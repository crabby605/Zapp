import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { parseBoardFile } from '../../../../compiler/src/board';

// Board definitions (boards/*.zappboard) drive pin completion, the Pins panel
// and pin names in programs: which GPIOs exist, what each is wired to, and
// which ones are the board's LEDs, NeoPixels and buttons.
export async function GET() {
  const dir = path.join(process.cwd(), '../boards');
  if (!fs.existsSync(dir)) return NextResponse.json({ boards: [] });

  const boards = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.zappboard'))
    .map((file) => {
      const board = parseBoardFile(fs.readFileSync(path.join(dir, file), 'utf-8'));
      board.name ||= file.replace('.zappboard', '');
      return board;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return NextResponse.json({ boards });
}
