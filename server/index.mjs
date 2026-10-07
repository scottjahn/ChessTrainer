import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, allSettings, setSetting } from './db.mjs';
import { fetchGameByUrl, fetchRecentGames, gameFromPgn } from './chesscom.mjs';
import { START_FEN, gamePositions, lineIsLegal, uciToSan } from './positions.mjs';
import { writePuzzleExport } from './export.mjs';
import {
  buildPuzzlePayload, hydrateAnalysis, hydrateOpening, hydrateOpeningLine, hydratePuzzle,
} from './payload.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Deliberately not PORT: dev tooling sets that for the Vite server.
const PORT = Number(process.env.CHESS_API_PORT ?? 8787);

const app = express();
app.use(express.json({ limit: '8mb' }));
// A dedicated worker started from a cross-origin-isolated page must itself be
// served with COEP, or the browser refuses to load it with no error message.
app.use('/engine', express.static(join(root, 'engine'), {
  setHeaders: (res) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  },
}));

const now = () => new Date().toISOString();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const fail = (message, status) => Object.assign(new Error(message), { status });

/* ------------------------------------------------------------------ health */

app.get('/api/health', (_req, res) => res.json({ ok: true, mode: 'local', version: 1 }));

/* ---------------------------------------------------------------- settings */

app.get('/api/settings', (_req, res) => res.json(allSettings()));

app.put('/api/settings', (req, res) => {
  res.json(setSetting('config', { ...allSettings(), ...req.body }));
});

/* ------------------------------------------------------------------- games */

const GAME_COLUMNS = [
  'source', 'url', 'pgn', 'event', 'white', 'black', 'white_elo', 'black_elo', 'result',
  'played_at', 'ended_at', 'time_control', 'time_class', 'eco', 'eco_url', 'termination',
  'hero', 'hero_color', 'hero_result', 'white_accuracy', 'black_accuracy', 'ply_count',
];

/** Work out which side the user played and how the game went for them. */
function applyHero(game, hero) {
  const name = String(hero ?? '').trim();
  if (!name) return { ...game, hero: null, hero_color: null, hero_result: null };
  const lower = name.toLowerCase();
  const color = game.white?.toLowerCase() === lower ? 'w'
    : game.black?.toLowerCase() === lower ? 'b'
      : null;
  const heroResult = !color || !game.result ? null
    : game.result === '1/2-1/2' ? 'draw'
      : (game.result === '1-0') === (color === 'w') ? 'win' : 'loss';
  return { ...game, hero: color ? name : null, hero_color: color, hero_result: heroResult };
}

function insertGame(game) {
  const existing = game.url
    ? db.prepare('SELECT id FROM games WHERE url = ?').get(game.url)
    : null;
  if (existing) return { id: existing.id, duplicate: true };

  const cols = GAME_COLUMNS.join(', ');
  const placeholders = GAME_COLUMNS.map(() => '?').join(', ');
  const values = GAME_COLUMNS.map((c) => game[c] ?? null);
  const info = db
    .prepare(`INSERT INTO games (${cols}, created_at) VALUES (${placeholders}, ?)`)
    .run(...values, now());
  return { id: Number(info.lastInsertRowid), duplicate: false };
}

const gameListSql = `
  SELECT g.*,
         (SELECT COUNT(*) FROM puzzles p WHERE p.game_id = g.id) AS puzzle_count,
         (SELECT COUNT(*) FROM analysis a WHERE a.game_id = g.id) AS analyzed_plies
  FROM games g`;

const getGame = (id) => db.prepare(`${gameListSql} WHERE g.id = ?`).get(id);

app.post('/api/games/import/url', wrap(async (req, res) => {
  const hero = req.body.hero ?? allSettings().heroUsername;
  const game = applyHero(await fetchGameByUrl(req.body.url), hero);
  const { id, duplicate } = insertGame(game);
  res.json({ id, duplicate, game: getGame(id) });
}));

