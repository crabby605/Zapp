import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { BUILTIN_MODULES, compileSourceToPayload, findZappPorts, ZAPP_PROBE } from './index';
import { compileProjectToPayload } from './project';
import { parseModuleFile } from './modfile';
import { onSerialData } from './nodeSerial';
import { ModuleDefinition } from './emitter';

// Load real modules from the workspace instead of hardcoded defaults
const loadedModules: Record<string, ModuleDefinition> = { ...BUILTIN_MODULES };
try {
    const modulesDir = path.join(__dirname, '../../modules');
    if (fs.existsSync(modulesDir)) {
        for (const file of fs.readdirSync(modulesDir).filter(f => f.endsWith('.zappmod'))) {
            const content = fs.readFileSync(path.join(modulesDir, file), 'utf-8');
            try {
                const mod = parseModuleFile(content);
                loadedModules[mod.name] = mod;
            } catch (e) {
                console.error(`Failed to parse ${file}:`, e);
            }
        }
    }
} catch (e) {}

function normalizeInput(code: string): string {
    return code
        .replace(/\\n/g, '\n')
        .trim();
}

function isSessionDirective(code: string): boolean {
    return code.startsWith('use ') ||
        code.startsWith('config:');
}

async function main() {
    console.log("⚡ Zapp Interactive REPL ⚡\nLooking for device...");

    // Auto-detect the USB serial port
    const ports = await SerialPort.list();
    const picoPort = findZappPorts(ports)[0];

    if (!picoPort) {
        console.error("No Zapp board found. Is it plugged in and running Zapp firmware?");
        process.exit(1);
    }


    const port = new SerialPort({ path: picoPort.path, baudRate: 115200 });
    const portParser = new ReadlineParser({ delimiter: '\r\n' });

    await new Promise<void>((resolve, reject) => {
        port.once('open', () => {
             onSerialData(port, (chunk) => portParser.write(chunk));
             // 1. Assert DTR and RTS so TinyUSB knows the host terminal is fully attached
             port.set({ dtr: true, rts: true }, (err) => {
                 if (err) return reject(err);
                 // 2. Delay slightly on macOS so the CDC buffers finish opening
                 setTimeout(() => {
                     port.write('\r\n\r\n');
                     resolve();
                 }, 500);
             });
        });
        port.once('error', (err) => reject(err));
    });

    // Only talk to the port once it answers the identify probe.
    const identity = await new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => { portParser.off('data', onLine); resolve(null); }, 1500);
        const onLine = (line: string) => {
            const at = line.indexOf('ZPPI ');
            if (at === -1) return;
            clearTimeout(timer);
            portParser.off('data', onLine);
            resolve(line.slice(at + 'ZPPI '.length).trim());
        };
        portParser.on('data', onLine);
        port.write(ZAPP_PROBE);
    });
    if (!identity) {
        console.error(`${picoPort.path} did not answer the Zapp probe. Is it running Zapp firmware?`);
        process.exit(1);
    }
    console.log(`Connected to board on ${picoPort.path} (${identity})\n`);

    // Reconnecting should stop any currently running program before accepting input.
    // port.write(Buffer.from([0x03]));

    // Listen to what the board says
    portParser.on('data', (data) => {
        // We filter out the manual echoing of the > prompt
        if (!data.trim().startsWith('>')) {
            console.log(`\x1b[36m[Device]\x1b[0m ${data.trim()}`);
        }
    });

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '\x1b[33mzap>\x1b[0m '
    });

    let buffer = "";
    let sessionPrelude = "";

    rl.prompt();

    rl.on('line', (line) => {
        if (line.trim().startsWith('➜')) {
            rl.prompt();
            return;
        }

        // Multi-line block accumulator
        if (line.trim().endsWith(':') || line.startsWith(' ') || line.startsWith('\t')) {
            buffer += line + '\n';
            rl.setPrompt('\x1b[33m ...\x1b[0m ');
            rl.prompt();
            return;
        }

        buffer += line + '\n';

        let code = normalizeInput(buffer);
        buffer = "";
        rl.setPrompt('\x1b[33mzap>\x1b[0m ');

        if (!code) {
            rl.prompt();
            return;
        }

        // Special CLI commands
        if (code === 'exit' || code === 'quit') {
            process.exit(0);
        }

        if (code === 'reset') {
            port.write('reset\n');
            setTimeout(() => rl.prompt(), 100);
            return;
        }

        if (code === 'session clear') {
            sessionPrelude = "";
            console.log('\x1b[36m[Local]\x1b[0m session state cleared');
            rl.prompt();
            return;
        }

        if (code.startsWith('flashdir ')) {
            try {
                const projectDir = code.slice('flashdir '.length).trim();
                const hex = compileProjectToPayload(projectDir);
                port.write(hex + '\n');
            } catch (e: any) {
                console.error(`\x1b[31mCompiler Error: ${e.message}\x1b[0m`);
            }
            setTimeout(() => rl.prompt(), 50);
            return;
        }

        if (isSessionDirective(code)) {
            sessionPrelude = sessionPrelude
                ? `${sessionPrelude}\n${code}`
                : code;
            console.log('\x1b[36m[Local]\x1b[0m saved to session');
            rl.prompt();
            return;
        }

        // Send firmware-native debugging strings directly uncompiled
        if (code === 'help' || code === '?' || code === 'identity' ||
            code.startsWith('set pin ') || code.startsWith('read pin ')) {
            port.write(code + '\r\n');
            setTimeout(() => rl.prompt(), 100);
            return;
        }

        try {
            const fullSource = sessionPrelude
                ? `${sessionPrelude}\n\n${code}`
                : code;
            // RUN: executes without replacing the board's saved program.
            const hex = compileSourceToPayload(fullSource, loadedModules).replace(/^BC:/, 'RUN:');
            port.write(hex + '\r\n');

        } catch (e: any) {
            console.error(`\x1b[31mCompiler Error: ${e.message}\x1b[0m`);
        }

        // Slight delay so device prints OK before prompt returns
        setTimeout(() => rl.prompt(), 50);
    });

    rl.on('close', () => {
        console.log('\nGoodbye!');
        process.exit(0);
    });
}

main();
