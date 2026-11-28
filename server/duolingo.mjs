import { Chess } from 'chess.js';
import { parsePgn } from './chesscom.mjs';

/**
 * Duolingo Chess has no public API. These are the private endpoints the
 * duolingo.com web app calls (as used by the duolingo-chess-history extension):
 *
 *   GET /chess/1/{userId}/matches?matchesLimit=N   → { matchHistory: [{ matchId, opponentName, … }] }
 *   GET /chess/1/{userId}/matches/{matchId}        → { match: { moveHistory: [uci…], outcome, playerColor, … } }
 *
 * Both need a signed-in session, so the server sends the account's JWT (the
 * `jwt_token` cookie on duolingo.com). The numeric user id is the JWT's `sub`.
 * Neither endpoint is documented and either may change without notice.
 */
const BASE = 'https://www.duolingo.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

/** Games have no public page, so this pseudo-URL is their identity in the library. */
export const DUOLINGO_PREFIX = 'duolingo:match:';
const gameKey = (matchId) => `${DUOLINGO_PREFIX}${matchId}`;

const fail = (message, status) => Object.assign(new Error(message), { status });

/** Accept the bare token, a `jwt_token=…` cookie pair, or a whole Cookie header. */
export function cleanJwt(raw) {
  const s = String(raw ?? '').trim();
  const fromCookie = s.match(/(?:^|;\s*)jwt_token=([^;\s]+)/)?.[1];
  return (fromCookie ?? s).replace(/^Bearer\s+/i, '').replace(/^"|"$/g, '');
}

export function userIdFromJwt(jwt) {
  const part = jwt.split('.')[1];
  if (!part) return null;
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    const sub = payload.sub ?? payload.user_id ?? payload.userId;
    return sub != null && /^\d+$/.test(String(sub)) ? String(sub) : null;
  } catch {
    return null;
  }
}

function session(rawJwt) {
  const jwt = cleanJwt(rawJwt);
  if (!jwt) {
    throw fail('Add your Duolingo token in Settings first (the jwt_token cookie from duolingo.com).', 400);
  }
  const userId = userIdFromJwt(jwt);
  if (!userId) throw fail('That Duolingo token does not look right: it has no user id in it.', 400);
  return { jwt, userId };
}

async function getJson(path, { jwt }) {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json',
      Authorization: `Bearer ${jwt}`,
      Cookie: `jwt_token=${jwt}`,
    },
  });
  if (res.status === 401 || res.status === 403) {
    throw fail('Duolingo refused the token. It has probably expired: copy a fresh jwt_token into Settings.', 401);
  }
  if (!res.ok) throw fail(`Duolingo answered ${res.status} ${res.statusText}`, res.status >= 500 ? 502 : res.status);
  return res.json();
}

/** Newest-first summaries of the account's matches, each with its moves replayed. */
export async function fetchRecentDuolingoGames(rawJwt, heroName, limit = 25) {
  const s = session(rawJwt);
  const list = await getJson(`/chess/1/${s.userId}/matches?matchesLimit=${Math.max(1, Math.min(limit, 200))}`, s);
  const entries = (list?.matchHistory ?? []).slice(0, limit);

  // The list carries little beyond the id and opponent, so each match is
  // fetched for its result, colour and moves — a few at a time.
  const out = new Array(entries.length);
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const i = next++;
      const entry = entries[i];
      try {
        const detail = await getJson(`/chess/1/${s.userId}/matches/${encodeURIComponent(entry.matchId)}`, s);
        out[i] = normalizeMatch(entry, detail?.match ?? {}, heroName);
      } catch (err) {
        if (err.status === 401) throw err;
        out[i] = normalizeMatch(entry, {}, heroName);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return out.filter(Boolean);
}

/** One match as a full game ready for the library. */
export async function fetchDuolingoGame(rawJwt, heroName, matchId, opponentName) {
  const id = String(matchId ?? '').replace(DUOLINGO_PREFIX, '').trim();
  if (!id) throw fail('matchId is required', 400);
  const s = session(rawJwt);
  const detail = await getJson(`/chess/1/${s.userId}/matches/${encodeURIComponent(id)}`, s);
  if (!detail?.match) throw fail('Duolingo did not return that match', 404);
  const game = normalizeMatch({ matchId: id, opponentName: opponentName || undefined }, detail.match, heroName);
  if (!game.pgn || !game.ply_count) throw fail('That match has no moves to review', 400);
  return game;
}

function normalizeMatch(entry, match, heroName) {
  const matchId = entry.matchId ?? match.matchId ?? match.id;
  const me = String(heroName ?? '').trim() || 'You';
  const opponent = entry.opponentName ?? match.opponentName ?? 'Duolingo Bot';
  const color = match.playerColor ?? entry.playerColor;
  const [white, black] = color === 'black' ? [opponent, me] : color === 'white' ? [me, opponent] : [null, null];
  const outcome = match.outcome ?? entry.outcome;
  const result = outcome === 'white' ? '1-0' : outcome === 'black' ? '0-1' : outcome === 'draw' ? '1/2-1/2' : '*';
  const when = pickDate(match) ?? pickDate(entry);

  let pgn = null;
  let plyCount = null;
  const moves = Array.isArray(match.moveHistory) ? match.moveHistory : null;
  if (moves && white) {
    try {
      pgn = buildPgn({ moves, white, black, result, when, matchId });
      plyCount = parsePgn(pgn).plyCount;
    } catch {
      pgn = null; // an illegal move list: listed, but not importable
    }
  }

  return {
    source: 'duolingo',
    match_id: String(matchId),
    url: gameKey(matchId),
    pgn,
    event: 'Duolingo Chess',
    white: white ?? (color ? null : `${me} / ${opponent}`),
    black,
    white_elo: null,
    black_elo: null,
    result: outcome ? result : null,
    played_at: when,
    ended_at: null,
    time_control: null,
    time_class: 'duolingo',
    eco: null,
    eco_url: null,
    termination: null,
    white_accuracy: null,
    black_accuracy: null,
    ply_count: plyCount,
    rated: null,
  };
}

function buildPgn({ moves, white, black, result, when, matchId }) {
  const chess = new Chess();
  for (const uci of moves) {
    const s = String(uci);
    const move = chess.move({ from: s.slice(0, 2), to: s.slice(2, 4), ...(s[4] ? { promotion: s[4] } : {}) });
    if (!move) throw new Error(`Invalid move ${s}`);
  }
  chess.setHeader('Event', 'Duolingo Chess');
  chess.setHeader('Site', 'Duolingo');
  if (when) {
    chess.setHeader('Date', when.slice(0, 10).replaceAll('-', '.'));
    chess.setHeader('UTCTime', when.slice(11, 19));
  }
  chess.setHeader('White', white);
  chess.setHeader('Black', black);
  chess.setHeader('Result', result);
  chess.setHeader('Link', gameKey(matchId));
  // chess.js writes "*" as the terminator unless the game ended on the board.
  return chess.pgn().replace(/\s\*$/, ` ${result}`);
}

/** The match JSON's date field is undocumented; take the first plausible one. */
function pickDate(obj) {
  for (const key of ['endTime', 'endedAt', 'finishedAt', 'completedAt', 'lastMoveTime', 'updatedAt',
    'startTime', 'startedAt', 'createdAt', 'timestamp', 'date']) {
    const v = obj?.[key];
    if (v == null || v === '') continue;
    const n = Number(v);
    const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(String(v));
    if (!Number.isNaN(d.getTime()) && d.getFullYear() > 2015) return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  return null;
}
