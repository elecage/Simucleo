// M35: the RC522 part's cards — a click puts one on the antenna or takes it
// off, a drag drops it where it is released (`npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { ANTENNA, TAGS, onAntenna, tagCentre, tagControl } from "../src/parts/rfidTags.ts";
import { PITCH } from "../src/parts/types.ts";

const at = (x: number, y: number, t = 0) => ({ x: x * PITCH, y: y * PITCH, clientX: 0, clientY: 0, t });

/** Press on tag n's centre, move to (x, y) in steps, release there. */
function gesture(n: number, card: number, to?: { x: number; y: number }) {
  const c = tagCentre(n, card);
  const s = tagControl(n).start(at(c.x, c.y), { card });
  const end = to ?? c;
  for (let i = 1; i <= 4; i++) s.move?.(at(c.x + ((end.x - c.x) * i) / 4, c.y + ((end.y - c.y) * i) / 4));
  return s.release?.(at(end.x, end.y));
}

test("tags rest in the tray, the one on the antenna in its middle", () => {
  assert.equal(TAGS.length, 4);
  for (const tag of TAGS) {
    const c = tagCentre(tag.n, 0);
    assert.ok(!onAntenna(c.x, c.y), `tag ${tag.n} in the tray`);
    const on = tagCentre(tag.n, tag.n);
    assert.ok(onAntenna(on.x, on.y));
  }
  assert.ok(onAntenna((ANTENNA.x0 + ANTENNA.x1) / 2, ANTENNA.y0 + 0.1));
});

test("a click toggles a tag on and off the antenna", () => {
  assert.deepEqual(gesture(3, 0), { card: 3 });
  assert.deepEqual(gesture(3, 3), { card: 0 });
  // Another card lies there: the clicked one takes its place.
  assert.deepEqual(gesture(1, 3), { card: 1 });
});

test("a drag onto the antenna places the tag, off it takes it away", () => {
  assert.deepEqual(gesture(2, 0, { x: 4, y: 4 }), { card: 2 });
  assert.deepEqual(gesture(2, 2, { x: 13, y: 9 }), { card: 0 });
  // Dragged within the tray: what lay on the antenna stays.
  assert.deepEqual(gesture(4, 1, { x: 12, y: 3 }), { card: 1 });
  // Dropped onto the antenna over another tag: it replaces it.
  assert.deepEqual(gesture(4, 1, { x: 5, y: 5 }), { card: 4 });
});
