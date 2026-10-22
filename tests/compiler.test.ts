import * as fs from 'fs';
import * as path from 'path';
import { compileSourceToPayload, findZappPorts, parseBoardFile, parseIdentity } from '../compiler/src/index';
import { parseModuleFile } from '../compiler/src/modfile';
import { ModuleDefinition } from '../compiler/src/emitter';
import { Lexer, TokenType } from '../compiler/src/lexer';

const root = path.join(__dirname, '..');

const modules: Record<string, ModuleDefinition> = {};
for (const f of fs.readdirSync(path.join(root, 'modules'))) {
    const mod = parseModuleFile(fs.readFileSync(path.join(root, 'modules', f), 'utf8'));
    modules[mod.name] = mod;
}

const compile = (src: string) => compileSourceToPayload(src, modules);
const byteLength = (payload: string) => (payload.length - 3) / 2;

describe('lexer', () => {
    test('splits a value from its unit', () => {
        const tokens = new Lexer('sleep 500ms\n').tokenize();
        expect(tokens.map(t => t.type).slice(0, 3))
            .toEqual([TokenType.SLEEP, TokenType.NUMBER, TokenType.MS]);
    });

    test('tracks indentation as INDENT/DEDENT', () => {
        const types = new Lexer('repeat 2:\n    print "a"\nprint "b"\n').tokenize().map(t => t.type);
        expect(types).toContain(TokenType.INDENT);
        expect(types).toContain(TokenType.DEDENT);
    });

    test('comments and blank lines are skipped', () => {
        expect(compile('# just a comment\n\nset pin 1 high\n')).toBe('BC:010101FF');
    });

    test('an unterminated string is an error', () => {
        expect(() => compile('print "oops\n')).toThrow(/Unterminated string/);
    });

    test('strings support escapes and stop at the line', () => {
        const str = new Lexer('print "say \\"hi\\" \\\\ ok"\n').tokenize()[1]!;
        expect(str.value).toBe('say "hi" \\ ok');
        expect(() => compile('print "a\nb"\n')).toThrow(/\[1:7\] Unterminated string/);
    });

    test('a lone CR is a line break', () => {
        expect(compile('print 1\rprint 2\r')).toBe(compile('print 1\nprint 2\n'));
    });

    test('invisible characters are named in errors', () => {
        expect(() => compile('print\u00a01\n')).toThrow(/U\+00A0/);
    });
});

describe('code generation', () => {
    test('blink emits gpio + sleep in a backwards jump', () => {
        const src = 'repeat forever:\n    set pin 25 high\n    sleep 500ms\n';
        //          GPIO 25 hi | SLEEP_MS 500      | JUMP -11 | HALT
        expect(compile(src)).toBe('BC:' + '011901' + '11000001F4' + '70FFF5' + 'FF');
    });

    test('repeat is a counted loop, not an unrolled body', () => {
        const small = byteLength(compile('repeat 3:\n    set pin 1 high\n'));
        const large = byteLength(compile('repeat 3000:\n    set pin 1 high\n'));
        expect(large).toBe(small);          // count is data, not repetition
        expect(large).toBeLessThan(40);     // and it stays tiny
    });

    test('if/else emits one conditional jump and one skip', () => {
        const payload = compile('if 1 > 0:\n    print "a"\nelse:\n    print "b"\n');
        expect(payload).toContain('71');    // JUMP_IF_FALSE
        expect(payload).toContain('70');    // JUMP over the else branch
    });

    test('string literals stay inline for print', () => {
        expect(compile('print "hi"\n')).toBe('BC:9102' + '6869' + 'FF');
    });
});

