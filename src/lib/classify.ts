import type { Classification, Score, Thresholds } from './types';

export const DEFAULT_THRESHOLDS: Thresholds = { inaccuracy: 5, mistake: 10, blunder: 20 };

/**
 * Convert an engine score into an expected-score percentage.
 *
 * Centipawns are a terrible yardstick for "how bad was that?" — dropping 200cp
 * from +50 loses roughly half the game, while dropping 200cp from +900 loses
 * almost nothing. chess.com and Lichess both classify on win probability
 * instead, so we use the standard logistic mapping.
 */
export function winPercent(score: Score | null | undefined): number {
  if (!score) return 50;
  if (score.type === 'mate') return score.value > 0 ? 100 : 0;
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * score.value)) - 1);
}

export const negate = (score: Score | null): Score | null =>
  score ? { type: score.type, value: -score.value } as Score : null;

export const isWinning = (score: Score | null): boolean =>
  !!score && (score.type === 'mate' ? score.value > 0 : score.value >= 300);

/**
 * Always renders White-relative, the way every chess UI does. Engine scores are
 * side-to-move relative, so pass whether White was the one to move.
 */
export function formatScore(score: Score | null | undefined, whiteToMove = true): string {
  if (!score) return '–';
  const value = whiteToMove ? score.value : -score.value;
  if (score.type === 'mate') return value === 0 ? '#' : `M${Math.abs(value)}${value < 0 ? '' : ''}`;
  const pawns = value / 100;
  return `${pawns > 0 ? '+' : ''}${pawns.toFixed(2)}`;
}

interface ClassifyInput {
  evalBefore: Score | null;
  evalAfter: Score | null;
  playedUci: string | null;
  bestUci: string | null;
  isBook?: boolean;
  thresholds?: Thresholds;
}

/**
 * Reproduce chess.com's move labels closely enough to train against.
 *
 * "Miss" is their own category and has no public definition, so it is
 * approximated as: you had a decisive advantage available, you gave most of it
 * away, but you did not actually end up worse. Everything else falls out of how
 * much win probability the move cost.
 */
export function classifyMove({
  evalBefore,
  evalAfter,
  playedUci,
  bestUci,
  isBook = false,
  thresholds = DEFAULT_THRESHOLDS,
}: ClassifyInput): { classification: Classification; wpLoss: number } {
  const before = winPercent(evalBefore);
  const after = winPercent(evalAfter);
  const wpLoss = Math.max(0, before - after);

  if (playedUci && bestUci && playedUci === bestUci) return { classification: 'best', wpLoss: 0 };
  if (isBook) return { classification: 'book', wpLoss };

  const stillFine = !evalAfter || (evalAfter.type === 'mate' ? evalAfter.value > 0 : evalAfter.value > -100);
  if (isWinning(evalBefore) && !isWinning(evalAfter) && stillFine && wpLoss >= thresholds.mistake) {
    return { classification: 'miss', wpLoss };
  }

  if (wpLoss >= thresholds.blunder) return { classification: 'blunder', wpLoss };
  if (wpLoss >= thresholds.mistake) return { classification: 'mistake', wpLoss };
  if (wpLoss >= thresholds.inaccuracy) return { classification: 'inaccuracy', wpLoss };
  if (wpLoss >= 2) return { classification: 'good', wpLoss };
  return { classification: 'excellent', wpLoss };
}

export const CLASSIFICATION_META: Record<Classification, { label: string; color: string; icon: string }> = {
  best: { label: 'Best', color: 'var(--c-best)', icon: '★' },
  excellent: { label: 'Excellent', color: 'var(--c-best)', icon: '✓' },
  good: { label: 'Good', color: 'var(--c-good)', icon: '✓' },
  book: { label: 'Book', color: 'var(--c-book)', icon: '📖' },
  inaccuracy: { label: 'Inaccuracy', color: 'var(--c-inaccuracy)', icon: '?!' },
  mistake: { label: 'Mistake', color: 'var(--c-mistake)', icon: '?' },
  miss: { label: 'Miss', color: 'var(--c-miss)', icon: '✗' },
  blunder: { label: 'Blunder', color: 'var(--c-blunder)', icon: '??' },
};
