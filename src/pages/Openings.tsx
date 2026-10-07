import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Chess } from 'chess.js';
import { useLocalApi } from '../App';
import { Board } from '../components/Board';
import { START_FEN, playLine } from '../lib/chessutil';
import { isYourPly, leafLines, lineRef, lineSan, pickLine, startsWith } from '../lib/openings';
import { loadPack } from '../lib/puzzles';
import { loadStats, recordAttempt, statFor } from '../lib/stats';
import type { Color, ExportedOpening, ExportedOpeningLine, PuzzlePack } from '../lib/types';

type Phase = 'waiting' | 'solved' | 'failed' | 'revealed';

const SIDE: Record<Color, string> = { w: 'White', b: 'Black' };

/** chess.com-style cross on the square a refused move landed on. */
const WRONG_SQUARE: React.CSSProperties = {
  background:
    "rgba(250, 65, 45, .5) url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M5 5l14 14M19 5L5 19' stroke='white' stroke-width='3.4' stroke-linecap='round'/%3E%3C/svg%3E\") center/54% no-repeat",
};

function usePack(): PuzzlePack | null {
  const local = useLocalApi();
  const [pack, setPack] = useState<PuzzlePack | null>(null);
  useEffect(() => {
    if (local === null) return;
    loadPack(local).then(({ pack: p }) => setPack(p));
  }, [local]);
  return pack;
}

/* ------------------------------------------------------------------ picker */

