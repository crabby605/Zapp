import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { moduleTemplate } from '../../../lib/templates';
import { HOSTED } from '../../../lib/workspace';

// Module manager, like Arduino's Library Manager. The repo's modules/ folder is
// the library everyone can install from; workspace/modules/ is what this
// workspace has installed, and only those compile into programs. Examples
// compile against the whole library so they always open cleanly.

const repoRoot = path.join(process.cwd(), '..');
const LIBRARY = path.join(repoRoot, 'modules');
const INSTALLED = path.join(repoRoot, 'workspace', 'modules');
const WORKSPACE = path.join(repoRoot, 'workspace');

const NAME = /^[a-z0-9_]+$/;

function read(dir: string): Record<string, string> {
    if (!fs.existsSync(dir)) return {};
    return Object.fromEntries(fs.readdirSync(dir)
        .filter((f) => f.endsWith('.zappmod'))
        .map((f) => [f.slice(0, -'.zappmod'.length), fs.readFileSync(path.join(dir, f), 'utf8')]));
}

// First run with a module manager: install whatever existing programs already
// `use`, so nothing that compiled yesterday breaks today.
function ensureInstalledDir() {
    if (fs.existsSync(INSTALLED)) return;
    fs.mkdirSync(INSTALLED, { recursive: true });
    const library = read(LIBRARY);
    const programs = fs.existsSync(WORKSPACE) ? fs.readdirSync(WORKSPACE).filter((f) => f.endsWith('.zap')) : [];
    for (const file of programs) {
        const source = fs.readFileSync(path.join(WORKSPACE, file), 'utf8');
        for (const [, name] of source.matchAll(/^\s*use\s+(\w+)/gm)) {
            if (name && library[name]) fs.writeFileSync(path.join(INSTALLED, `${name}.zappmod`), library[name]);
        }
    }
}

// Hosted, installed modules live in the browser; this only serves the library.
export async function GET() {
    if (HOSTED) return NextResponse.json({ library: read(LIBRARY), installed: {} });
    ensureInstalledDir();
    return NextResponse.json({ library: read(LIBRARY), installed: read(INSTALLED) });
}

// { op: 'install' | 'remove', name }. Install also updates: it copies the
// library's current version over the installed one.
export async function POST(request: Request) {
    if (HOSTED) return NextResponse.json({ error: 'Modules are kept in your browser here' }, { status: 403 });
    ensureInstalledDir();
    const { op, name } = await request.json();
    if (typeof name !== 'string' || !NAME.test(name)) {
        return NextResponse.json({ error: 'Bad module name' }, { status: 400 });
    }
    const installed = path.join(INSTALLED, `${name}.zappmod`);

    if (op === 'install') {
        const source = path.join(LIBRARY, `${name}.zappmod`);
        if (!fs.existsSync(source)) return NextResponse.json({ error: `No module called ${name}` }, { status: 404 });
        fs.copyFileSync(source, installed);
        return NextResponse.json({ installed: name });
    }
    if (op === 'create') {
        if (fs.existsSync(installed) || fs.existsSync(path.join(LIBRARY, `${name}.zappmod`))) {
            return NextResponse.json({ error: `There's already a module called ${name}` }, { status: 409 });
        }
        fs.writeFileSync(installed, moduleTemplate(name));
        return NextResponse.json({ path: `workspace/modules/${name}.zappmod` });
    }
    if (op === 'remove') {
        if (fs.existsSync(installed)) fs.unlinkSync(installed);
        return NextResponse.json({ removed: name });
    }
    return NextResponse.json({ error: `Unknown op '${op}'` }, { status: 400 });
}
