// The schematic: symbols from `buildSchematic`, connections as net labels.
// Hovering or clicking a label highlights the whole net; while the firmware
// runs, nets on MCU pins show their level and LEDs glow.
import { useState, type JSX } from "react";
import type { PinFrame } from "../sim/protocol";
import type { VisualState } from "../parts/types";
import { G, STUB, type SchNet, type SchPin, type SchSymbol, type Schematic } from "./layout";

const LED_HEX: Record<string, string> = {
  red: "#ef4444",
  green: "#22c55e",
  yellow: "#facc15",
  blue: "#3b82f6",
  white: "#f8fafc",
};

/** Level class of a net: from the MCU pin on it, if any. */
function levelOf(net: SchNet | undefined, pins: PinFrame[] | undefined): string {
  if (!net?.signal || !pins) return "";
  const p = pins.find((q) => `P${q.port}${q.pin}` === net.signal);
  if (!p) return "";
  if (p.duty > 0.05 && p.duty < 0.95) return " pwm";
  return p.level ? " hi" : " lo";
}

function Body({
  s,
  v,
  color,
  onAction,
}: {
  s: SchSymbol;
  v?: VisualState;
  color: string;
  onAction?: (part: string, action: string, down: boolean) => void;
}) {
  const [held, setHeld] = useState(false);
  const { x, y, w, h } = s;
  const my = y + h / 2;
  switch (s.shape) {
    case "resistor": {
      const x0 = x + G;
      const x1 = x + w - G;
      const n = 6;
      const step = (x1 - x0) / n;
      const pts = [`${x},${my}`, `${x0},${my}`];
      for (let i = 0; i < n; i++) pts.push(`${x0 + step * (i + 0.5)},${my + (i % 2 ? 6 : -6)}`);
      pts.push(`${x1},${my}`, `${x + w},${my}`);
      return <polyline className="sym-line" points={pts.join(" ")} />;
    }
    case "led": {
      const cx = x + w / 2;
      const b = v?.brightness ?? 0;
      return (
        <g>
          {b > 0.02 && <circle cx={cx} cy={my} r={14} fill={color} opacity={0.15 + 0.7 * b} className="sym-glow" />}
          <line className="sym-line" x1={x} y1={my} x2={cx - 8} y2={my} />
          <polygon className="sym-line sym-fill" points={`${cx - 8},${my - 9} ${cx - 8},${my + 9} ${cx + 8},${my}`} />
          <line className="sym-line" x1={cx + 8} y1={my - 9} x2={cx + 8} y2={my + 9} />
          <line className="sym-line" x1={cx + 8} y1={my} x2={x + w} y2={my} />
          <path className="sym-line" d={`M${cx},${my - 11} l6,-7 m-3,0 h3 v3 M${cx + 5},${my - 9} l6,-7 m-3,0 h3 v3`} />
        </g>
      );
    }
    case "switch": {
      const pressed = held || v?.pressed;
      // Hold the lever to press the switch, as on the breadboard.
      const press = (down: boolean) => {
        if (down === held) return;
        setHeld(down);
        onAction?.(s.part, "press", down);
      };
      return (
        <g
          data-action="press"
          onPointerDown={(e) => {
            e.stopPropagation();
            press(true);
          }}
          onPointerUp={() => press(false)}
          onPointerLeave={() => press(false)}
        >
          <rect className="sym-hit" x={x + G} y={my - 2 * G} width={w - 2 * G} height={2.5 * G} />
          <line className="sym-line" x1={x} y1={my} x2={x + 2 * G - 3} y2={my} />
          <circle className="sym-line sym-fill" cx={x + 2 * G} cy={my} r={3} />
          <circle className="sym-line sym-fill" cx={x + w - 2 * G} cy={my} r={3} />
          <line
            className="sym-line"
            x1={x + 2 * G}
            y1={my - 3}
            x2={x + w - 2 * G}
            y2={pressed ? my - 3 : my - 12}
          />
          <line className="sym-line" x1={x + w - 2 * G + 3} y1={my} x2={x + w} y2={my} />
        </g>
      );
    }
    case "buzzer": {
      const cx = x + w / 2;
      const on = (v?.on ?? 0) > 0.05;
      return (
        <g>
          <line className="sym-line" x1={x} y1={my} x2={cx - 10} y2={my} />
          <path className={`sym-line sym-fill${on ? " sym-on" : ""}`} d={`M${cx - 10},${my + 8} v-16 h20 v16 z`} />
          <path className="sym-line" d={`M${cx - 6},${my - 8} a8,8 0 0 1 12,0`} />
          <line className="sym-line" x1={cx + 10} y1={my} x2={x + w} y2={my} />
        </g>
      );
    }
    default:
      return <rect className="sym-line sym-fill" x={x} y={y} width={w} height={h} />;
  }
}

