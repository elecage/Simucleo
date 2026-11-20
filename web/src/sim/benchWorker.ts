/// <reference lib="webworker" />
// The device check's simulator (M31): its own worker and core, so the
// check neither disturbs the user's simulation nor draws anything.
import init, { Simulator } from "../wasm/pkg/simucleo_wasm.js";
import { benchRun } from "./benchRun";

export interface BenchJob {
  name: string;
  elf: ArrayBuffer;
  /** `setWiring` arguments (JSON), when the example comes with a circuit. */
  wiring?: { circuit: string; catalog: string; signals: string };
  simMs: number;
  maxWallMs: number;
}
export type BenchReply = { name: string; ratio: number; simMs: number; wallMs: number; error?: string };

const ready = init();

self.onmessage = async (e: MessageEvent<BenchJob>) => {
  const job = e.data;
  await ready;
  const post = (m: BenchReply) => (self as unknown as Worker).postMessage(m);
  try {
    const sim = new Simulator();
    sim.loadElf(new Uint8Array(job.elf));
    if (job.wiring) sim.setWiring(job.wiring.circuit, job.wiring.catalog, job.wiring.signals);
    // Warm up (the first run compiles the hot paths), then measure.
    benchRun(sim, 100, 1000);
    const r = benchRun(sim, job.simMs, job.maxWallMs);
    sim.free();
    post({ name: job.name, ratio: r.ratio, simMs: r.simMs, wallMs: r.wallMs, ...(r.stopped ? { error: r.stopped } : {}) });
  } catch (err) {
    post({ name: job.name, ratio: 0, simMs: 0, wallMs: 0, error: String(err) });
  }
};
