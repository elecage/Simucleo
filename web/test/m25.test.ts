// Unit tests of M25: the 1-Wire, TM1637 and WS2812 decoders, the content
// trigger, and the waveform settings kept in the project file (`npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  annotationLabel,
  decodeI2c,
  decodeOneWire,
  decodeTm1637,
  decodeUart,
  decodeWs2812,
  findMatches,
  scanStep,
  segmentChar,
  tm1637Display,
  ws2812Frame,
  type Annotation,
  type Line,
  type ScanState,
} from "../src/run/decode.ts";
import { levelAt } from "../src/run/scope.ts";
import { contentMatch, defaultScope, newDecoder, sanitizeScope, type ScopeSettings } from "../src/run/scopeSettings.ts";
import { parseWith, serialize, type CatalogEntry } from "../src/editor/projectFormat.ts";

const US = 1000;

/** A line built from levels held for given durations. */
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

/** The part of a line from `from` (up to `to`), as a live stream has it. */
const sliceFrom = (l: Line, from: number, to = Infinity): Line => ({
  level0: levelAt(l, from),
  edges: l.edges.filter((e) => e[0] >= from && e[0] <= to),
});

// ------------------------------------------------------------- 1-Wire

/** A 1-Wire bus: the controller's slots and the devices' answers, as the DQ line shows them. */
class OneWire {
  b = new Builder(true, 10 * US).hold(true, 100 * US);
  reset(presence = true, low = 480 * US) {
    this.b.hold(false, low);
    if (presence) this.b.hold(true, 30 * US).hold(false, 120 * US).hold(true, 330 * US);
    else this.b.hold(true, 480 * US);
    return this;
  }
  bit(one: boolean, low = one ? 6 * US : 60 * US, slot = 70 * US) {
    this.b.hold(false, low).hold(true, slot - low);
    return this;
  }
  /** Written or read: LSB first. A device reading a 0 holds the line ~30 µs. */
  byte(v: number, read = false) {
    for (let k = 0; k < 8; k++) {
      const one = ((v >> k) & 1) === 1;
      this.bit(one, one ? 6 * US : read ? 30 * US : 60 * US);
    }
    return this;
  }
  line() {
    this.b.hold(true, 100 * US);
    return this.b.line();
  }
}

const data = (anns: Annotation[]) => anns.filter((a) => a.kind === "data");

test("1-Wire: reset with presence, SKIP ROM, CONVERT T", () => {
  const anns = decodeOneWire(new OneWire().reset().byte(0xcc).byte(0x44).line());
  assert.equal(anns.length, 3);
  assert.equal(anns[0].kind, "reset");
  assert.equal(anns[0].presence, true);
  assert.equal(anns[0].error, undefined);
  assert.equal(annotationLabel(anns[0], "hex"), "리셋·프레즌스");
  assert.deepEqual(
    data(anns).map((a) => [a.value, a.note, a.error]),
    [
      [0xcc, "SKIP ROM", undefined],
      [0x44, "CONVERT T", undefined],
    ],
  );
  assert.equal(annotationLabel(anns[1], "hex"), "0xCC SKIP ROM");
  // The byte spans its eight slots (the last taken as 60 µs long).
  assert.equal(anns[1].start, anns[0].end + 330 * US);
  assert.ok(Math.abs(anns[1].end - (anns[1].start + (7 * 70 + 60) * US)) < 1);
});

test("1-Wire: READ SCRATCHPAD bytes read from the device, numbered", () => {
  const pad = [0x50, 0x05, 0x4b, 0x46, 0x7f, 0xff, 0x0c, 0x10, 0x1c];
  const ow = new OneWire().reset().byte(0xcc).byte(0xbe);
  for (const v of pad) ow.byte(v, true);
  const d = data(decodeOneWire(ow.line()));
  assert.equal(d[1].note, "READ SCRATCHPAD");
  assert.deepEqual(
    d.slice(2).map((a) => a.value),
    pad,
  );
  assert.equal(d[2].note, "스크래치패드 0");
  assert.equal(d[10].note, "스크래치패드 8");
  assert.ok(d.every((a) => !a.error));
});

