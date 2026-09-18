import { CLASSIFICATION_META } from '../lib/classify';
import type { Classification, ExportedGame } from '../lib/types';

export function ClassPill({ value }: { value: Classification }) {
  const meta = CLASSIFICATION_META[value];
  return (
    <span className="pill" style={{ color: meta.color, borderColor: meta.color }}>
      <span aria-hidden>{meta.icon}</span>
      {meta.label}
    </span>
  );
}

export const formatDate = (iso: string | null | undefined): string =>
  iso
    ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
    : '—';

const DURATION_UNITS: [number, string][] = [
  [86400, 'day'],
  [3600, 'hour'],
  [60, 'min'],
  [1, 'sec'],
];

/** Seconds as the largest unit that fits: 259200 -> "3 days", 180 -> "3 min". */
function formatDuration(seconds: number): string {
  const [size, unit] = DURATION_UNITS.find(([s]) => seconds >= s) ?? DURATION_UNITS[3];
  const value = seconds / size;
  const shown = Number.isInteger(value) ? String(value) : value.toFixed(1);
  const plural = value === 1 || unit === 'min' || unit === 'sec' ? '' : 's';
  return `${shown} ${unit}${plural}`;
}

/**
 * chess.com's raw time controls: "180" and "600+5" are live games in seconds
 * (base + increment), "1/259200" is a daily game at one move per 3 days.
 */
export function formatTimeControl(tc: string | null | undefined, cls?: string | null): string {
  if (!tc) return cls ?? '—';

  const daily = /^(\d+)\/(\d+)$/.exec(tc);
  if (daily) {
    const perMove = formatDuration(Number(daily[2]));
    return daily[1] === '1' ? `${perMove}/move` : `${daily[1]} moves / ${perMove}`;
  }

  const [base, inc] = tc.split('+');
  const seconds = Number(base);
  const increment = Number(inc ?? 0);
  if (!Number.isFinite(seconds)) return cls ? `${cls} · ${tc}` : tc;

  // Chess shorthand puts the base in minutes and the increment in seconds:
  // "120+1" is 2+1 min. Under a minute there are no minutes to shorten.
  const minutes = seconds / 60;
  const label =
    seconds >= 60 && increment
      ? `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}+${increment} min`
      : `${formatDuration(seconds)}${increment ? ` +${increment} sec` : ''}`;
  return cls ? `${label} ${cls}` : label;
}

const RESULT_WORD: Record<string, string> = { win: 'Won', loss: 'Lost', draw: 'Drew' };

export function GameMeta({ game, side }: { game: ExportedGame | undefined; side: 'w' | 'b' }) {
  if (!game) return <p className="muted tiny">Game details are missing from this export.</p>;

  const heroIsWhite = (game.heroColor ?? side) === 'w';
  const you = heroIsWhite ? game.white : game.black;
  const them = heroIsWhite ? game.black : game.white;
  const yourElo = heroIsWhite ? game.whiteElo : game.blackElo;
  const theirElo = heroIsWhite ? game.blackElo : game.whiteElo;
  const accuracy = heroIsWhite ? game.whiteAccuracy : game.blackAccuracy;

  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="stack" style={{ gap: 4 }}>
        <div className="player-line">
          <span className={`side-dot ${heroIsWhite ? 'w' : 'b'}`} />
          <b>{you ?? 'You'}</b>
          {yourElo ? <span className="muted tiny">({yourElo})</span> : null}
        </div>
        <div className="player-line">
          <span className={`side-dot ${heroIsWhite ? 'b' : 'w'}`} />
          <span>{them ?? 'Opponent'}</span>
          {theirElo ? <span className="muted tiny">({theirElo})</span> : null}
        </div>
      </div>

      <dl className="meta-grid">
        <dt>Played</dt>
        <dd>{formatDate(game.playedAt)}</dd>

        <dt>Result</dt>
        <dd>
          {game.heroResult ? RESULT_WORD[game.heroResult] : game.result ?? '—'}
          {game.termination ? <span className="muted tiny"> · {game.termination}</span> : null}
        </dd>

        <dt>Control</dt>
        <dd>{formatTimeControl(game.timeControl, game.timeClass)}</dd>

        {game.eco ? (
          <>
            <dt>Opening</dt>
            <dd>
              {game.ecoUrl ? (
                <a href={game.ecoUrl} target="_blank" rel="noreferrer">
                  {openingName(game.ecoUrl) ?? game.eco}
                </a>
              ) : (
                game.eco
              )}
            </dd>
          </>
        ) : null}

        {accuracy != null ? (
          <>
            <dt>Accuracy</dt>
            <dd>{accuracy.toFixed(1)}%</dd>
          </>
        ) : null}
      </dl>

      {game.url ? (
        <a href={game.url} target="_blank" rel="noreferrer" className="tiny">
          View the full game on chess.com ↗
        </a>
      ) : null}
    </div>
  );
}

/** chess.com opening URLs end in a readable slug; turn it back into a name. */
function openingName(url: string): string | null {
  const slug = url.split('/').pop();
  if (!slug) return null;
  const name = slug.split(/-\d/)[0].replaceAll('-', ' ').trim();
  return name.length > 2 ? name : null;
}
