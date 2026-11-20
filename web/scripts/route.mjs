// Routing helper for the bundled example circuits (M38). Not part of the
// app: a tool for whoever lays out an example, so it looks like a tidy
// breadboard build.
//
// Given a project whose parts are already placed (parts that plug into a
// breadboard seated in its holes), `rewire` throws the jumpers away and
// draws new ones that make exactly the given nets: it finds what is
// already joined by the breadboard, joins the rest with as few and as
// short jumpers as it can (power through the rails), and routes each one
// with square bends around the part bodies (a shortest path on the grid
// that pays for bends, for crossing other jumpers and for running over
// breadboard holes, and never runs over a part, a used hole or along
// another jumper).
//
//   node scripts/route.mjs <file> [--rails bb1:tp=3V3,bb1:bn=GND]
//     re-routes one project file (nets taken from its current wiring)
//
// Library use: see scripts/m38-layouts.mjs.
import { readFileSync } from "node:fs";
import { essentialNets, loadAppModel, projectNets } from "./appmodel.mjs";

// ------------------------------------------------------------- geometry

/** Body rectangle of a placed part in grid units (a zero-height part is a line). */
export function bodyRect(def, part) {
  return { x0: part.x, y0: part.y, x1: part.x + def.w, y1: part.y + def.h };
}

export const isBreadboard = (kind) => kind.startsWith("breadboard");

const ROWS = { a: 4, b: 5, c: 6, d: 7, e: 8, f: 11, g: 12, h: 13, i: 14, j: 15 };
const RAILS = { tp: 1, tn: 2, bp: 18, bn: 19 };

/** Grid point of breadboard hole `hole` ("e12", "tn3") of a breadboard at (bx, by). */
export function holePoint(bb, hole) {
  const m = /^([a-j]|tp|tn|bp|bn)(\d+)$/.exec(hole);
  if (!m) throw new Error(`no hole ${hole}`);
  const c = Number(m[2]);
  const y = m[1].length === 1 ? ROWS[m[1]] : RAILS[m[1]];
  return { x: bb.x + c + 1, y: bb.y + y };
}

/** Move `id` so its pin `pin` sits in hole `hole` ("bb1:e12"). */
export function seat(model, project, id, pin, hole) {
  const part = project.parts.find((p) => p.id === id);
  if (!part) throw new Error(`no part ${id}`);
  const [bbId, h] = hole.split(":");
  const bb = project.parts.find((p) => p.id === bbId);
  if (!bb) throw new Error(`no breadboard ${bbId}`);
  const pd = model.PART_BY_KIND[part.kind].pins.find((p) => p.id === pin);
  if (!pd) throw new Error(`${id} has no pin ${pin}`);
  const at = holePoint(bb, h);
  part.x = at.x - pd.x;
  part.y = at.y - pd.y;
}

/** Which way a wire leaves a pin: out of the nearest edge of the part body. */
function exitDirs(def, pin) {
  const d = [
    [pin.y, [0, -1]],
    [def.h - pin.y, [0, 1]],
    [pin.x, [-1, 0]],
    [def.w - pin.x, [1, 0]],
  ];
  const best = Math.min(...d.map(([v]) => v));
  return d.filter(([v]) => v === best).map(([, dir]) => dir);
}

// --------------------------------------------------------------- routing

const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const key = (x, y) => `${x},${y}`;

class Heap {
  constructor() {
    this.a = [];
  }
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() {
    return this.a.length;
  }
}

/** Costs of the router (grid steps). */
export const COST = { step: 1, bend: 4, cross: 3, hole: 0.6, near: 0.6, pinUse: 20, morpho: 30 };

/**
 * The board as the router sees it: blocked points (part bodies, pins,
 * wire ends), breadboard holes, and what the routed wires use.
 */
