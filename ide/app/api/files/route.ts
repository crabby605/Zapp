import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { findZappDrive } from '../../../../compiler/src/nodeInstall';

// Workspace file API
// `workspace/` is your own folder tree: any depth, folders and the file types
// below. `examples/` and `library/` (the module library, repo modules/) are
// read-only. `workspace/modules/` holds installed modules; the module manager
// shows it, so the tree leaves it out, but its files open like any other.
// `drive/` is a plugged-in board's own USB drive, with that drive's rules.

const repoRoot = path.join(process.cwd(), '..');

type RootName = 'workspace' | 'examples' | 'library' | 'drive';

const FIXED: Record<Exclude<RootName, 'drive'>, { dir: string; writable: boolean }> = {
    workspace: { dir: path.join(repoRoot, 'workspace'), writable: true },
    examples:  { dir: path.join(repoRoot, 'examples'),  writable: false },
    library:   { dir: path.join(repoRoot, 'modules'),   writable: false },
};

// The drive is looked up per request: boards come and go.
function rootDir(root: RootName): string | null {
    return root === 'drive' ? findZappDrive() : FIXED[root].dir;
}

// Zapp programs, the web/ folder `serve web` uses, and notes.
const EXTENSIONS = ['.zap', '.zappmod', '.html', '.htm', '.css', '.js', '.json', '.svg', '.txt', '.md', '.csv'];
const HIDDEN_AT_ROOT = new Set(['modules']);
const MAX_FILE_BYTES = 256 * 1024;

// What the board keeps (firmware/core/usb_msc.c + project_store.h): main.zap up
// to 8KB, and the files in modules/ and web/, which share one pool of space.
// The board says how big in boot_out.txt ("Space: modules/ and web/ share N
// bytes, up to M files"); firmware too old to say had 8 files of 2KB each.
// Anything else on the drive is gone after the next reboot, so it can't be made here.
const DRIVE_FOLDERS: Record<string, string[]> = {
    modules: ['.zappmod'],
    web: ['.html', '.htm', '.css', '.js', '.json', '.svg', '.txt'],
};
const MAIN_MAX = 8192;

interface DriveLimits { share: number | null; perFile: number | null; files: number; nameMax: number }

function driveLimits(base: string): DriveLimits {
    try {
        const m = /share (\d+) bytes, up to (\d+) files/.exec(fs.readFileSync(path.join(base, 'boot_out.txt'), 'utf8'));
        if (m) return { share: Number(m[1]), perFile: null, files: Number(m[2]), nameMax: 31 };
    } catch { /* fall through */ }
    return { share: null, perFile: 2048, files: 8, nameMax: 23 };   // older firmware
}

const STARTER = `# Welcome to Zapp.
# Run this with the Run button or Cmd/Ctrl+Enter — no board required.

num count = 0

repeat 3:
    count = count + 1
    print "blink " + count
    set pin 25 high
    sleep 200ms
    set pin 25 low
    sleep 200ms
`;

export interface TreeNode {
    path: string;            // "workspace/web/index.html"
    name: string;
    kind: 'file' | 'dir';
    size: number;
    modified: number;
    writable: boolean;
    children?: TreeNode[];
}

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

