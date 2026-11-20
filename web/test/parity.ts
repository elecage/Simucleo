// Streams for the TypeScript/Rust decoder parity check (M26). The content
// trigger decodes inside the simulator (crates/wasm/src/decode.rs) with the
// same decoders as web/src/run/decode.ts, one edge at a time. These
// synthetic streams — clean traffic, errors, glitches, edges at the same
// time on two lines — are decoded here; the items and the content matches
// go to crates/wasm/tests/fixtures/decode-parity.json, which
// crates/wasm/tests/decode_parity.rs feeds to the Rust decoders, edge by
// edge, and compares. `npm test` (m26.test.ts) checks that the file is what
// the TypeScript decoders give now; `node scripts/decode-parity.ts` writes it.
import {
  decodeI2c,
  decodeNec,
  decodeOneWire,
  decodeSpi,
  decodeTm1637,
  decodeUart,
  decodeWs2812,
  findMatches,
  type Annotation,
  type ContentMatch,
  type Line,
  type Parity,
} from "../src/run/decode.ts";

export interface ParityDecoder {
  type: "uart" | "i2c" | "spi" | "onewire" | "tm1637" | "ws2812" | "nec";
  pins: string[];
  baud: number;
  parity: Parity;
  mode: number;
  lsbFirst: boolean;
}

/** One decoded item: kind, start, end, value, miso, addr, rw, index, error class. */
export type ParityItem = [string, number, number, number | null, number | null, number | null, string | null, number | null, "partial" | "other" | null];

export interface ParityCase {
  name: string;
  decoder: ParityDecoder;
  /** WS2812: when watching starts. */
  from: number;
  /** One line per decoder pin (null: an optional pin left out). */
  lines: (Line | null)[];
  items: ParityItem[];
  matches: { match: ContentMatch; starts: number[] }[];
}

/** Deterministic pseudo-random numbers in [0, 1). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A line written at absolute (integer ns) times. */
class L {
  edges: [number, boolean][] = [];
  level0: boolean;
  level: boolean;
  constructor(level0: boolean) {
    this.level0 = level0;
    this.level = level0;
  }
  at(t: number, l: boolean) {
    t = Math.round(t);
    if (l === this.level) return;
    const last = this.edges[this.edges.length - 1];
    if (last && t < last[0]) throw new Error(`edges out of order: ${t} < ${last[0]}`);
    this.edges.push([t, l]);
    this.level = l;
  }
  line(): Line {
    return { level0: this.level0, edges: this.edges };
  }
}

const dec = (type: ParityDecoder["type"], pins: string[], o: Partial<ParityDecoder> = {}): ParityDecoder => ({
  type,
  pins,
  baud: 115200,
  parity: "none",
  mode: 0,
  lsbFirst: false,
  ...o,
});

// ------------------------------------------------------------- streams

function uartStream(seed: number, baud: number, parity: Parity) {
  const r = rng(seed);
  const bit = 1e9 / baud;
  const l = new L(true);
  let t = 5000;
  const text = "Hello\r\ntick 1\r\ntick 2\r\nti\x00ck 3\r\nOK\r\ntick 1 tick 1\r\n";
  for (let i = 0; i < text.length * 3; i++) {
    const v = text.charCodeAt(i % text.length);
    const bits: boolean[] = [];
    for (let k = 0; k < 8; k++) bits.push(((v >> k) & 1) === 1);
    if (parity !== "none") {
      const ones = bits.filter(Boolean).length + (r() < 0.05 ? 1 : 0); // a parity error now and then
      bits.push((ones % 2 === 1) !== (parity === "odd"));
    }
    const badStop = r() < 0.04;
    l.at(t, false);
    bits.forEach((b, k) => l.at(t + (1 + k) * bit, b));
    l.at(t + (1 + bits.length) * bit, !badStop);
    t += (2 + bits.length) * bit;
    if (badStop) {
      l.at(t, true);
      t += bit;
    }
    // A gap, sometimes with a glitch in it.
    if (r() < 0.3) {
      t += Math.floor(r() * 20) * bit;
      if (r() < 0.3) {
        l.at(t, false);
        l.at(t + bit / 5, true);
        t += bit;
      }
    }
  }
  l.at(t + 20 * bit, true);
  return [l.line()];
}

