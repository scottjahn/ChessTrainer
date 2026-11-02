import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Board } from '../components/Board';
import { moveLabel, playLine, type LineStep } from '../lib/chessutil';
import {
  inBookOrder, loadClean, loadDone, loadWorkbooks, nextToSolve, resumeAt, setClean, setDone, TYPE_PROMPT,
  type DoneMap, type WorkbookPuzzle,
} from '../lib/workbooks';

type Phase = 'playing' | 'solved' | 'revealed';

/** How long a solved board stays up before moving on. */
const ADVANCE_MS = 2500;

const puzzleLabel = (p: WorkbookPuzzle) => `${p.book}, page ${p.page}, puzzle ${p.number}`;

/** Numbered from the first move of the puzzle, whichever side that is. */
function lineText(steps: LineStep[], blackFirst: boolean): string {
  const start = blackFirst ? 1 : 0;
  return steps
    .map((s, i) => {
      const ply = start + i;
      return ply % 2 === 0 || i === 0 ? `${moveLabel(ply)} ${s.san}` : s.san;
    })
    .join(' ');
}

function useWorkbooks() {
  const [puzzles, setPuzzles] = useState<WorkbookPuzzle[] | null>(null);
  const [done, setDoneMap] = useState<DoneMap>(() => loadDone());
  const [clean, setCleanMap] = useState<DoneMap>(() => loadClean());
  useEffect(() => {
    loadWorkbooks().then((list) => setPuzzles(inBookOrder(list)));
  }, []);
  return { puzzles, done, clean, setDoneMap, setCleanMap };
}

/* ------------------------------------------------------------------ picker */

