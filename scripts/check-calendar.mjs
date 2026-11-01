// Checks public/data/calendar.json after transcribing a calendar page. A misread
// piece nearly always breaks the mate, so this is what catches a bad reading.
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { solveMate2 } from '../src/lib/mate2.ts';

const file = process.argv[2] ?? new URL('../public/data/calendar.json', import.meta.url);
const { puzzles } = JSON.parse(readFileSync(file, 'utf8'));

let errors = 0;
let warnings = 0;
const seen = new Set();

for (const { date, fen } of puzzles) {
  const problems = [];
  const notes = [];

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) problems.push('date is not YYYY-MM-DD');
  if (seen.has(date)) problems.push('duplicate date');
  seen.add(date);

  let keys = '';
  try {
    if (fen.split(' ')[1] !== 'w') problems.push('not white to move');
    // White to move with black already in check cannot arise in a game.
    if (new Chess(fen.replace(' w ', ' b ')).isCheck()) problems.push('black is in check');

    const { mateInOne, keys: found } = solveMate2(fen);
    if (mateInOne.length) problems.push(`mate in 1: ${mateInOne.map((m) => m.san).join(', ')}`);
    if (!found.length && !mateInOne.length) problems.push('no forced mate in 2');
    if (found.length > 1) notes.push('more than one key, worth comparing against the photo');
    keys = found.map((k) => k.san).join(', ');
  } catch (e) {
    problems.push(`bad FEN: ${e.message}`);
  }

  errors += problems.length;
  warnings += notes.length;
  const status = problems.length ? 'FAIL' : notes.length ? 'WARN' : 'ok  ';
  console.log(`${status} ${date}  ${keys}${[...problems, ...notes].map((p) => `\n     ${p}: ${fen}`).join('')}`);
}

console.log(`\n${puzzles.length} puzzles, ${errors} errors, ${warnings} warnings`);
process.exit(errors ? 1 : 0);
