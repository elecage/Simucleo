// M35: the thermocouple modules' words as the parts show them, and the
// probe's controls (lighter, ice water, plug).
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeMax31855, decodeMax6675, exposure, readingOf, toggle } from "../src/parts/thermocouple-logic.ts";

test("MAX6675 word: D14–D3 in 0.25 °C, D2 open", () => {
  assert.deepEqual(decodeMax6675(0x0320), { hot: 25, faults: [] });
  assert.deepEqual(decodeMax6675(0x7ff8), { hot: 1023.75, faults: [] });
  assert.deepEqual(decodeMax6675(0x7ffc), { hot: null, faults: ["OPEN"] });
});

test("MAX31855 word: signed hot and cold junctions, fault bits", () => {
  // 100.25 °C, cold 25.0625 °C.
  const w = (401 << 18) | (401 << 4);
  assert.deepEqual(decodeMax31855(w), { hot: 100.25, cold: 25.0625, faults: [] });
  // −250 °C hot, −10.5 °C cold: two's complement in 14 and 12 bits.
  const neg = (((-1000 & 0x3fff) << 18) | ((-168 & 0xfff) << 4)) | 0;
  assert.deepEqual(decodeMax31855(neg), { hot: -250, cold: -10.5, faults: [] });
  // Open and shorted to GND at once: D16 with D0 and D1.
  assert.deepEqual(decodeMax31855(0x0001_0003 | (400 << 4)), { hot: null, cold: 25, faults: ["OC", "SCG"] });
  assert.deepEqual(readingOf("max31855", "7FFD1944"), { hot: null, cold: 25.25, faults: ["SCV"] });
  assert.deepEqual(readingOf("max6675", "0320"), { hot: 25, faults: [] });
  assert.equal(readingOf("max6675", undefined), null);
  assert.equal(readingOf("max6675", "zz"), null);
});

test("holding the lighter heats the tip, letting go it cools back to the room", () => {
  const c = exposure(800, 3, 6, "");
  const props: Record<string, string | number> = { temp: 25, ambient: 22 };
  const s = c.start({ x: 0, y: 0, clientX: 0, clientY: 0, t: 0 }, props);
  let tick = 0;
  const run = (ms: number, held: boolean) => {
    let done = false;
    for (let t = 0; t < ms; t += 100) {
      tick += 100;
      const r = s.tick!(tick, held, props);
      if (r.set) Object.assign(props, r.set);
      done = !!r.done;
    }
    return done;
  };
  // A quick click does nothing.
  run(100, true);
  assert.equal(props.temp, 25);
  // 3 s held: about 63 % of the way to 800 °C, in 0.25 °C steps.
  run(3000, true);
  const hot = Number(props.temp);
  assert.ok(hot > 450 && hot < 560, `${hot}`);
  assert.equal(hot * 4, Math.round(hot * 4));
  // Released: back to the ambient temperature, then done.
  assert.equal(run(60000, false), true);
  assert.equal(props.temp, 22);
});

test("moving the slider stops an exposure; the plug toggles", () => {
  const c = exposure(0, 2, 8, "");
  const props: Record<string, string | number> = { temp: 50, ambient: 25 };
  const s = c.start({ x: 0, y: 0, clientX: 0, clientY: 0, t: 0 }, props);
  s.tick!(500, true, props);
  props.temp = 99;
  assert.deepEqual(s.tick!(600, true, props), { done: true });
  const plug = toggle("unplugged", "");
  const p0 = { x: 0, y: 0, clientX: 0, clientY: 0, t: 0 };
  assert.deepEqual(plug.start(p0, { unplugged: 0 }).set, { unplugged: 1 });
  assert.deepEqual(plug.start(p0, { unplugged: "1" }).set, { unplugged: 0 });
});
