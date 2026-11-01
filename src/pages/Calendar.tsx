import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Board } from '../components/Board';
import {
  dateKey, loadCalendar, loadDone, nextUndone, parseDate, setDone, type CalendarPuzzle, type DoneMap,
} from '../lib/calendar';
import { playLine } from '../lib/chessutil';
import { findEscape, solveMate2, toughestReply, type MateMove } from '../lib/mate2';

type Phase = 'playing' | 'solved' | 'revealed';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const longDate = (date: string) =>
  parseDate(date).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

function useCalendar() {
  const [puzzles, setPuzzles] = useState<CalendarPuzzle[] | null>(null);
  const [done, setDoneMap] = useState<DoneMap>(() => loadDone());
  useEffect(() => {
    loadCalendar().then(setPuzzles);
  }, []);
  return { puzzles, done, setDoneMap };
}

/* ------------------------------------------------------------------ picker */

export function Calendar() {
  const navigate = useNavigate();
  const { puzzles, done } = useCalendar();

  const months = useMemo(() => {
    const byMonth = new Map<string, CalendarPuzzle[]>();
    for (const p of puzzles ?? []) {
      const month = p.date.slice(0, 7);
      byMonth.set(month, [...(byMonth.get(month) ?? []), p]);
    }
    return [...byMonth.entries()];
  }, [puzzles]);

  if (!puzzles) return <div className="empty"><p className="muted">Loading calendar…</p></div>;

  if (!puzzles.length) {
    return (
      <div className="empty">
        <h2>No calendar puzzles yet</h2>
        <p>Give Claude Code a photo of a calendar page and its puzzles will appear here.</p>
      </div>
    );
  }

  const count = puzzles.filter((p) => done[p.date]).length;
  const up = nextUndone(puzzles, done);

  return (
    <div className="stack">
      <div className="card stack" style={{ gap: 10 }}>
        <div className="row">
          <h2>Mate in 2</h2>
          <span className="tiny muted">{count} of {puzzles.length} done</span>
          <div className="spacer" />
          <button className="primary" disabled={!up} onClick={() => up && navigate(`/calendar/${up.date}`)}>
            {up ? 'Next undone →' : 'All done'}
          </button>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${(count / puzzles.length) * 100}%` }} />
        </div>
      </div>

      <div className="month-grid">
        {months.map(([month, list]) => (
          <Month key={month} month={month} puzzles={list} done={done} />
        ))}
      </div>
    </div>
  );
}

function Month({ month, puzzles, done }: { month: string; puzzles: CalendarPuzzle[]; done: DoneMap }) {
  const first = parseDate(`${month}-01`);
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const today = dateKey(new Date());
  const byDate = new Set(puzzles.map((p) => p.date));

  return (
    <div className="card">
      <div className="card-head">
        <h2>{first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
      </div>
      <div className="cal-grid">
        {WEEKDAYS.map((d) => <span key={d} className="cal-weekday">{d}</span>)}
        {Array.from({ length: first.getDay() }, (_, i) => <span key={i} />)}
        {Array.from({ length: days }, (_, i) => {
          const date = `${month}-${String(i + 1).padStart(2, '0')}`;
          const ring = date === today ? ' is-today' : '';
          if (!byDate.has(date)) return <span key={date} className={`cal-day is-blank${ring}`}>{i + 1}</span>;
          return (
            <Link
              key={date}
              to={`/calendar/${date}`}
              className={`cal-day${done[date] ? ' is-done' : ''}${ring}`}
              aria-label={`${longDate(date)}${done[date] ? ', done' : ''}`}
            >
              {i + 1}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- drill */

export function CalendarDay() {
  const { date } = useParams();
  const { puzzles, done, setDoneMap } = useCalendar();

  if (!puzzles) return <div className="empty"><p className="muted">Loading calendar…</p></div>;

  const puzzle = puzzles.find((p) => p.date === date);
  if (!puzzle) {
    return (
      <div className="empty">
        <h2>No puzzle for that date</h2>
        <p><Link to="/calendar">Back to the calendar</Link></p>
      </div>
    );
  }

  // Keyed so that moving to another date starts from a clean board.
  return (
    <Drill
      key={puzzle.date}
      puzzle={puzzle}
      isDone={!!done[puzzle.date]}
      next={nextUndone(puzzles, done, puzzle.date)}
      mark={(isDone) => setDoneMap((d) => setDone(d, puzzle.date, isDone))}
    />
  );
}

function Drill({
  puzzle,
  isDone,
  next,
  mark,
}: {
  puzzle: CalendarPuzzle;
  isDone: boolean;
  next: CalendarPuzzle | null;
  mark: (isDone: boolean) => void;
}) {
  const navigate = useNavigate();
  const solution = useMemo(() => solveMate2(puzzle.fen), [puzzle.fen]);
  const [line, setLine] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>('playing');
  const [refused, setRefused] = useState<{ text: string; square: string; tries: number } | null>(null);
  const [hintAt, setHintAt] = useState<number | null>(null);
  const replyTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(replyTimer.current), []);

  const steps = useMemo(() => playLine(puzzle.fen, line), [puzzle.fen, line]);
  const last = steps[steps.length - 1];
  const fen = last?.fen ?? puzzle.fen;
  const yourTurn = line.length % 2 === 0;
  const sound = solution.keys.length > 0 || solution.mateInOne.length > 0;

  // What a hint or a shown solution points at: the key, or the mate after the
  // reply. A reply to a move the solver did not list cannot happen.
  const answer: MateMove | undefined = line.length === 0
    ? solution.keys[0] ?? solution.mateInOne[0]
    : solution.keys.find((k) => k.uci === line[0])?.lines.find((l) => l.reply.uci === line[1])?.mates[0];

  const refuse = (text: string, square: string) =>
    setRefused((r) => ({ text, square, tries: (r?.tries ?? 0) + 1 }));

  const finish = () => {
    setPhase('solved');
    setRefused(null);
    if (!isDone) mark(true);
  };

  const onMove = (from: string, to: string, promotion?: string) => {
    if (phase !== 'playing' || !yourTurn) return false;
    const chess = new Chess(fen);
    let move;
    try {
      move = chess.move({ from, to, promotion });
    } catch {
      return false;
    }
    const uci = `${move.from}${move.to}${move.promotion ?? ''}`;

    if (chess.isCheckmate()) {
      setLine([...line, uci]);
      finish();
      return true;
    }
    if (line.length) {
      refuse(`${move.san} is not mate.`, move.to);
      return false;
    }
    const key = solution.keys.find((k) => k.uci === uci);
    if (!key) {
      const escape = findEscape(puzzle.fen, uci);
      refuse(
        escape ? `${move.san} is not it: ${escape} escapes.` : `${move.san} is stalemate.`,
        move.to
      );
      return false;
    }
    setLine([uci]);
    setRefused(null);
    const reply = toughestReply(key).reply.uci;
    replyTimer.current = window.setTimeout(() => setLine([uci, reply]), 500);
    return true;
  };

  const restart = () => {
    window.clearTimeout(replyTimer.current);
    setLine([]);
    setPhase('playing');
    setRefused(null);
    setHintAt(null);
  };

  const highlights: Record<string, React.CSSProperties> = {};
  if (refused) {
    highlights[refused.square] = { background: 'rgba(250, 65, 45, .5)' };
  }
  if (hintAt === line.length && phase === 'playing' && yourTurn && answer) {
    highlights[answer.from] = {
      boxShadow: 'inset 0 0 0 4px rgba(247, 198, 49, .85)',
      borderRadius: '4px',
    };
  }

  const arrows = phase === 'revealed' && answer
    ? [{ startSquare: answer.from, endSquare: answer.to, color: 'rgba(127,166,80,.9)' }]
    : [];

  return (
    <div className="cols">
      <div className="stack">
        <div className="puzzle-prompt">
          <span>White to play — mate in 2.</span>
        </div>
        <Board
          fen={fen}
          onMove={phase === 'playing' && yourTurn ? onMove : undefined}
          highlights={highlights}
          arrows={arrows}
          lastMove={last ? { from: last.from, to: last.to } : null}
          status={refused ? 'wrong' : null}
          statusKey={refused?.tries ?? 0}
        />
      </div>

      <div className="card stack">
        <div className="card-head" style={{ marginBottom: 0 }}>
          <h2>{longDate(puzzle.date)}</h2>
        </div>
        {puzzle.credit && <span className="tiny muted">{puzzle.credit}</span>}
        <span className={`tiny ${isDone ? 'good-text' : 'muted'}`}>{isDone ? '✓ Done' : 'Not done yet'}</span>

        {!sound && (
          <div className="banner err">
            This position has no forced mate in 2, so a piece was probably misread from the calendar.
          </div>
        )}

        <div className="verdict" aria-live="polite">
          {phase === 'solved' && <span className="good">✓ Mate — {steps.map((s) => s.san).join(' ')}</span>}
          {phase === 'revealed' && <span className="shown">Here is the answer</span>}
          {phase === 'playing' && refused && <span className="bad">✗ {refused.text}</span>}
          {phase === 'playing' && !refused && line.length > 0 && (
            <span className="good">
              {yourTurn ? `✓ ${steps[0].san} works — ${steps[1].san} was played. Now mate.` : `✓ ${steps[0].san} works.`}
            </span>
          )}
        </div>

        <div className="row">
          <button onClick={() => setHintAt(line.length)} disabled={phase !== 'playing' || !yourTurn || !sound}>
            Hint
          </button>
          <button onClick={() => { setPhase('revealed'); setRefused(null); }} disabled={phase !== 'playing' || !sound}>
            Show solution
          </button>
          <button onClick={restart} disabled={!line.length && phase === 'playing'}>Start over</button>
        </div>

        <button
          className="primary wide"
          disabled={!next}
          onClick={() => next && navigate(`/calendar/${next.date}`)}
        >
          {next ? 'Next undone →' : 'No others left'}
        </button>
        <div className="row">
          <button className="small" onClick={() => mark(!isDone)}>
            {isDone ? 'Mark as not done' : 'Mark as done'}
          </button>
          <div className="spacer" />
          <Link className="tiny" to="/calendar">All dates</Link>
        </div>

        {phase === 'revealed' && (
          <div className="stack scroll-list" style={{ gap: 8 }}>
            {solution.mateInOne.map((m) => (
              <div key={m.uci} className="mono">1. {m.san}</div>
            ))}
            {solution.keys.map((key) => (
              <div key={key.uci}>
                <div className="mono"><b>1. {key.san}</b></div>
                {key.lines.map((l) => (
                  <div key={l.reply.uci} className="mono tiny muted">
                    1… {l.reply.san} 2. {l.mates.map((m) => m.san).join(' or ')}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
