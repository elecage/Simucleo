// Lesson editor helpers on the circuit (M24): "현재 배선에서 검사 만들기"
// turns the wiring on screen into wiring checks that it passes, and
// `involved` names the pins a wiring check is about, for the grading
// highlights on the schematic. Pure (unit tested with Node).
import type { ConnectedCheck, PartCheck, SeriesCheck, WiringCheck } from "./types.ts";
import { terminals, type PinRef, type WiringContext } from "./wiring.ts";

/** Supplies a check may name (besides MCU signals such as PA5). */
export const POWER = ["GND", "3V3", "5V", "VIN"] as const;
const IO = /^P[A-H]\d{1,2}$/;
const usable = (s: string) => IO.test(s) || (POWER as readonly string[]).includes(s);
/** GND first, then the supplies, then MCU signals in order. */
const rank = (s: string) => {
  const p = (POWER as readonly string[]).indexOf(s);
  return p >= 0 ? p : 10;
};
const bySignal = (a: string, b: string) => rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true });

export interface FromWiringOptions {
  /** Kinds that are the board itself (default: the Nucleo). */
  isBoard?: (kind: string) => boolean;
}

/**
 * Wiring checks that the circuit passes as it is: a `part` check per kind,
 * a `series` check per chain of two-terminal parts (resistor, LED, button,
 * potentiometer, RGB LED channel) between two board signals, and a
 * `connected` check for every other part pin on a board signal.
 */