const P = 10_000;

function i2cStream(seed: number) {
  const r = rng(seed);
  const scl = new L(true);
  const sda = new L(true);
  let t = 3000;
  const start = () => {
    sda.at(t, true);
    scl.at(t + P / 4, true);
    sda.at(t + P / 2, false);
    scl.at(t + P, false);
    t += P;
  };
  const stop = () => {
    sda.at(t + P / 4, false);
    scl.at(t + P / 2, true);
    sda.at(t + P, true);
    t += 2 * P;
  };
  const byte = (v: number, ack: boolean) => {
    for (let k = 0; k < 9; k++) {
      const b = k < 8 ? ((v >> (7 - k)) & 1) === 1 : !ack;
      // Sometimes SDA changes at the very time SCL falls.
      const same = r() < 0.3;
      if (same) sda.at(t, b);
      else sda.at(t + P / 4, b);
      scl.at(t + P / 2, true);
      scl.at(t + P, false);
      t += P;
    }
  };
  // Bits before the first START.
  scl.at(t, false);
  t += P;
  byte(0x55, true);
  for (let n = 0; n < 30; n++) {
    const addr = [0x76, 0x3c, 0x68][Math.floor(r() * 3)];
    const nack = r() < 0.1;
    start();
    byte(addr << 1, !nack);
    if (nack) {
      stop();
      continue;
    }
    byte(Math.floor(r() * 256), true);
    if (r() < 0.6) {
      // Repeated START, read.
      start();
      byte((addr << 1) | 1, true);
      const k = 1 + Math.floor(r() * 4);
      for (let j = 0; j < k; j++) byte(j === 0 ? 0xd0 : Math.floor(r() * 256), j < k - 1);
    } else byte(r() < 0.5 ? 0xd0 : Math.floor(r() * 256), r() > 0.1);
    stop();
    t += Math.floor(r() * 10) * P;
  }
  t += 5 * P;
  return [scl.line(), sda.line()];
}

function spiStream(seed: number, mode: number, cs: boolean, miso: boolean) {
  const r = rng(seed);
  const cpol = (mode & 2) !== 0;
  const cpha = (mode & 1) !== 0;
  const sck = new L(cpol);
  const mo = new L(false);
  const mi = new L(true);
  const csl = new L(true);
  const half = 125;
  let t = 1000;
  for (let burst = 0; burst < 12; burst++) {
    if (cs) csl.at(t - 300, false);
    const n = 1 + Math.floor(r() * 5);
    for (let j = 0; j < n; j++) {
      const v = j === 0 && r() < 0.4 ? 0x9f : Math.floor(r() * 256);
      const w = Math.floor(r() * 256);
      for (let k = 0; k < 8; k++) {
        const [b, c] = [((v >> (7 - k)) & 1) === 1, ((w >> (7 - k)) & 1) === 1];
        if (cpha) {
          sck.at(t, !cpol);
          // Data changes at the leading edge itself, now and then.
          const d = r() < 0.3 ? 0 : 1;
          mo.at(t + d, b);
          mi.at(t + d, c);
          sck.at(t + half, cpol);
        } else {
          // Data changes at the sampling edge itself, now and then (the
          // level before it is sampled).
          const d = r() < 0.15 ? half : 0;
          mo.at(t + d, b);
          mi.at(t + d, c);
          sck.at(t + half, !cpol);
          sck.at(t + 2 * half, cpol);
        }
        t += 2 * half;
      }
      t += 4 * half;
    }
    // A CS edge mid-word now and then (the word is dropped).
    if (cs && r() < 0.3) {
      sck.at(t, !cpol);
      sck.at(t + half, cpol);
      csl.at(t + half, true);
      t += 2 * half;
    }
    if (cs) csl.at(t + 300, true);
    t += 700 + Math.floor(r() * 30) * half;
  }
  return [sck.line(), mo.line(), miso ? mi.line() : null, cs ? csl.line() : null];
}

const US = 1000;

