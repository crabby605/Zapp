'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { TRANSFORM_IDS } from '../../compiler/src/opcodes';
import { compileSourceToPayload, compileWithWarnings, identityBoard, parseModuleFile, type BoardDefinition, type Warning } from '../../compiler/src/index';
import type { ModuleDefinition } from '../../compiler/src/emitter';
import { formatZapp, registerZappLanguage, setLanguageContext } from '../lib/zappLanguage';
import { ZappSerial } from '../lib/serial';
import { parseTrace, type RunResult } from '../lib/trace';
import * as ws from '../lib/workspace';
import { CommandPalette, type Command } from './CommandPalette';
import { InstallDialog } from './InstallDialog';
import { Lights, Output, PinsUsed, Screen, describeRun, type OutputLine } from './Panel';
import { Examples, FileManager, ModuleManager } from './Sidebar';
import { useDialogs } from './Dialogs';
import { ContextMenu, type MenuItem, type MenuState } from './ContextMenu';
import { GuideDoc } from './GuideDoc';
import { Tour, tourSeen, type TourStep } from './Tour';
import { FileIcon, IconBolt, IconBook, IconCheck, IconChevron, IconChip, IconClose, IconDownload, IconError, IconFiles, IconHelp, IconPackage, IconPlay, IconSearch, IconSim, IconSplit, IconStop, IconWarn } from './icons';

const Editor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

type SimScreen = 'ssd1306' | 'ssd1306_32' | 'sh1106' | 'none';
const SCREEN_LABELS: Record<SimScreen, string> = {
    ssd1306: '0.96″ OLED', ssd1306_32: '0.91″ OLED', sh1106: '1.3″ OLED', none: 'No screen',
};
const BUDGET = 2048;

type Side = 'left' | 'right';
// The language guide opens as a tab, like a file.
const GUIDE = 'doc:guide';
const isDoc = (path: string) => path.startsWith('doc:');

// Problems in a module file, phrased for someone writing their first one.
function checkModule(text: string): string | null {
    try {
        const mod = parseModuleFile(text);
        for (const [field, def] of Object.entries(mod.fields)) {
            if (def.transform && !(def.transform in TRANSFORM_IDS)) {
                const line = text.split('\n').findIndex((l) => new RegExp(`transform\\s*=\\s*"${def.transform}"`).test(l)) + 1;
                return `“${def.transform}” for ${field} isn't a transform Zapp knows — use format = "u16_be" and friends instead${line ? ` at line ${line}` : ''}`;
            }
        }
        return null;
    } catch (e) {
        return e instanceof Error ? e.message : 'This module file has a problem';
    }
}