// One path segment a person typed: no slashes, no dotfiles, nothing weird.
function validName(name: string): boolean {
    return name.length > 0 && name.length <= 80 && !name.startsWith('.') &&
           !/[\/\\:*?"<>|\x00-\x1f]/.test(name) && name.trim() === name;
}

const allowedFile = (name: string) => EXTENSIONS.includes(path.extname(name).toLowerCase());

interface Resolved { abs: string; root: RootName; rel: string }

// "workspace/web/index.html" → an absolute path inside its root, or null.
function resolve(relative: string): Resolved | null {
    const [rootName, ...rest] = relative.split('/').filter(Boolean);
    if (!['workspace', 'examples', 'library', 'drive'].includes(rootName ?? '')) return null;
    const base = rootDir(rootName as RootName);
    if (!base || rest.some((seg) => seg === '..' || seg.startsWith('.'))) return null;
    const abs = path.resolve(base, ...rest);
    if (abs !== path.resolve(base) && !abs.startsWith(path.resolve(base) + path.sep)) return null;   // no traversal
    return { abs, root: rootName as RootName, rel: rest.join('/') };
}

const toRelative = (root: RootName, abs: string) =>
    [root, ...path.relative(rootDir(root)!, abs).split(path.sep)].filter(Boolean).join('/');

// Files the board stores (modules/ and web/), with their sizes.
function driveFiles(base: string): { rel: string; size: number }[] {
    return Object.keys(DRIVE_FOLDERS).flatMap((f) => {
        try {
            return fs.readdirSync(path.join(base, f)).filter((n) => !n.startsWith('.'))
                .map((n) => ({ rel: `${f}/${n}`, size: fs.statSync(path.join(base, f, n)).size }));
        } catch { return []; }
    });
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)}KB`;

// Whether a file at `rel` (with `bytes` of content) is one the board keeps, and why not.
function driveRule(rel: string, bytes?: number): string | null {
    const base = rootDir('drive');
    const parts = rel.split('/');
    if (parts.length === 1) {
        if (rel !== 'main.zap') return 'Only main.zap, modules/ and web/ are kept on the board';
        if (bytes !== undefined && bytes > MAIN_MAX) return `main.zap can be at most ${MAIN_MAX / 1024}KB on the board`;
        return null;
    }
    const [folder, name] = parts;
    const exts = DRIVE_FOLDERS[folder ?? ''];
    if (parts.length !== 2 || !exts) return 'Only main.zap, modules/ and web/ are kept on the board';
    if (!exts.includes(path.extname(name!).toLowerCase())) return `${folder}/ holds ${exts.join(' ')} files`;
    if (!base) return null;
    const limits = driveLimits(base);
    const stored = folder === 'web' ? rel : name!;   // what the board names it
    if (stored.length > limits.nameMax) return `That name is too long for the board — ${limits.nameMax - (folder === 'web' ? 4 : 0)} characters at most`;
    if (bytes === undefined) return null;
    if (limits.perFile && bytes > limits.perFile) return `This board's Zapp keeps files up to ${kb(limits.perFile)} — install the latest Zapp for bigger ones`;
    const others = driveFiles(base).filter((f) => f.rel !== rel);
    if (others.length >= limits.files) return `The board holds ${limits.files} files across modules/ and web/ — delete one first`;
    const used = others.reduce((sum, f) => sum + f.size, 0);
    if (limits.share !== null && used + bytes > limits.share) {
        return `Not enough room on the board: ${kb(limits.share - used)} free in modules/ and web/, this needs ${kb(bytes)}`;
    }
    return null;
}

function writableFile(r: Resolved): boolean {
    if (r.root === 'drive') return r.rel !== 'boot_out.txt';
    return FIXED[r.root].writable;
}

function ensureWorkspace() {
    const { dir } = FIXED.workspace;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const main = path.join(dir, 'main.zap');
    if (!fs.existsSync(main) && fs.readdirSync(dir).length === 0) fs.writeFileSync(main, STARTER);
}

function walk(root: RootName, dir: string, depth = 0): TreeNode[] {
    if (!fs.existsSync(dir) || depth > 8) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.'))
        .filter((e) => !(depth === 0 && root === 'workspace' && HIDDEN_AT_ROOT.has(e.name)))
        .filter((e) => (root === 'drive' && depth === 0
            ? (e.isDirectory() ? e.name in DRIVE_FOLDERS : ['main.zap', 'boot_out.txt'].includes(e.name))
            : e.isDirectory() || allowedFile(e.name)))
        .map((e): TreeNode => {
            const abs = path.join(dir, e.name);
            const stat = fs.statSync(abs);
            const rel = toRelative(root, abs);
            const node: TreeNode = {
                path: rel, name: e.name, kind: e.isDirectory() ? 'dir' : 'file', size: stat.size, modified: stat.mtimeMs,
                writable: root === 'drive' ? !e.isDirectory() && rel !== 'drive/boot_out.txt' : FIXED[root].writable,
            };
            if (e.isDirectory()) node.children = walk(root, abs, depth + 1);
            return node;
        })
        // Folders first, then files, each alphabetical — like every file manager.
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.kind === 'dir' ? -1 : 1));
}