export class Board {
  constructor(model, project) {
    this.model = model;
    this.project = project;
    this.blocked = new Map(); // point → part id ("*" for a wire end)
    this.holes = new Map(); // point → [bb id, hole id]
    this.used = new Map(); // point → "h" | "v" | "hv" (wire segments over it)
    this.near = new Set();
    this.reserved = new Set(); // planned jumper ends (holes): not to be run over
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const part of project.parts) {
      const def = model.PART_BY_KIND[part.kind];
      const r = bodyRect(def, part);
      x0 = Math.min(x0, r.x0); y0 = Math.min(y0, r.y0); x1 = Math.max(x1, r.x1); y1 = Math.max(y1, r.y1);
      if (isBreadboard(part.kind)) {
        for (const p of def.pins) this.holes.set(key(part.x + p.x, part.y + p.y), [part.id, p.id]);
        continue;
      }
      for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) this.blocked.set(key(x, y), part.id);
      for (const p of def.pins) this.blocked.set(key(part.x + p.x, part.y + p.y), part.id);
      for (let x = r.x0 - 1; x <= r.x1 + 1; x++) for (let y = r.y0 - 1; y <= r.y1 + 1; y++) this.near.add(key(x, y));
    }
    this.bounds = { x0: x0 - 20, y0: y0 - 20, x1: x1 + 20, y1: y1 + 20 };
  }

  /** Points of `id`'s pins that plug into a breadboard hole. */
  seated(partId, pinId) {
    const part = this.project.parts.find((p) => p.id === partId);
    const pin = this.model.PART_BY_KIND[part.kind].pins.find((p) => p.id === pinId);
    return this.holes.has(key(part.x + pin.x, part.y + pin.y));
  }

  /** The straight stub from a pin out of its own part's body: points after the pin, or null. */
  stub(partId, pinId, dir) {
    const part = this.project.parts.find((p) => p.id === partId);
    const def = this.model.PART_BY_KIND[part.kind];
    const pin = def.pins.find((p) => p.id === pinId);
    let x = part.x + pin.x, y = part.y + pin.y;
    const pts = [];
    for (;;) {
      x += dir[0];
      y += dir[1];
      const b = this.blocked.get(key(x, y));
      pts.push([x, y]);
      if (b === undefined) return pts;
      if (b !== partId || pts.length > 40) return null;
    }
  }

  /** Where a wire may start from end `ref`: [[x, y, dir, cost, stub points]]. */
  starts(ref) {
    const part = this.project.parts.find((p) => p.id === ref.part);
    const def = this.model.PART_BY_KIND[part.kind];
    const pin = def.pins.find((p) => p.id === ref.pin);
    const px = part.x + pin.x, py = part.y + pin.y;
    if (isBreadboard(part.kind)) return [[px, py, null, 0, []]];
    const out = [];
    for (const dir of exitDirs(def, pin)) {
      const s = this.stub(ref.part, ref.pin, dir);
      if (s) {
        const [x, y] = s[s.length - 1];
        out.push([x, y, dir, s.length * COST.step, s]);
      }
    }
    return out;
  }

  free(x, y) {
    return !this.blocked.has(key(x, y)) && x >= this.bounds.x0 && x <= this.bounds.x1 && y >= this.bounds.y0 && y <= this.bounds.y1;
  }

  /** Cheapest square-cornered path from `a` to `b` (pin refs): grid points, ends included. */
  route(a, b, strict = true) {
    const sa = this.starts(a);
    const sb = this.starts(b);
    if (!sa.length || !sb.length) throw new Error(`no way out of ${a.part}:${a.pin} or ${b.part}:${b.pin}`);
    const pa = this.pinPoint(a);
    const pb = this.pinPoint(b);
    const dirIndex = (dir) => (dir ? DIRS.findIndex((d) => d[0] === dir[0] && d[1] === dir[1]) : -1);
    // Goals: the outer end of each of b's stubs; the last move should point into the stub.
    const goals = new Map();
    for (const [x, y, dir, cost, stub] of sb) {
      const k = key(x, y);
      if (!goals.has(k)) goals.set(k, []);
      goals.get(k).push({ need: dir ? dirIndex([-dir[0], -dir[1]]) : -1, cost, stub });
    }
    const heap = new Heap();
    const best = new Map();
    const prev = new Map();
    for (const [x, y, dir, cost, stub] of sa) {
      const s = `${x},${y},${dirIndex(dir)}`;
      if (cost < (best.get(s) ?? Infinity)) {
        best.set(s, cost);
        prev.set(s, { stub });
        heap.push([cost, x, y, dirIndex(dir), null]);
      }
    }
    while (heap.size) {
      const [c, x, y, di, fin] = heap.pop();
      if (fin) return this.unwind(prev, fin.s, pa, pb, fin.g);
      const s = `${x},${y},${di}`;
      if (c > (best.get(s) ?? Infinity)) continue;
      for (const g of goals.get(key(x, y)) ?? []) {
        const turn = g.need >= 0 && di >= 0 && di !== g.need ? COST.bend : 0;
        heap.push([c + turn + g.cost, x, y, di, { s, g }]);
      }
      for (let nd = 0; nd < 4; nd++) {
        const [dx, dy] = DIRS[nd];
        if (di >= 0 && dx === -DIRS[di][0] && dy === -DIRS[di][1]) continue;
        const nx = x + dx, ny = y + dy;
        const nk = key(nx, ny);
        const isGoal = goals.has(nk);
        if (!isGoal && (!this.free(nx, ny) || this.reserved.has(nk))) continue;
        // Never along another jumper, never over another jumper's end.
        const u = this.used.get(nk) ?? "";
        const axis = dx ? "h" : "v";
        if (u === "end") continue;
        if (u.includes(axis) && strict) continue;
        let cost = COST.step;
        if (u.includes(axis)) cost += 25;
        if (di >= 0 && di !== nd) cost += COST.bend;
        if (u) cost += COST.cross;
        // Over holes: a jumper lying along a row of holes looks plugged into all of them, so runs go in the channel and the gaps.
        if (this.holes.has(nk) && !isGoal) cost += dx && this.holes.has(key(x, y)) ? 3 * COST.hole : COST.hole;
        if (this.near.has(nk)) cost += COST.near;
        const ns = `${nx},${ny},${nd}`;
        const nc = c + cost;
        if (nc < (best.get(ns) ?? Infinity)) {
          best.set(ns, nc);
          prev.set(ns, { from: s });
          heap.push([nc, nx, ny, nd, null]);
        }
      }
    }
    throw new Error(`no route ${a.part}:${a.pin} → ${b.part}:${b.pin}`);
  }

  /** ASCII map around `c`: # body, o hole, + jumper, E jumper end, R reserved. */
  dump(c, r = 10) {
    const rows = [];
    for (let y = c.y - r; y <= c.y + r; y++) {
      let s = String(y).padStart(4) + " ";
      for (let x = c.x - 2 * r; x <= c.x + 2 * r; x++) {
        const k = key(x, y);
        s += x === c.x && y === c.y ? "@" : this.used.has(k) ? (this.used.get(k) === "end" ? "E" : "+") : this.reserved.has(k) ? "R" : this.blocked.has(k) ? "#" : this.holes.has(k) ? "o" : ".";
      }
      rows.push(s);
    }
    return rows.join("\n");
  }

  pinPoint(ref) {
    const part = this.project.parts.find((p) => p.id === ref.part);
    const pin = this.model.PART_BY_KIND[part.kind].pins.find((p) => p.id === ref.pin);
    return { x: part.x + pin.x, y: part.y + pin.y };
  }

  unwind(prev, s, pa, pb, goal) {
    const mid = [];
    let cur = s;
    let first;
    for (;;) {
      const [x, y] = cur.split(",").map(Number);
      mid.push([x, y]);
      const p = prev.get(cur);
      if (p.from === undefined) {
        first = p.stub;
        break;
      }
      cur = p.from;
    }
    mid.reverse();
    // pa, stub of a (ends where mid starts), mid, stub of b reversed, pb.
    const pts = [[pa.x, pa.y], ...first.slice(0, -1), ...mid, ...goal.stub.slice(0, -1).reverse(), [pb.x, pb.y]];
    return pts;
  }

  /** Take a routed path: its points can no longer be run along. */
  commit(pts) {
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = pts[i];
      const k = key(x, y);
      if (i === 0 || i === pts.length - 1) {
        this.used.set(k, "end");
        continue;
      }
      const [px, py] = pts[i - 1];
      const [nx, ny] = pts[i + 1];
      let u = this.used.get(k) ?? "";
      if (px !== x || nx !== x) u += "h";
      if (py !== y || ny !== y) u += "v";
      this.used.set(k, u);
    }
  }
}

