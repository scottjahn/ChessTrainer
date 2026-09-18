import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocalApi } from '../App';
import { ClassPill, formatDate } from '../components/bits';
import { loadPack } from '../lib/puzzles';
import { exportStats, importStats, loadStats, puzzleKey, resetStats, totals } from '../lib/stats';
import type { PuzzlePack } from '../lib/types';

type SortKey = 'worst' | 'seen' | 'recent' | 'game';

export function Progress() {
  const local = useLocalApi();
  const [pack, setPack] = useState<PuzzlePack | null>(null);
  const [stats, setStats] = useState(() => loadStats());
  const [sort, setSort] = useState<SortKey>('worst');
  const [note, setNote] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (local === null) return;
    loadPack(local).then(({ pack: p }) => setPack(p));
  }, [local]);

  const summary = useMemo(() => (pack ? totals(stats, pack.puzzles) : null), [pack, stats]);

  const rows = useMemo(() => {
    if (!pack) return [];
    const list = pack.puzzles.map((p) => {
      const s = stats[puzzleKey(p)];
      return {
        puzzle: p,
        game: pack.games[String(p.gameId)],
        attempts: s?.attempts ?? 0,
        solves: s?.solves ?? 0,
        rate: s?.attempts ? s.solves / s.attempts : -1,
        lastSeen: s?.lastSeen ?? null,
      };
    });
    const byKey = {
      // Untried puzzles sort last here; the point of "worst" is what you keep missing.
      worst: (a: typeof list[0], b: typeof list[0]) =>
        (a.rate < 0 ? 2 : a.rate) - (b.rate < 0 ? 2 : b.rate) || b.attempts - a.attempts,
      seen: (a: typeof list[0], b: typeof list[0]) => b.attempts - a.attempts,
      recent: (a: typeof list[0], b: typeof list[0]) =>
        (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''),
      game: (a: typeof list[0], b: typeof list[0]) =>
        (b.game?.playedAt ?? '').localeCompare(a.game?.playedAt ?? '') || a.puzzle.ply - b.puzzle.ply,
    };
    return list.sort(byKey[sort]);
  }, [pack, stats, sort]);

  if (!pack) return <div className="empty"><p className="muted">Loading…</p></div>;
  if (!pack.puzzles.length) {
    return (
      <div className="empty">
        <h2>Nothing to track yet</h2>
        <p>Progress appears once there are puzzles in the set.</p>
      </div>
    );
  }

  const download = () => {
    const blob = new Blob([exportStats(stats)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `chess-trainer-stats-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const upload = async (file: File) => {
    try {
      setStats(importStats(await file.text()));
      setNote('Stats imported.');
    } catch {
      setNote('That file was not a stats export.');
    }
  };

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <h2>Overall</h2>
          <button className="small" onClick={download}>Back up stats</button>
          <button className="small" onClick={() => fileInput.current?.click()}>Restore</button>
          <button
            className="small danger"
            onClick={() => {
              if (confirm('Erase every attempt and solve count in this browser?')) {
                setStats(resetStats());
                setNote('Stats cleared.');
              }
            }}
          >
            Reset
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json"
            hidden
            onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
          />
        </div>

        <div className="statline">
          <div className="stat"><b>{summary!.puzzles}</b><span>Puzzles</span></div>
          <div className="stat"><b>{summary!.seen}</b><span>Attempted</span></div>
          <div className="stat"><b>{summary!.unseen}</b><span>Untried</span></div>
          <div className="stat"><b>{summary!.attempts}</b><span>Total tries</span></div>
          <div className="stat"><b>{summary!.accuracy.toFixed(0)}%</b><span>Accuracy</span></div>
        </div>

        <div className="progress-track" style={{ marginTop: 14 }}>
          <div
            className="progress-fill"
            style={{ width: `${summary!.puzzles ? (summary!.seen / summary!.puzzles) * 100 : 0}%` }}
          />
        </div>
        <p className="tiny faint" style={{ marginTop: 6, marginBottom: 0 }}>
          Stats are stored in this browser only. Back them up before clearing site data.
        </p>
        {note && <p className="tiny" style={{ marginTop: 8, marginBottom: 0 }}>{note}</p>}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Every puzzle</h2>
          <select
            style={{ width: 'auto' }}
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
          >
            <option value="worst">Weakest first</option>
            <option value="seen">Most seen</option>
            <option value="recent">Recently trained</option>
            <option value="game">Newest game</option>
          </select>
        </div>

        <table className="table">
          <thead>
            <tr>
              <th>Move</th>
              <th>Type</th>
              <th>Game</th>
              <th>Played</th>
              <th className="num">Seen</th>
              <th className="num">Solved</th>
              <th className="num">Rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ puzzle, game, attempts, solves, rate }) => (
              <tr key={puzzle.id}>
                <td className="mono">
                  {Math.floor(puzzle.ply / 2) + 1}
                  {puzzle.sideToMove === 'w' ? '.' : '…'} {puzzle.solutionSan}
                </td>
                <td><ClassPill value={puzzle.classification} /></td>
                <td className="tiny">
                  {game?.url ? (
                    <a href={game.url} target="_blank" rel="noreferrer">
                      {game.white} – {game.black}
                    </a>
                  ) : (
                    `${game?.white ?? '?'} – ${game?.black ?? '?'}`
                  )}
                </td>
                <td className="tiny muted">{formatDate(game?.playedAt)}</td>
                <td className="num">{attempts}</td>
                <td className="num">{solves}</td>
                <td className="num">{rate < 0 ? <span className="faint">—</span> : `${Math.round(rate * 100)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
