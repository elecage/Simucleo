// Capture export (M22): CSV (one row per change, every channel) and VCD
// (value change dump, for GTKWave or PulseView). Pure functions, unit
// tested in test/decode.test.ts.
import type { ScopeCapture } from "../sim/protocol.ts";

type Col =
  | { name: string; digital: true; v0: boolean; changes: [number, boolean][] }
  | { name: string; digital: false; v0: number; changes: [number, number][] };

function columns(c: ScopeCapture): Col[] {
  return [
    ...c.channels.map((ch) => ({ name: ch.name, digital: true as const, v0: ch.level0, changes: ch.edges })),
    ...(c.analog ?? []).map((a) => ({ name: a.name, digital: false as const, v0: a.v0, changes: a.samples })),
  ];
}

/** Volts with up to 4 decimals ("2.475", "0"). */
const volts = (v: number) => String(Number(v.toFixed(4)));
/** ns with up to 3 decimals. */
const ns = (t: number) => String(Number(t.toFixed(3)));

/**
 * CSV: `time_ns` (relative to the trigger) and one column per channel
 * (0/1, or volts), a row at the window's start and at every change.
 */
export function captureCsv(c: ScopeCapture): string {
  const cols = columns(c);
  const times = new Set<number>([c.startNs]);
  for (const col of cols) for (const [t] of col.changes) if (t >= c.startNs && t <= c.endNs) times.add(t);
  const sorted = [...times].sort((a, b) => a - b);
  const idx = cols.map(() => 0);
  const cur: (boolean | number)[] = cols.map((col) => col.v0);
  const lines = [["time_ns", ...cols.map((col) => col.name)].join(",")];
  for (const t of sorted) {
    cols.forEach((col, k) => {
      while (idx[k] < col.changes.length && col.changes[idx[k]][0] <= t) cur[k] = col.changes[idx[k]++][1];
    });
    lines.push([ns(t), ...cur.map((v, k) => (cols[k].digital ? (v ? "1" : "0") : volts(v as number)))].join(","));
  }
  return lines.join("\n") + "\n";
}

/** VCD identifier of the k-th variable: "!", "\"", … */
function vcdId(k: number): string {
  let s = "";
  do {
    s += String.fromCharCode(33 + (k % 94));
    k = Math.floor(k / 94) - 1;
  } while (k >= 0);
  return s;
}

/** A VCD reference name: "V(pot.W)" → "V_pot.W". */
export function vcdName(name: string): string {
  return name.replace(/^V\((.*)\)$/, "V_$1").replace(/[^A-Za-z0-9_.[\]]/g, "_");
}

/**
 * VCD with a 1 ns timescale; time 0 is the window's start (the trigger is
 * noted in a comment). Digital channels are 1-bit wires, analog ones
 * reals (volts).
 */
export function captureVcd(c: ScopeCapture, date = new Date().toISOString()): string {
  const cols = columns(c);
  const out: string[] = [
    "$timescale 1 ns $end",
    `$date ${date} $end`,
    "$version Simucleo (M22 oscilloscope) $end",
    `$comment trigger on ${c.source} at ${ns(-c.startNs)} ns $end`,
    "$scope module nucleo $end",
    ...cols.map((col, k) => `$var ${col.digital ? "wire 1" : "real 64"} ${vcdId(k)} ${vcdName(col.name)} $end`),
    "$upscope $end",
    "$enddefinitions $end",
  ];
  const value = (col: Col, v: boolean | number, k: number) =>
    col.digital ? `${v ? 1 : 0}${vcdId(k)}` : `r${volts(v as number)} ${vcdId(k)}`;
  out.push("#0", "$dumpvars", ...cols.map((col, k) => value(col, col.v0, k)), "$end");
  // Every change in the window, grouped by (integer) time.
  const changes: [number, string][] = [];
  cols.forEach((col, k) => {
    for (const [t, v] of col.changes as [number, boolean | number][]) {
      if (t < c.startNs || t > c.endNs) continue;
      changes.push([Math.round(t - c.startNs), value(col, v, k)]);
    }
  });
  changes.sort((a, b) => a[0] - b[0]);
  let last = 0;
  for (const [t, line] of changes) {
    if (t !== last) out.push(`#${t}`);
    last = t;
    out.push(line);
  }
  out.push(`#${Math.round(c.endNs - c.startNs)}`);
  return out.join("\n") + "\n";
}
