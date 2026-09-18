import { useCallback, useEffect, useMemo, useState } from 'react';
import { Chessboard } from 'react-chessboard';
import { Chess, type Square } from 'chess.js';

export interface BoardProps {
  fen: string;
  orientation?: 'white' | 'black';
  /** Return true to accept the move. Omit to make the board read-only. */
  onMove?: (from: string, to: string, promotion?: string) => boolean;
  /** Squares painted underneath the pieces, e.g. the last move or a hint. */
  highlights?: Record<string, React.CSSProperties>;
  arrows?: { startSquare: string; endSquare: string; color: string }[];
  lastMove?: { from: string; to: string } | null;
  animate?: boolean;
}

const HINT_DOT: React.CSSProperties = {
  background: 'radial-gradient(circle, rgba(20,20,20,.28) 22%, transparent 24%)',
};
const HINT_CAPTURE: React.CSSProperties = {
  background: 'radial-gradient(circle, transparent 54%, rgba(20,20,20,.28) 56%)',
};
const SELECTED: React.CSSProperties = { background: 'rgba(255, 213, 79, .55)' };
const LAST_MOVE: React.CSSProperties = { background: 'rgba(155, 199, 0, .38)' };

export function Board({
  fen,
  orientation = 'white',
  onMove,
  highlights,
  arrows,
  lastMove,
  animate = true,
}: BoardProps) {
  const [selected, setSelected] = useState<string | null>(null);
  const [promotion, setPromotion] = useState<{ from: string; to: string } | null>(null);

  // A new position always cancels any half-finished interaction.
  useEffect(() => {
    setSelected(null);
    setPromotion(null);
  }, [fen]);

  const chess = useMemo(() => {
    try {
      return new Chess(fen);
    } catch {
      return null;
    }
  }, [fen]);

  const legalFrom = useCallback(
    (square: string) => {
      if (!chess) return [];
      try {
        return chess.moves({ square: square as Square, verbose: true });
      } catch {
        return [];
      }
    },
    [chess]
  );

  const needsPromotion = useCallback(
    (from: string, to: string) => legalFrom(from).some((m) => m.to === to && m.promotion),
    [legalFrom]
  );

  const attempt = useCallback(
    (from: string, to: string) => {
      if (!onMove) return false;
      if (needsPromotion(from, to)) {
        setPromotion({ from, to });
        setSelected(null);
        return true;
      }
      const ok = onMove(from, to);
      setSelected(null);
      return ok;
    },
    [onMove, needsPromotion]
  );

  const squareStyles = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};
    if (lastMove) {
      styles[lastMove.from] = { ...LAST_MOVE };
      styles[lastMove.to] = { ...LAST_MOVE };
    }
    if (selected) {
      styles[selected] = { ...(styles[selected] ?? {}), ...SELECTED };
      for (const move of legalFrom(selected)) {
        styles[move.to] = {
          ...(styles[move.to] ?? {}),
          ...(move.captured ? HINT_CAPTURE : HINT_DOT),
        };
      }
    }
    return { ...styles, ...(highlights ?? {}) };
  }, [lastMove, selected, legalFrom, highlights]);

  return (
    <div className="board-wrap">
      <Chessboard
        options={{
          position: fen,
          boardOrientation: orientation,
          allowDragging: !!onMove,
          showAnimations: animate,
          animationDurationInMs: 180,
          squareStyles,
          arrows: arrows ?? [],
          allowDrawingArrows: true,
          darkSquareStyle: { backgroundColor: 'var(--sq-dark)' },
          lightSquareStyle: { backgroundColor: 'var(--sq-light)' },
          boardStyle: { borderRadius: '6px', overflow: 'hidden' },
          canDragPiece: ({ square }) => {
            if (!onMove || !chess) return false;
            const piece = chess.get(square as Square);
            return !!piece && piece.color === chess.turn();
          },
          onPieceDrop: ({ sourceSquare, targetSquare }) =>
            targetSquare ? attempt(sourceSquare, targetSquare) : false,
          onSquareClick: ({ square }) => {
            if (!onMove || !chess) return;
            if (selected && square !== selected) {
              if (legalFrom(selected).some((m) => m.to === square)) {
                attempt(selected, square);
                return;
              }
            }
            const piece = chess.get(square as Square);
            setSelected(piece && piece.color === chess.turn() ? square : null);
          },
        }}
      />

      {promotion && (
        <div className="promo-overlay" onClick={() => setPromotion(null)}>
          <div className="promo-card" onClick={(e) => e.stopPropagation()}>
            <span>Promote to</span>
            <div className="promo-row">
              {(['q', 'r', 'b', 'n'] as const).map((p) => (
                <button
                  key={p}
                  className="promo-btn"
                  onClick={() => {
                    onMove?.(promotion.from, promotion.to, p);
                    setPromotion(null);
                  }}
                >
                  {{ q: '♛', r: '♜', b: '♝', n: '♞' }[p]}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
