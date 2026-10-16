import { Chess } from 'chess.js';

const UA = 'ChessTrainer/0.1 (personal mistake-training tool)';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) {
    const err = new Error(`${res.status} ${res.statusText} for ${url}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Pull the numeric id and game kind out of any chess.com game link. */
export function parseGameUrl(input) {
  const s = String(input ?? '').trim();
  const m = s.match(/chess\.com\/(?:[a-z-]+\/)*?(live|daily|rapid|blitz|bullet)?\/?game\/(live|daily)?\/?(\d+)/i)
    ?? s.match(/chess\.com\/.*?\/(\d{6,})/);
  if (!m) return null;
  const id = m[m.length - 1];
  const kind = /daily/i.test(s) ? 'daily' : 'live';
  return { id, kind, url: `https://www.chess.com/game/${kind}/${id}` };
}

/**
 * chess.com's public API is indexed by player + month, not by game id, so a bare
 * game link is resolved in two hops: the site callback yields the PGN headers
 * (players + date), then the documented archive endpoint yields the real PGN.
 */
export async function fetchGameByUrl(input) {
  const parsed = parseGameUrl(input);
  if (!parsed) throw Object.assign(new Error('Not a recognizable chess.com game URL'), { status: 400 });

  let headers;
  for (const kind of [parsed.kind, parsed.kind === 'live' ? 'daily' : 'live']) {
    try {
      const cb = await getJson(`https://www.chess.com/callback/${kind}/game/${parsed.id}`);
      if (cb?.game?.pgnHeaders) {
        headers = cb.game.pgnHeaders;
        parsed.kind = kind;
        parsed.url = `https://www.chess.com/game/${kind}/${parsed.id}`;
        break;
      }
    } catch { /* try the other kind */ }
  }
  if (!headers) {
    throw Object.assign(
      new Error('chess.com did not return that game. It may be private, or you can paste the PGN instead.'),
      { status: 404 }
    );
  }

  // Archives are filed under the month a game *finished*, so a daily game that
  // ran over a month boundary is not in the month of its Date header.
  const months = [...new Set([headers.EndDate, headers.Date]
    .map((d) => String(d ?? '').split('.').slice(0, 2))
    .filter(([y, m]) => /^\d{4}$/.test(y) && /^\d{2}$/.test(m))
    .map(([y, m]) => `${y}/${m}`))];
  if (!months.length) throw new Error('Game headers had no usable date');

  for (const month of months) {
    for (const who of [headers.White, headers.Black]) {
      try {
        const arch = await getJson(
          `https://api.chess.com/pub/player/${encodeURIComponent(String(who).toLowerCase())}/games/${month}`
        );
        const hit = arch.games?.find((g) => g.url === parsed.url || g.url?.endsWith(`/${parsed.id}`));
        if (hit) return normalizeArchiveGame(hit);
      } catch { /* fall through to the other player */ }
    }
  }
  throw Object.assign(
    new Error('Found the game but not its PGN in the monthly archive. Paste the PGN instead.'),
    { status: 404 }
  );
}

/** A player's monthly archive URLs, oldest first, as chess.com lists them. */
async function fetchArchives(username) {
  const user = String(username ?? '').trim().toLowerCase();
  if (!user) throw Object.assign(new Error('username is required'), { status: 400 });
  try {
    const { archives } = await getJson(
      `https://api.chess.com/pub/player/${encodeURIComponent(user)}/games/archives`
    );
    return archives ?? [];
  } catch (err) {
    if (err.status === 404) {
      throw Object.assign(new Error(`chess.com has no player called "${username}"`), { status: 404 });
    }
    throw err;
  }
}

/** The months a player has games in, oldest first, as "2024/03". */
export async function fetchArchiveMonths(username) {
  return (await fetchArchives(username))
    .map((url) => url.match(/(\d{4}\/\d{2})$/)?.[1])
    .filter(Boolean);
}

/** An opening is over long before this; it keeps a 5,000-game account's list light. */
const OPENING_PLIES = 60;

/**
 * One month of a player's games as one colour, oldest first, each with the
 * moves it opened with — the raw material for an opening line.
 */
export async function fetchOpeningGames(username, month, color) {
  const user = String(username ?? '').trim().toLowerCase();
  if (!user) throw Object.assign(new Error('username is required'), { status: 400 });
  if (!/^\d{4}\/\d{2}$/.test(String(month))) throw Object.assign(new Error('month must look like 2024/03'), { status: 400 });
  const [mine, theirs] = color === 'b' ? ['black', 'white'] : ['white', 'black'];

  const { games } = await getJson(
    `https://api.chess.com/pub/player/${encodeURIComponent(user)}/games/${month}`
  );
  const out = [];
  for (const g of [...(games ?? [])].sort((a, b) => (a.end_time ?? 0) - (b.end_time ?? 0))) {
    // Variants and games from a set-up position do not start where a line does.
    if (g.rules !== 'chess' || g[mine]?.username?.toLowerCase() !== user) continue;
    let parsed;
    try {
      parsed = parsePgn(g.pgn);
    } catch {
      continue; // skip anything chess.js cannot replay
    }
    if (parsed.headers.SetUp === '1' || !parsed.plyCount) continue;
    const ecoUrl = parsed.headers.ECOUrl ?? (typeof g.eco === 'string' && g.eco.startsWith('http') ? g.eco : null);
    out.push({
      url: g.url ?? null,
      opponent: g[theirs]?.username ?? null,
      opponent_elo: num(g[theirs]?.rating),
      elo: num(g[mine]?.rating),
      result: g[mine]?.result === 'win' ? 'win' : g[theirs]?.result === 'win' ? 'loss' : 'draw',
      ended_at: endTimeIso(g.end_time),
      time_class: g.time_class ?? null,
      opening: ecoUrl?.split('/').pop()?.replaceAll('-', ' ') ?? null,
      ply_count: parsed.plyCount,
      moves: parsed.moves.slice(0, OPENING_PLIES).map((m) => `${m.from}${m.to}${m.promotion ?? ''}`),
    });
  }
  return out;
}

/** Newest-first games for a player, walking monthly archives backwards. */
export async function fetchRecentGames(username, limit = 20) {
  const archives = await fetchArchives(username);

  const out = [];
  for (const monthUrl of [...(archives ?? [])].reverse()) {
    const { games } = await getJson(monthUrl);
    for (const g of [...(games ?? [])].reverse()) {
      out.push(normalizeArchiveGame(g));
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function normalizeArchiveGame(g) {
  const meta = parsePgn(g.pgn);
  return {
    source: 'chess.com',
    url: g.url ?? null,
    pgn: g.pgn,
    event: meta.headers.Event ?? 'Live Chess',
    white: g.white?.username ?? meta.headers.White ?? null,
    black: g.black?.username ?? meta.headers.Black ?? null,
    white_elo: num(g.white?.rating ?? meta.headers.WhiteElo),
    black_elo: num(g.black?.rating ?? meta.headers.BlackElo),
    result: meta.headers.Result ?? null,
    played_at: isoDate(meta.headers.Date, meta.headers.StartTime ?? meta.headers.UTCTime) ?? endTimeIso(g.end_time),
    ended_at: endTimeIso(g.end_time) ?? isoDate(meta.headers.EndDate, meta.headers.EndTime),
    time_control: g.time_control ?? meta.headers.TimeControl ?? null,
    time_class: g.time_class ?? null,
    eco: meta.headers.ECO ?? g.eco ?? null,
    eco_url: meta.headers.ECOUrl ?? (typeof g.eco === 'string' && g.eco.startsWith('http') ? g.eco : null),
    termination: meta.headers.Termination ?? null,
    white_accuracy: num(g.accuracies?.white),
    black_accuracy: num(g.accuracies?.black),
    ply_count: meta.plyCount,
    rated: g.rated ?? null,
  };
}

/** Headers + SAN move list + ply count for a PGN, using chess.js for legality. */
export function parsePgn(pgn) {
  const chess = new Chess();
  chess.loadPgn(pgn, { strict: false });
  const headers = chess.header();
  const moves = chess.history({ verbose: true });
  return { headers, moves, plyCount: moves.length };
}

export function gameFromPgn(pgn) {
  const { headers, plyCount } = parsePgn(pgn);
  return {
    source: 'pgn',
    url: headers.Link ?? null,
    pgn,
    event: headers.Event ?? null,
    white: headers.White ?? null,
    black: headers.Black ?? null,
    white_elo: num(headers.WhiteElo),
    black_elo: num(headers.BlackElo),
    result: headers.Result ?? null,
    played_at: isoDate(headers.Date, headers.StartTime ?? headers.UTCTime),
    ended_at: isoDate(headers.EndDate, headers.EndTime),
    time_control: headers.TimeControl ?? null,
    time_class: null,
    eco: headers.ECO ?? null,
    eco_url: headers.ECOUrl ?? null,
    termination: headers.Termination ?? null,
    white_accuracy: null,
    black_accuracy: null,
    ply_count: plyCount,
    rated: null,
  };
}

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

export function isoDate(date, time) {
  if (!date || !/^\d{4}[.\-]\d{2}[.\-]\d{2}$/.test(date)) return null;
  const d = date.replace(/\./g, '-');
  return time && /^\d{2}:\d{2}:\d{2}$/.test(time) ? `${d}T${time}Z` : `${d}T00:00:00Z`;
}

const endTimeIso = (t) => (t ? new Date(t * 1000).toISOString() : null);
