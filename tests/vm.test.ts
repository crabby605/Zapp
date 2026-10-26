// End-to-end tests: Zapp source → bytecode → the real VM (firmware/core/vm.c) running in
// the emulator. If these pass, the compiler and the firmware agree.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { compileSourceToPayload, parseBoardFile, type BoardDefinition } from '../compiler/src/index';
import { parseModuleFile } from '../compiler/src/modfile';
import { ModuleDefinition } from '../compiler/src/emitter';

const root = path.join(__dirname, '..');
const emulator = path.join(root, 'emulator', 'zapp-emu');

const modules: Record<string, ModuleDefinition> = {};
for (const f of fs.readdirSync(path.join(root, 'modules'))) {
    const mod = parseModuleFile(fs.readFileSync(path.join(root, 'modules', f), 'utf8'));
    modules[mod.name] = mod;
}

beforeAll(() => {
    execFileSync('make', ['-C', path.join(root, 'emulator')], { stdio: 'pipe' });
});

const pico = parseBoardFile(fs.readFileSync(path.join(root, 'boards', 'pico.zappboard'), 'utf8'));

// Compile and run, returning the emulator's trace lines.
function run(source: string, args: string[] = [], board?: BoardDefinition): string[] {
    const hex = compileSourceToPayload(source, modules, board);
    const out = execFileSync(emulator, [...args, '--quiet', hex], { encoding: 'utf8' });
    return out.trim().split('\n').filter(Boolean);
}

describe('gpio and timing', () => {
    test('blink toggles the pin', () => {
        expect(run('repeat 2:\n    set pin 25 high\n    sleep 10ms\n    set pin 25 low\n'))
            .toEqual(['gpio 25=1', 'gpio 25=0', 'gpio 25=1', 'gpio 25=0']);
    });

    test('read pin reports the level', () => {
        expect(run('set pin 5 high\nread pin 5\n')).toEqual(['gpio 5=1', 'true']);
    });
});

describe('variables and arithmetic', () => {
    test('whole numbers print in full', () => {
        expect(run('print 16777216\nprint 1234567\nprint 2.5\n')).toEqual(['16777216', '1234567', '2.5']);
    });

    test('numbers, precedence and parentheses', () => {
        expect(run('num x = 2\nprint x * 3 + 1\nprint (x + 1) * 4\nprint 7 % 4\nprint 7 / 2\n'))
            .toEqual(['7', '12', '3', '3.5']);
    });

    test('strings concatenate with numbers', () => {
        expect(run('num t = 21\nprint "temp: " + t\n')).toEqual(['temp: 21']);
    });

    test('assignment updates the slot', () => {
        expect(run('num n = 1\nn = n + 41\nprint n\n')).toEqual(['42']);
    });

    test('booleans and logic', () => {
        expect(run('print true and false\nprint true or false\nprint not true\n'))
            .toEqual(['false', 'true', 'false']);
    });

    test('comparisons', () => {
        expect(run('print 3 > 2\nprint 3 <= 2\nprint 2 == 2\nprint 2 != 2\n'))
            .toEqual(['true', 'false', 'true', 'false']);
    });

    test('divide by zero halts with an error', () => {
        expect(run('print 1 / 0\n')).toEqual(['VM Error: divide by zero']);
    });
});

describe('control flow', () => {
    test('if / else picks one branch', () => {
        const src = 'num t = 31\nif t > 30:\n    print "hot"\nelse:\n    print "cold"\n';
        expect(run(src)).toEqual(['hot']);
        expect(run(src.replace('31', '5'))).toEqual(['cold']);
    });

    test('repeat runs the body exactly N times', () => {
        expect(run('repeat 3:\n    print "x"\n')).toEqual(['x', 'x', 'x']);
    });

    test('repeat with a variable count', () => {
        expect(run('num n = 4\nrepeat n:\n    print "y"\n')).toEqual(['y', 'y', 'y', 'y']);
    });

    test('nested repeat', () => {
        expect(run('repeat 2:\n    repeat 2:\n        print "n"\n')).toEqual(['n', 'n', 'n', 'n']);
    });

    test('repeat forever is stopped by the emulator budget, not by drift', () => {
        const out = run('repeat forever:\n    print "loop"\n    sleep 1000ms\n');
        expect(out.length).toBeGreaterThan(3);
        expect(new Set(out)).toEqual(new Set(['loop']));
    });
});

