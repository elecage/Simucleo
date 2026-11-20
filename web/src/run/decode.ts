// Protocol decoders for the waveform view (M22): UART, I2C and SPI, on the
// edges of captured (or live) digital channels. Pure functions over edge
// lists with times in ns, unit tested in test/decode.test.ts.
// M25: 1-Wire (DS18B20), TM1637 and WS2812 decoders, and matching decoded
// content for the content trigger.
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

export type AnnotationKind = "data" | "address" | "start" | "restart" | "stop" | "reset" | "triplet" | "pixel";

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
  /** What the byte means: a command's name, the digit shown, … */
  note?: string;
  /** 1-Wire reset: a device answered with a presence pulse. */
  presence?: boolean;
  /** 1-Wire SEARCH ROM: the ROM bit, its complement and the direction written. */
  bits?: [boolean, boolean, boolean];
  /** WS2812 pixel: place in the chain (absent before the first reset); `value` is 0xRRGGBB. */
  index?: number;
  /** TM1637 segment byte: the digit position it goes to. */
  digit?: number;
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
    case "reset":
      return a.presence === undefined ? "RESET" : a.presence ? "리셋·프레즌스" : "리셋 (응답 없음)";
    case "triplet": {
      const [b, c, d] = a.bits!.map((x) => (x ? 1 : 0));
      return `${a.index ?? ""}: ${b}${c}→${d}`;
    }
    case "pixel":
      return `#${a.index ?? "?"} ${fmtColor(a.value!)}`;
    default: {
      let s = fmtByte(a.value!, f);
      if (a.miso !== undefined) s += ` / ${fmtByte(a.miso, f)}`;
      if (a.ack !== undefined) s += a.ack ? " A" : " N";
      if (a.note) s += ` ${a.note}`;
      if (a.error && a.error !== "NACK") s += ` (${a.error})`;
      return s;
    }
  }
}

/** "#RRGGBB" of a colour 0xRRGGBB. */
export const fmtColor = (c: number) => "#" + c.toString(16).toUpperCase().padStart(6, "0");

// ------------------------------------------------------------- 1-Wire

/** ROM commands, the first byte after a reset. */
export const OW_ROM: Record<number, string> = {
  0x33: "READ ROM",
  0x55: "MATCH ROM",
  0xcc: "SKIP ROM",
  0xf0: "SEARCH ROM",
  0xec: "ALARM SEARCH",
};
/** DS18B20 function commands, after the ROM command. */
export const OW_FUNC: Record<number, string> = {
  0x44: "CONVERT T",
  0xbe: "READ SCRATCHPAD",
  0x4e: "WRITE SCRATCHPAD",
  0x48: "COPY SCRATCHPAD",
  0xb8: "RECALL E²",
  0xb4: "READ POWER SUPPLY",
};

const US = 1000;
/** 1-Wire timing (standard speed), ns. */
export const OW = {
  /** Shortest reset pulse the spec allows. */
  resetMin: 480 * US,
  /** Longer than this, a low pulse is a reset (a short one is flagged). */
  resetLike: 300 * US,
  /** Longest low of a time slot (write 0). */
  slotMax: 120 * US,
  /** The bit is sampled here: low past it is a 0. */
  sample: 15 * US,
  /** Shortest time slot (fall to fall). */
  slotMin: 60 * US,
  /** Presence pulse: starts 15–60 µs after the reset, lasts 60–240 µs. */
  presenceWait: 80 * US,
  presenceMin: 60 * US,
  presenceMax: 240 * US,
};

const ROM_BYTES = ["ROM 계열", "ROM 일련번호 1", "ROM 일련번호 2", "ROM 일련번호 3", "ROM 일련번호 4", "ROM 일련번호 5", "ROM 일련번호 6", "ROM CRC"];

/**
 * 1-Wire on its data line (idle high): every low pulse is a reset (with
 * the presence pulse a device answers with), or a time slot whose bit is
 * read from the low time — past 15 µs a 0 (a write 0, or a device holding
 * the line for a read 0), else a 1. Bits make bytes LSB first, counted
 * from the reset: the ROM command, its ROM code (MATCH, READ ROM) or the
 * 64 SEARCH ROM triplets (bit, complement, direction), then the function
 * command and its data. Low pulses of the wrong length, slots too close
 * together, a reset without presence and a byte cut short are errors.
 * Pulses that end after `to` are left out.
 */
