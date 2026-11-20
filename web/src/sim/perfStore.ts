// The page's side of performance mode (M31): the mode the user chose
// (kept in this browser), whether the display is lightened now, and the
// numbers shown in the 성능 popover. `useRunner` feeds it; components
// read it with `usePerf()`.
import { useSyncExternalStore } from "react";
import {
  AutoSwitch,
  FULL_HZ,
  fullRateBusy,
  loadMode,
  RateScheduler,
  RatioMeter,
  saveMode,
  UiMeter,
  type PerfMode,
} from "./perf";

export interface PerfState {
  mode: PerfMode;
  /** Auto mode has switched performance mode on. */
  autoOn: boolean;
  /** Performance mode is in effect (on, or auto and switched on). */
  lite: boolean;
  /** Display updates asked of the worker (Hz). */
  hz: number;
  /** Achieved ratio as the page shows it (simulated time on screen / wall time), null: not running. */
  ratio: number | null;
  /** The worker's own ratio (simulated / wall time while it runs). */
  workerRatio: number | null;
  /** Mean page-thread cost of one display update (ms). */
  uiMs: number;
  /** Share of time the page thread spent on the display (0–1). */
  busy: number;
  updateHz: number;
  frameHz: number;
  /** The notice that auto mode switched on is showing. */
  notice: boolean;
}

const storage = (() => {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
})();

let state: PerfState = {
  mode: loadMode(storage),
  autoOn: false,
  lite: false,
  hz: FULL_HZ,
  ratio: null,
  workerRatio: null,
  uiMs: 0,
  busy: 0,
  updateHz: 0,
  frameHz: 0,
  notice: false,
};
state.lite = state.mode === "on";
const subs = new Set<() => void>();
const set = (patch: Partial<PerfState>) => {
  state = { ...state, ...patch };
  for (const f of subs) f();
};
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => void subs.delete(f);
};
export const getPerf = () => state;
export const usePerf = () => useSyncExternalStore(subscribe, getPerf);
const getLite = () => state.lite;
/** Performance mode is in effect: re-renders only when that changes. */
export const usePerfLite = () => useSyncExternalStore(subscribe, getLite);

const ui = new UiMeter();
const shown = new RatioMeter(2000);
const auto = new AutoSwitch();
const rate = new RateScheduler();
let lastPublish = 0;
/** Where the worker's frames should go at what rate: set by `useRunner`. */
let sendRate: (hz: number | null) => void = () => {};
let sentHz: number | null | undefined;

function applyRate() {
  const hz = state.lite ? rate.hz : null;
  if (hz !== sentHz) {
    sentHz = hz;
    sendRate(hz);
  }
  if (state.hz !== (hz ?? FULL_HZ)) set({ hz: hz ?? FULL_HZ });
}

export function setPerfMode(mode: PerfMode) {
  saveMode(storage, mode);
  auto.reset();
  rate.reset();
  ui.reset();
  set({ mode, autoOn: false, lite: mode === "on", notice: false });
  applyRate();
}

export const dismissPerfNotice = () => set({ notice: false });

/** `useRunner` hands over how to tell the worker the rate. */
export function connectPerf(send: (hz: number | null) => void) {
  sendRate = send;
  sentHz = undefined;
  applyRate();
}

export function perfLongTask(t: number, ms: number) {
  ui.addLongTask(t, ms);
}

/** Running stopped or started: the shown ratio starts over. */
export function perfRunning(running: boolean) {
  shown.reset();
  if (!running) set({ ratio: null, workerRatio: null });
}

/**
 * One display update was drawn: `costMs` of page-thread work for `frames`
 * worker frames, the last of them at `simMs`; the ratio asked for is
 * `target` (Infinity: as fast as possible).
 */
export function perfUpdate(now: number, costMs: number, frames: number, simMs: number, running: boolean, workerRatio: number, target: number) {
  ui.addUpdate(now, costMs, frames);
  if (!running) return;
  shown.add(now, simMs);
  const shownRatio = shown.ratio(500);
  const ratio = shownRatio === null ? null : Math.min(shownRatio, workerRatio || shownRatio);
  const busy = ui.busy(now);
  const perUpdate = ui.perUpdate(now);
  const updateHz = ui.updateHz(now);
  const frameHz = ui.frameHz(now);
  if (ui.settled(now) && ratio !== null) {
    const health = {
      keepUp: Number.isFinite(target) && target > 0 ? ratio / target : null,
      drawn: state.lite || frameHz === 0 ? 1 : Math.min(1, updateHz / frameHz),
      busy,
      fullBusy: fullRateBusy(perUpdate),
    };
    if (state.mode === "auto" && auto.step(now, health)) {
      rate.reset();
      set({ autoOn: auto.on, lite: auto.on, notice: auto.on });
    }
    if (state.lite && rate.step(now, busy)) applyRate();
    applyRate();
  }
  if (now - lastPublish > 400) {
    lastPublish = now;
    set({ ratio, workerRatio, uiMs: perUpdate, busy, updateHz, frameHz });
  }
}

/** Test hook (E2E): read the state, force a mode. */
export const perfHook = { get: getPerf, setMode: setPerfMode };
if (typeof window !== "undefined") (window as unknown as { __simucleoPerf: typeof perfHook }).__simucleoPerf = perfHook;
