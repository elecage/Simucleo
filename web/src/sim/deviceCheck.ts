// "이 기기에서 잘 돌아갈까?" (M31): a few representative examples run flat
// out for a couple of seconds each in a separate worker, without drawing
// anything, and the slowest one gives the verdict (see `verdict`).
import { toCircuit } from "../editor/model";
import { parse } from "../editor/project";
import { boardSignals, busCatalog } from "../parts";
import type { BenchJob, BenchReply } from "./benchWorker";
import { verdict, type Verdict } from "./perf";

/** A timer/PWM example, a bus with a display, many parts on SPI: what lessons use. */
export const CHECK_EXAMPLES = ["hal-pwm-led", "hal-i2c-oled", "hal-shift-register"];
/** Simulated time per example (ms), and the most wall time it may take. */
export const CHECK_SIM_MS = 2000;
export const CHECK_MAX_WALL_MS = 4000;

export interface CheckResult {
  rows: BenchReply[];
  worst: number;
  verdict: Verdict;
}

async function job(name: string): Promise<BenchJob> {
  const elf = await (await fetch(`./examples/${name}.elf`)).arrayBuffer();
  let wiring: BenchJob["wiring"];
  const r = await fetch(`./examples/${name}.simucleo.json`);
  if (r.ok) {
    const { project } = parse(await r.text());
    wiring = {
      circuit: JSON.stringify(toCircuit(project)),
      catalog: JSON.stringify(busCatalog()),
      signals: JSON.stringify(boardSignals()),
    };
  }
  return { name, elf, wiring, simMs: CHECK_SIM_MS, maxWallMs: CHECK_MAX_WALL_MS };
}

/** Run `names` headless, one after the other, in a worker of their own. */
export async function runBench(names: string[], onRow?: (row: BenchReply) => void, simMs = CHECK_SIM_MS): Promise<BenchReply[]> {
  const w = new Worker(new URL("./benchWorker.ts", import.meta.url), { type: "module" });
  try {
    const rows: BenchReply[] = [];
    for (const name of names) {
      const j = { ...(await job(name)), simMs };
      const row = await new Promise<BenchReply>((resolve, reject) => {
        w.onmessage = (e: MessageEvent<BenchReply>) => resolve(e.data);
        w.onerror = (e) => reject(new Error(e.message));
        w.postMessage(j, [j.elf]);
      });
      rows.push(row);
      onRow?.(row);
    }
    return rows;
  } finally {
    w.terminate();
  }
}

/** Run the check; `onRow` after each example. */
export async function runDeviceCheck(onRow?: (row: BenchReply) => void): Promise<CheckResult> {
  const rows = await runBench(CHECK_EXAMPLES, onRow);
  const worst = Math.min(...rows.map((r) => (r.error ? 0 : r.ratio)));
  return { rows, worst, verdict: verdict(worst) };
}

// Test hook (E2E): the headless speed of any bundled example.
if (typeof window !== "undefined") (window as unknown as { __simucleoBench: typeof runBench }).__simucleoBench = runBench;
