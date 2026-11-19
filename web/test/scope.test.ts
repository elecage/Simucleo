// Unit tests of the oscilloscope helpers of the waveform view (`npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TIMEBASE_NS,
  clampView,
  divLabel,
  fmtHz,
  fmtTime,
  highTime,
  levelAt,
  measurePulses,
  tracePoints,
  zoomView,
} from "../src/run/scope.ts";

test("timebase runs 1-2-5 from 1 µs to 200 ms per division", () => {
  assert.equal(TIMEBASE_NS[0], 1000);
  assert.equal(TIMEBASE_NS[TIMEBASE_NS.length - 1], 200e6);
  assert.equal(TIMEBASE_NS.length, 17);
  assert.deepEqual(TIMEBASE_NS.slice(0, 4), [1000, 2000, 5000, 10000]);
  assert.equal(divLabel(100e3), "100 µs/div");
  assert.equal(divLabel(2e6), "2 ms/div");
});

test("times and frequencies get units", () => {
  assert.equal(fmtTime(404.76), "405 ns");
  assert.equal(fmtTime(1500e3), "1.5 ms");
  assert.equal(fmtTime(-2000), "-2 µs");
  assert.equal(fmtTime(0), "0 ns");
  assert.equal(fmtHz(800e3), "800 kHz");
  assert.equal(fmtHz(50), "50 Hz");
  assert.equal(fmtHz(1.5e6), "1.5 MHz");
});

// 50 Hz servo signal: 1.5 ms high every 20 ms, times in ns from a trigger.
const servo = {
  level0: false,
  edges: [
    [0, true],
    [1.5e6, false],
    [20e6, true],
    [21.5e6, false],
    [40e6, true],
    [41.2e6, false],
  ] as [number, boolean][],
};

test("pulse widths, period, frequency and duty of a capture", () => {
  const m = measurePulses(servo, -1e6, 45e6);
  assert.equal(m.period, 20e6);
  assert.equal(m.freq, 50);
  assert.deepEqual(m.high, { min: 1.2e6, max: 1.5e6, last: 1.2e6, count: 3 });
  assert.deepEqual(m.low, { min: 18.5e6, max: 18.5e6, last: 18.5e6, count: 2 });
  // High 3 ms of the 40 ms between the first and last rising edge.
  assert.equal(m.duty, 3e6 / 40e6);
});

test("only pulses wholly inside the span count", () => {
  const m = measurePulses(servo, 1e6, 30e6);
  assert.equal(m.period, undefined);
  assert.deepEqual(m.high, { min: 1.5e6, max: 1.5e6, last: 1.5e6, count: 1 });
  assert.equal(highTime(servo, 1e6, 30e6), 0.5e6 + 1.5e6);
});

test("level before a time", () => {
  assert.equal(levelAt(servo, -5), false);
  assert.equal(levelAt(servo, 0), false); // just before the rising edge
  assert.equal(levelAt(servo, 1), true);
  assert.equal(levelAt(servo, 1e9), false);
});

test("a trace is drawn edge by edge", () => {
  const p = tracePoints(servo, 0, 40e6, 400, 5, 25);
  // The rising edge right at the end is drawn too.
  assert.equal(p, "0,25 0,25 0,5 15,5 15,25 200,25 200,5 215,5 215,25 400,25 400,5 400,5");
});

test("edges within half a pixel merge into one bar", () => {
  // 10 000 edges 1 ns apart on 100 pixels (200 half-pixel columns).
  const edges: [number, boolean][] = Array.from({ length: 10000 }, (_, i) => [i, i % 2 === 0]);
  const p = tracePoints({ level0: false, edges }, 0, 10000, 100, 5, 25).split(" ");
  assert.ok(p.length <= 5 * 201 + 2, `${p.length} points`);
  // Each column is a full-height bar.
  assert.ok(p.includes("50,5") && p.includes("50,25"));
  assert.equal(p[p.length - 1], "100,25");
});

test("zoom keeps the point under the pointer and stays inside the capture", () => {
  const v = zoomView({ start: -1000, span: 10000 }, 0, 0.5, -1000, 9000);
  assert.deepEqual(v, { start: -500, span: 5000 });
  assert.deepEqual(zoomView(v, 0, 10, -1000, 9000), { start: -1000, span: 10000 });
  assert.deepEqual(clampView({ start: 8000, span: 5000 }, -1000, 9000), { start: 4000, span: 5000 });
});
