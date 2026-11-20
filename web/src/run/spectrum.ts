// Spectrum of a waveform channel (M27): the channel (analog, digital as
// 0/3.3 V, or a math channel) resampled uniformly — each sample the exact
// mean of the signal over its interval, since the signal is piecewise
// constant (or linear) — windowed, transformed by a radix-2 FFT, and read
// as RMS volts per bin. Peaks, the fundamental, DC, THD and an SNR-like
// estimate. Pure functions, unit tested in test/m27.test.ts.
import { lowerBound, type Wave } from "./math.ts";

export type WindowKind = "rect" | "hann" | "hamming" | "blackman";
export const WINDOWS: WindowKind[] = ["hann", "rect", "hamming", "blackman"];
/** FFT sizes offered. */
export const FFT_SIZES = [1024, 2048, 4096, 8192, 16384];

/**
 * `n` samples over [from, to]: sample i is the mean of the wave over
 * [from + i·dt, from + (i + 1)·dt] — exact for steps and straight lines,
 * and a box filter against aliasing.
 */
export function resample(w: Wave, from: number, to: number, n: number): Float64Array {
  const out = new Float64Array(n);
  const dt = (to - from) / n;
  if (!(dt > 0)) return out;
  const s = w.samples;
  let k = lowerBound(s, from);
  // The segment we are in: from (ta, va) to (tb, vb), holding va for a step wave.
  let t = from;
  const valueAt = (tt: number) => {
    // (Only for a linear wave, between s[k - 1] and s[k].)
    if (k === 0) return s.length ? s[0][1] : w.v0;
    if (k >= s.length) return s[s.length - 1][1];
    const [ta, va] = s[k - 1];
    const [tb, vb] = s[k];
    return tb === ta ? vb : va + ((vb - va) * (tt - ta)) / (tb - ta);
  };
  let v = w.linear ? valueAt(from) : k === 0 ? w.v0 : s[k - 1][1];
  for (let i = 0; i < n; i++) {
    const end = i === n - 1 ? to : from + (i + 1) * dt;
    let acc = 0;
    while (k < s.length && s[k][0] <= end) {
      const [tk, vk] = s[k];
      acc += w.linear ? ((v + vk) / 2) * (tk - t) : v * (tk - t);
      t = tk;
      v = vk;
      k++;
    }
    const ve = w.linear ? valueAt(end) : v;
    acc += w.linear ? ((v + ve) / 2) * (end - t) : v * (end - t);
    t = end;
    v = ve;
    out[i] = acc / dt;
  }
  return out;
}

/** In-place radix-2 FFT (`re.length` a power of two). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n & (n - 1)) throw new Error("FFT size must be a power of two");
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  // e^(−2πi·j/n), j < n/2.
  const cos = new Float64Array(n >> 1);
  const sin = new Float64Array(n >> 1);
  for (let j = 0; j < n >> 1; j++) {
    cos[j] = Math.cos((-2 * Math.PI * j) / n);
    sin[j] = Math.sin((-2 * Math.PI * j) / n);
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const stride = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * stride];
        const wi = sin[k * stride];
        const a = i + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

/** A periodic window of `n` points (the DFT-even form). */
export function windowFn(kind: WindowKind, n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = (2 * Math.PI * i) / n;
    w[i] =
      kind === "rect"
        ? 1
        : kind === "hann"
          ? 0.5 - 0.5 * Math.cos(x)
          : kind === "hamming"
            ? 0.54 - 0.46 * Math.cos(x)
            : 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x);
  }
  return w;
}

/** Half the main lobe's width in bins: a tone's power lies within ± this of its bin. */
export const LOBE: Record<WindowKind, number> = { rect: 1, hann: 2, hamming: 2, blackman: 3 };

export interface Spectrum {
  /** Bin spacing (Hz) and sample rate (Hz). */
  df: number;
  fs: number;
  n: number;
  window: WindowKind;
  /** Single-sided RMS volts per bin 0 … n/2 (bin 0: |mean|; the others from the signal less its mean). */
  mag: Float64Array;
  /** The power of each bin (V² RMS), for sums over a tone's lobe. */
  pow: Float64Array;
  /** Mean of the signal (V), exact over the span. */
  dc: number;
}

/**
 * The spectrum of `x` (`n` samples, a power of two, over `spanS` seconds).
 * Amplitudes are corrected for the window's coherent gain and (`boxed`,
 * samples from `resample`) for its box averaging (a sinc), so a tone of RMS
 * A reads A at its bin.
 */
export function spectrum(x: Float64Array, spanS: number, window: WindowKind, boxed = true): Spectrum {
  const n = x.length;
  const w = windowFn(window, n);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  let sw = 0;
  let sw2 = 0;
  for (let i = 0; i < n; i++) {
    sw += w[i];
    sw2 += w[i] * w[i];
  }
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  // The mean comes off before windowing: a windowed offset spreads over
  // DC's whole lobe (bins 1…L) and would add to a tone that low.
  for (let i = 0; i < n; i++) re[i] = (x[i] - mean) * w[i];
  fft(re, im);
  const half = n / 2;
  const mag = new Float64Array(half + 1);
  const pow = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) {
    // The box average scaled bin k by sinc(k / n).
    const u = (Math.PI * k) / n;
    const box = k === 0 || !boxed ? 1 : Math.sin(u) / u;
    const p = (re[k] * re[k] + im[k] * im[k]) / (box * box);
    const one = k === 0 || k === half;
    mag[k] = one ? Math.sqrt(p) / sw : (Math.SQRT2 * Math.sqrt(p)) / sw;
    // Parseval: a tone's lobe sums to its mean square.
    pow[k] = ((one ? 1 : 2) * p) / (n * sw2);
  }
  // Bin 0 is the mean itself (exact).
  mag[0] = Math.abs(mean);
  pow[0] = mean * mean;
  return { df: 1 / spanS, fs: n / spanS, n, window, mag, pow, dc: mean };
}

