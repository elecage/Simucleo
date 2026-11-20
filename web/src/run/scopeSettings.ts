// Waveform view settings kept in the project file (M25): probed pins,
// analog channels, decoders, trigger (with a content trigger) and
// timebase. Pure functions, unit tested in test/m25.test.ts.
import { parseNumber, type ContentMatch, type Format, type Parity } from "./decode.ts";
import { TIMEBASE_NS } from "./scope.ts";

export type DecoderType = "uart" | "i2c" | "spi" | "onewire" | "tm1637" | "ws2812" | "nec";

export const DECODER_TYPES: DecoderType[] = ["uart", "i2c", "spi", "onewire", "tm1637", "ws2812", "nec"];

export interface DecoderCfg {
  /** Numbers the decoder within the view (a content trigger names it). */
  id: number;
  type: DecoderType;
  /** UART: [line]; I2C: [SCL, SDA]; SPI: [SCK, MOSI, MISO, CS] ("" = none);
   * 1-Wire: [DQ]; TM1637: [CLK, DIO]; WS2812: [DIN]; NEC: [OUT] (the IR receiver's). */
  pins: string[];
  baud: number;
  parity: Parity;
  /** SPI mode 0–3 (CPOL·2 + CPHA) and bit order. */
  mode: number;
  lsbFirst: boolean;
}

/** Default pins of a new decoder (the examples' wiring). */
export const DECODER_PINS: Record<DecoderType, string[]> = {
  uart: ["PA2"],
  i2c: ["PB8", "PB9"],
  spi: ["PA5", "PA7", "PA6", ""],
  onewire: ["PA10"],
  tm1637: ["PA10", "PB3"],
  ws2812: ["PB4"],
  nec: ["PB3"],
};
export const PIN_ROLES: Record<DecoderType, string[]> = {
  uart: ["TX/RX"],
  i2c: ["SCL", "SDA"],
  spi: ["SCK", "MOSI", "MISO", "CS"],
  onewire: ["DQ"],
  tm1637: ["CLK", "DIO"],
  ws2812: ["DIN"],
  nec: ["OUT"],
};
export const DECODER_NAMES: Record<DecoderType, string> = {
  uart: "UART",
  i2c: "I2C",
  spi: "SPI",
  onewire: "1-Wire",
  tm1637: "TM1637",
  ws2812: "WS2812",
  nec: "IR (NEC)",
};

export interface AnalogCfg {
  /** "PA1" or "part.pin". */
  spec: string;
  vdiv: number;
  /** Volts at the row's middle. */
  offset: number;
}

/** A content trigger's condition, as typed (see `contentMatch`). */
export interface ContentCfg {
  kind: ContentMatch["kind"];
  /** The byte, the I2C address, or the text. */
  text: string;
  rw: "R" | "W" | "any";
  /** WS2812 pixel index and (optional) colour "#RRGGBB". */
  index: number;
  color: string;
  /** NEC: the address ("" = any; the command is `text`). */
  addr: string;
}

export interface TriggerSettings {
  /** A probed pin, an analog channel "V(…)", or a decoder "dec:<id>" (content trigger). */
  source: string;
  edge: "rising" | "falling" | "either";
  mode: "auto" | "normal" | "single";
  pre: number;
  widthCmp: "off" | "lt" | "gt";
  widthUs: number;
  pause: boolean;
  level: number;
  hysteresis: number;
  content: ContentCfg;
}

export interface ScopeSettings {
  pins: string[];
  analog: AnalogCfg[];
  decoders: DecoderCfg[];
  fmt: Format;
  /** Time per division (ns). */
  divNs: number;
  trigger: TriggerSettings;
}

export const DEFAULT_CONTENT: ContentCfg = { kind: "byte", text: "0x41", rw: "any", index: 0, color: "", addr: "" };

export function defaultScope(): ScopeSettings {
  return {
    pins: ["PA5"],
    analog: [],
    decoders: [],
    fmt: "hex",
    divNs: 2e6,
    trigger: {
      source: "PA5",
      edge: "rising",
      mode: "auto",
      pre: 0.5,
      widthCmp: "off",
      widthUs: 10,
      pause: false,
      level: 1.65,
      hysteresis: 0.1,
      content: { ...DEFAULT_CONTENT },
    },
  };
}

/** A new decoder of `type` with its default pins and settings. */
export function newDecoder(id: number, type: DecoderType): DecoderCfg {
  return { id, type, pins: [...DECODER_PINS[type]], baud: 115200, parity: "none", mode: 0, lsbFirst: false };
}

/** The content kinds a decoder offers. */
export function contentKinds(type: DecoderType): ContentMatch["kind"][] {
  switch (type) {
    case "uart":
      return ["byte", "text"];
    case "i2c":
      return ["address", "byte"];
    case "ws2812":
      return ["pixel"];
    case "nec":
      return ["nec"];
    default:
      return ["byte"];
  }
}