export function decodeOneWire(line: Line, to = Infinity): Annotation[] {
  const out: Annotation[] = [];
  /** Low pulses: [fall, rise]. */
  const lows: [number, number][] = [];
  let level = line.level0;
  let fall = NaN;
  for (const [t, l] of line.edges) {
    if (l === level) continue;
    level = l;
    if (!l) fall = t;
    else if (!Number.isNaN(fall)) {
      if (t > to) break;
      lows.push([fall, t]);
      fall = NaN;
    }
  }
  type Phase = "none" | "rom" | "romcode" | "search" | "func" | "data";
  let phase: Phase = "none";
  let count = 0; // bytes (or triplets) left in the phase
  let dataName = ""; // what the data bytes are
  let dataIdx = 0;
  let bits: boolean[] = [];
  let bitErr: string | undefined;
  let byteStart = 0;
  let lastFall = NaN;
  const flushPartial = (end: number) => {
    if (bits.length > 0) {
      out.push({ start: byteStart, end, kind: "data", value: 0, error: `바이트가 끝나지 않음 (${bits.length}비트)` });
    }
    bits = [];
    bitErr = undefined;
  };
  for (let i = 0; i < lows.length; i++) {
    const [f, r] = lows[i];
    const w = r - f;
    if (w >= OW.resetLike) {
      flushPartial(f);
      // Presence: the next low pulse, soon after the reset.
      const next = lows[i + 1];
      const presence =
        next !== undefined &&
        next[0] - r <= OW.presenceWait &&
        next[1] - next[0] >= OW.presenceMin / 2 &&
        next[1] - next[0] <= 2 * OW.presenceMax;
      let end = r;
      let error: string | undefined;
      if (w < OW.resetMin) error = `리셋 펄스가 짧음 (${(w / US).toFixed(0)} µs < 480 µs)`;
      if (presence) {
        i++;
        end = next[1];
        const pw = next[1] - next[0];
        if (!error && (pw < OW.presenceMin || pw > OW.presenceMax))
          error = `프레즌스 폭 ${(pw / US).toFixed(0)} µs (60–240 µs 밖)`;
      } else if (!error) error = "프레즌스 없음";
      out.push({ start: f, end, kind: "reset", presence, ...(error ? { error } : {}) });
      phase = "rom";
      lastFall = NaN;
      continue;
    }
    // A time slot.
    let err: string | undefined;
    if (w > OW.slotMax) err = `Low ${(w / US).toFixed(0)} µs: 슬롯(최대 120 µs)도 리셋(480 µs)도 아님`;
    else if (!Number.isNaN(lastFall) && f - lastFall < OW.slotMin)
      err = `슬롯 간격 ${((f - lastFall) / US).toFixed(1)} µs < 60 µs`;
    lastFall = f;
    if (bits.length === 0) byteStart = f;
    bits.push(w < OW.sample);
    bitErr ??= err;
    const slotEnd = f + Math.max(OW.slotMin, w);
    if (phase === "search") {
      if (bits.length < 3) continue;
      const [b, c, d] = bits as [boolean, boolean, boolean];
      const error = bitErr ?? (b && c ? "응답하는 장치 없음 (1·1)" : undefined);
      out.push({ start: byteStart, end: slotEnd, kind: "triplet", bits: [b, c, d], index: 64 - count, ...(error ? { error } : {}) });
      bits = [];
      bitErr = undefined;
      if (--count === 0) phase = "func";
      continue;
    }
    if (bits.length < 8) continue;
    const value = bits.reduce((a, x, k) => a | ((x ? 1 : 0) << k), 0);
    let note: string | undefined;
    switch (phase) {
      case "rom":
        note = OW_ROM[value];
        if (!note) {
          note = "알 수 없는 ROM 명령";
          phase = "data";
          dataName = "";
        } else if (value === 0x33 || value === 0x55) {
          phase = "romcode";
          count = 8;
        } else if (value === 0xf0 || value === 0xec) {
          phase = "search";
          count = 64;
        } else phase = "func";
        break;
      case "romcode":
        note = ROM_BYTES[8 - count];
        if (--count === 0) phase = "func";
        break;
      case "func":
        note = OW_FUNC[value] ?? "알 수 없는 기능 명령";
        phase = "data";
        dataName = value === 0xbe ? "스크래치패드" : value === 0x4e ? "쓰기" : "";
        dataIdx = 0;
        break;
      case "data":
        if (dataName) note = `${dataName} ${dataIdx}`;
        dataIdx++;
        break;
      default:
        break;
    }
    out.push({ start: byteStart, end: slotEnd, kind: "data", value, ...(note ? { note } : {}), ...(bitErr ? { error: bitErr } : {}) });
    bits = [];
    bitErr = undefined;
  }
  return out;
}

