import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Board } from '../components/Board';
import { AdminTabs, formatDate } from '../components/bits';
import { api } from '../lib/api';
import { CLASSIFICATION_META, classifyMove, formatScore, negate } from '../lib/classify';
import { Engine, type EvalResult } from '../lib/engine';
import { START_FEN, moveLabel, playLine, uciToSan } from '../lib/chessutil';
import {
  QUESTIONABLE, isYourPly, leafLines, lineSan, moveFrom, parseMoveText, positionKey, startsWith,
} from '../lib/openings';
import type { Color, LineMoveReview, Opening, OpeningGame, OpeningLine, Settings } from '../lib/types';

const SIDE: Record<Color, string> = { w: 'White', b: 'Black' };

/* ------------------------------------------------------------------- list */

export function AdminOpenings() {
  const navigate = useNavigate();
  const [openings, setOpenings] = useState<Opening[] | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState<Color>('w');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    () => api.openings().then(setOpenings).catch((e) => setError((e as Error).message)),
    []
  );
  useEffect(() => { refresh(); }, [refresh]);

  const create = async () => {
    try {
      const made = await api.createOpening({ name, color });
      navigate(`/admin/openings/${made.id}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="stack">
      <AdminTabs />
      {error && <div className="banner err">{error}</div>}

      <div className="card">
        <div className="card-head"><h2>New opening</h2></div>
        <div className="row" style={{ alignItems: 'flex-end', gap: 14 }}>
          <label className="field" style={{ flex: '1 1 260px' }}>
            <span>Name</span>
            <input
              type="text"
              value={name}
              placeholder="e.g. Italian Game"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && name.trim() && create()}
            />
          </label>
          <label className="field" style={{ width: 150 }}>
            <span>You play</span>
            <select value={color} onChange={(e) => setColor(e.target.value as Color)}>
              <option value="w">White</option>
              <option value="b">Black</option>
            </select>
          </label>
          <button className="primary" disabled={!name.trim()} onClick={create}>Create</button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Your openings</h2>
          <span className="tiny faint">{openings ? `${openings.length} openings` : 'loading…'}</span>
        </div>
        {openings && !openings.length ? (
          <p className="muted tiny" style={{ margin: 0 }}>
            None yet. Create one above, then record the lines you want to drill.
          </p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Opening</th>
                <th>You play</th>
                <th className="num">Lines</th>
                <th>Trainer</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {openings?.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link to={`/admin/openings/${o.id}`}>{o.name}</Link>
                    {o.note && <div className="tiny faint">{o.note}</div>}
                  </td>
                  <td className="tiny">
                    <span className="row-tight"><span className={`side-dot ${o.color}`} />{SIDE[o.color]}</span>
                  </td>
                  <td className="num">{o.line_count || <span className="faint">0</span>}</td>
                  <td className="tiny muted">
                    {!o.enabled ? <span className="faint">hidden</span>
                      : o.line_count ? 'shown' : <span className="faint">no lines yet</span>}
                  </td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>
                    <Link className="btn small" to={`/admin/openings/${o.id}`}>Edit</Link>{' '}
                    <button
                      className="small danger"
                      onClick={() =>
                        confirm(`Delete ${o.name} and its lines?`) &&
                        api.deleteOpening(o.id).then(refresh).catch((e) => setError((e as Error).message))}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="tiny faint" style={{ marginTop: 12, marginBottom: 0 }}>
          Openings are published with the puzzles: <b>Export puzzles.json</b> on the Games tab writes both.
        </p>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- editor */

interface Draft {
  /** null while the line has not been saved yet. */
  id: number | null;
  name: string;
  note: string;
  moves: string[];
}

const EMPTY_DRAFT: Draft = { id: null, name: '', note: '', moves: [] };

/** Where an imported game is cut to begin with: eight moves or so is an opening. */
const IMPORT_PLIES = 16;

/** Keyed by opening, so moving to another one starts from a clean slate. */
export function AdminOpening() {
  const id = Number(useParams().id);
  return <OpeningEditor key={id} openingId={id} />;
}

function OpeningEditor({ openingId }: { openingId: number }) {
  const [opening, setOpening] = useState<Opening | null>(null);
  const [lines, setLines] = useState<OpeningLine[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  // How many of the draft's moves are on the board: 0 is the starting position.
  const [cursor, setCursor] = useState(0);
  // The rest of an imported game, past where the line ends for now.
  const [tail, setTail] = useState<string[]>([]);
  const [paste, setPaste] = useState('');
  // The saved lines and the chess.com games share the space under the editor.
  const [listTab, setListTab] = useState<'lines' | 'import'>('lines');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  // Bumped as engine results land, to redraw the verdicts read from the cache.
  const [evalTick, setEvalTick] = useState(0);

  const engineRef = useRef<Engine | null>(null);
  // Lines in one opening share most of their positions, so each is searched once.
  const evals = useRef(new Map<string, EvalResult>());
  const getEngine = () => (engineRef.current ??= new Engine());

  useEffect(() => {
    let alive = true;
    Promise.all([api.opening(openingId), api.settings()])
      .then(([d, s]) => {
        if (!alive) return;
        setOpening(d.opening);
        setLines(d.lines);
        setSettings(s);
      })
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [openingId]);

  const steps = useMemo(() => playLine(START_FEN, draft.moves), [draft.moves]);
  const fens = useMemo(() => [START_FEN, ...steps.map((s) => s.fen)], [steps]);

  // Check the line as it is entered: every position along it gets a search.
  useEffect(() => {
    if (!settings || fens.length < 2) return;
    let alive = true;
    (async () => {
      for (const fen of fens) {
        if (!alive) return;
        if (evals.current.has(fen)) continue;
        try {
          evals.current.set(fen, await getEngine().analyse(fen, settings.depth));
          if (alive) setEvalTick((t) => t + 1);
        } catch (e) {
          if (alive) setError((e as Error).message);
          return;
        }
      }
    })();
    return () => { alive = false; };
  }, [fens, settings]);

  // Same sums as a game review: a move costs the gap between the score before
  // it and the (negated) score of the position it leads to.
  const review = useMemo<(LineMoveReview | null)[]>(() => {
    if (!settings) return [];
    return steps.map((s, i) => {
      const before = evals.current.get(fens[i]);
      const after = evals.current.get(fens[i + 1]);
      if (!before || !after) return null;
      const evalBefore = before.score;
      const evalAfter = negate(after.score);
      const { classification, wpLoss } = classifyMove({
        evalBefore, evalAfter, playedUci: s.uci, bestUci: before.bestUci, thresholds: settings.thresholds,
      });
      return { bestUci: before.bestUci, evalBefore, evalAfter, wpLoss, classification, depth: before.depth };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps, fens, settings, evalTick]);

  const at = Math.min(cursor, steps.length);

  /** Put a move on the board, replacing whatever the line had from here on. */
  const replaceFrom = useCallback((ply: number, uci: string) => {
    setDraft((d) => (d.moves[ply] === uci ? d : { ...d, moves: [...d.moves.slice(0, ply), uci] }));
    // Leaving the game's moves leaves the rest of the game behind too.
    if (draft.moves[ply] !== uci) setTail((t) => (ply === draft.moves.length && t[0] === uci ? t.slice(1) : []));
    setCursor(ply + 1);
    setStatus(null);
  }, [draft.moves]);
  const play = useCallback((uci: string) => replaceFrom(at, uci), [replaceFrom, at]);

  /** Move the end of the line; what is cut off waits in the tail. */
  const endAt = (ply: number) => {
    const all = [...draft.moves, ...tail];
    setDraft((d) => ({ ...d, moves: all.slice(0, ply) }));
    setTail(all.slice(ply));
    setCursor(ply);
  };

  const edit = (line: OpeningLine | null, moves = line?.moves ?? []) => {
    setDraft(line ? { id: line.id, name: line.name ?? '', note: line.note ?? '', moves } : { ...EMPTY_DRAFT, moves });
    setCursor(moves.length);
    setTail([]);
    setPaste('');
    setError(null);
    setStatus(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && /input|textarea|select/i.test(e.target.tagName)) return;
      if (e.key === 'ArrowLeft') setCursor((c) => Math.max(0, Math.min(c, draft.moves.length) - 1));
      if (e.key === 'ArrowRight') setCursor((c) => Math.min(draft.moves.length, c + 1));
      if (e.key === 'Home') setCursor(0);
      if (e.key === 'End') setCursor(draft.moves.length);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft.moves.length]);

  if (error && !opening) return <div className="banner err">{error}</div>;
  if (!opening || !settings) return <div className="empty"><p className="muted">Loading opening…</p></div>;

  const color = opening.color;
  const flagged = review
    .map((r, i) => ({ r, i, step: steps[i] }))
    .filter((x): x is { r: LineMoveReview; i: number; step: typeof steps[0] } =>
      !!x.r && QUESTIONABLE.includes(x.r.classification));
  const yoursFlagged = flagged.filter((f) => isYourPly(color, f.i)).length;
  const checked = review.filter(Boolean).length;
  const complete = steps.length > 0 && checked === steps.length;
  const endsOnYours = steps.length > 0 && isYourPly(color, steps.length - 1);

  // Where the other lines go from the position on the board, however they reach it.
  const known = new Map<string, number>();
  for (const l of lines) {
    const uci = l.id === draft.id ? undefined : moveFrom(l, positionKey(fens[at]));
    if (uci) known.set(uci, (known.get(uci) ?? 0) + 1);
  }
  const tailSteps = playLine(fens[steps.length], tail);
  const others = lines.filter((l) => l.id !== draft.id);
  const swallowed = endsOnYours
    && others.some((l) => l.moves.length > draft.moves.length && startsWith(l.moves, draft.moves));
  const drilled = new Set(leafLines(lines).map((l) => l.id));

  const save = async () => {
    const body = {
      name: draft.name,
      note: draft.note,
      moves: draft.moves,
      // Half a review would read as a clean bill of health for the rest.
      review: complete ? (review as LineMoveReview[]) : [],
    };
    try {
      const saved = draft.id == null
        ? await api.createLine(openingId, body)
        : await api.patchLine(draft.id, body);
      setLines((list) => [...list.filter((l) => l.id !== saved.id), saved]);
      edit(null);
      setStatus(
        `Saved ${lineSan(saved.moves)}` +
        (yoursFlagged ? ` — with ${yoursFlagged} of your moves questioned by the engine.` : '.')
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const removeLine = async (line: OpeningLine) => {
    try {
      await api.deleteLine(line.id);
      setLines((list) => list.filter((l) => l.id !== line.id));
      if (draft.id === line.id) edit(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const loadPaste = () => {
    const { moves, error: problem } = parseMoveText(paste);
    setDraft((d) => ({ ...d, moves }));
    setCursor(moves.length);
    setTail([]);
    setError(problem);
    if (!problem) setPaste('');
  };

  const importGame = (game: OpeningGame) => {
    let end = Math.min(IMPORT_PLIES, game.moves.length);
    if (end > 0 && !isYourPly(color, end - 1)) end -= 1;
    setDraft({
      id: null,
      name: `vs ${game.opponent ?? 'unknown'} · ${formatDate(game.ended_at)}`,
      note: '',
      moves: game.moves.slice(0, end),
    });
    setTail(game.moves.slice(end));
    setCursor(end);
    setPaste('');
    setError(null);
    setStatus(null);
  };

  return (
    <div className="stack">
      <div className="row">
        <Link to="/admin/openings" className="btn small">← Openings</Link>
        <h1 style={{ marginLeft: 6 }}>{opening.name}</h1>
        <span className="pill"><span className={`side-dot ${color}`} />{SIDE[color]}</span>
        {!opening.enabled && <span className="tiny faint">hidden from the trainer</span>}
        <div className="spacer" />
        {opening.enabled && lines.length > 0 && (
          <a className="btn small" href={`#/openings/${opening.id}`}>Drill</a>
        )}
      </div>

      {error && <div className="banner err">{error}</div>}
      {status && <div className="banner ok">{status}</div>}

      <OpeningCard opening={opening} locked={lines.length > 0} onSaved={setOpening} onError={setError} />

      <div className="cols editor-cols">
        <div className="stack board-pin">
          <Board
            fen={fens[at]}
            orientation={color === 'b' ? 'black' : 'white'}
            onMove={(from, to, promotion) => {
              try {
                const move = new Chess(fens[at]).move({ from, to, promotion: promotion ?? 'q' });
                play(`${move.from}${move.to}${move.promotion ?? ''}`);
                return true;
              } catch {
                return false;
              }
            }}
            lastMove={at > 0 ? { from: steps[at - 1].from, to: steps[at - 1].to } : null}
          />

          <div className="row board-nav">
            <button className="icon" onClick={() => setCursor(0)} disabled={at === 0}>⏮</button>
            <button className="icon" onClick={() => setCursor(at - 1)} disabled={at === 0}>◀</button>
            <button className="icon" onClick={() => setCursor(at + 1)} disabled={at >= steps.length}>▶</button>
            <button className="icon" onClick={() => setCursor(steps.length)} disabled={at >= steps.length}>⏭</button>
            <span className="tiny faint">
              {at === 0 ? 'Starting position' : `${moveLabel(at - 1)} ${steps[at - 1].san}`}
            </span>
          </div>
        </div>

        <div className="stack">
          <div className="card" style={{ borderColor: 'var(--accent)' }}>
            <div className="card-head">
              <h2>{draft.id == null ? 'New line' : 'Edit line'}</h2>
              <span className="tiny faint">play both sides on the board</span>
            </div>

            <dl className="meta-grid">
              <dt>Line</dt>
              <dd className="row-tight" style={{ flexWrap: 'wrap' }}>
                {!steps.length && <span className="faint">no moves yet</span>}
                {steps.map((step, i) => {
                  const r = review[i];
                  const meta = r && QUESTIONABLE.includes(r.classification) ? CLASSIFICATION_META[r.classification] : null;
                  return (
                    <button
                      key={i}
                      className="small mono"
                      title={
                        (isYourPly(color, i) ? 'Your move' : 'Their move') +
                        (meta ? ` — ${meta.label.toLowerCase()}` : !r ? ' — not checked yet' : '')
                      }
                      style={{
                        ...(i === at - 1 ? { borderColor: 'var(--accent)' } : {}),
                        ...(isYourPly(color, i) ? {} : { opacity: 0.75 }),
                      }}
                      onClick={() => setCursor(i + 1)}
                    >
                      {moveLabel(i)} {step.san}
                      {meta && <span style={{ color: meta.color }}>{meta.icon}</span>}
                    </button>
                  );
                })}
                {tailSteps.map((step, j) => {
                  const ply = steps.length + j;
                  return (
                    <button
                      key={`t${j}`}
                      className="small mono ghost"
                      disabled={!isYourPly(color, ply)}
                      title={isYourPly(color, ply) ? 'Later in the game — click to run the line to here' : 'Their move — a line ends on yours'}
                      style={{ borderStyle: 'dashed', opacity: 0.55 }}
                      onClick={() => endAt(ply + 1)}
                    >
                      {moveLabel(ply)} {step.san}
                    </button>
                  );
                })}
                {at > 0 && at < steps.length && (
                  <button className="small" title="Stop the line at the move on the board" onClick={() => endAt(at)}>
                    ✂ End here
                  </button>
                )}
                {steps.length > 0 && (
                  <button
                    className="small ghost"
                    title="Remove the last move"
                    onClick={() => (tail.length ? endAt(steps.length - 1) : (
                      setDraft((d) => ({ ...d, moves: d.moves.slice(0, -1) })),
                      setCursor(steps.length - 1)
                    ))}
                  >
                    − Undo
                  </button>
                )}
              </dd>

              {known.size > 0 && (
                <>
                  <dt>Other lines</dt>
                  <dd className="row-tight" style={{ flexWrap: 'wrap' }}>
                    {[...known].map(([uci, count]) => (
                      <button
                        key={uci}
                        className="small mono"
                        title={`${count} other line${count === 1 ? '' : 's'} continue this way — click to play it`}
                        style={uci === draft.moves[at] ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
                        onClick={() => play(uci)}
                      >
                        {uciToSan(fens[at], uci) ?? uci} <span className="muted">×{count}</span>
                      </button>
                    ))}
                    <span className="tiny faint">
                      {isYourPly(color, at) ? 'your answers here so far' : 'their replies covered so far'}
                    </span>
                  </dd>
                </>
              )}

              <dt>Engine</dt>
              <dd>
                {!steps.length ? (
                  <span className="faint">Stockfish checks each move as you enter it.</span>
                ) : !complete ? (
                  <span className="muted">Checking move {checked + 1} of {steps.length}…</span>
                ) : !flagged.length ? (
                  <span style={{ color: 'var(--c-best)' }}>
                    ✓ No complaints at depth {settings.depth}.
                  </span>
                ) : (
                  <span style={{ color: yoursFlagged ? 'var(--c-mistake)' : undefined }}>
                    {flagged.length} move{flagged.length === 1 ? '' : 's'} questioned
                    {yoursFlagged ? ` — ${yoursFlagged} of them yours.` : ', none of them yours.'}
                  </span>
                )}
              </dd>
            </dl>

            {flagged.length > 0 && (
              <table className="table" style={{ marginTop: 10 }}>
                <tbody>
                  {flagged.map(({ r, i, step }) => {
                    const meta = CLASSIFICATION_META[r.classification];
                    const yours = isYourPly(color, i);
                    const best = uciToSan(fens[i], r.bestUci);
                    return (
                      <tr key={i} style={yours ? undefined : { opacity: 0.7 }}>
                        <td className="mono" style={{ width: 96 }}>
                          <button className="mv" onClick={() => setCursor(i + 1)}>
                            {moveLabel(i)} {step.san}
                          </button>
                        </td>
                        <td style={{ width: 112, color: meta.color }} className="tiny">
                          {meta.icon} {meta.label}
                        </td>
                        <td className="tiny muted">
                          {yours ? 'yours' : 'theirs'} · engine prefers{' '}
                          <button
                            className="small mono"
                            disabled={!r.bestUci}
                            title="Replace this move with the engine's — everything after it is dropped"
                            onClick={() => replaceFrom(i, r.bestUci!)}
                          >
                            {best ?? '—'}
                          </button>{' '}
                          <span className="mono">
                            {formatScore(r.evalBefore, i % 2 === 0)} → {formatScore(r.evalAfter, i % 2 === 0)}
                          </span>
                          <span className="faint"> · −{r.wpLoss.toFixed(0)}%</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {steps.length > 0 && !endsOnYours && (
              <p className="tiny faint" style={{ marginTop: 10, marginBottom: 0 }}>
                A line ends on your own move — add {SIDE[color]}'s answer to {steps[steps.length - 1].san}.
              </p>
            )}
            {tail.length > 0 && (
              <p className="tiny faint" style={{ marginTop: 10, marginBottom: 0 }}>
                From a game: the dashed moves are how it went on. Click one of yours to run the line that
                far, or select an earlier move and press End here.
              </p>
            )}
            {swallowed && (
              <p className="tiny faint" style={{ marginTop: 10, marginBottom: 0 }}>
                A longer line already starts with these moves, so this one will not be drilled on its own.
              </p>
            )}

            <div className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
              <label className="field" style={{ flex: '1 1 220px' }}>
                <span>Or type the moves</span>
                <input
                  type="text"
                  className="mono"
                  value={paste}
                  placeholder="1. e4 e5 2. Nf3 Nc6 3. Bc4"
                  onChange={(e) => setPaste(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && paste.trim() && loadPaste()}
                />
              </label>
              <button disabled={!paste.trim()} onClick={loadPaste}>Load</button>
            </div>

            <div className="row" style={{ marginTop: 12, alignItems: 'flex-end' }}>
              <label className="field" style={{ flex: '1 1 180px' }}>
                <span>Line name (optional)</span>
                <input
                  type="text"
                  value={draft.name}
                  placeholder="e.g. Giuoco Piano, main line"
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label className="field" style={{ flex: '2 1 240px' }}>
                <span>Note (optional, shown after the drill)</span>
                <input
                  type="text"
                  value={draft.note}
                  placeholder="e.g. c3 and d4 next — build the centre"
                  onChange={(e) => setDraft({ ...draft, note: e.target.value })}
                />
              </label>
            </div>

            <div className="row" style={{ marginTop: 12 }}>
              <button className="primary" disabled={!endsOnYours} onClick={save}>
                {draft.id == null ? 'Save line' : 'Update line'}
              </button>
              <button className="ghost" disabled={draft.id == null && !steps.length} onClick={() => edit(null)}>
                {draft.id == null ? 'Clear' : 'Cancel'}
              </button>
            </div>
          </div>

          <div className="row">
            {(['lines', 'import'] as const).map((tab) => (
              <button
                key={tab}
                className="small"
                style={listTab === tab ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
                onClick={() => setListTab(tab)}
              >
                {tab === 'lines' ? `Lines (${lines.length})` : 'Import from chess.com'}
              </button>
            ))}
          </div>

          <div className="card" style={listTab === 'lines' ? undefined : { display: 'none' }}>
            <div className="card-head">
              <h2>Lines</h2>
              <span className="tiny faint">{lines.length}</span>
            </div>
            {!lines.length ? (
              <p className="tiny faint" style={{ margin: 0 }}>
                None yet. Play a line out on the board and save it. Lines that share their first moves
                become one tree: the trainer accepts any of your recorded answers and follows that branch.
              </p>
            ) : (
              <div className="scroll-list"><table className="table">
                <tbody>
                  {[...lines].sort((a, b) => a.moves.join(' ').localeCompare(b.moves.join(' '))).map((l) => (
                    <tr key={l.id} style={l.id === draft.id ? { background: 'var(--accent-soft)' } : undefined}>
                      <td>
                        {l.name && <div>{l.name}</div>}
                        <div className="mono tiny muted">{lineSan(l.moves)}</div>
                        <div className="tiny"><LineVerdict line={l} color={color} drilled={drilled.has(l.id)} /></div>
                      </td>
                      <td className="num" style={{ whiteSpace: 'nowrap' }}>
                        <button className="small" onClick={() => edit(l)}>Edit</button>{' '}
                        <button
                          className="small"
                          title="Start a new line from these moves — step back and play a different one"
                          onClick={() => edit(null, l.moves)}
                        >
                          Branch
                        </button>{' '}
                        <button className="small danger" onClick={() => removeLine(l)}>×</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            )}
          </div>

          {/* Hidden rather than unmounted, so the fetched games survive a look at the lines. */}
          <div style={listTab === 'import' ? undefined : { display: 'none' }}>
            <ImportGamesCard color={color} lines={lines} username={settings.heroUsername} onImport={importGame} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- sub-views */

const PAGE = 100;

/**
 * Every game an account played as this opening's side, oldest first, each one
 * a line waiting to be cut. chess.com files games by month, so they arrive a
 * month at a time.
 */
function ImportGamesCard({
  color,
  lines,
  username,
  onImport,
}: {
  color: Color;
  lines: OpeningLine[];
  username: string;
  onImport: (game: OpeningGame) => void;
}) {
  const [name, setName] = useState(username);
  const [games, setGames] = useState<OpeningGame[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  // Bumped to abandon a load in flight: a new fetch, Stop, or leaving the page.
  const run = useRef(0);
  useEffect(() => () => { run.current++; }, []);

  const load = async () => {
    const token = ++run.current;
    setError(null);
    setGames([]);
    setLimit(PAGE);
    try {
      const months = await api.chesscomMonths(name.trim());
      for (let i = 0; i < months.length && token === run.current; i++) {
        setProgress({ done: i, total: months.length });
        const batch = await api.chesscomOpeningGames(name.trim(), months[i], color);
        if (token !== run.current) return;
        setGames((list) => [...(list ?? []), ...batch]);
      }
    } catch (e) {
      if (token === run.current) setError((e as Error).message);
    } finally {
      if (token === run.current) setProgress(null);
    }
  };

  const term = query.trim().toLowerCase();
  const hits = useMemo(
    () => (games ?? []).filter((g) =>
      !term || [g.opponent, g.opening, g.time_class, g.result].some((f) => f?.toLowerCase().includes(term))),
    [games, term]
  );

  return (
    <div className="card">
      <div className="card-head">
        <h2>Import from chess.com games</h2>
        <input
          type="text"
          style={{ width: 200 }}
          value={name}
          placeholder="username"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && name.trim() && !progress && load()}
        />
        {progress ? (
          <button className="small danger" onClick={() => { run.current++; setProgress(null); }}>Stop</button>
        ) : (
          <button className="small" disabled={!name.trim()} onClick={load}>Fetch games as {SIDE[color]}</button>
        )}
      </div>

      {error && <div className="banner err">{error}</div>}
      {progress && (
        <>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
          </div>
          <p className="tiny faint" style={{ marginTop: 7 }}>
            Month {progress.done + 1} of {progress.total} · {games?.length ?? 0} games so far
          </p>
        </>
      )}

      {!games ? (
        <p className="tiny faint" style={{ margin: 0 }}>
          Lists every standard game the account played as {SIDE[color]}, oldest first. Import one to load its
          moves into the editor above, choose where the line stops, and save it.
        </p>
      ) : !games.length ? (
        !progress && !error && <p className="tiny faint" style={{ margin: 0 }}>No games as {SIDE[color]} on that account.</p>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 8 }}>
            <input
              type="search"
              style={{ width: 260 }}
              value={query}
              placeholder="filter by opponent or opening"
              onChange={(e) => { setQuery(e.target.value); setLimit(PAGE); }}
            />
            <span className="tiny faint">
              {term ? `${hits.length} of ${games.length} games` : `${games.length} games`}
            </span>
          </div>
          <div className="scroll-list"><table className="table">
            <thead>
              <tr>
                <th>Finished</th>
                <th>Opponent</th>
                <th>Result</th>
                <th>Opening</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {hits.slice(0, limit).map((g, i) => {
                const imported = lines.some((l) => startsWith(g.moves, l.moves));
                return (
                  <tr key={g.url ?? i}>
                    <td className="tiny muted" style={{ whiteSpace: 'nowrap' }}>{formatDate(g.ended_at)}</td>
                    <td>
                      {g.opponent} {g.opponent_elo && <span className="faint">({g.opponent_elo})</span>}
                      <div className="tiny faint">{g.time_class}</div>
                    </td>
                    <td className="tiny">{g.result}</td>
                    <td className="tiny muted">
                      {g.opening ?? '—'}
                      <div className="mono faint">{lineSan(g.moves.slice(0, 8))} …</div>
                    </td>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>
                      {g.url && <a className="btn small" href={g.url} target="_blank" rel="noreferrer">chess.com ↗</a>}{' '}
                      <button
                        className={imported ? 'small' : 'small primary'}
                        title={imported ? 'A saved line already follows this game' : undefined}
                        onClick={() => onImport(g)}
                      >
                        {imported ? 'Imported ✓' : 'Import'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table></div>
          {hits.length > limit && (
            <div className="row" style={{ marginTop: 10, justifyContent: 'center' }}>
              <button className="small" onClick={() => setLimit(limit + PAGE)}>
                Show {Math.min(PAGE, hits.length - limit)} more
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** What the engine made of a saved line, from the review stored with it. */
function LineVerdict({ line, color, drilled }: { line: OpeningLine; color: Color; drilled: boolean }) {
  const notes: React.ReactNode[] = [];
  if (line.review.length !== line.moves.length) {
    notes.push(<span key="u" className="faint">not engine-checked — edit and update it to check</span>);
  } else {
    const bad = line.review
      .map((r, i) => ({ r, i }))
      .filter(({ r, i }) => isYourPly(color, i) && QUESTIONABLE.includes(r.classification));
    notes.push(
      bad.length ? (
        <span key="b" style={{ color: 'var(--c-mistake)' }}>
          ⚠ {bad.length} of your moves questioned
        </span>
      ) : (
        <span key="g" className="faint">✓ engine-checked</span>
      )
    );
  }
  if (!drilled) notes.push(<span key="p" className="faint"> · part of a longer line</span>);
  return <>{notes}</>;
}

function OpeningCard({
  opening,
  locked,
  onSaved,
  onError,
}: {
  opening: Opening;
  /** Lines end on the trained side's move, so the side is fixed once there are any. */
  locked: boolean;
  onSaved: (o: Opening) => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState(opening);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    try {
      onSaved(await api.patchOpening(opening.id, {
        name: draft.name, color: draft.color, note: draft.note, enabled: draft.enabled,
      }));
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2>Opening</h2>
        <button className="small primary" disabled={!draft.name.trim()} onClick={save}>
          {saved ? 'Saved' : 'Save'}
        </button>
      </div>
      <div className="row" style={{ alignItems: 'flex-end', gap: 14 }}>
        <label className="field" style={{ flex: '1 1 200px' }}>
          <span>Name</span>
          <input type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <label
          className="field"
          style={{ width: 130 }}
          title={locked ? 'Remove the lines to switch sides' : undefined}
        >
          <span>You play</span>
          <select
            value={draft.color}
            disabled={locked}
            onChange={(e) => setDraft({ ...draft, color: e.target.value as Color })}
          >
            <option value="w">White</option>
            <option value="b">Black</option>
          </select>
        </label>
        <label className="field" style={{ flex: '2 1 260px' }}>
          <span>Note (optional)</span>
          <input
            type="text"
            value={draft.note ?? ''}
            placeholder="e.g. my answer to 1. e4"
            onChange={(e) => setDraft({ ...draft, note: e.target.value })}
          />
        </label>
        <label className="checkbox" style={{ paddingBottom: 9 }}>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          />
          Show in trainer
        </label>
      </div>
    </div>
  );
}
