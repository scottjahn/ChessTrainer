import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// node:sqlite is loaded through require rather than a static import on purpose:
// a missing builtin fails during module linking, before any code in this file
// runs, so a static import could only ever produce a cryptic stack trace.
let DatabaseSync;
try {
  ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite'));
} catch {
  console.error(
    `\nThis app stores games in SQLite using Node's built-in node:sqlite module,\n` +
    `which is not available in the Node you are running (${process.version}).\n\n` +
    `  Fix:  install Node 24 (nvm install 24 && nvm use 24)\n` +
    `  Or:   on Node 22.x, start it with  node --experimental-sqlite server/index.mjs\n`
  );
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DB_PATH = process.env.CHESS_DB ?? join(root, 'data', 'chesstrainer.db');
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS games (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  source         TEXT NOT NULL DEFAULT 'pgn',
  url            TEXT UNIQUE,
  pgn            TEXT NOT NULL,
  event          TEXT,
  white          TEXT,
  black          TEXT,
  white_elo      INTEGER,
  black_elo      INTEGER,
  result         TEXT,
  played_at      TEXT,
  time_control   TEXT,
  time_class     TEXT,
  eco            TEXT,
  eco_url        TEXT,
  termination    TEXT,
  hero           TEXT,
  hero_color     TEXT,
  hero_result    TEXT,
  white_accuracy REAL,
  black_accuracy REAL,
  ply_count      INTEGER,
  analyzed_at    TEXT,
  analysis_depth INTEGER,
  reviewed       INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analysis (
  game_id        INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply            INTEGER NOT NULL,
  fen_before     TEXT NOT NULL,
  color          TEXT NOT NULL,
  san            TEXT,
  uci            TEXT,
  best_uci       TEXT,
  best_san       TEXT,
  eval_before    TEXT,
  eval_after     TEXT,
  wp_loss        REAL,
  classification TEXT,
  depth          INTEGER,
  PRIMARY KEY (game_id, ply)
);

CREATE TABLE IF NOT EXISTS puzzles (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id        INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply            INTEGER NOT NULL,
  fen            TEXT NOT NULL,
  side_to_move   TEXT NOT NULL,
  played_san     TEXT,
  played_uci     TEXT,
  solution_san   TEXT NOT NULL,
  solution_uci   TEXT NOT NULL,
  alt_solutions  TEXT NOT NULL DEFAULT '[]',
  classification TEXT NOT NULL,
  wp_loss        REAL,
  eval_before    TEXT,
  eval_after     TEXT,
  fen_prev       TEXT,
  prev_san       TEXT,
  prev_uci       TEXT,
  note           TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  UNIQUE (game_id, ply)
);

CREATE TABLE IF NOT EXISTS stats (
  puzzle_id        INTEGER PRIMARY KEY REFERENCES puzzles(id) ON DELETE CASCADE,
  attempts         INTEGER NOT NULL DEFAULT 0,
  solves           INTEGER NOT NULL DEFAULT 0,
  hints            INTEGER NOT NULL DEFAULT 0,
  solutions_shown  INTEGER NOT NULL DEFAULT 0,
  streak           INTEGER NOT NULL DEFAULT 0,
  last_seen        TEXT,
  last_result      TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_puzzles_game ON puzzles(game_id);
CREATE INDEX IF NOT EXISTS idx_analysis_game ON analysis(game_id);
`);

export function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

export function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, JSON.stringify(value));
  return value;
}

export const DEFAULT_SETTINGS = {
  heroUsername: '',
  depth: 16,
  multipv: 1,
  skipOpeningPlies: 6,
  thresholds: { inaccuracy: 5, mistake: 10, blunder: 20 },
  onlyHeroMoves: true,
};

export function allSettings() {
  const stored = getSetting('config', {});
  return { ...DEFAULT_SETTINGS, ...stored };
}
