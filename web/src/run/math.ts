// Math channels of the waveform view (M27): A+B, A−B, A×B, −A, k·A + c
// and a moving average, computed here from the capture (or the live
// traces). Analog channels and digital ones (0 / 3.3 V) hold their value
// between changes, so a combination is exact on the union of their change
// times; a moving average of such a signal is exactly piecewise linear.
// Pure functions, unit tested in test/m27.test.ts.
import type { AnalogStats } from "./scope.ts";

/** Volts of a digital channel's high level. */
export const V_HIGH = 3.3;

/**
 * A signal over time (one unit throughout, ns in the view): `v0` before
 * the first point, then `[t, v]`. A step wave holds each value until the
 * next point; a linear one (`linear`) goes in a straight line from point to
 * point (and holds the last value after it).
 */
export interface Wave {
  v0: number;
  samples: [number, number][];
  linear?: boolean;
}

export type MathOp = "add" | "sub" | "mul" | "neg" | "scale" | "avg";
export const MATH_OPS: MathOp[] = ["sub", "add", "mul", "neg", "scale", "avg"];
/** The operations on two sources. */
export const BINARY: MathOp[] = ["add", "sub", "mul"];

/** A digital channel as volts (low 0 V, high `vHigh`). */
export function fromDigital(ch: { level0: boolean; edges: [number, boolean][] }, vHigh = V_HIGH): Wave {
  return { v0: ch.level0 ? vHigh : 0, samples: ch.edges.map(([t, l]) => [t, l ? vHigh : 0] as [number, number]) };
}

/** Index of the first point at or after `t`. */
export function lowerBound(s: readonly (readonly [number, number])[], t: number): number {
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid][0] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The value just before `t` (a step wave), or at `t` (a linear one). */
export function waveAt(w: Wave, t: number): number {
  const i = lowerBound(w.samples, t);
  if (!w.linear) return i === 0 ? w.v0 : w.samples[i - 1][1];
  if (i === 0) return w.samples.length ? w.samples[0][1] : w.v0;
  if (i === w.samples.length) return w.samples[i - 1][1];
  const [t0, v0] = w.samples[i - 1];
  const [t1, v1] = w.samples[i];
  return t1 === t0 ? v1 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
}

/**
 * `f(a, b)` of two step waves, a point wherever either changes (once for
 * changes at the same time) and the result changes.
 */
export function combine(a: Wave, b: Wave, f: (x: number, y: number) => number): Wave {
  const sa = a.samples;
  const sb = b.samples;
  let va = a.v0;
  let vb = b.v0;
  const v0 = f(va, vb);
  let last = v0;
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < sa.length || j < sb.length) {
    const t = Math.min(i < sa.length ? sa[i][0] : Infinity, j < sb.length ? sb[j][0] : Infinity);
    while (i < sa.length && sa[i][0] === t) va = sa[i++][1];
    while (j < sb.length && sb[j][0] === t) vb = sb[j++][1];
    const v = f(va, vb);
    if (v !== last) {
      out.push([t, v]);
      last = v;
    }
  }
  return { v0, samples: out };
}

/** `f(a)` point by point (a linear map keeps a linear wave linear). */
export function mapWave(a: Wave, f: (x: number) => number): Wave {
  return { v0: f(a.v0), samples: a.samples.map(([t, v]) => [t, f(v)] as [number, number]), ...(a.linear ? { linear: true } : {}) };
}

/**
 * Moving average of a step wave over the last `w` (its time unit):
 * y(t) = (1/w)·∫ x over [t − w, t], the value before the first point
 * taken as held since forever. Exactly piecewise linear, with corners
 * where x changes and `w` later.
 */
export function movingAverage(x: Wave, w: number): Wave {
  if (!(w > 0) || x.samples.length === 0) return { v0: x.v0, samples: [], linear: true };
  const s = x.samples;
  const t0 = s[0][0];
  // Integral of x from t0 up to each point.
  const cum = new Float64Array(s.length);
  for (let k = 1; k < s.length; k++) cum[k] = cum[k - 1] + s[k - 1][1] * (s[k][0] - s[k - 1][0]);
  /** ∫ x from t0 to t (negative before t0, where x is v0), for t that only grow. */
  const walker = () => {
    let k = 0;
    return (t: number) => {
      if (t <= t0) return x.v0 * (t - t0);
      while (k + 1 < s.length && s[k + 1][0] <= t) k++;
      return cum[k] + s[k][1] * (t - s[k][0]);
    };
  };
  const upTo = walker();
  const upToBefore = walker();
  const out: [number, number][] = [];
  const corner = (t: number) => {
    const v = (upTo(t) - upToBefore(t - w)) / w;
    // A corner where the slope does not change replaces the last point.
    if (out.length >= 2) {
      const [ta, va] = out[out.length - 2];
      const [tb, vb] = out[out.length - 1];
      if (Math.abs((vb - va) * (t - tb) - (v - vb) * (tb - ta)) <= 1e-12 * Math.max(1, Math.abs(v)) * (t - ta)) {
        out[out.length - 1] = [t, v];
        return;
      }
    }
    out.push([t, v]);
  };
  // Corners: every change and every change + w, in order, once each.
  let i = 0;
  let j = 0;
  let last = -Infinity;
  while (i < s.length || j < s.length) {
    const a = i < s.length ? s[i][0] : Infinity;
    const b = j < s.length ? s[j][0] + w : Infinity;
    const t = Math.min(a, b);
    if (a === t) i++;
    if (b === t) j++;
    if (t !== last) corner(t);
    last = t;
  }
  return { v0: x.v0, samples: out, linear: true };
}

