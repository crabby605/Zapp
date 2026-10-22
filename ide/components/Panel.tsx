'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { BoardDefinition } from '../../compiler/src/index';
import type { RunResult, TraceEvent } from '../lib/trace';

// Output: one console for the simulator and the board

export interface OutputLine {
    text: string;
    kind: 'out' | 'err' | 'in' | 'note' | 'detail';
}

const BUS_KINDS = new Set(['i2c', 'spi', 'uart']);

// "GP25" → "LED" when the board has a name for it.
function pinLabel(board: BoardDefinition | undefined, gpio: number): string {
    const named = Object.entries(board?.indicators ?? {}).find(([n]) => board!.pins[n] === gpio)?.[0]
        ?? Object.entries(board?.pins ?? {}).find(([n, p]) => p === gpio && !/^GP\d+$/.test(n))?.[0];
    return named ? `${named} (GP${gpio})` : `GP${gpio}`;
}

/** Simulator events as plain sentences; bus traffic is marked as detail. */
export function describeRun(result: RunResult, board: BoardDefinition | undefined): OutputLine[] {
    return result.events.map((e: TraceEvent): OutputLine => {
        if (e.kind === 'print') return { text: e.detail, kind: 'out' };
        if (e.kind === 'error') return { text: e.detail, kind: 'err' };
        const gpio = /^gpio (\d+)=(\d)$/.exec(e.raw);
        if (gpio) {
            const pin = Number(gpio[1]);
            const name = Object.keys(board?.indicators ?? {}).find((n) => board!.pins[n] === pin);
            const high = gpio[2] === '1';
            const lit = name && board!.indicators[name]!.activeLow ? !high : high;
            return { text: `${pinLabel(board, pin)} → ${name ? (lit ? 'on' : 'off') : (high ? 'high' : 'low')}`, kind: 'note' };
        }
        return { text: `${e.target} · ${e.detail}`, kind: BUS_KINDS.has(e.kind) ? 'detail' : 'note' };
    });
}

export function Output({ lines, connected, onSend }: {
    lines: OutputLine[];
    connected: boolean;
    onSend: (line: string) => void;
}) {
    const [details, setDetails] = useState(false);
    const [command, setCommand] = useState('');
    const endRef = useRef<HTMLDivElement>(null);
    const shown = details ? lines : lines.filter((l) => l.kind !== 'detail');
    useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [shown.length]);

    return (
        <section className="card output">
            <header className="card-head">
                <h3>Output</h3>
                <label className="toggle" title="Show I2C / SPI / UART bus traffic">
                    <input type="checkbox" checked={details} onChange={(e) => setDetails(e.target.checked)} />
                    bus details
                </label>
            </header>
            <div className="console">
                {shown.length === 0 && (
                    <p className="hint">Press <b>Run</b> — anything your program prints shows up here.</p>
                )}
                {shown.map((l, i) => <div key={i} className={`line ${l.kind}`}>{l.text}</div>)}
                <div ref={endRef} />
            </div>
            {connected && (
                <form className="console-input" onSubmit={(e) => {
                    e.preventDefault();
                    if (!command.trim()) return;
                    onSend(command.trim());
                    setCommand('');
                }}>
                    <span className="prompt">›</span>
                    <input value={command} onChange={(e) => setCommand(e.target.value)}
                           placeholder="Type a board command — try: help" />
                </form>
            )}
        </section>
    );
}

// Lights: the board's LEDs, NeoPixel and buttons

interface Pixel { r: number; g: number; b: number; brightness: number }

function lastPixel(result: RunResult | null, pin: number): Pixel | null {
    let px: Pixel | null = null;
    let brightness = 255;
    for (const e of result?.events ?? []) {
        const all = /^neo (\d+) (?:all|\[0\])=(\d+),(\d+),(\d+)$/.exec(e.raw);
        if (all && Number(all[1]) === pin) px = { r: +all[2]!, g: +all[3]!, b: +all[4]!, brightness };
        const br = /^neo (\d+) brightness=(\d+)$/.exec(e.raw);
        if (br && Number(br[1]) === pin) { brightness = +br[2]!; if (px) px.brightness = brightness; }
    }
    return px;
}

