// Files live on disk under the repo; this is the client plus the open-buffer
// model the editor works against.

import { STARTER, moduleTemplate } from './templates';

export interface FileEntry {
    path: string;        // "workspace/web/index.html"
    name: string;
    kind: 'file' | 'dir';
    size: number;
    modified: number;
    writable?: boolean;
    children?: FileEntry[];
}

/** A plugged-in board's own USB drive. */
export interface DriveInfo {
    name: string;
    tree: FileEntry[];
    hasWeb: boolean;      // older firmware has no web/ folder
    slotsUsed: number;    // files in modules/ + web/
    slots: number;
    bytesUsed: number;
    bytes: number | null; // space modules/ + web/ share; null on older firmware (2KB each)
}

export interface FileTree {
    workspace: FileEntry[];   // nested folders
    examples: FileEntry[];    // flat, read-only
    drive: DriveInfo | null;
}

/** Every file in a tree, depth-first. */
export const allFiles = (nodes: FileEntry[]): FileEntry[] =>
    nodes.flatMap((n) => (n.kind === 'dir' ? allFiles(n.children ?? []) : [n]));

export const parentOf = (path: string) => path.split('/').slice(0, -1).join('/');

// Monaco language for a file, by extension.
export function languageOf(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase();
    return ({ zap: 'zapp', zappmod: 'ini', html: 'html', htm: 'html', css: 'css', js: 'javascript',
              json: 'json', svg: 'xml', md: 'markdown' } as Record<string, string>)[ext ?? ''] ?? 'plaintext';
}

export interface Buffer {
    path: string;
    content: string;
    saved: string;       // last content written to disk
    writable: boolean;
}

export const isDirty = (b: Buffer) => b.content !== b.saved;
export const fileName = (path: string) => path.split('/').pop() ?? path;
export const rootOf = (path: string) => path.split('/')[0] ?? '';

async function json<T>(input: string, init?: RequestInit): Promise<T> {
    const res = await fetch(input, init);
    const body = await res.json();
    if (!res.ok || body.error) throw new Error(body.error ?? `${res.status}`);
    return body as T;
}

/** Running as a public site (Vercel): there's no disk or board on the server, so
 *  My programs and installed modules live in this browser instead. */
export const HOSTED = process.env.NEXT_PUBLIC_ZAPP_HOSTED === '1';

// The hosted workspace: every file under workspace/ by path, plus empty folders.
// Same ops and error messages as /api/files, minus the board drive.
interface Local { files: Record<string, { content: string; modified: number }>; dirs: string[] }
const LOCAL_KEY = 'zapp-ide-files';
const EXTENSIONS = ['.zap', '.zappmod', '.html', '.htm', '.css', '.js', '.json', '.svg', '.txt', '.md', '.csv'];

function loadLocal(): Local {
    try {
        const raw = localStorage.getItem(LOCAL_KEY);
        if (raw) return JSON.parse(raw) as Local;
    } catch { /* corrupt or unavailable — start fresh */ }
    return { files: { 'workspace/main.zap': { content: STARTER, modified: Date.now() } }, dirs: [] };
}

function saveLocal(local: Local) {
    try {
        localStorage.setItem(LOCAL_KEY, JSON.stringify(local));
    } catch {
        throw new Error("This browser's storage is full — delete some files first");
    }
}

const extOf = (name: string) => (name.includes('.') ? '.' + name.split('.').pop()!.toLowerCase() : '');
const validName = (name: string) => name.length > 0 && name.length <= 80 && !name.startsWith('.') &&
    !/[\/\\:*?"<>|\x00-\x1f]/.test(name) && name.trim() === name;
const exists = (l: Local, path: string) =>
    path === 'workspace' || path in l.files || l.dirs.includes(path) ||
    Object.keys(l.files).some((f) => f.startsWith(path + '/'));
const isDir = (l: Local, path: string) => exists(l, path) && !(path in l.files);

function freeName(l: Local, dir: string, name: string): string {
    const ext = extOf(name);
    const base = name.slice(0, name.length - ext.length);
    for (let i = 1; ; i++) {
        const candidate = i === 1 ? name : `${base} ${i}${ext}`;
        if (!exists(l, `${dir}/${candidate}`)) return candidate;
    }
}

function localTree(l: Local, dir = 'workspace'): FileEntry[] {
    const prefix = dir + '/';
    const children = new Set<string>();
    for (const p of [...Object.keys(l.files), ...l.dirs]) {
        if (p.startsWith(prefix)) children.add(p.slice(prefix.length).split('/')[0]!);
    }
    return [...children]
        .filter((name) => !(dir === 'workspace' && name === 'modules'))   // the module manager shows those
        .map((name): FileEntry => {
            const path = prefix + name;
            const file = l.files[path];
            return file
                ? { path, name, kind: 'file', size: file.content.length, modified: file.modified, writable: true }
                : { path, name, kind: 'dir', size: 0, modified: 0, writable: true, children: localTree(l, path) };
        })
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind === 'dir' ? -1 : 1));
}

