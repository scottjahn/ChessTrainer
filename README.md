# Chess Mistake Trainer

Train on the moves you actually got wrong. Import your chess.com games, let
Stockfish find your mistakes, record the move you should have played, and drill
those positions like puzzles.

Two halves, deliberately split:

| | Admin | Trainer |
|---|---|---|
| Runs | only on your machine | anywhere, including GitHub Pages |
| Needs | Node + local API + SQLite | a static file |
| Holds | games, PGNs, engine analysis | the exported puzzle set |
| Stats | mirrored into SQLite | the visitor's own browser |

Your games, database and engine never leave your machine. `npm run export`
freezes the finished puzzles into `public/data/puzzles.json`, and that one file
is what the published trainer reads — so anyone you share the link with can try
your puzzles and keep their own score.

## Getting started

```bash
npm install
npm run dev
```

Then open <http://localhost:5173>. The API runs on port 8787; the app detects it
and shows the **Admin** tab. Without it, the same app runs as the public trainer.

## Loading a game

1. **Admin → Settings**: enter your chess.com username and save. This is what
   decides which side of each game is yours, and therefore which mistakes count
   as yours.
2. Import a game by pasting a **chess.com URL** (live, daily or analysis links
   all work), by pasting **PGN** (one game or many), or from the **Recent
   chess.com games** list.
3. Open the game and press **Analyse game**. Stockfish scores every position in
   your browser and labels each move.
4. In **Flagged moves**, press *Add* on anything you want to drill. The engine's
   move is filled in as the answer — play a different move on the board to
   override it, add a note if you want one, and save.
5. Back in the library, press **Export puzzles.json**.

## Publishing

`npm run export` (or the Export button) writes `public/data/puzzles.json`.
Commit that file and push:

```bash
npm run export
git add public/data/puzzles.json
git commit -m "Update puzzle set"
git push
```

The included workflow builds the static site and deploys it to GitHub Pages.
Enable it once under **Settings → Pages → Source: GitHub Actions**. The build
never runs the exporter, so CI cannot overwrite your puzzle set with an empty one.

## How moves are graded

chess.com's Game Review labels are not available through their public API — that
API returns PGN only. So the labels here are reproduced with Stockfish.

Every position is searched once. A position's score is the score *before* the
move played there; negating the next position's score gives the score *after*
it. Both are converted to win probability, because centipawns are a poor measure
of damage — losing 200cp from a dead-equal position costs far more of the game
than losing 200cp when you are already winning by a queen.

| Label | Win probability lost |
|---|---|
| Inaccuracy | 5% |
| Mistake | 10% |
| Blunder | 20% |
| Miss | you had a winning position, gave most of it up, but did not end up worse |

Thresholds live in `src/lib/classify.ts`; depth and the opening skip are in
Settings. *Miss* is chess.com's own category with no published definition, so it
is an approximation. Every label can be overridden by hand when you save a puzzle.

## Training

Puzzles are picked with a weighting, not uniformly: unseen positions come up
most, then the ones you keep failing, and a puzzle you have solved several times
in a row barely appears. Switch to specific mistake types or "never solved" with
the filters.

- **Hint** rings the piece that should move.
- **Show solution** plays it.
- An attempt is scored on your first try: a wrong move or a revealed solution
  counts as a miss, but you can keep hunting for the move afterwards.
- <kbd>H</kbd> hint · <kbd>S</kbd> solution · <kbd>N</kbd> next

Stats are keyed by position, not by database id, so re-exporting or rebuilding
the puzzle set never wipes your history. They live in `localStorage`, which means
they are per-browser — **Progress → Back up stats** downloads them as JSON.

## Layout

```
server/        local admin API (Express + node:sqlite, no native modules)
  chesscom.mjs chess.com URL -> PGN resolution
  payload.mjs  the exported puzzle shape
src/lib/       engine client, classification, puzzle selection, stats
src/pages/     Trainer, Progress, AdminHome, AdminGame
public/data/   puzzles.json  <- the published puzzle set (commit this)
data/          chesstrainer.db  <- your library (git-ignored, back it up)
engine/        Stockfish WASM, copied from node_modules (git-ignored)
```

## Notes

- **Node 24 is required** (`>=23.4`). Storage is `node:sqlite`, built into Node,
  so there are no native modules to compile and the project moves between
  machines cleanly — but that module only works without an opt-in flag from Node
  23.4 onward. On Node 22.x you would have to run the API as
  `node --experimental-sqlite server/index.mjs`. Check with `node -v`; the app
  tells you plainly if the version is too old.
- Runs the same on macOS, Linux and Windows. Nothing is platform-specific: no
  native dependencies, no shell scripts, and all paths are built with
  `node:path`.
- The engine is the ~1.7 MB "lite" Stockfish 19 build, not the 95 MB full net —
  ample for spotting a blunder. It is served by the local API from `engine/`, so
  it is never part of the published bundle.
- Analysis runs multi-threaded when the page is cross-origin isolated (the dev
  server sets the headers) and falls back to single-threaded otherwise. A worker
  started from an isolated page must itself be served with `Cross-Origin-
  Embedder-Policy`, which is why the API sets that header on `engine/`.
- Reviewing a game again is cheap: analysis is cached per position in SQLite.
