// Drawings that show a part being operated by hand (M14).
import { PITCH } from "./types";

const P = PITCH;

/** A fingertip pressed on a sensor at (x, y), with the warmth it brings. */
export function Fingertip({ x, y, scale = 1 }: { x: number; y: number; scale?: number }) {
  const r = 0.9 * P * scale;
  return (
    <g className="fingertip" data-touched="1" pointerEvents="none">
      <circle cx={x} cy={y} r={1.6 * r} className="heat-glow" />
      <ellipse cx={x} cy={y} rx={r} ry={1.2 * r} className="finger-pad" />
      {/* Fingerprint ridges. */}
      {[0.35, 0.6, 0.85].map((k) => (
        <ellipse key={k} cx={x} cy={y + 0.1 * r} rx={k * r * 0.8} ry={k * r} className="finger-ridge" />
      ))}
    </g>
  );
}