// ------------------------------------------------------------- TM1637

/** Segments (a = bit 0 … g = bit 6) of the characters a 7-segment shows. */
const SEGMENT_CHARS: Record<number, string> = {
  0x3f: "0", 0x06: "1", 0x5b: "2", 0x4f: "3", 0x66: "4", 0x6d: "5", 0x7d: "6", 0x07: "7", 0x27: "7",
  0x7f: "8", 0x6f: "9", 0x67: "9", 0x77: "A", 0x7c: "b", 0x39: "C", 0x58: "c", 0x5e: "d", 0x79: "E",
  0x71: "F", 0x3d: "G", 0x76: "H", 0x74: "h", 0x30: "I", 0x1e: "J", 0x38: "L", 0x54: "n", 0x5c: "o",
  0x73: "P", 0x50: "r", 0x78: "t", 0x3e: "U", 0x1c: "u", 0x6e: "y", 0x40: "-", 0x08: "_", 0x00: " ",
};

/** The character a segment byte shows (bit 7, the colon or point, aside). */
export const segmentChar = (seg: number) => SEGMENT_CHARS[seg & 0x7f] ?? "?";

/** What a TM1637 command byte (the first after a START) means. */
export function tm1637Command(v: number): string | undefined {
  switch (v & 0xc0) {
    case 0x40:
      return `데이터 명령: ${v & 2 ? "키 읽기" : "쓰기"}, ${v & 4 ? "고정 주소" : "주소 자동 증가"}`;
    case 0x80:
      return v & 8 ? `표시 켜기, 밝기 ${v & 7}` : "표시 끄기";
    case 0xc0:
      return `주소 ${v & 0x0f}`;
    default:
      return undefined;
  }
}

/**
 * TM1637 on CLK and DIO: START (DIO falls while CLK is high), STOP (DIO
 * rises while CLK is high), bytes LSB first sampled on CLK's rising edges,
 * the ACK (DIO low) on the 9th. The first byte after a START is a command:
 * data (0x40 auto-increment, 0x44 fixed address), display control
 * (0x80–0x8F: on, brightness) or address (0xC0+), which the segment bytes
 * follow, each decoded to the character it shows. A NACK is an error.
 */
