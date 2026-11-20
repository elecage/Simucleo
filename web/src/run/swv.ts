// SWV (Serial Wire Viewer) on the page: the settings a student picks, and
// what the trace sent so far, kept within limits — ITM text per stimulus
// port, data trace samples per traced variable, exception statistics and the
// latest exception events, and the PC-sample profile. Fed with each frame's
// `swv` part (see `crates/nucleo/src/swv.rs`); pure, for the unit tests.

/** How a traced variable is watched. */
export type DataMode = "write" | "read" | "rw";

export interface SwvSettings {
  /** ITM stimulus ports let through (bit n = port n). */
  ports: number;
  /** PC sampling: [POSTPRESET 0–15, CYCTAP] or null for none. */
  pcSampling: [number, boolean] | null;
  exceptions: boolean;
  /** Up to four C expressions (variables) for data trace. */
  data: { expr: string; mode: DataMode }[];
}

export const DEFAULT_SETTINGS: SwvSettings = {
  ports: 0b1,
  pcSampling: [15, true],
  exceptions: true,
  data: [],
};

/** Where a data trace expression landed (or why not), as the worker reports. */
export type DataPlaced = { addr: number; len: number; type: string | null } | { error: string };

/** One frame's trace (times in ns). */
export interface SwvData {
  itm: { t: number; port: number; size: number; value: number }[];
  data: { t: number; comparator: number; addr: number; value: number; size: number; write: boolean; pc: number }[];
  exceptions: { t: number; number: number; name: string; kind: "enter" | "exit" | "return" }[];
  profile: { function: string; samples: number }[];
  sleepSamples: number;
  dropped: number;
}

/** Statistics of one exception (CubeIDE's "Exception Trace" statistics). */
export interface ExcStats {
  number: number;
  name: string;
  count: number;
  /** Time spent in the handler, not counting handlers that preempted it (ns). */
  totalNs: number;
  maxNs: number;
  /** First and last entry (ns), for the rate. */
  firstNs: number;
  lastNs: number;
}

export interface SwvState {
  /** Text of ITM port 0 and other byte-wide writes, per port. */
  text: Map<number, string>;
  /** Wider writes (words, halfwords) per port: [t (ns), value]. */
  words: Map<number, [number, number][]>;
  /** Data trace samples per address: [t (ns), raw value, write]. */
  series: Map<number, [number, number, boolean][]>;
  /** Exception statistics by number. */
  exc: Map<number, ExcStats>;
  /** The latest exception events, for the timeline. */
  events: SwvData["exceptions"];
  /** PC samples by function, and asleep. */
  profile: Map<string, number>;
  sleepSamples: number;
  dropped: number;
  /** Exceptions entered and not yet exited, innermost last: [number, entered at, time preempted so far (ns;
   * while preempted it holds minus the moment it was preempted)]. */
  stack: [number, number, number][];
  /** Simulated time of the last frame (ns). */
  lastNs: number;
}

export const TEXT_LIMIT = 64 * 1024;
export const SERIES_LIMIT = 20_000;
export const WORDS_LIMIT = 2_000;
export const EVENTS_LIMIT = 6_000;

export function emptyState(): SwvState {
  return {
    text: new Map(),
    words: new Map(),
    series: new Map(),
    exc: new Map(),
    events: [],
    profile: new Map(),
    sleepSamples: 0,
    dropped: 0,
    stack: [],
    lastNs: 0,
  };
}

const capped = <T>(a: T[], limit: number) => (a.length > limit ? a.slice(a.length - limit) : a);

