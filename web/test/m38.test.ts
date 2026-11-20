// M38: every bundled circuit (examples, lesson solutions, lesson start
// circuits) is a tidy breadboard build — and still the same circuit.
//  a. the nets of every pin that is not a breadboard hole, and the parts,
//     equal the snapshot taken before the layouts changed;
//  b. no jumper runs over a part body (except where it leaves its own pin),
//     and every jumper runs in square bends on the grid;
//  c. no two part bodies overlap;
//  d. with a breadboard, through-hole parts sit in its holes (no jumper on
//     their legs);
//  e. no two legs of one part share a breadboard row (that shorts it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error plain JS helpers shared with scripts/
import { essentialNets, loadAppModel } from "../scripts/appmodel.mjs";
// @ts-expect-error plain JS helpers shared with scripts/
import { allCircuits, circuitSignature, railSupplies, web } from "../scripts/circuits.mjs";

interface Ref {
  part: string;
  pin: string;
}
interface Part {
  id: string;
  kind: string;
  x: number;
  y: number;
  props?: Record<string, unknown>;
}
interface Wire {
  id: string;
  a: Ref;
  b: Ref;
  color: string;
  points?: { x: number; y: number }[];
}
interface Project {
  parts: Part[];
  wires: Wire[];
}
interface Def {
  w: number;
  h: number;
  pins: { id: string; x: number; y: number }[];
  buses?: string[][];
}

const model = await loadAppModel();
const DEFS = model.PART_BY_KIND as Record<string, Def>;
const snapshot = JSON.parse(readFileSync(join(web, "test", "data", "m38-nets.json"), "utf8")) as Record<string, { parts: string[]; nets: string[]; rails?: string[] }>;
const circuits = allCircuits() as [string, string, Project][];

/** Parts that plug into a breadboard: with a breadboard in the project they must sit in it. */
export const SEATED = [
  "led-5mm", "rgb-led", "resistor", "tact-switch", "potentiometer", "ldr", "temp-sensor", "thermistor",
  "ds18b20", "buzzer-passive", "buzzer-active", "hc595", "seven-segment", "seven-segment-4", "dht",
  "bmp280", "aht20", "rtc-ds3231", "hc-sr04", "mpu6050", "rotary-encoder", "sd-card",
];

const isBB = (kind: string) => kind.startsWith("breadboard");

/** Body rectangle; a part with no height (a resistor) is a line, given some thickness. */
function rect(p: Part) {
  const d = DEFS[p.kind];
  const t = 0.3;
  return {
    x0: p.x - (d.w === 0 ? t : 0),
    x1: p.x + d.w + (d.w === 0 ? t : 0),
    y0: p.y - (d.h === 0 ? t : 0),
    y1: p.y + d.h + (d.h === 0 ? t : 0),
  };
}

function pinAt(project: Project, r: Ref) {
  const part = project.parts.find((p) => p.id === r.part);
  assert.ok(part, `no part ${r.part}`);
  const pin = DEFS[part.kind].pins.find((p) => p.id === r.pin);
  assert.ok(pin, `${part.kind} has no pin ${r.pin}`);
  return { x: part.x + pin.x, y: part.y + pin.y };
}

