import { PITCH, type PartDef, type PinDef } from "./types";

const COLS = 30;
const TOP = ["a", "b", "c", "d", "e"];
const BOTTOM = ["f", "g", "h", "i", "j"];
const W = COLS + 3;
const H = 20;

// Vertical layout in grid steps.
const RAIL_Y = { tp: 1, tn: 2, bp: H - 2, bn: H - 1 } as const;
const ROW_Y: Record<string, number> = {};
TOP.forEach((r, i) => (ROW_Y[r] = 4 + i));
BOTTOM.forEach((r, i) => (ROW_Y[r] = 11 + i));

const pins: PinDef[] = [];
const buses: string[][] = [];

for (let c = 1; c <= COLS; c++) {
  const x = c + 1;
  for (const r of [...TOP, ...BOTTOM]) pins.push({ id: `${r}${c}`, x, y: ROW_Y[r], label: `${r}${c}` });
  buses.push(TOP.map((r) => `${r}${c}`), BOTTOM.map((r) => `${r}${c}`));
}
for (const [rail, y] of Object.entries(RAIL_Y)) {
  const ids: string[] = [];
  for (let c = 1; c <= COLS; c++) {
    if (c % 6 === 0) continue; // gap between groups of five, like real rails
    const id = `${rail}${c}`;
    ids.push(id);
    pins.push({ id, x: c + 1, y, label: rail.endsWith("p") ? "+" : "−" });
  }
  buses.push(ids);
}

export const breadboardHalf: PartDef = {
  kind: "breadboard-half",
  name: "브레드보드 (하프)",
  category: "basic",
  w: W,
  h: H + 1,
  pins,
  buses,
  render: () => (
    <g>
      <rect width={W * PITCH} height={(H + 1) * PITCH} rx={4} className="breadboard" />
      <rect x={PITCH} y={9.2 * PITCH} width={(W - 2) * PITCH} height={0.6 * PITCH} className="bb-channel" />
      <line x1={PITCH} x2={(W - 1) * PITCH} y1={0.4 * PITCH} y2={0.4 * PITCH} className="rail-pos" />
      <line x1={PITCH} x2={(W - 1) * PITCH} y1={2.6 * PITCH} y2={2.6 * PITCH} className="rail-neg" />
      <line x1={PITCH} x2={(W - 1) * PITCH} y1={(H - 2.6) * PITCH} y2={(H - 2.6) * PITCH} className="rail-pos" />
      <line x1={PITCH} x2={(W - 1) * PITCH} y1={(H - 0.4) * PITCH} y2={(H - 0.4) * PITCH} className="rail-neg" />
      {pins.map((p) => (
        <rect key={p.id} x={p.x * PITCH - 2.5} y={p.y * PITCH - 2.5} width={5} height={5} className="hole" />
      ))}
    </g>
  ),
};