/** `s` with one frame's trace added (a new object; `s` is not changed). */
export function addFrame(s: SwvState, d: SwvData, nowNs?: number): SwvState {
  const text = new Map(s.text);
  const words = new Map(s.words);
  for (const e of d.itm) {
    if (e.size === 1) {
      text.set(e.port, (text.get(e.port) ?? "") + String.fromCharCode(e.value & 0xff));
    } else {
      const w = words.get(e.port) ?? [];
      words.set(e.port, [...w, [e.t, e.value]]);
    }
  }
  for (const [p, v] of text) if (v.length > TEXT_LIMIT) text.set(p, v.slice(v.length - TEXT_LIMIT));
  for (const [p, v] of words) words.set(p, capped(v, WORDS_LIMIT));

  const series = new Map(s.series);
  if (d.data.length) {
    const add = new Map<number, [number, number, boolean][]>();
    for (const e of d.data) {
      const a = add.get(e.addr) ?? [];
      a.push([e.t, e.value, e.write]);
      add.set(e.addr, a);
    }
    for (const [addr, a] of add) series.set(addr, capped([...(series.get(addr) ?? []), ...a], SERIES_LIMIT));
  }

  const exc = new Map(s.exc);
  const stack = s.stack.map((x) => [...x] as [number, number, number]);
  for (const e of d.exceptions) {
    if (e.kind === "enter") {
      // The handler it preempts stops counting time.
      const outer = stack[stack.length - 1];
      if (outer) outer[2] -= e.t;
      stack.push([e.number, e.t, 0]);
      const st = exc.get(e.number) ?? { number: e.number, name: e.name, count: 0, totalNs: 0, maxNs: 0, firstNs: e.t, lastNs: e.t };
      exc.set(e.number, { ...st, count: st.count + 1, lastNs: e.t });
    } else if (e.kind === "exit") {
      const i = stack.map((x) => x[0]).lastIndexOf(e.number);
      if (i >= 0) {
        const [, entered, preempted] = stack[i];
        stack.splice(i);
        const ns = e.t - entered - preempted;
        const st = exc.get(e.number);
        if (st) exc.set(e.number, { ...st, totalNs: st.totalNs + ns, maxNs: Math.max(st.maxNs, ns) });
      }
    } else {
      // Back in the handler it had preempted: that one counts again.
      const outer = stack[stack.length - 1];
      if (outer && outer[0] === e.number) outer[2] += e.t;
    }
  }

  const profile = new Map(s.profile);
  for (const p of d.profile) profile.set(p.function, (profile.get(p.function) ?? 0) + p.samples);

  return {
    text,
    words,
    series,
    exc,
    events: capped([...s.events, ...d.exceptions], EVENTS_LIMIT),
    profile,
    sleepSamples: s.sleepSamples + d.sleepSamples,
    dropped: s.dropped + d.dropped,
    stack,
    lastNs: nowNs ?? Math.max(s.lastNs, ...d.exceptions.map((e) => e.t), ...d.data.map((e) => e.t), ...d.itm.map((e) => e.t)),
  };
}

/** A traced value as the variable's C type reads it. */
export function typedValue(raw: number, len: number, type: string | null): number {
  const t = (type ?? "").replace(/\b(volatile|const|static)\b/g, "").trim();
  if (len === 4 && t === "float") {
    const b = new DataView(new ArrayBuffer(4));
    b.setUint32(0, raw >>> 0, true);
    return b.getFloat32(0, true);
  }
  const unsigned = /\bunsigned\b|^uint|^_Bool$|^bool$/.test(t);
  const bits = 8 * Math.min(len, 4);
  const masked = bits === 32 ? raw >>> 0 : raw & ((1 << bits) - 1);
  if (unsigned) return masked;
  return bits === 32 ? masked | 0 : masked >= 1 << (bits - 1) ? masked - (1 << bits) : masked;
}

/** The profile as a table: functions by samples, with their share of all samples (asleep included). */
export function profileRows(s: SwvState): { function: string; samples: number; share: number }[] {
  const total = [...s.profile.values()].reduce((a, b) => a + b, 0) + s.sleepSamples;
  const rows = [...s.profile].map(([f, n]) => ({ function: f, samples: n, share: total ? n / total : 0 }));
  rows.sort((a, b) => b.samples - a.samples || a.function.localeCompare(b.function));
  return rows;
}

/** Cycles per PC sample of a setting. */
export const samplePeriod = (p: [number, boolean]) => (p[0] + 1) * (p[1] ? 1024 : 64);
