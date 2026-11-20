// Run a simulator flat out the way the worker runs it, without a page to
// draw on (M31): 10 ms steps, a display frame closed and parsed every
// 1/60 s of simulated time, the console drained. Shared by the device
// check (`deviceCheck.ts`, in a worker) and `scripts/bench.mjs` (Node);
// `crates/wasm/examples/bench.rs` does the same natively.

/** The `Simulator` methods a benchmark needs. */
export interface BenchSim {
  runForMs(ms: number): string;
  frame(): string;
  takeConsole(): string;
  timeMs(): number;
}

export interface BenchResult {
  /** Simulated time run (ms). */
  simMs: number;
  /** Wall time it took (ms). */
  wallMs: number;
  /** ×real-time: simulated / wall time. */
  ratio: number;
  /** Why the firmware stopped, if it did. */
  stopped?: string;
}

export const BENCH_FRAME_MS = 1000 / 60;
export const BENCH_STEP_MS = 10;

/** Run `simMs` of simulated time (or until `maxWallMs` of wall time has gone by). */
export function benchRun(sim: BenchSim, simMs: number, maxWallMs = Infinity, now: () => number = () => performance.now()): BenchResult {
  const t0 = now();
  const s0 = sim.timeMs();
  let stopped: string | undefined;
  while (sim.timeMs() - s0 < simMs - 1e-6 && now() - t0 < maxWallMs && !stopped) {
    let frame = BENCH_FRAME_MS;
    while (frame > 1e-9) {
      const step = Math.min(BENCH_STEP_MS, frame);
      const why = sim.runForMs(step);
      frame -= step;
      if (why) {
        stopped = why;
        break;
      }
    }
    JSON.parse(sim.frame());
    sim.takeConsole();
  }
  const wallMs = Math.max(now() - t0, 1e-3);
  const ran = sim.timeMs() - s0;
  return { simMs: ran, wallMs, ratio: ran / wallMs, ...(stopped ? { stopped } : {}) };
}