/** Does segment p→q pass through the inside of `r` grown by `m`? (Liang–Barsky) */
export function crosses(p: { x: number; y: number }, q: { x: number; y: number }, r: { x0: number; y0: number; x1: number; y1: number }, m = 0.3) {
  let t0 = 0;
  let t1 = 1;
  const dx = q.x - p.x;
  const dy = q.y - p.y;
  const edges: [number, number][] = [
    [-dx, p.x - (r.x0 - m)],
    [dx, r.x1 + m - p.x],
    [-dy, p.y - (r.y0 - m)],
    [dy, r.y1 + m - p.y],
  ];
  for (const [pp, qq] of edges) {
    if (pp === 0) {
      if (qq <= 0) return false;
    } else {
      const t = qq / pp;
      if (pp < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
  }
  return t1 - t0 > 1e-9;
}

/** Problems with one circuit's layout (checks b–e). */
export function layoutProblems(project: Project): string[] {
  const out: string[] = [];
  const parts = project.parts.filter((p) => !isBB(p.kind));
  const bbs = project.parts.filter((p) => isBB(p.kind));
  // Breadboard holes: point → bus id.
  const hole = new Map<string, string>();
  for (const bb of bbs) {
    const d = DEFS[bb.kind];
    for (const pin of d.pins) {
      const bus = d.buses?.findIndex((b) => b.includes(pin.id)) ?? -1;
      hole.set(`${bb.x + pin.x},${bb.y + pin.y}`, bus >= 0 ? `${bb.id}#${bus}` : `${bb.id}:${pin.id}`);
    }
  }

  // b. Jumpers: square bends on the grid, over no part but their own ends.
  for (const w of project.wires) {
    const pts = [pinAt(project, w.a), ...(w.points ?? []), pinAt(project, w.b)];
    if (!w.points?.length) out.push(`${w.id}: no bend points (drawn as a curve)`);
    pts.forEach((p, i) => {
      if (!Number.isInteger(p.x) || !Number.isInteger(p.y)) out.push(`${w.id}: point ${i} off the grid`);
    });
    for (let i = 0; i + 1 < pts.length; i++) {
      const [p, q] = [pts[i], pts[i + 1]];
      if (p.x !== q.x && p.y !== q.y) out.push(`${w.id}: segment ${i} is not square`);
      for (const part of parts) {
        if (!crosses(p, q, rect(part))) continue;
        // Leaving (or reaching) its own pin through its own part's body.
        const own = (i === 0 && w.a.part === part.id) || (i === pts.length - 2 && w.b.part === part.id);
        if (!own) out.push(`${w.id} (${w.a.part}.${w.a.pin}–${w.b.part}.${w.b.pin}) crosses ${part.id}`);
      }
    }
  }

  // c. Bodies do not overlap.
  for (let i = 0; i < parts.length; i++)
    for (let j = i + 1; j < parts.length; j++) {
      const a = rect(parts[i]);
      const b = rect(parts[j]);
      if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) out.push(`${parts[i].id} overlaps ${parts[j].id}`);
    }

  // d. Through-hole parts sit in the breadboard.
  if (bbs.length) {
    for (const part of parts.filter((p) => SEATED.includes(p.kind))) {
      for (const pin of DEFS[part.kind].pins) {
        if (!hole.has(`${part.x + pin.x},${part.y + pin.y}`)) out.push(`${part.id}.${pin.id} is not in a breadboard hole`);
        if (project.wires.some((w) => [w.a, w.b].some((e) => e.part === part.id && e.pin === pin.id)))
          out.push(`${part.id}.${pin.id} has a jumper on its leg (seated parts connect through the breadboard)`);
      }
    }
  }

  // e. No two legs of a part in one breadboard row (unless the part joins them anyway).
  for (const part of parts) {
    const d = DEFS[part.kind];
    const seen = new Map<string, string>();
    for (const pin of d.pins) {
      const bus = hole.get(`${part.x + pin.x},${part.y + pin.y}`);
      if (!bus) continue;
      const other = seen.get(bus);
      const joined = other && d.buses?.some((b) => b.includes(other) && b.includes(pin.id));
      if (other && !joined) out.push(`${part.id}: legs ${other} and ${pin.id} share a breadboard row (shorted)`);
      seen.set(bus, pin.id);
    }
  }
  return out;
}

test("the snapshot covers every bundled circuit", () => {
  assert.deepEqual(circuits.map(([name]) => name).sort(), Object.keys(snapshot).sort());
  assert.ok(circuits.length >= 60, `${circuits.length} circuits`);
});

for (const [name, , project] of circuits) {
  test(`${name}: same parts and nets as before the layout`, () => {
    const now = circuitSignature(model, essentialNets, project);
    assert.deepEqual(now.parts, snapshot[name].parts);
    assert.deepEqual(now.nets, snapshot[name].nets);
    // A start circuit's rails still carry what its lesson says ("위쪽 레일은 3V3").
    const rails = new Set(railSupplies(model, project));
    for (const r of snapshot[name].rails ?? []) assert.ok(rails.has(r), `rail ${r}`);
  });
  test(`${name}: tidy layout`, () => {
    assert.deepEqual(layoutProblems(project), []);
  });
}

// The checks catch what they are for: each broken copy of a real circuit fails.
const byName = (n: string) => structuredClone(circuits.find(([name]) => name.includes(n))![2]);

test("check a: a wire moved to another pin changes the nets", () => {
  const p = byName("examples/lesson-led-on");
  const w = p.wires.find((x) => x.a.part === "nucleo" || x.b.part === "nucleo")!;
  const end = w.a.part === "nucleo" ? w.a : w.b;
  end.pin = "D8";
  assert.notDeepEqual(essentialNets(model, p), snapshot["examples/lesson-led-on.simucleo.json"].nets);
});

test("check a: a seated part moved one hole changes the nets", () => {
  const p = byName("examples/lesson-led-on");
  p.parts.find((x) => x.id === "led1")!.x += 1;
  assert.notDeepEqual(essentialNets(model, p), snapshot["examples/lesson-led-on.simucleo.json"].nets);
});

test("check b: a straight wire across the board, and a diagonal one, are caught", () => {
  const p = byName("examples/hal-adc-servo");
  p.wires.push({ id: "bad", a: { part: "nucleo", pin: "D2" }, b: { part: "bb1", pin: "j30" }, color: "#000", points: [{ x: 26, y: 23 }] });
  const problems = layoutProblems(p);
  assert.ok(problems.some((s) => /^bad .* crosses /.test(s)), problems.join("\n"));
  assert.ok(problems.some((s) => /^bad: segment 0 is not square/.test(s)), problems.join("\n"));
  p.wires.push({ id: "curve", a: { part: "nucleo", pin: "D3" }, b: { part: "bb1", pin: "j29" }, color: "#000" });
  assert.ok(layoutProblems(p).some((s) => s.startsWith("curve: no bend points")));
});

test("check b: a wire may leave its own pin through its own part, not through another", () => {
  const r = { x0: 0, y0: 0, x1: 4, y1: 4 };
  assert.ok(crosses({ x: 2, y: -2 }, { x: 2, y: 6 }, r));
  assert.ok(!crosses({ x: -1, y: -2 }, { x: -1, y: 6 }, r));
  assert.ok(!crosses({ x: 5, y: 0 }, { x: 9, y: 0 }, r));
});

test("check c: two parts on top of each other are caught", () => {
  const p = byName("examples/hal-relay");
  const k1 = p.parts.find((x) => x.id === "k1")!;
  const nucleo = p.parts.find((x) => x.id === "nucleo")!;
  Object.assign(k1, { x: nucleo.x + 2, y: nucleo.y + 10 });
  assert.ok(layoutProblems(p).some((s) => s === "k1 overlaps nucleo" || s === "nucleo overlaps k1"));
});

test("check d: an LED lifted off the board and wired by its legs is caught", () => {
  const p = byName("examples/lesson-led-on");
  const led = p.parts.find((x) => x.id === "led1")!;
  led.y -= 40;
  p.wires.push({ id: "leg", a: { part: "led1", pin: "A" }, b: { part: "bb1", pin: "a1" }, color: "#000", points: [{ x: led.x + 1, y: led.y + 6 }] });
  const problems = layoutProblems(p);
  assert.ok(problems.includes("led1.A is not in a breadboard hole"), problems.join("\n"));
  assert.ok(problems.some((s) => s.startsWith("led1.A has a jumper on its leg")));
});

test("check e: an LED with both legs in one strip (here the + rail) is caught", () => {
  const p = byName("examples/lesson-led-on");
  const bb = p.parts.find((x) => x.kind === "breadboard-half")!;
  const led = p.parts.find((x) => x.id === "led1")!;
  Object.assign(led, { x: bb.x + 2, y: bb.y + 18 - 3 });
  const problems = layoutProblems(p);
  assert.ok(problems.some((s) => /^led1: legs [AK] and [AK] share a breadboard row/.test(s)), problems.join("\n"));
  // The tact switch's 1a·1b are joined inside it: in one strip they are fine.
  const q = byName("examples/hal-button-exti");
  const sw = q.parts.find((x) => x.id === "sw1")!;
  const qb = q.parts.find((x) => x.kind === "breadboard-half")!;
  Object.assign(sw, { x: qb.x + 2, y: qb.y + 18 });
  assert.ok(!layoutProblems(q).some((s) => s.startsWith("sw1: legs")));
});