function oneWireStream(seed: number) {
  const r = rng(seed);
  const l = new L(true);
  let t = 10 * US;
  const hold = (level: boolean, ns: number) => {
    l.at(t, level);
    t += ns;
  };
  const reset = (presence = true, low = 480 * US) => {
    hold(false, low);
    if (presence) {
      hold(true, 30 * US);
      hold(false, 120 * US);
      hold(true, 330 * US);
    } else hold(true, 480 * US);
  };
  const bit = (one: boolean, low = one ? 6 * US : 60 * US, slot = 70 * US) => {
    hold(false, low);
    hold(true, slot - low);
  };
  const byte = (v: number, read = false) => {
    for (let k = 0; k < 8; k++) {
      const one = ((v >> k) & 1) === 1;
      bit(one, one ? 6 * US : read ? 30 * US : 60 * US);
    }
  };
  hold(true, 100 * US);
  for (let n = 0; n < 12; n++) {
    const x = r();
    if (x < 0.1) reset(false);
    else if (x < 0.15) reset(true, 400 * US);
    else reset();
    byte(0xcc);
    if (r() < 0.5) byte(0x44);
    else {
      byte(0xbe);
      for (let k = 0; k < 9; k++) byte(Math.floor(r() * 256), true);
    }
    if (r() < 0.2) {
      // A byte cut short by the next reset, a slot too long, slots too close.
      bit(true);
      bit(false, 200 * US, 260 * US);
      bit(true, 6 * US, 40 * US);
    }
    if (r() < 0.3) {
      reset();
      byte(0x55);
      for (let k = 0; k < 8; k++) byte(Math.floor(r() * 256));
      byte(0x44);
    }
    if (r() < 0.2) {
      reset();
      byte(0xf0);
      for (let k = 0; k < 64; k++) {
        const b = r() < 0.5;
        bit(b, b ? 6 * US : 30 * US);
        bit(!b && r() > 0.1, !b ? 6 * US : 30 * US);
        bit(b);
      }
      byte(0x44);
    }
    hold(true, Math.floor(r() * 500) * US);
  }
  // Ends with a time slot, not a reset (whose presence would be unknown).
  byte(0x00);
  hold(true, 1000 * US);
  return [l.line()];
}

function tm1637Stream(seed: number) {
  const r = rng(seed);
  const clk = new L(true);
  const dio = new L(true);
  const H = 5000;
  let t = 2000;
  const start = () => {
    dio.at(t, false);
    clk.at(t + H, false);
    t += 2 * H;
  };
  const stop = () => {
    dio.at(t, false);
    clk.at(t + H, true);
    dio.at(t + 2 * H, true);
    t += 3 * H;
  };
  const byte = (v: number, ack = true) => {
    for (let k = 0; k < 9; k++) {
      const b = k < 8 ? ((v >> k) & 1) === 1 : !ack;
      if (r() < 0.2) dio.at(t, b);
      else dio.at(t + H / 2, b);
      clk.at(t + H, true);
      clk.at(t + 2 * H, false);
      t += 2 * H;
    }
  };
  for (let n = 0; n < 15; n++) {
    start();
    byte(r() < 0.8 ? 0x40 : 0x44);
    stop();
    start();
    byte(0xc0 + Math.floor(r() * 4));
    for (let k = 0; k < 4; k++) byte(Math.floor(r() * 256), r() > 0.05);
    stop();
    start();
    byte(r() < 0.9 ? 0x88 + Math.floor(r() * 8) : 0x12);
    stop();
    t += Math.floor(r() * 20) * H;
  }
  return [clk.line(), dio.line()];
}