// Move everything at `from` (a file or a folder's contents) to `to`.
function relocate(l: Local, from: string, to: string) {
    const moved = (p: string) => (p === from ? to : p.startsWith(from + '/') ? to + p.slice(from.length) : p);
    l.files = Object.fromEntries(Object.entries(l.files).map(([p, f]) => [moved(p), f]));
    l.dirs = l.dirs.map(moved);
}

async function localPost(body: Record<string, string>): Promise<{ path?: string; deleted?: string }> {
    const l = loadLocal();
    const op = body.op;
    if (op === 'create' || op === 'mkdir') {
        const dir = body.dir || 'workspace';
        if (!dir.startsWith('workspace') || !isDir(l, dir)) throw new Error('That folder no longer exists');
        let name = String(body.name ?? '').trim();
        if (op === 'create' && !extOf(name)) name += '.zap';
        if (!validName(name)) throw new Error(`“${name}” isn't a usable name`);
        if (op === 'create' && !EXTENSIONS.includes(extOf(name))) throw new Error(`Files can be ${EXTENSIONS.join(' ')}`);
        if (dir === 'workspace' && name === 'modules') throw new Error(`“${name}” is reserved for the module manager`);
        const path = `${dir}/${freeName(l, dir, name)}`;
        if (op === 'mkdir') l.dirs.push(path);
        else l.files[path] = { content: body.from ? (await readFile(body.from)).content : body.content ?? '', modified: Date.now() };
        saveLocal(l);
        return { path };
    }

    const from = String(body.path ?? '');
    if (!from.startsWith('workspace/') || !exists(l, from)) throw new Error('Bad path');
    const parent = parentOf(from);
    if (op === 'rename') {
        let name = String(body.name ?? '').trim();
        if (!isDir(l, from) && !extOf(name)) name += extOf(fileName(from));
        if (!validName(name) || (!isDir(l, from) && !EXTENSIONS.includes(extOf(name)))) throw new Error(`“${name}” isn't a usable name`);
        if (name === fileName(from)) return { path: from };
        const to = `${parent}/${freeName(l, parent, name)}`;
        relocate(l, from, to);
        saveLocal(l);
        return { path: to };
    }
    if (op === 'move' || op === 'copy') {
        const dir = String(body.to ?? 'workspace');
        if (!dir.startsWith('workspace') || !isDir(l, dir)) throw new Error('The board drive is only reachable from the desktop IDE');
        if (dir === from || dir.startsWith(from + '/')) throw new Error("A folder can't go inside itself");
        if (op === 'move' && dir === parent) return { path: from };
        const to = `${dir}/${freeName(l, dir, String(body.name ?? fileName(from)))}`;
        if (op === 'move') relocate(l, from, to);
        else if (isDir(l, from)) throw new Error('Copy files one at a time');
        else l.files[to] = { content: l.files[from]!.content, modified: Date.now() };
        saveLocal(l);
        return { path: to };
    }
    if (op === 'delete') {
        for (const p of Object.keys(l.files)) if (p === from || p.startsWith(from + '/')) delete l.files[p];
        l.dirs = l.dirs.filter((p) => p !== from && !p.startsWith(from + '/'));
        saveLocal(l);
        return { deleted: from };
    }
    throw new Error(`Unknown op '${op}'`);
}

export async function listFiles(): Promise<FileTree> {
    const tree = await json<FileTree>('/api/files');
    return HOSTED ? { ...tree, workspace: localTree(loadLocal()), drive: null } : tree;
}

export async function readFile(path: string): Promise<{ path: string; content: string; writable: boolean }> {
    if (HOSTED && rootOf(path) === 'workspace') {
        const file = loadLocal().files[path];
        if (!file) throw new Error('Not found');
        return { path, content: file.content, writable: true };
    }
    return json(`/api/files?path=${encodeURIComponent(path)}`);
}

