// Wiring checks, evaluated live from the netlist the core computes
// (`sim.setCircuit`). Pure: no React, no part drawings, so it can be unit
// tested with Node (`npm test`).
import { t } from "../i18n/index.ts";
import type { CheckResult, ConnectedCheck, PartCheck, SeriesCheck, WiringCheck } from "./types.ts";

export interface PinRef {
  part: string;
  pin: string;
}

export interface WiringContext {
  parts: { id: string; kind: string; props?: Record<string, string | number> }[];
  nets: { pins: PinRef[] }[];
  /** Board signal of a board pin (`D13` → `PA5`, `GND_P1` → `GND`), else undefined. */
  boardSignal(kind: string, pin: string): string | undefined;
  /** Display name of a part kind. */
  nameOf(kind: string): string;
  /** Header name of an MCU signal, for hints (`PA5` → `D13`). */
  headerOf?(signal: string): string | undefined;
  /** Electrical-rule warnings shown now. */
  warnings: string[];
}

/** Short names for hints ("저항이 없습니다", not "저항 (Ω)이 …"). */
const SHORT: Record<string, string> = {
  "led-5mm": "LED",
  resistor: t("저항"),
  "rgb-led": "RGB LED",
  "tact-switch": t("버튼"),
  potentiometer: t("가변저항"),
  servo: t("서보"),
  "oled-ssd1306": "OLED",
  "lcd-i2c": "LCD",
};
export const shortName = (ctx: Pick<WiringContext, "nameOf">, kind: string) => SHORT[kind] ?? ctx.nameOf(kind);

/** Two-terminal paths through a part: [from pin, to pin, polarised, label]. */
export function terminals(part: WiringContext["parts"][number]): [string, string, boolean, string][] {
  switch (part.kind) {
    case "resistor":
      return [["1", "2", false, "resistor"]];
    case "led-5mm":
      return [["A", "K", true, "led-5mm"]];
    case "tact-switch":
      // Pressed, it joins the 1a/1b side to the 2a/2b side.
      return [["1a", "2a", false, "tact-switch"]];
    case "potentiometer":
      return [["1", "2", false, "potentiometer"]];
    case "rgb-led": {
      const anode = String(part.props?.common ?? "cathode") === "anode";
      return (["R", "G", "B"] as const).map((c) =>
        anode ? ["COM", c, true, `rgb-led:${c}`] : [c, "COM", true, `rgb-led:${c}`],
      );
    }
    default:
      return [];
  }
}

/** Nets by index, with lookups by pin and by board signal. */
class Nets {
  private byPin = new Map<string, number>();
  private count: number;
  private ctx: WiringContext;
  constructor(ctx: WiringContext) {
    this.ctx = ctx;
    ctx.nets.forEach((n, i) => n.pins.forEach((p) => this.byPin.set(`${p.part}:${p.pin}`, i)));
    this.count = ctx.nets.length;
  }
  /** A pin's net; an unconnected pin gets a net of its own. */
  of(p: PinRef): number {
    const k = `${p.part}:${p.pin}`;
    let n = this.byPin.get(k);
    if (n === undefined) {
      n = this.count++;
      this.byPin.set(k, n);
    }
    return n;
  }
  /** Nets that carry a board signal. */
  ofSignal(signal: string): Set<number> {
    const out = new Set<number>();
    for (const part of this.ctx.parts) {
      for (const [i, net] of this.ctx.nets.entries()) {
        for (const p of net.pins) {
          if (p.part === part.id && this.ctx.boardSignal(part.kind, p.pin) === signal) out.add(i);
        }
      }
    }
    return out;
  }
  /** Board signals on a net (`PA5`, `GND`). */
  signals(net: number): string[] {
    const pins = this.ctx.nets[net]?.pins ?? [];
    const out = new Set<string>();
    for (const p of pins) {
      const kind = this.ctx.parts.find((q) => q.id === p.part)?.kind;
      const s = kind && this.ctx.boardSignal(kind, p.pin);
      if (s && s !== "NC") out.add(s);
    }
    return [...out];
  }
}

const named = (ctx: WiringContext, signal: string) => {
  const h = ctx.headerOf?.(signal);
  return h && h !== signal ? `${signal} (${h})` : signal;
};

