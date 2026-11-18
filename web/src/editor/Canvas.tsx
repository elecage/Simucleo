import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { PART_BY_KIND } from "../parts";
import { PITCH } from "../parts/types";
import { pinKey, pinPosition, type PinRef, type Project } from "./model";

interface Props {
  project: Project;
  /** Pin keys (`part:pin`) electrically connected to the hovered pin. */
  netOf: (pin: PinRef) => Set<string>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onMovePart: (id: string, x: number, y: number) => void;
  onAddWire: (a: PinRef, b: PinRef) => void;
}

type Drag =
  | { kind: "part"; id: string; dx: number; dy: number }
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number };

const LAYER: Record<string, number> = { board: 0, basic: 1 };

export function Canvas({ project, netOf, selected, onSelect, onMovePart, onAddWire }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1.6 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [pendingWire, setPendingWire] = useState<PinRef | null>(null);
  const [mouse, setMouse] = useState({ x: 0, y: 0 });
  const [hover, setHover] = useState<{ pin: PinRef; label: string } | null>(null);

  const partById = new Map(project.parts.map((p) => [p.id, p]));
  const highlighted = hover ? netOf(hover.pin) : new Set<string>();

  // Screen → canvas units.
  const toCanvas = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / view.scale + view.x, y: (e.clientY - r.top) / view.scale + view.y };
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPendingWire(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** Route all pointer events to the canvas until the button is released,
   * even outside it, so a drag always ends (#3). */
  const startDrag = (e: RPointerEvent, d: Drag) => {
    svgRef.current?.setPointerCapture(e.pointerId);
    setDrag(d);
  };
  const endDrag = (e: RPointerEvent) => {
    if (svgRef.current?.hasPointerCapture(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId);
    setDrag(null);
  };

  const onPointerMove = (e: RPointerEvent) => {
    if (drag && e.buttons === 0) {
      // The release happened somewhere we could not see it.
      setDrag(null);
      return;
    }
    const p = toCanvas(e);
    setMouse(p);
    if (drag?.kind === "part") {
      onMovePart(drag.id, Math.round(p.x / PITCH - drag.dx), Math.round(p.y / PITCH - drag.dy));
    } else if (drag?.kind === "pan") {
      setView((v) => ({ ...v, x: drag.vx - (e.clientX - drag.sx) / v.scale, y: drag.vy - (e.clientY - drag.sy) / v.scale }));
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    const p = toCanvas(e);
    const scale = Math.min(6, Math.max(0.4, view.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    const r = svgRef.current!.getBoundingClientRect();
    setView({ scale, x: p.x - (e.clientX - r.left) / scale, y: p.y - (e.clientY - r.top) / scale });
  };

  // Cancel a wire in progress whose starting part was deleted (#2).
  const pendingValid = pendingWire !== null && partById.has(pendingWire.part);
  useEffect(() => {
    if (pendingWire && !project.parts.some((p) => p.id === pendingWire.part)) setPendingWire(null);
  }, [project.parts, pendingWire]);

  const clickPin = (pin: PinRef) => {
    if (!pendingWire || !pendingValid) setPendingWire(pin);
    else {
      if (pinKey(pendingWire) !== pinKey(pin)) onAddWire(pendingWire, pin);
      setPendingWire(null);
    }
  };

  const absPin = (ref: PinRef) => {
    const part = partById.get(ref.part);
    const pos = part && pinPosition(part, ref.pin);
    return pos && { x: pos.x * PITCH, y: pos.y * PITCH };
  };

  const ordered = [...project.parts].sort(
    (a, b) => (LAYER[PART_BY_KIND[a.kind]?.category] ?? 2) - (LAYER[PART_BY_KIND[b.kind]?.category] ?? 2),
  );
  const pendingStart = pendingValid && pendingWire ? absPin(pendingWire) : undefined;

  return (
    <div className="canvas-wrap">
      <svg
        ref={svgRef}
        className="canvas"
        viewBox={`${view.x} ${view.y} ${(svgRef.current?.clientWidth ?? 1200) / view.scale} ${(svgRef.current?.clientHeight ?? 800) / view.scale}`}
        onPointerDown={(e) => {
          if (e.target === svgRef.current) {
            onSelect(null);
            startDrag(e, { kind: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y });
          }
        }}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={() => setDrag(null)}
        onWheel={onWheel}
      >
        <defs>
          <pattern id="grid" width={PITCH} height={PITCH} patternUnits="userSpaceOnUse">
            <circle cx={0} cy={0} r={0.6} className="grid-dot" />
          </pattern>
        </defs>
        <rect x={view.x - 5000} y={view.y - 5000} width={20000} height={20000} fill="url(#grid)" pointerEvents="none" />

        {ordered.map((part) => {
          const def = PART_BY_KIND[part.kind];
          if (!def) return null;
          return (
            <g
              key={part.id}
              data-id={part.id}
              transform={`translate(${part.x * PITCH} ${part.y * PITCH})`}
              className={selected === part.id ? "part selected" : "part"}
            >
              <g
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onSelect(part.id);
                  const p = toCanvas(e);
                  startDrag(e, { kind: "part", id: part.id, dx: p.x / PITCH - part.x, dy: p.y / PITCH - part.y });
                }}
              >
                {def.render({ ...def.props, ...part.props }, {})}
              </g>
            </g>
          );
        })}

        {project.wires.map((w) => {
          const a = absPin(w.a);
          const b = absPin(w.b);
          if (!a || !b) return null;
          const sag = Math.min(40, Math.hypot(b.x - a.x, b.y - a.y) / 4);
          return (
            <path
              key={w.id}
              d={`M ${a.x} ${a.y} C ${a.x} ${a.y + sag}, ${b.x} ${b.y + sag}, ${b.x} ${b.y}`}
              stroke={w.color}
              className={selected === w.id ? "wire selected" : "wire"}
              onPointerDown={(e) => {
                e.stopPropagation();
                onSelect(w.id);
              }}
            />
          );
        })}
        {/* Pins sit above wires so a wired pin can still be hovered or wired again. */}
        {ordered.map((part) => (
          <g key={part.id} transform={`translate(${part.x * PITCH} ${part.y * PITCH})`} data-pins={part.id}>
            {(PART_BY_KIND[part.kind]?.pins ?? []).map((pin) => {
              const ref = { part: part.id, pin: pin.id };
              const key = pinKey(ref);
              return (
                <circle
                  key={pin.id}
                  data-pin={pin.id}
                  cx={pin.x * PITCH}
                  cy={pin.y * PITCH}
                  r={3.2}
                  className={highlighted.has(key) ? "pin hot" : pendingWire && pinKey(pendingWire) === key ? "pin pending" : "pin"}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    clickPin(ref);
                  }}
                  onPointerEnter={() => setHover({ pin: ref, label: `${part.id}.${pin.label ?? pin.id}` })}
                  onPointerLeave={() => setHover(null)}
                />
              );
            })}
          </g>
        ))}
        {pendingStart && (
          <line x1={pendingStart.x} y1={pendingStart.y} x2={mouse.x} y2={mouse.y} className="wire-preview" />
        )}
      </svg>
      {hover && <div className="tooltip">{hover.label}</div>}
    </div>
  );
}
