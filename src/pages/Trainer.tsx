import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { useLocalApi } from '../App';
import { Board } from '../components/Board';
import { ClassPill, GameMeta } from '../components/bits';
import { api } from '../lib/api';
import { formatScore } from '../lib/classify';
import { DEFAULT_FILTERS, applyFilters, loadPack, pickPuzzle, type PuzzleFilters } from '../lib/puzzles';
import { loadStats, recordAttempt, statFor } from '../lib/stats';
import type { ExportedPuzzle, PuzzlePack, PuzzleStat } from '../lib/types';

type Phase = 'waiting' | 'solved' | 'failed' | 'revealed';

/** One position in the little timeline you can step through under the board. */
interface Frame {
  fen: string;
  lastMove: { from: string; to: string } | null;
  label: string;
}

const ALL_CLASSES = ['blunder', 'miss', 'mistake', 'inaccuracy'] as const;

const squares = (uci: string) => ({ from: uci.slice(0, 2), to: uci.slice(2, 4) });

/** Play a UCI move, or give back null — chess.js throws on an illegal one. */
function tryMove(chess: Chess, uci: string) {
  try {
    return chess.move({
      ...squares(uci),
      promotion: uci.length > 4 ? uci[4] : undefined,
    });
  } catch {
    return null;
  }
}