describe('errors', () => {
    test('unknown module', () => {
        expect(() => compile('use nosuchsensor\n')).toThrow(/not found/);
    });

    test('module used without `use`', () => {
        expect(() => compile('config:\n    i2c sda=1 scl=2\n\nget data from ds3231\n'))
            .toThrow(/was not imported/);
    });

    test('i2c module with no board and no config block', () => {
        expect(() => compile('use ds3231\n\nget data from ds3231\n'))
            .toThrow(/needs to know its I2C pins/);
    });

    test('unknown field', () => {
        expect(() => compile('config:\n    i2c sda=1 scl=2\n\nuse ds3231\n\nprint ds3231.nope\n'))
            .toThrow(/has no field/);
    });

    test('undeclared variable', () => {
        expect(() => compile('print counter\n')).toThrow(/Unknown variable/);
    });

    test('redeclared variable', () => {
        expect(() => compile('num x = 1\nnum x = 2\n')).toThrow(/already declared/);
    });

    test('reserved word as a function name', () => {
        expect(() => compile('func print a:\n    sleep 1ms\n')).toThrow(/reserved word/);
    });

    test('unknown key in a press combo', () => {
        expect(() => compile('press "ctrl+nope"\n')).toThrow(/Unknown key/);
    });

    test('connect wifi without a config block', () => {
        expect(() => compile('connect wifi\n')).toThrow(/Say which network/);
    });

    test('bad ble property', () => {
        expect(() => compile('print ble nope\n')).toThrow(/Expected 'connected' or 'message'/);
    });

    test('lists and classes report as unsupported', () => {
        expect(() => compile('list temps = [0]\n')).toThrow(/not supported yet/);
        expect(() => compile('class Thing:\n    num x = 1\n')).toThrow(/not supported yet/);
    });
});

describe('examples', () => {
    test.each(fs.readdirSync(path.join(root, 'examples')))('%s compiles', (file) => {
        const src = fs.readFileSync(path.join(root, 'examples', file), 'utf8');
        const pico = parseBoardFile(fs.readFileSync(path.join(root, 'boards', 'pico.zappboard'), 'utf8'));
        const payload = compileSourceToPayload(src, modules, pico);   // examples use the board's I2C pins
        expect(payload.startsWith('BC:')).toBe(true);
        expect(byteLength(payload)).toBeLessThanOrEqual(2048);   // firmware buffer
    });
});

describe('board profiles', () => {
    const boards = Object.fromEntries(fs.readdirSync(path.join(root, 'boards'))
        .filter(f => f.endsWith('.zappboard'))
        .map(f => {
            const b = parseBoardFile(fs.readFileSync(path.join(root, 'boards', f), 'utf8'));
            return [b.name, b];
        }));
    const onBoard = (name: string, src: string) => compileSourceToPayload(src, modules, boards[name]);

    test('every profile parses and names its indicators', () => {
        for (const name of ['pico', 'pico_w', 'xiao_rp2040', 'feather_rp2040', 'qtpy_rp2040',
                            'itsybitsy_rp2040', 'kb2040', 'tiny2040', 'rp2040_zero']) {
            expect(Object.keys(boards[name]!.indicators).length).toBeGreaterThan(0);
        }
    });

    test('pin names resolve to the board\'s GPIOs', () => {
        expect(onBoard('pico', 'set pin LED high\n')).toBe(compile('set pin 25 high\n'));
    });

    test('active-low LEDs light on high', () => {
        expect(onBoard('xiao_rp2040', 'set pin LED_RED high\n')).toBe(compile('set pin 17 low\n'));
    });

    test('active-low buttons read true when pressed', () => {
        expect(onBoard('feather_rp2040', 'read pin BUTTON\n')).toBe('BC:020462' + '90FF');
    });

    test('a NeoPixel with a power pin switches it on first', () => {
        expect(onBoard('qtpy_rp2040', 'show pixels on pin NEOPIXEL\n'))
            .toBe('BC:010B01' + 'A30C' + 'FF');
    });

    test('unknown pin names explain themselves', () => {
        expect(() => compile('set pin LED high\n')).toThrow(/select a board/);
        expect(() => onBoard('qtpy_rp2040', 'set pin LED high\n')).toThrow(/QT Py RP2040 has no pin/);
    });

    test('a variable shadows a pin name', () => {
        expect(onBoard('pico', 'num LED = 5\nset pin LED high\n')).toBe(compile('num p = 5\nset pin p high\n'));
    });
});