// A name that isn't taken in `dir` yet: "blink.zap" → "blink 2.zap"
function freeName(dir: string, name: string): string {
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    for (let i = 1; ; i++) {
        const candidate = i === 1 ? name : `${base} ${i}${ext}`;
        if (!fs.existsSync(path.join(dir, candidate))) return candidate;
    }
}

// A target folder in the workspace or on the drive ("workspace", "drive/web").
function targetDir(dir: unknown): Resolved | null {
    const target = resolve(String(dir ?? 'workspace') || 'workspace');
    if (!target || (target.root !== 'workspace' && target.root !== 'drive')) return null;
    if (!fs.existsSync(target.abs) || !fs.statSync(target.abs).isDirectory()) return null;
    return target;
}

// Write a new file into `dir` (workspace or drive), applying the drive's rules.
function writeNew(dir: Resolved, name: string, content: string, overwrite = false): { path?: string; error?: string } {
    const isDrive = dir.root === 'drive';
    const file = overwrite ? name : freeName(dir.abs, name);
    if (isDrive) {
        const why = driveRule([dir.rel, file].filter(Boolean).join('/'), Buffer.byteLength(content));
        if (why) return { error: why };
    }
    const abs = path.join(dir.abs, file);
    fs.writeFileSync(abs, content);
    return { path: toRelative(dir.root, abs) };
}

export async function GET(request: Request) {
    ensureWorkspace();
    const target = new URL(request.url).searchParams.get('path');

    if (!target) {
        const drive = findZappDrive();
        return NextResponse.json({
            workspace: walk('workspace', FIXED.workspace.dir),
            examples: walk('examples', FIXED.examples.dir).filter((n) => n.kind === 'file' && n.name.endsWith('.zap')),
            drive: drive ? (() => {
                const limits = driveLimits(drive);
                const files = driveFiles(drive);
                return {
                    name: path.basename(drive),
                    tree: walk('drive', drive),
                    hasWeb: fs.existsSync(path.join(drive, 'web')),
                    slotsUsed: files.length,
                    slots: limits.files,
                    bytesUsed: files.reduce((sum, f) => sum + f.size, 0),
                    bytes: limits.share,
                };
            })() : null,
        });
    }

    const resolved = resolve(target);
    if (!resolved || !allowedFile(resolved.abs)) return bad('Bad path');
    if (!fs.existsSync(resolved.abs) || !fs.statSync(resolved.abs).isFile()) return bad('Not found', 404);
    return NextResponse.json({
        path: target,
        content: fs.readFileSync(resolved.abs, 'utf8'),
        writable: writableFile(resolved),
    });
}

export async function PUT(request: Request) {
    ensureWorkspace();
    const { path: target, content } = await request.json();
    const resolved = resolve(String(target ?? ''));
    if (!resolved || !allowedFile(resolved.abs)) return bad('Bad path');
    if (!writableFile(resolved)) return bad('That file is read-only', 403);
    const text = String(content ?? '');
    if (Buffer.byteLength(text) > MAX_FILE_BYTES) return bad('That file is too big to save here');
    if (resolved.root === 'drive') {
        const why = driveRule(resolved.rel, Buffer.byteLength(text));
        if (why) return bad(why);
    }
    fs.writeFileSync(resolved.abs, text);
    return NextResponse.json({ path: target, saved: true });
}

