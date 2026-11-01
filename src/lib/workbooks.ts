export type WorkbookPuzzleType = 'best-move';

export interface WorkbookPuzzle {
  /** Stable across corrections to the position, since progress is keyed on it. */
  id: string;
  book: string;
  /** The heading printed on the page, such as "Twofold attack". */
  theme: string;
  type: WorkbookPuzzleType;
  page: number;
  /** Position on the page, reading left to right then top to bottom. */
  number: number;
  fen: string;
  /** UCI moves: the answer, then the play that shows why it works. */
  solution: string[];
  /** Other first moves that are just as good, in UCI. */
  alternatives?: string[];
}

export const TYPE_PROMPT: Record<WorkbookPuzzleType, string> = {
  'best-move': 'find the best move',
};

const STORAGE_KEY = 'chesstrainer.workbooks.v1';

/** Date solved or ticked off, by puzzle id. */
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

/** Like the puzzle stats, this lives only in this browser. */
export function loadDone(): DoneMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as DoneMap) : {};
  } catch {
    return {};
  }
}

export function setDone(done: DoneMap, id: string, isDone: boolean): DoneMap {
  const next = { ...done };
  if (isDone) next[id] = new Date().toISOString();
  else delete next[id];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private mode or a full quota: the ticks last until the page closes */
  }
  return next;
}

/** The first undone puzzle after this one, wrapping round to the start. */
export function nextUndone(puzzles: WorkbookPuzzle[], done: DoneMap, afterId?: string): WorkbookPuzzle | null {
  const after = puzzles.findIndex((p) => p.id === afterId);
  const undone = (p: WorkbookPuzzle) => !done[p.id] && p.id !== afterId;
  return puzzles.slice(after + 1).find(undone) ?? puzzles.find(undone) ?? null;
}
