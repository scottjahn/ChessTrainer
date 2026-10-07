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
  /** Win-probability points a move may trail the best by and still be offered as an answer. */
  altMargin: number;
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
  ended_at: string | null;
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
  ended_at: string | null;
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
  /** UCI moves after the solution: their reply, your move, their reply, … */
  continuation: string[];
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

/** One row of the admin's puzzle finder. */
export interface PuzzleIndexRow {
  id: number;
  game_id: number;
  ply: number;
  played_san: string | null;
  solution_san: string;
  classification: Classification;
  note: string | null;
  enabled: boolean;
  white: string | null;
  black: string | null;
  played_at: string | null;
}

/** Stockfish's verdict on one move of an opening line. */
export interface LineMoveReview {
  bestUci: string | null;
  evalBefore: Score | null;
  evalAfter: Score | null;
  wpLoss: number;
  classification: Classification;
  depth: number;
}

export interface Opening {
  id: number;
  name: string;
  /** The side this opening is trained as. */
  color: Color;
  note: string | null;
  enabled: boolean;
  created_at: string;
  line_count: number;
}

export interface OpeningLine {
  id: number;
  opening_id: number;
  name: string | null;
  /** UCI moves from the starting position, ending on the trained side's move. */
  moves: string[];
  note: string | null;
  /** One entry per move, or empty when the line was saved before the engine finished. */
  review: LineMoveReview[];
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
  /** Absent from packs exported before multi-move puzzles existed. */
  continuation?: string[];
  classification: Classification;
  wpLoss: number | null;
  evalBefore: Score | null;
  evalAfter: Score | null;
  fenPrev: string | null;
  prevSan: string | null;
  prevUci: string | null;
  note: string | null;
}

export interface ExportedOpeningLine {
  id: number;
  name: string | null;
  moves: string[];
  note: string | null;
}

export interface ExportedOpening {
  id: number;
  name: string;
  color: Color;
  note: string | null;
  lines: ExportedOpeningLine[];
}

export interface PackCounts {
  puzzles: number;
  games: number;
  /** Absent from packs exported before openings existed. */
  openings?: number;
  lines?: number;
}

export interface PuzzlePack {
  version: number;
  exportedAt: string;
  counts: PackCounts;
  games: Record<string, ExportedGame>;
  puzzles: ExportedPuzzle[];
  /** Absent from packs exported before openings existed. */
  openings?: ExportedOpening[];
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
