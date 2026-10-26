import fs from 'fs';
import path from 'path';

// Every relative link in README.md and docs/ points at a file that exists.
const root = path.join(__dirname, '..');
const pages = ['README.md', ...fs.readdirSync(path.join(root, 'docs')).map((f) => `docs/${f}`)];

test.each(pages)('%s has no broken links', (page) => {
    const text = fs.readFileSync(path.join(root, page), 'utf8');
    const broken = [...text.matchAll(/\]\(([^)#:]+)(#[^)]*)?\)/g)]
        .map((m) => m[1]!)
        .filter((link) => !fs.existsSync(path.join(root, path.dirname(page), link)));
    expect(broken).toEqual([]);
});
