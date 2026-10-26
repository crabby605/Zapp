// Files live on disk under the repo; this is the client plus the open-buffer
// model the editor works against.

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

export const listFiles = () => json<FileTree>('/api/files');

export const readFile = (path: string) =>
    json<{ path: string; content: string; writable: boolean }>(
        `/api/files?path=${encodeURIComponent(path)}`);

export const writeFile = (path: string, content: string) =>
    json<{ saved: boolean }>('/api/files', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content }),
    });

const post = (body: object) =>
    json<{ path?: string; deleted?: string }>('/api/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });

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
