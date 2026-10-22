// Turns the emulator's stdout into typed hardware events so the Run, Pins and
// Display panels can show what the program did instead of a wall of text.
// The vocabulary is fixed by the printf calls in emulator/zapp_emu.c.

export type EventKind =
    | 'gpio' | 'pwm' | 'servo' | 'adc' | 'i2c' | 'spi'
    | 'uart' | 'neo' | 'hid' | 'wifi' | 'ble' | 'print' | 'error';

export interface TraceEvent {
    seq: number;
    kind: EventKind;
    target: string;     // pin number, device address, "—"
    detail: string;
    raw: string;
}

export interface RunResult {
    events: TraceEvent[];
    /** Last known level per pin, for the pin map. */
    pinStates: Record<number, boolean>;
    /** 1024-byte SSD1306 framebuffer, page-major, or null when unused. */
    framebuffer: Uint8Array | null;
    summary: string;
    bytes: number;
}

const MATCHERS: [RegExp, EventKind, (m: RegExpMatchArray) => [string, string]][] = [
    [/^gpio (\d+)=(\d)$/,                     'gpio',  (m) => [`GP${m[1]}`, m[2] === '1' ? 'high' : 'low']],
    [/^pwm (\d+) duty=(\d+) freq=(\d+)$/,     'pwm',   (m) => [`GP${m[1]}`, `duty ${m[2]}/255 · ${m[3]} Hz`]],
    [/^pwm (\d+) off$/,                       'pwm',   (m) => [`GP${m[1]}`, 'off']],
    [/^servo (\d+)=(-?\d+)$/,                 'servo', (m) => [`GP${m[1]}`, `${m[2]}°`]],
    [/^i2c init sda=(\d+) scl=(\d+) freq=(\d+)$/, 'i2c', (m) => ['bus', `SDA GP${m[1]} · SCL GP${m[2]} · ${Number(m[3]) / 1000} kHz`]],
    [/^i2c read (0x[0-9A-F]+) reg=(0x[0-9A-F]+) len=(\d+)$/, 'i2c', (m) => [m[1]!, `read ${m[3]} bytes from reg ${m[2]}`]],
    [/^i2c write (0x[0-9A-F]+) reg=(0x[0-9A-F]+) len=(\d+)$/, 'i2c', (m) => [m[1]!, `write ${m[3]} bytes to reg ${m[2]}`]],
    [/^i2c write (0x[0-9A-F]+) len=(\d+)$/,   'i2c',   (m) => [m[1]!, `write ${m[2]} bytes`]],
    [/^spi init mosi=(\d+) cs=(\d+) freq=(\d+) mode=(\d+)$/, 'spi', (m) => ['bus', `MOSI GP${m[1]} · CS GP${m[2]} · ${Number(m[3]) / 1000000} MHz · mode ${m[4]}`]],
    [/^spi transfer cs=(\d+) rx_len=(\d+)$/,  'spi',   (m) => [`CS GP${m[1]}`, `read ${m[2]} bytes`]],
    [/^spi cs (\d+)=(\d)$/,                   'spi',   (m) => [`CS GP${m[1]}`, m[2] === '1' ? 'active' : 'idle']],
    [/^uart init tx=(\d+) rx=(\d+) baud=(\d+)$/, 'uart', (m) => ['port', `TX GP${m[1]} · RX GP${m[2]} · ${m[3]} baud`]],
    [/^uart write (.*)$/,                     'uart',  (m) => ['tx', m[1]!]],
    [/^neo (\d+) \[(\d+)\]=(\d+),(\d+),(\d+)$/, 'neo', (m) => [`GP${m[1]}`, `pixel ${m[2]} → rgb(${m[3]}, ${m[4]}, ${m[5]})`]],
    [/^neo (\d+) all=(\d+),(\d+),(\d+)$/,     'neo',   (m) => [`GP${m[1]}`, `all → rgb(${m[2]}, ${m[3]}, ${m[4]})`]],
    [/^neo (\d+) brightness=(\d+)$/,          'neo',   (m) => [`GP${m[1]}`, `brightness ${m[2]}`]],
    [/^neo (\d+) show$/,                      'neo',   (m) => [`GP${m[1]}`, 'latch']],
    [/^neo init (\d+) count=(\d+)$/,          'neo',   (m) => [`GP${m[1]}`, `${m[2]} pixels`]],
    [/^hid type (.*)$/,                       'hid',   (m) => ['keyboard', `type "${m[1]}"`]],
    [/^hid key mod=(0x[0-9A-F]+) code=(0x[0-9A-F]+)$/, 'hid', (m) => ['keyboard', `key ${m[2]} (mod ${m[1]})`]],
    [/^hid mouse dx=(-?\d+) dy=(-?\d+) buttons=(\d+) scroll=(-?\d+)$/, 'hid', (m) => ['mouse', `move ${m[1]},${m[2]} · buttons ${m[3]} · scroll ${m[4]}`]],
    [/^wifi connect ssid=(.*)$/,              'wifi',  (m) => ['radio', `join "${m[1]}"`]],
    [/^http (GET|POST) (\S+)(?: body=(.*))?$/, 'wifi', (m) => ['http', `${m[1]} ${m[2]}${m[3] ? ` · ${m[3]}` : ''}`]],
    [/^ble advertise name=(.*)$/,             'ble',   (m) => ['radio', `advertise "${m[1]}"`]],
    [/^ble notify (.*)$/,                     'ble',   (m) => ['notify', m[1]!]],
];

export function parseTrace(stdout: string): { events: TraceEvent[]; pinStates: Record<number, boolean>; framebuffer: Uint8Array | null } {
    const events: TraceEvent[] = [];
    const pinStates: Record<number, boolean> = {};
    let framebuffer: Uint8Array | null = null;
    let seq = 0;

    for (const raw of stdout.split('\n')) {
        const line = raw.trimEnd();
        if (!line) continue;

        if (line.startsWith('fb:')) {
            const hex = line.slice(3);
            framebuffer = new Uint8Array(hex.length / 2);
            for (let i = 0; i < framebuffer.length; i++) {
                framebuffer[i] = parseInt(hex.substr(i * 2, 2), 16);
            }
            continue;
        }
        if (line === 'display:' || line.startsWith('  ')) continue;   // ASCII art, superseded by fb:

        const gpio = line.match(/^gpio (\d+)=(\d)$/);
        if (gpio) pinStates[Number(gpio[1])] = gpio[2] === '1';

        const matched = MATCHERS.find(([pattern]) => pattern.test(line));
        if (matched) {
            const [pattern, kind, describe] = matched;
            const [target, detail] = describe(line.match(pattern)!);
            events.push({ seq: seq++, kind, target, detail, raw: line });
        } else {
            // Anything else is the program talking: print output or a VM error.
            const isError = /Error:/.test(line);
            events.push({
                seq: seq++,
                kind: isError ? 'error' : 'print',
                target: isError ? 'vm' : 'print',
                detail: line,
                raw: line,
            });
        }
    }

    return { events, pinStates, framebuffer };
}

export const KIND_LABELS: Record<EventKind, string> = {
    print: 'output', error: 'errors', gpio: 'gpio', pwm: 'pwm', servo: 'servo',
    adc: 'adc', i2c: 'i2c', spi: 'spi', uart: 'uart', neo: 'pixels',
    hid: 'hid', wifi: 'wi-fi', ble: 'ble',
};