export async function writeFile(path: string, content: string): Promise<{ saved: boolean }> {
    if (HOSTED) {
        const l = loadLocal();
        if (rootOf(path) !== 'workspace') throw new Error('That file is read-only');
        l.files[path] = { content, modified: Date.now() };
        saveLocal(l);
        return { saved: true };
    }
    return json('/api/files', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content }),
    });
}

const post = (body: Record<string, string>) => HOSTED ? localPost(body) :
    json<{ path?: string; deleted?: string }>('/api/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

// Modules: the library is on the server; installed ones are workspace/modules/*.zappmod.

const postModule = (op: string, name: string) =>
    json<{ path?: string }>('/api/modules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op, name }),
    });

const installedPath = (name: string) => `workspace/modules/${name}.zappmod`;

/** Module name → .zappmod text, for the whole library and for what's installed. */
export async function listModules(): Promise<{ library: Record<string, string>; installed: Record<string, string> }> {
    const data = await json<{ library: Record<string, string>; installed: Record<string, string> }>('/api/modules');
    if (!HOSTED) return data;
    const installed = Object.fromEntries(Object.entries(loadLocal().files)
        .filter(([p]) => /^workspace\/modules\/[a-z0-9_]+\.zappmod$/.test(p))
        .map(([p, f]) => [fileName(p).slice(0, -'.zappmod'.length), f.content]));
    return { library: data.library, installed };
}

/** Install (or update to the library's version). */
export async function installModule(name: string) {
    if (!HOSTED) return void await postModule('install', name);
    const { library } = await listModules();
    if (!library[name]) throw new Error(`No module called ${name}`);
    await writeFile(installedPath(name), library[name]);
}

export async function removeModule(name: string) {
    if (!HOSTED) return void await postModule('remove', name);
    const l = loadLocal();
    delete l.files[installedPath(name)];
    saveLocal(l);
}

/** A new module of your own, from the template. Returns its path. */
export async function createModule(name: string): Promise<string> {
    if (!HOSTED) return (await postModule('create', name)).path!;
    const { library, installed } = await listModules();
    if (library[name] || installed[name]) throw new Error(`There's already a module called ${name}`);
    await writeFile(installedPath(name), moduleTemplate(name));
    return installedPath(name);
}

/** `dir` is a workspace folder path ("workspace" or "workspace/web"). */
export const createFile = (dir: string, name: string, content = '') => post({ op: 'create', dir, name, content });
export const createFolder = (dir: string, name: string) => post({ op: 'mkdir', dir, name });
export const moveEntry = (path: string, to: string) => post({ op: 'move', path, to });
/** Copy a file between My programs and the board drive. `to` is a folder; "drive" itself means main.zap. */
export const copyEntry = (path: string, to: string) => post({ op: 'copy', path, to });

/** Copy a read-only example into the workspace so editing it is safe. */
export const copyToWorkspace = (from: string) =>
    post({ op: 'create', dir: 'workspace', name: fileName(from), from });

export const renameFile = (path: string, name: string) => post({ op: 'rename', path, name });
export const deleteFile = (path: string) => post({ op: 'delete', path });

// Session
// Which tabs were open, so a refresh doesn't lose your place. Content is on
// disk, so only paths are stored.

const SESSION_KEY = 'zapp-ide-session';

export interface Session {
    open: string[];
    active: string | null;
}

export function loadSession(): Session {
    try {
        const raw = localStorage.getItem(SESSION_KEY);
        if (raw) return JSON.parse(raw) as Session;
    } catch {
        // corrupt or unavailable storage — start fresh
    }
    return { open: [], active: null };
}

export function saveSession(session: Session) {
    try {
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch {
        // private mode: losing the tab list is survivable
    }
}

// Drafts: unsaved edits, kept per file so a refresh or a crash loses nothing.
// They come back still marked unsaved.

const DRAFTS_KEY = 'zapp-ide-drafts';

export function loadDrafts(): Record<string, string> {
    try { return JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '{}'); } catch { return {}; }
}

export function saveDrafts(buffers: Record<string, Buffer>) {
    const drafts = Object.fromEntries(Object.values(buffers)
        .filter((b) => b.writable && isDirty(b)).map((b) => [b.path, b.content]));
    try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts)); } catch { /* full or unavailable */ }
}

/** A buffer for a file just read from disk, with its draft applied if it has one. */
export function bufferFor(path: string, file: { content: string; writable: boolean }): Buffer {
    const draft = file.writable ? loadDrafts()[path] : undefined;
    return { path, content: draft ?? file.content, saved: file.content, writable: file.writable };
}
