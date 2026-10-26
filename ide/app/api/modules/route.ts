import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

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

export async function GET() {
    ensureInstalledDir();
    return NextResponse.json({ library: read(LIBRARY), installed: read(INSTALLED) });
}

// { op: 'install' | 'remove', name }. Install also updates: it copies the
// library's current version over the installed one.
export async function POST(request: Request) {
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
        fs.writeFileSync(installed, template(name));
        return NextResponse.json({ path: `workspace/modules/${name}.zappmod` });
    }
    if (op === 'remove') {
        if (fs.existsSync(installed)) fs.unlinkSync(installed);
        return NextResponse.json({ removed: name });
    }
    return NextResponse.json({ error: `Unknown op '${op}'` }, { status: 400 });
}

// A new module, with every part explained. Comments sit on their own lines:
// the module parser reads everything after `=` as the value.
function template(name: string) {
    return `# A module tells Zapp how to read one part, so programs can just say
#   use ${name}
#   get data from ${name}
#   print ${name}.reading
# Fill in the numbers from your part's datasheet. Lines starting with # are notes.
# It saves by itself and is ready to use.
#
# What a module file can do: talk to I2C parts by register — read some bytes,
# turn them into a number, scale it. Parts that need more (special maths, a
# new screen type, a new GPS sentence) need support in Zapp itself.

[module]
# The name programs write after \`use\`. Lowercase letters, numbers and _.
name        = "${name}"
version     = "1.0.0"
description = "What this part is, in a few words"
author      = "me"

[compat]
# How the part is wired. Module files you write can describe i2c parts.
interface   = "i2c"

[i2c]
# The part's address. The datasheet lists it, usually written like 0x76.
addr_default = 0x76

[init]
# Settings to send once at the start, as  register = value  (one byte each).
# Many chips need one to wake up. Delete this section if yours doesn't.
0xF4 = 0x27

# One [fields.<name>] section per reading. Programs read it as ${name}.<name>.
[fields.reading]
type   = "num"
# The register the reading starts at.
reg    = 0xFA
# How its bytes make a number. u = never negative, i = can be negative.
# 8, 16, 24 or 32 bits. _be = first byte biggest, _le = first byte smallest.
#   u8  i8  u16_be  u16_le  i16_be  i16_le  u24_be  u24_le  u32_be  i32_be ...
format = "u16_be"
# Optional, applied in this order — delete any you don't need:
#   shift  = 4        drop this many low bits
#   bits   = 12       keep only this many bits (signed formats keep the sign)
#   mask   = 0x80     keep only these bits
#   scale  = 0.0625   multiply by this (the datasheet's "LSB" or "resolution")
#   offset = -40      then add this
# For a yes/no reading, set type = "bool" and use mask to pick the bit.
scale  = 1
`;
}
