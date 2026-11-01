export interface CalendarPuzzle {
  /** YYYY-MM-DD, the page of the calendar this came from. */
  date: string;
  fen: string;
  /** Composer and year, as printed above the diagram. */
  credit?: string;
}

const STORAGE_KEY = 'chesstrainer.calendar.v1';

/** Date solved or ticked off, by puzzle date. */
export type DoneMap = Record<string, string>;

/** Separate from puzzles.json, which every export overwrites. */
export async function loadCalendar(): Promise<CalendarPuzzle[]> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/calendar.json`, { cache: 'no-cache' });
    if (res.ok) {
      const { puzzles } = (await res.json()) as { puzzles: CalendarPuzzle[] };
      return [...puzzles].sort((a, b) => a.date.localeCompare(b.date));
    }
  } catch {
    /* nothing transcribed yet */
  }
  return [];
}

/**
 * Keyed by date rather than position, so correcting a mistranscribed piece does
 * not lose the tick. Like the puzzle stats, this lives only in this browser.
 */
export function loadDone(): DoneMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as DoneMap) : {};
  } catch {
    return {};
  }
}

export function setDone(done: DoneMap, date: string, isDone: boolean): DoneMap {
  const next = { ...done };
  if (isDone) next[date] = new Date().toISOString();
  else delete next[date];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private mode or a full quota: the ticks last until the page closes */
  }
  return next;
}

/** The first undone puzzle after this date, wrapping round to the start. */
export function nextUndone(puzzles: CalendarPuzzle[], done: DoneMap, after = ''): CalendarPuzzle | null {
  const undone = puzzles.filter((p) => !done[p.date] && p.date !== after);
  return undone.find((p) => p.date > after) ?? undone[0] ?? null;
}

/** Local dates, not UTC: "today" should turn over at the reader's midnight. */
export function dateKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseDate(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d);
}