function checkPart(c: PartCheck, ctx: WiringContext): CheckResult {
  const need = c.count ?? 1;
  const have = ctx.parts.filter((p) => p.kind === c.kind).length;
  if (have >= need) return { pass: true };
  const name = shortName(ctx, c.kind);
  return {
    pass: false,
    hint:
      have === 0
        ? t("{name|이/가} 없습니다. 왼쪽 부품 목록에서 '{part}'을(를) 추가하세요.", { name, part: ctx.nameOf(c.kind) })
        : t("{name} {need}개가 필요합니다 (지금 {have}개).", { name, need, have }),
  };
}

function checkConnected(c: ConnectedCheck, ctx: WiringContext): CheckResult {
  const nets = new Nets(ctx);
  const target = nets.ofSignal(c.to);
  const parts = ctx.parts.filter((p) => p.kind === c.kind);
  const name = shortName(ctx, c.kind);
  if (!parts.length) return { pass: false, hint: t("{name|이/가} 없습니다.", { name }) };
  const elsewhere = new Set<string>();
  for (const p of parts) {
    const n = nets.of({ part: p.id, pin: c.pin });
    if (target.has(n)) return { pass: true };
    for (const s of nets.signals(n)) elsewhere.add(s);
  }
  const now = [...elsewhere].map((s) => named(ctx, s));
  return {
    pass: false,
    hint:
      t("{name}의 {pin} 핀이 {to}에 연결되어 있지 않습니다.", { name, pin: c.pin, to: named(ctx, c.to) }) +
      (now.length ? t(" 지금은 {now}에 연결되어 있습니다.", { now: now.join(", ") }) : ""),
  };
}

interface Path {
  labels: string[];
  reversed: boolean;
}

/** Simple paths from a net in `from` to a net in `to` through at most `depth` part terminals. */
function paths(ctx: WiringContext, nets: Nets, from: Set<number>, to: Set<number>, allowed: Set<string>, depth: number) {
  // Edges between nets: one per two-terminal path of an allowed part.
  const edges: { a: number; b: number; part: string; label: string; polar: boolean }[] = [];
  for (const p of ctx.parts) {
    for (const [pa, pb, polar, label] of terminals(p)) {
      if (!allowed.has(label)) continue;
      edges.push({ a: nets.of({ part: p.id, pin: pa }), b: nets.of({ part: p.id, pin: pb }), part: p.id, label, polar });
    }
  }
  const found: Path[] = [];
  const walk = (net: number, seenNets: Set<number>, usedParts: Set<string>, labels: string[], reversed: boolean) => {
    if (labels.length > 0 && to.has(net)) {
      found.push({ labels: [...labels], reversed });
      return;
    }
    if (labels.length >= depth || found.length > 200) return;
    for (const e of edges) {
      if (usedParts.has(e.part)) continue;
      const fwd = e.a === net ? e.b : e.b === net ? e.a : null;
      if (fwd === null || seenNets.has(fwd)) continue;
      const rev = e.polar && e.b === net;
      seenNets.add(fwd);
      usedParts.add(e.part);
      labels.push(e.label);
      walk(fwd, seenNets, usedParts, labels, reversed || rev);
      labels.pop();
      usedParts.delete(e.part);
      seenNets.delete(fwd);
    }
  };
  for (const n of from) walk(n, new Set([n]), new Set(), [], false);
  return found;
}

/** "저항과 LED" */
function andList(names: string[]): string {
  if (names.length < 2) return names[0] ?? "";
  if (names.length === 2) return t("{a|와/과} {b}", { a: names[0], b: names[1] });
  return t("{first|와/과} {rest}", { first: names[0], rest: andList(names.slice(1)) });
}

const sameItems = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

function labelName(ctx: WiringContext, label: string) {
  const [kind, ch] = label.split(":");
  return ch ? `${shortName(ctx, kind)} ${ch}` : shortName(ctx, kind);
}

