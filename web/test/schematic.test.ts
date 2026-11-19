// Unit tests of the schematic wiring helpers (M18): the MCU pin lists,
// which pin a terminal stands for, the breadboard route, stable order.
import { test } from "node:test";
import assert from "node:assert/strict";
import { boardExit, choosePin, mcuSides, routePoints, stableOrder } from "../src/schematic/wiring.ts";

test("mcuSides: only the signals in use, on the right, I/O before power", () => {
  const s = mcuSides(["GND", "PA5", "3V3", "PA10", "PB3", "PA5"], false);
  assert.deepEqual(s.left, []);
  assert.deepEqual(s.right, ["PA5", "PA10", "PB3", "3V3", "GND"]);
});

test("mcuSides: every pin over both sides, ports A/B left, the rest and power right", () => {
  const all = ["PC13", "GND", "PB0", "5V", "PA0", "RESET", "PA15", "PH0", "3V3", "PD2", "PB15", "BOOT0", "VIN"];
  const s = mcuSides(all, true);
  assert.deepEqual(s.left, ["PA0", "PA15", "PB0", "PB15"]);
  assert.deepEqual(s.right, ["PC13", "PD2", "PH0", "BOOT0", "RESET", "3V3", "5V", "GND", "VIN"]);
  // Every signal once, none lost.
  assert.equal(s.left.length + s.right.length, all.length);
});

test("choosePin: of bused board pins, a free Arduino header pin near the other end", () => {
  const gnd = [
    { id: "CN7_8", at: { x: 18, y: 31 }, used: false },
    { id: "GND_P1", at: { x: 24, y: 26 }, used: true },
    { id: "GND_P2", at: { x: 25, y: 26 }, used: false },
    { id: "GND_D", at: { x: 19, y: 6 }, used: false },
  ];
  // GND_P1 has a wire already: the next header pin, nearer than GND_D.
  assert.equal(choosePin(gnd, { x: 50, y: 30 })!.id, "GND_P2");
  // Toward the top of the board, the top header's GND.
  assert.equal(choosePin(gnd, { x: 19, y: 0 })!.id, "GND_D");
  // Arduino before Morpho even when Morpho is nearer.
  const pa5 = [
    { id: "CN10_11", at: { x: 16, y: 3 }, used: false },
    { id: "D13", at: { x: 20, y: 6 }, used: false },
  ];
  assert.equal(choosePin(pa5, { x: 16, y: 0 })!.id, "D13");
  // All used: still a pin (wires may share one).
  assert.equal(choosePin([{ id: "1a", at: { x: 0, y: 0 }, used: true }], { x: 5, y: 5 })!.id, "1a");
  assert.equal(choosePin([], { x: 0, y: 0 }), undefined);
});

test("choosePin: a switch side picks the leg nearer the other end", () => {
  const side = [
    { id: "1a", at: { x: 10, y: 10 }, used: false },
    { id: "1b", at: { x: 10, y: 14 }, used: false },
  ];
  assert.equal(choosePin(side, { x: 30, y: 15 })!.id, "1b");
  assert.equal(choosePin(side, { x: 30, y: 8 })!.id, "1a");
});

/** Every segment of a route is horizontal or vertical. */
function square(a: { x: number; y: number }, pts: { x: number; y: number }[], b: { x: number; y: number }) {
  const all = [a, ...pts, b];
  for (let i = 1; i < all.length; i++) {
    assert.ok(all[i].x === all[i - 1].x || all[i].y === all[i - 1].y, `diagonal ${JSON.stringify(all.slice(i - 1, i + 1))}`);
  }
}

test("routePoints: one L bend between two parts, none when in line", () => {
  const a = { x: 50, y: 10 };
  const b = { x: 60, y: 14 };
  const pts = routePoints(a, b);
  assert.deepEqual(pts, [{ x: 60, y: 10 }]);
  square(a, pts, b);
  assert.deepEqual(routePoints({ x: 1, y: 5 }, { x: 9, y: 5 }), []);
  assert.deepEqual(routePoints({ x: 3, y: 1 }, { x: 3, y: 9 }), []);
  assert.deepEqual(routePoints({ x: 3, y: 1 }, { x: 3, y: 1 }), []);
});

test("routePoints: a board pin leaves the board straight out before turning", () => {
  const board = { y: 2, h: 32 };
  const d13 = { x: 16, y: 6 };
  const exit = boardExit(d13.y, board);
  assert.equal(exit, 0); // above the board
  assert.equal(boardExit(26, board), 36); // a bottom header: below it
  // Further out in another lane.
  assert.equal(boardExit(6, board, 2), -2);
  assert.equal(boardExit(26, board, 1), 37);
  const r = { x: 50, y: 10 };
  const pts = routePoints(d13, r, exit);
  assert.deepEqual(pts, [{ x: 16, y: 0 }, { x: 50, y: 0 }]);
  square(d13, pts, r);
  // The other way round: along outside the board, then down into the pin.
  const back = routePoints(r, d13, undefined, exit);
  assert.deepEqual(back, [{ x: 50, y: 0 }, { x: 16, y: 0 }]);
  square(r, back, d13);
  // Board to board, top to bottom header.
  const gnd = { x: 24, y: 26 };
  const jump = routePoints(d13, gnd, 0, 36);
  square(d13, jump, gnd);
});

test("stableOrder: known parts keep their places, a new one goes where it ranks", () => {
  assert.deepEqual(stableOrder(["a", "b", "c"], []), ["a", "b", "c"]);
  // A wire made c rank first: the drawing keeps a, b, c.
  assert.deepEqual(stableOrder(["c", "a", "b"], ["a", "b", "c"]), ["a", "b", "c"]);
  // A new part d ranks after a: right after it.
  assert.deepEqual(stableOrder(["a", "d", "b", "c"], ["a", "b", "c"]), ["a", "d", "b", "c"]);
  // A new part first in rank: at the start.
  assert.deepEqual(stableOrder(["d", "c", "b"], ["b", "c"]), ["d", "b", "c"]);
  // Deleted parts are dropped.
  assert.deepEqual(stableOrder(["b"], ["a", "b", "c"]), ["b"]);
});
