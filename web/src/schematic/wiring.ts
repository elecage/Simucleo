// Pure helpers for wiring on the schematic (M18): which MCU pins the symbol
// lists, which real pin a schematic terminal stands for, how the new wire
// runs on the breadboard, and keeping the symbols in place as wires come
// and go. No imports of parts or React, so `npm test` can load it directly.
import type { Point } from "../editor/model.ts";

/** Board power signals drawn as supply symbols. */
export const POWER_SIGNALS = new Set(["3V3", "5V", "E5V", "VIN", "IOREF", "VBAT"]);

/** MCU signals in port order (PA0, PA1, … PB0, …); others after. */
export function signalOrder(s: string): number {
  const m = /^P([A-H])(\d+)$/.exec(s);
  return m ? (m[1].charCodeAt(0) - 65) * 16 + Number(m[2]) : 1000;
}

const isPower = (s: string) => POWER_SIGNALS.has(s) || s === "GND";

/** I/O in port order (then RESET, BOOT0), then the supply pins and GND. */
export function compareSignals(a: string, b: string): number {
  return Number(isPower(a)) - Number(isPower(b)) || signalOrder(a) - signalOrder(b) || a.localeCompare(b);
}

/**
 * Which side of the MCU symbol each signal goes on. Normally only the
 * signals in use, all on the right (next to the parts). With every pin
 * shown the list is long, so it is split over both sides: ports A and B on
 * the left, the other ports and the supply pins on the right, each side in
 * a fixed order so a pin keeps its place as wires come and go.
 */
export function mcuSides(signals: string[], all: boolean): { left: string[]; right: string[] } {
  const sorted = [...new Set(signals)].sort(compareSignals);
  if (!all) return { left: [], right: sorted };
  const left = sorted.filter((s) => /^P[AB]\d+$/.test(s));
  const right = sorted.filter((s) => !/^P[AB]\d+$/.test(s));
  return { left, right };
}

export interface PinChoice {
  id: string;
  /** Grid position of the pin on the breadboard view. */
  at: Point;
  /** A wire already ends on it. */
  used: boolean;
}

/** Board pins that students wire to: Arduino headers before Morpho (CN7/CN10). */
const headerRank = (id: string) => (/^CN\d+_/.test(id) ? 1 : 0);

/**
 * The pin a schematic terminal stands for when a wire is drawn to it: of
 * bused pins (all of a board's GND pins, the two legs of a switch side),
 * a free one before one that already has a wire, an Arduino header pin
 * before a Morpho one, then the one nearest the other end.
 */
export function choosePin(options: PinChoice[], toward: Point): PinChoice | undefined {
  const dist = (p: Point) => Math.abs(p.x - toward.x) + Math.abs(p.y - toward.y);
  return [...options].sort(
    (a, b) =>
      Number(a.used) - Number(b.used) ||
      headerRank(a.id) - headerRank(b.id) ||
      dist(a.at) - dist(b.at) ||
      a.id.localeCompare(b.id),
  )[0];
}

/** Drop repeated and in-line points, and points on the ends. */
function tidy(a: Point, pts: Point[], b: Point): Point[] {
  const all = [a, ...pts, b];
  const out: Point[] = [a];
  for (let i = 1; i < all.length; i++) {
    const p = all[i];
    const q = out[out.length - 1];
    if (p.x === q.x && p.y === q.y) continue;
    if (out.length >= 2) {
      const r = out[out.length - 2];
      // q lies on the straight line r → p (same row or column): not a bend.
      if ((r.x === q.x && q.x === p.x) || (r.y === q.y && q.y === p.y)) out.pop();
    }
    out.push(p);
  }
  return out.slice(1, -1);
}

/**
 * Bend points (grid units) of a wire from `a` to `b` on the breadboard:
 * square corners instead of a diagonal across everything. An end on the
 * board leaves it straight up or down to `exit` (just outside the board,
 * clear of its headers) before turning; otherwise one L bend.
 */
export function routePoints(a: Point, b: Point, exitA?: number, exitB?: number): Point[] {
  const pts: Point[] = [];
  let cur = a;
  if (exitA !== undefined) {
    cur = { x: a.x, y: exitA };
    pts.push(cur);
  }
  const last = exitB !== undefined ? { x: b.x, y: exitB } : b;
  // Across, then along: one corner between the two.
  if (cur.x !== last.x && cur.y !== last.y) pts.push(exitA !== undefined || exitB === undefined ? { x: last.x, y: cur.y } : { x: cur.x, y: last.y });
  if (exitB !== undefined) pts.push(last);
  return tidy(a, pts, b);
}

/** Where a wire leaving a board pin turns: above the board for pins in its
 * upper half, below it for the others; `lane` steps further out, so wires
 * made one after another do not run on top of each other. */
export function boardExit(pinY: number, board: { y: number; h: number }, lane = 0): number {
  return pinY - board.y < board.h / 2 ? board.y - 2 - lane : board.y + board.h + 2 + lane;
}

/**
 * Keep the symbols where they were: the parts of the previous drawing in
 * their previous order, and each new one after the part it follows in the
 * ideal (by-MCU-pin) order. Without a previous order, the ideal one.
 */
export function stableOrder(ideal: string[], previous: string[]): string[] {
  const present = new Set(ideal);
  const out = previous.filter((id) => present.has(id));
  const placed = new Set(out);
  ideal.forEach((id, i) => {
    if (placed.has(id)) return;
    // After the nearest part before it in the ideal order that is placed.
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = out.indexOf(ideal[j]);
      if (k >= 0) {
        at = k + 1;
        break;
      }
    }
    out.splice(at, 0, id);
    placed.add(id);
  });
  return out;
}
