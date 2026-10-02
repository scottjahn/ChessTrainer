import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Chess } from 'chess.js';
import { Board } from '../components/Board';
import { ClassPill, formatDate, formatTimeControl } from '../components/bits';
import { api, type GameDetail } from '../lib/api';
import { CLASSIFICATION_META, classifyMove, formatScore, negate, winPercent } from '../lib/classify';
import { Engine, type EngineLine } from '../lib/engine';
import { moveLabel, playLine, pvToSan, uciToSan, type LineStep } from '../lib/chessutil';
import type { AnalysisRow, Classification, Game, Puzzle, Score, Settings } from '../lib/types';

const FLAGGED: Classification[] = ['blunder', 'miss', 'mistake'];

/** How many of the engine's best moves to weigh up as answers to a puzzle. */
const CANDIDATES = 3;

interface Draft {
  uci: string;
  note: string;
  alts: string[];
  /** What follows the answer in a multi-move puzzle: reply, your move, reply, … */
  line: string[];
}

const EMPTY_DRAFT: Draft = { uci: '', note: '', alts: [], line: [] };

interface Progress {
  done: number;
  total: number;
  label: string;
}

/** Keyed by game, so stepping to the next one starts from a clean slate. */
export function AdminGame() {
  const gameId = Number(useParams().id);
  return <GameReview key={gameId} gameId={gameId} />;
}

