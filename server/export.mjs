import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const EXPORT_PATH = join(root, 'public', 'data', 'puzzles.json');

/**
 * Freeze the puzzle set into a static file. This is the only thing the public
 * trainer needs: the SQLite database and the admin API never leave this machine.
 */
export async function writePuzzleExport(payload) {
  await mkdir(dirname(EXPORT_PATH), { recursive: true });
  const json = JSON.stringify(payload, null, 2);
  await writeFile(EXPORT_PATH, json, 'utf8');
  return {
    ok: true,
    path: relative(root, EXPORT_PATH).replaceAll('\\', '/'),
    bytes: Buffer.byteLength(json),
    counts: payload.counts,
    exportedAt: payload.exportedAt,
  };
}

// `npm run export` runs this file directly.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('export.mjs')) {
  const { buildPuzzlePayload } = await import('./payload.mjs');
  const result = await writePuzzleExport(buildPuzzlePayload());
  console.log(
    `exported ${result.counts.puzzles} puzzles from ${result.counts.games} games ` +
    `-> ${result.path} (${(result.bytes / 1024).toFixed(1)} kB)`
  );
}