// ops: create (file or folder, in a folder), rename, move, copy, delete.
export async function POST(request: Request) {
    ensureWorkspace();
    const body = await request.json();
    const op = String(body.op ?? '');

    if (op === 'create' || op === 'mkdir') {
        const dir = targetDir(body.dir);
        if (!dir) return bad('That folder no longer exists');
        if (op === 'mkdir' && dir.root === 'drive') return bad('The board only keeps its modules/ and web/ folders');
        let name = String(body.name ?? '').trim();
        if (op === 'create' && !path.extname(name)) name += dir.root === 'drive' && dir.rel === 'web' ? '.html' : '.zap';
        if (!validName(name)) return bad(`“${name}” isn't a usable name`);
        if (op === 'create' && !allowedFile(name)) return bad(`Files can be ${EXTENSIONS.join(' ')}`);
        if (dir.root === 'workspace' && !dir.rel && HIDDEN_AT_ROOT.has(name)) return bad(`“${name}” is reserved for the module manager`);

        if (op === 'mkdir') {
            const abs = path.join(dir.abs, freeName(dir.abs, name));
            fs.mkdirSync(abs);
            return NextResponse.json({ path: toRelative('workspace', abs) });
        }
        let content = String(body.content ?? '');
        if (body.from) {
            const source = resolve(String(body.from));
            if (!source || !allowedFile(source.abs) || !fs.existsSync(source.abs)) return bad('Bad source');
            content = fs.readFileSync(source.abs, 'utf8');
        }
        const result = writeNew(dir, name, content);
        return result.error ? bad(result.error) : NextResponse.json({ path: result.path });
    }

    const from = resolve(String(body.path ?? ''));
    if (!from || !from.rel || !fs.existsSync(from.abs)) return bad('Bad path');
    const isDir = fs.statSync(from.abs).isDirectory();

    // Copy between My programs and the board (either way), or within one.
    // `name` overrides the file name; copying a program to the drive's top
    // level makes it the board's main.zap.
    if (op === 'copy') {
        if (isDir) return bad('Copy files one at a time');
        const dir = targetDir(body.to);
        if (!dir) return bad('That folder no longer exists');
        const toMain = dir.root === 'drive' && !dir.rel;
        const name = toMain ? 'main.zap' : String(body.name ?? path.basename(from.abs));
        const result = writeNew(dir, name, fs.readFileSync(from.abs, 'utf8'), toMain);
        return result.error ? bad(result.error) : NextResponse.json({ path: result.path });
    }

    if (from.root !== 'workspace' && from.root !== 'drive') return bad('That file is read-only');
    if (from.root === 'workspace' && HIDDEN_AT_ROOT.has(from.rel)) return bad('That folder belongs to the module manager');
    if (from.root === 'drive' && (isDir || from.rel === 'main.zap' || from.rel === 'boot_out.txt')) {
        return bad(from.rel === 'main.zap' ? "The board always has a main.zap — empty it instead"
                 : isDir ? 'The board keeps its modules/ and web/ folders' : 'boot_out.txt is written by the board');
    }

    if (op === 'rename') {
        let name = String(body.name ?? '').trim();
        if (!isDir && !path.extname(name)) name += path.extname(from.abs);   // keep the type if left off
        if (!validName(name) || (!isDir && !allowedFile(name))) return bad(`“${name}” isn't a usable name`);
        if (name === path.basename(from.abs)) return NextResponse.json({ path: body.path });
        const dir = path.dirname(from.abs);
        if (from.root === 'workspace' && dir === path.resolve(FIXED.workspace.dir) && HIDDEN_AT_ROOT.has(name)) return bad(`“${name}” is reserved`);
        const to = path.join(dir, freeName(dir, name));
        if (from.root === 'drive') {
            const why = driveRule(path.relative(rootDir('drive')!, to).split(path.sep).join('/'));
            if (why) return bad(why);
        }
        fs.renameSync(from.abs, to);
        return NextResponse.json({ path: toRelative(from.root, to) });
    }

    if (op === 'move') {
        if (from.root !== 'workspace') return bad('Use copy to move files on and off the board');
        const dir = targetDir(body.to);
        if (!dir || dir.root !== 'workspace') return bad('That folder no longer exists');
        if (isDir && (dir.abs === from.abs || dir.abs.startsWith(from.abs + path.sep))) return bad("A folder can't go inside itself");
        if (path.dirname(from.abs) === dir.abs) return NextResponse.json({ path: body.path });
        const to = path.join(dir.abs, freeName(dir.abs, path.basename(from.abs)));
        fs.renameSync(from.abs, to);
        return NextResponse.json({ path: toRelative('workspace', to) });
    }

    if (op === 'delete') {
        fs.rmSync(from.abs, { recursive: isDir, force: false });
        return NextResponse.json({ deleted: body.path });
    }

    return bad(`Unknown op '${op}'`);
}