const EDITOR_OPTIONS = {
    fontSize: 14,
    fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
    fontLigatures: true,
    lineHeight: 22,
    minimap: { enabled: false },
    tabSize: 4,
    insertSpaces: true,
    scrollBeyondLastLine: false,
    automaticLayout: true,
    padding: { top: 14, bottom: 14 },
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
} as const;

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
    // Two editor panes, side by side when split. `active` is the file in the pane
    // you're working in; Run, problems and the status bar follow it.
    const [panes, setPanes] = useState<{ left: string | null; right: string | null }>({ left: null, right: null });
    const [focus, setFocus] = useState<Side>('left');
    const active = panes[focus];
    const setActive = useCallback((path: string | null) => setPanes((prev) => ({ ...prev, [focus]: path })), [focus]);
    const split = panes.right !== null;

    // The module library, and the part of it this workspace installed (see /api/modules).
    const [library, setLibrary] = useState<Record<string, ModuleDefinition>>({});
    const [installed, setInstalled] = useState<Record<string, ModuleDefinition>>({});
    const [moduleBusy, setModuleBusy] = useState<string | null>(null);
    const [open, setOpen] = useState<string[]>([]);   // editor tabs, in order
    const openRef = useRef<string[]>([]);
    openRef.current = open;
    const [boards, setBoards] = useState<BoardDefinition[]>([]);
    const [boardName, setBoardName] = useState('pico');
    const installedBoard = useRef<string | null>(null);   // picked in the install dialog, told to the board on connect

    // warnings: things that compile but behave differently on this board (compiler/src/quirks.ts)
    const [build, setBuild] = useState<{ bytes: number; error: string | null; warnings: Warning[] }>({ bytes: 0, error: null, warnings: [] });
    const [sim, setSim] = useState<RunResult | null>(null);
    const [busy, setBusy] = useState(false);
    const [simScreen, setSimScreen] = useState<SimScreen>('ssd1306');
    const [pressed, setPressed] = useState<Set<string>>(new Set());

    const [output, setOutput] = useState<OutputLine[]>([]);
    const [connected, setConnected] = useState(false);

    // The tool window opened from the left ribbon, like JetBrains' Project / Structure panes.
    const [tool, setTool] = useState<null | 'programs' | 'examples' | 'modules'>('programs');
    const [simOpen, setSimOpen] = useState(false);   // the simulator pane shows once asked for
    const [tourOpen, setTourOpen] = useState(false);
    const [menu, setMenu] = useState<null | 'run' | 'board'>(null);
    const [outputWidth, setOutputWidth] = useState(520);
    const [problemsOpen, setProblemsOpen] = useState(false);
    const [ctx, setCtx] = useState<MenuState | null>(null);
    const [recent, setRecent] = useState<string[]>([]);   // most recently viewed first
    const [maximized, setMaximized] = useState(false);   // double-click a tab: editor only
    const [cursor, setCursor] = useState({ line: 1, column: 1 });
    const [installOpen, setInstallOpen] = useState(false);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const [toast, setToast] = useState<string | null>(null);

    const dialogs = useDialogs();
    const serialRef = useRef<ZappSerial | null>(null);
    const editors = useRef<Record<Side, any>>({ left: null, right: null });
    const editorRef = useRef<any>(null);   // the focused pane's editor
    useEffect(() => { editorRef.current = editors.current[focus]; }, [focus, panes]);
    const monacoRef = useRef<any>(null);

    const buffer = active ? buffers[active] : undefined;
    const source = buffer?.content ?? '';
    const board = boards.find((b) => b.name === boardName);
    const isExample = !!buffer && !buffer.writable;
    // Examples compile against the whole library so they always open cleanly.
    const modules = isExample ? library : installed;

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
        try { setTree(await ws.listFiles()); } catch { notify("Couldn't load your files"); }
    }, []);

    const loadModules = useCallback(async () => {
        const parse = (files: Record<string, string>) => {
            const out: Record<string, ModuleDefinition> = {};
            for (const [name, text] of Object.entries(files ?? {})) {
                try { out[name] = parseModuleFile(text); } catch { /* skip a broken module */ }
            }
            return out;
        };
        try {
            const data = await fetch('/api/modules').then((r) => r.json());
            setLibrary(parse(data.library));
            setInstalled(parse(data.installed));
        } catch { /* offline: keep what we have */ }
    }, []);

    const openPath = useCallback(async (path: string) => {
        setActive(path);
        setOpen((prev) => (prev.includes(path) ? prev : [...prev, path]));
        if (buffers[path] || isDoc(path)) return;
        try {
            const file = await ws.readFile(path);
            setBuffers((prev) => ({ ...prev, [path]: ws.bufferFor(path, file) }));
        } catch (e) {
            notify(e instanceof Error ? e.message : 'Could not open that file');
        }
    }, [buffers]);

    useEffect(() => {
        void refreshTree();
        void loadModules();
        fetch('/api/board').then((r) => r.json()).then((data) => setBoards(data.boards ?? [])).catch(() => undefined);

        const session = ws.loadSession();
        try {
            const saved = localStorage.getItem('zapp.board');
            if (saved) setBoardName(saved);
        } catch { /* storage unavailable */ }
        // Reopen every tab from last time; files that have gone are dropped.
        const paths = session.open.length ? session.open : ['workspace/main.zap'];
        Promise.all(paths.map((p) => (isDoc(p) ? Promise.resolve({ path: p, content: '', writable: false })
                                                 : ws.readFile(p).then((f) => ({ ...f, path: p }), () => null)))).then((files) => {
            const ok = files.filter((f): f is NonNullable<typeof f> => !!f);
            setBuffers(Object.fromEntries(ok.filter((f) => !isDoc(f.path)).map((f) => [f.path, ws.bufferFor(f.path, f)])));
            setOpen(ok.map((f) => f.path));
            const want = session.active && ok.some((f) => f.path === session.active) ? session.active : ok[0]?.path ?? null;
            setPanes({ left: want, right: null });
        });
        if (!tourSeen()) setTourOpen(true);
    }, [refreshTree, loadModules]);

    useEffect(() => { ws.saveSession({ open, active: panes.left }); }, [open, panes.left]);
    // Boards are plugged in and out: look for the drive while My programs is showing.
    useEffect(() => {
        if (tool !== 'programs') return;
        const id = setInterval(() => void refreshTree(), 3000);
        return () => clearInterval(id);
    }, [tool, refreshTree]);
    useEffect(() => { if (active) setRecent((prev) => [active, ...prev.filter((p) => p !== active)].slice(0, 12)); }, [active]);

    // Unsaved edits survive a refresh as drafts — no "leave site?" browser dialog.
    useEffect(() => {
        const id = setTimeout(() => ws.saveDrafts(buffers), 400);
        return () => clearTimeout(id);
    }, [buffers]);

    // Autosave a moment after typing stops. ⌘S saves at once and tidies the
    // formatting too; autosave leaves formatting alone so nothing jumps while typing.
    useEffect(() => {
        const pending = Object.values(buffers).filter((b) => b.writable && ws.isDirty(b));
        if (!pending.length) return;
        const id = setTimeout(async () => {
            for (const b of pending) {
                try {
                    await ws.writeFile(b.path, b.content);
                    setBuffers((prev) => (prev[b.path] ? { ...prev, [b.path]: { ...prev[b.path]!, saved: b.content } } : prev));
                    if (b.path.endsWith('.zappmod')) void loadModules();   // edited modules compile straight away
                } catch {
                    notify(`Couldn't save ${ws.fileName(b.path)} — your changes are kept until it can`);
                }
            }
        }, 900);
        return () => clearTimeout(id);
    }, [buffers]);
    useEffect(() => {
        try { localStorage.setItem('zapp.board', boardName); } catch { /* storage unavailable */ }
    }, [boardName]);
    useEffect(() => { setLanguageContext({ modules, pins: board?.pins ?? {} }); }, [modules, board]);

    // Build as you type
    const compile = useCallback(() => compileSourceToPayload(source, modules, board), [source, modules, board]);

    useEffect(() => {
        const id = setTimeout(() => {
            if (active?.endsWith('.zappmod')) return setBuild({ bytes: 0, error: checkModule(source), warnings: [] });
            if (!active?.endsWith('.zap')) return setBuild({ bytes: 0, error: null, warnings: [] });
            try {
                const { payload, warnings } = compileWithWarnings(source, modules, board);
                setBuild({ bytes: (payload.length - 3) / 2, error: null, warnings });
            } catch (e) {
                setBuild({ bytes: 0, error: e instanceof Error ? e.message : 'compile failed', warnings: [] });
            }
        }, 220);
        return () => clearTimeout(id);
    }, [source, modules, board, active]);

    const problemLine = build.error ? errorLine(build.error) : null;
    // `use bmp280` before installing it: the error strip offers the install.
    const missingName = build.error ? /Module '(\w+)' not found/.exec(build.error)?.[1] : undefined;
    const missingModule = missingName && library[missingName] && !installed[missingName] ? missingName : null;

    // Errors and board notes, shown at the end of their line (and underlined),
    // counted in the corner of the editor.
    const problems = useMemo(() => build.error
        ? [{ severity: 'error' as const, line: problemLine ?? 1,
             message: missingModule ? `${missingModule} isn't installed yet` : cleanError(build.error) }]
        : build.warnings.map((w) => ({ severity: 'warning' as const, line: w.line, message: w.message })),
    [build.error, build.warnings, problemLine, missingModule]);

    const errorCount = problems.filter((p) => p.severity === 'error').length;
    const warnCount = problems.length - errorCount;

    const inlineRef = useRef<any>(null);
    useEffect(() => {
        const monaco = monacoRef.current;
        const editor = editorRef.current;
        const model = editor?.getModel();
        if (!monaco || !model) return;
        const lineOf = (line: number) => Math.max(1, Math.min(line, model.getLineCount()));
        monaco.editor.setModelMarkers(model, 'zapp', problems.map((p) => {
            const at = lineOf(p.line);
            return { severity: p.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
                     message: p.message, startLineNumber: at, endLineNumber: at, startColumn: 1, endColumn: model.getLineMaxColumn(at) };
        }));
        inlineRef.current?.clear();
        inlineRef.current = editor.createDecorationsCollection(problems.map((p) => {
            const at = lineOf(p.line);
            const end = model.getLineMaxColumn(at);
            return { range: new monaco.Range(at, end, at, end),
                     options: { after: { content: `    ${p.message}`, inlineClassName: `inline-${p.severity}` } } };
        }));
    }, [problems, active]);

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
            if (buffer.path.endsWith('.zappmod')) void loadModules();
        } catch (e) {
            notify(e instanceof Error ? e.message : 'Save failed');
        }
    }, [buffer, refreshTree]);

    // Paths moved or renamed on disk: carry open tabs and buffers along.
    // A folder rename moves everything under it.
    const remap = (from: string, to: string) => {
        const map = (p: string) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : p);
        setBuffers((prev) => Object.fromEntries(Object.entries(prev).map(([p, b]) => [map(p), { ...b, path: map(p) }])));
        setOpen((prev) => prev.map(map));
        setPanes((prev) => ({ left: prev.left && map(prev.left), right: prev.right && map(prev.right) }));
    };
    const forget = (gone: string) => {
        const under = (p: string) => p === gone || p.startsWith(gone + '/');
        setBuffers((prev) => Object.fromEntries(Object.entries(prev).filter(([p]) => !under(p))));
        const rest = open.filter((p) => !under(p));
        setOpen(rest);
        setPanes((prev) => ({
            left: prev.left && under(prev.left) ? rest[rest.length - 1] ?? null : prev.left,
            right: prev.right && under(prev.right) ? null : prev.right,
        }));
    };

    const createEntry = async (dir: string, name: string, kind: 'file' | 'folder') => {
        try {
            const becomesZap = name.endsWith('.zap') || (!name.includes('.') && dir !== 'drive/web');
            const starter = becomesZap ? '# my program\n\n' : '';
            const { path } = kind === 'folder' ? await ws.createFolder(dir, name) : await ws.createFile(dir, name, starter);
            await refreshTree();
            if (path && kind === 'file') void openPath(path);
            return true;
        } catch (e) {
            notify(e instanceof Error ? e.message : 'Could not create that');
            return false;
        }
    };

    // "New program" from the palette or the empty editor: a fresh untitled
    // program at the top level, ready to rename.
    const createFile = () => createEntry('workspace', 'untitled.zap', 'file');

    const copyExample = async (from = buffer?.path) => {
        if (!from) return;
        const { path } = await ws.copyToWorkspace(from);
        await refreshTree();
        if (!path) return;
        // Carry over any edits made to the example before copying.
        const content = buffers[from]?.content ?? (await ws.readFile(path)).content;
        await ws.writeFile(path, content);
        setBuffers((prev) => ({ ...prev, [path]: { path, content, saved: content, writable: true } }));
        setOpen((prev) => [...prev.filter((p) => p !== from), path]);
        setActive(path);
        notify(`Copied to My programs as ${ws.fileName(path)}`);
    };

    const closeTab = async (path: string) => {
        const b = buffers[path];
        if (b?.writable && ws.isDirty(b) && !(await dialogs.confirm({
            title: `Close “${ws.fileName(path)}”?`, body: 'It has changes you haven’t saved. Closing throws them away.',
            confirmLabel: 'Close without saving', danger: true,
        }))) return;
        const current = openRef.current;   // fresh, so closing several in a row works
        const index = current.indexOf(path);
        const rest = current.filter((p) => p !== path);
        openRef.current = rest;
        setOpen(rest);
        setBuffers((prev) => { const next = { ...prev }; delete next[path]; return next; });
        const next = rest[Math.min(index, rest.length - 1)] ?? null;
        setPanes((prev) => {
            const right = prev.right === path ? null : prev.right;     // closing the side file closes the split
            const left = prev.left === path ? (next === right ? rest.find((p) => p !== right) ?? null : next) : prev.left;
            return { left: left ?? right, right: left ? right : null };
        });
        if (panes.right === path) setFocus('left');
    };

    const closeTabs = (paths: string[]) => paths.reduce((chain, p) => chain.then(() => closeTab(p)), Promise.resolve());

    // Show a tab in the other pane, splitting the editor if it isn't already.
    const openToSide = (path: string) => {
        const side: Side = focus === 'left' ? 'right' : 'left';
        setPanes((prev) => ({ ...prev, [side]: path }));
        setFocus(side);
    };
    const unsplit = () => { setPanes((prev) => ({ left: prev[focus] ?? prev.left, right: null })); setFocus('left'); };

    // The guide opens like any file, full width. Drag its tab to the side to read and code at once.
    const openGuide = () => {
        setOpen((prev) => (prev.includes(GUIDE) ? prev : [...prev, GUIDE]));
        if (panes.left === GUIDE) return setFocus('left');
        if (panes.right === GUIDE) return setFocus('right');
        setActive(GUIDE);
    };

    // Drag a tab onto the editor: the right half splits, the left half takes the left pane.
    const [dropSide, setDropSide] = useState<Side | null>(null);
    const dragSide = (e: React.DragEvent): Side => {
        const box = e.currentTarget.getBoundingClientRect();
        return e.clientX > box.left + box.width / 2 ? 'right' : 'left';
    };
    const dropTab = (e: React.DragEvent) => {
        const path = e.dataTransfer.getData('text/x-zapp-tab');
        setDropSide(null);
        if (!path) return;
        e.preventDefault();
        const side = dragSide(e);
        setPanes((prev) => {
            const next = { ...prev, [side]: path };
            if (side === 'right' && next.left === path) next.left = open.find((p) => p !== path) ?? null;   // don't show one file twice
            if (!next.left) return { left: path, right: null };
            return next;
        });
        setFocus(side);
    };

    // Add `use <name>` under the program's existing `use` lines (or its opening
    // comments), as an editor edit so ⌘Z takes it back.
    const addUse = (name: string) => {
        if (!buffer?.writable) return false;
        if (new RegExp(`^\\s*use\\s+${name}\\b`, 'm').test(buffer.content)) return false;
        const lines = buffer.content.split('\n');
        let at = 0;
        for (let i = 0; i < lines.length; i++) {
            const t = lines[i]!.trim();
            if (/^use\s/.test(t)) at = i + 1;
            else if (at === 0 && (t.startsWith('#') || t === '')) continue;
            else if (at > 0 || t) break;
        }
        if (at === 0) at = lines.findIndex((l) => l.trim() && !l.trim().startsWith('#'));
        if (at < 0) at = lines.length;
        const editor = editorRef.current;
        if (editor && at < lines.length) {
            editor.executeEdits('modules', [{ range: { startLineNumber: at + 1, startColumn: 1, endLineNumber: at + 1, endColumn: 1 }, text: `use ${name}\n` }]);
        } else {
            lines.splice(at, 0, `use ${name}`);
            setContent(buffer.path, lines.join('\n'));
        }
        return true;
    };

    const installModule = async (name: string) => {
        setModuleBusy(name);
        try {
            const res = await fetch('/api/modules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'install', name }) });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            await loadModules();
            notify(addUse(name) ? `Installed ${name} and added “use ${name}” to your program` : `Installed ${name}`);
        } catch (e) {
            notify(e instanceof Error ? e.message : 'Install failed');
        } finally {
            setModuleBusy(null);
        }
    };

    const removeModule = async (name: string) => {
        if (!library[name] && !(await dialogs.confirm({
            title: `Delete ${name}?`, body: "You made this module, so there's no copy in the library. Removing it deletes it.",
            confirmLabel: 'Delete', danger: true,
        }))) return;
        setModuleBusy(name);
        try {
            await fetch('/api/modules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'remove', name }) });
            await loadModules();
            notify(`Removed ${name}`);
        } finally {
            setModuleBusy(null);
        }
    };

    // Open a module's file to learn from it: your installed copy (editable),
    // or the library's (read-only) when it isn't installed.
    const viewModule = (name: string) => void openPath(installed[name] ? `workspace/modules/${name}.zappmod` : `library/${name}.zappmod`);

    const newModule = async () => {
        const raw = await dialogs.prompt({
            title: 'New module', body: 'Name it after the part, like bh1750 or my_sensor. Programs will write “use” and this name.',
            input: { initial: '', placeholder: 'my_sensor' }, confirmLabel: 'Create',
        });
        if (!raw) return;
        const name = raw.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
        if (!name) return notify('Use letters, numbers or _ in the name');
        try {
            const res = await fetch('/api/modules', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'create', name }) });
            const data = await res.json();
            if (data.error) throw new Error(data.error);
            await loadModules();
            void openPath(data.path);
        } catch (e) {
            notify(e instanceof Error ? e.message : "Couldn't create the module");
        }
    };

    const removeEntry = async (entry: ws.FileEntry) => {
        const isDir = entry.kind === 'dir';
        const count = isDir ? ws.allFiles(entry.children ?? []).length : 0;
        const ok = await dialogs.confirm({
            title: `Delete “${entry.name}”?`,
            body: isDir ? `The folder${count ? ` and the ${count} file${count > 1 ? 's' : ''} in it` : ''} will be deleted. This can't be undone.`
                        : "This can't be undone.",
            confirmLabel: 'Delete', danger: true,
        });
        if (!ok) return;
        try {
            await ws.deleteFile(entry.path);
            forget(entry.path);
        } catch (e) {
            notify(e instanceof Error ? e.message : 'Could not delete that');
        }
        await refreshTree();
    };

    const renameEntry = async (path: string, name: string) => {
        try {
            const result = await ws.renameFile(path, name);
            if (result.path && result.path !== path) remap(path, result.path);
            await refreshTree();
            return true;
        } catch (e) {
            notify(e instanceof Error ? e.message : 'Could not rename that');
            return false;
        }
    };

    // Between My programs and the board. Replacing the board's main.zap asks first.
    const copyEntry = async (path: string, toDir: string) => {
        if (toDir === 'drive' && !(await dialogs.confirm({
            title: 'Replace main.zap on the board?', body: `${ws.fileName(path)} becomes the board's main.zap.`,
            confirmLabel: 'Replace',
        }))) return;
        try {
            const result = await ws.copyEntry(path, toDir);
            if (result.path && buffers[result.path]) {
                const file = await ws.readFile(result.path);   // an open copy shows the new contents
                setBuffers((prev) => ({ ...prev, [result.path!]: ws.bufferFor(result.path!, file) }));
            }
            notify(`Copied ${ws.fileName(path)} to ${toDir.startsWith('drive') ? 'the board' : 'My programs'}`);
        } catch (e) {
            notify(e instanceof Error ? e.message : "Couldn't copy that");
        }
        await refreshTree();
    };

    const moveEntry = async (path: string, toDir: string) => {
        try {
            const result = await ws.moveEntry(path, toDir);
            if (result.path && result.path !== path) remap(path, result.path);
        } catch (e) {
            notify(e instanceof Error ? e.message : 'Could not move that');
        }
        await refreshTree();
    };

    // The file name in the navbar: rename in a dialog.
    const rename = async (path: string) => {
        const name = await dialogs.prompt({ title: 'Rename', input: { initial: ws.fileName(path) }, confirmLabel: 'Rename' });
        if (name) await renameEntry(path, name);
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
                : { text: 'Connected. Which board is this? Choose it next to Run — the board will remember.', kind: 'note' });
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
        if (!active?.endsWith('.zap')) return notify('Open a .zap program to run it');
        if (build.error) return notify('Fix the problem in your code first');
        setSimOpen(true);
        setMaximized(false);
        setBusy(true);
        try {
            // Buttons idle at their released level; held ones at the pressed level.
            const gpio = Object.entries(board?.indicators ?? {})
                .filter(([, ind]) => ind.kind === 'button')
                .map(([name, ind]) => `${board!.pins[name]}=${pressed.has(name) === ind.activeLow ? 0 : 1}`);
            const res = await fetch('/api/emulate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ payload: compile(), gpio, noRadio: !board?.radio, display: simScreen }),
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
        if (!active?.endsWith('.zap')) return notify('Open a .zap program to run it');
        if (build.error) return notify('Fix the problem in your code first');
        try {
            await serialRef.current.sendLine(compile().replace(/^BC:/, 'RUN:'));
            log({ text: `▶ Running ${active ? ws.fileName(active) : 'program'} on the board`, kind: 'note' });
        } catch (e) {
            notify(e instanceof Error ? e.message : 'Could not send to the board');
        }
    }, [simulate, build.error, compile, active, log]);

    const saveToBoard = useCallback(async () => {
        if (!serialRef.current) return notify('Connect a board first');
        if (!active?.endsWith('.zap')) return notify('Open a .zap program to save it to the board');
        if (build.error) return notify('Fix the problem in your code first');
        try {
            await serialRef.current.sendLine(compile());
            log({ text: `✓ Saved ${active ? ws.fileName(active) : 'program'} to the board. It runs every time the board starts.`, kind: 'note' });
        } catch (e) {
            notify(e instanceof Error ? e.message : 'Could not send to the board');
        }
    }, [build.error, compile, active, log]);

    const sendCommand = (line: string) => {
        log({ text: `› ${line}`, kind: 'in' });
        void serialRef.current?.sendLine(line);
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
    const allPaths = new Set([...ws.allFiles(tree?.workspace ?? []), ...(tree?.examples ?? [])].map((f) => f.path));
    const commands: Command[] = useMemo(() => [
        ...recent.filter((p) => p !== active && (isDoc(p) || allPaths.has(p))).map((p) => ({
            id: `recent:${p}`, group: 'Recent', title: isDoc(p) ? 'Guide' : p.replace(/^(workspace|examples)\//, ''),
            run: () => (isDoc(p) ? openGuide() : void openPath(p)),
        })),
        { id: 'run', group: 'Run', title: connected ? 'Run on the board' : 'Run in the simulator', keys: '⌘⏎', run: () => void run() },
        { id: 'sim', group: 'Run', title: 'Simulate', run: () => void simulate() },
        { id: 'saveboard', group: 'Run', title: 'Save to board (runs on power-up)', keys: '⇧⌘S', run: () => void saveToBoard() },
        { id: 'stop', group: 'Board', title: 'Stop the program on the board', run: () => void serialRef.current?.stop() },
        { id: 'restart', group: 'Board', title: 'Restart the saved program', run: () => void serialRef.current?.reload() },
        { id: 'connect', group: 'Board', title: connected ? 'Disconnect board' : 'Connect board', run: () => void (connected ? disconnect() : connect()) },
        { id: 'install', group: 'Board', title: 'Install Zapp on a board…', run: () => setInstallOpen(true) },
        { id: 'simpane', group: 'View', title: simOpen ? 'Hide the simulator' : 'Show the simulator', run: () => setSimOpen(!simOpen) },
        { id: 'modules', group: 'View', title: 'Module manager', run: () => setTool('modules') },
        { id: 'examples', group: 'View', title: 'Examples', run: () => setTool('examples') },
        { id: 'tour', group: 'Help', title: 'Take the tour', run: () => setTourOpen(true) },
        { id: 'guide', group: 'Help', title: 'Open the guide', run: openGuide },
        { id: 'split', group: 'View', title: split ? 'Unsplit the editor' : 'Split the editor', run: () => (split ? unsplit() : active && openToSide(active)) },
        { id: 'max', group: 'View', title: maximized ? 'Restore panels' : 'Maximize the editor', keys: '⇧⌘F12', run: () => setMaximized(!maximized) },
        { id: 'save', group: 'File', title: 'Save', keys: '⌘S', run: () => void save() },
        ...(active ? [{ id: 'close', group: 'File', title: 'Close this tab', keys: '⌥W', run: () => closeTab(active) }] : []),
        { id: 'new', group: 'File', title: 'New program', run: () => void createFile() },
        ...ws.allFiles(tree?.workspace ?? []).map((f) => ({
            id: `open:${f.path}`, group: 'My files', title: f.path.replace(/^workspace\//, ''), run: () => void openPath(f.path),
        })),
        ...(tree?.examples ?? []).map((f) => ({
            id: `ex:${f.path}`, group: 'Examples', title: pretty(f.path), run: () => void openPath(f.path),
        })),
    ], [run, simulate, saveToBoard, save, connected, connect, tree, openPath, simOpen, active, buffers, open, recent, split, maximized, panes]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const mod = e.metaKey || e.ctrlKey;
            if (e.key === 'Escape') setMenu(null);
            // ⌥W / ⌥[ ⌥] for tabs: the browser keeps ⌘W and ⌘[ for itself.
            if (e.altKey && !mod && active) {
                const i = open.indexOf(active);
                if (e.code === 'KeyW') { e.preventDefault(); closeTab(active); return; }
                if (e.code === 'BracketLeft' && i > 0) { e.preventDefault(); setActive(open[i - 1]!); return; }
                if (e.code === 'BracketRight' && i < open.length - 1) { e.preventDefault(); setActive(open[i + 1]!); return; }
            }
            if (mod && e.shiftKey && e.key === 'F12') { e.preventDefault(); setMaximized((m) => !m); return; }
            if (!mod) return;
            if (e.key === 'Enter') { e.preventDefault(); void run(); }
            else if (e.key.toLowerCase() === 's') { e.preventDefault(); void (e.shiftKey ? saveToBoard() : save()); }
            else if (e.key === 'k' || e.key === 'p') { e.preventDefault(); setPaletteOpen(true); }
        };
        // Double-Shift: Search Everywhere, like JetBrains.
        let lastShift = 0;
        const onKeyUp = (e: KeyboardEvent) => {
            if (e.key !== 'Shift') { lastShift = 0; return; }
            const now = performance.now();
            if (now - lastShift < 350) { setPaletteOpen(true); lastShift = 0; } else lastShift = now;
        };
        window.addEventListener('keydown', onKey);
        window.addEventListener('keyup', onKeyUp);
        return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keyup', onKeyUp); };
    }, [run, saveToBoard, save, active, open, buffers]);

    const dirty = !!buffer && ws.isDirty(buffer);
    const percent = Math.min(100, (build.bytes / BUDGET) * 100);
    const screenRows = simScreen === 'ssd1306_32' ? 32 : 64;
    const usesScreen = simScreen !== 'none' && (!!sim?.framebuffer || /^\s*use\s+(oled|ssd1306|sh1106|ssd1306_32)\b/m.test(source));
    const simMs = Number(/(\d+) ms simulated/.exec(sim?.summary ?? '')?.[1] ?? 0);
    const saveState = !active ? '' : isExample ? 'Read-only' : dirty ? 'Saving…' : 'Saved';

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

    const problemsWidget = (
        <div className="problems-widget" onMouseDown={keep}>
            <button className={`problems-count ${problems.length ? '' : 'clean'}`}
                    onClick={() => setProblemsOpen(!problemsOpen)}
                    aria-label={problems.length ? `${problems.length} problem${problems.length > 1 ? 's' : ''}` : 'No problems'}>
                {errorCount > 0 && <span className="count-error"><IconError size={13} />{errorCount}</span>}
                {warnCount > 0 && <span className="count-warn"><IconWarn size={13} />{warnCount}</span>}
                {!problems.length && <IconCheck size={14} />}
            </button>
            {problemsOpen && problems.length > 0 && (
                <div className="problems-pop" role="list">
                    {problems.map((p) => (
                        <div key={`${p.line}:${p.message}`} role="listitem" className={`problem ${p.severity}`}>
                            <button onClick={() => { goToLine(p.line); setProblemsOpen(false); }}>
                                {p.severity === 'error' ? <IconError size={13} /> : <IconWarn size={13} />}
                                <span>{p.message}</span>
                                <em>{p.line}</em>
                            </button>
                            {p.severity === 'error' && missingModule && (
                                <button className="nav-btn accent sm" disabled={moduleBusy === missingModule}
                                        onClick={() => void installModule(missingModule)}>Install {missingModule}</button>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );

    const tabTitle = (p: string) => (isDoc(p) ? 'Guide' : ws.fileName(p));

    const tabMenu = (p: string): MenuItem[] => {
        const i = open.indexOf(p);
        return [
            { label: split && (panes.left === p || panes.right === p) ? 'Open in other pane' : 'Split right', run: () => openToSide(p) },
            ...(split ? [{ label: 'Unsplit', run: unsplit }] : []),
            'sep',
            { label: 'Close', keys: '⌥W', run: () => void closeTab(p) },
            { label: 'Close others', disabled: open.length < 2, run: () => void closeTabs(open.filter((q) => q !== p)) },
            { label: 'Close tabs to the right', disabled: i === open.length - 1, run: () => void closeTabs(open.slice(i + 1)) },
            { label: 'Close all', run: () => void closeTabs([...open]) },
        ];
    };

    const insertInto = (side: Side, text: string) => {
        const editor = editors.current[side];
        const path = panes[side];
        if (!editor || !path || !buffers[path]?.writable) return notify('Open one of your programs to insert into');
        editor.trigger('ide', 'type', { text });
        editor.focus();
        setFocus(side);
    };

    const renderPane = (side: Side) => {
        const path = panes[side];
        const b = path ? buffers[path] : undefined;
        const other: Side = side === 'left' ? 'right' : 'left';
        return (
            <div className={`pane ${split && focus === side ? 'focused' : ''}`} onMouseDownCapture={() => setFocus(side)}>
                <div className="code-box">
                    {focus === side && (path?.endsWith('.zap') || path?.endsWith('.zappmod')) && problemsWidget}
                    {path && isDoc(path) ? (
                        <GuideDoc canInsert={!!panes[other] && !!buffers[panes[other]!]?.writable}
                                  onInsert={(text) => insertInto(other, text)} onTour={() => setTourOpen(true)}
                                  onNewModule={() => void newModule()} onViewModule={viewModule} />
                    ) : path && b ? (
                        <Editor
                            height="100%"
                            path={path}
                            language={ws.languageOf(path)}
                            theme="zapp-dark"
                            value={b.content}
                            onChange={(v) => setContent(path, v ?? '')}
                            beforeMount={registerZappLanguage}
                            onMount={(editor, monaco) => {
                                editors.current[side] = editor;
                                monacoRef.current = monaco;
                                if (focus === side) editorRef.current = editor;
                                editor.onDidFocusEditorText(() => setFocus(side));
                                editor.onDidChangeCursorPosition((e: any) => setCursor({ line: e.position.lineNumber, column: e.position.column }));
                                if (focus === side) editor.focus();
                            }}
                            options={{ ...EDITOR_OPTIONS, readOnly: !b.writable }}
                        />
                    ) : path ? (
                        <div className="empty"><span className="spinner sm" /></div>
                    ) : (
                        <div className="empty">
                            <h2>Nothing open</h2>
                            <p>Open a file from My programs, or start a new one.</p>
                            <button className="nav-btn accent" onClick={() => void createFile()}>New program</button>
                        </div>
                    )}
                </div>
            </div>
        );
    };

    const tourSteps: TourStep[] = useMemo(() => [
        { title: 'Welcome to Zapp', body: 'Write a program, try it in the simulator, then run it on a real board. This takes a minute — use the arrow keys or the buttons.' },
        { target: 'ribbon-programs', title: 'Your programs', body: 'Everything you write lives here. Open as many as you like; each one gets its own tab.', before: () => setTool('programs') },
        { target: 'ribbon-examples', title: 'Examples', body: 'Ready-made programs to learn from. They open read-only — press “Make my own copy” to change one.', before: () => setTool('examples') },
        { target: 'ribbon-modules', title: 'Module manager', body: 'Sensors and screens come as modules. Press Install and Zapp adds “use <module>” to your program for you.', before: () => setTool('modules') },
        { target: 'editor', title: 'The editor', body: 'Mistakes are underlined in red as you type. Yellow means it compiles, but this board does it differently — the note says why.' },
        { target: 'run', title: 'Run', body: 'With no board connected, Run starts the simulator. With one connected, it runs there. ⌘/Ctrl+Enter works too.' },
        { target: 'ribbon-sim', title: 'Simulator', body: 'The simulator stays out of your way until you run something or open it here.' },
        { target: 'board', title: 'Connect a board', body: 'Plug in a board with Zapp on it and connect over USB (Chrome or Edge). Its drive also shows main.zap, like CircuitPython.' },
        { target: 'ribbon-guide', title: 'Guide', body: 'Every command with an example, in its own tab. Drag the tab to the right half of the editor to read it beside your program, then Insert drops examples straight in.' },
        { target: 'ribbon-install', title: 'New board?', body: 'Install Zapp onto a board from here first. You can take this tour again from the Guide.' },
    ], []);

    return (
        <div className="app" onMouseDown={closeMenus}>
            {/* Navbar (Sprig-style) */}
            <nav className="navbar">
                <div className="nav-left">
                    <div className="logo">
                        <span className="logo-mark"><IconBolt size={16} /></span>
                        <span className="logo-text">zapp</span>
                    </div>
                </div>

                <div className="nav-right">
                    {isExample && active?.startsWith('library/') && (
                        <button className="nav-btn" onClick={async () => {
                            const name = ws.fileName(active).replace(/\.zappmod$/, '');
                            const from = active;
                            await installModule(name);
                            const path = `workspace/modules/${name}.zappmod`;
                            setOpen((prev) => prev.map((p) => (p === from ? path : p)));
                            void openPath(path);
                        }}>Install to edit</button>
                    )}
                    {isExample && !active?.startsWith('library/') && <button className="nav-btn" onClick={() => void copyExample()}>Make my own copy</button>}

                    <div className="menu-anchor" onMouseDown={keep} data-tour="board">
                        <button className={`board-pill ${connected ? 'on' : ''}`}
                                onClick={() => (connected ? setMenu(menu === 'board' ? null : 'board') : connect())}>
                            <span className="led" />{connected ? 'Connected' : 'Connect board'}
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

                    <div className="run-group menu-anchor" onMouseDown={keep} data-tour="run">
                        <label className="run-config">
                            <IconChip size={14} />
                            <select value={boardName} onChange={(e) => chooseBoard(e.target.value)} aria-label="Board">
                                {boards.map((b) => <option key={b.name} value={b.name}>{b.title}</option>)}
                            </select>
                            <IconChevron size={12} />
                        </label>
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
                {/* Ribbon + tool window (JetBrains-style) */}
                <aside className="ribbon">
                    {([['programs', 'My programs', IconFiles], ['examples', 'Examples', IconBook],
                       ['modules', 'Module manager', IconPackage]] as const).map(([id, label, Icon]) => (
                        <button key={id} className={tool === id && !maximized ? 'active' : ''} title={label} data-tour={`ribbon-${id}`}
                                onClick={() => { setMaximized(false); setTool(tool === id ? null : id); }}>
                            <Icon size={18} />
                        </button>
                    ))}
                    <button className={open.includes(GUIDE) && (panes.left === GUIDE || panes.right === GUIDE) ? 'active' : ''}
                            title="Guide" data-tour="ribbon-guide" onClick={openGuide}>
                        <IconHelp size={18} />
                    </button>
                    <hr className="ribbon-sep" />
                    <button className={simOpen ? 'active' : ''} title={simOpen ? 'Hide the simulator' : 'Simulator'}
                            data-tour="ribbon-sim" onClick={() => setSimOpen(!simOpen)}>
                        <IconSim size={18} />
                    </button>
                    <span className="grow" />
                    <button title="Search everywhere (⇧⇧ or ⌘K)" onClick={() => setPaletteOpen(true)}><IconSearch size={18} /></button>
                    <button title="Install Zapp on a board" data-tour="ribbon-install" onClick={() => setInstallOpen(true)}><IconDownload size={18} /></button>
                </aside>
                {tool && !maximized && (
                    <aside className="tool-panel">
                        <header className="tool-head">
                            <h3>{{ programs: 'My programs', examples: 'Examples', modules: 'Module manager' }[tool]}</h3>
                            <button className="icon-btn" onClick={() => setTool(null)} aria-label="Hide"><IconClose size={13} /></button>
                        </header>
                        <div className="tool-body">
                            {tool === 'programs' ? (
                                <FileManager tree={tree} activePath={active}
                                             dirty={(p) => !!buffers[p] && ws.isDirty(buffers[p]!)}
                                             onOpen={(p) => void openPath(p)}
                                             onCreate={createEntry} onRename={renameEntry}
                                             onDelete={(e) => void removeEntry(e)} onMove={(p, d) => void moveEntry(p, d)}
                                             onCopy={(p, d) => void copyEntry(p, d)}
                                             onMenu={(e, items) => setCtx({ x: e.clientX, y: e.clientY, items })} />
                            ) : tool === 'examples' ? (
                                <Examples examples={tree?.examples ?? []} activePath={active}
                                          onOpen={(p) => void openPath(p)} onCopy={(p) => void copyExample(p)} />
                            ) : tool === 'modules' ? (
                                <ModuleManager library={library} installed={installed} busy={moduleBusy}
                                               onInstall={(n) => void installModule(n)} onRemove={(n) => void removeModule(n)}
                                               onUse={(n) => { if (!addUse(n)) notify(buffer?.writable ? `Already using ${n}` : 'Open one of your programs first'); }}
                                               onView={viewModule} onNew={() => void newModule()} />
                            ) : null}
                        </div>
                    </aside>
                )}

            <div className="workspace">
            <div className="main">
                {/* Code */}
                <section className="code-pane">
                    {open.length > 0 && (
                        <div className="tabs-row">
                            <div className="tabs" role="tablist" data-tour="tabs">
                                {open.map((p) => {
                                    const b = buffers[p];
                                    const unsaved = !!b && b.writable && ws.isDirty(b);
                                    const shownHere = panes[focus] === p;
                                    const shownThere = panes[focus === 'left' ? 'right' : 'left'] === p;
                                    return (
                                        <div key={p} role="tab" aria-selected={shownHere}
                                             className={`tab ${shownHere ? 'on' : ''} ${shownThere ? 'side' : ''}`}
                                             draggable
                                             onDragStart={(e) => { e.dataTransfer.setData('text/x-zapp-tab', p); e.dataTransfer.effectAllowed = 'move'; }}
                                             onDragEnd={() => setDropSide(null)}
                                             onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); void closeTab(p); } }}
                                             onContextMenu={(e) => { e.preventDefault(); setCtx({ x: e.clientX, y: e.clientY, items: tabMenu(p) }); }}>
                                            <button className="tab-name" onClick={() => setActive(p)}
                                                    onDoubleClick={() => setMaximized(!maximized)}
                                                    title={isDoc(p) ? 'Zapp guide' : p.replace(/^(workspace|examples)\//, '')}>
                                                {isDoc(p) ? <IconBook size={13} /> : <FileIcon name={p} size={14} />}
                                                {tabTitle(p)}
                                            </button>
                                            <button className="tab-close" onClick={() => void closeTab(p)} aria-label={`Close ${tabTitle(p)}`}>
                                                {unsaved ? <span className="unsaved" /> : <IconClose size={11} />}
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                            <button className={`icon-btn split-btn ${split ? 'on' : ''}`} onClick={() => (split ? unsplit() : active && openToSide(active))}
                                    title={split ? 'Unsplit' : 'Split right'} aria-label={split ? 'Unsplit' : 'Split right'}>
                                <IconSplit size={15} />
                            </button>
                        </div>
                    )}
                    <div className={`panes ${split ? 'split' : ''}`} data-tour="editor"
                         onDragOver={(e) => {
                             if (!e.dataTransfer.types.includes('text/x-zapp-tab')) return;
                             e.preventDefault();
                             const side = dragSide(e);
                             if (side !== dropSide) setDropSide(side);
                         }}
                         onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropSide(null); }}
                         onDrop={dropTab}>
                        {renderPane('left')}
                        {split && renderPane('right')}
                        {dropSide && <div className={`drop-zone ${dropSide}`}><span>{dropSide === 'right' && !split ? 'Split right' : `Open on the ${dropSide}`}</span></div>}
                    </div>
                </section>

                {simOpen && !maximized && <div className="resize-bar" onMouseDown={startResize} />}

                {/* Simulator: hidden until opened from the ribbon or by running in it */}
                {simOpen && !maximized && <section className="output-area" style={{ width: outputWidth }}>
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
                            <select className="mini-select" value={simScreen} onChange={(e) => setSimScreen(e.target.value as SimScreen)} aria-label="Screen">
                                {(Object.keys(SCREEN_LABELS) as SimScreen[]).map((k) => <option key={k} value={k}>{SCREEN_LABELS[k]}</option>)}
                            </select>
                        </div>
                        <div className="stage">
                            <div className={`board-face ${sim ? 'live' : ''}`}>
                                <div className="board-face-head">
                                    <span className="board-face-name">{board?.title ?? 'Pick a board'}</span>
                                    {board && <span className="board-face-chip">{board.chip.toUpperCase()}{board.radio ? ' · Wi-Fi · BLE' : ''}</span>}
                                </div>
                                {usesScreen && sim?.framebuffer && <div className="oled-bezel"><Screen framebuffer={sim.framebuffer} rows={screenRows} /></div>}
                                <Lights board={board} result={sim} pressed={pressed} onPress={togglePress} />
                            </div>
                            <PinsUsed board={board} result={sim} />
                            {!sim && <p className="stage-hint">Press ▶ to run your program on this virtual board.</p>}
                        </div>
                    </div>

                </section>}
            </div>
                {/* Console along the bottom */}
                <Output lines={output} connected={connected} onSend={sendCommand} />
            </div>
            </div>

            <footer className="status-bar">
                <span className={`status-conn ${connected ? 'on' : ''}`}><span className="led" />{connected ? `${board?.title ?? 'Board'} connected` : 'No board connected'}</span>
                <span className="grow" />
                {active?.endsWith('.zap') && !active.endsWith('.zappmod') && (
                    <span className="status-mem" title={`${build.bytes} of ${BUDGET} bytes of program memory`}>
                        <span className="meter"><span style={{ width: `${percent}%` }} /></span>{percent < 1 ? '<1' : Math.round(percent)}%
                    </span>
                )}
                {active && <>
                    <span>{cursor.line}:{cursor.column}</span>
                    <span>{{ zapp: 'Zapp', html: 'HTML', css: 'CSS', javascript: 'JavaScript', json: 'JSON', markdown: 'Markdown', ini: 'Module', xml: 'SVG' }[ws.languageOf(active)] ?? 'Text'}</span>
                    <span>4 spaces</span>
                    <span>UTF-8</span>
                    <span>{saveState}</span>
                </>}
            </footer>

            {toast && <div className="toast">{toast}</div>}
            {tourOpen && <Tour steps={tourSteps} onClose={() => setTourOpen(false)} />}
            {dialogs.element}
            {ctx && <ContextMenu menu={ctx} onClose={() => setCtx(null)} />}
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