export function checksFromWiring(ctx: WiringContext, opts: FromWiringOptions = {}): WiringCheck[] {
  const isBoard = opts.isBoard ?? ((k: string) => k === "nucleo-f401re");
  const kindOf = new Map(ctx.parts.map((p) => [p.id, p.kind]));
  const skip = (kind: string | undefined) => !kind || isBoard(kind) || kind.startsWith("breadboard");
  const byPin = new Map<string, number>();
  ctx.nets.forEach((n, i) => n.pins.forEach((p) => byPin.set(`${p.part}:${p.pin}`, i)));
  let fresh = ctx.nets.length;
  const netOf = (p: PinRef) => {
    const k = `${p.part}:${p.pin}`;
    if (!byPin.has(k)) byPin.set(k, fresh++);
    return byPin.get(k)!;
  };
  const signals = (net: number) =>
    [
      ...new Set(
        (ctx.nets[net]?.pins ?? []).flatMap((p) => {
          const kind = kindOf.get(p.part);
          const s = kind && isBoard(kind) ? ctx.boardSignal(kind, p.pin) : undefined;
          return s && usable(s) ? [s] : [];
        }),
      ),
    ].sort(bySignal);

  // ------------------------------------------------------------ parts
  const counts = new Map<string, number>();
  for (const p of ctx.parts) if (!skip(p.kind)) counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
  const partChecks: PartCheck[] = [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, n]) => ({ type: "part", kind, ...(n > 1 ? { count: n } : {}) }));

  // ----------------------------------------------------------- chains
  interface Edge {
    a: number;
    b: number;
    part: string;
    pins: [string, string];
    label: string;
    polar: boolean;
  }
  const edges: Edge[] = [];
  for (const p of ctx.parts) {
    if (skip(p.kind)) continue;
    for (const [pa, pb, polar, label] of terminals(p)) {
      edges.push({ a: netOf({ part: p.id, pin: pa }), b: netOf({ part: p.id, pin: pb }), part: p.id, pins: [pa, pb], label, polar });
    }
  }
  const covered = new Set<string>();
  const seen = new Set<string>();
  const series: SeriesCheck[] = [];
  const signalNets = [...new Set(ctx.nets.map((_, i) => i))].filter((i) => signals(i).length);
  // Start from MCU signals and supplies (a chain ending on GND is found from its other end).
  const starts = signalNets
    .map((n) => ({ n, s: signals(n).find((s) => s !== "GND") }))
    .filter((x): x is { n: number; s: string } => !!x.s)
    .sort((x, y) => bySignal(x.s, y.s));
  for (const { n: start, s: startSignal } of starts) {
    const walk = (net: number, nets: Set<number>, path: { e: Edge; fwd: boolean }[]) => {
      if (path.length && net !== start && signals(net).length) {
        const end = signals(net)[0];
        if (end === startSignal) return;
        const polar = path.filter((x) => x.e.polar);
        let from = startSignal;
        let to = end;
        if (polar.length) {
          if (polar.every((x) => !x.fwd)) [from, to] = [end, startSignal];
          else if (!polar.every((x) => x.fwd)) return; // LEDs both ways: not a series chain
        } else if (!IO.test(from) && IO.test(to)) [from, to] = [to, from];
        const through = path.map((x) => x.e.label);
        const key = `${from}|${to}|${[...through].sort().join()}`;
        if (seen.has(key)) return;
        seen.add(key);
        // In the order from `from` (the order does not matter to the check).
        series.push({ type: "series", from, to, through: from === startSignal ? through : [...through].reverse() });
        // Every pin of the part on those nets (a button's bused 1a/1b).
        for (const x of path) for (const n of [x.e.a, x.e.b]) covered.add(`${x.e.part}@${n}`);
        return;
      }
      if (path.length >= 4) return;
      for (const e of edges) {
        if (path.some((x) => x.e.part === e.part)) continue;
        const next = e.a === net ? e.b : e.b === net ? e.a : null;
        if (next === null || nets.has(next)) continue;
        nets.add(next);
        path.push({ e, fwd: e.a === net });
        walk(next, nets, path);
        path.pop();
        nets.delete(next);
      }
    };
    walk(start, new Set([start]), []);
  }
  series.sort((x, y) => bySignal(x.from, y.from) || bySignal(x.to, y.to));

  // ------------------------------------------------------- connections
  const connected: ConnectedCheck[] = [];
  const done = new Set<string>();
  for (const [i, net] of ctx.nets.entries()) {
    const sig = signals(i)[0];
    if (!sig) continue;
    const byPart = new Map<string, string[]>();
    for (const p of net.pins) {
      if (skip(kindOf.get(p.part)) || covered.has(`${p.part}@${i}`)) continue;
      byPart.set(p.part, [...(byPart.get(p.part) ?? []), p.pin]);
    }
    for (const [part, pins] of byPart) {
      // Bused pins (a button's 1a/1b) on one net: one check.
      const pin = [...pins].sort()[0];
      const kind = kindOf.get(part)!;
      const key = `${kind}|${pin}|${sig}`;
      if (done.has(key)) continue;
      done.add(key);
      connected.push({ type: "connected", kind, pin, to: sig });
    }
  }
  connected.sort((x, y) => x.kind.localeCompare(y.kind) || x.pin.localeCompare(y.pin) || bySignal(x.to, y.to));
  return [...partChecks, ...series, ...connected];
}

/** What a wiring check is about: part pins, and board signals (`PA5`, `GND`). */
export interface Involved {
  pins: PinRef[];
  signals: string[];
}

export function involved(c: WiringCheck, ctx: Pick<WiringContext, "parts">): Involved {
  switch (c.type) {
    case "connected":
      return {
        pins: ctx.parts.filter((p) => p.kind === c.kind).map((p) => ({ part: p.id, pin: c.pin })),
        signals: [c.to],
      };
    case "series": {
      const labels = new Set(c.through);
      const pins = ctx.parts.flatMap((p) =>
        terminals(p)
          .filter((t) => labels.has(t[3]))
          .flatMap(([a, b]) => [
            { part: p.id, pin: a },
            { part: p.id, pin: b },
          ]),
      );
      return { pins, signals: [c.from, c.to] };
    }
    case "part":
      return { pins: [], signals: [] };
    case "noWarnings":
      return { pins: [], signals: [] };
  }
}
