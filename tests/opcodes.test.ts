// The opcode numbers live in two places: include/vm.h (firmware) and
// compiler/src/opcodes.ts (compiler). These tests parse the C headers so the
// two can never drift apart silently.
import * as fs from 'fs';
import * as path from 'path';
import { OP, TRANSFORM_IDS, PARSER_IDS } from '../compiler/src/opcodes';

const root = path.join(__dirname, '..');
const vmHeader = fs.readFileSync(path.join(root, 'include', 'vm.h'), 'utf8');
const vmSource = fs.readFileSync(path.join(root, 'src', 'vm.c'), 'utf8');

// OP_GPIO_WRITE = 0x01, ...
function parseOpcodes(source: string): Record<string, number> {
    const found: Record<string, number> = {};
    for (const [, name, value] of source.matchAll(/OP_([A-Z0-9_]+)\s*=\s*(0x[0-9A-Fa-f]+)/g)) {
        found[name!] = parseInt(value!, 16);
    }
    return found;
}

// An enum whose first member is `= 0` and the rest implicit.
function parseSequentialEnum(source: string, typeName: string): Record<string, number> {
    const body = source.match(new RegExp(`typedef enum \\{([^}]*)\\} ${typeName};`))?.[1] ?? '';
    const names = body
        .split('\n')
        .map(line => line.replace(/\/\/.*$/, '').trim().replace(/,$/, ''))
        .filter(Boolean)
        .map(entry => entry.split('=')[0]!.trim());
    return Object.fromEntries(names.map((name, i) => [name, i]));
}

describe('opcode tables match the firmware', () => {
    const firmware = parseOpcodes(vmHeader);

    test('vm.h defines every opcode the compiler emits', () => {
        for (const [name, value] of Object.entries(OP)) {
            expect({ [name]: firmware[name] }).toEqual({ [name]: value });
        }
    });

    test('the compiler knows every opcode vm.h defines', () => {
        const known = new Set(Object.keys(OP));
        expect(Object.keys(firmware).filter(name => !known.has(name))).toEqual([]);
    });

    test('every opcode in vm.h is implemented in vm.c', () => {
        const unimplemented = Object.keys(firmware)
            .filter(name => !new RegExp(`case OP_${name}\\b`).test(vmSource));
        expect(unimplemented).toEqual([]);
    });
});

describe('transform and parser ids match the firmware', () => {
    test('transform ids line up with the TransformId enum', () => {
        const firmware = parseSequentialEnum(vmSource, 'TransformId');
        for (const [name, id] of Object.entries(TRANSFORM_IDS)) {
            expect({ [name]: firmware['TRANSFORM_' + name.toUpperCase()] }).toEqual({ [name]: id });
        }
    });

    test('parser ids line up with the PARSER_ defines', () => {
        for (const [name, id] of Object.entries(PARSER_IDS)) {
            const define = new RegExp(`#define PARSER_${name.toUpperCase()}\\s+(0x[0-9A-Fa-f]+)`);
            const found = vmSource.match(define);
            expect(found).not.toBeNull();
            expect(parseInt(found![1]!, 16)).toBe(id);
        }
    });
});
