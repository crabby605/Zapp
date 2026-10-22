// Node-only (fs): import directly, never re-export from index.ts.
import * as fs from 'fs';

// Structural so callers can pass their own `serialport` install's SerialPort.
interface OpenPort {
    port?: object | undefined;   // the platform binding; darwin's has an fd
    on(event: 'data', listener: (chunk: Buffer) => void): unknown;
}

// Deliver a port's incoming bytes to `handler`; returns a stop function.
//
// node-serialport 13's macOS binding (seen on Node 26 / macOS 26) only hands
// over received bytes when the port is also written to, so a board's reply
// sits unread until the next command. On macOS we read the file descriptor
// ourselves (it's already non-blocking and in raw mode). Call this after the
// port has opened, and don't also attach 'data' listeners or pipe the port.
// ponytail: 10ms polling; drop this once serialport's darwin poller is fixed.
export function onSerialData(port: OpenPort, handler: (chunk: Buffer) => void): () => void {
    const fd = (port.port as { fd?: unknown } | undefined)?.fd;
    if (process.platform !== 'darwin' || typeof fd !== 'number') {
        port.on('data', handler);
        return () => {};
    }
    const buf = Buffer.alloc(4096);
    const timer = setInterval(() => {
        for (;;) {
            let n = 0;
            try {
                n = fs.readSync(fd, buf, 0, buf.length, null);
            } catch {
                return;   // EAGAIN: nothing waiting (or the port closed)
            }
            if (n <= 0) return;
            handler(Buffer.from(buf.subarray(0, n)));
        }
    }, 10);
    return () => clearInterval(timer);
}
