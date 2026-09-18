import type { ExportedPuzzle, PuzzleStat } from './types';

const STORAGE_KEY = 'chesstrainer.stats.v1';

const EMPTY: PuzzleStat = {
  attempts: 0, solves: 0, hints: 0, solutionsShown: 0,
  streak: 0, lastSeen: null, lastResult: null,
};

/**
 * Stats live in the visitor's own browser, keyed by position rather than by
 * database id. That keeps a rebuilt or re-exported puzzle set from wiping
 * anyone's history, and means everyone who tries the published trainer keeps
 * their own record without a server.
 */
export function puzzleKey(p: Pick<ExportedPuzzle, 'fen' | 'solutionUci'>): string {
  let hash = 5381;
  const input = `${p.fen}|${p.solutionUci}`;
  for (let i = 0; i < input.length; i++) hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

type StatMap = Record<string, PuzzleStat>;

export function loadStats(): StatMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as StatMap) : {};
  } catch {
    return {};
  }
}

function persist(stats: StatMap) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
  } catch {
    /* private mode or a full quota: stats are a nice-to-have, never fatal */
  }
}

export const statFor = (stats: StatMap, puzzle: ExportedPuzzle): PuzzleStat =>
  stats[puzzleKey(puzzle)] ?? EMPTY;

export interface AttemptOutcome {
  solved: boolean;
  usedHint: boolean;
  usedSolution: boolean;
}

export function recordAttempt(
  stats: StatMap,
  puzzle: ExportedPuzzle,
  outcome: AttemptOutcome
): StatMap {
  const key = puzzleKey(puzzle);
  const prev = stats[key] ?? EMPTY;
  const next: StatMap = {
    ...stats,
    [key]: {
      attempts: prev.attempts + 1,
      solves: prev.solves + (outcome.solved ? 1 : 0),
      hints: prev.hints + (outcome.usedHint ? 1 : 0),
      solutionsShown: prev.solutionsShown + (outcome.usedSolution ? 1 : 0),
      streak: outcome.solved ? prev.streak + 1 : 0,
      lastSeen: new Date().toISOString(),
      lastResult: outcome.solved ? 'solved' : 'failed',
    },
  };
  persist(next);
  return next;
}

export function resetStats(): StatMap {
  persist({});
  return {};
}

export function exportStats(stats: StatMap): string {
  return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), stats }, null, 2);
}

export function importStats(json: string): StatMap {
  const parsed = JSON.parse(json) as { stats?: StatMap };
  const stats = parsed.stats ?? (parsed as unknown as StatMap);
  persist(stats);
  return stats;
}

export interface Totals {
  puzzles: number;
  seen: number;
  attempts: number;
  solves: number;
  accuracy: number;
  unseen: number;
}

export function totals(stats: StatMap, puzzles: ExportedPuzzle[]): Totals {
  let attempts = 0;
  let solves = 0;
  let seen = 0;
  for (const p of puzzles) {
    const s = stats[puzzleKey(p)];
    if (!s) continue;
    seen += 1;
    attempts += s.attempts;
    solves += s.solves;
  }
  return {
    puzzles: puzzles.length,
    seen,
    attempts,
    solves,
    accuracy: attempts ? (solves / attempts) * 100 : 0,
    unseen: puzzles.length - seen,
  };
}
