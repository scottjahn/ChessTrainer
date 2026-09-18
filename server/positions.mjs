import { Chess } from 'chess.js';

export const toUci = (m) => `${m.from}${m.to}${m.promotion ?? ''}`;

/**
 * Replay a PGN into one record per ply plus the final position.
 * `fenBefore` is the position the mover faced, which is exactly the puzzle FEN
 * when that move turns out to be a mistake.
 */
export function gamePositions(pgn) {
  const chess = new Chess();
  chess.loadPgn(pgn, { strict: false });
  const moves = chess.history({ verbose: true });

  const replay = new Chess();
  const plies = moves.map((m, i) => {
    const fenBefore = replay.fen();
    replay.move(m.san);
    return {
      ply: i,
      moveNumber: Math.floor(i / 2) + 1,
      color: m.color,
      san: m.san,
      uci: toUci(m),
      from: m.from,
      to: m.to,
      piece: m.piece,
      captured: m.captured ?? null,
      fenBefore,
      fenAfter: replay.fen(),
    };
  });

  return { plies, finalFen: replay.fen(), plyCount: plies.length };
}

/** SAN for a UCI move in a given position, or null if the move is illegal there. */
export function uciToSan(fen, uci) {
  try {
    const chess = new Chess(fen);
    const move = chess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
    return move?.san ?? null;
  } catch {
    return null;
  }
}
