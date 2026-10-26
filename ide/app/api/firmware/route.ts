import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

// The built firmware for the Install dialog: firmware/rp2040/build (plain RP2040)
// or firmware/rp2040/build-picow (Pico W, with the radio stack).
export async function GET(request: Request) {
  const variant = new URL(request.url).searchParams.get('variant') === 'pico_w' ? 'pico_w' : 'core';
  const file = path.join(process.cwd(), '..', 'firmware', 'rp2040', variant === 'pico_w' ? 'build-picow' : 'build', 'zapp.uf2');
  if (!fs.existsSync(file)) {
    return NextResponse.json({ error: `No firmware built for ${variant} yet — run make in ${path.dirname(file)}` }, { status: 404 });
  }
  return new NextResponse(fs.readFileSync(file), {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="zapp-${variant}.uf2"`,
    },
  });
}
