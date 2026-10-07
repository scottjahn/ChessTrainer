import type {
  AnalysisRow, Color, Game, LineMoveReview, Opening, OpeningLine, PackCounts, Ply, Puzzle,
  PuzzleIndexRow, PuzzlePack, RemoteGame, Settings,
} from './types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

/**
 * Is the local admin API reachable? On GitHub Pages it never is, which is what
 * flips the app into read-only trainer mode.
 */
export async function checkLocalApi(): Promise<boolean> {
  try {
    const res = await fetch('/api/health', { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return false;
    // A status check alone is not enough: static hosts with SPA fallback happily
    // answer 200 with index.html for any path, which would fake an admin API.
    const body = (await res.json()) as { ok?: boolean; mode?: string };
    return body.ok === true && body.mode === 'local';
  } catch {
    return false;
  }
}

export interface GameDetail {
  game: Game;
  plies: Ply[];
  finalFen: string;
  analysis: AnalysisRow[];
  puzzles: Puzzle[];
}

export interface OpeningDetail {
  opening: Opening;
  lines: OpeningLine[];
}

export interface LineInput {
  name?: string | null;
  note?: string | null;
  moves?: string[];
  review?: LineMoveReview[];
}

const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

export const api = {
  settings: () => request<Settings>('/api/settings'),
  saveSettings: (patch: Partial<Settings>) =>
    request<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }),

  games: () => request<Game[]>('/api/games'),
  game: (id: number) => request<GameDetail>(`/api/games/${id}`),
  deleteGame: (id: number) => request<{ ok: true }>(`/api/games/${id}`, { method: 'DELETE' }),
  patchGame: (id: number, patch: { hero?: string; reviewed?: boolean }) =>
    request<Game>(`/api/games/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  importUrl: (url: string, hero?: string) =>
    post<{ id: number; duplicate: boolean; game: Game }>('/api/games/import/url', { url, hero }),
  importPgn: (pgn: string, hero?: string) =>
    post<{ imported: { id: number; duplicate: boolean }[]; games: Game[] }>(
      '/api/games/import/pgn', { pgn, hero }
    ),
  recentGames: (username: string, limit = 20) =>
    request<RemoteGame[]>(`/api/games/recent?username=${encodeURIComponent(username)}&limit=${limit}`),

  saveAnalysis: (gameId: number, rows: unknown[], depth: number) =>
    request<{ ok: true; saved: number }>(`/api/games/${gameId}/analysis`, {
      method: 'PUT',
      body: JSON.stringify({ rows, depth }),
    }),

  savePuzzle: (puzzle: Record<string, unknown>) => post<Puzzle>('/api/puzzles', puzzle),
  patchPuzzle: (id: number, patch: Record<string, unknown>) =>
    request<Puzzle>(`/api/puzzles/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deletePuzzle: (id: number) => request<{ ok: true }>(`/api/puzzles/${id}`, { method: 'DELETE' }),

  puzzles: () => request<PuzzlePack>('/api/puzzles'),
  puzzleIndex: () => request<PuzzleIndexRow[]>('/api/puzzles/index'),
  exportPuzzles: () =>
    post<{ ok: true; path: string; bytes: number; counts: PackCounts }>('/api/export'),

  openings: () => request<Opening[]>('/api/openings'),
  opening: (id: number) => request<OpeningDetail>(`/api/openings/${id}`),
  createOpening: (body: { name: string; color: Color; note?: string | null }) =>
    post<Opening>('/api/openings', body),
  patchOpening: (id: number, body: Partial<Pick<Opening, 'name' | 'color' | 'note' | 'enabled'>>) =>
    patch<Opening>(`/api/openings/${id}`, body),
  deleteOpening: (id: number) => request<{ ok: true }>(`/api/openings/${id}`, { method: 'DELETE' }),
  createLine: (openingId: number, body: LineInput) =>
    post<OpeningLine>(`/api/openings/${openingId}/lines`, body),
  patchLine: (id: number, body: LineInput) => patch<OpeningLine>(`/api/opening-lines/${id}`, body),
  deleteLine: (id: number) => request<{ ok: true }>(`/api/opening-lines/${id}`, { method: 'DELETE' }),

  recordAttempt: (puzzleId: number, body: { solved: boolean; usedHint: boolean; usedSolution: boolean }) =>
    post<unknown>(`/api/stats/${puzzleId}`, body),
};
