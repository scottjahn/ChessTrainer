import { Chess } from 'chess.js';
import type { Score } from './types';

export interface EvalResult {
  fen: string;
  depth: number;
  score: Score;
  bestUci: string | null;
  pv: string[];
  /** True when the position is already over, so no search was run. */
  terminal: boolean;
}

const readLine = (event: MessageEvent): string =>
  (typeof event.data === 'string' ? event.data : String(event.data?.data ?? '')).trim();

type Pending = {
  fen: string;
  depth: number;
  resolve: (r: EvalResult) => void;
  reject: (e: Error) => void;
  score: Score | null;
  reachedDepth: number;
  pv: string[];
};

/**
 * A thin UCI client over the Stockfish WASM worker.
 *
 * Requests are queued and run one at a time: the engine is a single instance
 * with one search at a time, and a whole-game scan is naturally sequential.
 */
export class Engine {
  private worker: Worker | null = null;
  private current: Pending | null = null;
  private queue: Array<() => void> = [];
  private booted: Promise<void> | null = null;
  private disposed = false;

  readonly multiThreaded = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;

  get scriptUrl(): string {
    return this.multiThreaded
      ? '/engine/stockfish-19-lite.js'
      : '/engine/stockfish-19-lite-single.js';
  }

  /** Boot the worker and wait for `uciok` / `readyok`. */
  async init(): Promise<void> {
    if (this.booted) return this.booted;
    this.booted = new Promise<void>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(this.scriptUrl);
      } catch (e) {
        reject(new Error(`Could not start the engine worker: ${(e as Error).message}`));
        return;
      }
      this.worker = worker;

      const timer = setTimeout(
        () => reject(new Error('The engine did not respond. Is the local API running (npm run dev)?')),
        30_000
      );

      worker.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error(
          `The engine worker stopped: ${e.message || `no error detail from ${this.scriptUrl}`}`
        ));
      };

      worker.onmessage = (event: MessageEvent) => {
        const line = readLine(event);
        if (line === 'uciok') {
          // No Hash option: these WASM builds run on a fixed heap and abort
          // outright if asked for a transposition table they cannot allocate.
          if (this.multiThreaded) {
            const threads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
            worker.postMessage(`setoption name Threads value ${threads}`);
          }
          worker.postMessage('isready');
          return;
        }
        if (line === 'readyok' && !this.current) {
          clearTimeout(timer);
          worker.onmessage = (e) => this.onLine(readLine(e));
          resolve();
          return;
        }
      };

      worker.postMessage('uci');
    });
    return this.booted;
  }

  /** Search one position to a fixed depth. */
  async analyse(fen: string, depth: number): Promise<EvalResult> {
    await this.init();
    if (this.disposed) throw new Error('Engine was stopped');

    const terminal = terminalScore(fen);
    if (terminal) {
      return { fen, depth: 0, score: terminal, bestUci: null, pv: [], terminal: true };
    }

    return new Promise<EvalResult>((resolve, reject) => {
      const run = () => {
        this.current = { fen, depth, resolve, reject, score: null, reachedDepth: 0, pv: [] };
        this.worker!.postMessage('ucinewgame');
        this.worker!.postMessage(`position fen ${fen}`);
        this.worker!.postMessage(`go depth ${depth}`);
      };
      if (this.current) this.queue.push(run);
      else run();
    });
  }

  private onLine(line: string) {
    const pending = this.current;
    if (!pending) return;

    if (line.startsWith('info ')) {
      const depth = Number(line.match(/\bdepth (\d+)/)?.[1] ?? 0);
      const mate = line.match(/\bscore mate (-?\d+)/);
      const cp = line.match(/\bscore cp (-?\d+)/);
      if (!mate && !cp) return;
      if (depth < pending.reachedDepth) return;

      pending.reachedDepth = depth;
      pending.score = mate
        ? { type: 'mate', value: Number(mate[1]) }
        : { type: 'cp', value: Number(cp![1]) };
      const pv = line.match(/\bpv (.+)$/)?.[1];
      if (pv) pending.pv = pv.trim().split(/\s+/);
      return;
    }

    if (line.startsWith('bestmove')) {
      const best = line.split(/\s+/)[1];
      this.current = null;
      pending.resolve({
        fen: pending.fen,
        depth: pending.reachedDepth,
        score: pending.score ?? { type: 'cp', value: 0 },
        bestUci: !best || best === '(none)' ? null : best,
        pv: pending.pv,
        terminal: false,
      });
      this.queue.shift()?.();
    }
  }

  stop() {
    this.worker?.postMessage('stop');
  }

  dispose() {
    this.disposed = true;
    this.queue = [];
    this.current?.reject(new Error('Engine stopped'));
    this.current = null;
    this.worker?.terminate();
    this.worker = null;
    this.booted = null;
  }
}

/** Checkmate and draws have no search result, so score them directly. */
function terminalScore(fen: string): Score | null {
  try {
    const chess = new Chess(fen);
    if (chess.isCheckmate()) return { type: 'mate', value: 0 };
    if (chess.isDraw() || chess.isStalemate()) return { type: 'cp', value: 0 };
    return null;
  } catch {
    return null;
  }
}
