// Protocol decoders for the waveform view (M22): UART, I2C and SPI, on the
// edges of captured (or live) digital channels. Pure functions over edge
// lists with times in ns, unit tested in test/decode.test.ts.
//
// The edges of a USART, I2C or SPI pin are synthesized by the simulator
// from the bytes the peripheral moves (crates/periph-stm32f4/src/wire.rs);
// bit-banged protocols (TM1637, software I2C, 1-Wire) are real GPIO edges.
// The decoders do not care which.
import { levelAt, lowerBound } from "./scope.ts";

/** A digital channel: level before the first edge, then [ns, level]. */
export interface Line {
  level0: boolean;
  edges: [number, boolean][];
}

export type AnnotationKind = "data" | "address" | "start" | "restart" | "stop";

/** One decoded item, drawn as a box over [start, end] (ns). */
export interface Annotation {
  start: number;
  end: number;
  kind: AnnotationKind;
  /** Byte (or word) value: UART data, I2C address byte or data, SPI MOSI. */
  value?: number;
  /** SPI: the word on MISO. */
  miso?: number;
  /** I2C address byte: 7-bit address and direction. */
  addr?: number;
  rw?: "R" | "W";
  /** I2C: the byte was acknowledged. */
  ack?: boolean;
  /** Framing, parity or NACK: shown in red. */
  error?: string;
}

export type Parity = "none" | "even" | "odd";

export interface UartOptions {
  baud: number;
  /** Data bits (default 8; the parity bit comes after them). */
  dataBits?: number;
  parity?: Parity;
  stopBits?: number;
  /** Idle-low (inverted) line. */
  invert?: boolean;
}

/** Level of a line just after `t` (edges at `t` included). */
export function levelAfter(line: Line, t: number): boolean {
  let i = lowerBound(line.edges, t);
  while (i < line.edges.length && line.edges[i][0] === t) i++;
  return i === 0 ? line.level0 : line.edges[i - 1][1];
}

/**
 * UART frames: a start bit found on each falling edge (after the previous
 * frame), the bits sampled in their middle. Frames that would run past
 * `to` are left out. A low stop bit is a framing error, a wrong parity bit
 * a parity error.
 */
export function decodeUart(line: Line, o: UartOptions, to = Infinity): Annotation[] {
  const bit = 1e9 / o.baud;
  const n = o.dataBits ?? 8;
  const parity = o.parity ?? "none";
  const stops = o.stopBits ?? 1;
  const inv = o.invert ?? false;
  const at = (t: number) => levelAt(line, t) !== inv;
  const frame = (1 + n + (parity === "none" ? 0 : 1) + stops) * bit;
  const out: Annotation[] = [];
  let i = 0;
  while (i < line.edges.length) {
    const [t, l] = line.edges[i];
    // A start bit: the line leaves idle.
    if (l !== inv) {
      i++;
      continue;
    }
    if (t + frame - bit / 2 > to) break;
    if (at(t + bit / 2)) {
      // A glitch, not a start bit.
      i++;
      continue;
    }
    let value = 0;
    let ones = 0;
    for (let k = 0; k < n; k++) {
      if (at(t + (1.5 + k) * bit)) {
        value |= 1 << k;
        ones++;
      }
    }
    let k = 1 + n;
    let error: string | undefined;
    if (parity !== "none") {
      const p = at(t + (k + 0.5) * bit);
      if (((ones + (p ? 1 : 0)) % 2 === 1) !== (parity === "odd")) error = "패리티 오류";
      k++;
    }
    for (let s = 0; s < stops; s++, k++) {
      if (!at(t + (k + 0.5) * bit)) error = "프레이밍 오류";
    }
    out.push({ start: t, end: t + k * bit, kind: "data", value, ...(error ? { error } : {}) });
    // The next start bit comes after the middle of the (last) stop bit.
    i = lowerBound(line.edges, t + (k - 0.5) * bit);
  }
  return out;
}

/** The text of decoded UART frames (bytes with errors left out). */
export function uartText(anns: Annotation[]): string {
  return anns
    .filter((a) => a.kind === "data" && !a.error && a.value !== undefined)
    .map((a) => String.fromCharCode(a.value!))
    .join("");
}

/** Edges of two lines merged in time order (`a` first at equal times). */
function merge(a: Line, b: Line): [number, 0 | 1, boolean][] {
  const out: [number, 0 | 1, boolean][] = [];
  let i = 0;
  let j = 0;
  while (i < a.edges.length || j < b.edges.length) {
    if (j >= b.edges.length || (i < a.edges.length && a.edges[i][0] <= b.edges[j][0])) {
      out.push([a.edges[i][0], 0, a.edges[i][1]]);
      i++;
    } else {
      out.push([b.edges[j][0], 1, b.edges[j][1]]);
      j++;
    }
  }
  return out;
}

/**
 * I2C: START / repeated START (SDA falls while SCL is high), STOP (SDA
 * rises while SCL is high), then 9 bits per byte sampled on SCL's rising
 * edges: the first byte after a START is the address with R/W, then data.
 * A NACK on the address or on a written byte is an error; the NACK that
 * ends a read is how the controller says "last byte".
 */
