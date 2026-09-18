import type { ExportedPuzzle, PuzzlePack, PuzzleStat } from './types';
import { puzzleKey } from './stats';

const EMPTY_PACK: PuzzlePack = {
  version: 1,
  exportedAt: new Date(0).toISOString(),
  counts: { puzzles: 0, games: 0 },
  games: {},
  puzzles: [],
};

/**
 * Prefer the live API so the trainer reflects admin edits immediately; fall back
 * to the exported file, which is all that exists on the published site.
 */
export async function loadPack(preferApi: boolean): Promise<{ pack: PuzzlePack; source: 'api' | 'file' }> {
  if (preferApi) {
    try {
      const res = await fetch('/api/puzzles');
      if (res.ok) return { pack: (await res.json()) as PuzzlePack, source: 'api' };
    } catch {
      /* fall through to the static file */
    }
  }
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/puzzles.json`, { cache: 'no-cache' });
    if (res.ok) return { pack: (await res.json()) as PuzzlePack, source: 'file' };
  } catch {
    /* no export yet */
  }
  return { pack: EMPTY_PACK, source: 'file' };
}

export interface PuzzleFilters {
  classifications: string[];
  gameIds: number[] | null;
  color: 'all' | 'w' | 'b';
  onlyUnsolved: boolean;
}

export const DEFAULT_FILTERS: PuzzleFilters = {
  classifications: ['mistake', 'miss', 'blunder'],
  gameIds: null,
  color: 'all',
  onlyUnsolved: false,
};

export function applyFilters(
  puzzles: ExportedPuzzle[],
  filters: PuzzleFilters,
  stats: Record<string, PuzzleStat>
): ExportedPuzzle[] {
  return puzzles.filter((p) => {
    if (filters.classifications.length && !filters.classifications.includes(p.classification)) return false;
    if (filters.gameIds && !filters.gameIds.includes(p.gameId)) return false;
    if (filters.color !== 'all' && p.sideToMove !== filters.color) return false;
    if (filters.onlyUnsolved) {
      const s = stats[puzzleKey(p)];
      if (s && s.solves > 0) return false;
    }
    return true;
  });
}

/**
 * Weighted pick, so the queue drifts toward the positions that keep catching
 * you out: never-seen puzzles come up most, then ones you get wrong, and a
 * puzzle you have solved several times in a row barely shows up at all.
 */
export function pickPuzzle(
  puzzles: ExportedPuzzle[],
  stats: Record<string, PuzzleStat>,
  exclude?: number,
  mode: 'weighted' | 'random' = 'weighted'
): ExportedPuzzle | null {
  const pool = puzzles.length > 1 && exclude != null
    ? puzzles.filter((p) => p.id !== exclude)
    : puzzles;
  if (!pool.length) return null;

  if (mode === 'random') return pool[Math.floor(Math.random() * pool.length)];

  const weights = pool.map((p) => weightFor(stats[puzzleKey(p)]));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

function weightFor(stat: PuzzleStat | undefined): number {
  if (!stat || stat.attempts === 0) return 12;
  const solveRate = stat.solves / stat.attempts;
  const base = 1 + 9 * (1 - solveRate);
  // Each consecutive solve halves how often it reappears, down to a floor.
  return Math.max(0.35, base / 2 ** Math.min(stat.streak, 4));
}