/** The condition to look for, or null while it does not parse. */
export function contentMatch(c: ContentCfg, type: DecoderType): ContentMatch | null {
  const kind = contentKinds(type).includes(c.kind) ? c.kind : contentKinds(type)[0];
  switch (kind) {
    case "text":
      return c.text ? { kind, text: c.text.replace(/\\r/g, "\r").replace(/\\n/g, "\n") } : null;
    case "byte": {
      const v = parseNumber(c.text);
      return v === null || v > 0xffff ? null : { kind, value: v };
    }
    case "address": {
      const v = parseNumber(c.text);
      return v === null || v > 0x7f ? null : { kind, addr: v, rw: c.rw };
    }
    case "pixel": {
      if (!Number.isInteger(c.index) || c.index < 0) return null;
      if (!c.color.trim()) return { kind, index: c.index };
      const v = parseNumber(c.color.trim().startsWith("#") ? c.color : `#${c.color.trim()}`);
      return v === null || v > 0xffffff ? null : { kind, index: c.index, color: v };
    }
    case "nec": {
      const cmd = parseNumber(c.text);
      if (cmd === null || cmd > 0xff) return null;
      if (!c.addr.trim()) return { kind, cmd };
      const addr = parseNumber(c.addr);
      return addr === null || addr > 0xff ? null : { kind, cmd, addr };
    }
  }
}

/**
 * Whether the simulator's trigger engine can look for `m` in decoder
 * `type` (M26: it has the same decoders, taking every edge as it is
 * simulated); otherwise the view decodes the live stream itself (M25).
 */
export function exactContent(type: DecoderType, m: ContentMatch): boolean {
  return contentKinds(type).includes(m.kind);
}

// ----------------------------------------------------------- loading

const PIN = /^P[A-H]\d{1,2}$/;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const num = (x: unknown, d: number, ok: (v: number) => boolean = () => true) =>
  typeof x === "number" && Number.isFinite(x) && ok(x) ? x : d;
const pick = <T extends string>(x: unknown, options: readonly T[], d: T): T =>
  options.includes(x as T) ? (x as T) : d;
const str = (x: unknown, d: string) => (typeof x === "string" ? x : d);

/**
 * Settings read from a project file: anything missing or malformed gets
 * its default, unknown decoders and pins are dropped. Undefined when the
 * file has none (an older project).
 */
export function sanitizeScope(raw: unknown): ScopeSettings | undefined {
  if (!isObj(raw)) return undefined;
  const d = defaultScope();
  const pins = Array.isArray(raw.pins) ? [...new Set(raw.pins.filter((p): p is string => typeof p === "string" && PIN.test(p)))] : d.pins;
  const analog: AnalogCfg[] = [];
  for (const a of Array.isArray(raw.analog) ? raw.analog : []) {
    if (!isObj(a) || typeof a.spec !== "string" || !a.spec || analog.some((q) => q.spec === a.spec)) continue;
    analog.push({ spec: a.spec, vdiv: num(a.vdiv, 1, (v) => v > 0), offset: num(a.offset, 1.65) });
  }
  const decoders: DecoderCfg[] = [];
  for (const x of Array.isArray(raw.decoders) ? raw.decoders : []) {
    if (!isObj(x) || !DECODER_TYPES.includes(x.type as DecoderType)) continue;
    const type = x.type as DecoderType;
    const n = DECODER_PINS[type].length;
    const given = Array.isArray(x.pins) ? x.pins : [];
    const dp = Array.from({ length: n }, (_, k) => {
      const p = given[k];
      return typeof p === "string" && (PIN.test(p) || (p === "" && k >= 2)) ? p : DECODER_PINS[type][k];
    });
    let id = num(x.id, 0, (v) => Number.isInteger(v) && v > 0);
    if (!id || decoders.some((q) => q.id === id)) id = Math.max(0, ...decoders.map((q) => q.id)) + 1;
    decoders.push({
      id,
      type,
      pins: dp,
      baud: num(x.baud, 115200, (v) => v > 0),
      parity: pick(x.parity, ["none", "even", "odd"] as const, "none"),
      mode: num(x.mode, 0, (v) => [0, 1, 2, 3].includes(v)),
      lsbFirst: x.lsbFirst === true,
    });
  }
  const t = isObj(raw.trigger) ? raw.trigger : {};
  const c = isObj(t.content) ? t.content : {};
  const content: ContentCfg = {
    kind: pick(c.kind, ["byte", "text", "address", "pixel", "nec"] as const, DEFAULT_CONTENT.kind),
    text: str(c.text, DEFAULT_CONTENT.text),
    rw: pick(c.rw, ["R", "W", "any"] as const, "any"),
    index: num(c.index, 0, (v) => Number.isInteger(v) && v >= 0),
    color: str(c.color, ""),
    addr: str(c.addr, ""),
  };
  return {
    pins,
    analog,
    decoders,
    fmt: pick(raw.fmt, ["hex", "ascii"] as const, d.fmt),
    divNs: num(raw.divNs, d.divNs, (v) => TIMEBASE_NS.includes(v)),
    trigger: {
      source: str(t.source, pins[0] ?? d.trigger.source),
      edge: pick(t.edge, ["rising", "falling", "either"] as const, d.trigger.edge),
      mode: pick(t.mode, ["auto", "normal", "single"] as const, d.trigger.mode),
      pre: num(t.pre, d.trigger.pre, (v) => v >= 0.1 && v <= 0.9),
      widthCmp: pick(t.widthCmp, ["off", "lt", "gt"] as const, "off"),
      widthUs: num(t.widthUs, d.trigger.widthUs, (v) => v > 0),
      pause: t.pause === true,
      level: num(t.level, d.trigger.level),
      hysteresis: num(t.hysteresis, d.trigger.hysteresis, (v) => v >= 0),
      content,
    },
  };
}
