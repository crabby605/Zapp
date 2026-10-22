#!/usr/bin/env -S npx tsx
// Zapp MCP server — lets Claude compile, emulate and drive a real board.
//
// Board control uses the firmware's LLM mode (SPEC.md): the magic bytes ZPP!
// switch the REPL out of human mode, every command is answered with ZPPA (ok)
// or ZPPE (error), and ZPPX switches back.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SerialPort } from 'serialport';
import { z } from 'zod';

import { compileSourceToPayload, findZappPorts, identityBoard, parseBoardFile, parseIdentity, ZAPP_PROBE, type BoardDefinition } from '../compiler/src/index';
import { copyUf2, firmwarePath, waitForUf2Drive } from '../compiler/src/nodeInstall';
import { parseModuleFile } from '../compiler/src/modfile';
import { onSerialData } from '../compiler/src/nodeSerial';
import type { ModuleDefinition } from '../compiler/src/emitter';

const run = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const MAGIC = {
    enter: Buffer.from([0x5a, 0x50, 0x50, 0x21]),   // ZPP!
    exit:  Buffer.from([0x5a, 0x50, 0x50, 0x58]),   // ZPPX
    ack:   'ZPPA',
    err:   'ZPPE',
};

// Modules

function loadModules(): Record<string, ModuleDefinition> {
    const dir = join(repoRoot, 'modules');
    const modules: Record<string, ModuleDefinition> = {};
    if (!existsSync(dir)) return modules;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.zappmod'))) {
        try {
            const mod = parseModuleFile(readFileSync(join(dir, file), 'utf8'));
            modules[mod.name] = mod;
        } catch {
            // a broken module file shouldn't take the server down
        }
    }
    return modules;
}

const modules = loadModules();

// Board profiles (boards/*.zappboard): pin names, default I2C pins, LEDs.
function loadBoards(): Record<string, BoardDefinition> {
    const dir = join(repoRoot, 'boards');
    const boards: Record<string, BoardDefinition> = {};
    for (const file of existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.zappboard')) : []) {
        try {
            const b = parseBoardFile(readFileSync(join(dir, file), 'utf8'));
            boards[b.name] = b;
        } catch { /* skip a broken profile */ }
    }
    return boards;
}

const boards = loadBoards();
let boardName = 'pico';   // which profile programs compile against; set by any tool's `board`

const useBoard = (name?: string) => {
    if (!name) return;
    if (!boards[name]) throw new Error(`Unknown board '${name}'. Known: ${Object.keys(boards).join(', ')}`);
    boardName = name;
};
const compile = (source: string) => compileSourceToPayload(source, modules, boards[boardName]);
const boardParam = z.string().optional()
    .describe(`Board profile, remembered for later calls: ${Object.keys(boards).join(', ')}`);

// Board connection

class Board {
    private port: SerialPort | null = null;
    private stopReading = () => {};
    private buffer = '';
    private log: string[] = [];

    get connected() { return this.port !== null; }

    static async list() {
        return findZappPorts(await SerialPort.list());
    }

    async connect(path?: string) {
        if (this.port) await this.disconnect();

        const targets = path ? [path] : (await Board.list()).map((p) => p.path);
        if (!targets.length) throw new Error('No Zapp board found — is one plugged in?');

        // A port only counts once it answers the identify probe with ZPPI.
        for (const target of targets) {
            await this.open(target);
            const identity = await this.identify().catch(() => null);
            if (identity) {
                await this.raw(MAGIC.enter);   // switch the REPL into LLM framing
                await this.waitFor(MAGIC.ack, 2000).catch(() => {
                    throw new Error('Board did not acknowledge LLM mode');
                });
                return { target, identity };
            }
            this.stopReading();
            this.port!.close();
            this.port = null;
        }
        throw new Error(path
            ? `${path} did not answer the Zapp probe — is it running Zapp firmware?`
            : 'A USB device matched but did not answer the Zapp probe — is it running Zapp firmware?');
    }

