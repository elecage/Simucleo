// Unit tests of M31: the real-time ratio, the page-thread meter, the auto
// switch with its hysteresis, the update-rate scheduler, the worker's
// batching rule, the saved mode, the device-check verdict and the
// headless benchmark loop (`npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AutoSwitch,
  batchDue,
  batchHz,
  ENTER_MS,
  EXIT_MS,
  formatRatio,
  fullRateBusy,
  LITE_HZ,
  loadMode,
  PERF_KEY,
  RateScheduler,
  RatioMeter,
  saveMode,
  UiMeter,
  uiRecovered,
  uiStruggles,
  verdict,
  type Health,
} from "../src/sim/perf.ts";
import { benchRun, BENCH_FRAME_MS, type BenchSim } from "../src/sim/benchRun.ts";
import { sameJson } from "../src/sim/sameJson.ts";
import { dropStaleCaptures } from "../src/sim/staleCapture.ts";

const here = dirname(fileURLToPath(import.meta.url));

test("ratio: simulated over wall time in a window, whatever the spacing of the points", () => {
  const m = new RatioMeter(1000);
  assert.equal(m.ratio(), null);
  // Uneven ticks: 5 ms, 45 ms, 5 ms, 45 ms … at ×0.5 throughout.
  let wall = 0;
  let sim = 0;
  m.add(wall, sim);
  for (let i = 0; i < 40; i++) {
    const dt = i % 2 ? 45 : 5;
    wall += dt;
    sim += dt * 0.5;
    m.add(wall, sim);
  }
  assert.ok(Math.abs(m.ratio()! - 0.5) < 1e-9);
  // An average of per-tick ratios would be fooled by one long, slow tick;
  // the window is not: 900 ms at ×1 then 100 ms with nothing simulated.
  const n = new RatioMeter(1000);
  n.add(0, 0);
  for (let t = 10; t <= 900; t += 10) n.add(t, t);
  n.add(1000, 900);
  assert.ok(Math.abs(n.ratio()! - 0.9) < 1e-9);
  // Old history leaves the window: now ×2.
  for (let t = 1010; t <= 2500; t += 10) n.add(t, 900 + (t - 1000) * 2);
  assert.ok(Math.abs(n.ratio()! - 2) < 0.03, String(n.ratio()));
});

test("ratio: a reset (time back) or a long gap (background tab) starts over", () => {
  const m = new RatioMeter(1000, 1000);
  for (let t = 0; t <= 500; t += 10) m.add(t, t);
  m.add(510, 0); // reset
  assert.equal(m.ratio(), null);
  for (let t = 520; t <= 900; t += 10) m.add(t, t - 510);
  assert.ok(Math.abs(m.ratio()! - 1) < 1e-9);
  m.add(5000, 400); // 4 s in the background: not ×0.0001
  assert.equal(m.ratio(), null);
  // Too short a history is no measurement.
  m.add(5100, 500);
  assert.equal(m.ratio(200), null);
  assert.equal(m.ratio(50), 1);
});

test("page-thread meter: busy share, cost per update, update and frame rates", () => {
  const u = new UiMeter(1000);
  for (let t = 0; t < 1000; t += 50) u.addUpdate(t, 10, 3);
  assert.equal(u.busy(999), 0.2);
  assert.equal(u.perUpdate(999), 10);
  assert.equal(u.updateHz(999), 20);
  assert.equal(u.frameHz(999), 60);
  assert.ok(u.settled(999));
  // Long tasks count when they say more than the updates do.
  u.addLongTask(999, 600);
  assert.equal(u.busy(999), 0.6);
  // Old entries go.
  assert.equal(u.busy(5000), 0);
  assert.equal(u.perUpdate(5000), 0);
  assert.ok(!u.settled(5000));
  assert.equal(fullRateBusy(4), 0.24);
  assert.equal(fullRateBusy(40), 1);
});

const ok: Health = { keepUp: 1, drawn: 1, busy: 0.1, fullBusy: 0.1 };
const slowUi: Health = { keepUp: 0.7, drawn: 1, busy: 0.8, fullBusy: 1 };

test("struggling needs the UI as the cause; recovering needs room at the full rate", () => {
  assert.ok(uiStruggles(slowUi));
  // Behind, but the page thread is mostly idle: the simulation itself is slow.
  assert.ok(!uiStruggles({ ...slowUi, busy: 0.2 }));
  // Keeping up, but frames dropped with a busy page, or a saturated page.
  assert.ok(uiStruggles({ keepUp: 1, drawn: 0.5, busy: 0.6, fullBusy: 1 }));
  assert.ok(uiStruggles({ keepUp: 1, drawn: 1, busy: 0.95, fullBusy: 1 }));
  assert.ok(!uiStruggles({ keepUp: 1, drawn: 0.9, busy: 0.6, fullBusy: 1 }));
  // "최대" (no target): only dropped frames and saturation count.
  assert.ok(!uiStruggles({ ...slowUi, keepUp: null }));
  assert.ok(uiRecovered(ok));
  assert.ok(!uiRecovered({ ...ok, fullBusy: 0.5 }));
  assert.ok(!uiRecovered({ ...ok, keepUp: 0.8 }));
});

