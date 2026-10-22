// Web Serial wrapper for a Zapp board: connect, stream lines, send commands.
// Chrome and Edge only — Safari and Firefox have no Web Serial.

import { ZAPP_PROBE, ZAPP_USB } from '../../compiler/src/index';

export type SerialLineHandler = (line: string) => void;

export class ZappSerial {
    private port: any = null;
    private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    private buffer = '';
    private onLine: SerialLineHandler;
    private onIdentity: ((identity: string) => void) | null = null;
    /** The board's "ZAPP:..." identity, from its ZPPI reply. */
    identity: string | null = null;

    private onClose: () => void;
    private reading: Promise<void> = Promise.resolve();

    constructor(onLine: SerialLineHandler, onClose: () => void = () => {}) {
        this.onLine = onLine;
        this.onClose = onClose;
    }

    static supported(): boolean {
        return typeof navigator !== 'undefined' && 'serial' in navigator;
    }

    get connected(): boolean {
        return this.port !== null;
    }

    async connect(): Promise<void> {
        const serial = (navigator as any).serial;
        // Only offer Zapp boards in the browser's port picker.
        this.port = await serial.requestPort({ filters: [{ usbVendorId: ZAPP_USB.vendorId, usbProductId: ZAPP_USB.productId }] });
        await this.port.open({ baudRate: 115200 });
        // TinyUSB only starts talking once the host raises DTR/RTS.
        await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });
        this.reading = this.readLoop();

        // Only call it connected once the board answers the identify probe.
        if (!(await this.ask(ZAPP_PROBE))) {
            await this.disconnect();
            throw new Error("That board didn't answer — install Zapp on it first (⋯ → Install Zapp)");
        }
    }

    // Send `data` and wait briefly for an identity line in reply.
    private ask(data: string, timeoutMs = 1500): Promise<boolean> {
        const answered = new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => { this.onIdentity = null; resolve(false); }, timeoutMs);
            this.onIdentity = () => { clearTimeout(timer); this.onIdentity = null; resolve(true); };
        });
        return this.write(data).then(() => answered);
    }

    async disconnect(): Promise<void> {
        this.onClose = () => {};   // a deliberate disconnect isn't news
        // Clear this.port first: the read loop re-acquires a reader while it's
        // set, which would leave the stream locked and close() failing — and
        // the port held open by the browser, out of reach of other tools.
        const port = this.port;
        this.port = null;
        try {
            await this.reader?.cancel();
        } catch {
            // reader already gone
        }
        await this.reading;   // loop has released its lock
        this.reader = null;
        await port?.close().catch(() => undefined);
    }

    // Split the incoming byte stream into lines for the console.
    private async readLoop() {
        const decoder = new TextDecoder();
        while (this.port?.readable) {
            this.reader = this.port.readable.getReader();
            try {
                for (;;) {
                    const { value, done } = await this.reader!.read();
                    if (done) break;
                    this.buffer += decoder.decode(value, { stream: true });
                    const lines = this.buffer.split(/\r?\n/);
                    this.buffer = lines.pop() ?? '';
                    for (const line of lines) {
                        const at = line.indexOf('ZPPI ');
                        if (at !== -1) {
                            this.identity = line.slice(at + 'ZPPI '.length).trim();
                            this.onIdentity?.(this.identity);
                            this.onLine(this.identity);   // shows as a normal ZAPP: line
                            continue;
                        }
                        if (line.trim()) this.onLine(line.replace(/^> /, ''));
                    }
                }
            } catch {
                break;   // port closed or unplugged
            } finally {
                this.reader?.releaseLock();
                this.reader = null;
            }
        }
        // Unplugged, reset, or rebooted into the bootloader.
        if (this.port) {
            this.port = null;
            this.onClose();
        }
    }

    async write(data: string): Promise<void> {
        if (!this.port?.writable) throw new Error('not connected');
        const writer = this.port.writable.getWriter();
        try {
            await writer.write(new TextEncoder().encode(data));
        } finally {
            writer.releaseLock();
        }
    }

    sendLine(line: string): Promise<void> {
        return this.write(line + '\r\n');
    }

    /** Ctrl+C — stop the running program. */
    stop(): Promise<void> {
        return this.write('\x03');
    }

    /** Ctrl+D — soft reload from flash. */
    reload(): Promise<void> {
        return this.write('\x04');
    }

    /** Reboot into the RPI-RP2 drive to install firmware. */
    async bootloader(): Promise<void> {
        await this.write('bootloader\r\n');
    }
}