function ws2812Stream(seed: number) {
  const r = rng(seed);
  const l = new L(false);
  let t = 100_000;
  for (let frame = 0; frame < 6; frame++) {
    const n = 4 + Math.floor(r() * 5);
    for (let p = 0; p < n; p++) {
      const c = p === 2 && frame % 2 === 0 ? 0x123456 : Math.floor(r() * 0x1000000);
      const grb = (((c >> 8) & 0xff) << 16) | (((c >> 16) & 0xff) << 8) | (c & 0xff);
      for (let k = 23; k >= 0; k--) {
        const one = ((grb >> k) & 1) === 1;
        let h = one ? 800 : 400;
        if (r() < 0.01) h = one ? 1100 : 150; // out of tolerance
        l.at(t, true);
        l.at(t + h, false);
        t += 1250;
      }
      if ((frame === 3 && p === 1) || r() < 0.03) {
        // A pixel cut short by a reset.
        for (let k = 0; k < 5; k++) {
          l.at(t, true);
          l.at(t + 400, false);
          t += 1250;
        }
        break;
      }
    }
    t += 60_000 + Math.floor(r() * 50) * 1000;
  }
  return [l.line()];
}

function necStream(seed: number) {
  const r = rng(seed);
  const l = new L(true);
  const M = 562_500;
  let t = 5e6;
  const mark = (ns: number) => {
    l.at(t, false);
    l.at(t + ns, true);
    t += ns;
  };
  const frame = (addr: number, cmd: number, o: { badCheck?: boolean; cut?: number; badSpace?: boolean } = {}) => {
    const bytes = [addr, ~addr & 0xff, cmd, (~cmd & 0xff) ^ (o.badCheck ? 4 : 0)];
    mark(9e6);
    t += 4.5e6;
    let n = 0;
    for (const b of bytes)
      for (let k = 0; k < 8; k++) {
        if (o.cut !== undefined && n === o.cut) return;
        mark(M + Math.round((r() - 0.5) * 60_000));
        t += ((b >> k) & 1 ? 3 * M : M) + Math.round((r() - 0.5) * 60_000);
        if (o.badSpace && n === 13) t += 2e6;
        n++;
      }
    mark(M);
  };
  const repeat = () => {
    mark(9e6);
    t += 2.25e6;
    mark(M);
  };
  const cmds = [0x45, 0x46, 0x1c, 0x5a, 0x16];
  // Each kind of trouble at least once, then at random.
  const plan = [0.05, 0.15, 0.2, 0.5, 0.95];
  for (let n = 0; n < 16; n++) {
    const x = plan[n] ?? r();
    const cmd = cmds[Math.floor(r() * cmds.length)];
    if (x < 0.1) frame(0x00, cmd, { badCheck: true });
    else if (x < 0.18) {
      // The next leader cuts it short, right after a bit.
      frame(0x00, cmd, { cut: 1 + Math.floor(r() * 30) });
      frame(0x00, 0x1c);
    }
    else if (x < 0.24) frame(0x00, cmd, { badSpace: true });
    else frame(x > 0.9 ? 0x01 : 0x00, cmd);
    t += 40e6;
    const reps = Math.floor(r() * 3);
    for (let k = 0; k < reps; k++) {
      repeat();
      t += 96e6;
    }
    if (r() < 0.15) {
      // A leader with a space that fits neither.
      mark(9e6);
      t += 3e6;
      mark(M);
      t += 30e6;
    }
  }
  frame(0x00, 0x1c);
  t += 50e6;
  l.at(t, true);
  return [l.line()];
}

// ------------------------------------------------------------- decoding

export function decodeCase(d: ParityDecoder, lines: (Line | null)[], from: number): Annotation[] {
  const [a, b, c, e] = lines;
  switch (d.type) {
    case "uart":
      return decodeUart(a!, { baud: d.baud, parity: d.parity });
    case "i2c":
      return decodeI2c(a!, b!);
    case "spi":
      return decodeSpi(a!, b!, c ?? null, e ?? null, { cpol: (d.mode & 2) !== 0, cpha: (d.mode & 1) !== 0, msbFirst: !d.lsbFirst });
    case "onewire":
      return decodeOneWire(a!);
    case "tm1637":
      return decodeTm1637(a!, b!);
    case "ws2812":
      return decodeWs2812(a!, from);
    case "nec":
      return decodeNec(a!);
  }
}

const errClass = (a: Annotation): "partial" | "other" | null =>
  !a.error ? null : /^(바이트가|픽셀이|프레임이)/.test(a.error) ? "partial" : "other";

