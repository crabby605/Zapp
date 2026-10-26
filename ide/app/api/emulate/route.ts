import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const run = promisify(execFile);

// Runs compiled bytecode on the native emulator (emulator/zapp-emu), building it
// on first use. Same VM as the firmware, so the trace matches the board.
export async function POST(request: Request) {
  const { payload, gpio = [], noRadio = false, display = 'ssd1306' } = await request.json();
  // A board holds at most a few KB of bytecode; this keeps the public site from running anything bigger.
  if (typeof payload !== 'string' || !payload.startsWith('BC:') || payload.length > 128 * 1024) {
    return NextResponse.json({ error: 'Expected a BC: payload' }, { status: 400 });
  }

  const emulatorDir = path.join(process.cwd(), '../emulator');
  const binary = path.join(emulatorDir, 'zapp-emu');

  // Run configuration from the Run panel: preset input pins, fake a radio-less
  // board. --fb makes the display readable by the Display panel. Bus chatter is
  // left in — the Run panel has per-subsystem filters.
  const args = ['--fb'];
  if (noRadio) args.push('--no-radio');
  if (['ssd1306', 'ssd1306_32', 'sh1106', 'none'].includes(display)) args.push('--display', display);
  for (const preset of Array.isArray(gpio) ? gpio : []) {
    if (/^\d{1,2}=[01]$/.test(String(preset))) args.push('--gpio', String(preset));
  }

  try {
    if (!fs.existsSync(binary)) {
      await run('make', ['-C', emulatorDir], { timeout: 60_000 });
    }
    const started = Date.now();
    const { stdout, stderr } = await run(binary, [...args, payload], {
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    return NextResponse.json({
      output: stdout,
      summary: stderr.trim() || 'done',
      bytes: (payload.length - 3) / 2,
      wallMs: Date.now() - started,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'emulator failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
