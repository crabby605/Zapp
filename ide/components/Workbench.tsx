'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { compileSourceToPayload, identityBoard, parseModuleFile, type BoardDefinition } from '../../compiler/src/index';
import type { ModuleDefinition } from '../../compiler/src/emitter';
import { formatZapp, registerZappLanguage, setLanguageContext } from '../lib/zappLanguage';
import { ZappSerial } from '../lib/serial';
import { parseTrace, type RunResult } from '../lib/trace';
import * as ws from '../lib/workspace';
import { CommandPalette, type Command } from './CommandPalette';
import { InstallDialog } from './InstallDialog';
import { Lights, Output, PinsUsed, Screen, describeRun, type OutputLine } from './Panel';
import { Guide, Parts, Programs } from './Sidebar';
import { IconBolt, IconCheck, IconChevron, IconChip, IconClose, IconDownload, IconFiles, IconHelp, IconPlay, IconSearch, IconStop, IconWarn } from './icons';

const Editor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

type SimScreen = 'ssd1306' | 'ssd1306_32' | 'sh1106' | 'none';
const SCREEN_LABELS: Record<SimScreen, string> = {
    ssd1306: '0.96" OLED (128×64)', ssd1306_32: '0.91" OLED (128×32)', sh1106: '1.3" OLED (SH1106)', none: 'No screen',
};
const BUDGET = 2048;

