// Low-spec devices (M31): how fast the simulation really goes, how much of
// the UI thread the display takes, and when to show less of it.
//
// Only presentation is ever degraded. The worker simulates and closes a
// frame (`Simulator.frame()`) exactly as before in every mode; performance
// mode only changes how often the frames are handed to the page (in
// batches, every frame still delivered to `onFrame` listeners: grading and
// the waveform view see the same data) and how much of the page redraws.
//
// Pure logic, no DOM: unit tested in `web/test/m31.test.ts`.

export type PerfMode = "auto" | "off" | "on";
export const PERF_MODES: PerfMode[] = ["auto", "off", "on"];
export const PERF_KEY = "simucleo.perfMode";

/** Behind: achieved below this share of the speed asked for. */
export const BEHIND = 0.9;
/** The UI is the cause: the page thread is busy at least this share of the time. */
export const UI_BOUND = 0.5;
/** Auto mode switches on after this long behind with the UI as the cause (ms). */
export const ENTER_MS = 3000;
/** … and off after this long with room to spare at the full update rate (ms). */
export const EXIT_MS = 10_000;
/** Room to spare: the full rate would keep the page thread busy less than this. */
export const EXIT_BUSY = 0.35;
/** Full update rate (Hz): the worker's frame rate, every frame drawn. */
export const FULL_HZ = 60;
/** Update rates performance mode steps through as the page falls behind (Hz). */
export const LITE_HZ = [30, 15, 10, 5];

/**
 * Simulated time over wall time in a sliding window: a smoothed ratio that
 * stays accurate however the points are spaced (not an average of per-tick
 * ratios, which weighs a short tick like a long one).
 */
export class RatioMeter {
  private pts: { wall: number; sim: number }[] = [];
  private readonly windowMs: number;
  private readonly gapMs: number;
  /** `gapMs`: a pause longer than this (a background tab) starts over. */
  constructor(windowMs = 1500, gapMs = 1000) {
    this.windowMs = windowMs;
    this.gapMs = gapMs;
  }
  reset() {
    this.pts = [];
  }
  /** Simulated time `simMs` reached at wall time `wallMs`. */
  add(wallMs: number, simMs: number) {
    const last = this.pts[this.pts.length - 1];
    // A reset or new firmware (time went back), or a long gap: start over.
    if (last && (simMs < last.sim || wallMs - last.wall > this.gapMs)) this.pts = [];
    this.pts.push({ wall: wallMs, sim: simMs });
    // Keep one point at or before the window's start.
    while (this.pts.length > 2 && this.pts[1].wall <= wallMs - this.windowMs) this.pts.shift();
  }
  /** The ratio, or null with less than `minSpanMs` of history. */
  ratio(minSpanMs = 200): number | null {
    if (this.pts.length < 2) return null;
    const a = this.pts[0];
    const b = this.pts[this.pts.length - 1];
    const wall = b.wall - a.wall;
    if (wall < minSpanMs) return null;
    return (b.sim - a.sim) / wall;
  }
}

/** One display update: when, what it cost the page thread, how many frames it showed. */
interface Update {
  t: number;
  ms: number;
  frames: number;
}

/**
 * What the display costs the page thread: per update (message handling,
 * React render and commit, style/layout/paint up to the next task) and as
 * a share of wall time; long tasks (PerformanceObserver) count too.
 */
export class UiMeter {
  private updates: Update[] = [];
  private long: { t: number; ms: number }[] = [];
  private readonly windowMs: number;
  constructor(windowMs = 2000) {
    this.windowMs = windowMs;
  }
  reset() {
    this.updates = [];
    this.long = [];
  }
  private trim(now: number) {
    const from = now - this.windowMs;
    while (this.updates.length && this.updates[0].t < from) this.updates.shift();
    while (this.long.length && this.long[0].t < from) this.long.shift();
  }
  addUpdate(t: number, ms: number, frames: number) {
    this.updates.push({ t, ms: Math.max(0, ms), frames });
    this.trim(t);
  }
  addLongTask(t: number, ms: number) {
    this.long.push({ t, ms });
    this.trim(t);
  }
  /** Share of the window the page thread spent on the display (0–1). */
  busy(now: number): number {
    this.trim(now);
    const ui = this.updates.reduce((s, u) => s + u.ms, 0);
    const long = this.long.reduce((s, u) => s + u.ms, 0);
    return Math.min(1, Math.max(ui, long) / this.windowMs);
  }
  /** Mean cost of one update (ms), 0 without any. */
  perUpdate(now: number): number {
    this.trim(now);
    if (!this.updates.length) return 0;
    return this.updates.reduce((s, u) => s + u.ms, 0) / this.updates.length;
  }
  /** Display updates per second. */
  updateHz(now: number): number {
    this.trim(now);
    return (this.updates.length * 1000) / this.windowMs;
  }
  /** Worker frames per second shown (several per update when batched). */
  frameHz(now: number): number {
    this.trim(now);
    return (this.updates.reduce((s, u) => s + u.frames, 0) * 1000) / this.windowMs;
  }
  /** Enough history to judge (half a window). */
  settled(now: number): boolean {
    this.trim(now);
    return this.updates.length > 0 && now - this.updates[0].t >= this.windowMs / 2;
  }
}

