// Unit tests of the protocol decoders, the analog measurements and the
// capture export of the waveform view (`npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  annotationLabel,
  decodeI2c,
  decodeSpi,
  decodeUart,
  fmtByte,
  uartText,
  type Line,
} from "../src/run/decode.ts";
import { captureCsv, captureVcd, vcdName } from "../src/run/export.ts";
import { analogPoints, measureAnalog, valueAt } from "../src/run/scope.ts";
import type { ScopeCapture } from "../src/sim/protocol.ts";

/** A line built from levels held for given durations, from t0, idle `idle`. */
class Builder {
  edges: [number, boolean][] = [];
  level: boolean;
  t: number;
  idle: boolean;
  constructor(idle: boolean, t0 = 0) {
    this.idle = idle;
    this.level = idle;
    this.t = t0;
  }
  hold(level: boolean, ns: number) {
    if (level !== this.level) this.edges.push([this.t, level]);
    this.level = level;
    this.t += ns;
    return this;
  }
  line(): Line {
    return { level0: this.idle, edges: this.edges };
  }
}

const BIT = 1e9 / 115200;

/** UART frames: start, data LSB first, optional parity, stop(s); a gap. */
function uart(
  bytes: number[],
  o: { parity?: "even" | "odd"; badStop?: number; badParity?: number; gap?: number; dataBits?: number } = {},
): Line {
  const b = new Builder(true, 1000).hold(true, BIT * 3);
  bytes.forEach((v, i) => {
    const n = o.dataBits ?? 8;
    b.hold(false, BIT);
    let ones = 0;
    for (let k = 0; k < n; k++) {
      const bit = ((v >> k) & 1) === 1;
      ones += bit ? 1 : 0;
      b.hold(bit, BIT);
    }
    if (o.parity) {
      let p = (ones % 2 === 1) !== (o.parity === "odd");
      if (o.badParity === i) p = !p;
      b.hold(p, BIT);
    }
    b.hold(o.badStop !== i, BIT);
    b.hold(true, (o.gap ?? 0) * BIT);
  });
  b.hold(true, BIT);
  return b.line();
}

test("UART 8N1 text, back to back and with gaps", () => {
  for (const gap of [0, 2.3]) {
    const anns = decodeUart(uart([...Buffer.from("Hi!\r\n")], { gap }), { baud: 115200 });
    assert.equal(uartText(anns), "Hi!\r\n");
    assert.equal(anns.length, 5);
    assert.ok(anns.every((a) => !a.error));
    // Each frame is 10 bits from its start bit.
    assert.ok(Math.abs(anns[0].end - anns[0].start - 10 * BIT) < 1e-6);
    assert.ok(Math.abs(anns[0].start - (1000 + 3 * BIT)) < 1e-6);
  }
});

test("UART framing errors and the wrong baud rate", () => {
  const anns = decodeUart(uart([0x41, 0x42, 0x43], { badStop: 1, gap: 1 }), { baud: 115200 });
  assert.deepEqual(
    anns.map((a) => [a.value, a.error]),
    [
      [0x41, undefined],
      [0x42, "프레이밍 오류"],
      [0x43, undefined],
    ],
  );
  assert.equal(uartText(anns), "AC");
  // Decoded at 9600 baud the same line is garbage.
  const slow = decodeUart(uart([...Buffer.from("Hello")]), { baud: 9600 });
  assert.notEqual(uartText(slow), "Hello");
});

test("UART parity is checked", () => {
  const line = uart([0x07, 0x55, 0x00], { parity: "even", badParity: 1 });
  const anns = decodeUart(line, { baud: 115200, parity: "even" });
  assert.deepEqual(
    anns.map((a) => [a.value, a.error]),
    [
      [0x07, undefined],
      [0x55, "패리티 오류"],
      [0x00, undefined],
    ],
  );
  // The same frames read as odd parity: all wrong but the bad one.
  const odd = decodeUart(line, { baud: 115200, parity: "odd" });
  assert.deepEqual(
    odd.map((a) => a.error),
    ["패리티 오류", undefined, "패리티 오류"],
  );
});

test("a UART frame cut by the window's end is left out", () => {
  const line = uart([0x31, 0x32]);
  const to = 1000 + 3 * BIT + 15 * BIT; // in the middle of the second frame
  assert.equal(uartText(decodeUart(line, { baud: 115200 }, to)), "1");
});

const P = 10_000; // 100 kHz SCL

