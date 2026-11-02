// Checks public/data/workbooks.json after transcribing a workbook page. Each puzzle
// should have one clear best move, so an engine that disagrees with the stored
// answer, or sees no clear winner, usually means a misread piece.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const DEPTH = 16;
// How far ahead of the next move the answer should be, in centipawns.
const CLEAR_MARGIN = 100;

const file = process.argv[2] ?? new URL('../public/data/workbooks.json', import.meta.url);
const { puzzles } = JSON.parse(readFileSync(file, 'utf8'));

const engine = spawn('node', [
  fileURLToPath(new URL('../node_modules/stockfish/bin/stockfish-19-lite-single.js', import.meta.url)),
]);
let listener = () => {};
let pending = '';
engine.stdout.on('data', (chunk) => {
  pending += chunk;
  const lines = pending.split('\n');
  pending = lines.pop();
  for (const line of lines) listener(line.trim());
});
const send = (command) => engine.stdin.write(`${command}\n`);
const until = (prefix, onLine = () => {}) =>
  new Promise((resolve) => {
    listener = (line) => {
      onLine(line);
      if (line.startsWith(prefix)) resolve();
    };
  });

/** The two best first moves, best first, with scores in centipawns. */
async function topMoves(fen) {
  const found = [];
  const done = until('bestmove', (line) => {
    const m = line.match(/ multipv (\d) score (cp|mate) (-?\d+).* pv (\S+)/);
    if (!m) return;
    const score = m[2] === 'cp' ? Number(m[3]) : Math.sign(Number(m[3])) * 100000;
    found[Number(m[1]) - 1] = { uci: m[4], score };
  });
  send(`position fen ${fen}`);
  send(`go depth ${DEPTH}`);
  await done;
  return found;
}

send('uci');
await until('uciok');
send('setoption name MultiPV value 2');
send('isready');
await until('readyok');

let errors = 0;
let warnings = 0;
const seen = new Set();

for (const { id, book, theme, type, page, number, fen, solution, alternatives = [], engineDisagrees } of puzzles) {
  const problems = [];
  const notes = [];
  let answer = '';

  if (seen.has(id)) problems.push('duplicate id');
  seen.add(id);
  if (!book || !theme || !type || !page || !number) problems.push('missing book, theme, type, page or number');
  if (!solution?.length) problems.push('no solution');

  try {
    const chess = new Chess(fen);
    // The side that just moved cannot have left its own king in check.
    const flipped = fen.split(' ');
    flipped[1] = flipped[1] === 'w' ? 'b' : 'w';
    if (new Chess(flipped.join(' ')).isCheck()) problems.push('the side not to move is in check');

    const sans = [];
    for (const uci of solution ?? []) {
      const move = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      sans.push(move.san);
    }
    answer = sans.join(' ');

    const [best, second] = await topMoves(fen);
    const accepted = [solution[0], ...alternatives];
    if (!accepted.includes(best.uci)) {
      (engineDisagrees ? notes : problems).push(`engine prefers ${best.uci} (${best.score})`);
    } else if (second && !accepted.includes(second.uci) && best.score - second.score < CLEAR_MARGIN) {
      notes.push(`no clear best: ${second.uci} is within ${best.score - second.score}`);
    }
  } catch (e) {
    problems.push(`bad FEN or line: ${e.message}`);
  }

  errors += problems.length;
  warnings += notes.length;
  const status = problems.length ? 'FAIL' : notes.length ? 'WARN' : 'ok  ';
  console.log(`${status} ${id}  ${answer}${[...problems, ...notes].map((p) => `\n     ${p}: ${fen}`).join('')}`);
}

engine.kill();
console.log(`\n${puzzles.length} puzzles, ${errors} errors, ${warnings} warnings`);
process.exit(errors ? 1 : 0);
