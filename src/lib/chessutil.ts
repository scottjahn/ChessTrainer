import { Chess } from 'chess.js';

/** SAN for a UCI move in a position, or null when the move is not legal there. */
export function uciToSan(fen: string, uci: string | null | undefined): string | null {
  if (!uci || uci.length < 4) return null;
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

/** Turn an engine PV into readable SAN, stopping at the first illegal move. */
export function pvToSan(fen: string, pv: string[], limit = 6): string[] {
  const out: string[] = [];
  try {
    const chess = new Chess(fen);
    for (const uci of pv.slice(0, limit)) {
      const move = chess.move({
        from: uci.slice(0, 2),
        to: uci.slice(2, 4),
        promotion: uci.length > 4 ? uci[4] : undefined,
      });
      if (!move) break;
      out.push(move.san);
    }
  } catch {
    /* partial line is fine */
  }
  return out;
}

export const moveLabel = (ply: number): string =>
  `${Math.floor(ply / 2) + 1}${ply % 2 === 0 ? '.' : '…'}`;