/** A math channel's definition (see `MathCfg` in scopeSettings.ts). */
export interface MathDef {
  op: MathOp;
  /** k and c of `scale` (k·A + c). */
  gain: number;
  bias: number;
  /** The moving average's window (ns). */
  windowNs: number;
}

/** A math channel's wave from its sources (B only for A+B, A−B, A×B); null if a source is not a step wave. */
export function mathWave(def: MathDef, a: Wave, b?: Wave): Wave | null {
  switch (def.op) {
    case "add":
    case "sub":
    case "mul": {
      if (!b || a.linear || b.linear) return null;
      const f = def.op === "add" ? (x: number, y: number) => x + y : def.op === "sub" ? (x: number, y: number) => x - y : (x: number, y: number) => x * y;
      return combine(a, b, f);
    }
    case "neg":
      return mapWave(a, (x) => -x);
    case "scale":
      return mapWave(a, (x) => def.gain * x + def.bias);
    case "avg":
      return a.linear ? null : movingAverage(a, def.windowNs);
  }
}

/**
 * Min, max, time-weighted mean and RMS of a wave over [from, to]; a linear
 * wave's segments integrate exactly (∫(a + bt)² included).
 */
export function measureWave(w: Wave, from: number, to: number): AnalogStats | undefined {
  if (!(to > from)) return undefined;
  const s = w.samples;
  let t = from;
  let v = waveAt(w, from);
  let min = v;
  let max = v;
  let sum = 0;
  let sq = 0;
  const seg = (t1: number, v1: number) => {
    const d = t1 - t;
    if (w.linear) {
      sum += ((v + v1) / 2) * d;
      sq += ((v * v + v * v1 + v1 * v1) / 3) * d;
    } else {
      sum += v * d;
      sq += v * v * d;
    }
  };
  for (let i = lowerBound(s, from); i < s.length && s[i][0] <= to; i++) {
    const [ti, vi] = s[i];
    if (w.linear) {
      seg(ti, vi);
    } else {
      seg(ti, v);
    }
    t = ti;
    v = vi;
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  const vEnd = w.linear ? waveAt(w, to) : v;
  seg(to, vEnd);
  min = Math.min(min, vEnd);
  max = Math.max(max, vEnd);
  const span = to - from;
  return { min, max, mean: sum / span, rms: Math.sqrt(Math.max(0, sq / span)), vpp: max - min };
}

/**
 * SVG points of a wave over [from, to] in `width` pixels, `y(volts)` a
 * pixel row: steps for a step wave, straight lines for a linear one.
 * Points closer than half a pixel collapse to a vertical bar of their range.
 */
export function wavePoints(w: Wave, from: number, to: number, width: number, y: (v: number) => number): string {
  const x = (t: number) => Math.round(((t - from) / (to - from)) * width * 2) / 2;
  const s = w.samples;
  const out: string[] = [];
  let px = 0;
  let lo = waveAt(w, from);
  let hi = lo;
  let first = lo;
  let last = lo;
  const flush = () => {
    // Into the column at `first`, its range, out at `last`.
    const ys = [first];
    if (first <= last) {
      if (lo < first) ys.push(lo);
      if (hi > last) ys.push(hi);
    } else {
      if (hi > first) ys.push(hi);
      if (lo < last) ys.push(lo);
    }
    ys.push(last);
    for (const v of ys) {
      const pt = `${px},${y(v)}`;
      if (out[out.length - 1] !== pt) out.push(pt);
    }
  };
  for (let i = lowerBound(s, from); i < s.length; i++) {
    const [t, nv] = s[i];
    if (t > to) break;
    const p = x(t);
    if (p !== px) {
      flush();
      // A step holds `last` until here; a line runs straight to the new point.
      px = p;
      first = w.linear ? nv : last;
      lo = hi = first;
    }
    last = nv;
    lo = Math.min(lo, nv);
    hi = Math.max(hi, nv);
  }
  flush();
  const end = `${width},${y(w.linear ? waveAt(w, to) : last)}`;
  if (out[out.length - 1] !== end) out.push(end);
  return out.join(" ");
}