// Compiler errors carry their location as "... at line 7" or "[7:3] ...".
function errorLine(message: string): number | null {
    const match = message.match(/at line (\d+)/) ?? message.match(/^\[(\d+):/);
    return match ? Number(match[1]) : null;
}
const cleanError = (message: string) => message.replace(/ at line \d+/, '').replace(/^\[\d+:\d+\]\s*/, '');
const pretty = (path: string) => ws.fileName(path).replace(/\.zap$/, '').replace(/[_-]+/g, ' ');

export function Workbench() {
    const [tree, setTree] = useState<ws.FileTree | null>(null);
    const [buffers, setBuffers] = useState<Record<string, ws.Buffer>>({});
    const [active, setActive] = useState<string | null>(null);

    const [modules, setModules] = useState<Record<string, ModuleDefinition>>({});
    const [boards, setBoards] = useState<BoardDefinition[]>([]);
    const [boardName, setBoardName] = useState('pico');
    const installedBoard = useRef<string | null>(null);   // picked in the install dialog, told to the board on connect

    const [build, setBuild] = useState<{ bytes: number; error: string | null }>({ bytes: 0, error: null });
    const [sim, setSim] = useState<RunResult | null>(null);
    const [busy, setBusy] = useState(false);
    const [simScreen, setSimScreen] = useState<SimScreen>('ssd1306');
    const [pressed, setPressed] = useState<Set<string>>(new Set());

    const [output, setOutput] = useState<OutputLine[]>([]);
    const [connected, setConnected] = useState(false);

    // The tool window opened from the left ribbon, like JetBrains' Project / Structure panes.
    const [tool, setTool] = useState<null | 'programs' | 'parts' | 'guide'>('programs');
    const [menu, setMenu] = useState<null | 'run' | 'board'>(null);
    const [outputWidth, setOutputWidth] = useState(520);
    const [errorsHidden, setErrorsHidden] = useState(false);
    const [installOpen, setInstallOpen] = useState(false);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [toast, setToast] = useState<string | null>(null);

    const serialRef = useRef<ZappSerial | null>(null);
    const editorRef = useRef<any>(null);
    const monacoRef = useRef<any>(null);

    const buffer = active ? buffers[active] : undefined;
    const source = buffer?.content ?? '';
    const board = boards.find((b) => b.name === boardName);
    const isExample = !!buffer && !buffer.writable;

    const log = useCallback((lines: OutputLine | OutputLine[]) =>
        setOutput((prev) => [...prev, ...(Array.isArray(lines) ? lines : [lines])].slice(-800)), []);
    const notify = (message: string) => setToast(message);
    useEffect(() => {
        if (!toast) return;
        const id = setTimeout(() => setToast(null), 3200);
        return () => clearTimeout(id);
    }, [toast]);

    // Loading
    const refreshTree = useCallback(async () => {
        try { setTree(await ws.listFiles()); } catch { notify('Could not read your programs folder'); }
    }, []);

    const openPath = useCallback(async (path: string) => {
        setActive(path);
        if (buffers[path]) return;
        try {
            const file = await ws.readFile(path);
            setBuffers((prev) => ({ ...prev, [path]: { path, content: file.content, saved: file.content, writable: file.writable } }));
        } catch (e) {
            notify(e instanceof Error ? e.message : 'Could not open that file');
        }
    }, [buffers]);

    useEffect(() => {
        void refreshTree();
        fetch('/api/modules').then((r) => r.json()).then((data: Record<string, string>) => {
            if ((data as any).error) return;
            const loaded: Record<string, ModuleDefinition> = {};
            for (const [name, text] of Object.entries(data)) {
                try { loaded[name] = parseModuleFile(text); } catch { /* skip a broken module */ }
            }
            setModules(loaded);
        }).catch(() => undefined);
        fetch('/api/board').then((r) => r.json()).then((data) => setBoards(data.boards ?? [])).catch(() => undefined);

        const session = ws.loadSession();
        try {
            const saved = localStorage.getItem('zapp.board');
            if (saved) setBoardName(saved);
        } catch { /* storage unavailable */ }
        const first = session.active ?? 'workspace/main.zap';
        ws.readFile(first).then(
            (file) => {
                setBuffers({ [first]: { path: first, content: file.content, saved: file.content, writable: file.writable } });
                setActive(first);
            },
            () => undefined,
        );
    }, [refreshTree]);

    useEffect(() => { ws.saveSession({ open: active ? [active] : [], active }); }, [active]);
    useEffect(() => {
        try { localStorage.setItem('zapp.board', boardName); } catch { /* storage unavailable */ }
    }, [boardName]);
    useEffect(() => { setLanguageContext({ modules, pins: board?.pins ?? {} }); }, [modules, board]);

    // Build as you type
    const compile = useCallback(() => compileSourceToPayload(source, modules, board), [source, modules, board]);

    useEffect(() => {
        const id = setTimeout(() => {
            if (!active?.endsWith('.zap')) return setBuild({ bytes: 0, error: null });
            try {
                const payload = compile();
                setBuild({ bytes: (payload.length - 3) / 2, error: null });
            } catch (e) {
                setBuild({ bytes: 0, error: e instanceof Error ? e.message : 'compile failed' });
            }
        }, 220);
        return () => clearTimeout(id);
    }, [compile, active]);

    const problemLine = build.error ? errorLine(build.error) : null;

    useEffect(() => {
        const monaco = monacoRef.current;
        const model = editorRef.current?.getModel();
        if (!monaco || !model) return;
        monaco.editor.setModelMarkers(model, 'zapp', build.error ? [{
            severity: monaco.MarkerSeverity.Error,
            message: cleanError(build.error),
            startLineNumber: problemLine ?? 1,
            endLineNumber: problemLine ?? 1,
            startColumn: 1,
            endColumn: model.getLineMaxColumn(Math.min(problemLine ?? 1, model.getLineCount())),
        }] : []);
    }, [build.error, problemLine]);

    // Files
    const setContent = (path: string, content: string) =>
        setBuffers((prev) => (prev[path] ? { ...prev, [path]: { ...prev[path]!, content } } : prev));

    const save = useCallback(async () => {
        if (!buffer?.writable) return;
        const formatted = buffer.path.endsWith('.zap') ? formatZapp(buffer.content) : buffer.content;
        try {
            await ws.writeFile(buffer.path, formatted);
            setBuffers((prev) => ({ ...prev, [buffer.path]: { ...prev[buffer.path]!, content: formatted, saved: formatted } }));
            notify('Saved');
            void refreshTree();
        } catch (e) {
            notify(e instanceof Error ? e.message : 'Save failed');
        }
    }, [buffer, refreshTree]);

    const createFile = async () => {
        const name = prompt('Name your program', 'my program');
        if (!name) return;
        const file = name.trim().replace(/\s+/g, '_');
        const { path } = await ws.createFile(file.endsWith('.zap') ? file : `${file}.zap`, '# my program\n\n');
        await refreshTree();
        if (path) void openPath(path);
    };

    const copyExample = async () => {
        if (!buffer) return;
        const { path } = await ws.copyToWorkspace(buffer.path);
        await refreshTree();
        if (path) {
            // Carry over any edits made to the example before copying.
            await ws.writeFile(path, buffer.content);
            setBuffers((prev) => ({ ...prev, [path]: { path, content: buffer.content, saved: buffer.content, writable: true } }));
            setActive(path);
            notify(`Copied to My programs as “${pretty(path)}”`);
        }
    };

    const removeFile = async (path: string) => {
        if (!confirm(`Delete “${pretty(path)}”? This can't be undone.`)) return;
        await ws.deleteFile(path);
        setBuffers((prev) => { const next = { ...prev }; delete next[path]; return next; });
        if (active === path) setActive(null);
        await refreshTree();
    };

    const rename = async (path: string) => {
        const name = prompt('Rename to', pretty(path));
        if (!name) return;
        const file = name.trim().replace(/\s+/g, '_');
        const result = await ws.renameFile(path, file.endsWith('.zap') ? file : `${file}.zap`);
        await refreshTree();
        if (result.path) {
            setBuffers((prev) => { const next = { ...prev }; delete next[path]; return next; });
            if (active === path) void openPath(result.path);
        }
    };

    // Board connection
    const onDisconnected = useCallback(() => {
        serialRef.current = null;
        setConnected(false);
        log({ text: 'Board disconnected.', kind: 'note' });
    }, [log]);

    const connect = useCallback(async () => {
        if (!ZappSerial.supported()) return notify('Connecting a board needs Chrome or Edge');
        try {
            const serial = new ZappSerial((line) => {
                if (line.startsWith('ZAPP:') || line === 'OK') return;   // protocol chatter
                log({ text: line, kind: line.startsWith('ERR:') || /Error:/.test(line) ? 'err' : 'out' });
            }, onDisconnected);
            await serial.connect();
            serialRef.current = serial;
            setConnected(true);
            // The board remembers what it is once told. Freshly installed, it's
            // told the board picked in the install dialog.
            const told = identityBoard(serial.identity);
            const name = installedBoard.current ?? told;
            if (name && name !== told) await serial.sendLine(`board ${name}`);
            installedBoard.current = null;
            const known = boards.find((b) => b.name === name);
            if (known) setBoardName(known.name);
            log(known
                ? { text: `Connected to ${known.title}.`, kind: 'note' }
                : { text: 'Connected. Which board is this? Pick it in the simulator\'s board menu — it will remember.', kind: 'note' });
        } catch (e) {
            if (e instanceof DOMException && e.name === 'NotFoundError') return;   // closed the picker
            notify(e instanceof Error ? e.message : 'Could not connect');
        }
    }, [boards, log, onDisconnected]);

    // Picking a board while one is connected tells it what it is, for next time.
    const chooseBoard = (name: string) => {
        setBoardName(name);
        if (serialRef.current?.connected) void serialRef.current.sendLine(`board ${name}`);
    };

    const disconnect = async () => {
        await serialRef.current?.disconnect();
        serialRef.current = null;
        setConnected(false);
    };

    // Run
    const simulate = useCallback(async () => {
        if (build.error) return notify('Fix the problem in your code first');
        setBusy(true);
        try {
            // Buttons idle at their released level; held ones at the pressed level.
            const gpio = Object.entries(board?.indicators ?? {})
                .filter(([, ind]) => ind.kind === 'button')
                .map(([name, ind]) => `${board!.pins[name]}=${pressed.has(name) === ind.activeLow ? 0 : 1}`);
            const res = await fetch('/api/emulate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ payload: compile(), gpio, noRadio: board?.name !== 'pico_w', display: simScreen }),
            });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            const result = { ...parseTrace(data.output as string), summary: data.summary, bytes: data.bytes };
            setSim(result);
            log([{ text: '▶ Simulation', kind: 'note' }, ...describeRun(result, board)]);
        } catch (e) {
            log({ text: e instanceof Error ? e.message : 'Simulation failed', kind: 'err' });
        } finally {
            setBusy(false);
        }
    }, [build.error, board, pressed, compile, simScreen, log]);

    // On a connected board, Run runs there — without replacing the saved program.
    const run = useCallback(async () => {
        if (!serialRef.current) return simulate();
        if (build.error) return notify('Fix the problem in your code first');
        try {
            await serialRef.current.sendLine(compile().replace(/^BC:/, 'RUN:'));
            log({ text: `▶ Running “${active ? pretty(active) : 'program'}” on the board`, kind: 'note' });
        } catch (e) {
            notify(e instanceof Error ? e.message : 'Could not send to the board');
        }
    }, [simulate, build.error, compile, active, log]);

    const saveToBoard = useCallback(async () => {
        if (!serialRef.current) return notify('Connect a board first');
        if (build.error) return notify('Fix the problem in your code first');
        try {
            await serialRef.current.sendLine(compile());
            log({ text: `✓ Saved “${active ? pretty(active) : 'program'}” to the board — it now runs every time the board powers up.`, kind: 'note' });
        } catch (e) {
            notify(e instanceof Error ? e.message : 'Could not send to the board');
        }
    }, [build.error, compile, active, log]);

    const sendCommand = (line: string) => {
        log({ text: `› ${line}`, kind: 'in' });
        void serialRef.current?.sendLine(line);
    };

    const insert = (text: string) => {
        editorRef.current?.trigger('ide', 'type', { text });
        editorRef.current?.focus();
    };

    const goToLine = (line: number) => {
        editorRef.current?.revealLineInCenter(line);
        editorRef.current?.setPosition({ lineNumber: line, column: 1 });
        editorRef.current?.focus();
    };

    const togglePress = (name: string) => setPressed((prev) => {
        const next = new Set(prev);
        if (next.has(name)) next.delete(name); else next.add(name);
        return next;
    });

    // Commands & keys
    const commands: Command[] = useMemo(() => [
        { id: 'run', group: 'Run', title: connected ? 'Run on the board' : 'Run in the simulator', keys: '⌘⏎', run: () => void run() },
        { id: 'sim', group: 'Run', title: 'Simulate', run: () => void simulate() },
        { id: 'saveboard', group: 'Run', title: 'Save to board (runs on power-up)', keys: '⇧⌘S', run: () => void saveToBoard() },
        { id: 'stop', group: 'Board', title: 'Stop the program on the board', run: () => void serialRef.current?.stop() },
        { id: 'restart', group: 'Board', title: 'Restart the saved program', run: () => void serialRef.current?.reload() },
        { id: 'connect', group: 'Board', title: connected ? 'Disconnect board' : 'Connect board', run: () => void (connected ? disconnect() : connect()) },
        { id: 'install', group: 'Board', title: 'Install Zapp on a board…', run: () => setInstallOpen(true) },
        { id: 'save', group: 'File', title: 'Save', keys: '⌘S', run: () => void save() },
        { id: 'new', group: 'File', title: 'New program', run: () => void createFile() },
        ...(tree?.workspace ?? []).filter((f) => f.name.endsWith('.zap')).map((f) => ({
            id: `open:${f.path}`, group: 'My programs', title: pretty(f.path), run: () => void openPath(f.path),
        })),
        ...(tree?.examples ?? []).map((f) => ({
            id: `ex:${f.path}`, group: 'Examples', title: pretty(f.path), run: () => void openPath(f.path),
        })),
    ], [run, simulate, saveToBoard, save, connected, connect, tree, openPath]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const mod = e.metaKey || e.ctrlKey;
            if (e.key === 'Escape') setMenu(null);
            if (!mod) return;
            if (e.key === 'Enter') { e.preventDefault(); void run(); }
            else if (e.key.toLowerCase() === 's') { e.preventDefault(); void (e.shiftKey ? saveToBoard() : save()); }
            else if (e.key === 'k' || e.key === 'p') { e.preventDefault(); setPaletteOpen(true); }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [run, saveToBoard, save]);

    const dirty = !!buffer && ws.isDirty(buffer);
    const percent = Math.min(100, (build.bytes / BUDGET) * 100);
    const screenRows = simScreen === 'ssd1306_32' ? 32 : 64;
    const usesScreen = simScreen !== 'none' && (!!sim?.framebuffer || /^\s*use\s+(oled|ssd1306|sh1106|ssd1306_32)\b/m.test(source));
    const simMs = Number(/(\d+) ms simulated/.exec(sim?.summary ?? '')?.[1] ?? 0);
    const saveState = !active ? '' : isExample ? 'Example — make a copy to keep changes' : dirty ? 'Unsaved changes' : 'Saved';

    // Divider between code and output, like Sprig's: drag to resize, remembered.
    useEffect(() => {
        try { const w = Number(localStorage.getItem('zapp.outputWidth')); if (w) setOutputWidth(w); } catch { /* storage unavailable */ }
    }, []);
    const startResize = (e: React.MouseEvent) => {
        e.preventDefault();
        const startX = e.clientX, startW = outputWidth;
        const onMove = (m: MouseEvent) => {
            const w = Math.max(400, Math.min(window.innerWidth - 420, startW + startX - m.clientX));
            setOutputWidth(w);
            try { localStorage.setItem('zapp.outputWidth', String(w)); } catch { /* storage unavailable */ }
        };
        const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    };
    const closeMenus = () => setMenu(null);
    const keep = (e: React.MouseEvent) => e.stopPropagation();

    return (
        <div className="app" onMouseDown={closeMenus}>
            {/* ─── Navbar (Sprig-style) ─── */}
            <nav className="navbar">
                <div className="nav-left">
                    <div className="logo">
                        <span className="logo-mark"><IconBolt size={16} /></span>
                        <span className="logo-text">zapp</span>
                    </div>
                    <div className="filename">
                        {active ? (
                            <button className="filename-text" onClick={() => !isExample && active && rename(active)}
                                    title={isExample ? undefined : 'Rename'}>
                                {pretty(active)}
                            </button>
                        ) : <span className="filename-text dim">No program open</span>}
                        <span className={`save-state ${dirty && !isExample ? 'warn' : ''}`}>{saveState}</span>
                    </div>
                </div>

                <div className="nav-right">
                    {isExample && <button className="nav-btn" onClick={copyExample}>Make my own copy</button>}
                    {dirty && !isExample && <button className="nav-btn" onClick={save}>Save</button>}

                    <div className="menu-anchor" onMouseDown={keep}>
                        <button className={`board-pill ${connected ? 'on' : ''}`}
                                onClick={() => (connected ? setMenu(menu === 'board' ? null : 'board') : connect())}>
                            <span className="led" />{connected ? (board?.title ?? 'Board') : 'Connect board'}
                        </button>
                        {menu === 'board' && (
                            <div className="popup">
                                <button onClick={() => { void serialRef.current?.stop(); closeMenus(); }}>Stop the program</button>
                                <button onClick={() => { void serialRef.current?.reload(); closeMenus(); }}>Restart saved program</button>
                                <button onClick={() => { void saveToBoard(); closeMenus(); }}>Save to board (runs at power-up)</button>
                                <hr />
                                <button onClick={() => { void disconnect(); closeMenus(); }}>Disconnect</button>
                            </div>
                        )}
                    </div>

                    <div className="run-group menu-anchor" onMouseDown={keep}>
                        <button className="run-btn" onClick={run} disabled={busy || !active}
                                title={connected ? 'Run on the board (⌘⏎)' : 'Run in the simulator (⌘⏎)'}>
                            <IconPlay size={14} />{connected ? 'Run on board' : 'Run'}
                        </button>
                        <button className="run-caret" onClick={() => setMenu(menu === 'run' ? null : 'run')} aria-label="More ways to run">
                            <IconChevron size={14} />
                        </button>
                        {menu === 'run' && (
                            <div className="popup">
                                <button onClick={() => { void simulate(); closeMenus(); }}>Run in the simulator</button>
                                <button disabled={!connected} onClick={() => { void run(); closeMenus(); }}>Run on the board</button>
                                <button disabled={!connected} onClick={() => { void saveToBoard(); closeMenus(); }}>Save to the board</button>
                                <hr />
                                <button onClick={() => { setPaletteOpen(true); closeMenus(); }}>All commands <kbd>⌘K</kbd></button>
                            </div>
                        )}
                    </div>
                </div>
            </nav>

            <div className="body">
                {/* ─── Ribbon + tool window (JetBrains-style) ─── */}
                <aside className="ribbon">
                    {([['programs', 'Programs', IconFiles], ['parts', 'Parts', IconChip], ['guide', 'Guide', IconHelp]] as const).map(([id, label, Icon]) => (
                        <button key={id} className={tool === id ? 'active' : ''} title={label}
                                onClick={() => setTool(tool === id ? null : id)}>
                            <Icon size={18} />
                        </button>
                    ))}
                    <span className="grow" />
                    <button title="All commands (⌘K)" onClick={() => setPaletteOpen(true)}><IconSearch size={18} /></button>
                    <button title="Install Zapp on a board" onClick={() => setInstallOpen(true)}><IconDownload size={18} /></button>
                </aside>
                {tool && (
                    <aside className="tool-panel">
                        <header className="tool-head">
                            <h3>{tool === 'programs' ? 'Programs' : tool === 'parts' ? 'Parts' : 'Guide'}</h3>
                            <button className="icon-btn" onClick={() => setTool(null)} aria-label="Hide"><IconClose size={13} /></button>
                        </header>
                        <div className="tool-body">
                            {tool === 'programs' ? (
                                <Programs tree={tree} activePath={active}
                                          dirty={(p) => !!buffers[p] && ws.isDirty(buffers[p]!)}
                                          onOpen={(p) => void openPath(p)}
                                          onCreate={() => void createFile()}
                                          onRename={rename} onDelete={removeFile} />
                            ) : tool === 'parts' ? <Parts modules={modules} onInsert={insert} /> : <Guide onInsert={insert} />}
                        </div>
                    </aside>
                )}

            <div className="workspace">
            <div className="main">
                {/* ─── Code ─── */}
                <section className="code-pane">
                    <div className="code-box">
                        {active ? (
                            <Editor
                                height="100%"
                                path={active}
                                language={active.endsWith('.zappmod') ? 'ini' : 'zapp'}
                                theme="zapp-dark"
                                value={source}
                                onChange={(v) => active && setContent(active, v ?? '')}
                                beforeMount={registerZappLanguage}
                                onMount={(editor, monaco) => {
                                    editorRef.current = editor;
                                    monacoRef.current = monaco;
                                    editor.focus();
                                }}
                                options={{
                                    fontSize: 15,
                                    fontFamily: '"Fira Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
                                    lineHeight: 24,
                                    minimap: { enabled: false },
                                    tabSize: 4,
                                    insertSpaces: true,
                                    scrollBeyondLastLine: false,
                                    automaticLayout: true,
                                    padding: { top: 18, bottom: 18 },
                                    renderLineHighlight: 'line',
                                    guides: { indentation: true },
                                    lineNumbersMinChars: 3,
                                    overviewRulerLanes: 0,
                                    hideCursorInOverviewRuler: true,
                                    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
                                    // Only our context-aware suggestions — never "every word in the file".
                                    wordBasedSuggestions: 'off',
                                    suggest: { showWords: false, preview: true },
                                    quickSuggestions: { other: true, comments: false, strings: false },
                                    fixedOverflowWidgets: true,
                                }}
                            />
                        ) : (
                            <div className="empty">
                                <h2>Start a program</h2>
                                <p>Pick a program or example on the left, or start fresh.</p>
                                <button className="nav-btn accent" onClick={createFile}>New program</button>
                            </div>
                        )}
                    </div>

                    {build.error && !errorsHidden ? (
                        <div className="errors">
                            <button className="error-close" onClick={() => setErrorsHidden(true)} aria-label="Hide"><IconClose size={14} /></button>
                            <button className="error-line" onClick={() => problemLine && goToLine(problemLine)}>
                                <IconWarn size={15} />
                                {problemLine && <b>Line {problemLine}:</b>}
                                <span>{cleanError(build.error)}</span>
                            </button>
                        </div>
                    ) : active && (
                        <div className="code-stats">
                            {build.error
                                ? <button className="link-btn" onClick={() => setErrorsHidden(false)}><IconWarn size={13} /> 1 problem</button>
                                : <span className="ok"><IconCheck size={13} /> No problems</span>}
                            <span className="grow" />
                            <span className="meter" title={`${build.bytes} of ${BUDGET} bytes`}><span style={{ width: `${percent}%` }} /></span>
                            <span>{percent < 1 ? '<1' : Math.round(percent)}% of board memory</span>
                        </div>
                    )}
                </section>

                <div className="resize-bar" onMouseDown={startResize} />

                {/* ─── Simulator ─── */}
                <section className="output-area" style={{ width: outputWidth }}>
                    <div className="sim">
                        <div className="sim-toolbar">
                            <button className="sim-play" onClick={simulate} disabled={busy || !active} title="Start the simulation">
                                {busy ? <span className="spinner sm" /> : <IconPlay size={16} />}
                            </button>
                            <button className="sim-stop" onClick={() => { setSim(null); setPressed(new Set()); }} disabled={!sim} title="Reset the simulation">
                                <IconStop size={14} />
                            </button>
                            <span className="sim-time">{(simMs / 1000).toFixed(3).padStart(6, '0')}s</span>
                            <span className="grow" />
                            <select className="mini-select" value={boardName} onChange={(e) => chooseBoard(e.target.value)} aria-label="Board">
                                {boards.map((b) => <option key={b.name} value={b.name}>{b.title}</option>)}
                            </select>
                            <select className="mini-select" value={simScreen} onChange={(e) => setSimScreen(e.target.value as SimScreen)} aria-label="Screen">
                                {(Object.keys(SCREEN_LABELS) as SimScreen[]).map((k) => <option key={k} value={k}>{SCREEN_LABELS[k]}</option>)}
                            </select>
                        </div>
                        <div className="stage">
                            {usesScreen && sim?.framebuffer && <Screen framebuffer={sim.framebuffer} rows={screenRows} />}
                            <Lights board={board} result={sim} pressed={pressed} onPress={togglePress} />
                            <PinsUsed board={board} result={sim} />
                            {!sim && <p className="stage-hint">Press ▶ to simulate — or <b>{connected ? 'Run on board' : 'Connect board'}</b> for the real thing.</p>}
                        </div>
                    </div>

                </section>
            </div>
                {/* ─── Console along the bottom ─── */}
                <Output lines={output} connected={connected} onSend={sendCommand} />
            </div>
            </div>

            {toast && <div className="toast">{toast}</div>}
            {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
            {installOpen && (
                <InstallDialog boards={boards} board={board} onBoard={(name) => { setBoardName(name); installedBoard.current = name; }}
                               canAutoBoot={connected}
                               onAutoBoot={async () => {
                                   await serialRef.current?.bootloader();
                                   await disconnect();
                               }}
                               onClose={() => setInstallOpen(false)} />
            )}
        </div>
    );
}
