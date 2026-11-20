// Unit tests of M27: math channels (combination on the union of change
// times, operations, moving average), the spectrum (FFT, windows, the
// resampler, THD, harmonic nulls of PWM) and the settings in the project
// file (`npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { combine, fromDigital, mathWave, measureWave, movingAverage, waveAt, wavePoints, type Wave } from "../src/run/math.ts";
import { analyze, fft, peaks, resample, spectrum, windowFn, type WindowKind } from "../src/run/spectrum.ts";
import { defaultScope, defaultSpectrum, newMath, sanitizeScope, type ScopeSettings } from "../src/run/scopeSettings.ts";
import { parseWith, serialize, type CatalogEntry } from "../src/editor/projectFormat.ts";

const close = (a: number, b: number, tol: number, what = "") => assert.ok(Math.abs(a - b) <= tol, `${what} ${a} ≉ ${b} (±${tol})`);

/** A PWM of `period`, high for `duty` of it, `cycles` periods from t = 0 (0/3.3 V). */
function pwm(period: number, duty: number, cycles: number, phase = 0): Wave {
  const ch: { level0: boolean; edges: [number, boolean][] } = { level0: false, edges: [] };
  for (let c = 0; c < cycles; c++) {
    const t = phase + c * period;
    ch.edges.push([t, true], [t + duty * period, false]);
  }
  return fromDigital(ch);
}

// ------------------------------------------------- math channels

test("math: A − B on the union of both change times, once for a shared time", () => {
  const a: Wave = { v0: 1, samples: [[10, 2], [30, 4], [50, 4.5]] };
  const b: Wave = { v0: 0.5, samples: [[20, 1], [30, 0], [40, 3]] };
  const d = combine(a, b, (x, y) => x - y);
  assert.equal(d.v0, 0.5);
  // 10: 2−0.5, 20: 2−1, 30 (both): 4−0, 40: 4−3, 50: 4.5−3.
  assert.deepEqual(d.samples, [[10, 1.5], [20, 1], [30, 4], [40, 1], [50, 1.5]]);
  // Exactly the difference everywhere, just before and at each change.
  for (const t of [0, 9.99, 10, 15, 20, 29, 30, 30.01, 39, 40, 45, 50, 60]) close(waveAt(d, t + 1e-9), waveAt(a, t + 1e-9) - waveAt(b, t + 1e-9), 1e-12, `t=${t}`);
  // A change that cancels out leaves no point.
  const same = combine({ v0: 0, samples: [[5, 1]] }, { v0: 0, samples: [[5, 1]] }, (x, y) => x - y);
  assert.deepEqual(same.samples, []);
});

test("math: the operations — A+B, A×B, −A, k·A + c — and digital sources as 0/3.3 V", () => {
  const dig = fromDigital({ level0: false, edges: [[100, true], [300, false]] });
  assert.deepEqual(dig, { v0: 0, samples: [[100, 3.3], [300, 0]] });
  const an: Wave = { v0: 1, samples: [[200, 2]] };
  const def = { gain: 2, bias: -0.5, windowNs: 0 };
  assert.deepEqual(mathWave({ ...def, op: "add" }, dig, an)!.samples, [[100, 4.3], [200, 5.3], [300, 2]]);
  const mul = mathWave({ ...def, op: "mul" }, dig, an)!;
  assert.equal(mul.v0, 0);
  assert.deepEqual(mul.samples.map(([t, v]) => [t, Number(v.toFixed(9))]), [[100, 3.3], [200, 6.6], [300, 0]]);
  assert.deepEqual(mathWave({ ...def, op: "neg" }, an), { v0: -1, samples: [[200, -2]] });
  assert.deepEqual(mathWave({ ...def, op: "scale" }, an), { v0: 1.5, samples: [[200, 3.5]] });
  assert.deepEqual(mathWave({ ...def, op: "sub" }, an, an)!.samples, []);
  // A binary operation needs B, and step sources.
  assert.equal(mathWave({ ...def, op: "sub" }, an), null);
  const avg = mathWave({ ...def, op: "avg", windowNs: 10 }, an)!;
  assert.equal(mathWave({ ...def, op: "add" }, avg, an), null);
  assert.equal(mathWave({ ...def, op: "avg", windowNs: 10 }, avg), null);
  // −A of a linear wave stays linear.
  assert.equal(mathWave({ ...def, op: "neg" }, avg)!.linear, true);
});