/** Items in start order (the Rust decoders emit an NEC leader once its frame is known). */
export function summarize(anns: Annotation[]): ParityItem[] {
  return anns
    .map(
      (a): ParityItem => [
        a.kind,
        a.start,
        a.end,
        a.value ?? null,
        a.miso ?? null,
        a.addr ?? null,
        a.rw ?? null,
        a.index ?? null,
        errClass(a),
      ],
    )
    .sort((x, y) => x[1] - y[1] || (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
}

function makeCase(name: string, decoder: ParityDecoder, lines: (Line | null)[], matches: ContentMatch[], from = 0): ParityCase {
  const anns = decodeCase(decoder, lines, from);
  return {
    name,
    decoder,
    from,
    lines,
    items: summarize(anns),
    matches: matches.map((match) => ({ match, starts: findMatches(anns, match) })),
  };
}

/** All the parity cases. */
export function parityCases(): ParityCase[] {
  const cases: ParityCase[] = [];
  const text = (s: string): ContentMatch => ({ kind: "text", text: s });
  const byte = (v: number): ContentMatch => ({ kind: "byte", value: v });
  for (const [seed, baud] of [
    [1, 115200],
    [2, 9600],
  ] as const) {
    cases.push(
      makeCase(`uart 8N1 ${baud} (seed ${seed})`, dec("uart", ["PA2"], { baud }), uartStream(seed, baud, "none"), [
        text("tick 1"),
        text("ti"),
        text("1 tick"),
        text("\r\n"),
        text("OK\r\n"),
        byte(0x0a),
        byte("k".charCodeAt(0)),
      ]),
    );
  }
  for (const parity of ["even", "odd"] as const)
    cases.push(
      makeCase(`uart 8${parity[0].toUpperCase()}1`, dec("uart", ["PA2"], { parity }), uartStream(7, 115200, parity), [text("tick"), byte(0x0d)]),
    );
  for (const seed of [3, 4])
    cases.push(
      makeCase(`i2c (seed ${seed})`, dec("i2c", ["PB8", "PB9"]), i2cStream(seed), [
        { kind: "address", addr: 0x76, rw: "W" },
        { kind: "address", addr: 0x76, rw: "R" },
        { kind: "address", addr: 0x3c, rw: "any" },
        byte(0xd0),
      ]),
    );
  for (let mode = 0; mode < 4; mode++)
    for (const [cs, miso, lsb] of [
      [true, true, false],
      [false, true, false],
      [true, false, true],
    ] as const)
      cases.push(
        makeCase(
          `spi mode ${mode}${cs ? " CS" : ""}${miso ? " MISO" : ""}${lsb ? " LSB" : ""}`,
          dec("spi", ["PA5", "PA7", miso ? "PA6" : "", cs ? "PB6" : ""], { mode, lsbFirst: lsb }),
          spiStream(10 + mode, mode, cs, miso),
          [byte(0x9f), byte(0xf9), byte(0x00)],
        ),
      );
  cases.push(makeCase("1-wire", dec("onewire", ["PA10"]), oneWireStream(5), [byte(0x44), byte(0xbe), byte(0x55)]));
  cases.push(makeCase("tm1637", dec("tm1637", ["PA10", "PB3"]), tm1637Stream(6), [byte(0xc0), byte(0x40), byte(0x12)]));
  cases.push(
    makeCase("ws2812", dec("ws2812", ["PB4"]), ws2812Stream(8), [
      { kind: "pixel", index: 2, color: 0x123456 },
      { kind: "pixel", index: 0 },
      { kind: "pixel", index: 5 },
    ]),
  );
  for (const seed of [9, 12])
    cases.push(
      makeCase(`nec (seed ${seed})`, dec("nec", ["PB3"]), necStream(seed), [
        { kind: "nec", cmd: 0x1c },
        { kind: "nec", cmd: 0x1c, addr: 0 },
        { kind: "nec", cmd: 0x45, addr: 1 },
        { kind: "nec", cmd: 0x16 },
      ]),
    );
  return cases;
}

/** The fixture file's text. */
export const parityJson = () => JSON.stringify({ generatedBy: "web/scripts/decode-parity.ts", cases: parityCases() }) + "\n";
