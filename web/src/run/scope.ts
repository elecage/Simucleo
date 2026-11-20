// Oscilloscope helpers for the waveform view: timebase steps, unit
// formatting, drawing a channel and measuring pulses. Pure functions, unit
// tested in test/scope.test.ts.
import type { CaptureChannel } from "../sim/protocol.ts";

/** Time per division (ns), 1-2-5 steps from 1 µs to 200 ms. */
export const TIMEBASE_NS: number[] = [1, 10, 100, 1000, 10000, 100000].flatMap((m) =>
  [1, 2, 5].map((k) => k * m * 1000),
).filter((v) => v <= 200e6);
export const DIVISIONS = 10;

/** "1.50 ms", "400 ns", "-2 µs": three significant digits, SI prefix. */
export function fmtTime(ns: number): string {
  const a = Math.abs(ns);
  const [v, u] =
    a >= 1e9 ? [ns / 1e9, "s"] : a >= 1e6 ? [ns / 1e6, "ms"] : a >= 1e3 ? [ns / 1e3, "µs"] : [ns, "ns"];
  return `${trim(v)} ${u}`;
}

export function fmtHz(f: number): string {
  const [v, u] = f >= 1e6 ? [f / 1e6, "MHz"] : f >= 1e3 ? [f / 1e3, "kHz"] : [f, "Hz"];
  return `${trim(v)} ${u}`;
}

function trim(v: number): string {
  if (v === 0) return "0";
  const a = Math.abs(v);
  const digits = a >= 100 ? 0 : a >= 10 ? 1 : 2;
  return String(Number(v.toFixed(digits)));
}

/** Label of a timebase step: "2 ms/div". */
export const divLabel = (ns: number) => `${fmtTime(ns)}/div`;

/** Level of a channel just before `t`. */
export function levelAt(ch: { level0: boolean; edges: [number, boolean][] }, t: number): boolean {
  const i = lowerBound(ch.edges, t);
  return i === 0 ? ch.level0 : ch.edges[i - 1][1];
}

