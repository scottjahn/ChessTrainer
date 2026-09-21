import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Chess } from 'chess.js';
import { useLocalApi } from '../App';
import { Board } from '../components/Board';
import { ClassPill, GameMeta, gameSummary } from '../components/bits';
import { api } from '../lib/api';
import { formatScore } from '../lib/classify';
import { newIssueUrl, puzzleUrl } from '../lib/links';
import { DEFAULT_FILTERS, applyFilters, loadPack, pickPuzzle, type PuzzleFilters } from '../lib/puzzles';
import { loadStats, recordAttempt, statFor } from '../lib/stats';
import type { ExportedGame, ExportedPuzzle, PuzzlePack, PuzzleStat } from '../lib/types';

type Phase = 'waiting' | 'solved' | 'failed' | 'revealed';

/** The refused move, kept so the board can point at it. */
interface WrongMove {
  san: string;
  square: string;
  /** Bumped per attempt, to replay the board's flash each time. */
  tries: number;
}

/** One position in the little timeline you can step through under the board. */
interface Frame {
  fen: string;
  lastMove: { from: string; to: string } | null;
  label: string;
}

const ALL_CLASSES = ['blunder', 'miss', 'mistake', 'inaccuracy'] as const;

/** chess.com-style cross on the square a refused move landed on. */
const WRONG_SQUARE: React.CSSProperties = {
  background:
    "rgba(250, 65, 45, .5) url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M5 5l14 14M19 5L5 19' stroke='white' stroke-width='3.4' stroke-linecap='round'/%3E%3C/svg%3E\") center/54% no-repeat",
};

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
  const { puzzleId } = useParams();
  const navigate = useNavigate();
  const [pack, setPack] = useState<PuzzlePack | null>(null);
  const [stats, setStats] = useState(() => loadStats());
  const [filters, setFilters] = useState<PuzzleFilters>(DEFAULT_FILTERS);
  const [puzzle, setPuzzle] = useState<ExportedPuzzle | null>(null);
  const [phase, setPhase] = useState<Phase>('waiting');
  const [wrong, setWrong] = useState<WrongMove | null>(null);
  const [usedHint, setUsedHint] = useState(false);
  const [step, setStep] = useState(0);
  const [missingLink, setMissingLink] = useState<string | null>(null);
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

  const show = useCallback(
    (chosen: ExportedPuzzle | null) => {
      setPuzzle(chosen);
      setPhase('waiting');
      setWrong(null);
      setUsedHint(false);
      recorded.current = false;
      // Replay the opponent's move into the puzzle position, the way a real
      // puzzle trainer does, so the position arrives with context.
      setStep(0);
      window.clearTimeout(replayTimer.current);
      if (chosen?.fenPrev) {
        replayTimer.current = window.setTimeout(() => setStep(1), 420);
      }
      // Keep the address bar on the puzzle you are looking at, so the link in
      // the card matches it. Replacing keeps Back out of the puzzle queue.
      if (chosen) navigate(`/puzzle/${chosen.id}`, { replace: true });
    },
    [navigate]
  );

  const next = useCallback(() => {
    setMissingLink(null);
    show(pickPuzzle(pool, stats, puzzle?.id));
  }, [pool, stats, puzzle?.id, show]);

  useEffect(() => () => window.clearTimeout(replayTimer.current), []);

  // A /puzzle/:id link wins over the random pick, and ignores the filters —
  // a shared link should always open the puzzle it names.
  useEffect(() => {
    if (!pack || !puzzleId || puzzleId === String(puzzle?.id)) return;
    const wanted = pack.puzzles.find((p) => String(p.id) === puzzleId);
    if (wanted) {
      setMissingLink(null);
      show(wanted);
    } else {
      // Clear the board too, or the link in the address bar and the puzzle on
      // screen would disagree.
      setMissingLink(puzzleId);
      show(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pack, puzzleId]);

  // First puzzle once the pack lands, and whenever filters empty the board.
  // A link in the URL is handled above instead.
  useEffect(() => {
    if (pack && !puzzle && pool.length && !puzzleId) next();
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
        setWrong(null);
        goto(puzzleStep + 1);
        return true;
      }
      settle(false, false);
      setPhase('failed');
      setWrong((w) => ({ san: move.san, square: move.to, tries: (w?.tries ?? 0) + 1 }));
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

  if (missingLink && !puzzle) {
    return (
      <div className="empty">
        <h2>That puzzle is not in this set</h2>
        <p>
          The link points at puzzle {missingLink}, which this set does not contain — it may have been
          removed, or belong to a different export.
        </p>
        <button className="primary" onClick={next}>Start training →</button>
      </div>
    );
  }

  // A deep-linked puzzle stays on screen even when the filters would hide it.
  if (!pool.length && !puzzle) {
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
  if (phase === 'failed' && wrong && onPuzzleStep) {
    highlights[wrong.square] = WRONG_SQUARE;
  }
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
            status={phase === 'failed' && onPuzzleStep ? 'wrong' : null}
            statusKey={wrong?.tries ?? 0}
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

        </div>

        <div className="stack">
          {/* Collapsed by default: on a short screen the controls below matter
              more than the game's metadata. */}
          <details className="card collapsible">
            <summary>
              <h2>This game</h2>
              <span className="tiny muted">{gameSummary(game, puzzle.sideToMove)}</span>
            </summary>
            <div style={{ marginTop: 14 }}>
              <GameMeta game={game} side={puzzle.sideToMove} />
            </div>
          </details>

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

            <PuzzleLinks puzzle={puzzle} game={game} />

            <div className="stack controls" style={{ gap: 9 }}>
              <div className="verdict" aria-live="polite">
                {phase === 'solved' && <><span>✓</span><span className="good">Correct — {puzzle.solutionSan}</span></>}
                {phase === 'failed' && <span className="bad">✗ {wrong?.san} is not it. Try again.</span>}
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
              </div>
              <button className="primary wide" onClick={next}>
                Next puzzle →
              </button>
              <p className="tiny faint" style={{ margin: 0 }}>
                Shortcuts: <b>←</b>/<b>→</b> step · <b>H</b> hint · <b>S</b> solution · <b>N</b> next
              </p>
            </div>

            {/* Below the controls: this block only appears once the puzzle is
                settled, and must not push the buttons off a short screen. */}
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

/** The shareable link to this puzzle, plus a prefilled bug report about it. */
function PuzzleLinks({ puzzle, game }: { puzzle: ExportedPuzzle; game: ExportedGame | undefined }) {
  const url = puzzleUrl(puzzle.id);

  const issue = newIssueUrl(
    `Problem with puzzle ${puzzle.id}`,
    [
      `**Puzzle:** ${puzzle.id} (${puzzle.classification})`,
      `**Link:** ${url}`,
      `**Game:** ${game?.url ?? puzzle.gameId}`,
      `**Move asked for:** ${puzzle.solutionSan}`,
      `**Position:** \`${puzzle.fen}\``,
      '',
      '**What looks wrong:**',
      '',
    ].join('\n')
  );

  return (
    <div className="stack" style={{ gap: 7, marginTop: 16 }}>
      <a className="tiny" href={url}>Link to this puzzle</a>
      <a className="tiny" href={issue} target="_blank" rel="noreferrer">
        Report issue with this puzzle ↗
      </a>
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