export function Workbooks() {
  const navigate = useNavigate();
  const { puzzles, done, clean } = useWorkbooks();

  const pages = useMemo(() => {
    const byPage = new Map<string, WorkbookPuzzle[]>();
    for (const p of puzzles ?? []) {
      const key = `${p.book}|${p.page}`;
      byPage.set(key, [...(byPage.get(key) ?? []), p]);
    }
    return [...byPage.entries()];
  }, [puzzles]);

  if (!puzzles) return <div className="empty"><p className="muted">Loading workbooks…</p></div>;

  if (!puzzles.length) {
    return (
      <div className="empty">
        <h2>No workbook puzzles yet</h2>
        <p>Give Claude Code a photo of a workbook page and its puzzles will appear here.</p>
      </div>
    );
  }

  const cleanCount = puzzles.filter((p) => clean[p.id]).length;
  const up = resumeAt(puzzles, done, clean);

  return (
    <div className="stack">
      <div className="card stack" style={{ gap: 10 }}>
        <div className="row">
          <h2>Workbooks</h2>
          <span className="tiny muted">{cleanCount} of {puzzles.length} in one attempt</span>
          <div className="spacer" />
          <button className="primary" disabled={!up} onClick={() => up && navigate(`/workbooks/${up.id}`)}>
            {up ? 'Continue →' : 'All done'}
          </button>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${(cleanCount / puzzles.length) * 100}%` }} />
        </div>
        {up && <span className="tiny muted">Up next: {puzzleLabel(up)}</span>}
        <div className="legend tiny muted">
          <span><i className="cal-day is-done" /> In one attempt</span>
          <span><i className="cal-day is-partial" /> Solved, with a mistake or help</span>
          <span><i className="cal-day" /> Not solved yet</span>
        </div>
      </div>

      <div className="month-grid">
        {pages.map(([key, list]) => (
          <WorkbookPage key={key} puzzles={list} done={done} clean={clean} up={up} />
        ))}
      </div>
    </div>
  );
}

function WorkbookPage({
  puzzles,
  done,
  clean,
  up,
}: {
  puzzles: WorkbookPuzzle[];
  done: DoneMap;
  clean: DoneMap;
  up: WorkbookPuzzle | null;
}) {
  const open = puzzles.filter((p) => !clean[p.id]);
  const status = (p: WorkbookPuzzle) =>
    clean[p.id] ? ', solved in one attempt' : done[p.id] ? ', solved with a mistake or help' : ', not solved yet';

  return (
    <div className="card">
      <div className="card-head" style={{ marginBottom: 2 }}>
        <h2>{puzzles[0].book}, page {puzzles[0].page}</h2>
      </div>
      <p className="tiny muted" style={{ margin: '0 0 10px' }}>
        {puzzles[0].section} · {puzzles[0].theme} · {puzzles.length - open.length} of {puzzles.length} in one attempt
      </p>
      <div className="cal-grid">
        {puzzles.map((p) => (
          <Link
            key={p.id}
            to={`/workbooks/${p.id}`}
            className={`cal-day${clean[p.id] ? ' is-done' : done[p.id] ? ' is-partial' : ''}${p.id === up?.id ? ' is-today' : ''}`}
            aria-label={`${puzzleLabel(p)}${status(p)}`}
          >
            {p.number}
          </Link>
        ))}
      </div>
      {open.length ? (
        <div className="row" style={{ marginTop: 12 }}>
          <span className="tiny muted">Not yet in one attempt: {open.map((p) => p.number).join(', ')}</span>
          <div className="spacer" />
          <Link className="tiny" to={`/workbooks/${open[0].id}`}>Work on these →</Link>
        </div>
      ) : (
        <p className="tiny good-text" style={{ margin: '12px 0 0' }}>✓ All in one attempt</p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- drill */

export function WorkbookPuzzlePage() {
  const { puzzleId } = useParams();
  const { puzzles, done, clean, setDoneMap, setCleanMap } = useWorkbooks();

  if (!puzzles) return <div className="empty"><p className="muted">Loading workbooks…</p></div>;

  const puzzle = puzzles.find((p) => p.id === puzzleId);
  if (!puzzle) {
    return (
      <div className="empty">
        <h2>No such puzzle</h2>
        <p><Link to="/workbooks">Back to the workbooks</Link></p>
      </div>
    );
  }

  // Keyed so that moving to another puzzle starts from a clean board.
  return (
    <Drill
      key={puzzle.id}
      puzzle={puzzle}
      isDone={!!done[puzzle.id]}
      isClean={!!clean[puzzle.id]}
      next={nextToSolve(puzzles, clean, puzzle.id)}
      mark={(isDone) => {
        setDoneMap((d) => setDone(d, puzzle.id, isDone));
        if (!isDone) setCleanMap((c) => setClean(c, puzzle.id, false));
      }}
      markClean={(isClean) => {
        setCleanMap((c) => setClean(c, puzzle.id, isClean));
        if (isClean) setDoneMap((d) => setDone(d, puzzle.id, true));
      }}
    />
  );
}

function Drill({
  puzzle,
  isDone,
  isClean,
  next,
  mark,
  markClean,
}: {
  puzzle: WorkbookPuzzle;
  isDone: boolean;
  isClean: boolean;
  next: WorkbookPuzzle | null;
  mark: (isDone: boolean) => void;
  markClean: (isClean: boolean) => void;
}) {
  const navigate = useNavigate();
  const [line, setLine] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>('playing');
  const [refused, setRefused] = useState<{ text: string; square: string; tries: number } | null>(null);
  const [hinted, setHinted] = useState(false);
  // Survives Start over: a retry straight after a slip is not a clean solve.
  const [slipped, setSlipped] = useState(false);
  const [stay, setStay] = useState(false);
  const replyTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(replyTimer.current), []);

  // Once solved, the board plays out the rest of the line to show what it wins.
  useEffect(() => {
    if (phase !== 'solved' || line[0] !== puzzle.solution[0] || line.length >= puzzle.solution.length) return;
    replyTimer.current = window.setTimeout(() => setLine(puzzle.solution.slice(0, line.length + 1)), 700);
    return () => window.clearTimeout(replyTimer.current);
  }, [phase, line, puzzle.solution]);

  const playedOut = phase === 'solved' && (line[0] !== puzzle.solution[0] || line.length >= puzzle.solution.length);
  const advancing = playedOut && !stay && !!next;
  const nextId = next?.id;

  useEffect(() => {
    if (!advancing) return;
    const timer = window.setTimeout(() => navigate(`/workbooks/${nextId}`), ADVANCE_MS);
    return () => window.clearTimeout(timer);
  }, [advancing, nextId, navigate]);

  const whiteToMove = puzzle.fen.split(' ')[1] === 'w';
  const steps = useMemo(() => playLine(puzzle.fen, line), [puzzle.fen, line]);
  const answer = useMemo(() => playLine(puzzle.fen, puzzle.solution), [puzzle.fen, puzzle.solution]);
  const last = steps[steps.length - 1];
  const fen = last?.fen ?? puzzle.fen;

  const onMove = (from: string, to: string, promotion?: string) => {
    if (phase !== 'playing') return false;
    const chess = new Chess(puzzle.fen);
    let move;
    try {
      move = chess.move({ from, to, promotion });
    } catch {
      return false;
    }
    const uci = `${move.from}${move.to}${move.promotion ?? ''}`;

    if (uci !== puzzle.solution[0] && !puzzle.bookAlternatives?.includes(uci) && !puzzle.alternatives?.includes(uci)) {
      setRefused((r) => ({ text: `${move.san} is not it.`, square: move.to, tries: (r?.tries ?? 0) + 1 }));
      setSlipped(true);
      return false;
    }
    setLine([uci]);
    setPhase('solved');
    setRefused(null);
    if (!slipped && !isClean) markClean(true);
    else if (!isDone) mark(true);
    return true;
  };

  const restart = () => {
    window.clearTimeout(replyTimer.current);
    setLine([]);
    setPhase('playing');
    setRefused(null);
    setHinted(false);
    setStay(false);
  };

  const highlights: Record<string, React.CSSProperties> = {};
  if (refused) {
    highlights[refused.square] = { background: 'rgba(250, 65, 45, .5)' };
  }
  if (hinted && phase === 'playing' && answer[0]) {
    highlights[answer[0].from] = {
      boxShadow: 'inset 0 0 0 4px rgba(247, 198, 49, .85)',
      borderRadius: '4px',
    };
  }

  const arrows = phase === 'revealed' && answer[0]
    ? [{ startSquare: answer[0].from, endSquare: answer[0].to, color: 'rgba(127,166,80,.9)' }]
    : [];

  return (
    <div className="cols">
      <div className="stack">
        <div className="puzzle-prompt">
          <span>{whiteToMove ? 'White' : 'Black'} to play — {TYPE_PROMPT[puzzle.type]}.</span>
        </div>
        <Board
          fen={fen}
          orientation={whiteToMove ? 'white' : 'black'}
          onMove={phase === 'playing' ? onMove : undefined}
          highlights={highlights}
          arrows={arrows}
          lastMove={last ? { from: last.from, to: last.to } : null}
          status={refused ? 'wrong' : null}
          statusKey={refused?.tries ?? 0}
        />
      </div>

      <div className="card stack">
        <div className="card-head" style={{ marginBottom: 0 }}>
          <h2>{puzzle.book}</h2>
        </div>
        <span className="tiny muted">{puzzle.section} · {puzzle.theme} · page {puzzle.page} · puzzle {puzzle.number}</span>
        <span className={`tiny ${isClean ? 'good-text' : isDone ? 'partial-text' : 'muted'}`}>
          {isClean ? '✓ Solved in one attempt' : isDone ? 'Solved, not yet in one attempt' : 'Not solved yet'}
        </span>
        {slipped && !isClean && phase === 'playing' && (
          <span className="tiny muted">This try won't count as one attempt. Come back to this puzzle later for a clean run.</span>
        )}

        <div className="verdict" aria-live="polite">
          {phase === 'solved' && <span className="good">✓ {lineText(steps, !whiteToMove)}</span>}
          {phase === 'revealed' && <span className="shown">{lineText(answer, !whiteToMove)}</span>}
          {phase === 'playing' && refused && <span className="bad">✗ {refused.text}</span>}
        </div>
        {phase === 'solved' && line[0] !== puzzle.solution[0] && (
          <span className="tiny muted">
            {puzzle.bookAlternatives?.includes(line[0])
              ? `The book also gives ${answer[0]?.san}.`
              : `Stockfish rates this at least as highly. The book plays ${answer[0]?.san}.`}
          </span>
        )}

        <div className="row">
          <button onClick={() => { setHinted(true); setSlipped(true); }} disabled={phase !== 'playing'}>Hint</button>
          <button
            onClick={() => { setPhase('revealed'); setRefused(null); setSlipped(true); }}
            disabled={phase !== 'playing'}
          >
            Show solution
          </button>
          <button onClick={restart} disabled={phase === 'playing' && !refused && !hinted}>Start over</button>
        </div>

        <button
          className="primary wide"
          disabled={!next}
          onClick={() => next && navigate(`/workbooks/${next.id}`)}
        >
          {next ? `Next: page ${next.page}, puzzle ${next.number} →` : 'No others left'}
        </button>
        {advancing && (
          <div className="row">
            <span className="tiny muted">Moving on in a moment.</span>
            <div className="spacer" />
            <button className="small" onClick={() => setStay(true)}>Stay here</button>
          </div>
        )}
        <div className="row">
          <button className="small" onClick={() => mark(!isDone)}>
            {isDone ? 'Mark as not solved' : 'Mark as solved'}
          </button>
          <button className="small" onClick={() => markClean(!isClean)}>
            {isClean ? "Don't count as one attempt" : 'Count as one attempt'}
          </button>
          <div className="spacer" />
          <Link className="tiny" to="/workbooks">All puzzles</Link>
        </div>
      </div>
    </div>
  );
}
