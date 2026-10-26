import { Lexer } from './lexer';
import { ParserEmitter, ModuleDefinition } from './emitter';
import { BoardDefinition } from './board';
import type { Warning } from './quirks';
export { parseModuleFile } from './modfile';
export { parseBoardFile } from './board';
export type { BoardDefinition, Indicator } from './board';
export type { Warning } from './quirks';
// './project' is Node-only (fs) — import it directly, never re-export it here,
// or browser bundles of this module (ide/) fail to resolve 'fs'.

// The firmware's USB IDs (firmware/core/usb_device.c): TinyUSB's VID with the CDC+MSC
// PID bits. Other TinyUSB gadgets share the VID, so match the pair.
export const ZAPP_USB = { vendorId: 0xCAFE, productId: 0x4003 };

interface PortInfo { path: string; vendorId?: string | undefined; productId?: string | undefined; manufacturer?: string | undefined }

// Zapp boards among serialport's list, best match first. The manufacturer
// string only ranks: on Windows it's the driver's vendor, not the board's.
export function findZappPorts<T extends PortInfo>(ports: T[]): T[] {
    const id = (v?: string) => parseInt(v ?? '', 16);
    return ports
        .filter(p => id(p.vendorId) === ZAPP_USB.vendorId && id(p.productId) === ZAPP_USB.productId)
        .sort((a, b) => Number(b.manufacturer === 'Zapp') - Number(a.manufacturer === 'Zapp'));
}

// Identify handshake (firmware/core/config.h): send ZAPP_PROBE, a Zapp board answers
// "ZPPI ZAPP:<chip>:<variant>:<flash>:<ram>:<board>" in any mode. It also sends
// that line by itself when the port is opened.
export const ZAPP_PROBE = 'ZPP?';

// The identity string from a ZPPI line in received text, or null if none yet.
export function parseIdentity(received: string): string | null {
    return /ZPPI (ZAPP:[^\r\n]+)\r?\n/.exec(received)?.[1] ?? null;
}

/** The board name in an identity ("ZAPP:rp2040:core:2048:264:xiao_rp2040"), or null if it was never set. */
export function identityBoard(identity: string | null): string | null {
    const name = identity?.split(':')[5]?.trim();
    return name && name !== 'unknown' ? name : null;
}

// "BC:" + uppercase hex, the wire format the firmware's REPL expects.
export function toPayload(bytecode: Uint8Array): string {
    return 'BC:' + [...bytecode].map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}

// Provide built-in defaults for web-editor fallback
export const BUILTIN_MODULES: Record<string, ModuleDefinition> = {
    'ds3231': {
        name: 'ds3231', interface: 'i2c', fields: {
            time: { reg: 0x00, len: 3, transform: 'ds3231_time', type: 'text' },
            date: { reg: 0x04, len: 3, transform: 'ds3231_date', type: 'text' }
        }, i2c: { addr_default: 0x68 }
    },
    'bmp280': {
        name: 'bmp280', interface: 'i2c', fields: {
            temp: { reg: 0xFA, len: 3, transform: 'bmp280_temp', type: 'num' },
            pressure: { reg: 0xF7, len: 3, transform: 'bmp280_pressure', type: 'num' }
        }, i2c: { addr_default: 0x76, addr_alt: 0x77 },
        init: { 0xF3: 0x00, 0xF4: 0xB7, 0xF5: 0xB0 }
    },
    'mpu6050': {
        name: 'mpu6050', interface: 'i2c', fields: {
            accel_x: { reg: 0x3B, len: 2, transform: 'mpu6050_accel', type: 'num' },
            accel_y: { reg: 0x3D, len: 2, transform: 'mpu6050_accel', type: 'num' },
            accel_z: { reg: 0x3F, len: 2, transform: 'mpu6050_accel', type: 'num' },
            gyro_x: { reg: 0x43, len: 2, transform: 'mpu6050_gyro', type: 'num' },
            gyro_y: { reg: 0x45, len: 2, transform: 'mpu6050_gyro', type: 'num' },
            gyro_z: { reg: 0x47, len: 2, transform: 'mpu6050_gyro', type: 'num' }
        }, i2c: { addr_default: 0x68, addr_alt: 0x69 },
        init: { 0x6B: 0x00 }
    },
    'oled': {
        name: 'oled',
        interface: 'display',
        display: { controller: 'auto', width: 128, height: 64, addr: 0x3C, addr_alt: 0x3D },
        fields: {},
    },
    'ssd1306': {
        name: 'ssd1306',
        interface: 'display',
        display: {
            controller: 'ssd1306',
            width: 128,
            height: 64,
            addr: 0x3C,
            addr_alt: 0x3D,
        },
        fields: {},
    },
};

export function compileSourceToPayload(code: string, modules: Record<string, ModuleDefinition> = BUILTIN_MODULES,
                                      board?: BoardDefinition): string {
    return compileWithWarnings(code, modules, board).payload;
}

/** Compile, plus what will behave differently on the real board (see quirks.ts). */
export function compileWithWarnings(code: string, modules: Record<string, ModuleDefinition> = BUILTIN_MODULES,
                                    board?: BoardDefinition): { payload: string; warnings: Warning[] } {
    const emitter = new ParserEmitter(new Lexer(code).tokenize(), { modules, board });
    const payload = toPayload(emitter.compile());
    return { payload, warnings: emitter.warnings() };
}
