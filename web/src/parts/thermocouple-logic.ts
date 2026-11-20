// M35: what the thermocouple modules' words mean, and the probe's controls
// (a lighter, ice water, unplugging it). The chips themselves are modelled
// in `simucleo_circuit::thermocouple`; the part shows the word the next
// read gives (`visual.text`, hex).
import type { PartControl } from "./types";

const num = (v: string | number | undefined, d = 0) => {
  const x = Number(v);
  return Number.isFinite(x) && v !== "" && v !== undefined ? x : d;
};

export interface TcReading {
  /** Hot junction (°C) as the chip reports it; null with a fault. */
  hot: number | null;
  /** MAX31855: its cold junction (°C). */
  cold?: number;
  /** "OPEN" (MAX6675 D2), "OC", "SCG", "SCV" (MAX31855 D0–D2). */
  faults: string[];
}

/** MAX6675: D14–D3 temperature (0.25 °C), D2 thermocouple open. */
export function decodeMax6675(word: number): TcReading {
  if (word & 4) return { hot: null, faults: ["OPEN"] };
  return { hot: ((word >> 3) & 0xfff) * 0.25, faults: [] };
}

/** MAX31855: D31–D18 hot (signed, 0.25 °C), D16 fault, D15–D4 cold
 * (signed, 0.0625 °C), D2 SCV, D1 SCG, D0 OC. */
export function decodeMax31855(word: number): TcReading {
  const cold = ((word << 16) >> 20) * 0.0625;
  const faults = ["OC", "SCG", "SCV"].filter((_, i) => word & (1 << i));
  if (word & 0x10000) return { hot: null, cold, faults };
  return { hot: (word >> 18) * 0.25, cold, faults };
}

/** The word in `visual.text` (hex), decoded for `kind`. */
export function readingOf(kind: string, text: string | undefined): TcReading | null {
  if (!text || !/^[0-9A-F]+$/i.test(text)) return null;
  const w = parseInt(text, 16) | 0;
  return kind === "max6675" ? decodeMax6675(w) : decodeMax31855(w);
}

/** A press shorter than this (ms) does not heat or cool the probe. */
const TOUCH_DELAY = 150;

/**
 * Hold the probe in something at `target` °C (a lighter's flame, ice
 * water): `temp` heads there with a first-order lag `tauIn` (s); released,
 * it relaxes back to the room (`ambient`) with `tauOut`. Moving the slider
 * meanwhile stops it.
 */
export function exposure(target: number, tauIn: number, tauOut: number, hint: string): PartControl {
  return {
    hint,
    holdOnly: true,
    start(p, props) {
      let cur = num(props.temp, 25);
      let written = cur;
      let last = p.t;
      return {
        tick(t, held, now) {
          if (Math.abs(num(now.temp, 25) - written) > 1e-6) return { done: true };
          const dt = Math.max(0, t - last) / 1000;
          last = t;
          if (held && t - p.t < TOUCH_DELAY) return {};
          const room = num(now.ambient, 25);
          const goal = held ? target : room;
          cur += (goal - cur) * (1 - Math.exp(-dt / (held ? tauIn : tauOut)));
          const settled = !held && Math.abs(cur - room) < 0.3;
          const out = settled ? room : Math.round(cur * 4) / 4;
          const changed = out !== written;
          written = out;
          return { set: changed ? { temp: out } : undefined, done: settled };
        },
      };
    },
  };
}

/** A click flips `prop` between 0 and 1 (the probe's plug). */
export function toggle(prop: string, hint: string): PartControl {
  return {
    hint,
    start(_p, props) {
      return { set: { [prop]: num(props[prop]) ? 0 : 1 } };
    },
  };
}
