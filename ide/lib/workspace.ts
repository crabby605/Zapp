// Files live on disk under the repo; this is the client plus the open-buffer
// model the editor works against.

export interface FileEntry {
    path: string;        // "workspace/main.zap"
    name: string;
    size: number;
    modified: number;
}

export interface FileTree {
    workspace: FileEntry[];
    examples: FileEntry[];
    modules: FileEntry[];
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

export const createFile = (name: string, content = '') => post({ op: 'create', name, content });

/** Copy a read-only example into the workspace so editing it is safe. */
export const copyToWorkspace = (from: string) =>
    post({ op: 'create', name: fileName(from), from });

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