describe('functions', () => {
    test('a function runs only when called', () => {
        const src = 'func hello:\n    print "hi"\n\nprint "before"\nhello\nprint "after"\n';
        expect(run(src)).toEqual(['before', 'hi', 'after']);
    });

    test('parameters arrive in order', () => {
        const src = 'func report a b:\n    print a\n    print b\n\nreport 1 2\n';
        expect(run(src)).toEqual(['1', '2']);
    });

    test('a parameter can be the pin — SPEC blink example', () => {
        const src = [
            'func blink pin times:',
            '    repeat times:',
            '        set pin pin high',
            '        sleep 10ms',
            '        set pin pin low',
            '        sleep 10ms',
            '',
            'blink 25 2',
            'blink 16 1',
        ].join('\n') + '\n';
        expect(run(src)).toEqual([
            'gpio 25=1', 'gpio 25=0', 'gpio 25=1', 'gpio 25=0',
            'gpio 16=1', 'gpio 16=0',
        ]);
    });

    test('calls can be repeated and nested in loops', () => {
        const src = 'func tick n:\n    print n\n\nrepeat 3:\n    tick 7\n';
        expect(run(src)).toEqual(['7', '7', '7']);
    });
});

describe('peripherals', () => {
    test('pwm, servo and adc', () => {
        const src = [
            'pulse 128 on pin 10 at 500hz',
            'pulse 0 on pin 10',
            'move servo on pin 12 to -45',
            'read analog pin 26',
            'read analog pin 26 as voltage',
        ].join('\n') + '\n';
        expect(run(src)).toEqual([
            'pwm 10 duty=128 freq=500',
            'pwm 10 off',
            'servo 12=-45',
            '32768',
            '1.65',
        ]);
    });

    test('neopixel statements', () => {
        const src = [
            'set pixel 2 on pin 16 to 255 0 0',
            'set pixels on pin 16 to 0 0 255',
            'set brightness on pin 16 to 64',
            'show pixels on pin 16',
        ].join('\n') + '\n';
        expect(run(src)).toEqual([
            'neo 16 [2]=255,0,0',
            'neo 16 all=0,0,255',
            'neo 16 brightness=64',
            'neo 16 show',
        ]);
    });

    test('hid keyboard and mouse', () => {
        const src = [
            'type "ok"',
            'press "ctrl+c"',
            'press "enter"',
            'click right',
            'move mouse 5 -5',
            'scroll -2',
        ].join('\n') + '\n';
        expect(run(src)).toEqual([
            'hid type ok',
            'hid key mod=0x01 code=0x06',
            'hid key mod=0x00 code=0x28',
            'hid mouse dx=0 dy=0 buttons=2 scroll=0',
            'hid mouse dx=5 dy=-5 buttons=0 scroll=0',
            'hid mouse dx=0 dy=0 buttons=0 scroll=-2',
        ]);
    });
});

describe('radio', () => {
    const program = [
        'connect wifi to "homenet" with "hunter22"',
        'if wifi connected:',
        '    print "ip " + wifi ip',
        '    print http get "http://example.com/api"',
        'else:',
        '    print "no network"',
    ].join('\n') + '\n';

    test('joins, reports its address and fetches a url', () => {
        expect(run(program)).toEqual([
            'wifi connect ssid=homenet',
            'ip 192.168.1.42',
            'http GET http://example.com/api',
            '{"ok":true}',
        ]);
    });

    test('a board with no radio says so instead of failing silently', () => {
        expect(run(program, ['--no-radio'])).toEqual(['Hardware Error: this board has no radio']);
    });

    test('http post carries a body', () => {
        const src = [
            'connect wifi to "net"',
            'http post "http://example.com/log" "temp=21"',
        ].join('\n') + '\n';
        expect(run(src)).toEqual([
            'wifi connect ssid=net',
            'http POST http://example.com/log body=temp=21',
        ]);
    });
});