test("moving average: exact ramps of a step, corners at the change and one window later", () => {
  const x: Wave = { v0: 0, samples: [[100, 2]] };
  const y = movingAverage(x, 50);
  assert.equal(y.linear, true);
  assert.deepEqual(y.samples, [[100, 0], [150, 2]]);
  close(waveAt(y, 125), 1, 1e-12);
  close(waveAt(y, 99), 0, 1e-12);
  close(waveAt(y, 1000), 2, 1e-12);
  // A pulse shorter than the window: a trapezoid up to (width / window)·V.
  const p = movingAverage({ v0: 0, samples: [[0, 3], [20, 0]] }, 100);
  assert.deepEqual(p.samples.map(([t, v]) => [t, Number(v.toFixed(12))]), [[0, 0], [20, 0.6], [100, 0.6], [120, 0]]);
});

test("moving average of PWM over one period is flat at duty × 3.3 V; shorter windows ripple", () => {
  const T = 1e6; // 1 kHz in ns
  for (const duty of [0.1, 0.25, 0.5, 0.8]) {
    const x = pwm(T, duty, 20);
    const y = movingAverage(x, T);
    // After the first period: flat.
    const m = measureWave(y, 2 * T, 18 * T)!;
    close(m.mean, duty * 3.3, 1e-9, `mean ${duty}`);
    close(m.vpp, 0, 1e-9, `ripple ${duty}`);
    // Half a period: a triangle between the extremes, the same mean.
    const h = measureWave(movingAverage(x, T / 2), 2 * T, 18 * T)!;
    close(h.mean, duty * 3.3, 1e-9, `half-window mean ${duty}`);
    close(h.vpp, duty <= 0.5 ? 2 * duty * 3.3 : 2 * (1 - duty) * 3.3, 1e-9, `half-window ripple ${duty}`);
  }
  // The mean of a ramp (a linear wave) integrates exactly; RMS of a 0 → 1 ramp is 1/√3.
  const ramp: Wave = { v0: 0, samples: [[0, 0], [1, 1]], linear: true };
  const r = measureWave(ramp, 0, 1)!;
  close(r.mean, 0.5, 1e-12);
  close(r.rms, 1 / Math.sqrt(3), 1e-12);
  assert.deepEqual([r.min, r.max], [0, 1]);
});

test("math: a linear wave is drawn with straight lines, a step wave with steps", () => {
  const y = (v: number) => 100 - v * 10;
  assert.equal(wavePoints({ v0: 0, samples: [[0, 0], [10, 5]], linear: true }, 0, 10, 100, y), "0,100 100,50");
  assert.equal(wavePoints({ v0: 0, samples: [[5, 5]] }, 0, 10, 100, y), "0,100 50,100 50,50 100,50");
});

// ------------------------------------------------- spectrum

test("FFT matches a direct DFT", () => {
  const n = 64;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
  const x = Array.from({ length: n }, rnd);
  const re = Float64Array.from(x);
  const im = new Float64Array(n);
  fft(re, im);
  for (let k = 0; k < n; k++) {
    let r = 0;
    let i = 0;
    for (let j = 0; j < n; j++) {
      r += x[j] * Math.cos((-2 * Math.PI * k * j) / n);
      i += x[j] * Math.sin((-2 * Math.PI * k * j) / n);
    }
    close(re[k], r, 1e-9, `re[${k}]`);
    close(im[k], i, 1e-9, `im[${k}]`);
  }
  assert.throws(() => fft(new Float64Array(6), new Float64Array(6)));
});

test("a sine of 1 V peak reads 0.707 V RMS (−3 dBV) at its bin with every window, DC exact", () => {
  const n = 4096;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.25 + Math.sin((2 * Math.PI * 100 * i) / n);
  for (const w of ["rect", "hann", "hamming", "blackman"] as WindowKind[]) {
    const sp = spectrum(x, 0.1, w, false); // 100 cycles in 0.1 s: 1 kHz
    assert.equal(sp.df, 10);
    close(sp.mag[100], Math.SQRT1_2, 1e-9, w);
    const s = analyze(sp);
    close(s.fundamental!.freq, 1000, 1e-6, w);
    close(s.fundamental!.vrms, Math.SQRT1_2, 1e-9, w);
    close(s.dc, 0.25, 1e-12, w);
    assert.ok(s.thd! < 1e-6, `${w} thd ${s.thd}`);
  }
});