/** Bend points of a path (grid points): the corners, never empty. */
export function bends(pts) {
  const out = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i - 1];
    const [x, y] = pts[i];
    const [bx, by] = pts[i + 1];
    if ((ax === x && x === bx) || (ay === y && y === by)) continue;
    out.push({ x, y });
  }
  if (!out.length) {
    // Straight: one point on the line so the editor draws it straight, not as a sagging curve.
    const m = pts[Math.floor(pts.length / 2)];
    out.push({ x: m[0], y: m[1] });
  }
  return out;
}

// ---------------------------------------------------------------- wiring

const GND = "#212121";
const POWER = "#e53935";
const SIGNAL = ["#1e88e5", "#43a047", "#fb8c00", "#8e24aa", "#fdd835", "#00897b", "#ec407a", "#6d4c41", "#00acc1", "#757575"];

/**
 * Replace the project's wires by jumpers that make exactly `nets`
 * (`essentialNets` of the circuit before). `opts.rails` assigns a
 * breadboard rail to the net of a pin: `{ "bb1:tp": "nucleo:3V3" }`.
 * `opts.colors` keeps the colour of a net: `{ "nucleo:D7": "#fdd835" }`
 * (by any pin on it); `opts.oldWires` gives the colours used before.
 */
export function rewire(model, project, nets, opts = {}) {
  const kind = new Map(project.parts.map((p) => [p.id, p.kind]));
  const bare = { ...project, wires: [] };
  const groups = projectNets(model, bare);
  const groupOf = new Map();
  groups.forEach((g, i) => g.forEach((k) => groupOf.set(k, i)));
  const gOf = (k) => {
    if (!groupOf.has(k)) {
      groups.push([k]);
      groupOf.set(k, groups.length - 1);
    }
    return groupOf.get(k);
  };
  const board = new Board(model, project);
  const isBB = (k) => isBreadboard(kind.get(k.slice(0, k.indexOf(":"))) ?? "");

  // Each target net and the groups (already joined pieces) it is made of.
  const netPins = nets.map((n) => n.split(" "));
  const netOfPin = new Map();
  netPins.forEach((n, i) => n.forEach((k) => netOfPin.set(k, i)));
  for (const g of groups) {
    const ns = new Set(g.filter((k) => !isBB(k)).map((k) => netOfPin.get(k) ?? `alone ${k}`));
    const real = g.filter((k) => !isBB(k));
    if (ns.size > 1 && real.length > 1) throw new Error(`placement joins different nets: ${real.join(" ")}`);
  }
  const railOf = new Map();
  for (const [rail, pin] of Object.entries(opts.rails ?? {})) {
    const net = netOfPin.get(pin.includes(":") ? pin : `nucleo:${pin}`);
    if (net === undefined) throw new Error(`rail ${rail}: ${pin} is on no net`);
    const [bb, r] = rail.split(":");
    railOf.set(gOf(`${bb}:${r}1`), net);
  }

  // Ends a jumper may use in each group: free holes and pins of parts that
  // are not seated. A part pin may take more than one jumper, at a price.
  const pinUse = new Map();
  const holeFree = (k) => {
    const [bb, h] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
    const p = holePoint(project.parts.find((x) => x.id === bb), h);
    const pk = key(p.x, p.y);
    return !board.blocked.has(pk) && !board.reserved.has(pk);
  };
  const ends = (gi) =>
    groups[gi].filter((k) => {
      if (isBB(k)) return holeFree(k);
      const [part, pin] = [k.slice(0, k.indexOf(":")), k.slice(k.indexOf(":") + 1)];
      if (board.seated(part, pin)) return false;
      const d = model.PART_BY_KIND[kind.get(part)];
      const pd = d.pins.find((p) => p.id === pin);
      // Pins that are only joined inside the part by a bus are still separate pins.
      return pd !== undefined && board.starts({ part, pin }).length > 0;
    });
  const pt = (k) => {
    const i = k.indexOf(":");
    return board.pinPoint({ part: k.slice(0, i), pin: k.slice(i + 1) });
  };
  const ref = (k) => ({ part: k.slice(0, k.indexOf(":")), pin: k.slice(k.indexOf(":") + 1) });
  const prefer = opts.prefer ?? {};
  // Students wire to the Arduino headers: Morpho pins only when nothing else carries the signal, never AREF/IOREF/AVDD/U5V as a supply.
  const endCost = (k) =>
    (pinUse.get(k) ?? 0) * COST.pinUse + (prefer[k] ?? 0) + (/^nucleo:CN/.test(k) ? COST.morpho : 0) + (/^nucleo:(AREF|IOREF|CN10_7|CN10_8|CN7_5|CN7_6|CN7_12)$/.test(k) ? 1000 : 0);

  const jumpers = [];
  netPins.forEach((pins, ni) => {
    const gs = [...new Set(pins.map(gOf))];
    for (const [g, n] of railOf) if (n === ni && !gs.includes(g)) gs.push(g);
    if (gs.length < 2) return;
    // Kruskal over the groups, by the shortest pair of ends.
    const comp = new Map(gs.map((g) => [g, g]));
    const find = (g) => (comp.get(g) === g ? g : find(comp.get(g)));
    const pairs = [];
    for (let i = 0; i < gs.length; i++)
      for (let j = i + 1; j < gs.length; j++) {
        let bestD = Infinity;
        for (const a of ends(gs[i]))
          for (const b of ends(gs[j])) {
            const pa = pt(a), pb = pt(b);
            bestD = Math.min(bestD, Math.abs(pa.x - pb.x) + Math.abs(pa.y - pb.y) + endCost(a) + endCost(b));
          }
        if (bestD < Infinity) pairs.push([bestD, gs[i], gs[j]]);
      }
    pairs.sort((x, y) => x[0] - y[0]);
    let joined = 0;
    // A breadboard strip takes as many jumpers as it has free holes.
    const cap = new Map(gs.map((g) => [g, ends(g).some((k) => !isBB(k)) ? Infinity : ends(g).length]));
    const compCap = new Map(gs.map((g) => [g, cap.get(g)]));
    for (const [, gi, gj] of pairs) {
      const ri = find(gi), rj = find(gj);
      if (ri === rj || cap.get(gi) < 1 || cap.get(gj) < 1) continue;
      // Do not close off a piece that still has to reach the rest.
      const left = compCap.get(ri) + compCap.get(rj) - 2;
      if (left <= 0 && joined + 1 < gs.length - 1) continue;
      cap.set(gi, cap.get(gi) - 1);
      cap.set(gj, cap.get(gj) - 1);
      compCap.set(rj, left);
      comp.set(ri, rj);
      jumpers.push({ net: ni, gi, gj });
      joined++;
    }
    if (joined !== gs.length - 1) throw new Error(`net ${pins.join(" ")}: cannot join all pieces (no free hole?)`);
  });

  // Colours: power red, ground black, signals keep the colour they had.
  const oldColor = new Map();
  for (const w of opts.oldWires ?? []) {
    for (const k of [`${w.a.part}:${w.a.pin}`, `${w.b.part}:${w.b.pin}`]) {
      const n = netOfPin.get(k);
      if (n !== undefined && !oldColor.has(n)) oldColor.set(n, w.color);
    }
  }
  const colorOf = new Map();
  let next = 0;
  const colour = (ni) => {
    if (colorOf.has(ni)) return colorOf.get(ni);
    const pins = netPins[ni];
    let c;
    for (const [pin, col] of Object.entries(opts.colors ?? {})) if (pins.includes(pin)) c = col;
    if (!c && pins.includes("nucleo:GND_P1")) c = GND;
    if (!c && pins.some((k) => /^nucleo:(3V3|5V|VIN|E5V)$/.test(k))) c = POWER;
    if (!c && oldColor.has(ni) && ![GND, POWER, "#f5f5f5", "#dc2626", "#111111"].includes(oldColor.get(ni))) c = oldColor.get(ni);
    // Red and black only for supplies and ground: a battery lead keeps its colour, a signal does not.
    if (!c && oldColor.has(ni) && !pins.some((k) => k.startsWith("nucleo:"))) c = oldColor.get(ni);
    if (!c) c = SIGNAL[next++ % SIGNAL.length];
    colorOf.set(ni, c);
    return c;
  };

  // Concrete ends, shortest jumpers first, then route in that order.
  const plans = [];
  for (const j of jumpers) {
    let bestPair, bestD = Infinity;
    for (const a of ends(j.gi))
      for (const b of ends(j.gj)) {
        const pa = pt(a), pb = pt(b);
        const d = Math.abs(pa.x - pb.x) + Math.abs(pa.y - pb.y) + endCost(a) + endCost(b);
        if (d < bestD) [bestD, bestPair] = [d, [a, b]];
      }
    if (!bestPair) throw new Error(`no ends left for a jumper on ${netPins[j.net].join(" ")}`);
    for (const k of bestPair) {
      if (isBB(k)) {
        const p = pt(k);
        board.reserved.add(key(p.x, p.y));
      } else pinUse.set(k, (pinUse.get(k) ?? 0) + 1);
    }
    plans.push({ ...j, a: bestPair[0], b: bestPair[1], d: bestD });
  }
  // Keep the way out of every pin that gets a jumper clear of the others.
  for (const p of plans)
    for (const k of [p.a, p.b]) if (!isBB(k)) for (const [x, y] of board.starts(ref(k))) board.reserved.add(key(x, y));
  plans.sort((x, y) => x.d - y.d);
  /** A boxed-in jumper: other free holes of the same row, then running along another jumper. */
  const retry = (p) => {
    const side = (k, gi) => (isBB(k) ? [k, ...ends(gi).filter((h) => isBB(h) && h !== k)] : [k]);
    for (const strict of [true, false]) {
      for (const a of side(p.a, p.gi))
        for (const b of side(p.b, p.gj)) {
          if (a === p.a && b === p.b && strict) continue;
          try {
            const path = board.route(ref(a), ref(b), strict);
            for (const [old, now] of [[p.a, a], [p.b, b]]) {
              if (old === now) continue;
              const o = pt(old), q = pt(now);
              board.reserved.delete(key(o.x, o.y));
              board.reserved.add(key(q.x, q.y));
            }
            p.a = a;
            p.b = b;
            return path;
          } catch {
            // next
          }
        }
    }
    if (process.env.ROUTE_DEBUG) for (const k of [p.a, p.b]) console.error(board.dump(pt(k)));
    throw new Error(`no route ${p.a} → ${p.b}`);
  };
  const wires = [];
  let n = 0;
  for (const p of plans) {
    let path;
    try {
      path = board.route(ref(p.a), ref(p.b));
    } catch {
      path = retry(p);
    }
    board.commit(path);
    wires.push({ id: `w${++n}`, a: ref(p.a), b: ref(p.b), color: colour(p.net), points: bends(path) });
  }
  project.wires = wires;
  const after = essentialNets(model, project);
  const want = [...nets].sort();
  if (JSON.stringify(after) !== JSON.stringify(want)) {
    const missing = want.filter((x) => !after.includes(x));
    const extra = after.filter((x) => !want.includes(x));
    throw new Error(`nets differ after rewiring:\n  want ${missing.join("\n       ")}\n  got  ${extra.join("\n       ")}`);
  }
  return project;
}

// ------------------------------------------------------------------- CLI

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, ...rest] = process.argv.slice(2);
  const model = await loadAppModel();
  const project = JSON.parse(readFileSync(file, "utf8"));
  const nets = essentialNets(model, project);
  const rails = {};
  const i = rest.indexOf("--rails");
  if (i >= 0) for (const r of rest[i + 1].split(",")) { const [k, v] = r.split("="); rails[k] = v; }
  rewire(model, project, nets, { rails, oldWires: project.wires });
  process.stdout.write(JSON.stringify(project, null, 2) + "\n");
}
