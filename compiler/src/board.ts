// Board profiles (boards/*.zappboard): what each pin is called on this board
// and which pins drive the on-board indicators, so programs can say
// `set pin LED high` instead of looking up GPIO numbers.

export interface Indicator {
    kind: string;          // led | neopixel | button
    activeLow: boolean;    // LED lights / button reads on a low level
    power?: number;        // pin that must be driven high first (NeoPixel power)
}

export interface BoardDefinition {
    name: string;
    chip: string;
    title: string;
    install: string;       // how to put this board into install (UF2 bootloader) mode
    radio: string;         // "wifi ble" on boards with a radio, "" otherwise
    pins: Record<string, number>;
    indicators: Record<string, Indicator>;
    reserved: Record<number, string>;   // GPIOs a program shouldn't touch, and why
}

// [board]  name/chip/title/install/radio
// [pins]   NAME = gpio
// [indicators]  NAME = "kind [active_low] [power=gpio]"   (NAME must be in [pins])
// [reserved]    gpio = "why"   — the IDE warns when a program uses it
export function parseBoardFile(text: string): BoardDefinition {
    const board: BoardDefinition = { name: '', chip: 'unknown', title: '', install: '', radio: '', pins: {}, indicators: {}, reserved: {} };
    let section = '';

    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/#.*/, '').trim();
        if (!line) continue;
        if (line.startsWith('[') && line.endsWith(']')) { section = line.slice(1, -1); continue; }

        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim().replace(/^"|"$/g, '');

        if (section === 'board' && (key === 'name' || key === 'chip' || key === 'title' || key === 'install' || key === 'radio')) {
            board[key] = value;
        } else if (section === 'pins') {
            if (!/^\d+$/.test(value)) throw new Error(`Pin ${key} must be a GPIO number, got '${value}'`);
            board.pins[key] = Number(value);
        } else if (section === 'reserved') {
            if (!/^\d+$/.test(key)) throw new Error(`Reserved pin must be a GPIO number, got '${key}'`);
            board.reserved[Number(key)] = value;
        } else if (section === 'indicators') {
            const [kind = 'led', ...flags] = value.split(/\s+/);
            const power = flags.find(f => f.startsWith('power='))?.slice('power='.length);
            board.indicators[key] = {
                kind,
                activeLow: flags.includes('active_low'),
                ...(power !== undefined ? { power: Number(power) } : {}),
            };
        }
    }

    for (const name of Object.keys(board.indicators)) {
        if (board.pins[name] === undefined) throw new Error(`Indicator ${name} has no entry in [pins]`);
    }
    board.title ||= board.name;
    board.install ||= 'Hold the BOOT button while you plug the board in';
    return board;
}
