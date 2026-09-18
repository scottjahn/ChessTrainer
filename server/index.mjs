import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, allSettings, setSetting } from './db.mjs';
import { fetchGameByUrl, fetchRecentGames, gameFromPgn } from './chesscom.mjs';
import { gamePositions, uciToSan } from './positions.mjs';
import { writePuzzleExport } from './export.mjs';
import { buildPuzzlePayload, hydrateAnalysis, hydratePuzzle } from './payload.mjs';

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
  'played_at', 'time_control', 'time_class', 'eco', 'eco_url', 'termination',
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
  res.json(db.prepare(`${gameListSql} ORDER BY COALESCE(g.played_at, g.created_at) DESC`).all());
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

  const row = db.prepare(`
    INSERT INTO puzzles (game_id, ply, fen, side_to_move, played_san, played_uci,
                         solution_san, solution_uci, alt_solutions, classification, wp_loss,
                         eval_before, eval_after, fen_prev, prev_san, prev_uci, note, enabled, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(game_id, ply) DO UPDATE SET
      solution_san = excluded.solution_san, solution_uci = excluded.solution_uci,
      alt_solutions = excluded.alt_solutions, classification = excluded.classification,
      wp_loss = excluded.wp_loss, eval_before = excluded.eval_before,
      eval_after = excluded.eval_after, note = excluded.note, enabled = excluded.enabled
    RETURNING *`).get(
    game.id, b.ply, b.fen, b.side_to_move, b.played_san ?? null, b.played_uci ?? null,
    solutionSan, b.solution_uci, JSON.stringify(b.alt_solutions ?? []),
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

  if (req.body.solution_uci !== undefined) {
    const san = uciToSan(existing.fen, req.body.solution_uci);
    if (!san) throw fail('That solution move is not legal in this position', 400);
    db.prepare('UPDATE puzzles SET solution_uci = ?, solution_san = ? WHERE id = ?')
      .run(req.body.solution_uci, san, id);
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
