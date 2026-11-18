// Resistor values: parsing, display, E-series and the colour code
// (IEC 60062:2016) with 3, 4, 5 and 6 bands.
// Parsing accepts the same notations as `simucleo_circuit::sim::parse_ohms`:
// 220, 4.7k, 4k7, 1M, 2M2, 4R7, "10 kΩ", "330 ohm".

const MULT: Record<string, number> = { R: 1, r: 1, k: 1e3, K: 1e3, M: 1e6, m: 1e6 };

export function parseOhms(v: string | number | undefined): number | null {
  if (typeof v === "number") return v > 0 && Number.isFinite(v) ? v : null;
  if (!v) return null;
  const s = v.replace(/\s+/g, "").replace(/(Ω|ohms?)$/i, "");
  // 4k7, 2M2, 4R7: the letter is the decimal point.
  let m = /^(\d+)([RrKkMm])(\d+)$/.exec(s);
  if (m) return Number(`${m[1]}.${m[3]}`) * MULT[m[2]];
  m = /^(\d+(?:\.\d+)?|\.\d+)([RrKkMm]?)$/.exec(s);
  if (!m) return null;
  const r = Number(m[1]) * (m[2] ? MULT[m[2]] : 1);
  return r > 0 && Number.isFinite(r) ? r : null;
}

export function formatOhms(r: number): string {
  const [v, unit] = r >= 1e9 ? [r / 1e9, "G"] : r >= 1e6 ? [r / 1e6, "M"] : r >= 1e3 ? [r / 1e3, "k"] : [r, ""];
  return `${Number(v.toPrecision(4))} ${unit}Ω`;
}

/** Digit colours 0–9. */
export const DIGIT_COLORS = ["black", "brown", "red", "orange", "yellow", "green", "blue", "violet", "grey", "white"];

/** Multiplier band: colour for 10^exp, exp = −3 … 9. */
const MULTIPLIER: Record<number, string> = {
  [-3]: "pink",
  [-2]: "silver",
  [-1]: "gold",
  ...Object.fromEntries(DIGIT_COLORS.map((c, i) => [i, c])),
};

/** Tolerance band (IEC 60062:2016). "20%" has no band. */
export const TOLERANCE_COLORS: Record<string, string | null> = {
  "0.01%": "grey",
  "0.02%": "yellow",
  "0.05%": "orange",
  "0.1%": "violet",
  "0.25%": "blue",
  "0.5%": "green",
  "1%": "brown",
  "2%": "red",
  "5%": "gold",
  "10%": "silver",
  "20%": null,
};
export const TOLERANCES = Object.keys(TOLERANCE_COLORS);

/** Temperature coefficient band of 6-band resistors, ppm/K. */
export const TEMPCO_COLORS: Record<string, string> = {
  "250": "black",
  "100": "brown",
  "50": "red",
  "15": "orange",
  "25": "yellow",
  "20": "green",
  "10": "blue",
  "5": "violet",
  "1": "grey",
};
export const TEMPCOS = Object.keys(TEMPCO_COLORS);

export type BandCount = 3 | 4 | 5 | 6;

export interface ColorCode {
  /** Band colours from the left (value end) to the right. */
  colors: string[];
  /** Index of the first band after the gap (tolerance), or -1. */
  gapBefore: number;
  /** The value the bands actually encode. */
  coded: number;
  /** The value needed more significant digits than the bands have. */
  rounded: boolean;
  /** The value is outside what a multiplier band can express. */
  outOfRange: boolean;
}

/**
 * Colour code of a resistor: 3 bands = 2 digits + multiplier (±20 %, no
 * tolerance band); 4 = 2 digits + multiplier + tolerance; 5 = 3 digits +
 * multiplier + tolerance; 6 = 5 bands + temperature coefficient.
 */
export function colorCode(r: number, bands: BandCount = 4, tolerance = "5%", tempco = "100"): ColorCode {
  const sig = bands >= 5 ? 3 : 2;
  let exp = Math.floor(Math.log10(r)) - (sig - 1);
  let digits = Math.round(r / 10 ** exp);
  if (digits >= 10 ** sig) {
    digits = Math.round(digits / 10);
    exp += 1;
  }
  const outOfRange = exp < -3 || exp > 9;
  exp = Math.min(9, Math.max(-3, exp));
  const coded = digits * 10 ** exp;
  const digitColors = String(digits)
    .padStart(sig, "0")
    .split("")
    .map((d) => DIGIT_COLORS[Number(d)]);
  const colors = [...digitColors, MULTIPLIER[exp]];
  let gapBefore = -1;
  if (bands >= 4) {
    // A 4/5/6-band part always has a tolerance band; ±20 % is not one of
    // them, so fall back to the usual value for that band count.
    const tol = TOLERANCE_COLORS[tolerance] ?? (bands === 4 ? "gold" : "brown");
    gapBefore = colors.length;
    colors.push(tol);
  }
  if (bands === 6) colors.push(TEMPCO_COLORS[tempco] ?? "brown");
  return {
    colors,
    gapBefore,
    coded,
    rounded: Math.abs(coded - r) > r * 1e-9,
    outOfRange,
  };
}

/** Kept for callers that only need the 4-band colours. */
export function resistorBands(r: number): string[] {
  return colorCode(r, 4, "5%").colors;
}

// ------------------------------------------------------------- E series

const E24 = [10, 11, 12, 13, 15, 16, 18, 20, 22, 24, 27, 30, 33, 36, 39, 43, 47, 51, 56, 62, 68, 75, 82, 91];
const E12 = E24.filter((_, i) => i % 2 === 0);
const E6 = E24.filter((_, i) => i % 4 === 0);
const E96 = [
  100, 102, 105, 107, 110, 113, 115, 118, 121, 124, 127, 130, 133, 137, 140, 143, 147, 150, 154, 158, 162, 165, 169,
  174, 178, 182, 187, 191, 196, 200, 205, 210, 215, 221, 226, 232, 237, 243, 249, 255, 261, 267, 274, 280, 287, 294,
  301, 309, 316, 324, 332, 340, 348, 357, 365, 374, 383, 392, 402, 412, 422, 432, 442, 453, 464, 475, 487, 499, 511,
  523, 536, 549, 562, 576, 590, 604, 619, 634, 649, 665, 681, 698, 715, 732, 750, 768, 787, 806, 825, 845, 866, 887,
  909, 931, 953, 976,
];
const E48 = E96.filter((_, i) => i % 2 === 0);
const SERIES: [string, number[], number][] = [
  ["E6 (±20%)", E6, 2],
  ["E12 (±10%)", E12, 2],
  ["E24 (±5%)", E24, 2],
  ["E48 (±2%)", E48, 3],
  ["E96 (±1%)", E96, 3],
];

/** The coarsest E series that contains `r`, or null for a non-standard value. */
export function eSeries(r: number): string | null {
  for (const [name, values, sig] of SERIES) {
    const exp = Math.floor(Math.log10(r)) - (sig - 1);
    const m = r / 10 ** exp;
    if (Math.abs(m - Math.round(m)) < 1e-6 && values.includes(Math.round(m))) return name;
  }
  return null;
}