test("1-Wire: MATCH ROM names the eight ROM bytes, then the function command", () => {
  const rom = [0x28, 1, 2, 3, 4, 5, 6, 0x9a];
  const ow = new OneWire().reset().byte(0x55);
  for (const v of rom) ow.byte(v);
  const d = data(decodeOneWire(ow.byte(0x44).line()));
  assert.equal(d[0].note, "MATCH ROM");
  assert.deepEqual(
    d.slice(1, 9).map((a) => a.value),
    rom,
  );
  assert.equal(d[1].note, "ROM 계열");
  assert.equal(d[8].note, "ROM CRC");
  assert.equal(d[9].note, "CONVERT T");
});

test("1-Wire: SEARCH ROM triplets (bit, complement, direction), then the function command", () => {
  const ow = new OneWire().reset().byte(0xf0);
  // Bit 0: devices differ (0, 0), go 0; bit 1: all 1 (1, 0), go 1; the rest all 0.
  ow.bit(false).bit(false).bit(false);
  ow.bit(true).bit(false).bit(true);
  for (let k = 2; k < 64; k++) ow.bit(false).bit(true).bit(false);
  const anns = decodeOneWire(ow.byte(0xbe).line());
  const trip = anns.filter((a) => a.kind === "triplet");
  assert.equal(trip.length, 64);
  assert.deepEqual(trip[0].bits, [false, false, false]);
  assert.deepEqual(trip[1].bits, [true, false, true]);
  assert.equal(trip[0].index, 0);
  assert.equal(trip[63].index, 63);
  assert.equal(annotationLabel(trip[1], "hex"), "1: 10→1");
  assert.ok(trip.every((a) => !a.error));
  const d = data(anns);
  assert.equal(d[0].note, "SEARCH ROM");
  assert.equal(d[1].note, "READ SCRATCHPAD");
  assert.equal(d.length, 2);
});

test("1-Wire: a SEARCH triplet where no device answered (1, 1) is an error", () => {
  const ow = new OneWire().reset().byte(0xf0).bit(true).bit(true).bit(false);
  const trip = decodeOneWire(ow.line()).filter((a) => a.kind === "triplet");
  assert.match(trip[0].error ?? "", /응답하는 장치 없음/);
});