/** Busy share the full rate (every frame drawn) would take at `perUpdateMs` an update. */
export const fullRateBusy = (perUpdateMs: number) => Math.min(1, (perUpdateMs * FULL_HZ) / 1000);

/** What the auto switch looks at, once per update. */
export interface Health {
  /** Achieved ratio over the ratio asked for (1: keeping up); null: unknown or no target ("최대"). */
  keepUp: number | null;
  /** Share of worker frames the page drew one by one (1: none skipped or batched by React). */
  drawn: number;
  /** `UiMeter.busy`. */
  busy: number;
  /** `fullRateBusy(UiMeter.perUpdate)`. */
  fullBusy: number;
}

/** Frames dropping: the page draws fewer than this share of the worker's frames. */
export const DRAWN_MIN = 0.75;
/** Saturated: the page thread is this busy (input waits, drags stutter). */
export const SATURATED = 0.9;

/**
 * Struggling with the page thread as the cause: it is busy at least half
 * the time, and the simulation falls behind, or frames are dropped, or the
 * thread is saturated (long tasks back to back).
 */
export function uiStruggles(h: Health): boolean {
  const behind = h.keepUp !== null && h.keepUp < BEHIND;
  return h.busy >= UI_BOUND && (behind || h.drawn < DRAWN_MIN || h.busy >= SATURATED);
}

/** Room to spare at the full rate again. */
export function uiRecovered(h: Health): boolean {
  return h.fullBusy < EXIT_BUSY && (h.keepUp === null || h.keepUp >= BEHIND);
}

/**
 * Auto mode: on after `ENTER_MS` of struggling, off after `EXIT_MS` of
 * room to spare (hysteresis: the two conditions are far apart, and each
 * must hold the whole time).
 */
export class AutoSwitch {
  on = false;
  private since: number | null = null;
  reset() {
    this.on = false;
    this.since = null;
  }
  /** Feed one observation; true when `on` changed. */
  step(now: number, h: Health): boolean {
    const want = this.on ? uiRecovered(h) : uiStruggles(h);
    if (!want) {
      this.since = null;
      return false;
    }
    if (this.since === null) this.since = now;
    if (now - this.since < (this.on ? EXIT_MS : ENTER_MS)) return false;
    this.on = !this.on;
    this.since = null;
    return true;
  }
}

/**
 * The update rate in performance mode: one step slower while the page
 * thread stays busy, one step faster again when it has plenty of room.
 */
export class RateScheduler {
  level = 0;
  private since: number | null = null;
  private dir = 0;
  private readonly downMs: number;
  private readonly upMs: number;
  constructor(downMs = 1000, upMs = 4000) {
    this.downMs = downMs;
    this.upMs = upMs;
  }
  get hz(): number {
    return LITE_HZ[this.level];
  }
  reset() {
    this.level = 0;
    this.since = null;
    this.dir = 0;
  }
  /** Feed the busy share; true when the rate changed. */
  step(now: number, busy: number): boolean {
    const dir = busy > 0.45 && this.level < LITE_HZ.length - 1 ? 1 : busy < 0.15 && this.level > 0 ? -1 : 0;
    if (dir === 0 || dir !== this.dir) {
      this.dir = dir;
      this.since = dir === 0 ? null : now;
      return false;
    }
    if (now - (this.since ?? now) < (dir > 0 ? this.downMs : this.upMs)) return false;
    this.level += dir;
    this.since = now;
    return true;
  }
}

/**
 * The worker's side of the update rate: given when the last batch went
 * out and whether the page has acknowledged it, is it time to send the
 * frames collected since? `hz` null: every frame at once, unbatched (as
 * before M31). A batch waits for the page's acknowledgement, so frames
 * never pile up in its message queue, but not longer than `maxWaitMs`
 * (a page that stopped answering still gets its frames).
 */
export function batchDue(now: number, lastSent: number, hz: number | null, inFlight: boolean, maxWaitMs = 1000): boolean {
  if (hz === null) return true;
  if (now - lastSent >= maxWaitMs) return true;
  return !inFlight && now - lastSent >= 1000 / hz - 1;
}

/** "실제 ×0.62", as the status line shows it. */
export const formatRatio = (r: number) => `×${r >= 100 ? r.toFixed(0) : r.toFixed(2)}`;

export function loadMode(storage: Pick<Storage, "getItem"> | undefined): PerfMode {
  try {
    const v = storage?.getItem(PERF_KEY);
    return v === "off" || v === "on" || v === "auto" ? v : "auto";
  } catch {
    return "auto";
  }
}

export function saveMode(storage: Pick<Storage, "setItem"> | undefined, mode: PerfMode) {
  try {
    storage?.setItem(PERF_KEY, mode);
  } catch {
    // Private mode or storage off: the choice lasts for this visit.
  }
}

/** Device check (이 기기에서 잘 돌아갈까?): verdict from the slowest example's ratio without UI. */
export type Verdict = "충분" | "성능 모드 권장" | "느림";
export const ENOUGH = 2;
export const SLOW = 1.1;
export function verdict(worstRatio: number): Verdict {
  return worstRatio >= ENOUGH ? "충분" : worstRatio >= SLOW ? "성능 모드 권장" : "느림";
}