function PinEnd({
  p,
  net,
  level,
  lit,
  onNet,
}: {
  p: SchPin;
  net?: SchNet;
  level: string;
  lit: boolean;
  onNet: (n: string | null, pin?: boolean) => void;
}): JSX.Element {
  const left = p.side === "left";
  if (!net)
    return (
      <path className="sym-nc" d={`M${p.x - 3},${p.y - 3} l6,6 m0,-6 l-6,6`}>
        <title>연결 안 됨</title>
      </path>
    );
  const cls = `net-end${level}${lit ? " lit" : ""}`;
  const hover = {
    onMouseEnter: () => onNet(net.name),
    onMouseLeave: () => onNet(null),
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      onNet(net.name, true);
    },
  };
  const tip = <title>{`${net.name}: ${net.members.join(", ") || "보드"}`}</title>;
  if (net.power === "gnd")
    return (
      <g className={cls} data-net={net.name} {...hover}>
        {tip}
        <path className="pwr-sym" d={`M${p.x},${p.y} v8 M${p.x - 8},${p.y + 8} h16 M${p.x - 5},${p.y + 11} h10 M${p.x - 2},${p.y + 14} h4`} />
      </g>
    );
  // A flag pointing away from the symbol.
  const tw = Math.max(3 * G, net.name.length * 7 + 12);
  const d = left
    ? `M${p.x},${p.y} l-6,-7 h-${tw} v14 h${tw} z`
    : `M${p.x},${p.y} l6,-7 h${tw} v14 h-${tw} z`;
  return (
    <g className={`${cls}${net.power === "supply" ? " supply" : ""}`} data-net={net.name} {...hover}>
      {tip}
      <path className="net-flag" d={d} />
      <text className="net-text" x={left ? p.x - 6 - tw / 2 : p.x + 6 + tw / 2} y={p.y + 4} textAnchor="middle">
        {net.name}
      </text>
    </g>
  );
}

export function SchematicView({
  schematic,
  pins,
  visuals,
  selected,
  onSelect,
  parts,
  onAction,
}: {
  schematic: Schematic;
  pins?: PinFrame[];
  visuals: Record<string, VisualState>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  parts: { id: string; props: Record<string, string | number> }[];
  /** Press a switch (like the breadboard's parts). */
  onAction?: (part: string, action: string, down: boolean) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const lit = hover ?? pinned;
  const onNet = (n: string | null, pin?: boolean) => {
    if (pin) setPinned((p) => (p === n ? null : n));
    else setHover(n);
  };
  const { width, height, symbols, nets } = schematic;
  const net = lit ? nets[lit] : undefined;
  return (
    <div className="schematic-wrap" onClick={() => setPinned(null)}>
      <div className="schematic-bar">
        <button onClick={() => setZoom((z) => Math.max(0.4, z / 1.25))} aria-label="회로도 축소">
          −
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom((z) => Math.min(3, z * 1.25))} aria-label="회로도 확대">
          +
        </button>
        <span className="hint" data-testid="net-info">
          {net ? `${net.name}: ${net.members.join(", ") || "보드"}` : "넷 이름에 마우스를 올리면 같은 넷이 강조됩니다. 클릭하면 고정."}
        </span>
      </div>
      <div className="schematic-scroll">
        <svg
          className="schematic"
          width={width * zoom}
          height={height * zoom}
          viewBox={`0 0 ${width} ${height}`}
          onClick={() => onSelect(null)}
        >
          {symbols.map((s) => {
            const color = LED_HEX[String(parts.find((p) => p.id === s.part)?.props.color ?? "red")] ?? "#ef4444";
            return (
              <g
                key={s.part}
                className={`part sym sym-${s.shape}${selected === s.part ? " selected" : ""}`}
                data-part={s.part}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(s.part);
                }}
              >
                <text className="sym-title" x={s.x} y={s.y - 6}>
                  {s.title}
                  {s.subtitle && <tspan className="sym-sub"> {s.subtitle}</tspan>}
                </text>
                <Body s={s} v={visuals[s.part]} color={color} onAction={onAction} />
                {s.pins.map((p, i) => {
                  const edge = p.side === "left" ? p.x + STUB : p.x - STUB;
                  const n = p.net ? nets[p.net] : undefined;
                  const level = levelOf(n, pins);
                  return (
                    <g key={i} className="sym-pin" data-pin={p.ids.join("/")}>
                      <line className={`sym-stub${level}`} x1={edge} y1={p.y} x2={p.x} y2={p.y} />
                      {(s.shape === "box" || s.shape === "mcu") && (
                        <text
                          className="pin-name"
                          x={p.side === "left" ? edge + 4 : edge - 4}
                          y={p.y + 4}
                          textAnchor={p.side === "left" ? "start" : "end"}
                        >
                          {p.name}
                        </text>
                      )}
                      <PinEnd p={p} net={n} level={level} lit={!!p.net && p.net === lit} onNet={onNet} />
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
