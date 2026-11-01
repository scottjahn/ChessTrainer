import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Board } from '../components/Board';
import { moveLabel, playLine, type LineStep } from '../lib/chessutil';
import {
  inBookOrder, loadDone, loadWorkbooks, nextUndone, setDone, TYPE_PROMPT, type DoneMap, type WorkbookPuzzle,
} from '../lib/workbooks';

type Phase = 'playing' | 'solved' | 'revealed';

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
  useEffect(() => {
    loadWorkbooks().then((list) => setPuzzles(inBookOrder(list)));
  }, []);
  return { puzzles, done, setDoneMap };
}

/* ------------------------------------------------------------------ picker */

export function Workbooks() {
  const navigate = useNavigate();
  const { puzzles, done } = useWorkbooks();

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

  const count = puzzles.filter((p) => done[p.id]).length;
  const up = nextUndone(puzzles, done);

  return (
    <div className="stack">
      <div className="card stack" style={{ gap: 10 }}>
        <div className="row">
          <h2>Workbooks</h2>
          <span className="tiny muted">{count} of {puzzles.length} done</span>
          <div className="spacer" />
          <button className="primary" disabled={!up} onClick={() => up && navigate(`/workbooks/${up.id}`)}>
            {up ? 'Continue →' : 'All done'}
          </button>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${(count / puzzles.length) * 100}%` }} />
        </div>
        {up && <span className="tiny muted">Up next: {puzzleLabel(up)}</span>}
      </div>

      <div className="month-grid">
        {pages.map(([key, list]) => (
          <div key={key} className="card">
            <div className="card-head" style={{ marginBottom: 2 }}>
              <h2>{list[0].book}, page {list[0].page}</h2>
            </div>
            <p className="tiny muted" style={{ margin: '0 0 10px' }}>{list[0].theme}</p>
            <div className="cal-grid">
              {list.map((p) => (
                <Link
                  key={p.id}
                  to={`/workbooks/${p.id}`}
                  className={`cal-day${done[p.id] ? ' is-done' : ''}${p.id === up?.id ? ' is-today' : ''}`}
                  aria-label={`${puzzleLabel(p)}${done[p.id] ? ', done' : ''}`}
                >
                  {p.number}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- drill */

export function WorkbookPuzzlePage() {
  const { puzzleId } = useParams();
  const { puzzles, done, setDoneMap } = useWorkbooks();

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
      next={nextUndone(puzzles, done, puzzle.id)}
      mark={(isDone) => setDoneMap((d) => setDone(d, puzzle.id, isDone))}
    />
  );
}

function Drill({
  puzzle,
  isDone,
  next,
  mark,
}: {
  puzzle: WorkbookPuzzle;
  isDone: boolean;
  next: WorkbookPuzzle | null;
  mark: (isDone: boolean) => void;
}) {
  const navigate = useNavigate();
  const [line, setLine] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>('playing');
  const [refused, setRefused] = useState<{ text: string; square: string; tries: number } | null>(null);
  const [hinted, setHinted] = useState(false);
  const replyTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(replyTimer.current), []);

  // Once solved, the board plays out the rest of the line to show what it wins.
  useEffect(() => {
    if (phase !== 'solved' || line[0] !== puzzle.solution[0] || line.length >= puzzle.solution.length) return;
    replyTimer.current = window.setTimeout(() => setLine(puzzle.solution.slice(0, line.length + 1)), 700);
    return () => window.clearTimeout(replyTimer.current);
  }, [phase, line, puzzle.solution]);

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

    if (uci !== puzzle.solution[0] && !puzzle.alternatives?.includes(uci)) {
      setRefused((r) => ({ text: `${move.san} is not the best move.`, square: move.to, tries: (r?.tries ?? 0) + 1 }));
      return false;
    }
    setLine([uci]);
    setPhase('solved');
    setRefused(null);
    if (!isDone) mark(true);
    return true;
  };

  const restart = () => {
    window.clearTimeout(replyTimer.current);
    setLine([]);
    setPhase('playing');
    setRefused(null);
    setHinted(false);
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
        <span className="tiny muted">{puzzle.theme} · page {puzzle.page} · puzzle {puzzle.number}</span>
        <span className={`tiny ${isDone ? 'good-text' : 'muted'}`}>{isDone ? '✓ Done' : 'Not done yet'}</span>

        <div className="verdict" aria-live="polite">
          {phase === 'solved' && <span className="good">✓ {lineText(steps, !whiteToMove)}</span>}
          {phase === 'revealed' && <span className="shown">{lineText(answer, !whiteToMove)}</span>}
          {phase === 'playing' && refused && <span className="bad">✗ {refused.text}</span>}
        </div>

        <div className="row">
          <button onClick={() => setHinted(true)} disabled={phase !== 'playing'}>Hint</button>
          <button onClick={() => { setPhase('revealed'); setRefused(null); }} disabled={phase !== 'playing'}>
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
        <div className="row">
          <button className="small" onClick={() => mark(!isDone)}>
            {isDone ? 'Mark as not done' : 'Mark as done'}
          </button>
          <div className="spacer" />
          <Link className="tiny" to="/workbooks">All puzzles</Link>
        </div>
      </div>
    </div>
  );
}
