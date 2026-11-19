import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { PART_BY_KIND } from "../parts";
import { PITCH, type ControlPointer, type ControlSession, type PropValues, type VisualState } from "../parts/types";
import { pinKey, pinPosition, type PinRef, type Point, type Project } from "./model";

interface Props {
  project: Project;
  /** Pin keys (`part:pin`) electrically connected to the hovered pin. */
  netOf: (pin: PinRef) => Set<string>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onMovePart: (id: string, x: number, y: number) => void;
  /** A new wire, with the bend points (grid units) clicked on the way. */
  onAddWire: (a: PinRef, b: PinRef, points: Point[]) => void;
  /** The bend points of a wire were edited. */
  onUpdateWire?: (id: string, points: Point[]) => void;
  /** A live input on a part (a potentiometer knob, a lamp over an LDR, …) was operated. */
  onPropChange?: (id: string, key: string, value: number) => void;
  /** An end of a wire was dragged onto another pin. */
  onMoveWireEnd?: (id: string, end: "a" | "b", pin: PinRef) => void;
  /** Live state from the simulator, by part id (LED brightness, …). */
  visuals?: Record<string, VisualState>;
  /** A pressable element (`data-action`) on a part went down or up. */
  onPartAction?: (partId: string, action: string, down: boolean) => void;
  /** Changes when a different project is loaded: zoom to fit it. */
  fitKey?: number;
  /** Reports the centre of the visible area (grid units) when it moves. */
  onViewCenter?: (p: Point) => void;
  /** Bring this part into view if it is not (e.g. just added). */
  reveal?: { id: string; seq: number };
}

type Drag =
  | { kind: "part"; id: string; dx: number; dy: number }
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }
  | { kind: "wire"; sx: number; sy: number; moved: boolean }
  | { kind: "point"; wire: string; index: number }
  | { kind: "end"; wire: string; end: "a" | "b" }
  /** Operating a control on a part (`data-drag`, see `PartDef.controls`). */
  | { kind: "control"; key: string; part: string; sx: number; sy: number; holdOnly: boolean; dx: number; dy: number };

/** A control gesture in progress, or one still animating after the release. */
interface Live {
  part: string;
  control: string;
  session: ControlSession;
  held: boolean;
}

/** Prop writes from a drag reach the simulator at most this often (ms):
 * each one re-sends the whole circuit. The drawing follows at once. */
const PROP_INTERVAL = 50;
/** Timed controls (a warming sensor) step this often (ms). */
const TICK_MS = 100;
/** Pointer travel (px) that turns a press-and-hold control into a move. */
const HOLD_SLOP = 5;

interface Pending {
  start: PinRef;
  points: Point[];
}

/** Boards and breadboards are the base layer: parts plug into them, so their
 * holes must not cover the parts (a resistor on the breadboard has to stay
 * clickable). */
const isBase = (kind: string) => kind.startsWith("breadboard") || PART_BY_KIND[kind]?.category === "board";
/** 100 % zoom. */
const BASE_SCALE = 1.6;
const MIN_SCALE = 0.3;
const MAX_SCALE = 8;
/** A click this close (canvas units) to a pin lands on the pin. */
const SNAP = 7;
/** Pointer travel (px) that turns a press on a pin into a drag-to-wire. */
const DRAG_START = 4;

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

/** SVG path of a wire through its bend points; without any, a gentle sag like a real jumper. */
function wirePath(a: Point, b: Point, points: Point[]): string {
  if (points.length === 0) {
    const sag = Math.min(40, Math.hypot(b.x - a.x, b.y - a.y) / 4);
    return `M ${a.x} ${a.y} C ${a.x} ${a.y + sag}, ${b.x} ${b.y + sag}, ${b.x} ${b.y}`;
  }
  return `M ${a.x} ${a.y} ` + [...points, b].map((p) => `L ${p.x} ${p.y}`).join(" ");
}