describe('bluetooth', () => {
    const program = [
        'advertise "zapp-board"',
        '',
        'repeat 2:',
        '    if ble connected:',
        '        notify "temp 21"',
        '        print ble message',
        '    sleep 100ms',
    ].join('\n') + '\n';

    test('advertises, notifies and receives one message', () => {
        expect(run(program)).toEqual([
            'ble advertise name=zapp-board',
            'ble notify temp 21',
            'hello board',      // the virtual central's message, delivered once
            'ble notify temp 21',
            'nil',
        ]);
    });

    test('notify sends any value as text', () => {
        expect(run('advertise "b"\nnum t = 21\nnotify "temp " + t\n'))
            .toEqual(['ble advertise name=b', 'ble notify temp 21']);
    });

    test('a board with no bluetooth says so', () => {
        expect(run(program, ['--no-radio']))
            .toEqual(['Hardware Error: this board has no bluetooth']);
    });
});

describe('modules', () => {
    test('i2c sensor read applies the module transform', () => {
        const src = 'config:\n    i2c sda=20 scl=21\n\nuse ds3231\n\nget data from ds3231\nprint ds3231.time\nprint ds3231.date\n';
        // The emulator's virtual DS3231 answers with the host clock in BCD.
        const [time, date] = run(src);
        expect(time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
        expect(date).toMatch(/^\d{2}\/\d{2}\/20\d{2}$/);
    });

    test('bmp280 matches the datasheet example: 25.08 C, 1006.53 hPa', () => {
        const src = 'config:\n    i2c sda=20 scl=21\n\nuse bmp280\n\nget data from bmp280\nprint bmp280.temp\nprint bmp280.pressure\n';
        const [temp, pressure] = run(src).map(Number);
        expect(temp).toBeCloseTo(25.08, 2);
        expect(pressure).toBeCloseTo(1006.53, 1);
    });

    test('an older bmp280 module (3-byte pressure) still reads right', () => {
        const old = parseModuleFile(fs.readFileSync(path.join(root, 'modules', 'bmp280.zappmod'), 'utf8')
            .replace('len       = 6', 'len       = 3'));
        const hex = compileSourceToPayload('config:\n    i2c sda=20 scl=21\nuse bmp280\nget data from bmp280\nprint bmp280.pressure\n', { bmp280: old });
        expect(Number(execFileSync(emulator, ['--quiet', hex], { encoding: 'utf8' }).trim())).toBeCloseTo(1006.53, 1);
    });

    test('virtual mpu6050 reads a board lying flat', () => {
        const src = [
            'config:', '    i2c sda=20 scl=21', '', 'use mpu6050', '',
            'get data from mpu6050', 'print mpu6050.accel_z',
        ].join('\n') + '\n';
        expect(Number(run(src)[0])).toBeCloseTo(1, 2);   // 1 g down
    });

    test('sensor values work in expressions', () => {
        const src = [
            'config:',
            '    i2c sda=20 scl=21',
            '',
            'use mpu6050',
            '',
            'get data from mpu6050',
            'if mpu6050.accel_x > 0:',
            '    print "moving"',
        ].join('\n') + '\n';
        expect(run(src)).toEqual(['moving']);
    });

    test('spi module decodes a bit field (max31855)', () => {
        const src = [
            'config:',
            '    spi mosi=19 miso=16 sck=18 cs=17',
            '',
            'use max31855',
            '',
            'get data from max31855',
            'print max31855.temp',
        ].join('\n') + '\n';
        // Sample word 0x06400190: temp bits 31..18 = 100 → 100 * 0.25 = 25 C.
        expect(run(src)).toEqual(['25']);
    });

    test('uart gps parses NMEA out of the stream', () => {
        const src = [
            'config:',
            '    uart tx=0 rx=1 baud=9600',
            '',
            'use gps_nmea',
            '',
            'get data from gps_nmea',
            'print gps_nmea.latitude',
            'print gps_nmea.fix',
        ].join('\n') + '\n';
        const out = run(src);
        // 4807.038,N → 48 + 07.038/60 = 48.1173 degrees
        expect(parseFloat(out[0]!)).toBeCloseTo(48.1173, 3);
        expect(out[1]).toBe('true');
    });

    test('display text lands in the framebuffer', () => {
        const src = [
            'config:',
            '    i2c sda=4 scl=5',
            '',
            'use ssd1306',
            '',
            'clear ssd1306',
            'display on ssd1306 "Hi"',
        ].join('\n') + '\n';
        const hex = compileSourceToPayload(src, modules);
        const out = execFileSync(emulator, ['--quiet', hex], { encoding: 'utf8' });
        expect(out).toContain('display:');
        expect(out).toContain('#');
    });
});

describe('displays', () => {
    const oled = (body: string) => 'config:\n    i2c sda=4 scl=5\nuse oled\n' + body;
    // The emulator's screen, as rows of '#'/'.' (one char per pixel).
    const screen = (src: string, display: string) =>
        run(src, ['--display', display]).map(l => l.trim()).filter(l => /^[#.]+$/.test(l));
    const lit = (rows: string[], x: number, y: number) => rows[y]?.[x] === '#';

    test.each(['ssd1306', 'ssd1306@3d', 'sh1106', 'sh1106@3d'])(
        'detects a %s and draws in the right place', (display) => {
            // "|" is a vertical bar in column 2 of its glyph: x=0 → pixel column 2.
            const rows = screen(oled('display on oled "|" at 0 0\n'), display);
            expect(lit(rows, 2, 0)).toBe(true);
            expect(lit(rows, 0, 0)).toBe(false);
        });

    test('reports what it detected', () => {
        expect(run(oled('display on oled "hi"\n'), ['--display', 'ssd1306_32'])).toContain('Screen: SSD1306 128x32 at 0x3C');
        expect(run(oled('display on oled "hi"\n'), ['--display', 'sh1106@3d'])).toContain('Screen: SH1106 128x64 at 0x3D');
    });

    test('a clone that ignores reads is still found, and says the size is a guess', () => {
        const out = run(oled('display on oled "|" at 0 0\n'), ['--display', 'ssd1306_noread']);
        expect(out.join('\n')).toMatch(/Screen: SSD1306 128x64 at 0x3C \(guessed/);
        expect(screen(oled('display on oled "|" at 0 0\n'), 'ssd1306_noread')[0]?.[2]).toBe('#');
    });

    test('use ssd1306_32 pins the size when detection can only guess', () => {
        const out = run('config:\n    i2c sda=4 scl=5\nuse ssd1306_32\ndisplay on ssd1306_32 "hi"\n', ['--display', 'ssd1306_noread']);
        expect(out.join('\n')).toMatch(/SSD1306 128x32/);
    });

    test('a missing display stops with a message', () => {
        expect(run(oled('display on oled "hi"\n'), ['--display', 'none']).join('\n'))
            .toMatch(/no display found at 0x3C or 0x3D/);
    });

    test('size scales the font', () => {
        const rows = screen(oled('display on oled "|" at 0 0 size 2\n'), 'ssd1306');
        expect(lit(rows, 4, 0) && lit(rows, 5, 0) && lit(rows, 4, 13)).toBe(true);
    });

    test('display without at stacks lines and scrolls a detected 128x32', () => {
        const rows = screen(oled('num i = 1\nrepeat 6:\n    display on oled "" + i\n    i = i + 1\n'), 'ssd1306_32');
        expect(rows.length).toBeLessThanOrEqual(32);
        // After scrolling, the top line is "3": same pixels as drawing "3" there directly.
        const three = screen(oled('display on oled "3" at 0 0\n'), 'ssd1306_32');
        expect(rows.slice(0, 7)).toEqual(three.slice(0, 7));
    });

    test('a program that leaves the screen blank gets the idle screen; one that drew keeps it', () => {
        const idle = screen(oled('clear oled\n'), 'ssd1306_32');
        expect(idle.some(r => r.slice(0, 24).includes('#'))).toBe(true);   // the bolt
        expect(idle.some(r => r.slice(26).includes('#'))).toBe(true);      // "Zapp"
        const drawn = screen(oled('display on oled "|" at 0 0\n'), 'ssd1306_32');
        expect(drawn.flatMap(r => [...r]).filter(c => c === '#').length).toBe(7);
    });

    test('new text replaces old text to its right', () => {
        const rows = screen(oled('display on oled "100" at 0 0\ndisplay on oled "99" at 0 0\n'), 'ssd1306');
        const fresh = screen(oled('display on oled "99" at 0 0\n'), 'ssd1306');
        expect(rows).toEqual(fresh);
    });
});

describe('examples', () => {
    const examples = fs.readdirSync(path.join(root, 'examples'));
    // Examples use pin names (LED, BUTTON, NEOPIXEL, A0, SDA…); this board has them all.
    const feather = parseBoardFile(fs.readFileSync(path.join(root, 'boards', 'feather_rp2040.zappboard'), 'utf8'));

    test.each(examples)('%s compiles and runs', (file) => {
        const src = fs.readFileSync(path.join(root, 'examples', file), 'utf8');
        expect(() => run(src, [], feather)).not.toThrow();
    });
});

describe('functions', () => {
    test('recursion keeps each call\'s parameters', () => {
        expect(run('func down n:\n    if n > 0:\n        down n - 1\n    print n\ndown 3\n'))
            .toEqual(['0', '1', '2', '3']);
    });

    test('too-deep recursion stops with a message', () => {
        expect(run('func f n:\n    f n + 1\nf 0\n').join('\n')).toMatch(/recursion too deep/);
    });

    test('a bad pin stops with a message', () => {
        expect(run('num p = 99\nset pin p high\n').join('\n')).toMatch(/pin number out of range/);
    });
});

describe('wifi inline', () => {
    test('connect wifi to "SSID" with "PSK" joins that network', () => {
        const out = run('connect wifi to "homenet" with "hunter22"\nif wifi connected:\n    print "up"\n');
        expect(out).toContain('wifi connect ssid=homenet');
        expect(out).toContain('up');
    });

    test('start wifi makes an access point and serve web serves it', () => {
        const out = run('start wifi "Zapp" with "hunter22"\nserve web\nprint wifi ip\n');
        expect(out).toEqual(['wifi ap ssid=Zapp', 'web serve port=80', '192.168.4.1']);
    });

    test('an open access point needs no password', () => {
        expect(run('start wifi "Zapp"\n')).toEqual(['wifi ap ssid=Zapp open']);
    });

    test('boards without a radio say so', () => {
        expect(run('serve web\n', ['--no-radio']).join('\n')).toMatch(/no radio/);
    });
});

describe('pico w led', () => {
    test('the virtual LED pin drives the radio chip\'s LED', () => {
        expect(run('set pin 32 high\n')).toEqual(['gpio 32=1']);
    });

    test('boards without a radio say so', () => {
        expect(run('set pin 32 high\n', ['--no-radio']).join('\n')).toMatch(/no radio LED/);
    });
});

describe('numbers', () => {
    const p = (expr: string) => run(`print ${expr}\n`)[0];

    test('whole numbers stay exact past 16 million, where floats give up', () => {
        expect(p('16777216 + 1')).toBe('16777217');
        expect(p('2000000000 + 100000000')).toBe('2100000000');
    });

    test('a whole number that overflows turns into a decimal instead of wrapping', () => {
        expect(Number(p('2147483647 + 1'))).toBeGreaterThan(2e9);
    });

    test('/ gives the real answer; // and % are floored', () => {
        expect([p('7 / 2'), p('8 / 2'), p('7 // 2'), p('-7 // 2'), p('-1 % 3'), p('7.5 // 2')])
            .toEqual(['3.5', '4', '3', '-4', '2', '3']);
    });

    test('** is power, and binds tighter than minus', () => {
        expect([p('2 ** 10'), p('-2 ** 2'), p('2 ** 0.5')]).toEqual(['1024', '-4', '1.41421']);
    });

    test('hex and binary literals', () => {
        expect([p('0xFF'), p('0b1010'), p('0x1_00')]).toEqual(['255', '10', '256']);
    });

    test('bit operators', () => {
        expect([p('0xF0 | 0x0F'), p('0xFF & 0x0F'), p('5 ^ 1'), p('1 << 8'), p('0x80 >> 4'), p('~0')])
            .toEqual(['255', '15', '4', '256', '8', '-1']);
        expect(p('(0x12 << 4) | (0x34 >> 4)')).toBe('291');
        expect(p('bit 7 of 0x80')).toBe('true');
        expect(p('bit 0 of 0x80')).toBe('false');
    });

    test('whole and decimal variables convert what is stored in them', () => {
        expect(run('whole steps = 2.7\nprint steps\nsteps = -3.9\nprint steps\ndecimal r = 1\nprint r / 4\n'))
            .toEqual(['2', '-3', '0.25']);
    });

    test('maths functions', () => {
        expect([p('abs(-3)'), p('round 2.5'), p('floor(-1.5)'), p('ceil 1.2'), p('sqrt(16)'),
                p('min(3, 7)'), p('max(3, 7)'), p('clamp(12, 0, 10)'), p('map(5, 0, 10, 0, 100)'),
                p('round(sin(90))')])
            .toEqual(['3', '3', '-2', '2', '4', '3', '7', '10', '50', '1']);
    });

    test('random stays in range', () => {
        const out = run('repeat 50:\n    print random(1, 6)\n').map(Number);
        expect(out.every(n => Number.isInteger(n) && n >= 1 && n <= 6)).toBe(true);
    });

    test('maths with too few values is a compile error', () => {
        expect(() => run('print min 3\n')).toThrow(/brackets/);
        expect(() => run('print clamp(1, 2)\n')).toThrow(/takes 3/);
    });
});

describe('bytes', () => {
    test('build, index, change and measure', () => {
        expect(run('bytes b = [1, 2, 0xFF]\nprint b[2]\nprint b[-1]\nset b[0] to 9\nprint b\nprint length of b\n'))
            .toEqual(['255', '255', '0902FF', '3']);
    });

    test('a byte out of range or a bad index stops with a message', () => {
        expect(run('bytes b = [256]\n').join('\n')).toMatch(/a byte is 0-255/);
        expect(run('bytes b = [1, 2]\nprint b[5]\n').join('\n')).toMatch(/index 5 is past the end \(length 2\)/);
    });

    test('as signed/unsigned N-bit reads bytes as a number', () => {
        expect(run('bytes b = [0xFF, 0x5C]\nprint b as signed 16-bit\nprint b as unsigned 16-bit\nprint b as unsigned 16-bit little endian\n'))
            .toEqual(['-164', '65372', '23807']);
        expect(run('print 0xFFFF as signed 16-bit\n')).toEqual(['-1']);
    });

    test('set x to works for plain variables too', () => {
        expect(run('num x = 1\nset x to x + 1\nprint x\n')).toEqual(['2']);
    });
});

describe('raw i2c and spi', () => {
    // Bus traffic only shows up in the trace without --quiet.
    const trace = (source: string) =>
        execFileSync(emulator, [compileSourceToPayload(source, modules, pico)], { encoding: 'utf8' }).trim().split('\n');

    test('read registers straight off a chip', () => {
        const out = run('num ax = read 2 bytes from i2c 0x68 at 0x3B as signed 16-bit\nprint ax\n' +
                        'print read 2 bytes from i2c 0x68 at 0x3D as signed 16-bit\n', [], pico);
        expect(out).toEqual(['328', '-164']);
    });

    test('send writes bytes, with or without a register', () => {
        const out = trace('send [0x00, 0xAF] to i2c 0x50\nsend 0x27 to i2c 0x76 at 0xF4\n').join('\n');
        expect(out).toMatch(/i2c write 0x50 len=2/);
        expect(out).toMatch(/i2c write 0x76 reg=0xF4 len=1/);
    });

    test('the bus comes from the board when there is no config', () => {
        expect(trace('send 1 to i2c 0x50\n')).toContain('i2c init sda=4 scl=5 freq=100000');
        expect(() => run('send 1 to i2c 0x50\n')).toThrow(/I2C needs to know its pins/);
    });

    test('spi transfer is full duplex (the emulator loops MISO back to MOSI)', () => {
        const out = run('bytes r = spi transfer [0x9F, 1, 2] with cs 5\nprint r\nprint read 2 bytes from spi with cs 5\n', [], pico);
        expect(out.filter(l => !l.startsWith('spi'))).toEqual(['9F0102', '0000']);
        expect(trace('send [1] to spi with cs 5\n')).toContain('spi init mosi=7 cs=255 freq=1000000 mode=0');
    });

    test('an address out of range stops with a message', () => {
        expect(run('send 1 to i2c 200\n', [], pico).join('\n')).toMatch(/I2C address is 0-127/);
    });
});

describe('function calls with brackets', () => {
    test('f(a, b) and f a b do the same thing', () => {
        expect(run('func add a b:\n    print a + b\nadd(2, 3)\nadd 2 3\n')).toEqual(['5', '5']);
    });
});

// Your own module: fields described by format/shift/bits/scale/offset compile to
// plain VM steps. The emulator's unknown I2C device answers bytes 1, 2, 3...
describe('modules described by registers', () => {
    const mod = (fields: string) => parseModuleFile(
        '[module]\nname = "probe"\n[compat]\ninterface = "i2c"\n[i2c]\naddr_default = 0x50\n' + fields);
    const read = (fields: string, field = 'v') => {
        const hex = compileSourceToPayload(`use probe\nget data from probe\nprint probe.${field}\n`, { probe: mod(fields) }, pico);
        return execFileSync(emulator, ['--quiet', hex], { encoding: 'utf8' }).trim();
    };

    test('format picks byte order and sign', () => {
        expect(read('[fields.v]\nreg = 0\nformat = "u16_be"\n')).toBe('258');     // 0x0102
        expect(read('[fields.v]\nreg = 0\nformat = "u16_le"\n')).toBe('513');     // 0x0201
        expect(read('[fields.v]\nreg = 0\nformat = "u24_be"\n')).toBe('66051');   // 0x010203
    });

    test('shift, bits, scale and offset apply in order', () => {
        expect(read('[fields.v]\nreg = 0\nformat = "u16_be"\nshift = 4\n')).toBe('16');
        expect(read('[fields.v]\nreg = 0\nformat = "u16_be"\nbits = 4\n')).toBe('2');
        expect(read('[fields.v]\nreg = 0\nformat = "u16_be"\nshift = 4\nscale = 0.5\noffset = -40\n')).toBe('-32');
    });

    test('a signed field narrower than its bytes keeps its sign', () => {
        expect(read('[fields.v]\nreg = 0\nformat = "i16_le"\nbits = 10\n')).toBe('-511');   // 0x201 in 10 bits
    });

    test('bool fields are true when any kept bit is set', () => {
        expect(read('[fields.v]\ntype = "bool"\nreg = 0\nformat = "u8"\nmask = 0x01\n')).toBe('true');
        expect(read('[fields.v]\ntype = "bool"\nreg = 0\nformat = "u8"\nmask = 0x02\n')).toBe('false');
    });

    test('mistakes are explained', () => {
        expect(() => mod('[fields.v]\nreg = 0\nformat = "u17"\n')).toThrow(/isn't one Zapp knows/);
        expect(() => mod('[fields.v]\nreg = 0\n')).toThrow(/needs a format/);
        expect(() => mod('[fields.v]\nreg = 0\nformat = "u16_be"\ntransform = "raw_u8"\n')).toThrow(/use one/);
        expect(() => mod('[fields.v]\nreg = 0\nformat = "u16_be"\nlen = 1\n')).toThrow(/needs 2 bytes/);
    });
});

