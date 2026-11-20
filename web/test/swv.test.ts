// SWV on the page: what the trace frames add up to (src/run/swv.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { addFrame, emptyState, profileRows, samplePeriod, typedValue, TEXT_LIMIT, type SwvData } from "../src/run/swv.ts";

const frame = (d: Partial<SwvData>): SwvData => ({ itm: [], data: [], exceptions: [], profile: [], sleepSamples: 0, dropped: 0, ...d });
const exc = (t: number, number: number, kind: "enter" | "exit" | "return", name = `E${number}`) => ({ t, number, name, kind });

test("ITM: bytes become text per port, wider writes are kept as words", () => {
  let s = emptyState();
  s = addFrame(s, frame({ itm: [..."hi\n"].map((c, i) => ({ t: i, port: 0, size: 1, value: c.charCodeAt(0) })) }));
  s = addFrame(s, frame({ itm: [{ t: 10, port: 1, size: 4, value: 0xdeadbeef }, { t: 11, port: 0, size: 1, value: 0x21 }] }));
  assert.equal(s.text.get(0), "hi\n!");
  assert.deepEqual(s.words.get(1), [[10, 0xdeadbeef]]);
  // Text is capped, keeping the newest.
  const long = { itm: Array.from({ length: TEXT_LIMIT + 10 }, (_, i) => ({ t: i, port: 2, size: 1, value: 65 + (i % 26) })) };
  s = addFrame(s, frame(long));
  assert.equal(s.text.get(2)!.length, TEXT_LIMIT);
});

test("data trace: samples per address, in order", () => {
  let s = emptyState();
  s = addFrame(s, frame({ data: [{ t: 1, comparator: 0, addr: 0x2000_0010, value: 4, size: 4, write: true, pc: 0 }] }));
  s = addFrame(s, frame({ data: [{ t: 2, comparator: 0, addr: 0x2000_0010, value: 8, size: 4, write: true, pc: 0 }, { t: 2, comparator: 1, addr: 0x2000_0020, value: 1, size: 1, write: false, pc: 0 }] }));
  assert.deepEqual(s.series.get(0x2000_0010), [[1, 4, true], [2, 8, true]]);
  assert.deepEqual(s.series.get(0x2000_0020), [[2, 1, false]]);
});

test("exception statistics: count, time in the handler without the time it was preempted, max", () => {
  let s = emptyState();
  // TIM2 (44) runs 0–100 ns, preempted by SysTick (15) from 40 to 60 ns.
  s = addFrame(s, frame({
    exceptions: [
      exc(0, 44, "enter"),
      exc(40, 15, "enter"),
      exc(60, 15, "exit"),
      exc(60, 44, "return"),
      exc(100, 44, "exit"),
      exc(100, 0, "return"),
    ],
  }));
  // Again, 30 ns, unpreempted; split across two frames.
  s = addFrame(s, frame({ exceptions: [exc(1000, 44, "enter")] }));
  s = addFrame(s, frame({ exceptions: [exc(1030, 44, "exit"), exc(1030, 0, "return")] }));
  const tim2 = s.exc.get(44)!;
  assert.equal(tim2.count, 2);
  assert.equal(tim2.totalNs, 80 + 30);
  assert.equal(tim2.maxNs, 80);
  assert.equal(tim2.firstNs, 0);
  assert.equal(tim2.lastNs, 1000);
  const st = s.exc.get(15)!;
  assert.equal(st.count, 1);
  assert.equal(st.totalNs, 20);
  assert.deepEqual(s.stack, []);
});

test("profile: samples add up per function; shares count the sleep samples", () => {
  let s = emptyState();
  s = addFrame(s, frame({ profile: [{ function: "filter", samples: 30 }, { function: "main", samples: 10 }], sleepSamples: 50 }));
  s = addFrame(s, frame({ profile: [{ function: "main", samples: 10 }], sleepSamples: 0 }));
  const rows = profileRows(s);
  assert.deepEqual(rows.map((r) => [r.function, r.samples]), [["filter", 30], ["main", 20]]);
  assert.equal(rows[0].share, 0.3);
  assert.equal(samplePeriod([15, true]), 16384);
  assert.equal(samplePeriod([0, false]), 64);
});

test("traced values read as their C type", () => {
  assert.equal(typedValue(0xfffffffc, 4, "int32_t"), -4);
  assert.equal(typedValue(0xfffffffc, 4, "volatile int32_t"), -4);
  assert.equal(typedValue(0xfffffffc, 4, "uint32_t"), 0xfffffffc);
  assert.equal(typedValue(0xff, 1, "int8_t"), -1);
  assert.equal(typedValue(0xff, 1, "unsigned char"), 255);
  assert.equal(typedValue(0x8000, 2, "short"), -32768);
  assert.equal(typedValue(0x3fc00000, 4, "float"), 1.5);
});
