import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AdminTabs, formatDate, formatTimeControl } from '../components/bits';
import { api } from '../lib/api';
import { CLASSIFICATION_META } from '../lib/classify';
import type { DuolingoGame, Game, PuzzleIndexRow, RemoteGame, Settings } from '../lib/types';

export function AdminHome() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [games, setGames] = useState<Game[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setGames(await api.games());
  }, []);

  useEffect(() => {
    api.settings().then(setSettings);
    refresh().catch((e) => setError(e.message));
  }, [refresh]);

  const run = async (label: string, fn: () => Promise<string | void>) => {
    setBusy(label);
    setError(null);
    setStatus(null);
    try {
      const message = await fn();
      if (message) setStatus(message);
      await refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (!settings) return <div className="empty"><p className="muted">Loading…</p></div>;

  return (
    <div className="stack">
      <AdminTabs />
      {error && <ErrorDialog message={error} onClose={() => setError(null)} />}
      {status && <div className="banner ok">{status}</div>}

      <SettingsCard settings={settings} onSave={setSettings} />

      <div className="cols" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <ImportUrlCard busy={busy === 'url'} onImport={(url) =>
          run('url', async () => {
            const { duplicate, game } = await api.importUrl(url);
            return duplicate
              ? `Already imported: ${game.white} vs ${game.black}.`
              : `Imported ${game.white} vs ${game.black}.`;
          })
        } />

        <ImportPgnCard busy={busy === 'pgn'} onImport={(pgn) =>
          run('pgn', async () => {
            const { imported } = await api.importPgn(pgn);
            const fresh = imported.filter((i) => !i.duplicate).length;
            return `Imported ${fresh} game${fresh === 1 ? '' : 's'}` +
              (imported.length - fresh ? ` (${imported.length - fresh} already present).` : '.');
          })
        } />
      </div>

      <FindPuzzleCard />

      <RecentGamesCard
        username={settings.heroUsername}
        onImport={(url) =>
          run('recent', async () => {
            const { duplicate } = await api.importUrl(url);
            return duplicate ? 'That game was already imported.' : 'Game imported.';
          })
        }
      />

      <DuolingoGamesCard
        hasToken={Boolean(settings.duolingoJwt?.trim())}
        onImport={(g) =>
          run('duolingo', async () => {
            const opponent = g.white === (settings.heroUsername.trim() || 'You') ? g.black : g.white;
            const { duplicate } = await api.importDuolingo(g.match_id, opponent);
            return duplicate ? 'That game was already imported.' : 'Game imported.';
          })
        }
      />

      <GamesCard
        games={games}
        busy={busy}
        onDelete={(id) =>
          run('delete', async () => {
            await api.deleteGame(id);
            return 'Game deleted.';
          })
        }
        onExport={() =>
          run('export', async () => {
            const r = await api.exportPuzzles();
            return `Wrote ${r.counts.puzzles} puzzles from ${r.counts.games} games and ${r.counts.lines ?? 0} lines from ${r.counts.openings ?? 0} openings to ${r.path} (${(r.bytes / 1024).toFixed(1)} kB). Commit and push to publish.`;
          })
        }
      />
    </div>
  );
}

/** Errors pop up over the page so they are seen wherever it is scrolled to. */
function ErrorDialog({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => (e.key === 'Escape' || e.key === 'Enter') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h2>Something went wrong</h2>
        <p>{message}</p>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="primary" autoFocus onClick={onClose}>OK</button>
        </div>
      </div>
    </div>
  );
}

/**
 * Puzzles live under the game they came from, which is no help when all you
 * have is an id from a bug report. This looks one up directly.
 */
function FindPuzzleCard() {
  const [rows, setRows] = useState<PuzzleIndexRow[] | null>(null);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.puzzleIndex().then(setRows).catch((e) => setError((e as Error).message));
  }, []);

  // "12", "#12" and a pasted trainer link all mean puzzle 12.
  const term = query.trim().replace(/^.*#\/puzzle\//, '').replace(/^#/, '').toLowerCase();

  const hits = useMemo(() => {
    if (!rows || !term) return [];
    const byId = Number(term);
    const matches = Number.isInteger(byId) && String(byId) === term
      ? rows.filter((r) => r.id === byId)
      : rows.filter((r) =>
        [r.solution_san, r.played_san, r.classification, r.white, r.black, r.note]
          .some((f) => f?.toLowerCase().includes(term))
      );
    return matches.slice(0, 12);
  }, [rows, term]);

  return (
    <div className="card">
      <div className="card-head">
        <h2>Find a puzzle</h2>
        <input
          type="search"
          style={{ width: 260 }}
          value={query}
          placeholder="puzzle id, move, or opponent"
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="tiny faint">{rows ? `${rows.length} puzzles` : 'loading…'}</span>
      </div>

      {error && <div className="banner err">{error}</div>}

      {!term ? (
        <p className="tiny faint" style={{ margin: 0 }}>
          Search by id (from a puzzle link or a bug report), or by move, classification or opponent.
        </p>
      ) : !hits.length ? (
        <p className="tiny faint" style={{ margin: 0 }}>Nothing matches “{query.trim()}”.</p>
      ) : (
        <table className="table">
          <tbody>
            {hits.map((r) => (
              <tr key={r.id}>
                <td className="mono" style={{ width: 54 }}>#{r.id}</td>
                <td style={{ width: 34 }}>
                  <span title={r.classification} style={{ color: CLASSIFICATION_META[r.classification].color }}>
                    {CLASSIFICATION_META[r.classification].icon}
                  </span>
                </td>
                <td>
                  <span className="faint mono">{r.played_san}</span>
                  <span className="faint"> → </span>
                  <b className="mono">{r.solution_san}</b>
                  {!r.enabled && <span className="tiny faint"> · disabled</span>}
                </td>
                <td className="tiny muted">
                  {r.white} <span className="faint">vs</span> {r.black}
                  <div className="tiny faint">{formatDate(r.played_at)}</div>
                </td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>
                  <Link className="btn small" to={`/admin/game/${r.game_id}?puzzle=${r.id}`}>Edit</Link>{' '}
                  <a className="btn small" href={`#/puzzle/${r.id}`}>Train</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SettingsCard({ settings, onSave }: { settings: Settings; onSave: (s: Settings) => void }) {
  const [draft, setDraft] = useState(settings);
  const [saved, setSaved] = useState(false);

  const save = async () => {
    onSave(await api.saveSettings(draft));
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2>Settings</h2>
        <button className="small primary" onClick={save}>{saved ? 'Saved' : 'Save'}</button>
      </div>
      <div className="row" style={{ alignItems: 'flex-end', gap: 14 }}>
        <label className="field" style={{ flex: '1 1 220px' }}>
          <span>Your chess.com username</span>
          <input
            type="text"
            value={draft.heroUsername}
            placeholder="e.g. magnuscarlsen"
            onChange={(e) => setDraft({ ...draft, heroUsername: e.target.value })}
          />
        </label>
        <label className="field" style={{ width: 150 }}>
          <span>Engine depth</span>
          <select
            value={draft.depth}
            onChange={(e) => setDraft({ ...draft, depth: Number(e.target.value) })}
          >
            <option value={12}>12 — fast</option>
            <option value={16}>16 — balanced</option>
            <option value={20}>20 — slow</option>
          </select>
        </label>
        <label className="field" style={{ width: 160 }}>
          <span>Skip opening plies</span>
          <input
            type="number"
            min={0}
            max={30}
            value={draft.skipOpeningPlies}
            onChange={(e) => setDraft({ ...draft, skipOpeningPlies: Number(e.target.value) })}
          />
        </label>
        <label className="field" style={{ width: 170 }} title="Engine moves within this much win probability of the best are added as accepted answers on a new puzzle. 0 turns it off.">
          <span>Also accept within (win %)</span>
          <input
            type="number"
            min={0}
            max={20}
            step={0.5}
            value={draft.altMargin}
            onChange={(e) => setDraft({ ...draft, altMargin: Number(e.target.value) })}
          />
        </label>
        <label className="checkbox" style={{ paddingBottom: 9 }}>
          <input
            type="checkbox"
            checked={draft.onlyHeroMoves}
            onChange={(e) => setDraft({ ...draft, onlyHeroMoves: e.target.checked })}
          />
          Only flag my own moves
        </label>
      </div>
      <label className="field" style={{ marginTop: 12 }}>
        <span>Duolingo token (optional)</span>
        <input
          type="password"
          autoComplete="off"
          value={draft.duolingoJwt ?? ''}
          placeholder="jwt_token cookie from duolingo.com"
          onChange={(e) => setDraft({ ...draft, duolingoJwt: e.target.value })}
        />
      </label>
      <p className="tiny faint" style={{ marginTop: 10, marginBottom: 0 }}>
        The username decides which side of each game is yours, which is what makes a mistake "yours";
        Duolingo games are filed under it too. Duolingo has no public API: to pull your games, sign in at
        duolingo.com, open the developer tools, and copy the <span className="mono">jwt_token</span> cookie
        (Application → Cookies). It stays in your local database and expires now and then.
      </p>
    </div>
  );
}

function ImportUrlCard({ busy, onImport }: { busy: boolean; onImport: (url: string) => void }) {
  const [url, setUrl] = useState('');
  return (
    <div className="card">
      <div className="card-head"><h2>Import from chess.com</h2></div>
      <label className="field">
        <span>Game URL</span>
        <input
          type="text"
          value={url}
          placeholder="https://www.chess.com/game/live/123456789"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && url.trim() && onImport(url.trim())}
        />
      </label>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" disabled={busy || !url.trim()} onClick={() => onImport(url.trim())}>
          {busy ? 'Fetching…' : 'Import game'}
        </button>
      </div>
      <p className="tiny faint" style={{ marginTop: 10, marginBottom: 0 }}>
        Live, daily and analysis links all work.
      </p>
    </div>
  );
}

function ImportPgnCard({ busy, onImport }: { busy: boolean; onImport: (pgn: string) => void }) {
  const [pgn, setPgn] = useState('');
  return (
    <div className="card">
      <div className="card-head"><h2>Paste a PGN</h2></div>
      <label className="field">
        <span>PGN (one or many games)</span>
        <textarea
          value={pgn}
          placeholder={'[Event "Live Chess"]\n[White "..."]\n\n1. e4 e5 2. Nf3 ...'}
          onChange={(e) => setPgn(e.target.value)}
        />
      </label>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary" disabled={busy || !pgn.trim()} onClick={() => onImport(pgn)}>
          {busy ? 'Importing…' : 'Import PGN'}
        </button>
        <button className="ghost" disabled={!pgn} onClick={() => setPgn('')}>Clear</button>
      </div>
    </div>
  );
}

function RecentGamesCard({ username, onImport }: { username: string; onImport: (url: string) => Promise<boolean> }) {
  const [importing, setImporting] = useState<string | null>(null);
  const [name, setName] = useState(username);
  const [remote, setRemote] = useState<RemoteGame[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setName(username), [username]);

  const importGame = async (url: string) => {
    setImporting(url);
    const ok = await onImport(url);
    setImporting(null);
    if (ok) setRemote((rows) => rows && rows.map((g) => (g.url === url ? { ...g, imported: true } : g)));
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setRemote(await api.recentGames(name.trim(), 25));
    } catch (e) {
      setError((e as Error).message);
      setRemote(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2>Recent chess.com games</h2>
        <input
          type="text"
          style={{ width: 200 }}
          value={name}
          placeholder="username"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && name.trim() && load()}
        />
        <button className="small" disabled={loading || !name.trim()} onClick={load}>
          {loading ? 'Loading…' : 'Fetch'}
        </button>
      </div>

      {error && <div className="banner err">{error}</div>}
      {!remote && !error && <p className="tiny faint" style={{ margin: 0 }}>Pull your latest 25 games and import the ones worth reviewing.</p>}

      {remote && (
        <table className="table">
          <thead>
            <tr>
              <th>Players</th>
              <th>Started</th>
              <th>Finished</th>
              <th>Control</th>
              <th>Result</th>
              <th className="num">Accuracy</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {remote.map((g) => (
              <tr key={g.url ?? `${g.white}-${g.played_at}`}>
                <td>
                  {g.white} <span className="faint">({g.white_elo})</span>
                  <span className="faint"> vs </span>
                  {g.black} <span className="faint">({g.black_elo})</span>
                </td>
                <td className="tiny muted">{formatDate(g.played_at)}</td>
                <td className="tiny muted">{formatDate(g.ended_at)}</td>
                <td className="tiny muted">{formatTimeControl(g.time_control, g.time_class)}</td>
                <td className="mono tiny">{g.result}</td>
                <td className="num tiny muted">
                  {g.white_accuracy != null
                    ? `${g.white_accuracy.toFixed(0)} / ${g.black_accuracy?.toFixed(0)}`
                    : '—'}
                </td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>
                  {g.url && (
                    <a className="btn small" href={g.url} target="_blank" rel="noreferrer">chess.com ↗</a>
                  )}{' '}
                  <button
                    className="small"
                    disabled={g.imported || !g.url || importing !== null}
                    onClick={() => g.url && importGame(g.url)}
                  >
                    {g.imported ? 'Imported' : importing === g.url ? 'Importing…' : 'Import'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Duolingo Chess matches, fetched with the account's own session token. */
function DuolingoGamesCard({ hasToken, onImport }: { hasToken: boolean; onImport: (g: DuolingoGame) => Promise<boolean> }) {
  const [importing, setImporting] = useState<string | null>(null);
  const [remote, setRemote] = useState<DuolingoGame[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [copied, setCopied] = useState<string | null>(null);

  const copyPgn = async (g: DuolingoGame) => {
    if (!g.pgn) return;
    await navigator.clipboard.writeText(g.pgn);
    setCopied(g.match_id);
    window.setTimeout(() => setCopied((id) => (id === g.match_id ? null : id)), 1800);
  };

  // chess.com's analysis board takes a pasted PGN, so copy first, then open it.
  const analyse = async (g: DuolingoGame) => {
    // Copy before opening: the clipboard refuses writes once the page loses focus.
    await copyPgn(g);
    window.open('https://www.chess.com/analysis', '_blank', 'noopener');
  };

  const downloadAll = () => {
    const pgns = (remote ?? []).map((g) => g.pgn).filter(Boolean);
    const blob = new Blob([pgns.join('\n\n')], { type: 'application/x-chess-pgn' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `duolingo-games-${new Date().toISOString().slice(0, 10)}.pgn`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const importGame = async (g: DuolingoGame) => {
    setImporting(g.match_id);
    const ok = await onImport(g);
    setImporting(null);
    if (ok) setRemote((rows) => rows && rows.map((r) => (r.match_id === g.match_id ? { ...r, imported: true } : r)));
  };

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setRemote(await api.duolingoGames(25));
    } catch (e) {
      setError((e as Error).message);
      setRemote(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2>Recent Duolingo games</h2>
        {remote?.some((g) => g.pgn) && (
          <button className="small ghost" onClick={downloadAll} title="One .pgn file with every listed game">
            Download all PGN
          </button>
        )}
        <button className="small" disabled={loading || !hasToken} onClick={load}>
          {loading ? 'Loading…' : 'Fetch'}
        </button>
      </div>

      {error && <div className="banner err">{error}</div>}
      {!remote && !error && (
        <p className="tiny faint" style={{ margin: 0 }}>
          {hasToken
            ? 'Pull your latest 25 Duolingo Chess matches. Import the ones worth reviewing, or copy a PGN to paste into chess.com\'s analysis board.'
            : 'Add your Duolingo token in Settings (and save) to list your Duolingo Chess matches.'}
        </p>
      )}
      {remote && !remote.length && <p className="tiny faint" style={{ margin: 0 }}>No Duolingo matches found.</p>}

      {remote && remote.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>Players</th>
              <th>Played</th>
              <th className="num">Moves</th>
              <th>Result</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {remote.map((g) => (
              <tr key={g.match_id}>
                <td>
                  {g.white ?? '?'}
                  {g.black && <><span className="faint"> vs </span>{g.black}</>}
                </td>
                <td className="tiny muted">{g.played_at ? formatDate(g.played_at) : '—'}</td>
                <td className="num tiny muted">{g.ply_count != null ? Math.ceil(g.ply_count / 2) : '—'}</td>
                <td className="mono tiny">{g.result ?? '—'}</td>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>
                  <button className="small ghost" disabled={!g.pgn} onClick={() => copyPgn(g)}>
                    {copied === g.match_id ? 'Copied' : 'Copy PGN'}
                  </button>{' '}
                  <button
                    className="small"
                    disabled={!g.pgn}
                    title="Copies the PGN and opens chess.com's analysis board: paste it there"
                    onClick={() => analyse(g)}
                  >
                    chess.com ↗
                  </button>{' '}
                  <button
                    className="small"
                    disabled={g.imported || !g.importable || importing !== null}
                    title={g.importable ? undefined : 'Duolingo did not return playable moves for this match'}
                    onClick={() => importGame(g)}
                  >
                    {g.imported ? 'Imported' : importing === g.match_id ? 'Importing…' : 'Import'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function GamesCard({
  games,
  busy,
  onDelete,
  onExport,
}: {
  games: Game[];
  busy: string | null;
  onDelete: (id: number) => void;
  onExport: () => void;
}) {
  const totalPuzzles = games.reduce((n, g) => n + g.puzzle_count, 0);

  return (
    <div className="card">
      <div className="card-head">
        <h2>Your library</h2>
        <span className="tiny faint">{games.length} games · {totalPuzzles} puzzles</span>
        <button className="primary small" disabled={busy === 'export'} onClick={onExport}>
          {busy === 'export' ? 'Exporting…' : 'Export puzzles.json'}
        </button>
      </div>

      {!games.length ? (
        <p className="muted tiny" style={{ margin: 0 }}>Import a game above to get started.</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Players</th>
              <th>Started</th>
              <th>Finished</th>
              <th>You</th>
              <th>Analysis</th>
              <th className="num">Puzzles</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {games.map((g) => (
              <tr key={g.id}>
                <td>
                  <Link to={`/admin/game/${g.id}`}>
                    {g.white} <span className="faint">vs</span> {g.black}
                  </Link>
                  <div className="tiny faint">{g.result} · {formatTimeControl(g.time_control, g.time_class)}</div>
                </td>
                <td className="tiny muted">{formatDate(g.played_at)}</td>
                <td className="tiny muted">{formatDate(g.ended_at)}</td>
                <td className="tiny">
                  {g.hero_color ? (
                    <span className="row-tight">
                      <span className={`side-dot ${g.hero_color}`} />
                      {g.hero_result ?? '—'}
                    </span>
                  ) : (
                    <span className="faint">not set</span>
                  )}
                </td>
                <td className="tiny muted">
                  {g.analyzed_at ? `depth ${g.analysis_depth ?? '?'}` : <span className="faint">not analysed</span>}
                </td>
                <td className="num">{g.puzzle_count || <span className="faint">0</span>}</td>
                <td className="num">
                  <Link className="btn small" to={`/admin/game/${g.id}`}>Review</Link>{' '}
                  <button
                    className="small danger"
                    onClick={() => confirm('Delete this game and its puzzles?') && onDelete(g.id)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="tiny faint" style={{ marginTop: 12, marginBottom: 0 }}>
        Export writes <span className="mono">public/data/puzzles.json</span>. Commit that file and push to
        update the published trainer — your database and this admin area stay on this machine.
      </p>
    </div>
  );
}
