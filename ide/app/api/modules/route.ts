import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
export async function GET() {
  const modulesDir = path.join(process.cwd(), '../modules');
  if (!fs.existsSync(modulesDir)) {
    return NextResponse.json({ error: 'Modules directory not found' }, { status: 404 });
  }
  const files = fs.readdirSync(modulesDir).filter(f => f.endsWith('.zappmod'));
  const payload: Record<string, string> = {};
  for (const file of files) {
    const name = file.replace('.zappmod', '');
    const content = fs.readFileSync(path.join(modulesDir, file), 'utf-8');
    payload[name] = content;
  }
  return NextResponse.json(payload);
}