export function Lights({ board, result, pressed, onPress }: {
    board: BoardDefinition | undefined;
    result: RunResult | null;
    pressed: Set<string>;
    onPress: (name: string) => void;
}) {
    const items = Object.entries(board?.indicators ?? {});
    if (!items.length) return null;

    return (
        <div className="lights">
            {items.map(([name, ind]) => {
                const pin = board!.pins[name]!;
                if (ind.kind === 'button') {
                    const down = pressed.has(name);
                    return (
                        <button key={name} className={`light button ${down ? 'down' : ''}`}
                                onClick={() => onPress(name)}
                                title="Click to hold this button pressed in the simulator">
                            <span className="dot" />
                            <span className="label">{name}</span>
                            <span className="sub">{down ? 'held' : 'click to press'}</span>
                        </button>
                    );
                }
                if (ind.kind === 'neopixel') {
                    const px = lastPixel(result, pin);
                    const on = px && (px.r || px.g || px.b) && px.brightness > 0;
                    const color = px ? `rgb(${px.r}, ${px.g}, ${px.b})` : undefined;
                    return (
                        <div key={name} className={`light ${on ? 'on' : ''}`}>
                            <span className="dot" style={on ? { background: color, boxShadow: `0 0 14px ${color}`, opacity: 0.35 + 0.65 * (px!.brightness / 255) } : undefined} />
                            <span className="label">{name}</span>
                            <span className="sub">{on ? `${px!.r} ${px!.g} ${px!.b}` : 'off'}</span>
                        </div>
                    );
                }
                const level = result?.pinStates[pin];
                const lit = level === undefined ? false : ind.activeLow ? !level : level;
                return (
                    <div key={name} className={`light led ${lit ? 'on' : ''} ${ledColor(name)}`}>
                        <span className="dot" />
                        <span className="label">{name}</span>
                        <span className="sub">{lit ? 'on' : 'off'}</span>
                    </div>
                );
            })}
        </div>
    );
}

const ledColor = (name: string) =>
    /RED/.test(name) ? 'red' : /GREEN/.test(name) ? 'green' : /BLUE/.test(name) ? 'blue' : 'amber';

// Screen: the OLED framebuffer, drawn

export function Screen({ framebuffer, rows }: { framebuffer: Uint8Array; rows: number }) {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;
        const scale = 2;
        canvas.width = 128 * scale;
        canvas.height = rows * scale;
        ctx.fillStyle = '#04060a';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#9fe7ff';
        // Page-major: byte (page, x) holds 8 vertical pixels.
        for (let y = 0; y < rows; y++) {
            for (let x = 0; x < 128; x++) {
                if ((framebuffer[(y >> 3) * 128 + x] ?? 0) & (1 << (y & 7))) {
                    ctx.fillRect(x * scale, y * scale, scale - 0.3, scale - 0.3);
                }
            }
        }
    }, [framebuffer, rows]);

    return <canvas ref={canvasRef} className="oled" style={{ aspectRatio: `128 / ${rows}` }} />;
}

// Pins used by the last simulation

export function PinsUsed({ board, result }: { board: BoardDefinition | undefined; result: RunResult | null }) {
    const pins = useMemo(() => Object.entries(result?.pinStates ?? {}).map(([p, high]) => [Number(p), high] as const)
        .sort((a, b) => a[0] - b[0]), [result]);
    if (!pins.length) return null;
    return (
        <div className="pins">
            {pins.map(([pin, high]) => (
                <span key={pin} className={`pin ${high ? 'high' : ''}`}>
                    {pinLabel(board, pin)} <b>{high ? 'HIGH' : 'LOW'}</b>
                </span>
            ))}
        </div>
    );
}