function GameReview({ gameId }: { gameId: number }) {
  const [search, setSearch] = useSearchParams();
  const [detail, setDetail] = useState<GameDetail | null>(null);
  // The games either side of this one, in the library's order.
  const [neighbours, setNeighbours] = useState<{ prev: Game | null; next: Game | null }>({ prev: null, next: null });
  const [settings, setSettings] = useState<Settings | null>(null);
  const [rows, setRows] = useState<Map<number, AnalysisRow>>(new Map());
  const [puzzles, setPuzzles] = useState<Puzzle[]>([]);
  const [viewPly, setViewPly] = useState(-1);
  const [editPly, setEditPly] = useState<number | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  // When true, the next move played on the board is added as an extra accepted
  // answer rather than replacing the main one.
  const [addingAlt, setAddingAlt] = useState(false);
  // Which move of the answer line the board is on: 0 is the answer itself.
  const [cursor, setCursor] = useState(0);
  const [candidates, setCandidates] = useState<EngineLine[] | null>(null);
  const [lineBusy, setLineBusy] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const engineRef = useRef<Engine | null>(null);
  const cancelRef = useRef(false);
  // Only a brand-new puzzle gets the engine's near-equal moves added for it;
  // a saved one keeps exactly the answers it was saved with.
  const autoAltRef = useRef(false);
  // Bumped whenever the line changes by hand, to drop an engine reply in flight.
  const lineToken = useRef(0);

  const getEngine = () => (engineRef.current ??= new Engine());

  useEffect(() => {
    let alive = true;
    Promise.all([api.game(gameId), api.settings()])
      .then(([d, s]) => {
        if (!alive) return;
        setDetail(d);
        setSettings(s);
        setPuzzles(d.puzzles);
        setRows(new Map(d.analysis.map((r) => [r.ply, r])));
      })
      .catch((e) => alive && setError(e.message));
    api.games()
      .then((games) => {
        if (!alive) return;
        const i = games.findIndex((g) => g.id === gameId);
        if (i >= 0) setNeighbours({ prev: games[i - 1] ?? null, next: games[i + 1] ?? null });
      })
      .catch(() => { /* without the list there is just nothing to step to */ });
    return () => {
      alive = false;
      // Leaving mid-analysis must not save the half-finished scan.
      cancelRef.current = true;
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [gameId]);

  /* ------------------------------------------------------------- analysis */

  const analyse = useCallback(async () => {
    if (!detail || !settings) return;
    cancelRef.current = false;
    setError(null);
    setStatus(null);

    const { plies, finalFen } = detail;
    const positions = [...plies.map((p) => p.fenBefore), finalFen];
    const depth = settings.depth;

    setProgress({ done: 0, total: positions.length, label: 'Starting engine…' });
    const engine = getEngine();

    try {
      await engine.init();
    } catch (e) {
      setProgress(null);
      setError((e as Error).message);
      return;
    }

    const scores: (Score | null)[] = [];
    const bests: (string | null)[] = [];

    for (let i = 0; i < positions.length; i++) {
      if (cancelRef.current) break;
      setProgress({
        done: i,
        total: positions.length,
        label: i < plies.length ? `${moveLabel(i)} ${plies[i].san}` : 'final position',
      });
      try {
        const result = await engine.analyse(positions[i], depth);
        scores[i] = result.score;
        bests[i] = result.bestUci;
      } catch (e) {
        setError((e as Error).message);
        break;
      }
    }

    if (cancelRef.current) {
      setProgress(null);
      setStatus('Analysis stopped.');
      return;
    }

    // Evaluating every position once gives both sides of each move: the score
    // before it, and the score after it (which is the next position's score,
    // negated because the side to move has flipped).
    const computed = plies.map((p, i) => {
      const evalBefore = scores[i] ?? null;
      const evalAfter = negate(scores[i + 1] ?? null);
      const bestUci = bests[i] ?? null;
      const { classification, wpLoss } = classifyMove({
        evalBefore,
        evalAfter,
        playedUci: p.uci,
        bestUci,
        isBook: i < settings.skipOpeningPlies,
        thresholds: settings.thresholds,
      });
      return {
        ply: p.ply,
        fenBefore: p.fenBefore,
        color: p.color,
        san: p.san,
        uci: p.uci,
        bestUci,
        bestSan: uciToSan(p.fenBefore, bestUci),
        evalBefore,
        evalAfter,
        wpLoss,
        classification,
        depth,
      };
    });

    setProgress({ done: positions.length, total: positions.length, label: 'Saving…' });
    try {
      await api.saveAnalysis(gameId, computed, depth);
      const fresh = await api.game(gameId);
      setDetail(fresh);
      setRows(new Map(fresh.analysis.map((r) => [r.ply, r])));
      // Count what the flagged list will show, so the two numbers agree.
      const heroOnly = settings.onlyHeroMoves && fresh.game.hero_color;
      const flagged = computed.filter((c) =>
        FLAGGED.includes(c.classification) && (!heroOnly || c.color === fresh.game.hero_color)
      ).length;
      setStatus(
        `Analysed ${plies.length} moves at depth ${depth} — ${flagged} ${heroOnly ? 'of yours ' : ''}worth a look.`
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setProgress(null);
    }
  }, [detail, settings, gameId]);

  // A game nobody has analysed yet has nothing to review, so start the engine
  // on first view. Only once per game: stopping it shouldn't restart it.
  const autoAnalysedRef = useRef<number | null>(null);
  useEffect(() => {
    if (!detail || !settings || autoAnalysedRef.current === gameId) return;
    autoAnalysedRef.current = gameId;
    if (!detail.game.analyzed_at && !detail.analysis.length) analyse();
  }, [detail, settings, gameId, analyse]);

  const stopAnalysis = () => {
    cancelRef.current = true;
    engineRef.current?.stop();
  };

  /* -------------------------------------------------------------- puzzles */

  const startEdit = useCallback(
    (ply: number) => {
      const existing = puzzles.find((p) => p.ply === ply);
      const row = rows.get(ply);
      setEditPly(ply);
      setViewPly(ply - 1);
      setAddingAlt(false);
      setCursor(0);
      autoAltRef.current = !existing;
      setDraft({
        uci: existing?.solution_uci ?? row?.best_uci ?? '',
        note: existing?.note ?? '',
        alts: existing?.alt_solutions ?? [],
        line: existing?.continuation ?? [],
      });
    },
    [puzzles, rows]
  );

  const stopEdit = useCallback(() => {
    setEditPly(null);
    setDraft(null);
    setAddingAlt(false);
    setCursor(0);
  }, []);

  // The game scan keeps one best move per position. A puzzle wants to know
  // whether that move stands alone, so search its position again for the top few.
  const editFen = editPly != null && detail ? detail.plies[editPly].fenBefore : null;
  const playedUci = editPly != null && detail ? detail.plies[editPly].uci : null;
  useEffect(() => {
    lineToken.current++;
    setLineBusy(false);
    setCandidates(null);
    if (!editFen || !settings) return;
    let alive = true;
    getEngine()
      .analyse(editFen, settings.depth, CANDIDATES)
      .then(({ lines }) => {
        if (!alive) return;
        setCandidates(lines);
        if (!autoAltRef.current || !lines.length) return;
        autoAltRef.current = false;
        const best = winPercent(lines[0].score);
        const close = lines
          .filter((l) => best - winPercent(l.score) <= settings.altMargin)
          .map((l) => l.uci);
        setDraft((d) => {
          if (!d) return d;
          const uci = d.uci || close[0];
          const extra = close.filter((c) => c !== uci && c !== playedUci && !d.alts.includes(c));
          return { ...d, uci, alts: [...d.alts, ...extra] };
        });
      })
      .catch(() => { /* the candidates are a convenience; the editor works without them */ });
    return () => { alive = false; };
  }, [editFen, playedUci, settings]);

  /**
   * Let the engine play on from the end of `base`. A line has to end on the
   * solver's move, so a reply the engine could not answer is dropped again.
   */
  const growLine = useCallback(
    async (base: string[], count: number) => {
      if (!editFen || !settings) return;
      const token = ++lineToken.current;
      setLineBusy(true);
      let moves = base;
      try {
        for (let i = 0; i < count; i++) {
          const steps = playLine(editFen, moves);
          if (steps.length !== moves.length) break;
          const result = await getEngine().analyse(steps[steps.length - 1].fen, settings.depth);
          if (token !== lineToken.current) return;
          if (!result.bestUci) break;
          moves = [...moves, result.bestUci];
        }
        if (moves.length % 2 === 0) moves = moves.slice(0, -1);
        setDraft((d) => (d && d.uci === moves[0] ? { ...d, line: moves.slice(1) } : d));
        setCursor(moves.length - 1);
      } catch (e) {
        if (token === lineToken.current) setError((e as Error).message);
      } finally {
        if (token === lineToken.current) setLineBusy(false);
      }
    },
    [editFen, settings]
  );

  // ?puzzle=<id> arrives from the admin's finder: open that one for editing.
  const wantedPuzzle = search.get('puzzle');
  useEffect(() => {
    if (!detail || !wantedPuzzle) return;
    const match = puzzles.find((p) => String(p.id) === wantedPuzzle);
    if (match) startEdit(match.ply);
    else setError(`Puzzle ${wantedPuzzle} does not belong to this game.`);
    // Drop the parameter so a later edit of another puzzle is not undone by it.
    setSearch({}, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, wantedPuzzle]);

  const savePuzzle = useCallback(async () => {
    if (editPly == null || !draft?.uci || !detail) return;
    const ply = detail.plies[editPly];
    const row = rows.get(editPly);
    const prev = editPly > 0 ? detail.plies[editPly - 1] : null;

    try {
      const saved = await api.savePuzzle({
        game_id: gameId,
        ply: editPly,
        fen: ply.fenBefore,
        side_to_move: ply.color,
        played_san: ply.san,
        played_uci: ply.uci,
        solution_uci: draft.uci,
        alt_solutions: draft.alts,
        // Whole reply/answer pairs only, so the puzzle ends on the solver's move.
        continuation: draft.line.slice(0, draft.line.length - (draft.line.length % 2)),
        classification: row?.classification ?? 'mistake',
        wp_loss: row?.wp_loss ?? null,
        eval_before: row?.eval_before ?? null,
        eval_after: row?.eval_after ?? null,
        fen_prev: prev?.fenBefore ?? null,
        prev_san: prev?.san ?? null,
        prev_uci: prev?.uci ?? null,
        note: draft.note.trim() || null,
      });
      setPuzzles((list) => [...list.filter((p) => p.ply !== editPly), saved].sort((a, b) => a.ply - b.ply));
      stopEdit();
      setStatus(`Saved puzzle: ${moveLabel(editPly)} ${saved.solution_san}`);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [editPly, draft, detail, rows, gameId, stopEdit]);

  const removePuzzle = useCallback(async (id: number) => {
    await api.deletePuzzle(id);
    setPuzzles((list) => list.filter((p) => p.id !== id));
  }, []);

  /* ------------------------------------------------------------ keyboard */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && /input|textarea|select/i.test(e.target.tagName)) return;
      if (!detail) return;
      if (e.key === 'ArrowLeft') setViewPly((p) => Math.max(-1, p - 1));
      if (e.key === 'ArrowRight') setViewPly((p) => Math.min(detail.plies.length - 1, p + 1));
      if (e.key === 'Home') setViewPly(-1);
      if (e.key === 'End') setViewPly(detail.plies.length - 1);
      if (e.key === 'Escape') stopEdit();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [detail, stopEdit]);

  /* ---------------------------------------------------------------- view */

  const flagged = useMemo(() => {
    if (!detail || !settings) return [];
    return detail.plies
      .map((p) => ({ ply: p, row: rows.get(p.ply) }))
      .filter(({ ply, row }) => {
        if (!row?.classification || !FLAGGED.includes(row.classification)) return false;
        if (settings.onlyHeroMoves && detail.game.hero_color) {
          return ply.color === detail.game.hero_color;
        }
        return true;
      });
  }, [detail, rows, settings]);

  if (error && !detail) return <div className="banner err">{error}</div>;
  if (!detail || !settings) return <div className="empty"><p className="muted">Loading game…</p></div>;

  const { game, plies } = detail;
  const editing = editPly != null;
  // The answer and everything after it, replayed from the puzzle position.
  const fullLine = editing && draft?.uci ? [draft.uci, ...draft.line] : [];
  const lineSteps = editing ? playLine(plies[editPly].fenBefore, fullLine) : [];
  const at = Math.min(cursor, Math.max(lineSteps.length - 1, 0));
  const editBoardFen = editing ? (at > 0 ? lineSteps[at - 1].fen : plies[editPly].fenBefore) : '';

  const boardFen = editing
    ? editBoardFen
    : viewPly < 0
      ? plies[0]?.fenBefore ?? detail.finalFen
      : plies[viewPly].fenAfter;

  const orientation = game.hero_color === 'b' ? 'black' : 'white';
  const shownMove = editing ? null : viewPly >= 0 ? plies[viewPly] : null;

  const draftSan = editing && draft?.uci ? uciToSan(plies[editPly].fenBefore, draft.uci) : null;
  const editRow = editing ? rows.get(editPly) : undefined;

  const arrow = (uci: string, color: string) => (
    { startSquare: uci.slice(0, 2), endSquare: uci.slice(2, 4), color }
  );
  // Red for the move actually played, green for the solution, faint green for
  // accepted alternatives. One arrow per pair of squares, solution winning.
  // Further down the line there is only the one move to show.
  const arrows = !editing
    ? []
    : at > 0
      ? [arrow(lineSteps[at].uci, 'rgba(127,166,80,.9)')]
      : [
      ...(draft?.uci ? [arrow(draft.uci, 'rgba(127,166,80,.9)')] : []),
      ...(draft?.alts ?? []).map((uci) => arrow(uci, 'rgba(127,166,80,.4)')),
      arrow(plies[editPly].uci, 'rgba(208,87,74,.9)'),
    ].filter((a, i, all) =>
      all.findIndex((b) => b.startSquare === a.startSquare && b.endSquare === a.endSquare) === i
    );

  return (
    <div className="stack">
      <div className="row">
        <Link to="/admin" className="btn small">← Library</Link>
        <h1 style={{ marginLeft: 6 }}>
          {game.white} <span className="faint">vs</span> {game.black}
        </h1>
        <span className="pill">{game.result}</span>
        <span className="tiny muted">
          {formatDate(game.played_at)} · {formatTimeControl(game.time_control, game.time_class)}
        </span>
        <div className="spacer" />
        <GameStep game={neighbours.prev} label="← Previous" />
        <GameStep game={neighbours.next} label="Next →" />
        {game.url && <a className="btn small" href={game.url} target="_blank" rel="noreferrer">chess.com ↗</a>}
      </div>

      {error && <div className="banner err">{error}</div>}
      {status && <div className="banner ok">{status}</div>}
      {!game.hero_color && (
        <div className="banner info row">
          <span>
            Neither player matches your username, so "my mistakes" cannot be worked out.
            Which side were you?
          </span>
          <div className="spacer" />
          {(['w', 'b'] as const).map((color) => {
            const who = color === 'w' ? game.white : game.black;
            return (
              <button
                key={color}
                className="small"
                disabled={!who}
                onClick={() =>
                  api
                    .patchGame(gameId, { hero: who ?? '' })
                    .then((updated) => setDetail((d) => (d ? { ...d, game: updated } : d)))
                    .catch((e) => setError((e as Error).message))
                }
              >
                <span className={`side-dot ${color}`} />
                {who ?? (color === 'w' ? 'White' : 'Black')}
              </button>
            );
          })}
        </div>
      )}

      <AnalysisBar
        progress={progress}
        analysed={rows.size > 0}
        depth={game.analysis_depth}
        multiThreaded={engineRef.current?.multiThreaded}
        onRun={analyse}
        onStop={stopAnalysis}
      />

      <div className="cols">
        <div className="stack">
          <Board
            fen={boardFen}
            orientation={orientation}
            onMove={
              editing
                ? (from, to, promotion) => {
                  const chess = new Chess(editBoardFen);
                  const move = chess.move({ from, to, promotion: promotion ?? 'q' });
                  if (!move) return false;
                  const uci = `${move.from}${move.to}${move.promotion ?? ''}`;
                  if (at > 0) {
                    // Overriding a move further down: what came after it no
                    // longer follows, and a new reply needs a new answer.
                    if (uci === fullLine[at]) return true;
                    const moves = [...fullLine.slice(0, at), uci];
                    lineToken.current++;
                    setLineBusy(false);
                    setDraft((d) => (d ? { ...d, line: moves.slice(1) } : d));
                    if (at % 2 === 1) growLine(moves, 1);
                    return true;
                  }
                  if (!addingAlt && uci !== draft?.uci) {
                    lineToken.current++;
                    setLineBusy(false);
                  }
                  setDraft((d) => {
                    const base = d ?? EMPTY_DRAFT;
                    if (!addingAlt) {
                      // A different answer leaves the old follow-up dangling.
                      const line = uci === base.uci ? base.line : [];
                      return { ...base, uci, line, alts: base.alts.filter((a) => a !== uci) };
                    }
                    if (uci === base.uci || base.alts.includes(uci)) return base;
                    return { ...base, alts: [...base.alts, uci] };
                  });
                  setAddingAlt(false);
                  return true;
                }
                : undefined
            }
            arrows={arrows}
            lastMove={
              editing && at > 0
                ? { from: lineSteps[at - 1].from, to: lineSteps[at - 1].to }
                : shownMove ? { from: shownMove.from, to: shownMove.to } : null
            }
          />

          {editing ? (
            <PuzzleEditor
              ply={editPly}
              row={editRow}
              played={plies[editPly]}
              draftSan={draftSan}
              note={draft?.note ?? ''}
              onNote={(note) => setDraft((d) => ({ ...(d ?? EMPTY_DRAFT), note }))}
              onUseBest={() => {
                const uci = editRow?.best_uci ?? '';
                lineToken.current++;
                setLineBusy(false);
                setCursor(0);
                setDraft((d) => {
                  const base = d ?? EMPTY_DRAFT;
                  return {
                    ...base,
                    uci,
                    line: uci === base.uci ? base.line : [],
                    alts: base.alts.filter((a) => a !== uci),
                  };
                });
              }}
              candidates={candidates}
              mainUci={draft?.uci ?? ''}
              onToggleCandidate={(uci) =>
                setDraft((d) => {
                  if (!d || uci === d.uci) return d;
                  return {
                    ...d,
                    alts: d.alts.includes(uci) ? d.alts.filter((a) => a !== uci) : [...d.alts, uci],
                  };
                })}
              steps={lineSteps}
              cursor={at}
              lineBusy={lineBusy}
              onCursor={(i) => { setCursor(i); setAddingAlt(false); }}
              onExtend={() => growLine(fullLine, 2)}
              onTrim={() => {
                lineToken.current++;
                setLineBusy(false);
                setCursor(0);
                setDraft((d) => (d ? { ...d, line: d.line.slice(0, Math.max(0, d.line.length - 2)) } : d));
              }}
              alts={draft?.alts ?? []}
              altSans={(draft?.alts ?? []).map((a) => ({ uci: a, san: uciToSan(plies[editPly].fenBefore, a) }))}
              addingAlt={addingAlt}
              onToggleAlt={() => setAddingAlt((v) => !v)}
              onRemoveAlt={(uci) =>
                setDraft((d) => (d ? { ...d, alts: d.alts.filter((a) => a !== uci) } : d))}
              onCancel={stopEdit}
              onSave={savePuzzle}
              existing={puzzles.find((p) => p.ply === editPly)}
            />
          ) : (
            <div className="row">
              <button className="icon" onClick={() => setViewPly(-1)} disabled={viewPly < 0}>⏮</button>
              <button className="icon" onClick={() => setViewPly((p) => Math.max(-1, p - 1))} disabled={viewPly < 0}>◀</button>
              <button
                className="icon"
                onClick={() => setViewPly((p) => Math.min(plies.length - 1, p + 1))}
                disabled={viewPly >= plies.length - 1}
              >▶</button>
              <button
                className="icon"
                onClick={() => setViewPly(plies.length - 1)}
                disabled={viewPly >= plies.length - 1}
              >⏭</button>
              <span className="tiny faint">
                {viewPly < 0 ? 'Starting position' : `${moveLabel(viewPly)} ${plies[viewPly].san}`}
              </span>
              <div className="spacer" />
              {viewPly >= 0 && (
                <button className="small" onClick={() => startEdit(viewPly)}>
                  Make this a puzzle
                </button>
              )}
            </div>
          )}

          <FlaggedList
            flagged={flagged}
            puzzles={puzzles}
            onPick={startEdit}
          />
        </div>

        <div className="stack">
          <SavedPuzzles puzzles={puzzles} onEdit={startEdit} onRemove={removePuzzle} />

          <div className="card">
            <div className="card-head"><h2>Moves</h2></div>
            <MoveList
              plies={plies}
              rows={rows}
              current={editing ? editPly : viewPly}
              onSelect={(ply) => { stopEdit(); setViewPly(ply); }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- sub-views */

function GameStep({ game, label }: { game: Game | null; label: string }) {
  if (!game) return <button className="small" disabled>{label}</button>;
  return (
    <Link
      className="btn small"
      to={`/admin/game/${game.id}`}
      title={`${game.white} vs ${game.black} · ${formatDate(game.played_at)}`}
    >
      {label}
    </Link>
  );
}

function AnalysisBar({
  progress,
  analysed,
  depth,
  multiThreaded,
  onRun,
  onStop,
}: {
  progress: Progress | null;
  analysed: boolean;
  depth: number | null;
  multiThreaded?: boolean;
  onRun: () => void;
  onStop: () => void;
}) {
  const pct = progress ? (progress.done / Math.max(1, progress.total)) * 100 : 0;
  return (
    <div className="card">
      <div className="card-head">
        <h2>Engine review</h2>
        {analysed && !progress && (
          <span className="tiny faint">already analysed{depth ? ` at depth ${depth}` : ''}</span>
        )}
        {progress ? (
          <button className="danger small" onClick={onStop}>Stop</button>
        ) : (
          <button className="primary small" onClick={onRun}>
            {analysed ? 'Re-analyse' : 'Analyse game'}
          </button>
        )}
      </div>

      {progress ? (
        <>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <p className="tiny faint" style={{ marginTop: 7, marginBottom: 0 }}>
            {progress.done} / {progress.total} positions · {progress.label}
          </p>
        </>
      ) : (
        <p className="tiny faint" style={{ margin: 0 }}>
          Stockfish scores every position, then labels each move by how much win probability it cost.
          {multiThreaded === false && ' Running single-threaded.'}
        </p>
      )}
    </div>
  );
}

function PuzzleEditor({
  ply,
  row,
  played,
  draftSan,
  note,
  existing,
  candidates,
  mainUci,
  alts,
  altSans,
  addingAlt,
  steps,
  cursor,
  lineBusy,
  onNote,
  onUseBest,
  onToggleCandidate,
  onCursor,
  onExtend,
  onTrim,
  onToggleAlt,
  onRemoveAlt,
  onCancel,
  onSave,
}: {
  ply: number;
  row: AnalysisRow | undefined;
  played: { san: string; uci: string; color: string; fenBefore: string };
  draftSan: string | null;
  note: string;
  existing: Puzzle | undefined;
  /** The engine's top moves here, best first; null while it is still searching. */
  candidates: EngineLine[] | null;
  mainUci: string;
  steps: LineStep[];
  cursor: number;
  lineBusy: boolean;
  onToggleCandidate: (uci: string) => void;
  onCursor: (index: number) => void;
  onExtend: () => void;
  onTrim: () => void;
  alts: string[];
  altSans: { uci: string; san: string | null }[];
  addingAlt: boolean;
  onNote: (s: string) => void;
  onUseBest: () => void;
  onToggleAlt: () => void;
  onRemoveAlt: (uci: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const pv = row?.best_uci ? pvToSan(played.fenBefore, [row.best_uci], 1) : [];
  return (
    <div className="card" style={{ borderColor: 'var(--accent)' }}>
      <div className="card-head">
        <h2>{existing ? 'Edit puzzle' : 'New puzzle'} · {moveLabel(ply)} {played.san}</h2>
        {row?.classification && <ClassPill value={row.classification} />}
      </div>

      <dl className="meta-grid">
        <dt>You played</dt>
        <dd className="mono">{played.san}</dd>
        <dt>Engine best</dt>
        <dd className="mono">
          {row?.best_san ?? pv[0] ?? '—'}
          {row?.eval_before && (
            <span className="muted"> ({formatScore(row.eval_before, played.color === 'w')})</span>
          )}
        </dd>
        <dt>Top moves</dt>
        <dd className="row-tight" style={{ flexWrap: 'wrap' }}>
          {!candidates && <span className="faint tiny">searching…</span>}
          {candidates?.map((c) => {
            const isMain = c.uci === mainUci;
            const accepted = isMain || alts.includes(c.uci);
            return (
              <button
                key={c.uci}
                className="small mono"
                disabled={isMain}
                title={
                  isMain ? 'The correct move'
                    : accepted ? 'Accepted as an answer — click to stop accepting it'
                      : c.uci === played.uci ? 'The move played in the game — click to accept it anyway'
                        : 'Click to accept this as an answer too'
                }
                style={accepted ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
                onClick={() => onToggleCandidate(c.uci)}
              >
                {accepted ? '✓ ' : ''}{uciToSan(played.fenBefore, c.uci) ?? c.uci}{' '}
                <span className="muted">{formatScore(c.score, played.color === 'w')}</span>
              </button>
            );
          })}
        </dd>
        <dt>Correct move</dt>
        <dd className="mono">
          {draftSan ? <b style={{ color: 'var(--accent)' }}>{draftSan}</b> : <span className="faint">play a move on the board</span>}
        </dd>

        <dt>Also accept</dt>
        <dd className="row-tight" style={{ flexWrap: 'wrap' }}>
          {altSans.map(({ uci, san }) => (
            <span key={uci} className="pill mono">
              {san ?? uci}
              <button
                className="ghost small"
                style={{ padding: '0 2px', border: 'none' }}
                title="Remove"
                onClick={() => onRemoveAlt(uci)}
              >
                ×
              </button>
            </span>
          ))}
          <button className="small" onClick={onToggleAlt} disabled={!draftSan || cursor > 0}>
            {addingAlt ? 'Play it on the board…' : '+ Another move'}
          </button>
        </dd>

        <dt>Line</dt>
        <dd className="row-tight" style={{ flexWrap: 'wrap' }}>
          {steps.map((step, i) => (
            <button
              key={i}
              className="small mono"
              title={i % 2 ? 'Their reply — select it, then play a different one on the board to override' : 'Your move'}
              style={{
                ...(i === cursor && steps.length > 1 ? { borderColor: 'var(--accent)' } : {}),
                ...(i % 2 ? { opacity: 0.75 } : {}),
              }}
              onClick={() => onCursor(i)}
            >
              {moveLabel(ply + i)} {step.san}
            </button>
          ))}
          <button className="small" onClick={onExtend} disabled={!draftSan || lineBusy}>
            {lineBusy ? 'Engine thinking…' : '+ Reply & next move'}
          </button>
          {steps.length > 1 && (
            <button className="small ghost" onClick={onTrim} title="Remove the last reply and answer">
              − Shorten
            </button>
          )}
        </dd>
      </dl>
      {steps.length > 1 && (
        <p className="tiny faint" style={{ marginTop: 8, marginBottom: 0 }}>
          Multi-move puzzle: the trainer plays their replies and asks for each of your moves in turn.
          Select a move above and play another on the board to override it — everything after it is
          dropped, and a new reply gets a fresh engine answer.
        </p>
      )}
      {addingAlt && (
        <p className="tiny faint" style={{ marginTop: 8, marginBottom: 0 }}>
          The next move you play is added as a second acceptable answer instead of replacing the first.
        </p>
      )}

      <label className="field" style={{ marginTop: 12 }}>
        <span>Note (optional, shown after solving)</span>
        <input
          type="text"
          value={note}
          placeholder="e.g. back-rank tactic — always check the king first"
          onChange={(e) => onNote(e.target.value)}
        />
      </label>

      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" disabled={!draftSan} onClick={onSave}>
          {existing ? 'Update puzzle' : 'Save puzzle'}
        </button>
        <button onClick={onUseBest} disabled={!row?.best_uci}>Use engine move</button>
        <button className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function FlaggedList({
  flagged,
  puzzles,
  onPick,
}: {
  flagged: { ply: { ply: number; san: string; color: string }; row: AnalysisRow | undefined }[];
  puzzles: Puzzle[];
  onPick: (ply: number) => void;
}) {
  if (!flagged.length) return null;
  const saved = new Set(puzzles.map((p) => p.ply));

  return (
    <div className="card">
      <div className="card-head">
        <h2>Flagged moves</h2>
        <span className="tiny faint">{flagged.length} found · {saved.size} saved</span>
      </div>
      <table className="table">
        <tbody>
          {flagged.map(({ ply, row }) => (
            <tr key={ply.ply}>
              <td className="mono" style={{ width: 84 }}>{moveLabel(ply.ply)} {ply.san}</td>
              <td style={{ width: 120 }}>{row?.classification && <ClassPill value={row.classification} />}</td>
              <td className="tiny muted">
                best <span className="mono">{row?.best_san ?? '—'}</span>
                {row?.wp_loss != null && <span className="faint"> · −{row.wp_loss.toFixed(0)}%</span>}
              </td>
              <td className="num">
                <button className={saved.has(ply.ply) ? 'small' : 'small primary'} onClick={() => onPick(ply.ply)}>
                  {saved.has(ply.ply) ? 'Edit' : 'Add'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SavedPuzzles({
  puzzles,
  onEdit,
  onRemove,
}: {
  puzzles: Puzzle[];
  onEdit: (ply: number) => void;
  onRemove: (id: number) => void;
}) {
  return (
    <div className="card">
      <div className="card-head">
        <h2>Puzzles from this game</h2>
        <span className="tiny faint">{puzzles.length}</span>
      </div>
      {!puzzles.length ? (
        <p className="tiny faint" style={{ margin: 0 }}>
          None yet. Analyse the game, then add the moves you want to drill.
        </p>
      ) : (
        <table className="table">
          <tbody>
            {puzzles.map((p) => (
              <tr key={p.id}>
                <td className="mono faint tiny" style={{ width: 40 }}>#{p.id}</td>
                <td className="mono" style={{ width: 70 }}>{moveLabel(p.ply)}</td>
                <td>
                  <span className="faint mono">{p.played_san}</span>
                  <span className="faint"> → </span>
                  <b className="mono">{p.solution_san}</b>
                  {p.continuation.length > 0 && (
                    <span className="faint tiny" title="Multi-move puzzle">
                      {' '}+{p.continuation.length / 2} more
                    </span>
                  )}
                </td>
                <td style={{ width: 34 }}>
                  <span style={{ color: CLASSIFICATION_META[p.classification].color }}>
                    {CLASSIFICATION_META[p.classification].icon}
                  </span>
                </td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>
                  <button className="small" onClick={() => onEdit(p.ply)}>Edit</button>{' '}
                  <button className="small danger" onClick={() => onRemove(p.id)}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function MoveList({
  plies,
  rows,
  current,
  onSelect,
}: {
  plies: { ply: number; san: string; color: string }[];
  rows: Map<number, AnalysisRow>;
  current: number;
  onSelect: (ply: number) => void;
}) {
  const pairs: { n: number; white?: typeof plies[0]; black?: typeof plies[0] }[] = [];
  for (const p of plies) {
    const n = Math.floor(p.ply / 2) + 1;
    const last = pairs[pairs.length - 1];
    if (last?.n === n) last[p.color === 'w' ? 'white' : 'black'] = p;
    else pairs.push({ n, [p.color === 'w' ? 'white' : 'black']: p });
  }

  const cell = (p: typeof plies[0] | undefined) => {
    if (!p) return <span className="mv blank" />;
    const row = rows.get(p.ply);
    const meta = row?.classification ? CLASSIFICATION_META[row.classification] : null;
    return (
      <button
        className={`mv ${current === p.ply ? 'current' : ''}`}
        onClick={() => onSelect(p.ply)}
      >
        {p.san}
        {meta && meta.label !== 'Excellent' && meta.label !== 'Best' && (
          <span className="mv-tag" style={{ color: meta.color }}>{meta.icon}</span>
        )}
      </button>
    );
  };

  return (
    <div className="movelist">
      {pairs.map((pair) => (
        <div key={pair.n} style={{ display: 'contents' }}>
          <span className="mv-num">{pair.n}.</span>
          {cell(pair.white)}
          {cell(pair.black)}
        </div>
      ))}
    </div>
  );
}