function checkSeries(c: SeriesCheck, ctx: WiringContext): CheckResult {
  const nets = new Nets(ctx);
  const from = nets.ofSignal(c.from);
  const to = nets.ofSignal(c.to);
  const allowed = new Set(c.through);
  const items = andList(c.through.map((l) => labelName(ctx, l)));
  for (const n of from) {
    if (to.has(n)) return { pass: false, hint: t("{from|이/가} {to}에 바로 연결되어 있습니다 (단락). 사이에 {items|을/를} 넣으세요.", { from: c.from, to: c.to, items }),
      };
  }
  const found = paths(ctx, nets, from, to, allowed, c.through.length);
  if (found.some((p) => !p.reversed && sameItems(p.labels, c.through))) return { pass: true };
  if (found.some((p) => p.reversed && sameItems(p.labels, c.through))) {
    return { pass: false, hint: t("LED 방향이 반대입니다. 긴 다리(A, 애노드)가 {from} 쪽, 짧은 다리(K)가 {to} 쪽이어야 합니다.", { from: c.from, to: c.to }),
    };
  }
  // Something is in series, but not everything.
  const partial = found.filter((p) => p.labels.length < c.through.length);
  if (partial.length) {
    const missing = c.through.filter((l) => !partial[0].labels.includes(l));
    const what = andList(missing.map((l) => labelName(ctx, l)));
    return { pass: false, hint: t("{from|이/가} {to|으로/로} 가는 길에 {what|이/가} 없습니다.", { from: c.from, to: c.to, what }) };
  }
  // The right chain, on the wrong pin?
  const others = new Set<number>();
  for (const part of ctx.parts) {
    for (const pin of ctx.nets.flatMap((n) => n.pins).filter((p) => p.part === part.id)) {
      const s = ctx.boardSignal(part.kind, pin.pin);
      if (s && s !== c.from && s !== c.to && /^P[A-H]\d+$/.test(s)) others.add(nets.of(pin));
    }
  }
  const wrong = paths(ctx, nets, others, to, allowed, c.through.length).filter((p) => sameItems(p.labels, c.through));
  if (wrong.length) {
    const at = [...others].flatMap((n) => nets.signals(n)).filter((s) =>
      paths(ctx, nets, nets.ofSignal(s), to, allowed, c.through.length).some((p) => sameItems(p.labels, c.through)),
    );
    return {
      pass: false,
      hint: t("{items|이/가} {at}에 연결되어 있습니다. {from}에 연결하세요.", {
        items,
        at: [...new Set(at)].map((s) => named(ctx, s)).join(", "),
        from: named(ctx, c.from),
      }),
    };
  }
  const missingParts = c.through.filter((l) => !ctx.parts.some((p) => terminals(p).some((t) => t[3] === l)));
  if (missingParts.length) {
    return { pass: false, hint: t("{name|이/가} 회로에 없습니다.", { name: andList(missingParts.map((l) => labelName(ctx, l))) }) };
  }
  return { pass: false, hint: t("{from}에서 {to}까지 {items|이/가} 이어진 길이 없습니다. 브레드보드의 같은 줄에 꽂혔는지 확인하세요.", { from: c.from, to: c.to, items }),
  };
}

export function evaluateWiring(c: WiringCheck, ctx: WiringContext): CheckResult {
  switch (c.type) {
    case "part":
      return checkPart(c, ctx);
    case "connected":
      return checkConnected(c, ctx);
    case "series":
      return checkSeries(c, ctx);
    case "noWarnings":
      return ctx.warnings.length
        ? { pass: false, hint: t("전기 규칙 경고가 있습니다: {warnings}", { warnings: ctx.warnings.join(" / ") }) }
        : { pass: true };
  }
}

/** The default checklist line for a wiring check. */
export function wiringLabel(c: WiringCheck, ctx: Pick<WiringContext, "nameOf">): string {
  switch (c.type) {
    case "part":
      return c.count && c.count > 1
        ? t("{name} {n}개 놓기", { name: shortName(ctx, c.kind), n: c.count })
        : t("{name} 놓기", { name: shortName(ctx, c.kind) });
    case "connected":
      return t("{name}의 {pin} 핀 → {to}", { name: shortName(ctx, c.kind), pin: c.pin, to: c.to });
    case "series":
      return t("{from} → {through} → {to} 직렬 연결", {
        from: c.from,
        through: c.through.map((l) => labelName(ctx as WiringContext, l)).join(" → "),
        to: c.to,
      });
    case "noWarnings":
      return t("전기 규칙 경고 없음");
  }
}
