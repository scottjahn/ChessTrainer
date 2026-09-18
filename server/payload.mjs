import { db } from './db.mjs';

export const safeJson = (s, fallback) => {
  try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; }
};

export const hydrateAnalysis = (row) => ({
  ...row,
  eval_before: safeJson(row.eval_before, null),
  eval_after: safeJson(row.eval_after, null),
});

export const hydratePuzzle = (row) => ({
  ...row,
  enabled: !!row.enabled,
  alt_solutions: safeJson(row.alt_solutions, []),
  eval_before: safeJson(row.eval_before, null),
  eval_after: safeJson(row.eval_after, null),
});

/**
 * The shape the public trainer consumes. Games are kept in a side map so the
 * metadata for a 12-puzzle game is stored once rather than twelve times.
 */
export function buildPuzzlePayload() {
  const puzzles = db
    .prepare('SELECT * FROM puzzles WHERE enabled = 1 ORDER BY game_id, ply')
    .all()
    .map(hydratePuzzle);

  const games = {};
  for (const id of new Set(puzzles.map((p) => p.game_id))) {
    const g = db.prepare('SELECT * FROM games WHERE id = ?').get(id);
    if (!g) continue;
    games[id] = {
      id: g.id, url: g.url, event: g.event, white: g.white, black: g.black,
      whiteElo: g.white_elo, blackElo: g.black_elo, result: g.result,
      playedAt: g.played_at, timeControl: g.time_control, timeClass: g.time_class,
      eco: g.eco, ecoUrl: g.eco_url, termination: g.termination,
      hero: g.hero, heroColor: g.hero_color, heroResult: g.hero_result,
      whiteAccuracy: g.white_accuracy, blackAccuracy: g.black_accuracy,
    };
  }

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    counts: { puzzles: puzzles.length, games: Object.keys(games).length },
    games,
    puzzles: puzzles.map((p) => ({
      id: p.id, gameId: p.game_id, ply: p.ply, fen: p.fen, sideToMove: p.side_to_move,
      playedSan: p.played_san, playedUci: p.played_uci,
      solutionSan: p.solution_san, solutionUci: p.solution_uci,
      altSolutions: p.alt_solutions, classification: p.classification, wpLoss: p.wp_loss,
      evalBefore: p.eval_before, evalAfter: p.eval_after,
      fenPrev: p.fen_prev, prevSan: p.prev_san, prevUci: p.prev_uci, note: p.note,
    })),
  };
}