test("1-Wire timing errors: no presence, a short reset, an overlong slot, slots too close, a cut byte", () => {
  // No device.
  let anns = decodeOneWire(new OneWire().reset(false).line());
  assert.equal(anns[0].presence, false);
  assert.equal(anns[0].error, "프레즌스 없음");
  assert.equal(annotationLabel(anns[0], "hex"), "리셋 (응답 없음)");
  // A 350 µs reset.
  anns = decodeOneWire(new OneWire().reset(true, 350 * US).line());
  assert.match(anns[0].error ?? "", /리셋 펄스가 짧음 \(350 µs/);
  // A 200 µs low in a byte: neither a slot nor a reset.
  const ow = new OneWire().reset().byte(0xcc);
  ow.bit(false, 200 * US, 270 * US);
  for (let k = 0; k < 7; k++) ow.bit(false);
  anns = data(decodeOneWire(ow.line()));
  assert.equal(anns[0].error, undefined);
  assert.match(anns[1].error ?? "", /Low 200 µs/);
  // Slots 40 µs apart.
  const fast = new OneWire().reset();
  for (let k = 0; k < 8; k++) fast.bit(k % 2 === 0, k % 2 === 0 ? 6 * US : 30 * US, 40 * US);
  anns = data(decodeOneWire(fast.line()));
  assert.match(anns[0].error ?? "", /슬롯 간격 40\.0 µs < 60 µs/);
  // Five bits, then a reset.
  const cut = new OneWire().reset();
  for (let k = 0; k < 5; k++) cut.bit(true);
  anns = decodeOneWire(cut.reset().byte(0xcc).line());
  assert.match(anns[1].error ?? "", /바이트가 끝나지 않음 \(5비트\)/);
  assert.equal(anns[3].note, "SKIP ROM");
  // Correct timing has none of these.
  assert.ok(decodeOneWire(new OneWire().reset().byte(0xcc).byte(0x44).line()).every((a) => !a.error));
});

test("1-Wire: pulses that end after `to` are left out", () => {
  const line = new OneWire().reset().byte(0xcc).byte(0x44).line();
  const all = decodeOneWire(line);
  const cut = decodeOneWire(line, all[2].start + 100 * US);
  assert.equal(cut.length, 2);
});

// ------------------------------------------------------------- TM1637

/** CLK and DIO of a TM1637 write, 5 µs a step. */
class Tm {
  clk = new Builder(true, 0);
  dio = new Builder(true, 0);
  /** Both lines' next level for one step. */
  step(c: boolean, d: boolean) {
    this.clk.hold(c, 5 * US);
    this.dio.hold(d, 5 * US);
    return this;
  }
  start() {
    return this.step(true, true).step(true, false).step(false, false);
  }
  stop() {
    return this.step(false, false).step(true, false).step(true, true).step(true, true);
  }
  byte(v: number, ack = true) {
    for (let k = 0; k < 8; k++) {
      const b = ((v >> k) & 1) === 1;
      this.step(false, b).step(true, b).step(false, b);
    }
    // The chip pulls DIO low after the 8th falling edge.
    return this.step(false, !ack).step(true, !ack).step(false, !ack).step(false, true);
  }
  write(bytes: number[], ack = true) {
    this.start();
    for (const v of bytes) this.byte(v, ack);
    return this.stop();
  }
  lines(): [Line, Line] {
    return [this.clk.line(), this.dio.line()];
  }
}

const SEG = { 0: 0x3f, 1: 0x06, 2: 0x5b, 3: 0x4f, 4: 0x66, 5: 0x6d } as Record<number, number>;

test("TM1637: commands, address and segment bytes decoded to the digits shown", () => {
  const tm = new Tm().write([0x40]).write([0xc0, SEG[1], SEG[2] | 0x80, SEG[3], SEG[4]]).write([0x8f]);
  const anns = decodeTm1637(...tm.lines());
  assert.deepEqual(
    anns.map((a) => a.kind),
    ["start", "data", "stop", "start", "data", "data", "data", "data", "data", "stop", "start", "data", "stop"],
  );
  const d = data(anns);
  assert.ok(d.every((a) => a.ack && !a.error));
  assert.equal(d[0].value, 0x40);
  assert.equal(d[0].note, "데이터 명령: 쓰기, 주소 자동 증가");
  assert.equal(d[1].value, 0xc0);
  assert.equal(d[1].note, "주소 0");
  assert.deepEqual(
    d.slice(2, 6).map((a) => [a.digit, a.note]),
    [
      [0, "자리 0: 1"],
      [1, "자리 1: 2 + 콜론"],
      [2, "자리 2: 3"],
      [3, "자리 3: 4"],
    ],
  );
  assert.equal(d[6].note, "표시 켜기, 밝기 7");
  assert.deepEqual(tm1637Display(anns), { segments: [SEG[1], SEG[2] | 0x80, SEG[3], SEG[4]], text: "12:34" });
  assert.equal(annotationLabel(d[3], "hex"), "0xDB A 자리 1: 2 + 콜론");
});

test("TM1637: fixed address, display off, an unknown command and a NACK", () => {
  const tm = new Tm().write([0x44]).write([0xc2, SEG[5]]).write([0xc3, SEG[0]]).write([0x80]).write([0x12]).write([0x40], false);
  const d = data(decodeTm1637(...tm.lines()));
  assert.equal(d[0].note, "데이터 명령: 쓰기, 고정 주소");
  assert.equal(d[2].note, "자리 2: 5");
  assert.equal(d[4].note, "자리 3: 0");
  assert.equal(d[5].note, "표시 끄기");
  assert.equal(d[6].error, "알 수 없는 명령");
  assert.equal(d[7].error, "NACK");
  assert.equal(d[7].ack, false);
  // Without all four digits there is nothing to show.
  assert.equal(tm1637Display(decodeTm1637(...tm.lines())), null);
});

test("TM1637: bytes are LSB first (a MSB-first reading would differ)", () => {
  const d = data(decodeTm1637(...new Tm().write([0x8a]).lines()));
  assert.equal(d[0].value, 0x8a);
  assert.equal(d[0].note, "표시 켜기, 밝기 2");
  assert.equal(segmentChar(0x7f), "8");
  assert.equal(segmentChar(0xff), "8");
  assert.equal(segmentChar(0x01), "?");
});

// ------------------------------------------------------------- WS2812

/** A WS2812 data line: pixels as 0xRRGGBB sent G, R, B, MSB first. */
class Ws {
  b = new Builder(false, 0).hold(false, 100 * US);
  bit(one: boolean, high = one ? 800 : 400) {
    this.b.hold(true, high).hold(false, 1250 - high);
    return this;
  }
  pixel(rgb: number, bad?: { bit: number; high: number }) {
    const grb = (((rgb >> 8) & 0xff) << 16) | (((rgb >> 16) & 0xff) << 8) | (rgb & 0xff);
    for (let k = 23; k >= 0; k--) {
      const one = ((grb >> k) & 1) === 1;
      this.bit(one, bad && bad.bit === 23 - k ? bad.high : undefined);
    }
    return this;
  }
  reset(ns = 80 * US) {
    this.b.hold(false, ns);
    return this;
  }
  line() {
    return this.b.line();
  }
}

test("WS2812: GRB pixels as colours, numbered from the reset, frames split by a reset", () => {
  const ws = new Ws().pixel(0xff0000).pixel(0x00ff00).pixel(0x123456).reset().pixel(0x0000ff).pixel(0xff8000).reset();
  const line = ws.line();
  const anns = decodeWs2812(line, 0, ws.b.t);
  assert.deepEqual(
    anns.map((a) => [a.kind, a.index, a.value]),
    [
      ["pixel", 0, 0xff0000],
      ["pixel", 1, 0x00ff00],
      ["pixel", 2, 0x123456],
      ["reset", undefined, undefined],
      ["pixel", 0, 0x0000ff],
      ["pixel", 1, 0xff8000],
      ["reset", undefined, undefined],
    ],
  );
  assert.ok(anns.every((a) => !a.error));
  assert.equal(annotationLabel(anns[2], "hex"), "#2 #123456");
  // A pixel spans its 24 bits.
  assert.ok(Math.abs(anns[0].end - anns[0].start - 24 * 1250) < 1);
});

test("WS2812: the index is unknown before the first reset seen", () => {
  const ws = new Ws().pixel(0x010203).pixel(0x040506).reset().pixel(0x0a0b0c);
  // A window starting with the second pixel (24 bits, 48 edges in).
  const first = ws.line().edges[48][0];
  const anns = decodeWs2812(sliceFrom(ws.line(), first), first);
  const px = anns.filter((a) => a.kind === "pixel" && !a.error);
  assert.equal(px.length, 2);
  assert.equal(px[0].index, undefined);
  assert.equal(px[0].value, 0x040506);
  assert.equal(px[1].index, 0);
  assert.equal(px[1].value, 0x0a0b0c);
});

test("WS2812: bits out of tolerance and a pixel cut short are errors", () => {
  const ws = new Ws().pixel(0xffffff).pixel(0x000000, { bit: 3, high: 600 }).pixel(0xffffff, { bit: 0, high: 1000 });
  ws.bit(true).bit(true).reset();
  const anns = decodeWs2812(ws.line(), 0, ws.b.t);
  assert.equal(anns[0].error, undefined);
  assert.match(anns[1].error ?? "", /비트 High 600 ns/);
  assert.match(anns[2].error ?? "", /비트 High 1000 ns/);
  assert.match(anns[3].error ?? "", /픽셀이 끝나지 않음 \(2비트\)/);
  assert.equal(anns[4].kind, "reset");
  // 0.4 and 0.8 µs ± 140 ns are fine.
  const ok = new Ws().pixel(0, { bit: 5, high: 540 }).pixel(0xffffff, { bit: 7, high: 660 }).reset();
  assert.ok(decodeWs2812(ok.line(), 0, ok.b.t).every((a) => !a.error));
  // A low shorter than 50 µs is no reset.
  const short = new Ws().pixel(1).reset(30 * US).pixel(2).reset();
  const px = decodeWs2812(short.line(), 0, short.b.t).filter((a) => a.kind === "pixel");
  assert.deepEqual(
    px.map((a) => a.index),
    [0, 1],
  );
});

// ---------------------------------------------------- content trigger

const BIT = 1e9 / 115200;

/** UART frames, back to back, from `t0`. */
function uart(text: string, t0 = 1000, gap = 0): Line {
  const b = new Builder(true, t0).hold(true, BIT * 3);
  for (const ch of text) {
    const v = ch.charCodeAt(0);
    b.hold(false, BIT);
    for (let k = 0; k < 8; k++) b.hold(((v >> k) & 1) === 1, BIT);
    b.hold(true, BIT + gap);
  }
  b.hold(true, BIT * 3);
  return b.line();
}

test("content match: UART byte, text, I2C address with R/W, pixel index and colour, commands", () => {
  const u = decodeUart(uart("xAyHello"), { baud: 115200 });
  assert.deepEqual(findMatches(u, { kind: "byte", value: 0x41 }), [u[1].start]);
  assert.deepEqual(findMatches(u, { kind: "text", text: "Hello" }), [u[3].start]);
  assert.deepEqual(findMatches(u, { kind: "text", text: "lo" }), [u[6].start]);
  assert.deepEqual(findMatches(u, { kind: "text", text: "Help" }), []);
  // Only after a time.
  assert.deepEqual(findMatches(u, { kind: "byte", value: 0x41 }, u[1].start), []);

  const i2c: Annotation[] = [
    { start: 0, end: 0, kind: "start" },
    { start: 1, end: 9, kind: "address", value: 0x78, addr: 0x3c, rw: "W", ack: true },
    { start: 10, end: 19, kind: "data", value: 0x3c, ack: true },
    { start: 20, end: 20, kind: "restart" },
    { start: 21, end: 29, kind: "address", value: 0x79, addr: 0x3c, rw: "R", ack: true },
  ];
  assert.deepEqual(findMatches(i2c, { kind: "address", addr: 0x3c, rw: "any" }), [1, 21]);
  assert.deepEqual(findMatches(i2c, { kind: "address", addr: 0x3c, rw: "R" }), [21]);
  assert.deepEqual(findMatches(i2c, { kind: "address", addr: 0x3d, rw: "any" }), []);
  // A data byte equal to the address is not an address.
  assert.deepEqual(findMatches(i2c, { kind: "byte", value: 0x3c }), [10]);

  const ws = new Ws().pixel(0xff0000).pixel(0x00ff00).reset().pixel(0xff0000).pixel(0x0000ff).reset();
  const px = decodeWs2812(ws.line(), 0, ws.b.t);
  assert.deepEqual(findMatches(px, { kind: "pixel", index: 1 }), [px[1].start, px[4].start]);
  assert.deepEqual(findMatches(px, { kind: "pixel", index: 1, color: 0x0000ff }), [px[4].start]);
  assert.deepEqual(findMatches(px, { kind: "pixel", index: 0, color: 0x00ff00 }), []);

  const ow = decodeOneWire(new OneWire().reset().byte(0xcc).byte(0x44).reset().byte(0xcc).byte(0xbe).line());
  assert.deepEqual(findMatches(ow, { kind: "byte", value: 0xbe }), [ow[5].start]);
  const tm = decodeTm1637(...new Tm().write([0x40]).write([0xc0, SEG[1]]).lines());
  assert.deepEqual(findMatches(tm, { kind: "byte", value: 0xc0 }), [tm[4].start]);
});

test("content trigger settings: what is typed becomes a condition (or none)", () => {
  const c = defaultScope().trigger.content;
  assert.deepEqual(contentMatch({ ...c, text: "0x41" }, "uart"), { kind: "byte", value: 0x41 });
  assert.deepEqual(contentMatch({ ...c, text: "'A'" }, "uart"), { kind: "byte", value: 0x41 });
  assert.deepEqual(contentMatch({ ...c, text: "65" }, "spi"), { kind: "byte", value: 65 });
  assert.equal(contentMatch({ ...c, text: "zz" }, "uart"), null);
  assert.deepEqual(contentMatch({ ...c, kind: "text", text: "OK\\r\\n" }, "uart"), { kind: "text", text: "OK\r\n" });
  assert.deepEqual(contentMatch({ ...c, kind: "address", text: "0x3C", rw: "W" }, "i2c"), { kind: "address", addr: 0x3c, rw: "W" });
  assert.equal(contentMatch({ ...c, kind: "address", text: "0x80" }, "i2c"), null);
  // A kind the decoder does not have falls back to its first.
  assert.deepEqual(contentMatch({ ...c, kind: "text", text: "0x44" }, "onewire"), { kind: "byte", value: 0x44 });
  assert.deepEqual(contentMatch({ ...c, kind: "pixel", index: 3, color: "#FF8000" }, "ws2812"), { kind: "pixel", index: 3, color: 0xff8000 });
  assert.deepEqual(contentMatch({ ...c, kind: "pixel", index: 3, color: "ff8000" }, "ws2812"), { kind: "pixel", index: 3, color: 0xff8000 });
  assert.deepEqual(contentMatch({ ...c, kind: "pixel", index: 0, color: "" }, "ws2812"), { kind: "pixel", index: 0 });
  assert.equal(contentMatch({ ...c, kind: "pixel", index: 0, color: "#GG0000" }, "ws2812"), null);
});

/** Run the live scan over a stream, a step every `dt` ns, from `arm`. */
function scanAll(line: Line, decode: (l: Line, from: number, to: number) => Annotation[], type: string, m: Parameters<typeof scanStep>[2], arm: number, end: number, dt: number) {
  let st: ScanState = { checked: arm, anchor: arm - 50 * US };
  const hits: number[] = [];
  for (let now = arm + dt; now < end + dt; now += dt) {
    const r = scanStep((from, to) => decode(sliceFrom(line, from, to), from, to), type, m, st, now, 200e6);
    hits.push(...r.hits);
    st = r.state;
  }
  return hits;
}

test("live content trigger: each match found once, also when it is split between steps", () => {
  const text = "noise Hello, Hello!";
  const line = uart(text);
  const all = decodeUart(line, { baud: 115200 });
  const end = line.edges[line.edges.length - 1][0] + 20 * BIT;
  const dec = (l: Line, _from: number, to: number) => decodeUart(l, { baud: 115200 }, to);
  const want = [all[6].start, all[13].start];
  // Steps shorter than a frame, between one frame and the text, and longer than all.
  for (const dt of [BIT * 3, BIT * 25, BIT * 1000]) {
    assert.deepEqual(scanAll(line, dec, "uart", { kind: "text", text: "Hello" }, 0, end, dt), want, `step ${dt}`);
    assert.deepEqual(scanAll(line, dec, "uart", { kind: "byte", value: 0x48 }, 0, end, dt), want, `step ${dt}`);
  }
  // Armed after the first: only the second.
  assert.deepEqual(scanAll(line, dec, "uart", { kind: "text", text: "Hello" }, all[7].start, end, BIT * 7), [want[1]]);
});

test("live content trigger: an I2C address needs the START before it, kept as the anchor", () => {
  // Write to 0x3C: START, address, 20 data bytes, STOP — 100 kHz.
  const scl = new Builder(true, 0).hold(true, 20 * US);
  const sda = new Builder(true, 0).hold(true, 20 * US);
  const q = 2.5 * US;
  const step = (c: boolean, d: boolean) => {
    scl.hold(c, q);
    sda.hold(d, q);
  };
  const byte = (v: number) => {
    for (let k = 7; k >= -1; k--) {
      const b = k < 0 ? false : ((v >> k) & 1) === 1;
      step(false, b);
      step(true, b);
      step(true, b);
      step(false, b);
    }
  };
  step(true, true);
  step(true, false);
  step(false, false);
  byte(0x78);
  for (let i = 0; i < 20; i++) byte(0x3c);
  step(false, false);
  step(true, false);
  step(true, true);
  step(true, true);
  const end = scl.t;
  const dec = (from: number, to: number) => decodeI2c(sliceFrom(scl.line(), from, to), sliceFrom(sda.line(), from, to));
  const all = decodeI2c(scl.line(), sda.line());
  let st: ScanState = { checked: 0, anchor: 0 };
  const hits: number[] = [];
  const dataHits: number[] = [];
  let st2: ScanState = { checked: 0, anchor: 0 };
  for (let now = 30 * US; now < end + 30 * US; now += 30 * US) {
    const r = scanStep(dec, "i2c", { kind: "address", addr: 0x3c, rw: "W" }, st, now, 200e6);
    hits.push(...r.hits);
    st = r.state;
    const r2 = scanStep(dec, "i2c", { kind: "byte", value: 0x3c }, st2, now, 200e6);
    dataHits.push(...r2.hits);
    st2 = r2.state;
  }
  assert.deepEqual(hits, [all[1].start]);
  // Every data byte once (none read as an address), though the steps cut the transaction.
  assert.equal(dataHits.length, 20);
  assert.deepEqual(dataHits, all.filter((a) => a.kind === "data").map((a) => a.start));
});

// ------------------------------------------------- project file

const CATALOG: Record<string, CatalogEntry> = {
  "nucleo-f401re": { pins: [{ id: "PA5" }, { id: "GND" }] },
  led: { props: { color: "red" }, pins: [{ id: "A" }, { id: "K" }] },
};

const PROJECT = {
  parts: [
    { id: "board", kind: "nucleo-f401re", x: 0, y: 0, props: {} },
    { id: "led1", kind: "led", x: 10, y: 5, props: { color: "green" } },
  ],
  wires: [{ id: "w1", a: { part: "board", pin: "PA5" }, b: { part: "led1", pin: "A" }, color: "#1e88e5" }],
};

function settings(): ScopeSettings {
  const s = defaultScope();
  const uart = newDecoder(1, "uart");
  const ow = newDecoder(2, "onewire");
  const spi = { ...newDecoder(3, "spi"), mode: 3, lsbFirst: true, pins: ["PA5", "PA7", "", "PB6"] };
  return {
    ...s,
    pins: ["PA5", "PA2", "PA10", "PA7", "PB6"],
    analog: [{ spec: "led1.A", vdiv: 0.5, offset: 2 }],
    decoders: [{ ...uart, baud: 9600, parity: "even" }, ow, spi],
    fmt: "ascii",
    divNs: 500e3,
    trigger: {
      ...s.trigger,
      source: "dec:1",
      edge: "falling",
      mode: "single",
      pre: 0.25,
      widthCmp: "gt",
      widthUs: 40,
      pause: true,
      level: 2.5,
      hysteresis: 0.2,
      content: { kind: "text", text: "Hello", rw: "R", index: 4, color: "#FF0000" },
    },
  };
}

test("project file: the waveform settings survive saving and opening", () => {
  const scope = settings();
  const text = serialize({ ...PROJECT, scope }, "시험", { name: "hal-uart-printf", example: "hal-uart-printf.elf" });
  assert.deepEqual(JSON.parse(text).scope, scope);
  const back = parseWith(text, CATALOG);
  assert.deepEqual(back.project.scope, scope);
  assert.deepEqual(back.project.parts, PROJECT.parts);
  assert.equal(back.name, "시험");
  assert.deepEqual(back.notes, []);
  // And again.
  assert.deepEqual(parseWith(serialize(back.project, back.name, back.firmware), CATALOG).project.scope, scope);
});

test("project file: an older project without settings opens as before", () => {
  const old = JSON.stringify({ format: "simucleo-project", version: 1, name: "옛것", parts: PROJECT.parts, wires: PROJECT.wires });
  const l = parseWith(old, CATALOG);
  assert.equal(l.project.scope, undefined);
  assert.ok(!("scope" in l.project));
  assert.equal(l.project.parts.length, 2);
  assert.equal(l.project.wires.length, 1);
  assert.deepEqual(l.notes, []);
  // Saved again, it still has none.
  assert.ok(!("scope" in JSON.parse(serialize(l.project, l.name))));
  // Version 0, a bare { parts, wires }.
  assert.equal(parseWith(JSON.stringify({ parts: PROJECT.parts, wires: [] }), CATALOG).project.scope, undefined);
});

test("project file: broken or unknown settings get their defaults", () => {
  const d = defaultScope();
  const l = parseWith(
    JSON.stringify({
      ...PROJECT,
      scope: {
        pins: ["PA5", "PZ9", 3, "PA5", "PB10"],
        analog: [{ spec: "pot.W", vdiv: -1 }, { vdiv: 1 }, { spec: "pot.W" }],
        decoders: [
          { type: "can", pins: ["PA11"] },
          { id: 4, type: "tm1637", pins: ["PB0"] },
          { id: 4, type: "ws2812", pins: [], baud: "fast" },
          { type: "spi", pins: ["PA5", "PA7", "", "x"], mode: 7 },
        ],
        divNs: 3e6,
        fmt: "bin",
        trigger: { source: "dec:4", mode: "sometimes", pre: 2, content: { kind: "pixel", index: -1 } },
      },
    }),
    CATALOG,
  );
  const s = l.project.scope!;
  assert.deepEqual(s.pins, ["PA5", "PB10"]);
  assert.deepEqual(s.analog, [{ spec: "pot.W", vdiv: 1, offset: 1.65 }]);
  assert.deepEqual(
    s.decoders.map((x) => [x.id, x.type, x.pins, x.baud, x.mode]),
    [
      [4, "tm1637", ["PB0", "PB3"], 115200, 0],
      [5, "ws2812", ["PB4"], 115200, 0],
      [6, "spi", ["PA5", "PA7", "", ""], 115200, 0],
    ],
  );
  assert.equal(s.divNs, d.divNs);
  assert.equal(s.fmt, "hex");
  assert.equal(s.trigger.source, "dec:4");
  assert.equal(s.trigger.mode, "auto");
  assert.equal(s.trigger.pre, 0.5);
  assert.equal(s.trigger.content.kind, "pixel");
  assert.equal(s.trigger.content.index, 0);
  // Not an object: none.
  assert.equal(sanitizeScope("scope"), undefined);
  assert.equal(sanitizeScope(null), undefined);
});

test("WS2812: the colours of the last frame latched by a reset", () => {
  const ws = new Ws().pixel(0x010101).pixel(0x020202).reset().pixel(0xff0000).pixel(0x00ff00).pixel(0x0000ff).reset().pixel(0x111111);
  const anns = decodeWs2812(ws.line(), 0, ws.b.t);
  assert.deepEqual(ws2812Frame(anns), [0xff0000, 0x00ff00, 0x0000ff]);
  // The first frame counts too: the window starts in the idle low.
  assert.deepEqual(ws2812Frame(anns.slice(0, 3)), [0x010101, 0x020202]);
  // Not latched yet, or a pixel in error: none.
  assert.equal(ws2812Frame(anns.slice(0, 2)), null);
  const bad = new Ws().pixel(1).pixel(2, { bit: 0, high: 600 }).reset();
  assert.equal(ws2812Frame(decodeWs2812(bad.line(), 0, bad.b.t)), null);
});
