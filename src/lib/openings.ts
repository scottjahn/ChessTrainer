import { Chess } from 'chess.js';
import { START_FEN, moveLabel, playLine } from './chessutil';
import { weightFor } from './puzzles';
import { puzzleKey, type StatRef } from './stats';
import type { Classification, Color, PuzzleStat } from './types';

/** The labels worth a second look when they land on a move of an opening line. */
export const QUESTIONABLE: Classification[] = ['inaccuracy', 'mistake', 'miss', 'blunder'];

interface HasMoves {
  moves: string[];
}

/** Whether the trained side is the one to play ply `ply` (0 is White's first move). */
export const isYourPly = (color: Color, ply: number): boolean => (ply % 2 === 0) === (color === 'w');

export const startsWith = (moves: string[], prefix: string[]): boolean =>
  prefix.length <= moves.length && prefix.every((m, i) => moves[i] === m);

/**
 * Line stats share the puzzle store, keyed by the moves rather than a database
 * id — so a re-export keeps them, and a reworded line starts afresh.
 */
export const lineRef = (color: Color, line: HasMoves): StatRef => ({
  fen: `opening:${color}`,
  solutionUci: line.moves.join(' '),
});

/**
 * The lines to drill. One that is only the start of a longer line is left out:
 * playing the longer one covers it.
 */
export function leafLines<T extends HasMoves>(lines: T[]): T[] {
  return lines.filter(
    (l) => !lines.some((o) => o !== l && o.moves.length > l.moves.length && startsWith(o.moves, l.moves))
  );
}

/** Weighted like the puzzle queue: unseen lines first, then the ones that keep going wrong. */
export function pickLine<T extends HasMoves>(
  lines: T[],
  color: Color,
  stats: Record<string, PuzzleStat>,
  exclude?: T | null
): T | null {
  const pool = lines.length > 1 && exclude ? lines.filter((l) => l !== exclude) : lines;
  if (!pool.length) return null;
  const weights = pool.map((l) => weightFor(stats[puzzleKey(lineRef(color, l))]));
  let roll = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

/** A line as numbered movetext: "1. e4 e5 2. Nf3". */
export function lineSan(moves: string[]): string {
  return playLine(START_FEN, moves)
    .map((s, i) => (i % 2 === 0 ? `${moveLabel(i)} ${s.san}` : s.san))
    .join(' ');
}

/**
 * Read typed or pasted moves — "1. e4 e5 2. Nf3", with or without the numbers —
 * into UCI. Stops at the first move that cannot be played and says which.
 */
export function parseMoveText(text: string): { moves: string[]; error: string | null } {
  const tokens = text
    .replace(/\{[^}]*\}|\([^)]*\)|\$\d+/g, ' ')
    .replace(/\d+(\.+|…)/g, ' ')
    .split(/\s+/)
    .filter((t) => t && !/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t));

  const chess = new Chess();
  const moves: string[] = [];
  for (const token of tokens) {
    const san = token.replace(/[!?]+$/, '').replaceAll('0', 'O');
    try {
      const move = chess.move(san);
      moves.push(`${move.from}${move.to}${move.promotion ?? ''}`);
    } catch {
      return { moves, error: `"${token}" cannot be played as ${moveLabel(moves.length)}` };
    }
  }
  return { moves, error: null };
}