export function decodeI2c(scl: Line, sda: Line): Annotation[] {
  const out: Annotation[] = [];
  let c = scl.level0;
  let d = sda.level0;
  /** In a transaction (after a START). */
  let active = false;
  let first = false;
  let read = false;
  let bits: boolean[] = [];
  let byteStart = 0;
  let lastFall = NaN;
  let lastRise = NaN;
  let period = NaN;
  for (const [t, which, l] of merge(scl, sda)) {
    if (which === 0) {
      if (l === c) continue;
      c = l;
      if (!c) {
        lastFall = t;
        continue;
      }
      if (!active) continue;
      if (bits.length === 0) byteStart = Number.isNaN(lastFall) ? t : lastFall;
      if (!Number.isNaN(lastRise) && bits.length > 0) period = t - lastRise;
      lastRise = t;
      bits.push(d);
      if (bits.length === 9) {
        const value = bits.slice(0, 8).reduce((a, x) => (a << 1) | (x ? 1 : 0), 0);
        const ack = !bits[8];
        const end = t + (Number.isNaN(period) ? t - byteStart : period / 2);
        if (first) {
          read = (value & 1) === 1;
          out.push({
            start: byteStart,
            end,
            kind: "address",
            value,
            addr: value >> 1,
            rw: read ? "R" : "W",
            ack,
            ...(ack ? {} : { error: "NACK" }),
          });
          first = false;
        } else {
          out.push({ start: byteStart, end, kind: "data", value, ack, ...(ack || read ? {} : { error: "NACK" }) });
        }
        bits = [];
      }
    } else {
      if (l === d) continue;
      d = l;
      if (!c) continue;
      if (!d) {
        out.push({ start: t, end: t, kind: active ? "restart" : "start" });
        active = true;
        first = true;
      } else {
        out.push({ start: t, end: t, kind: "stop" });
        active = false;
      }
      bits = [];
    }
  }
  return out;
}

export interface SpiOptions {
  cpol: boolean;
  cpha: boolean;
  /** Most significant bit first (default). */
  msbFirst?: boolean;
  /** Bits per word (default 8). */
  bits?: number;
}

/**
 * SPI words: MOSI (and MISO) sampled on SCK's sampling edges — the
 * leading edge (leaving CPOL) for CPHA 0, the trailing one for CPHA 1.
 * With a CS line, only while it is low, and a word starts over when it
 * falls; without one, a pause of more than 8 clock periods starts a new
 * word.
 */
export function decodeSpi(sck: Line, mosi: Line, miso: Line | null, cs: Line | null, o: SpiOptions): Annotation[] {
  const n = o.bits ?? 8;
  const msb = o.msbFirst ?? true;
  const sampleLevel = o.cpha ? o.cpol : !o.cpol;
  const out: Annotation[] = [];
  let mo: boolean[] = [];
  let mi: boolean[] = [];
  let first = 0;
  let last = NaN;
  let period = NaN;
  const csEdges = cs ? cs.edges : [];
  let ci = 0;
  let selected = cs ? !cs.level0 : true;
  let prev = sck.level0;
  const word = (bits: boolean[]) =>
    (msb ? bits : [...bits].reverse()).reduce((a, x) => (a << 1) | (x ? 1 : 0), 0);
  for (const [t, l] of sck.edges) {
    while (ci < csEdges.length && csEdges[ci][0] <= t) {
      selected = !csEdges[ci][1];
      // CS moved: a word in progress is dropped.
      mo = [];
      mi = [];
      ci++;
    }
    if (l === prev) continue;
    prev = l;
    if (l !== sampleLevel || !selected) continue;
    if (!cs && mo.length > 0 && !Number.isNaN(period) && t - last > 8 * period) {
      mo = [];
      mi = [];
    }
    if (!Number.isNaN(last) && mo.length > 0) period = t - last;
    if (mo.length === 0) first = t;
    last = t;
    mo.push(levelAt(mosi, t));
    if (miso) mi.push(levelAt(miso, t));
    if (mo.length === n) {
      const half = Number.isNaN(period) ? 0 : period / 2;
      out.push({
        start: first - half,
        end: t + half,
        kind: "data",
        value: word(mo),
        ...(miso ? { miso: word(mi) } : {}),
      });
      mo = [];
      mi = [];
    }
  }
  return out;
}

export type Format = "hex" | "ascii";

/** A byte as hex (`0x41`) or ASCII (`A`, escapes for the rest). */
export function fmtByte(v: number, f: Format): string {
  if (f === "ascii" && v < 256) {
    if (v >= 0x20 && v < 0x7f) return String.fromCharCode(v);
    const esc: Record<number, string> = { 10: "\\n", 13: "\\r", 9: "\\t", 0: "\\0" };
    if (esc[v]) return esc[v];
  }
  return "0x" + v.toString(16).toUpperCase().padStart(v > 0xff ? 4 : 2, "0");
}

/** Text of an annotation's box. */
export function annotationLabel(a: Annotation, f: Format): string {
  switch (a.kind) {
    case "start":
      return "S";
    case "restart":
      return "Sr";
    case "stop":
      return "P";
    case "address":
      return `${fmtByte(a.addr!, "hex")} ${a.rw} ${a.ack ? "ACK" : "NACK"}`;
    default: {
      let s = fmtByte(a.value!, f);
      if (a.miso !== undefined) s += ` / ${fmtByte(a.miso, f)}`;
      if (a.ack !== undefined) s += a.ack ? " A" : " N";
      if (a.error && a.error !== "NACK") s += ` (${a.error})`;
      return s;
    }
  }
}
