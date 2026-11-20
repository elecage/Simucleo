// The schematic: symbols from `buildSchematic`, connections as net labels.
// Hovering or clicking a label highlights the whole net; while the firmware
// runs, nets on MCU pins show their level and LEDs glow.
//
// Wiring (M18): drag from one pin end (stub tip, net flag, ground or supply
// symbol, the "not connected" X) to another to add a wire between the two
// pins. A click on a pin end pins its net and selects the pin, which
// "연결 끊기" or Delete disconnects. The project stays the only source of
// truth: App turns both into wires, and the schematic is drawn again.
import { useEffect, useRef, useState, type JSX, type PointerEvent as RPointerEvent } from "react";
import type { PinFrame } from "../sim/protocol";
import type { VisualState } from "../parts/types";
import { G, STUB, type SchNet, type SchPin, type SchSymbol, type Schematic } from "./layout";
import { t } from "../i18n";

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
      return (
        <g>
          <rect className="sym-line sym-fill" x={x} y={y} width={w} height={h} />
          {s.kind === "relay" && <RelayInside s={s} v={v} />}
        </g>
      );
  }
}

/** Inside a relay module's box: the coil and the change-over contact
 * (COM to NO while energised, else to NC), linked by a dashed line. */
function RelayInside({ s, v }: { s: SchSymbol; v?: VisualState }) {
  const { x, y } = s;
  const row = (i: number) => y + (2 * i + 2) * G; // pin rows: NO, COM, NC
  const closed = !!v?.closed;
  const coil = (v?.on ?? 0) > 0.5;
  const pivot = [x + 8 * G, row(1)];
  const contact = (i: number) => [x + 11 * G, row(i)];
  const tip = closed ? [x + 11 * G, row(0) + 3] : [x + 11 * G, row(2) - 3];
  return (
    <g data-closed={closed ? "1" : "0"}>
      <rect className={`sym-line${coil ? " sym-on" : ""}`} x={x + 3 * G} y={row(0) + G / 2} width={2.4 * G} height={3 * G} fill="none" />
      <line className="sym-line" x1={x + 3 * G} y1={row(2) - G / 2} x2={x + 5.4 * G} y2={row(0) + G / 2} />
      <line className="sym-line" x1={x + 5.4 * G} y1={row(1)} x2={pivot[0]} y2={pivot[1] + (closed ? -1 : 1) * G} strokeDasharray="3 3" />
      {/* COM to the pivot, NO and NC contacts to their pins. */}
      <line className="sym-line" x1={pivot[0]} y1={pivot[1]} x2={x + 12.5 * G} y2={row(1)} />
      <line className="sym-line" x1={pivot[0]} y1={pivot[1]} x2={tip[0]} y2={tip[1]} />
      {[0, 2].map((i) => (
        <g key={i}>
          <circle className="sym-line sym-fill" cx={contact(i)[0]} cy={contact(i)[1]} r={2.5} />
          <line className="sym-line" x1={contact(i)[0] + 2.5} y1={row(i)} x2={x + 12.5 * G} y2={row(i)} />
        </g>
      ))}
      <circle className="sym-line sym-fill" cx={pivot[0]} cy={pivot[1]} r={2.5} />
    </g>
  );
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
  onNet: (n: string | null) => void;
}): JSX.Element {
  const left = p.side === "left";
  if (!net)
    return (
      <path className="sym-nc" d={`M${p.x - 3},${p.y - 3} l6,6 m0,-6 l-6,6`}>
        <title>{t("연결 안 됨")}</title>
      </path>
    );
  const cls = `net-end${level}${lit ? " lit" : ""}`;
  const hover = {
    onMouseEnter: () => onNet(net.name),
    onMouseLeave: () => onNet(null),
  };
  const tip = <title>{`${net.name}: ${net.members.join(", ") || t("보드")}`}</title>;
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

/** A pin end of the drawing: a part and the pins its terminal stands for. */
export interface SchEnd {
  part: string;
  ids: string[];
}

interface End extends SchEnd {
  key: string;
  /** Name shown for it (R1.2, nucleo.PA5). */
  label: string;
  net: string | null;
  x: number;
  y: number;
}

const endKey = (part: string, ids: string[]) => `${part}|${ids.join("/")}`;

/** A press on a pin end: a click if it does not move, else a new wire. */
interface Drag {
  pointer: number;
  from: End;
  sx: number;
  sy: number;
  moved: boolean;
  /** The pointer, in drawing units. */
  at: { x: number; y: number };
  /** The pin end it is over (where the wire would go). */
  over: End | null;
}

/** Screen distance before a press on a pin end becomes a drag. */
const DRAG_START = 4;
/** How near (drawing units) a drop must be to a pin end to land on it. */
const SNAP = 14;

export function SchematicView({
  schematic,
  pins,
  visuals,
  selected,
  onSelect,
  parts,
  onAction,
  allPins = false,
  onAllPins,
  onConnect,
  onDisconnect,
  marks,
}: {
  schematic: Schematic;
  pins?: PinFrame[];
  visuals: Record<string, VisualState>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  parts: { id: string; props: Record<string, string | number> }[];
  /** Press a switch (like the breadboard's parts). */
  onAction?: (part: string, action: string, down: boolean) => void;
  /** Every MCU pin is listed (for wiring to one not in use yet). */
  allPins?: boolean;
  onAllPins?: (on: boolean) => void;
  /** A wire was drawn from one pin end to another. */
  onConnect?: (a: SchEnd, b: SchEnd) => void;
  /** Remove the wires on a pin. */
  onDisconnect?: (end: SchEnd) => void;
  /** Pins (`part:pin`) of wiring checks that failed at grading (M24). */
  marks?: Set<string>;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [selKey, setSelKey] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  // The click that follows a press handled here (it would deselect).
  const swallow = useRef(false);
  const lit = hover ?? pinned;
  const onNet = (n: string | null) => {
    if (!drag) setHover(n);
  };
  const { width, height, symbols, nets } = schematic;
  const net = lit ? nets[lit] : undefined;

  const ends: End[] = symbols.flatMap((s) =>
    s.pins.map((p) => ({
      part: s.part,
      ids: p.ids,
      key: endKey(s.part, p.ids),
      label: `${s.part}.${s.shape === "mcu" ? p.name.replace(/ .*/, "") : p.name}`,
      net: p.net,
      x: p.x,
      y: p.y,
    })),
  );
  const selEnd = ends.find((e) => e.key === selKey) ?? null;

  // Selecting a part (here or on the breadboard) drops the pin selection.
  useEffect(() => {
    if (selected) setSelKey(null);
  }, [selected]);

  const toDrawing = (e: { clientX: number; clientY: number }) => {
    const m = svgRef.current?.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };
  /** The pin end under the pointer: the one drawn there, else the nearest. */
  const endAt = (e: { clientX: number; clientY: number }): End | null => {
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-end]");
    const hit = el && ends.find((x) => x.key === el.getAttribute("data-end"));
    if (hit) return hit;
    const p = toDrawing(e);
    let best: End | null = null;
    let d = SNAP;
    for (const x of ends) {
      const dd = Math.hypot(x.x - p.x, x.y - p.y);
      if (dd < d) {
        d = dd;
        best = x;
      }
    }
    return best;
  };

  const swallowClick = () => {
    swallow.current = true;
    // Only the click of this press: it comes right after the release.
    setTimeout(() => (swallow.current = false), 0);
  };
  const swallowed = () => {
    if (!swallow.current) return false;
    swallow.current = false;
    return true;
  };

  const press = (e: RPointerEvent, end: End) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.stopPropagation();
    if (drag) return; // a second finger
    try {
      svgRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // A synthetic pointer: the press still ends on its pointerup.
    }
    setDrag({ pointer: e.pointerId, from: end, sx: e.clientX, sy: e.clientY, moved: false, at: toDrawing(e), over: null });
  };
  const move = (e: RPointerEvent) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    const moved = drag.moved || Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > DRAG_START;
    if (moved && !drag.moved) setHover(null);
    const over = moved ? endAt(e) : null;
    setDrag({ ...drag, moved, at: toDrawing(e), over: over && over.key !== drag.from.key ? over : null });
  };
  const release = (e: RPointerEvent) => {
    if (!drag || e.pointerId !== drag.pointer) return;
    if (svgRef.current?.hasPointerCapture(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId);
    swallowClick();
    const { from } = drag;
    setDrag(null);
    if (!drag.moved) {
      // A click: pin the net and select the pin (or let go of both).
      if (selKey === from.key) {
        setSelKey(null);
        setPinned(null);
      } else {
        setSelKey(from.key);
        setPinned(from.net);
        onSelect(null);
      }
      return;
    }
    const to = endAt(e);
    // Dropped on empty space (or back on itself): nothing.
    if (to && to.key !== from.key) onConnect?.({ part: from.part, ids: from.ids }, { part: to.part, ids: to.ids });
  };
  const cancel = () => {
    setDrag(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === "Escape") {
        if (drag) setDrag(null);
        else if (selKey) {
          setSelKey(null);
          setPinned(null);
        }
      } else if ((e.key === "Delete" || e.key === "Backspace") && selEnd && !drag) {
        // The pin, not the part: before the app's Delete handler.
        e.preventDefault();
        e.stopImmediatePropagation();
        onDisconnect?.({ part: selEnd.part, ids: selEnd.ids });
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const target = drag?.moved ? drag.over : null;
  return (
    <div
      className="schematic-wrap"
      onClick={() => {
        if (swallowed()) return;
        setPinned(null);
        setSelKey(null);
      }}
    >
      <div className="schematic-bar" onClick={(e) => e.stopPropagation()}>
        <button onClick={() => setZoom((z) => Math.max(0.4, z / 1.25))} aria-label={t("회로도 축소")}>
          −
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom((z) => Math.min(3, z * 1.25))} aria-label={t("회로도 확대")}>
          +
        </button>
        <label className="all-pins" title={t("쓰지 않는 MCU 핀과 전원 핀(3V3, 5V, GND, …)도 보여, 그 핀에 배선할 수 있습니다")}>
          <input type="checkbox" checked={allPins} onChange={(e) => onAllPins?.(e.target.checked)} /> {t("모든 MCU 핀")}
        </label>
        {!!marks?.size && (
          <span className="sch-marks" data-testid="sch-marks">
            {t("🔴 채점: 틀린 배선 검사의 핀·넷")}
          </span>
        )}
        {selEnd && (
          <span className="pin-selection" data-testid="pin-selection">
            {t("선택:")} <b>{selEnd.label}</b>
            {selEnd.net ? ` (${selEnd.net})` : ` (${t("연결 안 됨")})`}{" "}
            <button onClick={() => onDisconnect?.({ part: selEnd.part, ids: selEnd.ids })}>{t("연결 끊기")}</button>
          </span>
        )}
        <span className="hint" data-testid="net-info">
          {drag?.moved
            ? target
              ? t("{from} → {to}: 놓으면 와이어가 생깁니다", { from: drag.from.label, to: target.label })
              : t("{from}에서 배선 중: 다른 핀 끝에 놓으세요 (Esc 또는 빈 곳에 놓으면 취소)", { from: drag.from.label })
            : net
              ? `${net.name}: ${net.members.join(", ") || t("보드")}`
              : t("넷 이름에 마우스를 올리면 같은 넷이 강조됩니다. 핀 끝을 클릭하면 넷 고정 + 핀 선택(연결 끊기·Delete), 핀 끝에서 다른 핀 끝으로 끌면 배선.")}
        </span>
      </div>
      <div className="schematic-scroll">
        <svg
          ref={svgRef}
          className={drag?.moved ? "schematic wiring" : "schematic"}
          width={width * zoom}
          height={height * zoom}
          viewBox={`0 0 ${width} ${height}`}
          onClick={() => {
            if (swallow.current) return; // the wrap's handler takes it
            onSelect(null);
          }}
          onPointerMove={move}
          onPointerUp={release}
          onPointerCancel={cancel}
          onLostPointerCapture={(e) => {
            // Released somewhere we did not see (the pointerup already ran otherwise).
            if (drag && e.pointerId === drag.pointer) setTimeout(() => setDrag((d) => (d?.pointer === e.pointerId ? null : d)), 0);
          }}
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
                  if (swallowed()) return;
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
                  const key = endKey(s.part, p.ids);
                  const end = ends.find((x) => x.key === key)!;
                  const marked = !!marks && p.ids.some((id) => marks.has(`${s.part}:${id}`));
                  return (
                    <g
                      key={i}
                      className={marked ? "sym-pin marked" : "sym-pin"}
                      data-pin={p.ids.join("/")}
                      data-mark={marked ? "fail" : undefined}
                    >
                      {marked && <circle className="pin-mark" cx={p.x} cy={p.y} r={10} />}
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
                      <g
                        className={`pin-end${selKey === key ? " sel" : ""}${target?.key === key ? " target" : ""}`}
                        data-end={key}
                        onPointerDown={(e) => press(e, end)}
                      >
                        {/* The stub tip: easy to grab, also with a finger. */}
                        <circle className="pin-hit" cx={p.x} cy={p.y} r={7} />
                        <PinEnd p={p} net={n} level={level} lit={!!p.net && p.net === lit} onNet={onNet} />
                        {selKey === key && <circle className="pin-sel" cx={p.x} cy={p.y} r={6} />}
                      </g>
                    </g>
                  );
                })}
              </g>
            );
          })}
          {drag?.moved && (
            <line
              className="sch-rubber"
              x1={drag.from.x}
              y1={drag.from.y}
              x2={target ? target.x : drag.at.x}
              y2={target ? target.y : drag.at.y}
            />
          )}
        </svg>
      </div>
    </div>
  );
}