test("auto switch: on after ENTER_MS of struggling, off after EXIT_MS of room, with hysteresis", () => {
  const a = new AutoSwitch();
  let t = 0;
  // Short struggles do not switch it on.
  for (; t < ENTER_MS - 100; t += 100) assert.equal(a.step(t, slowUi), false);
  a.step(t, ok); // one good moment: the clock starts again
  for (t += 100; t < 2 * ENTER_MS - 200; t += 100) assert.equal(a.step(t, slowUi), false);
  assert.equal(a.on, false);
  let changed = false;
  for (; t < 3 * ENTER_MS && !changed; t += 100) changed = a.step(t, slowUi);
  assert.ok(changed && a.on);
  // On: the lighter display is busy less, but the full rate would not fit.
  const lighter: Health = { keepUp: 1, drawn: 1, busy: 0.3, fullBusy: 0.8 };
  for (const end = t + 3 * EXIT_MS; t < end; t += 100) assert.equal(a.step(t, lighter), false);
  assert.ok(a.on);
  // Room to spare for EXIT_MS (a blip restarts the count).
  for (const end = t + EXIT_MS - 500; t < end; t += 100) a.step(t, ok);
  a.step(t, lighter);
  t += 100;
  for (const end = t + EXIT_MS - 200; t < end; t += 100) assert.equal(a.step(t, ok), false);
  assert.ok(a.on);
  changed = false;
  for (const end = t + 1000; t < end && !changed; t += 100) changed = a.step(t, ok);
  assert.ok(changed && !a.on);
  a.reset();
  assert.equal(a.on, false);
});

test("rate scheduler: steps down while busy, back up slowly, within LITE_HZ", () => {
  const r = new RateScheduler(1000, 4000);
  assert.equal(r.hz, LITE_HZ[0]);
  let t = 0;
  const run = (ms: number, busy: number) => {
    for (const end = t + ms; t < end; t += 50) r.step(t, busy);
  };
  run(900, 0.9);
  assert.equal(r.hz, 30); // not yet
  run(200, 0.9);
  assert.equal(r.hz, 15);
  run(10_000, 0.9);
  assert.equal(r.hz, LITE_HZ[LITE_HZ.length - 1]); // the slowest, no further
  // In between: stays.
  run(20_000, 0.3);
  assert.equal(r.hz, 5);
  // Plenty of room: one step faster per 4 s.
  run(3900, 0.05);
  assert.equal(r.hz, 5);
  run(200, 0.05);
  assert.equal(r.hz, 10);
  run(20_000, 0.05);
  assert.equal(r.hz, 30);
  r.reset();
  assert.equal(r.level, 0);
});

test("worker batching: unbatched without a rate, else wait for the rate and the page's acknowledgement", () => {
  assert.ok(batchDue(0, 0, null, true)); // as before M31: every frame
  assert.ok(!batchDue(10, 0, 30, false)); // 33 ms not up
  assert.ok(batchDue(33, 0, 30, false));
  assert.ok(!batchDue(200, 0, 30, true)); // the page has not drawn the last one
  assert.ok(batchDue(1000, 0, 30, true)); // … but not forever
  assert.ok(batchDue(1000, 0, 5, true, 1000));
});

test("the mode is kept per browser; anything unknown or unreadable is auto", () => {
  const store = new Map<string, string>();
  const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  assert.equal(loadMode(s), "auto");
  saveMode(s, "on");
  assert.equal(store.get(PERF_KEY), "on");
  assert.equal(loadMode(s), "on");
  store.set(PERF_KEY, "turbo");
  assert.equal(loadMode(s), "auto");
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  assert.equal(loadMode(broken), "auto");
  saveMode(broken, "off"); // no throw
  assert.equal(loadMode(undefined), "auto");
});

test("device-check verdict and the ratio's format", () => {
  assert.equal(verdict(5), "충분");
  assert.equal(verdict(2), "충분");
  assert.equal(verdict(1.5), "성능 모드 권장");
  assert.equal(verdict(1.1), "성능 모드 권장");
  assert.equal(verdict(0.9), "느림");
  assert.equal(formatRatio(0.6234), "×0.62");
  assert.equal(formatRatio(123.4), "×123");
});

test("frames compared by value (memoized parts redraw only on change)", () => {
  assert.ok(sameJson({ a: [1, 2, { b: "x" }], c: undefined }, { a: [1, 2, { b: "x" }], c: undefined }));
  assert.ok(!sameJson({ a: [1, 2] }, { a: [1, 3] }));
  assert.ok(!sameJson({ a: 1 }, { a: 1, b: 2 }));
  assert.ok(!sameJson([1], { 0: 1 }));
  assert.ok(!sameJson(null, {}));
  assert.ok(sameJson(undefined, undefined));
});