/** I2C lines from a script: "S", "P", or [byte, ackLow]. */
function i2c(script: ("S" | "P" | [number, boolean])[], sclIdle = true): { scl: Line; sda: Line } {
  const scl = new Builder(sclIdle);
  const sda = new Builder(true);
  let t = 5000;
  const at = (b: Builder, time: number, l: boolean) => {
    if (l !== b.level) b.edges.push([time, l]);
    b.level = l;
  };
  for (const s of script) {
    if (s === "S") {
      at(sda, t, true);
      at(scl, t + P / 4, true);
      at(sda, t + P / 2, false);
      at(scl, t + P, false);
      t += P;
    } else if (s === "P") {
      at(sda, t + P / 4, false);
      at(scl, t + P / 2, true);
      at(sda, t + P, true);
      t += 2 * P;
    } else {
      const [v, ack] = s;
      for (let k = 0; k < 9; k++) {
        const bit = k < 8 ? ((v >> (7 - k)) & 1) === 1 : !ack;
        at(sda, t + P / 4, bit);
        at(scl, t + P / 2, true);
        at(scl, t + P, false);
        t += P;
      }
    }
  }
  return { scl: scl.line(), sda: sda.line() };
}

test("I2C write: START, address + W, ACK, data, STOP", () => {
  const { scl, sda } = i2c(["S", [0x76 << 1, true], [0xd0, true], "P"]);
  const anns = decodeI2c(scl, sda);
  assert.deepEqual(
    anns.map((a) => a.kind),
    ["start", "address", "data", "stop"],
  );
  const addr = anns[1];
  assert.equal(addr.addr, 0x76);
  assert.equal(addr.rw, "W");
  assert.equal(addr.ack, true);
  assert.equal(annotationLabel(addr, "hex"), "0x76 W ACK");
  assert.equal(anns[2].value, 0xd0);
  assert.equal(annotationLabel(anns[2], "hex"), "0xD0 A");
  // The address box spans its 9 clocks.
  assert.ok(Math.abs(addr.end - addr.start - 9 * P) < P);
});

test("I2C NACK on the address and repeated START for a read", () => {
  const { scl, sda } = i2c([
    "S",
    [0x3c << 1, false], // nobody at 0x3C
    "P",
    "S",
    [0x68 << 1, true],
    [0x00, true],
    "S", // repeated START
    [(0x68 << 1) | 1, true],
    [0x12, true],
    [0x34, false], // the controller NACKs the last byte read
    "P",
  ]);
  const anns = decodeI2c(scl, sda);
  assert.deepEqual(
    anns.map((a) => a.kind),
    ["start", "address", "stop", "start", "address", "data", "restart", "address", "data", "data", "stop"],
  );
  assert.equal(anns[1].error, "NACK");
  assert.equal(annotationLabel(anns[1], "hex"), "0x3C W NACK");
  assert.equal(anns[7].rw, "R");
  assert.equal(anns[7].addr, 0x68);
  assert.deepEqual(
    anns.slice(8, 10).map((a) => [a.value, a.ack, a.error]),
    [
      [0x12, true, undefined],
      [0x34, false, undefined], // a read's last NACK is no error
    ],
  );
  // A NACKed write is.
  const w = decodeI2c(...(Object.values(i2c(["S", [0x50 << 1, true], [0xaa, false], "P"])) as [Line, Line]));
  assert.equal(w[2].error, "NACK");
});

test("I2C bits before the first START are ignored", () => {
  // (The window starts with SCL low, in the middle of a transfer.)
  const { scl, sda } = i2c([[0x55, true], "S", [0xa0, true], "P"], false);
  const anns = decodeI2c(scl, sda);
  assert.deepEqual(
    anns.map((a) => a.kind),
    ["start", "address", "stop"],
  );
});

/** SPI lines for `bytes` (MOSI) and their replies, in a mode. */
function spi(bytes: number[], replies: number[], cpol: boolean, cpha: boolean, half = 100, cs = true) {
  const sck = new Builder(cpol);
  const mosi = new Builder(false);
  const miso = new Builder(true);
  const csl = new Builder(true);
  let t = 1000;
  const at = (b: Builder, time: number, l: boolean) => {
    if (l !== b.level) b.edges.push([time, l]);
    b.level = l;
  };
  if (cs) at(csl, t - 200, false);
  bytes.forEach((v, j) => {
    for (let k = 0; k < 8; k++) {
      const [mo, mi] = [((v >> (7 - k)) & 1) === 1, ((replies[j] >> (7 - k)) & 1) === 1];
      if (cpha) {
        at(sck, t, !cpol);
        at(mosi, t + 1, mo);
        at(miso, t + 1, mi);
        at(sck, t + half, cpol);
      } else {
        at(mosi, t, mo);
        at(miso, t, mi);
        at(sck, t + half, !cpol);
        at(sck, t + 2 * half, cpol);
      }
      t += 2 * half;
    }
    t += 4 * half;
  });
  if (cs) at(csl, t + 200, true);
  return { sck: sck.line(), mosi: mosi.line(), miso: miso.line(), cs: csl.line() };
}

