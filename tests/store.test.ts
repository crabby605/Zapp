// The firmware's flash store (firmware/core/project_store.c), run on this
// machine against a fake flash by tests/native/store_check.c.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const root = path.join(__dirname, '..');

test.each([32, 512])('project store keeps files safe (%iKB, like boards without and with PSRAM)', (kb) => {
    const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zapp-store-')), 'store_check');
    execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror',
        `-DSTORE_KB=${kb}`, '-I', path.join(root, 'firmware', 'core'), '-I', path.join(root, 'firmware', 'rp2040'),
        '-o', bin, path.join(root, 'tests', 'native', 'store_check.c'),
        path.join(root, 'firmware', 'core', 'project_store.c')], { stdio: 'pipe' });
    expect(execFileSync(bin, { encoding: 'utf8' })).toMatch(/^store ok/);
});
