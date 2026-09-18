export type Color = 'w' | 'b';

/** A UCI score, always from the perspective of the side to move. */
export type Score =
  | { type: 'cp'; value: number }
  | { type: 'mate'; value: number };

export type Classification =
  | 'best'
  | 'excellent'
  | 'good'
  | 'book'
  | 'inaccuracy'
  | 'mistake'
  | 'miss'
  | 'blunder';

/** The classifications that are worth turning into a puzzle. */
export const TRAINABLE: Classification[] = ['mistake', 'miss', 'blunder'];

export interface Thresholds {
  inaccuracy: number;
  mistake: number;
  blunder: number;
}

export interface Settings {
  heroUsername: string;
  depth: number;
  multipv: number;
  skipOpeningPlies: number;
  thresholds: Thresholds;
  onlyHeroMoves: boolean;
}

export interface Ply {
  ply: number;
  moveNumber: number;
  color: Color;
  san: string;
  uci: string;
  from: string;
  to: string;
  piece: string;
  captured: string | null;
  fenBefore: string;
  fenAfter: string;
}

export interface Game {
  id: number;
  source: string;
  url: string | null;
  pgn: string;
  event: string | null;
  white: string | null;
  black: string | null;
  white_elo: number | null;
  black_elo: number | null;
  result: string | null;
  played_at: string | null;
  time_control: string | null;
  time_class: string | null;
  eco: string | null;
  eco_url: string | null;
  termination: string | null;
  hero: string | null;
  hero_color: Color | null;
  hero_result: 'win' | 'loss' | 'draw' | null;
  white_accuracy: number | null;
  black_accuracy: number | null;
  ply_count: number | null;
  analyzed_at: string | null;
  analysis_depth: number | null;
  reviewed: number;
  created_at: string;
  puzzle_count: number;
  analyzed_plies: number;
}

/** A game as listed by chess.com but not yet imported. */
export interface RemoteGame {
  url: string | null;
  white: string | null;
  black: string | null;
  white_elo: number | null;
  black_elo: number | null;
  result: string | null;
  played_at: string | null;
  time_class: string | null;
  time_control: string | null;
  eco: string | null;
  termination: string | null;
  white_accuracy: number | null;
  black_accuracy: number | null;
  ply_count: number | null;
  rated: boolean | null;
  imported: boolean;
}

export interface AnalysisRow {
  game_id: number;
  ply: number;
  fen_before: string;
  color: Color;
  san: string | null;
  uci: string | null;
  best_uci: string | null;
  best_san: string | null;
  eval_before: Score | null;
  eval_after: Score | null;
  wp_loss: number | null;
  classification: Classification | null;
  depth: number | null;
}

export interface Puzzle {
  id: number;
  game_id: number;
  ply: number;
  fen: string;
  side_to_move: Color;
  played_san: string | null;
  played_uci: string | null;
  solution_san: string;
  solution_uci: string;
  alt_solutions: string[];
  classification: Classification;
  wp_loss: number | null;
  eval_before: Score | null;
  eval_after: Score | null;
  fen_prev: string | null;
  prev_san: string | null;
  prev_uci: string | null;
  note: string | null;
  enabled: boolean;
  created_at: string;
}

/* ---- the exported (public) shape the trainer reads ---- */

export interface ExportedGame {
  id: number;
  url: string | null;
  event: string | null;
  white: string | null;
  black: string | null;
  whiteElo: number | null;
  blackElo: number | null;
  result: string | null;
  playedAt: string | null;
  timeControl: string | null;
  timeClass: string | null;
  eco: string | null;
  ecoUrl: string | null;
  termination: string | null;
  hero: string | null;
  heroColor: Color | null;
  heroResult: 'win' | 'loss' | 'draw' | null;
  whiteAccuracy: number | null;
  blackAccuracy: number | null;
}

export interface ExportedPuzzle {
  id: number;
  gameId: number;
  ply: number;
  fen: string;
  sideToMove: Color;
  playedSan: string | null;
  playedUci: string | null;
  solutionSan: string;
  solutionUci: string;
  altSolutions: string[];
  classification: Classification;
  wpLoss: number | null;
  evalBefore: Score | null;
  evalAfter: Score | null;
  fenPrev: string | null;
  prevSan: string | null;
  prevUci: string | null;
  note: string | null;
}

export interface PuzzlePack {
  version: number;
  exportedAt: string;
  counts: { puzzles: number; games: number };
  games: Record<string, ExportedGame>;
  puzzles: ExportedPuzzle[];
}

export interface PuzzleStat {
  attempts: number;
  solves: number;
  hints: number;
  solutionsShown: number;
  streak: number;
  lastSeen: string | null;
  lastResult: 'solved' | 'failed' | null;
}