    private async open(target: string) {
        // Only keep the port once it's really open: a half-made one left in
        // this.port would make the next connect() hang trying to close it.
        const port = new SerialPort({ path: target, baudRate: 115200 });
        await new Promise<void>((resolve, reject) => {
            port.once('open', () => resolve());
            port.once('error', reject);
        });
        this.port = port;
        this.stopReading = onSerialData(this.port, (chunk: Buffer) => {
            this.buffer += chunk.toString('utf8');
            this.log.push(chunk.toString('utf8'));
            if (this.log.length > 500) this.log.shift();
        });

        // Raising DTR makes the board announce itself; give TinyUSB a moment.
        this.port.set({ dtr: true, rts: true });
        await delay(400);
    }

    // Send the probe and wait for the board's "ZPPI ZAPP:..." line.
    private async identify(timeoutMs = 1500): Promise<string> {
        this.buffer = '';
        await this.raw(ZAPP_PROBE);
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const identity = parseIdentity(this.buffer);
            if (identity) return identity;
            if (Date.now() > deadline) throw new Error('No ZPPI reply');
            await delay(20);
        }
    }

    // Reboot into the RPI-RP2 drive. The board drops off USB, so no reply comes.
    async bootloader() {
        if (!this.port) return;
        await this.raw('bootloader\r\n');
        await delay(200);
        this.stopReading();
        this.port.close();
        this.port = null;
        this.buffer = '';
    }

    async disconnect() {
        if (!this.port) return;
        if (!this.port.isOpen) { this.stopReading(); this.port = null; return; }
        try {
            await this.raw(MAGIC.exit);
            await delay(100);
        } finally {
            this.stopReading();
            this.port.close();
            this.port = null;
            this.buffer = '';
        }
    }

    private raw(data: Buffer | string): Promise<void> {
        return new Promise((resolve, reject) => {
            if (!this.port) return reject(new Error('Not connected — call zapp_connect first'));
            this.port.write(data, (err) => (err ? reject(err) : resolve()));
        });
    }

    // Send one command and collect everything up to the ack/err frame.
    async command(line: string, timeoutMs = 5000): Promise<string> {
        this.buffer = '';
        await this.raw(line + '\r\n');
        const reply = await this.waitFor([MAGIC.ack, MAGIC.err], timeoutMs);
        const body = reply.text.replace(/ZPP[AE]\s*$/, '').trim();
        if (reply.marker === MAGIC.err) {
            throw new Error(body || 'Board reported an error');
        }
        return body;
    }

    // Output the board produced on its own (a running program's prints).
    async drain(ms: number): Promise<string> {
        this.buffer = '';
        await delay(ms);
        return this.buffer.trim();
    }

    async stop() {
        await this.raw('\x03');       // Ctrl+C
        return this.drain(200);
    }

    private waitFor(markers: string | string[], timeoutMs: number):
        Promise<{ text: string; marker: string }> {
        const wanted = Array.isArray(markers) ? markers : [markers];
        const deadline = Date.now() + timeoutMs;
        return new Promise((resolve, reject) => {
            const tick = () => {
                for (const marker of wanted) {
                    if (this.buffer.includes(marker)) {
                        return resolve({ text: this.buffer, marker });
                    }
                }
                if (Date.now() > deadline) return reject(new Error('Timed out waiting for the board'));
                setTimeout(tick, 20);
            };
            tick();
        });
    }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const board = new Board();

// Emulator

