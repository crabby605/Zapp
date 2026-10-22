// Install Zapp: the board's bootloader mounts as a USB drive (RPI-RP2) and
// flashes any .uf2 copied onto it. The IDE server runs on the computer the
// board is plugged into, so it does the copy (/api/install) — the same code
// the MCP server's zapp_install uses.

export type FirmwareVariant = 'core' | 'pico_w';

export const firmwareVariant = (boardName: string): FirmwareVariant =>
    boardName === 'pico_w' ? 'pico_w' : 'core';

export const firmwareUrl = (variant: FirmwareVariant) => `/api/firmware?variant=${variant}`;

/** Wait (on the server) for the RPI-RP2 drive, then copy Zapp onto it. */
export async function installViaServer(variant: FirmwareVariant): Promise<void> {
    const res = await fetch('/api/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ variant, waitMs: 60_000 }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? 'Install failed');
}
