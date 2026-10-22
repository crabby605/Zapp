import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { copyUf2, firmwarePath, waitForUf2Drive, type FirmwareVariant } from '../../../../compiler/src/nodeInstall';

// Install Zapp on a board in bootloader mode: wait for its RPI-RP2 drive to
// mount on this machine, then copy the firmware on. The IDE server runs on the
// same computer the board is plugged into, so it can do what you'd do by hand.
export async function POST(request: Request) {
  const { variant = 'core', waitMs = 60_000 } = await request.json().catch(() => ({}));
  const v: FirmwareVariant = variant === 'pico_w' ? 'pico_w' : 'core';
  const uf2 = firmwarePath(path.join(process.cwd(), '..'), v);
  if (!fs.existsSync(uf2)) {
    return NextResponse.json({ error: `No firmware built for ${v} yet — run make in ${path.dirname(uf2)}` }, { status: 404 });
  }

  const drive = await waitForUf2Drive(Math.min(Number(waitMs) || 0, 120_000));
  if (!drive) {
    return NextResponse.json({ error: 'No RPI-RP2 drive showed up — put the board in install mode and try again' }, { status: 408 });
  }
  try {
    await copyUf2(uf2, drive);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'copy failed' }, { status: 500 });
  }
  return NextResponse.json({ drive });
}