app.post('/api/games/import/pgn', wrap(async (req, res) => {
  const hero = req.body.hero ?? allSettings().heroUsername;
  const chunks = splitPgns(String(req.body.pgn ?? ''));
  if (!chunks.length) throw fail('No games found in that PGN', 400);

  const imported = [];
  for (const chunk of chunks) {
    let game;
    try {
      game = applyHero(gameFromPgn(chunk), hero);
    } catch {
      continue; // skip anything chess.js cannot replay
    }
    if (!game.ply_count) continue;
    imported.push(insertGame(game));
  }
  if (!imported.length) throw fail('None of those games could be parsed', 400);
  res.json({ imported, games: imported.map((i) => getGame(i.id)) });
}));

app.get('/api/games/recent', wrap(async (req, res) => {
  const games = await fetchRecentGames(req.query.username, Number(req.query.limit ?? 20));
  const known = new Set(db.prepare('SELECT url FROM games WHERE url IS NOT NULL').all().map((r) => r.url));
  res.json(games.map(({ pgn: _pgn, ...g }) => ({ ...g, imported: known.has(g.url) })));
}));

app.get('/api/games', (_req, res) => {
  res.json(db.prepare(`${gameListSql} ORDER BY COALESCE(g.ended_at, g.played_at, g.created_at) DESC`).all());
});

app.get('/api/games/:id', wrap((req, res) => {
  const game = getGame(Number(req.params.id));
  if (!game) throw fail('No such game', 404);
  const { plies, finalFen } = gamePositions(game.pgn);
  const analysis = db.prepare('SELECT * FROM analysis WHERE game_id = ? ORDER BY ply').all(game.id);
  const puzzles = db.prepare('SELECT * FROM puzzles WHERE game_id = ? ORDER BY ply').all(game.id);
  res.json({
    game,
    plies,
    finalFen,
    analysis: analysis.map(hydrateAnalysis),
    puzzles: puzzles.map(hydratePuzzle),
  });
}));

app.patch('/api/games/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const game = getGame(id);
  if (!game) throw fail('No such game', 404);

  if (req.body.hero !== undefined) {
    const patched = applyHero(game, req.body.hero);
    db.prepare('UPDATE games SET hero = ?, hero_color = ?, hero_result = ? WHERE id = ?')
      .run(patched.hero, patched.hero_color, patched.hero_result, id);
  }
  if (req.body.reviewed !== undefined) {
    db.prepare('UPDATE games SET reviewed = ? WHERE id = ?').run(req.body.reviewed ? 1 : 0, id);
  }
  res.json(getGame(id));
}));