export function Openings() {
  const local = useLocalApi();
  const pack = usePack();
  const [stats] = useState(() => loadStats());

  if (!pack) return <div className="empty"><p className="muted">Loading openings…</p></div>;

  const openings = pack.openings ?? [];
  if (!openings.length) {
    return (
      <div className="empty">
        <h2>No openings yet</h2>
        <p>
          {local
            ? 'Open Admin → Openings, create one, and record the lines you want to drill.'
            : 'This published set has no openings in it yet.'}
        </p>
      </div>
    );
  }

  return (
    <div className="stack">
      {(['w', 'b'] as const).map((color) => {
        const mine = openings.filter((o) => o.color === color);
        if (!mine.length) return null;
        return (
          <div key={color} className="stack">
            <h2 className="row-tight"><span className={`side-dot ${color}`} />As {SIDE[color]}</h2>
            <div className="opening-grid">
              {mine.map((o) => {
                const lines = leafLines(o.lines);
                const learned = lines.filter((l) => statFor(stats, lineRef(color, l)).solves > 0).length;
                return (
                  <Link key={o.id} to={`/openings/${o.id}`} className="card opening-card">
                    <h3>{o.name}</h3>
                    {o.note && <p className="tiny muted">{o.note}</p>}
                    <div className="progress-track">
                      <div className="progress-fill" style={{ width: `${(learned / lines.length) * 100}%` }} />
                    </div>
                    <span className="tiny faint">
                      {lines.length} line{lines.length === 1 ? '' : 's'} · {learned} played through
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------- drill */

export function OpeningDrill() {
  const { openingId } = useParams();
  const pack = usePack();

  if (!pack) return <div className="empty"><p className="muted">Loading openings…</p></div>;

  const opening = pack.openings?.find((o) => String(o.id) === openingId);
  if (!opening) {
    return (
      <div className="empty">
        <h2>That opening is not in this set</h2>
        <p>It may have been removed, hidden, or belong to a different export.</p>
        <Link className="btn" to="/openings">All openings</Link>
      </div>
    );
  }
  return <Drill key={opening.id} opening={opening} />;
}

function Drill({ opening }: { opening: ExportedOpening }) {
  const color = opening.color;
  const lines = useMemo(() => leafLines(opening.lines), [opening]);
  const [stats, setStats] = useState(() => loadStats());
  // The line being followed. It decides the opponent's replies, and changes
  // when you answer with a move that belongs to a different line.
  const [line, setLine] = useState<ExportedOpeningLine | null>(null);
  // Every move on the board so far, both sides, from the starting position.
  const [path, setPath] = useState<string[]>([]);
  const [phase, setPhase] = useState<Phase>('waiting');
  const [wrong, setWrong] = useState<{ san: string; square: string; tries: number } | null>(null);
  const [usedHint, setUsedHint] = useState(false);
  const [hintAt, setHintAt] = useState<number | null>(null);
  // The ply at which your move took the drill onto another line.
  const [switchedAt, setSwitchedAt] = useState<number | null>(null);
  const [step, setStep] = useState(0);
  const recorded = useRef(false);
  // A wrong move this drill. It is charged to whichever line the drill ends
  // on, which is not known until then: a later move can still switch lines.
  const slipped = useRef(false);
  const replyTimer = useRef<number | undefined>(undefined);

  const start = useCallback(
    (chosen: ExportedOpeningLine | null) => {
      window.clearTimeout(replyTimer.current);
      setLine(chosen);
      setPath([]);
      setPhase('waiting');
      setWrong(null);
      setUsedHint(false);
      setHintAt(null);
      setSwitchedAt(null);
      setStep(0);
      recorded.current = false;
      slipped.current = false;
      // As Black the opening starts with their move, not yours.
      if (chosen && color === 'b') {
        replyTimer.current = window.setTimeout(() => {
          setPath((p) => (p.length ? p : [chosen.moves[0]]));
          setStep(1);
        }, 420);
      }
    },
    [color]
  );


  useEffect(() => {
    start(pickLine(lines, color, loadStats()));
    return () => window.clearTimeout(replyTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const done = phase === 'solved' || phase === 'revealed';
  const solution = useMemo(() => (line ? playLine(START_FEN, line.moves) : []), [line]);
  const steps = useMemo(
    () => (phase === 'revealed' ? solution : playLine(START_FEN, path)),
    [phase, solution, path]
  );
  const yourTurn = isYourPly(color, path.length);
  // Frame i is the position after i moves, so the live one is path.length.
  const index = Math.min(step, steps.length);

  const settle = useCallback(
    (target: ExportedOpeningLine, solved: boolean, viaSolution: boolean) => {
      if (recorded.current) return;
      recorded.current = true;
      setStats((s) => recordAttempt(s, lineRef(color, target), { solved, usedHint, usedSolution: viaSolution }));
    },
    [color, usedHint]
  );

  // Walking away after a wrong move still counts as a miss on this line.
  const leaveFor = useCallback(
    (chosen: ExportedOpeningLine | null) => {
      if (line && slipped.current) settle(line, false, false);
      start(chosen);
    },
    [line, settle, start]
  );
  const next = useCallback(
    () => leaveFor(pickLine(lines, color, stats, line)),
    [leaveFor, lines, color, stats, line]
  );

  const onMove = useCallback(
    (from: string, to: string, promotion?: string) => {
      if (!line || done || !yourTurn) return false;
      const at = path.length;
      let move;
      try {
        move = new Chess(at ? steps[at - 1].fen : START_FEN).move({ from, to, promotion: promotion ?? 'q' });
      } catch {
        return false;
      }
      const uci = `${move.from}${move.to}${move.promotion ?? ''}`;

      let target = line;
      if (uci !== line.moves[at]) {
        // Not this line's move — but another line may answer the same position
        // this way, and then that is the one to follow.
        const branch = pickLine(lines.filter((l) => l.moves[at] === uci && startsWith(l.moves, path)), color, stats);
        if (!branch) {
          slipped.current = true;
          setPhase('failed');
          setWrong((w) => ({ san: move.san, square: move.to, tries: (w?.tries ?? 0) + 1 }));
          return false; // snap the piece back
        }
        target = branch;
        setLine(branch);
        setSwitchedAt(at);
      }

      setPath([...path, uci]);
      setWrong(null);
      setStep(at + 1);
      const reply = target.moves[at + 1];
      if (!reply) {
        // Scored on the first try: one wrong move on the way makes it a miss.
        settle(target, !slipped.current, false);
        setPhase('solved');
        return true;
      }
      setPhase('waiting');
      window.clearTimeout(replyTimer.current);
      replyTimer.current = window.setTimeout(() => {
        setPath((p) => (p.length === at + 1 ? [...p, reply] : p));
        setStep(at + 2);
      }, 500);
      return true;
    },
    [line, done, yourTurn, path, steps, lines, color, stats, settle]
  );

  const reveal = useCallback(() => {
    if (!line || done) return;
    window.clearTimeout(replyTimer.current);
    settle(line, false, true);
    setPhase('revealed');
    // Land on the move that was being asked for, not the end of the line.
    setStep(Math.min(line.moves.length, path.length + (yourTurn ? 1 : 2)));
  }, [line, done, settle, path.length, yourTurn]);

  const hint = useCallback(() => {
    setUsedHint(true);
    setHintAt(path.length);
  }, [path.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && /input|textarea|select/i.test(e.target.tagName)) return;
      if (e.key === 'n' || e.key === 'Enter') next();
      if (e.key === 'h') hint();
      if (e.key === 's') reveal();
      if (e.key === 'ArrowLeft' && index > 0) {
        e.preventDefault();
        setStep(index - 1);
      }
      if (e.key === 'ArrowRight' && index < steps.length) {
        e.preventDefault();
        setStep(index + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [next, reveal, hint, index, steps.length]);

  if (!line) return <div className="empty"><p className="muted">Picking a line…</p></div>;

  const stat = statFor(stats, lineRef(color, line));
  const learned = lines.filter((l) => statFor(stats, lineRef(color, l)).solves > 0).length;
  // Only the position where the next move is due takes moves, hints and crosses.
  const onLiveStep = index === path.length;
  const hinting = hintAt === path.length && !done && yourTurn;
  const lastYours = steps[path.length - (yourTurn ? 2 : 1)];
  const switched = switchedAt != null && path.length <= switchedAt + 2;

  const highlights: Record<string, React.CSSProperties> = {};
  if (phase === 'failed' && wrong && onLiveStep) highlights[wrong.square] = WRONG_SQUARE;
  if (hinting && onLiveStep && solution[path.length]) {
    highlights[solution[path.length].from] = {
      boxShadow: 'inset 0 0 0 4px rgba(247, 198, 49, .85)',
      borderRadius: '4px',
    };
  }

  // Once it is over, each position shows the move played from it; the final
  // one, the move that led to it.
  const arrowMove = done ? steps[Math.min(index, steps.length - 1)] : undefined;
  const arrows = arrowMove
    ? [{ startSquare: arrowMove.from, endSquare: arrowMove.to, color: 'rgba(127,166,80,.9)' }]
    : [];

  const shown = index > 0 ? steps[index - 1] : null;
  const label = !shown
    ? 'Starting position'
    : !done && onLiveStep && yourTurn ? `${shown.san} played — your move` : `After ${shown.san}`;

  return (
    <div className="stack">
      <div className="cols">
        <div className="stack">
          <div className="puzzle-prompt">
            <span className="pill"><span className={`side-dot ${color}`} />{SIDE[color]}</span>
            <span>{opening.name} — play {SIDE[color]}'s moves.</span>
          </div>

          <Board
            fen={shown?.fen ?? START_FEN}
            orientation={color === 'w' ? 'white' : 'black'}
            onMove={done || !onLiveStep || !yourTurn ? undefined : onMove}
            highlights={highlights}
            arrows={arrows}
            lastMove={shown ? { from: shown.from, to: shown.to } : null}
            status={phase === 'failed' && onLiveStep ? 'wrong' : null}
            statusKey={wrong?.tries ?? 0}
          />

          <div className="row board-nav">
            <button
              className="icon"
              onClick={() => setStep(index - 1)}
              disabled={index === 0}
              title="Previous position (←)"
              aria-label="Previous position"
            >
              ←
            </button>
            <button
              className="icon"
              onClick={() => setStep(index + 1)}
              disabled={index >= steps.length}
              title="Next position (→)"
              aria-label="Next position"
            >
              →
            </button>
            <span className="tiny faint">{label}</span>
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h2>This line</h2>
              <Link className="tiny" to="/openings">All openings</Link>
            </div>
            <div className="statline">
              <div className="stat"><b>{stat.attempts}</b><span>Seen</span></div>
              <div className="stat"><b>{stat.solves}</b><span>Clean</span></div>
              <div className="stat">
                <b>{stat.attempts ? Math.round((stat.solves / stat.attempts) * 100) : 0}%</b>
                <span>Rate</span>
              </div>
              <div className="stat"><b>{stat.streak}</b><span>Streak</span></div>
            </div>

            <div className="stack controls" style={{ gap: 9 }}>
              <div className="verdict" aria-live="polite">
                {phase === 'solved' && <><span>✓</span><span className="good">Line complete.</span></>}
                {phase === 'failed' && <span className="bad">✗ {wrong?.san} is not in this opening. Try again.</span>}
                {phase === 'revealed' && <span className="shown">Here is the line.</span>}
                {phase === 'waiting' && hinting && <span className="muted">Move the highlighted piece.</span>}
                {phase === 'waiting' && !hinting && lastYours && (
                  <span className="good">
                    ✓ {lastYours.san} {switched ? 'is another of your lines — following it.' : 'is right — keep going.'}
                  </span>
                )}
              </div>

              <div className="row">
                <button onClick={hint} disabled={hinting || done || !yourTurn}>Hint</button>
                <button onClick={reveal} disabled={done}>Show solution</button>
              </div>
              <button className="primary wide" onClick={next}>Next line →</button>
              <p className="tiny faint" style={{ margin: 0 }}>
                Shortcuts: <b>←</b>/<b>→</b> step · <b>H</b> hint · <b>S</b> solution · <b>N</b> next
              </p>
            </div>

            {done && (
              <dl className="meta-grid" style={{ marginTop: 14 }}>
                {line.name && (
                  <>
                    <dt>Line</dt>
                    <dd>{line.name}</dd>
                  </>
                )}
                <dt>Moves</dt>
                <dd className="mono">{lineSan(line.moves)}</dd>
              </dl>
            )}
            {done && line.note && <p className="tiny muted" style={{ marginTop: 12 }}>{line.note}</p>}
          </div>

          {/* Collapsed by default: the line names can give the answer away. */}
          <details className="card collapsible">
            <summary>
              <h2>{opening.name}</h2>
              <span className="tiny muted">{learned} of {lines.length} lines played through</span>
            </summary>
            <div style={{ marginTop: 14 }}>
              {opening.note && <p className="tiny muted">{opening.note}</p>}
              <table className="table">
                <tbody>
                  {lines.map((l, i) => {
                    const s = statFor(stats, lineRef(color, l));
                    return (
                      <tr key={l.id}>
                        <td>{l.name ?? `Line ${i + 1}`}</td>
                        <td className="num tiny muted">
                          {s.attempts ? `${s.solves}/${s.attempts}` : <span className="faint">new</span>}
                        </td>
                        <td className="num">
                          <button className="small" onClick={() => leaveFor(l)}>Drill</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
