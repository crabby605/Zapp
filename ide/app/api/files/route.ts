import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

// Workspace file API
// Three roots, all inside the repo. `workspace/` is the IDE's own project and is
// created on first run; examples are read-only templates; modules are the
// .zappmod definitions the compiler reads.

const repoRoot = path.join(process.cwd(), '..');

const ROOTS = {
    workspace: { dir: path.join(repoRoot, 'workspace'), writable: true,  ext: '.zap' },
    examples:  { dir: path.join(repoRoot, 'examples'),  writable: false, ext: '.zap' },
    modules:   { dir: path.join(repoRoot, 'modules'),   writable: true,  ext: '.zappmod' },
} as const;

type RootName = keyof typeof ROOTS;

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

// "workspace/main.zap" → an absolute path, or null if it escapes its root.
function resolve(relative: string): { file: string; root: RootName } | null {
    const [rootName, ...rest] = relative.split('/');
    const root = ROOTS[rootName as RootName];
    if (!root || rest.length !== 1) return null;

    const name = rest[0]!;
    if (!name.endsWith(root.ext) || name.startsWith('.') || name.includes('..')) return null;

    const file = path.resolve(root.dir, name);
    if (path.dirname(file) !== path.resolve(root.dir)) return null;   // no traversal
    return { file, root: rootName as RootName };
}

function ensureWorkspace() {
    const { dir } = ROOTS.workspace;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const main = path.join(dir, 'main.zap');
    if (!fs.existsSync(main)) fs.writeFileSync(main, STARTER);
}

function list(rootName: RootName) {
    const { dir, ext } = ROOTS[rootName];
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter((f) => f.endsWith(ext) && !f.startsWith('.'))
        .sort()
        .map((name) => {
            const stat = fs.statSync(path.join(dir, name));
            return { path: `${rootName}/${name}`, name, size: stat.size, modified: stat.mtimeMs };
        });
}

// A name that isn't taken yet: "blink.zap" → "blink 2.zap"
function freeName(rootName: RootName, name: string): string {
    const { dir, ext } = ROOTS[rootName];
    const base = name.endsWith(ext) ? name.slice(0, -ext.length) : name;
    for (let i = 1; ; i++) {
        const candidate = i === 1 ? `${base}${ext}` : `${base} ${i}${ext}`;
        if (!fs.existsSync(path.join(dir, candidate))) return candidate;
    }
}

export async function GET(request: Request) {
    ensureWorkspace();
    const params = new URL(request.url).searchParams;
    const target = params.get('path');

    if (!target) {
        return NextResponse.json({
            workspace: list('workspace'),
            examples: list('examples'),
            modules: list('modules'),
        });
    }

    const resolved = resolve(target);
    if (!resolved) return NextResponse.json({ error: 'Bad path' }, { status: 400 });
    if (!fs.existsSync(resolved.file)) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({
        path: target,
        content: fs.readFileSync(resolved.file, 'utf8'),
        writable: ROOTS[resolved.root].writable,
    });
}

export async function PUT(request: Request) {
    ensureWorkspace();
    const { path: target, content } = await request.json();
    const resolved = resolve(String(target ?? ''));
    if (!resolved) return NextResponse.json({ error: 'Bad path' }, { status: 400 });
    if (!ROOTS[resolved.root].writable) {
        return NextResponse.json({ error: `${resolved.root} is read-only` }, { status: 403 });
    }
    fs.writeFileSync(resolved.file, String(content ?? ''));
    return NextResponse.json({ path: target, saved: true });
}

export async function POST(request: Request) {
    ensureWorkspace();
    const body = await request.json();
    const op = String(body.op ?? '');

    // Create a new file, optionally seeded from another one ("open a copy").
    if (op === 'create') {
        const name = freeName('workspace', String(body.name ?? 'untitled.zap'));
        let content = String(body.content ?? '');
        if (body.from) {
            const source = resolve(String(body.from));
            if (!source) return NextResponse.json({ error: 'Bad source' }, { status: 400 });
            content = fs.readFileSync(source.file, 'utf8');
        }
        fs.writeFileSync(path.join(ROOTS.workspace.dir, name), content);
        return NextResponse.json({ path: `workspace/${name}` });
    }

    if (op === 'rename') {
        const from = resolve(String(body.path ?? ''));
        if (!from || !ROOTS[from.root].writable) {
            return NextResponse.json({ error: 'Bad path' }, { status: 400 });
        }
        const name = freeName(from.root, String(body.name ?? ''));
        fs.renameSync(from.file, path.join(ROOTS[from.root].dir, name));
        return NextResponse.json({ path: `${from.root}/${name}` });
    }

    if (op === 'delete') {
        const target = resolve(String(body.path ?? ''));
        if (!target || !ROOTS[target.root].writable) {
            return NextResponse.json({ error: 'Bad path' }, { status: 400 });
        }
        fs.unlinkSync(target.file);
        return NextResponse.json({ deleted: body.path });
    }

    return NextResponse.json({ error: `Unknown op '${op}'` }, { status: 400 });
}
