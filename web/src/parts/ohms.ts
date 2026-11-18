// Resistor values: parsing, display and the 4-band colour code.
// Accepts the same notations as `simucleo_circuit::sim::parse_ohms`:
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
  const [v, unit] = r >= 1e6 ? [r / 1e6, "M"] : r >= 1e3 ? [r / 1e3, "k"] : [r, ""];
  return `${Number(v.toPrecision(3))} ${unit}Ω`;
}

export const BAND_COLORS = ["black", "brown", "red", "orange", "yellow", "green", "blue", "violet", "grey", "white"];

/** Colours of a 4-band resistor (two digits, multiplier, gold tolerance).
 * Values with more precision are rounded to two significant digits. */
export function resistorBands(r: number): string[] {
  let exp = Math.floor(Math.log10(r)) - 1;
  let digits = Math.round(r / 10 ** exp);
  if (digits >= 100) {
    digits = Math.round(digits / 10);
    exp += 1;
  }
  const mult = exp === -1 ? "gold" : exp === -2 ? "silver" : BAND_COLORS[Math.min(9, Math.max(0, exp))];
  return [BAND_COLORS[Math.floor(digits / 10)], BAND_COLORS[digits % 10], mult, "gold"];
}