describe('board detection', () => {
    test('matches the firmware VID:PID only, Zapp manufacturer first', () => {
        const ports = [
            { path: 'macropad', vendorId: 'cafe', productId: '4004' },        // other TinyUSB gadget
            { path: 'micropython', vendorId: '2e8a', productId: '0005' },     // a Pico running MicroPython
            { path: 'win-zapp', vendorId: 'CAFE', productId: '4003', manufacturer: 'Microsoft' },
            { path: 'zapp', vendorId: 'cafe', productId: '4003', manufacturer: 'Zapp' },
        ];
        expect(findZappPorts(ports).map(p => p.path)).toEqual(['zapp', 'win-zapp']);
    });

    test('the ZPPI reply carries the identity, once the line is complete', () => {
        expect(parseIdentity('ZPP\r\nZPPI ZAPP:rp2040:core:2048:264:pico\r\n> '))
            .toBe('ZAPP:rp2040:core:2048:264:pico');
        expect(parseIdentity('ZPPI ZAPP:rp2040:co')).toBeNull();     // still arriving
        expect(parseIdentity('ZAPP:rp2040:core:2048:264:pico\r\n')).toBeNull();  // not the magic reply
    });
});

describe('display statements', () => {
    const oled = (body: string) => compile('config:\n    i2c sda=4 scl=5\nuse oled\n' + body);

    test('off-screen positions and sizes are compile errors', () => {
        expect(() => oled('display on oled "x" at 128 0\n')).toThrow(/off the 128x64 display/);
        expect(() => oled('display on oled "x" size 5\n')).toThrow(/size must be 1-4/);
        expect(() => oled('show "x" on oled line 0\n')).toThrow(/display on/);
    });

    test('display needs a display module', () => {
        expect(() => compile('display on oled "x"\n')).toThrow(/use oled/);
    });
});

describe('neopixel colours', () => {
    test('named colours compile to their r g b', () => {
        expect(compile('set pixels on pin 16 to red\n')).toBe(compile('set pixels on pin 16 to 255 0 0\n'));
        expect(compile('set pixel 2 on pin 16 to off\n')).toBe(compile('set pixel 2 on pin 16 to 0 0 0\n'));
    });

    test('an unknown colour lists the names', () => {
        expect(() => compile('set pixels on pin 16 to teal\n')).toThrow(/orange/);
    });
});

describe('wifi', () => {
    test('an open network needs no password', () => {
        expect(compile('connect wifi to "Cafe"\n')).toMatch(/^BC:F00443616665/);   // WIFI_CONNECT "Cafe"
    });

    test('quotes and password length are checked', () => {
        expect(() => compile('connect wifi to homenet\n')).toThrow(/network name in quotes/);
        expect(() => compile('connect wifi to "homenet" with "short"\n')).toThrow(/8-63 characters/);
    });

    test('start wifi takes the same name and optional password', () => {
        expect(compile('start wifi "Zapp"\n')).toMatch(/^BC:F9045A61707000/);   // WIFI_AP "Zapp" ""
        expect(() => compile('start wifi "Zapp" with "short"\n')).toThrow(/8-63 characters/);
    });
});

describe('i2c pins from the board', () => {
    const xiao = parseBoardFile(fs.readFileSync(path.join(root, 'boards', 'xiao_rp2040.zappboard'), 'utf8'));
    const pico = parseBoardFile(fs.readFileSync(path.join(root, 'boards', 'pico.zappboard'), 'utf8'));

    test('no config block: the selected board\'s SDA/SCL are used', () => {
        expect(compileSourceToPayload('use oled\n', modules, xiao)).toMatch(/^BC:0C0607000186A0/);   // XIAO GP6/GP7
        expect(compileSourceToPayload('use oled\n', modules, pico)).toMatch(/^BC:0C0405000186A0/);   // Pico GP4/GP5
    });

    test('pin names work in the config block', () => {
        expect(compileSourceToPayload('config:\n    i2c sda=SDA scl=SCL\nuse oled\n', modules, xiao)).toMatch(/^BC:0C0607/);
    });

    test('without a board it says how to give the pins', () => {
        expect(() => compile('use oled\n')).toThrow(/pick your board, or add/);
    });
});
