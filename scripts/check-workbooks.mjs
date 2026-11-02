// Checks public/data/workbooks.json after transcribing a workbook page. Each puzzle
// should have one clear best move, so a stored answer the engine ranks well down,
// or no clear winner, usually means a misread piece.
//
// The book's answer stays the solution, but any move Stockfish rates at least as
// highly is accepted too. Run with --write to store those as `alternatives`.
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Chess } from 'chess.js';

const DEPTH = 16;
// How far ahead of the next move the answer should be, in centipawns.
const CLEAR_MARGIN = 100;
const MATE = 100000;

const write = process.argv.includes('--write');
const file = process.argv.slice(2).find((a) => a !== '--write')
  ?? fileURLToPath(new URL('../public/data/workbooks.json', import.meta.url));
const pack = JSON.parse(readFileSync(file, 'utf8'));
const { puzzles } = pack;

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

/** A score for every legal move, best first. A sooner mate scores higher. */
async function rankMoves(fen) {
  send('ucinewgame');
  send('isready');
  await until('readyok');
  const scores = new Map();
  const done = until('bestmove', (line) => {
    if (line.includes('bound')) return;
    const m = line.match(/ score (cp|mate) (-?\d+).* pv (\S+)/);
    if (!m) return;
    const n = Number(m[2]);
    scores.set(m[3], m[1] === 'cp' ? n : n > 0 ? MATE - n : -MATE - n);
  });
  send(`position fen ${fen}`);
  send(`go depth ${DEPTH}`);
  await done;
  return [...scores].map(([uci, score]) => ({ uci, score })).sort((a, b) => b.score - a.score);
}

send('uci');
await until('uciok');
send('setoption name MultiPV value 256');

let errors = 0;
let warnings = 0;
const seen = new Set();

for (const puzzle of puzzles) {
  const { id, book, theme, type, page, number, fen, solution, alternatives = [], bookAlternatives = [] } = puzzle;
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

    const ranked = await rankMoves(fen);
    const bookScore = ranked.find((m) => m.uci === solution[0])?.score;
    if (bookScore === undefined) throw new Error(`engine did not rank ${solution[0]}`);
    const fromBook = [solution[0], ...bookAlternatives];
    const asGood = ranked.filter((m) => !fromBook.includes(m.uci) && m.score >= bookScore).map((m) => m.uci);

    if (write) {
      if (asGood.length) puzzle.alternatives = asGood;
      else delete puzzle.alternatives;
    } else {
      const missing = asGood.filter((uci) => !alternatives.includes(uci));
      if (missing.length) problems.push(`engine rates these at least as highly: ${missing.join(' ')}`);
    }
    if (asGood.length) notes.push(`also accepted: ${asGood.join(' ')}`);
    const next = ranked.find((m) => !fromBook.includes(m.uci) && !asGood.includes(m.uci));
    if (!asGood.length && next && bookScore - next.score < CLEAR_MARGIN) {
      notes.push(`no clear best: ${next.uci} is within ${bookScore - next.score}`);
    }
  } catch (e) {
    problems.push(`bad FEN or line: ${e.message}`);
  }

  errors += problems.length;
  warnings += notes.length;
  const status = problems.length ? 'FAIL' : notes.length ? 'WARN' : 'ok  ';
  console.log(`${status} ${id}  ${answer}${[...problems, ...notes].map((p) => `\n     ${p}`).join('')}`);
}

engine.kill();

if (write && !errors) {
  const pad = (p) => JSON.stringify(p).replace(/":/g, '": ').replace(/,"/g, ', "').replace(/^\{/, '{ ').replace(/\}$/, ' }');
  writeFileSync(file, `{\n  "version": ${pack.version},\n  "puzzles": [\n${puzzles.map((p) => `    ${pad(p)}`).join(',\n')}\n  ]\n}\n`);
}

console.log(`\n${puzzles.length} puzzles, ${errors} errors, ${warnings} warnings`);
process.exit(errors ? 1 : 0);