export function Canvas({
  project,
  netOf,
  selected,
  onSelect,
  onMovePart,
  onAddWire,
  onUpdateWire,
  onMoveWireEnd,
  onPropChange,
  visuals,
  onPartAction,
  fitKey,
  onViewCenter,
  reveal,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: BASE_SCALE });
  const [drag, setDrag] = useState<Drag | null>(null);
  /** The pointer the current drag follows (one gesture at a time). */
  const dragPointer = useRef<number | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [mouse, setMouse] = useState({ x: 0, y: 0 });
  const [hover, setHover] = useState<{ pin: PinRef; label: string } | null>(null);
  const [pressed, setPressed] = useState<{ part: string; action: string } | null>(null);
  /** The control under the pointer: its hint is shown next to it. */
  const [controlHint, setControlHint] = useState<{ text: string; x: number; y: number } | null>(null);
  /** The control held down now, shown by its part (`visual.control`). */
  const [held, setHeld] = useState<{ part: string; control: string } | null>(null);

  // ---------------------------------------------------- control props

  // Latest values for timers and native listeners.
  const projectRef = useRef(project);
  projectRef.current = project;
  const onPropChangeRef = useRef(onPropChange);
  onPropChangeRef.current = onPropChange;

  /** Values written but not yet sent on (drawn already). */
  const unsent = useRef(new Map<string, PropValues>());
  const [overlay, setOverlay] = useState<Record<string, PropValues>>({});
  const lastSent = useRef(0);
  const sendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushProps = useCallback(() => {
    clearTimeout(sendTimer.current ?? undefined);
    sendTimer.current = null;
    lastSent.current = performance.now();
    if (unsent.current.size === 0) return;
    for (const [part, values] of unsent.current)
      for (const [k, v] of Object.entries(values)) onPropChangeRef.current?.(part, k, v);
    unsent.current.clear();
    setOverlay({});
  }, []);

  /** Write props from a control: drawn now, sent on at most every PROP_INTERVAL. */
  const writeProps = useCallback(
    (part: string, values: PropValues, now = false) => {
      unsent.current.set(part, { ...unsent.current.get(part), ...values });
      setOverlay((o) => ({ ...o, [part]: { ...o[part], ...values } }));
      const wait = PROP_INTERVAL - (performance.now() - lastSent.current);
      if (now || wait <= 0) flushProps();
      else sendTimer.current ??= setTimeout(flushProps, wait);
    },
    [flushProps],
  );
  useEffect(() => () => clearTimeout(sendTimer.current ?? undefined), []);

  /** A part's props as they are now, including unsent control writes. */
  const propsOf = useCallback((id: string) => {
    const part = projectRef.current.parts.find((p) => p.id === id);
    const def = part && PART_BY_KIND[part.kind];
    return { ...def?.props, ...part?.props, ...unsent.current.get(id) };
  }, []);

  // Control sessions, by `part|control`. Timed ones tick until done.
  const live = useRef(new Map<string, Live>());
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);
  const tick = useCallback(() => {
    const t = performance.now();
    for (const [key, l] of live.current) {
      if (!projectRef.current.parts.some((p) => p.id === l.part)) {
        live.current.delete(key);
        continue;
      }
      if (!l.session.tick) continue;
      const r = l.session.tick(t, l.held, propsOf(l.part));
      if (r.set) writeProps(l.part, r.set, !l.held);
      if (r.done && !l.held) live.current.delete(key);
    }
    if (live.current.size === 0 && ticker.current) {
      clearInterval(ticker.current);
      ticker.current = null;
    }
  }, [propsOf, writeProps]);
  const startTicking = () => {
    ticker.current ??= setInterval(tick, TICK_MS);
  };
  useEffect(() => () => clearInterval(ticker.current ?? undefined), []);

  /** The pointer of `e` in the part's own coordinates. */
  const pointerIn = (e: { clientX: number; clientY: number }, partId: string): ControlPointer => {
    const part = projectRef.current.parts.find((p) => p.id === partId);
    const c = toCanvas(e);
    return { x: c.x - (part?.x ?? 0) * PITCH, y: c.y - (part?.y ?? 0) * PITCH, clientX: e.clientX, clientY: e.clientY, t: performance.now() };
  };

  /** The press on a control ended (released, or turned into a move). */
  const releaseControl = (key: string, e: { clientX: number; clientY: number }) => {
    const l = live.current.get(key);
    if (!l?.held) return;
    l.held = false;
    const r = l.session.release?.(pointerIn(e, l.part));
    if (r) writeProps(l.part, r);
    flushProps();
    if (!l.session.tick) live.current.delete(key);
    setHeld(null);
  };

  // Release a pressed board button wherever the pointer goes up.
  useEffect(() => {
    if (!pressed) return;
    const up = () => {
      onPartAction?.(pressed.part, pressed.action, false);
      setPressed(null);
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [pressed, onPartAction]);

  // ------------------------------------------------------------- zoom

  /** Zoom by `factor` keeping the canvas point under (clientX, clientY) — or the centre — fixed. */
  const zoomBy = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const el = svgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const cx = (clientX ?? r.left + r.width / 2) - r.left;
    const cy = (clientY ?? r.top + r.height / 2) - r.top;
    setView((v) => {
      const scale = clampScale(v.scale * factor);
      const px = cx / v.scale + v.x;
      const py = cy / v.scale + v.y;
      return { scale, x: px - cx / scale, y: py - cy / scale };
    });
  }, []);

  /** Zoom and pan so every part is visible. */
  const fit = () => {
    const el = svgRef.current;
    if (!el || project.parts.length === 0) return;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of project.parts) {
      const def = PART_BY_KIND[p.kind];
      if (!def) continue;
      x0 = Math.min(x0, p.x - 1);
      y0 = Math.min(y0, p.y - 2);
      x1 = Math.max(x1, p.x + def.w + 1);
      y1 = Math.max(y1, p.y + def.h + 1);
      // What the part draws outside its box too (a lamp, an obstacle).
      const g = el.querySelector(`[data-id="${CSS.escape(p.id)}"] > g`);
      if (g instanceof SVGGraphicsElement) {
        const b = g.getBBox();
        if (b.width > 0) {
          x0 = Math.min(x0, p.x + b.x / PITCH - 1);
          y0 = Math.min(y0, p.y + b.y / PITCH - 1);
          x1 = Math.max(x1, p.x + (b.x + b.width) / PITCH + 1);
          y1 = Math.max(y1, p.y + (b.y + b.height) / PITCH + 1);
        }
      }
    }
    for (const w of project.wires) {
      for (const q of w.points ?? []) {
        x0 = Math.min(x0, q.x - 1);
        y0 = Math.min(y0, q.y - 1);
        x1 = Math.max(x1, q.x + 1);
        y1 = Math.max(y1, q.y + 1);
      }
    }
    const [w, h] = [(x1 - x0) * PITCH, (y1 - y0) * PITCH];
    const scale = clampScale(Math.min(el.clientWidth / w, el.clientHeight / h));
    setView({
      scale,
      x: x0 * PITCH - (el.clientWidth / scale - w) / 2,
      y: y0 * PITCH - (el.clientHeight / scale - h) / 2,
    });
  };
  const fitRef = useRef(fit);
  fitRef.current = fit;
  useEffect(() => {
    if (fitKey) fitRef.current();
  }, [fitKey]);

  useEffect(() => {
    const el = svgRef.current;
    if (!el || !onViewCenter) return;
    onViewCenter({
      x: (view.x + el.clientWidth / view.scale / 2) / PITCH,
      y: (view.y + el.clientHeight / view.scale / 2) / PITCH,
    });
  }, [view, onViewCenter]);

  // Pan just enough to show a part that is (partly) outside the view.
  const revealRef = useRef<(id: string) => void>(() => {});
  revealRef.current = (id: string) => {
    const el = svgRef.current;
    const part = project.parts.find((p) => p.id === id);
    const def = part && PART_BY_KIND[part.kind];
    if (!el || !part || !def) return;
    const m = 2 * PITCH; // margin
    const [x0, y0] = [part.x * PITCH - m, (part.y - 1) * PITCH - m];
    const [x1, y1] = [(part.x + def.w) * PITCH + m, (part.y + def.h) * PITCH + m];
    const [vw, vh] = [el.clientWidth / view.scale, el.clientHeight / view.scale];
    let { x, y } = view;
    if (x0 < x) x = x0;
    else if (x1 > x + vw) x = x1 - vw;
    if (y0 < y) y = y0;
    else if (y1 > y + vh) y = y1 - vh;
    if (x !== view.x || y !== view.y) setView({ ...view, x, y });
  };
  useEffect(() => {
    if (reveal) revealRef.current(reveal.id);
  }, [reveal]);

  // Wheel / trackpad pinch: smooth zoom around the pointer. A native listener
  // so the page itself does not scroll or zoom.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Over a control that turns with the wheel (a knob): turn it.
      const el = e.target instanceof Element ? e.target.closest("[data-drag]") : null;
      const partId = el?.closest("[data-id]")?.getAttribute("data-id");
      const kind = partId && projectRef.current.parts.find((p) => p.id === partId)?.kind;
      const control = kind && PART_BY_KIND[kind]?.controls?.[el!.getAttribute("data-drag")!];
      if (control && control.wheel && partId && onPropChangeRef.current) {
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        const r = control.wheel(dy, propsOf(partId));
        if (r) writeProps(partId, r);
        return;
      }
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      // Pinch gestures arrive as ctrl+wheel with small deltas.
      zoomBy(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX, e.clientY);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomBy, propsOf, writeProps]);

  // --------------------------------------------------------- geometry

  const partById = new Map(project.parts.map((p) => [p.id, p]));
  const highlighted = hover ? netOf(hover.pin) : new Set<string>();

  // Screen → canvas units.
  const toCanvas = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / view.scale + view.x, y: (e.clientY - r.top) / view.scale + view.y };
  };

  const absPin = (ref: PinRef) => {
    const part = partById.get(ref.part);
    const pos = part && pinPosition(part, ref.pin);
    return pos && { x: pos.x * PITCH, y: pos.y * PITCH };
  };

  /** The pin nearest to `p` (canvas units) within the snap distance. */
  const nearestPin = (p: Point): PinRef | null => {
    let best: PinRef | null = null;
    let bestD = SNAP;
    for (const part of project.parts) {
      for (const pin of PART_BY_KIND[part.kind]?.pins ?? []) {
        const d = Math.hypot((part.x + pin.x) * PITCH - p.x, (part.y + pin.y) * PITCH - p.y);
        if (d < bestD) {
          bestD = d;
          best = { part: part.id, pin: pin.id };
        }
      }
    }
    return best;
  };

  // ------------------------------------------------------------ wiring

  // Cancel a wire in progress whose starting part was deleted (#2).
  useEffect(() => {
    if (pending && !project.parts.some((p) => p.id === pending.start.part)) setPending(null);
  }, [project.parts, pending]);

  const finishWire = (end: PinRef) => {
    if (pending && pinKey(pending.start) !== pinKey(end)) onAddWire(pending.start, end, pending.points);
    setPending(null);
  };

  /** While wiring, a click lands on the nearest pin, or else adds a bend point. */
  const wiringClick = (p: Point) => {
    if (!pending) return;
    const target = nearestPin(p);
    if (target) finishWire(target);
    else setPending({ ...pending, points: [...pending.points, { x: Math.round(p.x / PITCH), y: Math.round(p.y / PITCH) }] });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === "Escape") setPending(null);
      else if (e.key === "Backspace" && pending?.points.length) {
        // Undo the last bend point (and keep the wire going).
        e.stopImmediatePropagation();
        setPending({ ...pending, points: pending.points.slice(0, -1) });
      } else if (e.key === "+" || e.key === "=") zoomBy(1.25);
      else if (e.key === "-" || e.key === "_") zoomBy(1 / 1.25);
    };
    // Capture phase: runs before the app's Delete/Backspace handler.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending, zoomBy]);

  /** Route all pointer events to the canvas until the button is released,
   * even outside it, so a drag always ends (#3). */
  const startDrag = (e: RPointerEvent, d: Drag) => {
    dragPointer.current = e.pointerId;
    try {
      svgRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // Not a live pointer (a synthetic event): the drag still ends on its pointerup.
    }
    setDrag(d);
  };
  /** The drag is over without a release we saw: let go of a control too. */
  const dropDrag = (e: { clientX: number; clientY: number }) => {
    if (drag?.kind === "control") releaseControl(drag.key, e);
    dragPointer.current = null;
    setDrag(null);
  };
  /** Another finger while one drag is on: the drag belongs to the first. */
  const otherPointer = (e: RPointerEvent) => dragPointer.current !== null && e.pointerId !== dragPointer.current;
  const endDrag = (e: RPointerEvent) => {
    if (otherPointer(e)) return;
    dragPointer.current = null;
    if (drag?.kind === "control") releaseControl(drag.key, e);
    if (svgRef.current?.hasPointerCapture(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId);
    if (drag?.kind === "end") {
      // Re-plug the wire end into the pin it was dropped on (or near).
      const w = project.wires.find((x) => x.id === drag.wire);
      const target = nearestPin(toCanvas(e));
      const other = w && (drag.end === "a" ? w.b : w.a);
      if (w && target && other && pinKey(target) !== pinKey(other)) onMoveWireEnd?.(w.id, drag.end, target);
    }
    if (drag?.kind === "wire" && drag.moved && pending) {
      // Drag-to-wire: released over (or near) a pin.
      const target = nearestPin(toCanvas(e));
      if (target && pinKey(target) !== pinKey(pending.start)) finishWire(target);
    }
    setDrag(null);
  };

  const onPointerMove = (e: RPointerEvent) => {
    if (otherPointer(e)) return;
    if (drag && e.buttons === 0) {
      // The release happened somewhere we could not see it.
      dropDrag(e);
      return;
    }
    const p = toCanvas(e);
    setMouse(p);
    if (drag?.kind === "part") {
      onMovePart(drag.id, Math.round(p.x / PITCH - drag.dx), Math.round(p.y / PITCH - drag.dy));
    } else if (drag?.kind === "pan") {
      setView((v) => ({ ...v, x: drag.vx - (e.clientX - drag.sx) / v.scale, y: drag.vy - (e.clientY - drag.sy) / v.scale }));
    } else if (drag?.kind === "wire" && !drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > DRAG_START) {
      setDrag({ ...drag, moved: true });
    } else if (drag?.kind === "control") {
      if (drag.holdOnly && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > HOLD_SLOP) {
        // Pressed to touch, but dragged: it is a move after all.
        releaseControl(drag.key, e);
        setDrag({ kind: "part", id: drag.part, dx: drag.dx, dy: drag.dy });
        return;
      }
      const l = live.current.get(drag.key);
      const r = l?.session.move?.(pointerIn(e, drag.part));
      if (r) writeProps(drag.part, r);
    } else if (drag?.kind === "point" && onUpdateWire) {
      const w = project.wires.find((x) => x.id === drag.wire);
      if (w?.points) {
        const points = w.points.map((q, i) =>
          i === drag.index ? { x: Math.round(p.x / PITCH), y: Math.round(p.y / PITCH) } : q,
        );
        onUpdateWire(w.id, points);
      }
    }
  };

  const base = project.parts.filter((p) => isBase(p.kind));
  const placed = project.parts.filter((p) => !isBase(p.kind));
  const pendingStart = pending ? absPin(pending.start) : undefined;
  const snapTarget = pending || drag?.kind === "end" ? nearestPin(mouse) : null;
  const snapKey = snapTarget && pinKey(snapTarget);
  const previewEnd = (snapTarget && absPin(snapTarget)) ?? mouse;
  const selectedWire = project.wires.find((w) => w.id === selected);

  const renderBodies = (parts: typeof project.parts) =>
    parts.map((part) => {
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
            onPointerOver={(e) => {
              const el = (e.target as Element).closest("[data-drag]");
              const hint = el && def.controls?.[el.getAttribute("data-drag")!]?.hint;
              const r = svgRef.current!.getBoundingClientRect();
              setControlHint(hint ? { text: hint, x: e.clientX - r.left, y: e.clientY - r.top } : null);
            }}
            onPointerLeave={() => setControlHint(null)}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (pending) {
                wiringClick(toCanvas(e));
                return;
              }
              const p = toCanvas(e);
              const name = (e.target as Element).closest("[data-drag]")?.getAttribute("data-drag");
              const control = name ? def.controls?.[name] : undefined;
              if (name && control && onPropChange) {
                // Operate the part (knob, lamp, touch…); the rest of its body moves it.
                onSelect(part.id);
                const key = `${part.id}|${name}`;
                // Still cooling from the last touch: carry on from there.
                const before = live.current.get(key);
                const session = control.start(pointerIn(e, part.id), propsOf(part.id), before?.session.carry);
                live.current.set(key, { part: part.id, control: name, session, held: true });
                if (session.set) writeProps(part.id, session.set);
                if (session.tick) startTicking();
                setHeld({ part: part.id, control: name });
                startDrag(e, {
                  kind: "control",
                  key,
                  part: part.id,
                  sx: e.clientX,
                  sy: e.clientY,
                  holdOnly: !!control.holdOnly,
                  dx: p.x / PITCH - part.x,
                  dy: p.y / PITCH - part.y,
                });
                return;
              }
              const action = (e.target as Element).closest("[data-action]")?.getAttribute("data-action");
              if (action && onPartAction) {
                setPressed({ part: part.id, action });
                onPartAction(part.id, action, true);
                return;
              }
              onSelect(part.id);
              startDrag(e, { kind: "part", id: part.id, dx: p.x / PITCH - part.x, dy: p.y / PITCH - part.y });
            }}
          >
            {def.render({ ...def.props, ...part.props, ...overlay[part.id] }, {
              ...(visuals?.[part.id] ?? {}),
              pressed: pressed?.part === part.id && pressed.action !== "reset",
              action: pressed?.part === part.id ? pressed.action : undefined,
              control: held?.part === part.id ? held.control : undefined,
            })}
          </g>
        </g>
      );
    });

  const renderPins = (parts: typeof project.parts) =>
    parts.map((part) => (
      <g key={part.id} transform={`translate(${part.x * PITCH} ${part.y * PITCH})`} data-pins={part.id}>
        {(PART_BY_KIND[part.kind]?.pins ?? []).map((pin) => {
          const ref = { part: part.id, pin: pin.id };
          const key = pinKey(ref);
          const cls =
            pending && pinKey(pending.start) === key
              ? "pin pending"
              : snapKey === key
                ? "pin snap"
                : highlighted.has(key)
                  ? "pin hot"
                  : "pin";
          return (
            <circle
              key={pin.id}
              data-pin={pin.id}
              cx={pin.x * PITCH}
              cy={pin.y * PITCH}
              r={4.2}
              className={cls}
              onPointerDown={(e) => {
                e.stopPropagation();
                if (pending) {
                  finishWire(ref);
                  return;
                }
                // Start a wire: click-and-click, or drag to the other pin.
                setPending({ start: ref, points: [] });
                setMouse(toCanvas(e));
                startDrag(e, { kind: "wire", sx: e.clientX, sy: e.clientY, moved: false });
              }}
              onPointerEnter={() => setHover({ pin: ref, label: `${part.id}.${pin.label ?? pin.id}` })}
              onPointerLeave={() => setHover(null)}
            />
          );
        })}
      </g>
    ));

  return (
    <div className={pending ? "canvas-wrap wiring" : "canvas-wrap"}>
      <svg
        ref={svgRef}
        className="canvas"
        viewBox={`${view.x} ${view.y} ${(svgRef.current?.clientWidth ?? 1200) / view.scale} ${(svgRef.current?.clientHeight ?? 800) / view.scale}`}
        onPointerDown={(e) => {
          if (e.target !== svgRef.current) return;
          if (pending) {
            wiringClick(toCanvas(e));
            return;
          }
          onSelect(null);
          startDrag(e, { kind: "pan", sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y });
        }}
        onPointerDownCapture={(e) => {
          // One gesture at a time: a second finger cannot start another
          // drag (it would take over the first one's release).
          if (otherPointer(e)) e.stopPropagation();
        }}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={(e) => dropDrag(e)}
        onContextMenu={(e) => {
          // Right click while wiring: cancel.
          if (pending) {
            e.preventDefault();
            setPending(null);
          }
        }}
      >
        <defs>
          <pattern id="grid" width={PITCH} height={PITCH} patternUnits="userSpaceOnUse">
            <circle cx={0} cy={0} r={0.6} className="grid-dot" />
          </pattern>
        </defs>
        <rect x={view.x - 5000} y={view.y - 5000} width={20000} height={20000} fill="url(#grid)" pointerEvents="none" />

        {renderBodies(base)}
        {renderPins(base)}
        {renderBodies(placed)}

        {project.wires.map((w) => {
          let a = absPin(w.a);
          let b = absPin(w.b);
          if (!a || !b) return null;
          // An end being dragged follows the pointer (snapping to pins).
          if (drag?.kind === "end" && drag.wire === w.id) {
            const p = (snapTarget && absPin(snapTarget)) ?? mouse;
            if (drag.end === "a") a = p;
            else b = p;
          }
          const pts = (w.points ?? []).map((q) => ({ x: q.x * PITCH, y: q.y * PITCH }));
          const onDown = (e: RPointerEvent) => {
            e.stopPropagation();
            if (pending) {
              wiringClick(toCanvas(e));
              return;
            }
            onSelect(w.id);
          };
          const d = wirePath(a, b, pts);
          return (
            <g key={w.id}>
              {/* Wide invisible stroke: easy to click a thin wire. */}
              <path d={d} className="wire-hit" onPointerDown={onDown} />
              <path
                data-wire={w.id}
                d={d}
                stroke={w.color}
                className={selected === w.id ? "wire selected" : "wire"}
                onPointerDown={onDown}
              />
            </g>
          );
        })}
        {/* Bend points of the selected wire: drag to move, double-click to remove. */}
        {selectedWire?.points?.map((q, i) => (
          <circle
            key={i}
            cx={q.x * PITCH}
            cy={q.y * PITCH}
            r={3.5}
            className="wire-handle"
            onPointerDown={(e) => {
              e.stopPropagation();
              startDrag(e, { kind: "point", wire: selectedWire.id, index: i });
            }}
            onDoubleClick={() =>
              onUpdateWire?.(
                selectedWire.id,
                selectedWire.points!.filter((_, j) => j !== i),
              )
            }
          />
        ))}
        {pendingStart && (
          <path
            d={`M ${pendingStart.x} ${pendingStart.y} ` +
              [...pending!.points.map((q) => ({ x: q.x * PITCH, y: q.y * PITCH })), previewEnd]
                .map((p) => `L ${p.x} ${p.y}`)
                .join(" ")}
            className="wire-preview"
          />
        )}
        {/* Pins of placed parts sit above wires so a wired pin can still be hovered or wired again. */}
        {renderPins(placed)}
        {/* Ends of the selected wire, above the pins: drag one to another pin. */}
        {selectedWire &&
          (["a", "b"] as const).map((end) => {
            const at =
              drag?.kind === "end" && drag.end === end
                ? ((snapTarget && absPin(snapTarget)) ?? mouse)
                : absPin(selectedWire[end]);
            if (!at) return null;
            return (
              <rect
                key={end}
                data-wire-end={end}
                x={at.x - 3.5}
                y={at.y - 3.5}
                width={7}
                height={7}
                rx={1.5}
                className="wire-end"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  setMouse(toCanvas(e));
                  startDrag(e, { kind: "end", wire: selectedWire.id, end });
                }}
              >
                <title>끌어서 다른 핀으로 옮기기</title>
              </rect>
            );
          })}
      </svg>
      {hover && <div className="tooltip">{hover.label}</div>}
      {controlHint && !pending && (
        <div className="control-hint" data-testid="control-hint" style={{
            left: Math.max(4, Math.min(controlHint.x + 14, (svgRef.current?.clientWidth ?? 1200) - 270)),
            top: controlHint.y + 18 > (svgRef.current?.clientHeight ?? 800) - 60 ? controlHint.y - 60 : controlHint.y + 18,
          }}>
          {controlHint.text}
        </div>
      )}
      {pending && (
        <div className="wiring-hint">
          배선 중: 다른 핀을 클릭(또는 끌어다 놓기) · 빈 곳 클릭 = 꺾는 점 · Backspace = 점 취소 · Esc/우클릭 = 취소
        </div>
      )}
      <div className="zoom-controls" role="group" aria-label="확대/축소">
        <button onClick={() => zoomBy(1 / 1.25)} aria-label="축소" title="축소 (−, 휠)">
          −
        </button>
        <button
          onClick={() => zoomBy(BASE_SCALE / view.scale)}
          title="100%로"
          data-testid="zoom-level"
          className="zoom-level"
        >
          {Math.round((view.scale / BASE_SCALE) * 100)}%
        </button>
        <button onClick={() => zoomBy(1.25)} aria-label="확대" title="확대 (+, 휠)">
          +
        </button>
        <button onClick={fit} title="모든 부품이 보이게 맞춤">
          ⤢ 맞춤
        </button>
      </div>
    </div>
  );
}