test("SPI words in all four modes, with and without CS", () => {
  for (let mode = 0; mode < 4; mode++) {
    const [cpol, cpha] = [(mode & 2) !== 0, (mode & 1) !== 0];
    const l = spi([0xa5, 0x3c, 0x01], [0xff, 0x80, 0x7e], cpol, cpha);
    for (const cs of [l.cs, null]) {
      const anns = decodeSpi(l.sck, l.mosi, l.miso, cs, { cpol, cpha });
      assert.deepEqual(
        anns.map((a) => [a.value, a.miso]),
        [
          [0xa5, 0xff],
          [0x3c, 0x80],
          [0x01, 0x7e],
        ],
        `mode ${mode} cs ${cs !== null}`,
      );
    }
    // CPHA 1 data (changing on the leading edge) read as CPHA 0 comes out
    // a bit late.
    if (cpha) {
      const wrong = decodeSpi(l.sck, l.mosi, l.miso, l.cs, { cpol, cpha: false });
      assert.deepEqual(
        wrong.map((a) => a.value),
        [0x52, 0x9e, 0x00],
        `mode ${mode}`,
      );
    }
  }
});

test("SPI LSB first and a CS edge mid-word", () => {
  const l = spi([0x01], [0], false, false);
  assert.deepEqual(
    decodeSpi(l.sck, l.mosi, null, null, { cpol: false, cpha: false, msbFirst: false }).map((a) => a.value),
    [0x80],
  );
  // CS rises after 4 clocks: no word.
  const cs: Line = { level0: false, edges: [[1000 + 4 * 200 + 50, true]] };
  assert.deepEqual(decodeSpi(l.sck, l.mosi, null, cs, { cpol: false, cpha: false }), []);
});

test("hex and ASCII", () => {
  assert.equal(fmtByte(0x41, "ascii"), "A");
  assert.equal(fmtByte(0x41, "hex"), "0x41");
  assert.equal(fmtByte(0x0a, "ascii"), "\\n");
  assert.equal(fmtByte(0x07, "ascii"), "0x07");
  assert.equal(annotationLabel({ start: 0, end: 1, kind: "data", value: 0x42, error: "프레이밍 오류" }, "ascii"), "B (프레이밍 오류)");
  assert.equal(annotationLabel({ start: 0, end: 1, kind: "data", value: 0xa5, miso: 0x3c }, "hex"), "0xA5 / 0x3C");
});

test("analog measurements are time-weighted", () => {
  // 0 V until 0, 3.3 V for 250 ns, 0 V for 750 ns: 25 % PWM.
  const ch = {
    v0: 0,
    samples: [
      [0, 3.3],
      [250, 0],
      [1000, 3.3],
    ] as [number, number][],
  };
  const m = measureAnalog(ch, 0, 1000)!;
  assert.equal(m.min, 0);
  assert.equal(m.max, 3.3);
  assert.equal(m.vpp, 3.3);
  assert.ok(Math.abs(m.mean - 0.825) < 1e-9);
  assert.ok(Math.abs(m.rms - 3.3 / 2) < 1e-9);
  assert.equal(valueAt(ch, 100), 3.3);
  assert.equal(valueAt(ch, 0), 0);
  // A constant: no change in the span.
  const flat = measureAnalog({ v0: 1.2, samples: [] }, -5, 5)!;
  assert.deepEqual([flat.min, flat.max, flat.vpp], [1.2, 1.2, 0]);
  assert.ok(Math.abs(flat.mean - 1.2) < 1e-12);
  // Step trace points.
  assert.equal(analogPoints(ch, 0, 1000, 100, (v) => 100 - v * 10), "0,100 0,100 0,67 25,67 25,100 100,100 100,67 100,67");
});

const capture: ScopeCapture = {
  seq: 1,
  source: "PA5",
  triggerMs: 12,
  startNs: -100,
  endNs: 400,
  channels: [
    {
      name: "PA5",
      level0: false,
      edges: [
        [0, true],
        [250.5, false],
      ],
      fromNs: -100,
      toNs: 400,
    },
  ],
  analog: [
    {
      name: "V(pot.W)",
      v0: 1.65,
      samples: [[100, 2.475]],
      fromNs: -100,
      toNs: 400,
    },
  ],
};

test("CSV export: a row at the start and at each change", () => {
  assert.equal(
    captureCsv(capture),
    ["time_ns,PA5,V(pot.W)", "-100,0,1.65", "0,1,1.65", "100,1,2.475", "250.5,0,2.475", ""].join("\n"),
  );
});

test("VCD export: header, dumpvars and changes from the window's start", () => {
  const vcd = captureVcd(capture, "2026-01-01");
  const lines = vcd.split("\n");
  assert.equal(lines[0], "$timescale 1 ns $end");
  assert.equal(lines[1], "$date 2026-01-01 $end");
  assert.ok(vcd.includes("$comment trigger on PA5 at 100 ns $end"));
  assert.ok(vcd.includes("$var wire 1 ! PA5 $end"));
  assert.ok(vcd.includes('$var real 64 " V_pot.W $end'));
  const body = lines.slice(lines.indexOf("$enddefinitions $end") + 1);
  assert.deepEqual(body, ["#0", "$dumpvars", "0!", 'r1.65 "', "$end", "#100", "1!", "#200", 'r2.475 "', "#351", "0!", "#500", ""]);
  assert.equal(vcdName("V(PA1)"), "V_PA1");
});