app.delete('/api/games/:id', wrap((req, res) => {
  db.prepare('DELETE FROM games WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

/* ---------------------------------------------------------------- analysis */

app.put('/api/games/:id/analysis', wrap((req, res) => {
  const gameId = Number(req.params.id);
  if (!getGame(gameId)) throw fail('No such game', 404);
  const rows = req.body.rows ?? [];

  const stmt = db.prepare(`
    INSERT INTO analysis (game_id, ply, fen_before, color, san, uci, best_uci, best_san,
                          eval_before, eval_after, wp_loss, classification, depth)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(game_id, ply) DO UPDATE SET
      best_uci = excluded.best_uci, best_san = excluded.best_san,
      eval_before = excluded.eval_before, eval_after = excluded.eval_after,
      wp_loss = excluded.wp_loss, classification = excluded.classification,
      depth = excluded.depth`);

  for (const r of rows) {
    stmt.run(
      gameId, r.ply, r.fenBefore, r.color, r.san ?? null, r.uci ?? null,
      r.bestUci ?? null, r.bestSan ?? null,
      JSON.stringify(r.evalBefore ?? null), JSON.stringify(r.evalAfter ?? null),
      r.wpLoss ?? null, r.classification ?? null, r.depth ?? null
    );
  }
  db.prepare('UPDATE games SET analyzed_at = ?, analysis_depth = ? WHERE id = ?')
    .run(now(), req.body.depth ?? null, gameId);
  res.json({ ok: true, saved: rows.length });
}));

/* ----------------------------------------------------------------- puzzles */

app.post('/api/puzzles', wrap((req, res) => {
  const b = req.body;
  const game = getGame(Number(b.game_id));
  if (!game) throw fail('No such game', 404);

  const solutionSan = uciToSan(b.fen, b.solution_uci);
  if (!solutionSan) throw fail('That solution move is not legal in this position', 400);
  const continuation = b.continuation ?? [];
  checkContinuation(b.fen, b.solution_uci, continuation);

  const row = db.prepare(`
    INSERT INTO puzzles (game_id, ply, fen, side_to_move, played_san, played_uci,
                         solution_san, solution_uci, alt_solutions, continuation, classification, wp_loss,
                         eval_before, eval_after, fen_prev, prev_san, prev_uci, note, enabled, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(game_id, ply) DO UPDATE SET
      solution_san = excluded.solution_san, solution_uci = excluded.solution_uci,
      alt_solutions = excluded.alt_solutions, continuation = excluded.continuation,
      classification = excluded.classification,
      wp_loss = excluded.wp_loss, eval_before = excluded.eval_before,
      eval_after = excluded.eval_after, note = excluded.note, enabled = excluded.enabled
    RETURNING *`).get(
    game.id, b.ply, b.fen, b.side_to_move, b.played_san ?? null, b.played_uci ?? null,
    solutionSan, b.solution_uci, JSON.stringify(b.alt_solutions ?? []), JSON.stringify(continuation),
    b.classification ?? 'mistake', b.wp_loss ?? null,
    JSON.stringify(b.eval_before ?? null), JSON.stringify(b.eval_after ?? null),
    b.fen_prev ?? null, b.prev_san ?? null, b.prev_uci ?? null, b.note ?? null,
    b.enabled === false ? 0 : 1, now()
  );
  res.json(hydratePuzzle(row));
}));

app.patch('/api/puzzles/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM puzzles WHERE id = ?').get(id);
  if (!existing) throw fail('No such puzzle', 404);

  if (req.body.solution_uci !== undefined || req.body.continuation !== undefined) {
    const uci = req.body.solution_uci ?? existing.solution_uci;
    const san = uciToSan(existing.fen, uci);
    if (!san) throw fail('That solution move is not legal in this position', 400);
    // A new first move leaves the old follow-up dangling, so it goes unless replaced.
    const continuation = req.body.continuation
      ?? (uci === existing.solution_uci ? JSON.parse(existing.continuation) : []);
    checkContinuation(existing.fen, uci, continuation);
    db.prepare('UPDATE puzzles SET solution_uci = ?, solution_san = ?, continuation = ? WHERE id = ?')
      .run(uci, san, JSON.stringify(continuation), id);
  }
  if (req.body.alt_solutions !== undefined) {
    db.prepare('UPDATE puzzles SET alt_solutions = ? WHERE id = ?')
      .run(JSON.stringify(req.body.alt_solutions), id);
  }
  for (const f of ['classification', 'note']) {
    if (req.body[f] !== undefined) {
      db.prepare(`UPDATE puzzles SET ${f} = ? WHERE id = ?`).run(req.body[f], id);
    }
  }
  if (req.body.enabled !== undefined) {
    db.prepare('UPDATE puzzles SET enabled = ? WHERE id = ?').run(req.body.enabled ? 1 : 0, id);
  }
  res.json(hydratePuzzle(db.prepare('SELECT * FROM puzzles WHERE id = ?').get(id)));
}));

app.delete('/api/puzzles/:id', wrap((req, res) => {
  db.prepare('DELETE FROM puzzles WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

app.get('/api/puzzles', (_req, res) => res.json(buildPuzzlePayload()));

/**
 * A flat list of every puzzle for the admin's finder — including disabled ones,
 * which the trainer payload leaves out, and with just enough of the game to
 * recognise it in a result row.
 */
app.get('/api/puzzles/index', (_req, res) => {
  res.json(db.prepare(`
    SELECT p.id, p.game_id, p.ply, p.played_san, p.solution_san, p.classification,
           p.note, p.enabled, g.white, g.black, g.played_at
    FROM puzzles p JOIN games g ON g.id = p.game_id
    ORDER BY p.id DESC`).all().map((r) => ({ ...r, enabled: !!r.enabled })));
});

/* ---------------------------------------------------------------- openings */

const openingListSql = `
  SELECT o.*, (SELECT COUNT(*) FROM opening_lines l WHERE l.opening_id = o.id) AS line_count
  FROM openings o`;

const getOpening = (id) => {
  const row = db.prepare(`${openingListSql} WHERE o.id = ?`).get(id);
  return row ? hydrateOpening(row) : null;
};
const getLine = (id) => {
  const row = db.prepare('SELECT * FROM opening_lines WHERE id = ?').get(id);
  return row ? hydrateOpeningLine(row) : null;
};
const text = (value) => String(value ?? '').trim() || null;

app.get('/api/openings', (_req, res) => {
  res.json(
    db.prepare(`${openingListSql} ORDER BY o.color DESC, o.name COLLATE NOCASE`).all().map(hydrateOpening)
  );
});

app.post('/api/openings', wrap((req, res) => {
  const name = text(req.body.name);
  if (!name) throw fail('An opening needs a name', 400);
  if (!['w', 'b'].includes(req.body.color)) throw fail('Pick the side you play this opening as', 400);
  const info = db
    .prepare('INSERT INTO openings (name, color, note, enabled, created_at) VALUES (?,?,?,?,?)')
    .run(name, req.body.color, text(req.body.note), req.body.enabled === false ? 0 : 1, now());
  res.json(getOpening(Number(info.lastInsertRowid)));
}));

app.get('/api/openings/:id', wrap((req, res) => {
  const opening = getOpening(Number(req.params.id));
  if (!opening) throw fail('No such opening', 404);
  const lines = db.prepare('SELECT * FROM opening_lines WHERE opening_id = ? ORDER BY moves').all(opening.id);
  res.json({ opening, lines: lines.map(hydrateOpeningLine) });
}));

app.patch('/api/openings/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const opening = getOpening(id);
  if (!opening) throw fail('No such opening', 404);

  if (req.body.name !== undefined) {
    const name = text(req.body.name);
    if (!name) throw fail('An opening needs a name', 400);
    db.prepare('UPDATE openings SET name = ? WHERE id = ?').run(name, id);
  }
  if (req.body.color !== undefined && req.body.color !== opening.color) {
    if (!['w', 'b'].includes(req.body.color)) throw fail('Pick the side you play this opening as', 400);
    // Every line ends on the trained side's move, so the lines pin the side.
    if (opening.line_count) throw fail('Remove the lines before switching sides', 400);
    db.prepare('UPDATE openings SET color = ? WHERE id = ?').run(req.body.color, id);
  }
  if (req.body.note !== undefined) {
    db.prepare('UPDATE openings SET note = ? WHERE id = ?').run(text(req.body.note), id);
  }
  if (req.body.enabled !== undefined) {
    db.prepare('UPDATE openings SET enabled = ? WHERE id = ?').run(req.body.enabled ? 1 : 0, id);
  }
  res.json(getOpening(id));
}));

app.delete('/api/openings/:id', wrap((req, res) => {
  db.prepare('DELETE FROM openings WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

app.post('/api/openings/:id/lines', wrap((req, res) => {
  const opening = getOpening(Number(req.params.id));
  if (!opening) throw fail('No such opening', 404);
  const moves = req.body.moves;
  checkOpeningLine(opening, moves);

  const info = db
    .prepare('INSERT INTO opening_lines (opening_id, name, moves, note, review, created_at) VALUES (?,?,?,?,?,?)')
    .run(opening.id, text(req.body.name), JSON.stringify(moves), text(req.body.note),
      JSON.stringify(req.body.review ?? []), now());
  res.json(getLine(Number(info.lastInsertRowid)));
}));

app.patch('/api/opening-lines/:id', wrap((req, res) => {
  const id = Number(req.params.id);
  const line = getLine(id);
  if (!line) throw fail('No such line', 404);

  if (req.body.moves !== undefined) {
    checkOpeningLine(getOpening(line.opening_id), req.body.moves, id);
    // The engine's verdicts belong to the moves they were made on.
    db.prepare('UPDATE opening_lines SET moves = ?, review = ? WHERE id = ?')
      .run(JSON.stringify(req.body.moves), JSON.stringify(req.body.review ?? []), id);
  } else if (req.body.review !== undefined) {
    db.prepare('UPDATE opening_lines SET review = ? WHERE id = ?').run(JSON.stringify(req.body.review), id);
  }
  for (const f of ['name', 'note']) {
    if (req.body[f] !== undefined) {
      db.prepare(`UPDATE opening_lines SET ${f} = ? WHERE id = ?`).run(text(req.body[f]), id);
    }
  }
  res.json(getLine(id));
}));

app.delete('/api/opening-lines/:id', wrap((req, res) => {
  db.prepare('DELETE FROM opening_lines WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

/* ------------------------------------------------------------------- stats */

app.get('/api/stats', (_req, res) => res.json(db.prepare('SELECT * FROM stats').all()));

app.post('/api/stats/:puzzleId', wrap((req, res) => {
  const id = Number(req.params.puzzleId);
  if (!db.prepare('SELECT 1 FROM puzzles WHERE id = ?').get(id)) throw fail('No such puzzle', 404);

  const solved = req.body.solved ? 1 : 0;
  const hint = req.body.usedHint ? 1 : 0;
  const shown = req.body.usedSolution ? 1 : 0;
  const stamp = now();
  const result = solved ? 'solved' : 'failed';

  db.prepare(`
    INSERT INTO stats (puzzle_id, attempts, solves, hints, solutions_shown, streak, last_seen, last_result)
    VALUES (?, 1, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(puzzle_id) DO UPDATE SET
      attempts        = stats.attempts + 1,
      solves          = stats.solves + ?,
      hints           = stats.hints + ?,
      solutions_shown = stats.solutions_shown + ?,
      streak          = CASE WHEN ? = 1 THEN stats.streak + 1 ELSE 0 END,
      last_seen       = ?,
      last_result     = ?`)
    .run(id, solved, hint, shown, solved, stamp, result,
      solved, hint, shown, solved, stamp, result);

  res.json(db.prepare('SELECT * FROM stats WHERE puzzle_id = ?').get(id));
}));

/* ------------------------------------------------------------------ export */

app.post('/api/export', wrap(async (_req, res) => {
  res.json(await writePuzzleExport(buildPuzzlePayload()));
}));

/* ------------------------------------------------------------------ errors */

app.use((err, _req, res, _next) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message ?? 'Server error' });
});

/** A continuation is reply/answer pairs, so the puzzle always ends on the solver's move. */
function checkContinuation(fen, solutionUci, continuation) {
  if (!Array.isArray(continuation) || continuation.length % 2) {
    throw fail('A multi-move line has to end on your own move', 400);
  }
  if (!lineIsLegal(fen, [solutionUci, ...continuation])) {
    throw fail('That line has a move that is not legal where it is played', 400);
  }
}

/** An opening line runs from the starting position to one of the trained side's moves. */
function checkOpeningLine(opening, moves, lineId = null) {
  if (!Array.isArray(moves) || !moves.length || moves.some((m) => typeof m !== 'string')) {
    throw fail('A line needs at least one move', 400);
  }
  if (!lineIsLegal(START_FEN, moves)) {
    throw fail('That line has a move that is not legal where it is played', 400);
  }
  // White's moves are the odd-numbered plies, so a White line has odd length.
  if ((moves.length % 2 === 1) !== (opening.color === 'w')) {
    throw fail('A line has to end on your own move', 400);
  }
  const twin = db
    .prepare('SELECT id FROM opening_lines WHERE opening_id = ? AND moves = ?')
    .get(opening.id, JSON.stringify(moves));
  if (twin && twin.id !== lineId) throw fail('That line is already in this opening', 409);
}

/** PGN files can hold many games back to back; split on the header starting each. */
function splitPgns(text) {
  return text
    .split(/\n\s*(?=\[Event\s)/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

app.listen(PORT, () => {
  console.log(`  ChessTrainer API   http://localhost:${PORT}`);
  console.log(`  admin + trainer    http://localhost:5173`);
});