export function Trainer() {
  const local = useLocalApi();
  const [pack, setPack] = useState<PuzzlePack | null>(null);
  const [stats, setStats] = useState(() => loadStats());
  const [filters, setFilters] = useState<PuzzleFilters>(DEFAULT_FILTERS);
  const [puzzle, setPuzzle] = useState<ExportedPuzzle | null>(null);
  const [phase, setPhase] = useState<Phase>('waiting');
  const [wrongMove, setWrongMove] = useState<string | null>(null);
  const [usedHint, setUsedHint] = useState(false);
  const [step, setStep] = useState(0);
  const recorded = useRef(false);
  const replayTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (local === null) return;
    loadPack(local).then(({ pack: p }) => setPack(p));
  }, [local]);

  const pool = useMemo(
    () => (pack ? applyFilters(pack.puzzles, filters, stats) : []),
    [pack, filters, stats]
  );

  const next = useCallback(() => {
    const chosen = pickPuzzle(pool, stats, puzzle?.id);
    setPuzzle(chosen);
    setPhase('waiting');
    setWrongMove(null);
    setUsedHint(false);
    recorded.current = false;
    // Replay the opponent's move into the puzzle position, the way a real
    // puzzle trainer does, so the position arrives with context.
    setStep(0);
    window.clearTimeout(replayTimer.current);
    if (chosen?.fenPrev) {
      replayTimer.current = window.setTimeout(() => setStep(1), 420);
    }
  }, [pool, stats, puzzle?.id]);

  useEffect(() => () => window.clearTimeout(replayTimer.current), []);

  // First puzzle once the pack lands, and whenever filters empty the board.
  useEffect(() => {
    if (pack && !puzzle && pool.length) next();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pack, pool.length]);

  const stat: PuzzleStat | null = puzzle ? statFor(stats, puzzle) : null;
  const game = puzzle && pack ? pack.games[String(puzzle.gameId)] : undefined;
  const done = phase === 'solved' || phase === 'revealed';

  // The board is a small timeline: the position before the opponent's move,
  // the puzzle itself, and — once it is settled — the solution played out.
  const frames = useMemo<Frame[]>(() => {
    if (!puzzle) return [];
    const list: Frame[] = [];

    if (puzzle.fenPrev) {
      list.push({
        fen: puzzle.fenPrev,
        lastMove: null,
        label: puzzle.prevSan ? `Before ${puzzle.prevSan}` : 'Before their move',
      });
    }

    list.push({
      fen: puzzle.fen,
      lastMove: puzzle.prevUci ? squares(puzzle.prevUci) : null,
      label: puzzle.prevSan ? `${puzzle.prevSan} played — your move` : 'Your move',
    });

    if (done) {
      const chess = new Chess(puzzle.fen);
      const move = tryMove(chess, puzzle.solutionUci);
      if (move) {
        list.push({
          fen: chess.fen(),
          lastMove: { from: move.from, to: move.to },
          label: `After ${puzzle.solutionSan}`,
        });
      }
    }

    return list;
  }, [puzzle, done]);

  // Where the puzzle position itself sits, and where we actually are now.
  const puzzleStep = puzzle?.fenPrev ? 1 : 0;
  const index = Math.min(step, Math.max(frames.length - 1, 0));

  // Stepping by hand cancels the opening replay so it cannot yank you forward.
  const goto = useCallback((to: number) => {
    window.clearTimeout(replayTimer.current);
    setStep(to);
  }, []);

  const settle = useCallback(
    (solved: boolean, viaSolution: boolean) => {
      if (recorded.current || !puzzle) return;
      recorded.current = true;
      const outcome = { solved, usedHint, usedSolution: viaSolution };
      setStats((s) => recordAttempt(s, puzzle, outcome));
      if (local) api.recordAttempt(puzzle.id, outcome).catch(() => { /* local mirror only */ });
    },
    [puzzle, usedHint, local]
  );

  const accepts = useCallback(
    (uci: string) => puzzle != null && (uci === puzzle.solutionUci || puzzle.altSolutions.includes(uci)),
    [puzzle]
  );

  const onMove = useCallback(
    (from: string, to: string, promotion?: string) => {
      if (!puzzle || phase === 'solved' || phase === 'revealed') return false;

      const chess = new Chess(puzzle.fen);
      const move = chess.move({ from, to, promotion: promotion ?? 'q' });
      if (!move) return false;

      const uci = `${move.from}${move.to}${move.promotion ?? ''}`;
      if (accepts(uci)) {
        settle(phase !== 'failed', false);
        setPhase('solved');
        setWrongMove(null);
        goto(puzzleStep + 1);
        return true;
      }
      settle(false, false);
      setPhase('failed');
      setWrongMove(move.san);
      return false; // snap the piece back
    },
    [puzzle, phase, accepts, settle, goto, puzzleStep]
  );

  const reveal = useCallback(() => {
    if (!puzzle) return;
    settle(false, true);
    setPhase('revealed');
    goto(puzzleStep + 1);
  }, [puzzle, settle, goto, puzzleStep]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && /input|textarea|select/i.test(e.target.tagName)) return;
      if (e.key === 'n' || e.key === 'Enter') next();
      if (e.key === 'h') setUsedHint(true);
      if (e.key === 's') reveal();
      if (e.key === 'ArrowLeft' && index > 0) {
        e.preventDefault();
        goto(index - 1);
      }
      if (e.key === 'ArrowRight' && index < frames.length - 1) {
        e.preventDefault();
        goto(index + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, reveal, goto, index, frames.length]);

  if (!pack) return <div className="empty"><p className="muted">Loading puzzles…</p></div>;

  if (!pack.puzzles.length) {
    return (
      <div className="empty">
        <h2>No puzzles yet</h2>
        <p>
          {local
            ? 'Open Admin, import a game, and save some mistakes as puzzles.'
            : 'This published set is empty — the owner has not exported any puzzles yet.'}
        </p>
      </div>
    );
  }

  if (!pool.length) {
    return (
      <div className="stack">
        <FilterBar filters={filters} setFilters={setFilters} total={pack.puzzles.length} shown={0} />
        <div className="empty">
          <h2>Nothing matches those filters</h2>
          <p>Widen the selection above to get back to training.</p>
        </div>
      </div>
    );
  }

  if (!puzzle) return <div className="empty"><p className="muted">Picking a puzzle…</p></div>;

  const orientation = puzzle.sideToMove === 'w' ? 'white' : 'black';
  const frame = frames[index];
  const onPuzzleStep = index === puzzleStep;

  const highlights: Record<string, React.CSSProperties> = {};
  if (usedHint && !done && onPuzzleStep) {
    highlights[squares(puzzle.solutionUci).from] = {
      boxShadow: 'inset 0 0 0 4px rgba(247, 198, 49, .85)',
      borderRadius: '4px',
    };
  }

  // The solution arrow only makes sense from the puzzle position onwards —
  // on the earlier frame those squares hold different pieces.
  const arrows = done && index >= puzzleStep
    ? [{
      startSquare: squares(puzzle.solutionUci).from,
      endSquare: squares(puzzle.solutionUci).to,
      color: 'rgba(127,166,80,.9)',
    }]
    : [];

  return (
    <div className="stack">
      <FilterBar filters={filters} setFilters={setFilters} total={pack.puzzles.length} shown={pool.length} />

      <div className="cols">
        <div className="stack">
          <div className="puzzle-prompt">
            <ClassPill value={puzzle.classification} />
            <span>{puzzle.sideToMove === 'w' ? 'White' : 'Black'} to play — find the move you missed.</span>
          </div>

          <Board
            fen={frame.fen}
            orientation={orientation}
            onMove={done || !onPuzzleStep ? undefined : onMove}
            highlights={highlights}
            arrows={arrows}
            lastMove={frame.lastMove}
          />

          <div className="row board-nav">
            <button
              className="icon"
              onClick={() => goto(index - 1)}
              disabled={index === 0}
              title="Previous position (←)"
              aria-label="Previous position"
            >
              ←
            </button>
            <button
              className="icon"
              onClick={() => goto(index + 1)}
              disabled={index >= frames.length - 1}
              title="Next position (→)"
              aria-label="Next position"
            >
              →
            </button>
            <span className="tiny faint">{frame.label}</span>
          </div>

          <div className="verdict">
            {phase === 'solved' && <><span>✓</span><span className="good">Correct — {puzzle.solutionSan}</span></>}
            {phase === 'failed' && <span className="bad">✗ {wrongMove} is not it. Try again.</span>}
            {phase === 'revealed' && <span className="shown">The move was {puzzle.solutionSan}</span>}
            {phase === 'waiting' && usedHint && <span className="muted">Move the highlighted piece.</span>}
          </div>

          <div className="row">
            <button onClick={() => setUsedHint(true)} disabled={usedHint || done}>
              Hint
            </button>
            <button onClick={reveal} disabled={done}>
              Show solution
            </button>
            <div className="spacer" />
            <button className="primary" onClick={next}>
              Next puzzle →
            </button>
          </div>
          <p className="tiny faint">
            Shortcuts: <b>←</b>/<b>→</b> step · <b>H</b> hint · <b>S</b> solution · <b>N</b> next
          </p>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head"><h2>This game</h2></div>
            <GameMeta game={game} side={puzzle.sideToMove} />
          </div>

          <div className="card">
            <div className="card-head"><h2>This puzzle</h2></div>
            <div className="statline">
              <div className="stat">
                <b>{stat?.attempts ?? 0}</b>
                <span>Seen</span>
              </div>
              <div className="stat">
                <b>{stat?.solves ?? 0}</b>
                <span>Solved</span>
              </div>
              <div className="stat">
                <b>{stat?.attempts ? Math.round((stat.solves / stat.attempts) * 100) : 0}%</b>
                <span>Rate</span>
              </div>
              <div className="stat">
                <b>{stat?.streak ?? 0}</b>
                <span>Streak</span>
              </div>
            </div>

            {done && (
              <dl className="meta-grid" style={{ marginTop: 14 }}>
                <dt>You played</dt>
                <dd className="mono">{puzzle.playedSan ?? '—'}</dd>
                <dt>Best</dt>
                <dd className="mono">{puzzle.solutionSan}</dd>
                <dt>Eval</dt>
                <dd className="mono">
                  {formatScore(puzzle.evalBefore, puzzle.sideToMove === 'w')} →{' '}
                  {formatScore(puzzle.evalAfter, puzzle.sideToMove === 'w')}
                  {puzzle.wpLoss != null && (
                    <span className="muted"> ({puzzle.wpLoss.toFixed(0)}% swing)</span>
                  )}
                </dd>
              </dl>
            )}

            {done && puzzle.note && <p className="tiny muted" style={{ marginTop: 12 }}>{puzzle.note}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

function FilterBar({
  filters,
  setFilters,
  total,
  shown,
}: {
  filters: PuzzleFilters;
  setFilters: (f: PuzzleFilters) => void;
  total: number;
  shown: number;
}) {
  const toggle = (value: string) => {
    const has = filters.classifications.includes(value);
    setFilters({
      ...filters,
      classifications: has
        ? filters.classifications.filter((c) => c !== value)
        : [...filters.classifications, value],
    });
  };

  return (
    <div className="card row" style={{ padding: '11px 14px' }}>
      {ALL_CLASSES.map((c) => (
        <label key={c} className="checkbox">
          <input type="checkbox" checked={filters.classifications.includes(c)} onChange={() => toggle(c)} />
          <ClassPill value={c} />
        </label>
      ))}
      <label className="checkbox">
        <input
          type="checkbox"
          checked={filters.onlyUnsolved}
          onChange={(e) => setFilters({ ...filters, onlyUnsolved: e.target.checked })}
        />
        Never solved
      </label>
      <div className="spacer" />
      <span className="tiny faint">
        {shown} of {total} puzzles
      </span>
    </div>
  );
}