async function emulate(source: string, gpio: string[] = [], display?: string): Promise<string> {
    const dir = join(repoRoot, 'emulator');
    const binary = join(dir, 'zapp-emu');
    if (!existsSync(binary)) await run('make', ['-C', dir], { timeout: 60_000 });

    const args = gpio.flatMap((preset) => ['--gpio', preset]);
    if (display) args.push('--display', display);
    if (boardName !== 'pico_w') args.push('--no-radio');
    const { stdout, stderr } = await run(binary, [...args, '--quiet', compile(source)],
                                         { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
    return [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
}

// Server

const server = new McpServer({ name: 'zapp', version: '0.1.0' });
const text = (body: string) => ({ content: [{ type: 'text' as const, text: body }] });

server.registerTool('zapp_list_boards', {
    description: 'List Zapp boards plugged into this machine (USB serial devices).',
    inputSchema: {},
}, async () => {
    const ports = await Board.list();
    if (!ports.length) return text('No boards found.');
    return text(ports.map((p) => `${p.path}  ${p.manufacturer ?? ''} ${p.serialNumber ?? ''}`.trim()).join('\n'));
});

server.registerTool('zapp_connect', {
    description: 'Connect to a Zapp board and put it in LLM mode. Do this before any board tool.',
    inputSchema: {
        path: z.string().optional().describe('Serial port path; defaults to the first board found'),
        board: boardParam,
    },
}, async ({ path, board: name }) => {
    const { target, identity } = await board.connect(path);
    // The board remembers what it is once told; naming one tells it.
    const told = identityBoard(identity);
    if (name) {
        useBoard(name);
        if (name !== told) await board.command(`board ${name}`);
    } else if (told && boards[told]) {
        boardName = told;
    }
    const note = !name && !told ? '\nThe board doesn\'t know what it is yet — pass `board` once and it will remember.' : '';
    return text(`Connected to ${target} (${boards[boardName]?.title ?? boardName})\n${identity}${note}`);
});

server.registerTool('zapp_disconnect', {
    description: 'Leave LLM mode and close the serial port.',
    inputSchema: {},
}, async () => {
    await board.disconnect();
    return text('Disconnected.');
});

server.registerTool('zapp_run', {
    description: 'Compile Zapp source and run it on the connected board. Stops whatever is running, ' +
                 'but leaves the saved power-up program alone (use zapp_save for that).',
    inputSchema: { source: z.string().describe('Zapp source code'), board: boardParam },
}, async ({ source, board: name }) => {
    useBoard(name);
    const payload = compile(source).replace(/^BC:/, 'RUN:');
    const reply = await board.command(payload, 10_000);
    const output = await board.drain(600);
    return text([`Running ${(payload.length - 4) / 2} bytes.`, reply, output].filter(Boolean).join('\n'));
});

server.registerTool('zapp_save', {
    description: 'Compile Zapp source, save it on the board as the program that runs at power-up, and run it.',
    inputSchema: { source: z.string().describe('Zapp source code'), board: boardParam },
}, async ({ source, board: name }) => {
    useBoard(name);
    const payload = compile(source);
    const reply = await board.command(payload, 10_000);
    const output = await board.drain(600);
    return text([`Saved ${(payload.length - 3) / 2} bytes as the power-up program.`, reply, output].filter(Boolean).join('\n'));
});

server.registerTool('zapp_install', {
    description: 'Install (or update) the Zapp firmware on a board. A connected Zapp board restarts ' +
                 'itself into install mode; otherwise ask the user to do it (e.g. XIAO: hold B, tap R; ' +
                 'Pico: hold BOOTSEL while plugging in) — this waits up to a minute for the RPI-RP2 drive.',
    inputSchema: { board: boardParam },
}, async ({ board: name }) => {
    useBoard(name);
    const uf2 = firmwarePath(repoRoot, boardName === 'pico_w' ? 'pico_w' : 'core');
    if (!existsSync(uf2)) throw new Error(`No firmware built yet — run make in ${dirname(uf2)}`);

    const wasConnected = board.connected;
    if (wasConnected) await board.bootloader();
    const drive = await waitForUf2Drive(wasConnected ? 20_000 : 60_000);
    if (!drive) {
        throw new Error(`No RPI-RP2 drive appeared. Put the board in install mode: ` +
                        `${boards[boardName]?.install ?? 'hold BOOT while plugging it in'}, then try again.`);
    }
    await copyUf2(uf2, drive);

    // Wait for it to come back as a Zapp board.
    for (let i = 0; i < 60; i++) {
        if ((await Board.list()).length) break;
        await delay(250);
    }
    if (wasConnected) {
        await delay(800);
        await board.connect().catch(() => undefined);
    }
    return text(`Installed Zapp from ${uf2} via ${drive}.` +
                (board.connected ? ' Reconnected.' : ' Call zapp_connect to use it.'));
});

server.registerTool('zapp_emulate', {
    description: 'Run Zapp source in the emulator (no board needed). Returns the hardware trace: ' +
                 'every GPIO/PWM/servo/I2C/HID effect plus program output.',
    inputSchema: {
        source: z.string().describe('Zapp source code'),
        gpio: z.array(z.string()).optional().describe('Input pin presets, e.g. ["15=1"]'),
        display: z.enum(['ssd1306', 'ssd1306_32', 'sh1106', 'none']).optional()
            .describe('Which OLED the virtual board has attached (default ssd1306 128x64)'),
        board: boardParam,
    },
}, async ({ source, gpio, display, board: name }) => {
    useBoard(name);
    return text(await emulate(source, gpio ?? [], display));
});

server.registerTool('zapp_compile', {
    description: 'Compile Zapp source to bytecode without running it. Returns the BC: payload.',
    inputSchema: { source: z.string().describe('Zapp source code'), board: boardParam },
}, async ({ source, board: name }) => {
    useBoard(name);
    const payload = compile(source);
    return text(`${payload}\n(${(payload.length - 3) / 2} bytes)`);
});

server.registerTool('zapp_gpio_write', {
    description: 'Set one GPIO pin high or low on the connected board.',
    inputSchema: {
        pin: z.number().int().min(0).max(29),
        value: z.enum(['high', 'low']),
    },
}, async ({ pin, value }) => text(await board.command(`set pin ${pin} ${value}`)));

server.registerTool('zapp_gpio_read', {
    description: 'Read one GPIO pin on the connected board.',
    inputSchema: { pin: z.number().int().min(0).max(29) },
}, async ({ pin }) => text(await board.command(`read pin ${pin}`)));

server.registerTool('zapp_i2c_scan', {
    description: 'Scan the I2C bus and list the addresses that answer. Configure the bus first with zapp_run.',
    inputSchema: {
        sda: z.number().int().describe('SDA pin'),
        scl: z.number().int().describe('SCL pin'),
    },
}, async ({ sda, scl }) => {
    // A three-instruction program: init the bus, scan it, halt.
    const payload = 'RUN:0C' + hex(sda) + hex(scl) + '000186A0' + '0A' + 'FF';
    // The scan result can land in the command's reply or after it; keep both.
    const out = (await board.command(payload, 8000)) + '\n' + (await board.drain(1500));
    const result = out.split('\n').find(l => l.startsWith('i2c:') || l.startsWith('0x'));
    return text(result || 'No scan result received (board busy?), not "no devices".');
});

server.registerTool('zapp_repl', {
    description: 'Send a raw REPL command to the board (help, identity, reset, print <text>, ...).',
    inputSchema: { command: z.string() },
}, async ({ command }) => text(await board.command(command)));

server.registerTool('zapp_stop', {
    description: 'Stop the program running on the board (Ctrl+C).',
    inputSchema: {},
}, async () => text((await board.stop()) || 'Stopped.'));

server.registerTool('zapp_read_output', {
    description: 'Collect whatever the board prints over the next few hundred milliseconds.',
    inputSchema: { ms: z.number().int().min(50).max(10_000).default(1000) },
}, async ({ ms }) => text((await board.drain(ms)) || '(no output)'));

server.registerTool('zapp_list_modules', {
    description: 'List the sensor/peripheral modules available to `use` in Zapp source.',
    inputSchema: {},
}, async () => text(
    Object.values(modules)
        .map((m) => `${m.name} (${m.interface}): ${Object.keys(m.fields).join(', ') || 'display'}`)
        .join('\n') || 'No modules found.'));

const hex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();

await server.connect(new StdioServerTransport());
