// Monaco vendors its own copy of DOMPurify, and even the newest Monaco ships a
// version with known XSS advisories. Swap in the npm package (kept current via
// package.json) so the editor bundles the fixed one. Same default export.
const fs = require('fs');
const path = require('path');

const modules = path.join(__dirname, '../node_modules');
const vendored = path.join(modules, 'monaco-editor/esm/vs/base/browser/dompurify/dompurify.js');
const patched = path.join(modules, 'dompurify/dist/purify.es.mjs');
if (fs.existsSync(vendored)) {
    fs.copyFileSync(patched, vendored);
    console.log(`monaco: DOMPurify ${JSON.parse(fs.readFileSync(path.join(modules, 'dompurify/package.json'), 'utf8')).version}`);
}
