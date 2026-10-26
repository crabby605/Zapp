// Hardware quirks: things that compile fine but won't behave on the real board.
// The emitter records what a program touches (Usage); this checks it against
// what the chip and board can actually do and returns warnings, never errors.
import type { BoardDefinition } from './board';

export interface Warning { line: number; message: string }

export interface PinUse { pin: number; name?: string; line: number }

export interface Usage {
    pins: PinUse[];                                   // every literal or named pin
    analog: PinUse[];
    pwm: (PinUse & { freq?: number })[];             // servos have no freq: they get their own timer
    driven: Set<number>;                              // pins set high somewhere
    wifi: number | null;                              // first line that uses Wi-Fi
    ble: number | null;                               // first line that uses Bluetooth
    i2c: number | null;                               // first line that uses I2C
    httpPost: number[];
    https: number[];
}

export const emptyUsage = (): Usage => ({
    pins: [], analog: [], pwm: [], driven: new Set(), wifi: null, ble: null, i2c: null, httpPost: [], https: [],
});

interface Chip {
    analog: number[];
    reserved: Record<number, string>;
    adcBlockedByWifi?: number[];   // ADC2 shares hardware with the radio
    pwmChannels?: number;
    pwmSharesFrequency?: boolean;
    httpPost?: boolean;            // false where the radio backend can't POST
    https?: boolean;
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const CHIPS: Record<string, Chip> = {
    rp2040: {
        analog: [26, 27, 28, 29],
        reserved: {},
        httpPost: false,
        https: false,
    },
    esp32s3: {
        analog: range(1, 20),
        reserved: { 19: 'is the USB D− line', 20: 'is the USB D+ line' },
        adcBlockedByWifi: range(11, 20),
        pwmChannels: 8,
        pwmSharesFrequency: true,
    },
};

const label = (u: PinUse) => u.name ? `${u.name} (GPIO${u.pin})` : `pin ${u.pin}`;

export function hardwareWarnings(board: BoardDefinition | undefined, use: Usage): Warning[] {
    if (!board) return [];
    const chip = CHIPS[board.chip];
    const out: Warning[] = [];
    const once = new Set<string>();
    const warn = (line: number, message: string) => {
        if (once.has(message)) return;
        once.add(message);
        out.push({ line, message });
    };

    for (const u of use.pins) {
        const why = board.reserved[u.pin] ?? chip?.reserved[u.pin];
        if (why) warn(u.line, `${label(u)} ${why} on the ${board.title}, so using it will break that`);
    }

    if (chip) {
        const analogNames = Object.entries(board.pins)
            .filter(([name, pin]) => /^A\d+$/.test(name) && chip.analog.includes(pin)).map(([name]) => name);
        for (const u of use.analog) {
            if (!chip.analog.includes(u.pin)) {
                warn(u.line, `${label(u)} can't read analog on the ${board.title}` +
                    (analogNames.length ? ` — use ${analogNames.join(', ')}` : ''));
            } else if (use.wifi !== null && chip.adcBlockedByWifi?.includes(u.pin)) {
                const free = analogNames.filter(n => !chip.adcBlockedByWifi!.includes(board.pins[n]!));
                warn(u.line, `${label(u)} is on ADC2, which Wi-Fi uses: reads can fail while Wi-Fi is on` +
                    (free.length ? ` — ${free.join(', ')} ${free.length > 1 ? 'are' : 'is'} on ADC1 and always work` : ''));
            }
        }

        const pwmPins = new Set(use.pwm.map(p => p.pin));
        if (chip.pwmChannels && pwmPins.size > chip.pwmChannels) {
            warn(use.pwm[0]!.line, `Only ${chip.pwmChannels} pins can do PWM at once on the ${board.title}; this program uses ${pwmPins.size}`);
        }
        const tones = use.pwm.filter(p => p.freq !== undefined);
        const freqs = new Set(tones.map(p => p.freq!));
        if (chip.pwmSharesFrequency && freqs.size > 1) {
            const last = tones[tones.length - 1]!;
            warn(last.line, `PWM pins share one frequency on the ${board.title}: every pin runs at whichever ` +
                `of ${[...freqs].sort((a, b) => a - b).join(' / ')} hz was set last`);
        }

        if (board.radio) {
            if (chip.httpPost === false) {
                for (const line of use.httpPost) warn(line, `The ${board.title} can't send http post yet — only http get (the simulator does both)`);
            }
            if (chip.https === false) {
                for (const line of use.https) warn(line, `The ${board.title} can't do https:// — use http://`);
            }
        }
    }

    const radioLine = [use.wifi, use.ble].filter((l): l is number => l !== null).sort((a, b) => a - b)[0];
    if (!board.radio && radioLine !== undefined) {
        warn(radioLine, `The ${board.title} has no radio, so Wi-Fi and Bluetooth stop the program on the board`);
    }

    const i2cPower = board.pins.I2C_POWER;
    if (i2cPower !== undefined && use.i2c !== null && !use.driven.has(i2cPower)) {
        warn(use.i2c, `The ${board.title}'s STEMMA QT port has no power until \`set pin I2C_POWER high\``);
    }

    return out.sort((a, b) => a.line - b.line);
}