export function decodeTm1637(clk: Line, dio: Line): Annotation[] {
  const out: Annotation[] = [];
  let c = clk.level0;
  let d = dio.level0;
  let active = false;
  let first = false;
  let fixed = false;
  let addr = -1; // digit of the next segment byte (-1: none)
  let bits: boolean[] = [];
  let byteStart = 0;
  let lastFall = NaN;
  let lastRise = NaN;
  let period = NaN;
  for (const [t, which, l] of merge(clk, dio)) {
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
      if (bits.length < 9) continue;
      const value = bits.slice(0, 8).reduce((a, x, k) => a | ((x ? 1 : 0) << k), 0);
      const ack = !bits[8];
      const end = t + (Number.isNaN(period) ? t - byteStart : period / 2);
      const a: Annotation = { start: byteStart, end, kind: "data", value, ack };
      if (first) {
        first = false;
        const note = tm1637Command(value);
        if (note) a.note = note;
        else a.error = "알 수 없는 명령";
        if ((value & 0xc0) === 0x40) fixed = (value & 4) !== 0;
        addr = (value & 0xc0) === 0xc0 ? value & 0x0f : -1;
      } else if (addr >= 0) {
        a.digit = addr;
        a.note = `자리 ${addr}: ${segmentChar(value)}${value & 0x80 ? (addr === 1 ? " + 콜론" : " + 점") : ""}`;
        if (!fixed) addr++;
      }
      if (!ack) a.error = "NACK";
      out.push(a);
      bits = [];
    } else {
      if (l === d) continue;
      d = l;
      if (!c) continue;
      if (!d) {
        out.push({ start: t, end: t, kind: "start" });
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

/**
 * What the display shows after the last complete write of digits 0–3:
 * the four segment bytes and their text ("12:34", the colon from bit 7
 * of digit 1).
 */
export function tm1637Display(anns: Annotation[]): { segments: number[]; text: string } | null {
  const segs: (number | undefined)[] = [];
  let shown: { segments: number[]; text: string } | null = null;
  for (const a of anns) {
    if (a.kind === "data" && a.digit !== undefined && a.ack) segs[a.digit] = a.value;
    if (a.kind === "stop" && [0, 1, 2, 3].every((k) => segs[k] !== undefined)) {
      const s = segs.slice(0, 4) as number[];
      const ch = s.map(segmentChar);
      shown = { segments: s, text: `${ch[0]}${ch[1]}${s[1] & 0x80 ? ":" : " "}${ch[2]}${ch[3]}` };
    }
  }
  return shown;
}

// ------------------------------------------------------------- WS2812

/** WS2812 timing, ns. */
export const WS = {
  t0h: 400,
  t1h: 800,
  tolerance: 150,
  /** Low this long latches the colours: the next bit starts a new frame. */
  reset: 50_000,
  bit: 1250,
};

/**
 * WS2812 (NeoPixel) on DIN: each bit a high pulse, 0.4 µs for a 0 and
 * 0.8 µs for a 1 (±150 ns, else an error), 24 bits per pixel in G, R, B
 * order (most significant first), a low of 50 µs or more (a reset)
 * between frames. Pixels are numbered from the reset; before the first one
 * (unless the line was already low for 50 µs at `from`) the index is not
 * known. Pulses after `to` are left out; a reset at the end of the span is
 * reported when the span is known to be low for 50 µs.
 */
export function decodeWs2812(line: Line, from?: number, to = Infinity): Annotation[] {
  const out: Annotation[] = [];
  let level = line.level0;
  let rise = NaN;
  let lastFall = !line.level0 && from !== undefined ? from : NaN;
  /** The low before the next rise started at `from` (or earlier): no reset box. */
  let fromWindow = !Number.isNaN(lastFall);
  let index: number | undefined;
  let bits: boolean[] = [];
  let err: string | undefined;
  let pixStart = 0;
  let lastRise = NaN;
  const flush = (end: number) => {
    if (bits.length > 0)
      out.push({
        start: pixStart,
        end,
        kind: "pixel",
        value: 0,
        ...(index !== undefined ? { index } : {}),
        error: `픽셀이 끝나지 않음 (${bits.length}비트)`,
      });
    bits = [];
    err = undefined;
  };
  for (const [t, l] of line.edges) {
    if (l === level) continue;
    if (t > to) break;
    level = l;
    if (l) {
      if (!Number.isNaN(lastFall) && t - lastFall >= WS.reset) {
        flush(lastFall);
        if (!fromWindow) out.push({ start: lastFall, end: t, kind: "reset" });
        index = 0;
      }
      fromWindow = false;
      rise = t;
      continue;
    }
    lastFall = t;
    if (Number.isNaN(rise)) continue;
    const h = t - rise;
    const one = h > (WS.t0h + WS.t1h) / 2;
    if (Math.abs(h - (one ? WS.t1h : WS.t0h)) > WS.tolerance) err ??= `비트 High ${Math.round(h)} ns (0.4/0.8 µs ±150 ns 밖)`;
    if (bits.length === 0) pixStart = rise;
    const period = Number.isNaN(lastRise) || rise - lastRise > 4 * WS.bit ? WS.bit : rise - lastRise;
    lastRise = rise;
    bits.push(one);
    rise = NaN;
    if (bits.length < 24) continue;
    const grb = bits.reduce((a, x) => a * 2 + (x ? 1 : 0), 0);
    const value = (((grb >> 8) & 0xff) << 16) | (((grb >> 16) & 0xff) << 8) | (grb & 0xff);
    out.push({
      start: pixStart,
      end: lastRise + period,
      kind: "pixel",
      value,
      ...(index !== undefined ? { index } : {}),
      ...(err ? { error: err } : {}),
    });
    if (index !== undefined) index++;
    bits = [];
    err = undefined;
  }
  // The span ends low after a whole reset time.
  if (!level && !Number.isNaN(lastFall) && !fromWindow && Number.isFinite(to) && to - lastFall >= WS.reset) {
    flush(lastFall);
    out.push({ start: lastFall, end: to, kind: "reset" });
  }
  return out;
}

/**
 * The colours (0xRRGGBB) of the last whole frame: pixels numbered from 0
 * (after a reset, or a window that starts in the idle low) up to the reset
 * that latches them, none in error. Null when no frame is latched yet.
 */
export function ws2812Frame(anns: Annotation[]): number[] | null {
  let cur: number[] | null = null;
  let last: number[] | null = null;
  for (const a of anns) {
    if (a.kind === "reset") {
      if (cur?.length) last = cur;
      cur = null;
    } else if (a.kind === "pixel") {
      if (a.index === 0 && !a.error) cur = [];
      if (cur && !a.error && a.index === cur.length) cur.push(a.value!);
      else cur = null;
    }
  }
  return last;
}

// ---------------------------------------------------- content trigger

/**
 * What a content trigger looks for in a decoder's items: a byte (UART,
 * SPI MOSI or MISO, 1-Wire, TM1637), UART text, an I2C address with
 * R/W, or a WS2812 pixel by index (and colour).
 */
export type ContentMatch =
  | { kind: "byte"; value: number }
  | { kind: "text"; text: string }
  | { kind: "address"; addr: number; rw: "R" | "W" | "any" }
  | { kind: "pixel"; index: number; color?: number };

/**
 * Start times of the matches in `anns` (for a text, the start of its
 * first byte) that are later than `after`.
 */
export function findMatches(anns: Annotation[], m: ContentMatch, after = -Infinity): number[] {
  const out: number[] = [];
  if (m.kind === "text") {
    if (!m.text) return out;
    const chars = anns.filter((a) => a.kind === "data" && !a.error && a.value !== undefined);
    const text = chars.map((a) => String.fromCharCode(a.value!)).join("");
    for (let i = text.indexOf(m.text); i >= 0; i = text.indexOf(m.text, i + 1)) {
      if (chars[i].start > after) out.push(chars[i].start);
    }
    return out;
  }
  for (const a of anns) {
    if (a.start <= after) continue;
    let hit = false;
    if (m.kind === "byte") hit = a.kind === "data" && !a.error?.startsWith("바이트가") && (a.value === m.value || a.miso === m.value);
    else if (m.kind === "address") hit = a.kind === "address" && a.addr === m.addr && (m.rw === "any" || a.rw === m.rw);
    else hit = a.kind === "pixel" && a.index === m.index && !a.error?.startsWith("픽셀이") && (m.color === undefined || a.value === m.color);
    if (hit) out.push(a.start);
  }
  return out;
}

/** A number typed as hex (`0x41`, `41h`, `#FF8000`), decimal, or a quoted character (`'A'`). */
export function parseNumber(s: string): number | null {
  const t = s.trim();
  let m = /^'(.)'$/u.exec(t);
  if (m) return m[1].codePointAt(0)!;
  m = /^(?:0x|#)([0-9a-f]+)$/i.exec(t) ?? /^([0-9a-f]+)h$/i.exec(t);
  if (m) return parseInt(m[1], 16);
  if (/^\d+$/.test(t)) return Number(t);
  return null;
}

/** Where a live content trigger stands (ns, the stream's own clock). */
export interface ScanState {
  /** Only matches starting after this count (the arming time, then the end
   * of the last capture's window). */
  checked: number;
  /** Decoding starts here: a point the protocol can be picked up from. */
  anchor: number;
}

/**
 * The items a decoder can start from without what came before: a UART
 * frame, an SPI word, an I2C or TM1637 START, a 1-Wire or WS2812 reset.
 */
export function isSyncPoint(a: Annotation, type: string): boolean {
  if (type === "uart" || type === "spi") return a.kind === "data";
  return a.kind === "start" || a.kind === "restart" || a.kind === "reset";
}

/**
 * One step of the live content trigger: decode the stream over
 * [anchor, now] (`decode(from, to)`, no more than `maxSpan` back) and
 * return the matches that start after `checked`. Items not complete by
 * `now` are not decoded yet: they match in a later step, because the next
 * anchor is the last sync point (see `isSyncPoint`) before them — for a
 * text, the one that many frames back, so a text split over two steps is
 * still found. `checked` moves to the last match.
 */
export function scanStep(
  decode: (from: number, to: number) => Annotation[],
  type: string,
  m: ContentMatch,
  st: ScanState,
  now: number,
  maxSpan: number,
): { hits: number[]; state: ScanState } {
  const from = Math.max(st.anchor, now - maxSpan);
  const anns = decode(from, now);
  const hits = findMatches(anns, m, st.checked);
  let keep = m.kind === "text" ? m.text.length : 1;
  let anchor = from;
  for (let i = anns.length - 1; i >= 0; i--) {
    if (isSyncPoint(anns[i], type) && --keep === 0) {
      anchor = anns[i].start - 1;
      break;
    }
  }
  return { hits, state: { checked: hits.length ? hits[hits.length - 1] : st.checked, anchor: Math.max(anchor, from) } };
}