/** Index of the first edge at or after `t`. */
export function lowerBound(edges: readonly (readonly [number, unknown])[], t: number): number {
  let lo = 0;
  let hi = edges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (edges[mid][0] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * SVG polyline points of a channel between `from` and `to` (its own time
 * unit) over `width` pixels, `yHigh`/`yLow` the two levels. Edges closer
 * than half a pixel merge into a vertical bar, so 64 k edges stay cheap.
 */
export function tracePoints(
  ch: { level0: boolean; edges: [number, boolean][] },
  from: number,
  to: number,
  width: number,
  yHigh: number,
  yLow: number,
): string {
  const x = (t: number) => Math.round(((t - from) / (to - from)) * width * 2) / 2;
  const y = (l: boolean) => (l ? yHigh : yLow);
  let level = levelAt(ch, from);
  const out: string[] = [`0,${y(level)}`];
  let lastPx = NaN;
  let merged = false;
  for (let i = lowerBound(ch.edges, from); i < ch.edges.length; i++) {
    const [t, l] = ch.edges[i];
    if (t > to) break;
    const px = x(t);
    if (px === lastPx) {
      merged = true;
      level = l;
      continue;
    }
    if (merged) {
      out.push(`${lastPx},${yHigh}`, `${lastPx},${yLow}`, `${lastPx},${y(level)}`);
      merged = false;
    }
    out.push(`${px},${y(level)}`, `${px},${y(l)}`);
    level = l;
    lastPx = px;
  }
  if (merged) out.push(`${lastPx},${yHigh}`, `${lastPx},${yLow}`, `${lastPx},${y(level)}`);
  out.push(`${width},${y(level)}`);
  return out.join(" ");
}

export interface Widths {
  min: number;
  max: number;
  last: number;
  count: number;
}

export interface PulseStats {
  /** Mean rising-to-rising period (ns), with two rising edges or more. */
  period?: number;
  freq?: number;
  /** High share over whole periods (or the span, without them). */
  duty?: number;
  high?: Widths;
  low?: Widths;
  edges: number;
}

function widths(list: number[]): Widths | undefined {
  if (list.length === 0) return undefined;
  return { min: Math.min(...list), max: Math.max(...list), last: list[list.length - 1], count: list.length };
}

/**
 * Pulse measurements of a channel within [from, to] (ns): only pulses
 * whose both edges lie inside count.
 */
export function measurePulses(ch: { level0: boolean; edges: [number, boolean][] }, from: number, to: number): PulseStats {
  const inside = ch.edges.filter((e) => e[0] >= from && e[0] <= to);
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = 1; i < inside.length; i++) {
    const [t0, l0] = inside[i - 1];
    const [t1, l1] = inside[i];
    if (l0 === l1) continue;
    (l0 ? highs : lows).push(t1 - t0);
  }
  const rises = inside.filter((e) => e[1]).map((e) => e[0]);
  const stats: PulseStats = { high: widths(highs), low: widths(lows), edges: inside.length };
  if (rises.length >= 2) {
    const a = rises[0];
    const b = rises[rises.length - 1];
    stats.period = (b - a) / (rises.length - 1);
    stats.freq = 1e9 / stats.period;
    stats.duty = highTime(ch, a, b) / (b - a);
  } else if (to > from) {
    stats.duty = highTime(ch, from, to) / (to - from);
  }
  return stats;
}

/** Time spent high between `from` and `to`. */
export function highTime(ch: { level0: boolean; edges: [number, boolean][] }, from: number, to: number): number {
  let level = levelAt(ch, from);
  let last = from;
  let high = 0;
  for (let i = lowerBound(ch.edges, from); i < ch.edges.length && ch.edges[i][0] <= to; i++) {
    const [t, l] = ch.edges[i];
    if (level) high += t - last;
    last = t;
    level = l;
  }
  if (level) high += to - last;
  return high;
}

/** The span of a capture channel whose edges are all known. */
export function validSpan(ch: CaptureChannel, startNs: number, endNs: number): [number, number] {
  return [Math.max(startNs, ch.fromNs), Math.min(endNs, ch.toNs)];
}

/** Zoom a view [start, start + span] by `factor` around `at`, kept inside [min, max]. */
export function zoomView(
  view: { start: number; span: number },
  at: number,
  factor: number,
  min: number,
  max: number,
): { start: number; span: number } {
  const full = max - min;
  const span = Math.min(full, Math.max(full / 1e4, view.span * factor, 1));
  const start = at - ((at - view.start) * span) / view.span;
  return clampView({ start, span }, min, max);
}

export function clampView(view: { start: number; span: number }, min: number, max: number) {
  const span = Math.min(view.span, max - min);
  return { start: Math.min(Math.max(view.start, min), max - span), span };
}

/** An analog channel: voltage before the first sample, then [t, volts]. */
export interface AnalogLine {
  v0: number;
  samples: [number, number][];
}

function lowerBoundSamples(s: [number, number][], t: number): number {
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid][0] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Voltage of an analog channel just before `t`. */
export function valueAt(ch: AnalogLine, t: number): number {
  const i = lowerBoundSamples(ch.samples, t);
  return i === 0 ? ch.v0 : ch.samples[i - 1][1];
}

export interface AnalogStats {
  min: number;
  max: number;
  /** Time-weighted mean and RMS (the voltage holds between samples). */
  mean: number;
  rms: number;
  vpp: number;
}

/** Measurements of an analog channel over [from, to]. */
export function measureAnalog(ch: AnalogLine, from: number, to: number): AnalogStats | undefined {
  if (!(to > from)) return undefined;
  let v = valueAt(ch, from);
  let last = from;
  let min = v;
  let max = v;
  let sum = 0;
  let sq = 0;
  for (let i = lowerBoundSamples(ch.samples, from); i < ch.samples.length && ch.samples[i][0] <= to; i++) {
    const [t, nv] = ch.samples[i];
    sum += v * (t - last);
    sq += v * v * (t - last);
    last = t;
    v = nv;
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  sum += v * (to - last);
  sq += v * v * (to - last);
  const span = to - from;
  return { min, max, mean: sum / span, rms: Math.sqrt(sq / span), vpp: max - min };
}

/**
 * SVG points of an analog channel over [from, to] in `width` pixels: a
 * step trace, `y(volts)` mapping a voltage to a pixel row. Samples closer
 * than half a pixel collapse to a vertical bar of their range.
 */
export function analogPoints(
  ch: AnalogLine,
  from: number,
  to: number,
  width: number,
  y: (v: number) => number,
): string {
  const x = (t: number) => Math.round(((t - from) / (to - from)) * width * 2) / 2;
  let v = valueAt(ch, from);
  const out: string[] = [`0,${y(v)}`];
  let lastPx = NaN;
  for (let i = lowerBoundSamples(ch.samples, from); i < ch.samples.length; i++) {
    const [t, nv] = ch.samples[i];
    if (t > to) break;
    const px = x(t);
    if (px !== lastPx) out.push(`${px},${y(v)}`);
    out.push(`${px},${y(nv)}`);
    v = nv;
    lastPx = px;
  }
  out.push(`${width},${y(v)}`);
  return out.join(" ");
}

/** "2.48 V", "350 mV". */
export function fmtVolts(v: number): string {
  return Math.abs(v) < 1 && v !== 0 ? `${Number((v * 1000).toFixed(0))} mV` : `${Number(v.toFixed(2))} V`;
}

/** Volts per division, 1-2-5 from 10 mV to 5 V. */
export const VOLTS_DIV: number[] = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5];