/** Index of the largest bin among k ∈ [lo, hi]. */
function argmax(a: Float64Array, lo: number, hi: number): number {
  let best = lo;
  for (let k = lo + 1; k <= hi; k++) if (a[k] > a[best]) best = k;
  return best;
}

/** A tone's frequency (Hz), from its bin and the neighbours (parabola on dB). */
function refine(sp: Spectrum, k: number): number {
  if (k <= 0 || k >= sp.mag.length - 1) return k * sp.df;
  const db = (m: number) => 20 * Math.log10(Math.max(m, 1e-15));
  const [a, b, c] = [db(sp.mag[k - 1]), db(sp.mag[k]), db(sp.mag[k + 1])];
  const den = a - 2 * b + c;
  const d = den === 0 ? 0 : (0.5 * (a - c)) / den;
  return (k + Math.max(-0.5, Math.min(0.5, d))) * sp.df;
}

export interface Peak {
  bin: number;
  /** Hz (interpolated between bins) and RMS volts (the tone's whole lobe). */
  freq: number;
  vrms: number;
}

/** RMS of the tone at bin k: the power of its lobe. */
function lobeRms(sp: Spectrum, k: number): number {
  const L = LOBE[sp.window];
  let p = 0;
  for (let j = Math.max(1, k - L); j <= Math.min(sp.pow.length - 1, k + L); j++) p += sp.pow[j];
  return Math.sqrt(p);
}

/**
 * The `count` largest local maxima above DC (outside DC's lobe), at
 * least a lobe apart, largest first.
 */
export function peaks(sp: Spectrum, count: number): Peak[] {
  const L = LOBE[sp.window];
  const m = sp.mag;
  const cand: number[] = [];
  for (let k = L + 1; k < m.length; k++) {
    if (m[k] > 0 && m[k] >= m[k - 1] && (k + 1 >= m.length || m[k] > m[k + 1])) cand.push(k);
  }
  cand.sort((a, b) => m[b] - m[a]);
  const out: Peak[] = [];
  for (const k of cand) {
    if (out.length >= count) break;
    if (out.some((p) => Math.abs(p.bin - k) <= L)) continue;
    out.push({ bin: k, freq: refine(sp, k), vrms: lobeRms(sp, k) });
  }
  return out;
}

export interface Harmonic {
  /** 1 = the fundamental. */
  order: number;
  freq: number;
  vrms: number;
  /** Relative to the fundamental (dB). */
  dbc: number;
}

export interface SpectrumStats {
  /** Mean (V). */
  dc: number;
  /** The largest tone above DC. */
  fundamental?: Peak;
  /** Fundamental and harmonics 2 … `maxOrder` below Nyquist. */
  harmonics: Harmonic[];
  /** √(Σ harmonics 2 … maxOrder power) / fundamental (a ratio, 0.48 = 48 %). */
  thd?: number;
  /** Fundamental against what is left (all AC power but the fundamental and those harmonics), dB. */
  snr?: number;
  /** AC RMS (V): everything but the mean. */
  acRms: number;
}

/** Fundamental, harmonics, THD and an SNR-like ratio of a spectrum. */
export function analyze(sp: Spectrum, maxOrder = 10): SpectrumStats {
  const L = LOBE[sp.window];
  let ac = 0;
  // (Bins 1 … L hold no DC: the mean came off before windowing.)
  for (let k = 1; k < sp.pow.length; k++) ac += sp.pow[k];
  const stats: SpectrumStats = { dc: sp.dc, harmonics: [], acRms: Math.sqrt(ac) };
  const top = argmax(sp.mag, Math.min(L + 1, sp.mag.length - 1), sp.mag.length - 1);
  if (top <= L || !(sp.mag[top] > 0)) return stats;
  const f0 = refine(sp, top);
  const fund: Peak = { bin: top, freq: f0, vrms: lobeRms(sp, top) };
  stats.fundamental = fund;
  const nyq = sp.fs / 2;
  let used = 0;
  let hp = 0;
  const taken = new Set<number>();
  for (let h = 1; h <= maxOrder; h++) {
    const f = h * f0;
    if (f > nyq - L * sp.df) break;
    // The largest bin near h·f0: the tone's own.
    const c = Math.round(f / sp.df);
    const k = h === 1 ? top : argmax(sp.mag, Math.max(L + 1, c - 1), Math.min(sp.mag.length - 1, c + 1));
    let p = 0;
    for (let j = Math.max(1, k - L); j <= Math.min(sp.pow.length - 1, k + L); j++) {
      if (taken.has(j)) continue;
      taken.add(j);
      p += sp.pow[j];
    }
    used += p;
    if (h > 1) hp += p;
    const vrms = Math.sqrt(p);
    stats.harmonics.push({ order: h, freq: h === 1 ? f0 : refine(sp, k), vrms, dbc: 20 * Math.log10(Math.max(vrms, 1e-15) / fund.vrms) });
  }
  const p1 = fund.vrms ** 2;
  stats.thd = Math.sqrt(hp / p1);
  const rest = ac - used;
  stats.snr = rest > 0 ? 10 * Math.log10(p1 / rest) : Infinity;
  return stats;
}

/** dB relative to 1 V RMS. */
export const dbv = (vrms: number) => 20 * Math.log10(Math.max(vrms, 1e-12));

/** Largest power of two ≤ n (at least 2). */
export const pow2Floor = (n: number) => 2 ** Math.max(1, Math.floor(Math.log2(Math.max(2, n))));
