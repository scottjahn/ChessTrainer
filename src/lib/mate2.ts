import { Chess, type Move } from 'chess.js';

/** A move as the calendar drill needs it. */
export interface MateMove {
  uci: string;
  san: string;
  from: string;
  to: string;
}

/** One black defence to a key move, and every white move that mates after it. */
export interface MateLine {
  reply: MateMove;
  mates: MateMove[];
}

export interface MateKey extends MateMove {
  lines: MateLine[];
}

export interface Mate2Solution {
  /** Moves that mate at once: a calendar position should not have any. */
  mateInOne: MateMove[];
  /** Moves that force mate on the next move, whatever the reply. */
  keys: MateKey[];
}

const toMove = (m: Move): MateMove => ({
  uci: `${m.from}${m.to}${m.promotion ?? ''}`,
  san: m.san,
  from: m.from,
  to: m.to,
});

const matesFrom = (chess: Chess) =>
  chess.moves({ verbose: true }).filter((m) => m.san.endsWith('#')).map(toMove);

/**
 * Brute force, with an early exit on each move as soon as a reply escapes. The
 * answer is worked out rather than stored, so a transcribed position only has
 * to get the pieces right, and every sound first move counts.
 */
export function solveMate2(fen: string): Mate2Solution {
  const chess = new Chess(fen);
  const solution: Mate2Solution = { mateInOne: [], keys: [] };

  for (const first of chess.moves({ verbose: true })) {
    chess.move(first);
    if (chess.isCheckmate()) {
      solution.mateInOne.push(toMove(first));
    } else {
      const replies = chess.moves({ verbose: true });
      const lines: MateLine[] = [];
      for (const reply of replies) {
        chess.move(reply);
        const mates = matesFrom(chess);
        chess.undo();
        if (!mates.length) break;
        lines.push({ reply: toMove(reply), mates });
      }
      // No replies at all is stalemate, which is no mate.
      if (replies.length && lines.length === replies.length) {
        solution.keys.push({ ...toMove(first), lines });
      }
    }
    chess.undo();
  }
  return solution;
}

/** A black reply that leaves white without a mate, to explain a refused move. */
export function findEscape(fen: string, uci: string): string | null {
  const chess = new Chess(fen);
  chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  for (const reply of chess.moves({ verbose: true })) {
    chess.move(reply);
    const mated = matesFrom(chess).length > 0;
    chess.undo();
    if (!mated) return reply.san;
  }
  return null;
}

/** The defence with the fewest mates against it; ties go at random, for replays. */
export function toughestReply(key: MateKey): MateLine {
  const fewest = Math.min(...key.lines.map((l) => l.mates.length));
  const toughest = key.lines.filter((l) => l.mates.length === fewest);
  return toughest[Math.floor(Math.random() * toughest.length)];
}
