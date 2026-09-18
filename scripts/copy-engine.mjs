import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'stockfish', 'bin');
const dest = join(root, 'engine');

/**
 * Only the "lite" builds are copied: ~1.7 MB each versus 95 MB for the full
 * NNUE net, and plenty strong for spotting a blunder. The engine lives outside
 * public/ on purpose, so it is served only by the local API and never ends up
 * in the static bundle that goes to GitHub Pages.
 */
const WANTED = [
  'stockfish-19-lite.js',          // multi-threaded, needs cross-origin isolation
  'stockfish-19-lite.wasm',
  'stockfish-19-lite-single.js',   // single-threaded fallback, works anywhere
  'stockfish-19-lite-single.wasm',
];

await mkdir(dest, { recursive: true });

const available = new Set(await readdir(src));
const missing = WANTED.filter((f) => !available.has(f));
if (missing.length) {
  // Never fail the install over this: only the local admin needs an engine, and
  // it reports a clear error of its own if the files are not there.
  console.warn(`stockfish package is missing: ${missing.join(', ')}`);
  console.warn('Engine analysis will not work. Try: npm install stockfish --force');
  process.exit(0);
}

let total = 0;
for (const file of WANTED) {
  await cp(join(src, file), join(dest, file));
  total += (await stat(join(dest, file))).size;
}
console.log(`copied ${WANTED.length} engine files -> engine/ (${(total / 1024 / 1024).toFixed(1)} MB)`);