test("windows: values, coherent gain, and less leakage than rectangular between bins", () => {
  const n = 1024;
  const sum = (w: Float64Array) => w.reduce((a, b) => a + b, 0) / n;
  const hann = windowFn("hann", n);
  assert.equal(hann[0], 0);
  close(hann[n / 2], 1, 1e-15);
  close(sum(hann), 0.5, 1e-12);
  close(sum(windowFn("hamming", n)), 0.54, 1e-12);
  close(windowFn("hamming", n)[0], 0.08, 1e-12);
  close(sum(windowFn("blackman", n)), 0.42, 1e-12);
  close(windowFn("blackman", n)[0], 0, 1e-12);
  assert.ok(windowFn("rect", n).every((v) => v === 1));
  // A tone between two bins (100.5): far from it, rectangular leaks most, Blackman least.
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * 100.5 * i) / n);
  const far = (w: WindowKind) => spectrum(x, 1, w, false).mag[150];
  assert.ok(far("rect") > 5 * far("hamming"), "rect vs hamming");
  assert.ok(far("hamming") > 100 * far("hann"), "hamming vs hann (Hann's side lobes fall faster)");
  assert.ok(far("hann") > far("blackman"), "hann vs blackman");
  // The whole lobe still holds the tone's power.
  for (const w of ["rect", "hann", "hamming", "blackman"] as WindowKind[]) {
    const p = peaks(spectrum(x, 1, w, false), 1)[0];
    close(p.freq, 100.5, 0.5, `${w} freq`);
    close(p.vrms, Math.SQRT1_2, w === "rect" ? 0.1 : 0.02, `${w} lobe rms`);
  }
});

test("resampler: each sample is the exact mean of the steps over its interval", () => {
  const w: Wave = { v0: 1, samples: [[2.5, 3], [6, 0], [6.25, 2]] };
  const r = resample(w, 0, 8, 8);
  // [2, 3]: half 1, half 3 → 2; [6, 7]: a quarter of 0, three quarters of 2 → 1.5.
  assert.deepEqual(Array.from(r), [1, 1, 2, 3, 3, 3, 1.5, 2]);
  // A span starting after the changes, and a linear wave (a ramp's mean is its middle).
  assert.deepEqual(Array.from(resample(w, 10, 12, 2)), [2, 2]);
  const ramp: Wave = { v0: 0, samples: [[0, 0], [4, 4]], linear: true };
  assert.deepEqual(Array.from(resample(ramp, 0, 4, 4)), [0.5, 1.5, 2.5, 3.5]);
  // The mean is kept exactly, whatever the grid.
  const p = pwm(1000, 0.3, 50, 123.4);
  const many = resample(p, 0, 50000, 1024);
  // (All 50 pulses of 300 lie inside [0, 50 000].)
  close(many.reduce((a, b) => a + b, 0) / 1024, 3.3 * 0.3, 1e-9);
});

test("THD of a 50 % square wave: harmonics 2–10 give 42.9 %, all of them → 48.3 %", () => {
  // 1 V square wave, 32 periods over the span.
  const sq = pwm(1, 0.5, 32);
  const sp = spectrum(resample(sq, 0, 32, 16384), 32, "hann");
  const s = analyze(sp);
  close(s.fundamental!.freq, 1, 1e-6);
  // Fundamental of a 0/3.3 V square: (2·3.3/π)/√2 RMS; DC 1.65 V.
  close(s.fundamental!.vrms, (2 * 3.3) / Math.PI / Math.SQRT2, 1e-3);
  close(s.dc, 1.65, 1e-9);
  const ideal10 = Math.sqrt([3, 5, 7, 9].reduce((a, k) => a + 1 / (k * k), 0));
  close(s.thd!, ideal10, 0.002, "THD 2–10");
  close(ideal10, 0.4287, 1e-4);
  // With harmonics up to 199: close to √(π²/8 − 1) = 48.3 %.
  const all = analyze(sp, 199);
  close(all.thd!, Math.sqrt((Math.PI * Math.PI) / 8 - 1), 0.003, "THD 2–199");
  // Even harmonics vanish; odd ones fall as 1/k.
  for (const h of s.harmonics.slice(1)) {
    if (h.order % 2 === 0) assert.ok(h.dbc < -80, `H${h.order} ${h.dbc} dBc`);
    else close(h.dbc, 20 * Math.log10(1 / h.order), 0.02, `H${h.order}`);
  }
  // SNR: what is left is the harmonics above 10.
  assert.ok(s.snr! > 10 && s.snr! < 30, `snr ${s.snr}`);
});

test("PWM harmonics follow the duty's sinc envelope: nulls at multiples of 1/duty", () => {
  const level = (duty: number, k: number) => {
    const s = analyze(spectrum(resample(pwm(1, duty, 40), 0, 40, 16384), 40, "blackman"));
    return s.harmonics.find((h) => h.order === k)!.dbc;
  };
  // 25 %: the 4th and 8th vanish, the 2nd is |sin(2π/4)/sin(π/4)| = −3 dB.
  assert.ok(level(0.25, 4) < -80);
  assert.ok(level(0.25, 8) < -80);
  close(level(0.25, 2), 20 * Math.log10(Math.SQRT1_2), 0.02);
  // 20 % (or 80 %): the 5th and 10th.
  assert.ok(level(0.2, 5) < -80);
  assert.ok(level(0.8, 5) < -80);
  assert.ok(level(0.8, 10) < -80);
  // |H2 / H1| = |sin(2πD)| / (2·|sin(πD)|) = |cos(πD)|.
  close(level(0.8, 2), 20 * Math.log10(Math.abs(Math.sin(2 * Math.PI * 0.8)) / (2 * Math.abs(Math.sin(Math.PI * 0.8)))), 0.02);
  // 50 % has every even one at the floor, but 49 % does not.
  assert.ok(level(0.5, 2) < -80);
  assert.ok(level(0.49, 2) > -40);
});

