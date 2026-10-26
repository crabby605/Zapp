// Node-only (fs): import directly, never re-export from index.ts.
// Installs Zapp the way you would by hand: the RP2040 bootloader mounts as a
// USB drive (RPI-RP2) and flashes any .uf2 copied onto it. Shared by the IDE's
// /api/install route and the MCP server's zapp_install tool.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type FirmwareVariant = 'core' | 'pico_w';

export const firmwarePath = (repoRoot: string, variant: FirmwareVariant) =>
    path.join(repoRoot, 'firmware', 'rp2040', variant === 'pico_w' ? 'build-picow' : 'build', 'zapp.uf2');

// Where removable drives get mounted on each OS.
function mountRoots(): string[] {
    if (process.platform === 'darwin') return ['/Volumes'];
    if (process.platform === 'win32') return [];   // drive letters, below
    const user = os.userInfo().username;
    return [`/media/${user}`, `/run/media/${user}`, '/media', '/mnt'];
}

function candidates(): string[] {
    if (process.platform === 'win32') {
        return 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((d) => `${d}:\\`);
    }
    return mountRoots().flatMap((root) => {
        try { return fs.readdirSync(root).map((name) => path.join(root, name)); } catch { return []; }
    });
}

/** A running Zapp board's own USB drive, or null. Its boot_out.txt starts "Zapp v". */
export function findZappDrive(): string | null {
    for (const dir of candidates()) {
        try {
            if (fs.readFileSync(path.join(dir, 'boot_out.txt'), 'utf8').startsWith('Zapp v')) return dir;
        } catch { /* not a Zapp drive */ }
    }
    return null;
}

/** The mounted UF2 bootloader drive, or null. It always holds INFO_UF2.TXT. */
export function findUf2Drive(): string | null {
    for (const dir of candidates()) {
        try {
            const info = fs.readFileSync(path.join(dir, 'INFO_UF2.TXT'), 'utf8');
            if (/RPI-RP2|RP2040|Board-ID/i.test(info)) return dir;
        } catch { /* not a UF2 drive */ }
    }
    return null;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitForUf2Drive(timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const drive = findUf2Drive();
        if (drive) return drive;
        if (Date.now() > deadline) return null;
        await delay(250);
    }
}

/** Copy the firmware onto the bootloader drive. Returns the drive it used. */
export async function copyUf2(uf2: string, drive: string): Promise<void> {
    try {
        await fs.promises.copyFile(uf2, path.join(drive, 'zapp.uf2'));
    } catch (e) {
        // The board reboots the moment the last block lands, so the drive can
        // vanish before the copy "finishes". Gone = it took the firmware.
        if (fs.existsSync(path.join(drive, 'INFO_UF2.TXT'))) throw e;
    }
}