/** A pretend simulator: `cost` ms of wall time per simulated ms. */
function fakeSim(cost: number, clock: { t: number }): BenchSim & { frames: number } {
  let ms = 0;
  return {
    frames: 0,
    runForMs(d) {
      ms += d;
      clock.t += d * cost;
      return "";
    },
    frame() {
      this.frames++;
      return "{}";
    },
    takeConsole: () => "",
    timeMs: () => ms,
  };
}

test("headless benchmark: frames every 1/60 s of simulated time, ratio = simulated / wall", () => {
  const clock = { t: 0 };
  const sim = fakeSim(0.25, clock);
  const r = benchRun(sim, 1000, Infinity, () => clock.t);
  assert.ok(Math.abs(r.simMs - 1000) < 1e-6, String(r.simMs));
  assert.equal(sim.frames, Math.ceil(1000 / BENCH_FRAME_MS));
  assert.ok(Math.abs(r.ratio - 4) < 1e-6);
  // A wall-time budget stops a slow one early.
  const c2 = { t: 0 };
  const slow = benchRun(fakeSim(4, c2), 10_000, 500, () => c2.t);
  assert.ok(slow.simMs < 200 && Math.abs(slow.ratio - 0.25) < 1e-6);
});

const WASM = join(here, "../src/wasm/pkg/simucleo_wasm_bg.wasm");
const UART = join(here, "../public/examples/hal-uart-printf.elf");

test(
  "the benchmark loop leaves simulation results as they are: same console as one long run",
  { skip: (!existsSync(WASM) && "run npm run wasm") || (!existsSync(UART) && "run npm run examples") },
  async () => {
    const { initSync, Simulator } = await import("../src/wasm/pkg/simucleo_wasm.js");
    initSync({ module: readFileSync(WASM) });
    const elf = readFileSync(UART);
    const a = new Simulator();
    a.loadElf(elf);
    let consoleA = "";
    const benchA = {
      runForMs: (d: number) => a.runForMs(d),
      frame: () => a.frame(),
      takeConsole: () => {
        const s = a.takeConsole();
        consoleA += s;
        return s;
      },
      timeMs: () => a.timeMs(),
    };
    benchRun(benchA, 1500);
    const b = new Simulator();
    b.loadElf(elf);
    b.runForMs(a.timeMs());
    assert.ok(consoleA.length > 20, consoleA);
    assert.equal(b.takeConsole(), consoleA);
  },
);

test("a capture made under an older trigger setting is dropped, the rest of its frame kept", () => {
  const capture = { source: "PB4" } as never;
  const msg = (triggerGen: number, withCapture = true) => ({
    frame: { timeMs: triggerGen, scope: { state: "stopped", capture: withCapture ? capture : null } } as never,
    triggerGen,
  });
  // Frames batched before the page set the trigger again (gen 2): the
  // capture of gen 1 is not the one asked for; gen 2's is.
  const out = dropStaleCaptures([msg(1), msg(2)], 2) as { frame: { timeMs: number; scope: { state: string; capture: unknown } } }[];
  assert.equal(out[0].frame.scope.capture, null);
  assert.equal(out[0].frame.scope.state, "stopped");
  assert.equal(out[0].frame.timeMs, 1);
  assert.equal(out[1].frame.scope.capture, capture);
  // Frames without a capture pass as they are.
  const plain = msg(1, false);
  assert.equal(dropStaleCaptures([plain], 2)[0], plain);
  // The worker stamps each frame with the gen of the last trigger message.
  const worker = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/sim/worker.ts"), "utf8");
  assert.match(worker, /case "trigger":\s*triggerGen = m\.gen;/);
  assert.match(worker, /case "armTrigger":\s*triggerGen = m\.gen;/);
  assert.match(worker, /const m: FrameMsg = \{[^}]*triggerGen \}/);
});

test("frames are batched at the performance rate, but not while a speed cap (grading) is set", () => {
  assert.equal(batchHz(5, Infinity), 5);
  assert.equal(batchHz(null, Infinity), null);
  assert.equal(batchHz(5, 1), null);
  assert.equal(batchHz(15, 4), null);
});

test("the worker takes its frame rate and speed cap before the simulator is ready", () => {
  // The page sends its rate as it connects, while the WASM still loads;
  // dropped there, it was sent again only when the rate next changed.
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/sim/worker.ts"), "utf8");
  assert.match(src, /if \(setting\(m\) \|\| !sim\) return;/);
  const setting = src.slice(src.indexOf("function setting("), src.indexOf("self.onmessage"));
  for (const t of ["uiRate", "ack", "speedCap"]) assert.match(setting, new RegExp(`case "${t}":`));
  // ... and nowhere after the guard.
  const after = src.slice(src.indexOf("self.onmessage"));
  for (const t of ["uiRate", "ack", "speedCap"]) assert.doesNotMatch(after, new RegExp(`case "${t}":`));
});