test("peaks: the largest local maxima, a lobe apart, largest first", () => {
  const n = 2048;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = 2 * Math.sin((2 * Math.PI * 50 * i) / n) + 0.5 * Math.sin((2 * Math.PI * 300 * i) / n) + Math.sin((2 * Math.PI * 120 * i) / n);
  const ps = peaks(spectrum(x, 1, "hann", false), 3);
  assert.deepEqual(ps.map((p) => Math.round(p.freq)), [50, 120, 300]);
  close(ps[0].vrms, 2 * Math.SQRT1_2, 1e-9);
  assert.equal(peaks(spectrum(x, 1, "hann"), 0).length, 0);
});

test("spectrum of PWM through the whole chain: the fundamental within a bin, off-grid", () => {
  // 262.05 Hz (a buzzer's C4: 1 MHz / 3816), 50 %, over 100 ms that is not a whole number of periods.
  const T = 3816e3; // ns
  const x = pwm(T, 0.5, 40);
  const from = 30e6;
  const to = 130e6;
  const sp = spectrum(resample(x, from, to, 8192), 0.1, "hann");
  const s = analyze(sp);
  close(s.fundamental!.freq, 1e9 / T, sp.df);
  assert.ok(s.harmonics[1].dbc < -40, `H2 ${s.harmonics[1].dbc}`);
  close(s.harmonics[2].dbc, 20 * Math.log10(1 / 3), 0.5);
});

// ------------------------------------------------- settings

const CATALOG: Record<string, CatalogEntry> = {
  "nucleo-f401re": { pins: [{ id: "PA5" }, { id: "GND" }] },
};
const PROJECT = { parts: [{ id: "board", kind: "nucleo-f401re", x: 0, y: 0, props: {} }], wires: [] };

function settings(): ScopeSettings {
  const s = defaultScope();
  s.analog = [{ spec: "pot.W", vdiv: 1, offset: 1.65 }];
  s.math = [
    { ...newMath(1, ["V(pot.W)", "PA5"]), vdiv: 0.5, offset: 1 },
    { ...newMath(2, []), op: "avg", a: "PA5", windowUs: 250 },
  ];
  s.spectrum = { view: "split", source: "M2", window: "blackman", n: 16384, db: false, logFreq: true, fit: false, peaks: 8, range: "cursors" };
  return s;
}

test("settings: math channels and the spectrum survive saving and opening", () => {
  const scope = settings();
  assert.deepEqual(scope.math[0], { id: 1, op: "sub", a: "V(pot.W)", b: "PA5", gain: 1, bias: 0, windowUs: 1000, vdiv: 0.5, offset: 1 });
  const text = serialize({ ...PROJECT, scope }, "시험");
  const back = parseWith(text, CATALOG);
  assert.deepEqual(back.project.scope, scope);
  assert.deepEqual(parseWith(serialize(back.project, back.name), CATALOG).project.scope, scope);
});

test("settings: a project saved before M27 opens without math channels and with the time view", () => {
  // An M25/M26 file: scope without `math` and `spectrum`.
  const old = { ...settings() } as Partial<ScopeSettings>;
  delete old.math;
  delete old.spectrum;
  const l = parseWith(JSON.stringify({ format: "simucleo-project", version: 1, name: "옛것", ...PROJECT, scope: old }), CATALOG);
  assert.deepEqual(l.project.scope!.math, []);
  assert.deepEqual(l.project.scope!.spectrum, defaultSpectrum());
  assert.equal(l.project.scope!.spectrum.view, "time");
  assert.deepEqual(l.project.scope!.analog, old.analog);
});

test("settings: broken math and spectrum values get their defaults", () => {
  const s = sanitizeScope({
    math: [
      { id: 1, op: "pow", a: 3, windowUs: -5, vdiv: 0 },
      { id: 1, op: "avg", a: "PA5", windowUs: 20 },
      { id: 2, op: "neg", a: "PA6" },
    ],
    spectrum: { view: "3d", window: "kaiser", n: 1000, db: "yes", peaks: 99, range: "all", fit: false },
  })!;
  assert.deepEqual(
    s.math.map((m) => [m.id, m.op, m.a, m.windowUs, m.vdiv]),
    [
      [1, "sub", "", 1000, 1],
      [2, "avg", "PA5", 20, 1],
    ],
  );
  const d = defaultSpectrum();
  assert.deepEqual(s.spectrum, { ...d, fit: false });
});
