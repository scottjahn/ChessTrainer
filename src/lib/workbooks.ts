export type WorkbookPuzzleType = 'best-move' | 'correct-capture';

export interface WorkbookPuzzle {
  /** Stable across corrections to the position, since progress is keyed on it. */
  id: string;
  book: string;
  /** The heading at the top left of the page, such as "Material". */
  section: string;
  /** The heading at the top right of the page, such as "Twofold attack". */
  theme: string;
  type: WorkbookPuzzleType;
  page: number;
  /** Position on the page, reading left to right then top to bottom. */
  number: number;
  fen: string;
  /** UCI moves: the answer, then the play that shows why it works. */
  solution: string[];
  /** Other first moves the book's answer key also gives, in UCI. */
  bookAlternatives?: string[];
  /** Other first moves Stockfish rates at least as highly, in UCI. */
  alternatives?: string[];
}

export const TYPE_PROMPT: Record<WorkbookPuzzleType, string> = {
  'best-move': 'find the best move',
  'correct-capture': 'choose the correct capture',
};

const DONE_KEY = 'chesstrainer.workbooks.v1';
const CLEAN_KEY = 'chesstrainer.workbooks.clean.v1';

/** Date of the tick, by puzzle id. */
export type DoneMap = Record<string, string>;

/** Separate from puzzles.json, which every export overwrites. */
export async function loadWorkbooks(): Promise<WorkbookPuzzle[]> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/workbooks.json`, { cache: 'no-cache' });
    if (res.ok) {
      const { puzzles } = (await res.json()) as { puzzles: WorkbookPuzzle[] };
      return puzzles;
    }
  } catch {
    /* nothing transcribed yet */
  }
  return [];
}

/**
 * Book order is the order of first appearance in the file, then page and number,
 * so pages can be transcribed out of sequence and still be worked through in order.
 */
export function inBookOrder(puzzles: WorkbookPuzzle[]): WorkbookPuzzle[] {
  const books = [...new Set(puzzles.map((p) => p.book))];
  return [...puzzles].sort(
    (a, b) => books.indexOf(a.book) - books.indexOf(b.book) || a.page - b.page || a.number - b.number
  );
}

function load(key: string): DoneMap {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as DoneMap) : {};
  } catch {
    return {};
  }
}

function update(key: string, map: DoneMap, id: string, on: boolean): DoneMap {
  const next = { ...map };
  if (on) next[id] = new Date().toISOString();
  else delete next[id];
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    /* private mode or a full quota: the ticks last until the page closes */
  }
  return next;
}

/** Like the puzzle stats, these live only in this browser. Done means solved at all. */
export const loadDone = () => load(DONE_KEY);
export const setDone = (done: DoneMap, id: string, on: boolean) => update(DONE_KEY, done, id, on);

/** Clean means solved at some point with no wrong move, hint or shown solution. */
export const loadClean = () => load(CLEAN_KEY);
export const setClean = (clean: DoneMap, id: string, on: boolean) => update(CLEAN_KEY, clean, id, on);

/** The next puzzle after this one not yet solved cleanly, wrapping round to the start. */
export function nextToSolve(puzzles: WorkbookPuzzle[], clean: DoneMap, afterId: string): WorkbookPuzzle | null {
  const after = puzzles.findIndex((p) => p.id === afterId);
  const open = (p: WorkbookPuzzle) => !clean[p.id] && p.id !== afterId;
  return puzzles.slice(after + 1).find(open) ?? puzzles.find(open) ?? null;
}

/** Where to pick up: the first puzzle never solved, then the first not yet solved cleanly. */
export function resumeAt(puzzles: WorkbookPuzzle[], done: DoneMap, clean: DoneMap): WorkbookPuzzle | null {
  return puzzles.find((p) => !done[p.id]) ?? puzzles.find((p) => !clean[p.id]) ?? null;
}
