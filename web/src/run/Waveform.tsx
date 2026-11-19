// Logic probe with an oscilloscope-style trigger: the level of chosen MCU
// pins, either scrolling live (the last 10 divisions) or as a capture around
// a trigger, taken edge by edge in the simulator (crates/wasm/src/scope.rs),
// so pulses of a few cycles are shown and measured exactly.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Runner } from "../sim/useRunner";
import type { CaptureChannel, ScopeCapture, ScopeState, TriggerConfig } from "../sim/protocol";
import {
  DIVISIONS,
  TIMEBASE_NS,
  clampView,
  divLabel,
  fmtHz,
  fmtTime,
  measurePulses,
  tracePoints,
  validSpan,
  zoomView,
  type PulseStats,
  type Widths,
} from "./scope";

const PIN_NAMES = [
  ...["A", "B", "C"].flatMap((p) => Array.from({ length: 16 }, (_, i) => `P${p}${i}`)),
  "PD2",
  "PH0",
  "PH1",
];
const ROW = 34;
const TOP = 14; // trigger marker strip
const AXIS = 18; // time labels
/** Live history kept, in ms (two windows of the widest timebase). */
const KEEP_MS = 2 * DIVISIONS * (TIMEBASE_NS[TIMEBASE_NS.length - 1] / 1e6);
/** Edges a capture keeps per pin (`scope::CAPTURE_EDGES`). */
const CAPTURE_EDGES = 65536;

interface Trace {
  /** Level before the first edge. */
  level0: boolean;
  /** [time in ms, level] */
  edges: [number, boolean][];
  dense: boolean;
}

type Mode = TriggerConfig["mode"];
type EdgeKind = TriggerConfig["edge"];
type View = { start: number; span: number };
type Drag = { kind: "trigger" | "a" | "b" | "pan"; x0: number; view0: View } | null;

const STATE_TEXT: Record<ScopeState, string> = {
  off: "",
  nosource: "트리거 소스 핀이 프로브되지 않았습니다 — 핀을 추가하세요",
  armed: "트리거 대기 중…",
  collecting: "트리거됨 — 수집 중…",
  stopped: "정지 (단일 캡처 완료)",
};

export function Waveform({ runner, active = true }: { runner: Runner; active?: boolean }) {
  const [pins, setPins] = useState<string[]>(["PA5"]);
  const [divIdx, setDivIdx] = useState(TIMEBASE_NS.indexOf(2e6));
  const [mode, setMode] = useState<Mode>("auto");
  const [source, setSource] = useState("PA5");
  const [edge, setEdge] = useState<EdgeKind>("rising");
  const [widthCmp, setWidthCmp] = useState<"off" | "lt" | "gt">("off");
  const [widthUs, setWidthUs] = useState(10);
  const [pre, setPre] = useState(0.5);
  const [pause, setPause] = useState(false);
  const [cursors, setCursors] = useState<{ a: number; b: number } | null>(null);
  const [capture, setCapture] = useState<ScopeCapture | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [dragPre, setDragPre] = useState<number | null>(null);
  const [plotWidth, setPlotWidth] = useState(800);
  const traces = useRef(new Map<string, Trace>());
  /** The live (rolling) view is shown, not a capture. */
  const liveRef = useRef(false);
  const lastTime = useRef(0);
  const plot = useRef<SVGSVGElement>(null);
  const { setProbes, setTrigger, armTrigger, onFrame, ready } = runner;
  const divNs = TIMEBASE_NS[divIdx];
  const windowNs = divNs * DIVISIONS;

  useEffect(() => {
    if (ready) setProbes(pins);
  }, [pins, ready, setProbes]);

  const config = useMemo<TriggerConfig>(
    () => ({
      source,
      edge,
      mode,
      windowNs,
      pre,
      width: widthCmp === "off" ? undefined : { cmp: widthCmp, ns: widthUs * 1000 },
      pause,
    }),
    [source, edge, mode, windowNs, pre, widthCmp, widthUs, pause],
  );
  const configRef = useRef(config);
  configRef.current = config;
  // New settings: wait for a capture taken with them.
  useEffect(() => {
    if (ready) setTrigger(config);
    setCapture(null);
  }, [config, ready, setTrigger]);
  useEffect(() => () => setTrigger(null), [setTrigger]);
  // A new timebase or trigger position: back to the whole window, cursors
  // at a quarter and three quarters of it.
  useEffect(() => {
    setView(null);
    const start = liveRef.current ? -windowNs : -pre * windowNs;
    setCursors((c) => c && { a: start + 0.25 * windowNs, b: start + 0.75 * windowNs });
  }, [windowNs, pre]);

  // Every frame, none skipped: fold the live edges into the traces, keep
  // the newest capture.
  useEffect(
    () =>
      onFrame(({ frame: f }) => {
        if (f.timeMs < lastTime.current) {
          // Reset or new firmware: the history is gone.
          traces.current.clear();
          setCapture(null);
        }
        lastTime.current = f.timeMs;
        for (const p of f.probes) {
          let t = traces.current.get(p.name);
          if (!t) {
            t = { level0: p.level0, edges: [], dense: false };
            traces.current.set(p.name, t);
          }
          for (const e of p.edges) t.edges.push(e);
          t.dense = p.dense;
          const keepFrom = f.timeMs - KEEP_MS;
          let drop = 0;
          while (drop < t.edges.length && t.edges[drop][0] < keepFrom) drop++;
          if (drop > 0) {
            t.level0 = t.edges[drop - 1][1];
            t.edges.splice(0, drop);
          }
        }
        const c = f.scope?.capture;
        // (One still on its way from before a change of settings is dropped.)
        const k = configRef.current;
        if (c && c.source === k.source && near(c.endNs - c.startNs, k.windowNs) && near(c.startNs, -k.pre * k.windowNs))
          setCapture(c);
      }),
    [onFrame],
  );

  // Pixel width of the plot, so text and markers keep their shape.
  useEffect(() => {
    const el = plot.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPlotWidth(Math.max(200, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [active]);

  const f = runner.frame;
  const now = f?.timeMs ?? 0;
  const state: ScopeState = f?.scope?.state ?? "armed";
  const windowMs = windowNs / 1e6;
  // Auto free-runs when the triggers stop coming.
  const stale = capture !== null && now - (capture.triggerMs + capture.endNs / 1e6) > Math.max(2 * windowMs, 100);
  const showCapture = capture !== null && !(mode === "auto" && stale);
  const live = mode === "auto" && !showCapture;
  liveRef.current = !showCapture;
  const full: View = showCapture ? { start: capture.startNs, span: capture.endNs - capture.startNs } : { start: -windowNs, span: windowNs };
  const v = showCapture && view ? view : full;
  const W = plotWidth;
  const x = (t: number) => ((t - v.start) / v.span) * W;
  const tAt = (px: number) => v.start + (px / W) * v.span;

  // Wheel zoom over a capture (a native listener: React's is passive).
  const zoomRef = useRef<(e: WheelEvent) => void>(() => {});
  zoomRef.current = (e: WheelEvent) => {
    if (!showCapture || !plot.current) return;
    e.preventDefault();
    const r = plot.current.getBoundingClientRect();
    const at = tAt(e.clientX - r.left);
    setView(zoomView(v, at, e.deltaY > 0 ? 1.25 : 0.8, full.start, full.start + full.span));
  };
  useEffect(() => {
    const el = plot.current;
    if (!el) return;
    const h = (e: WheelEvent) => zoomRef.current(e);
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, [active]);

  const pointerX = (e: React.PointerEvent) => e.clientX - plot.current!.getBoundingClientRect().left;
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const kind = (e.target as Element).getAttribute("data-drag") as "trigger" | "a" | "b" | null;
    if (!kind && !showCapture) return;
    plot.current?.setPointerCapture(e.pointerId);
    setDrag({ kind: kind ?? "pan", x0: pointerX(e), view0: v });
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const px = Math.min(W, Math.max(0, pointerX(e)));
    if (drag.kind === "trigger") setDragPre(Math.min(0.9, Math.max(0.1, Math.round((px / W) * 20) / 20)));
    else if (drag.kind === "pan") {
      const dt = ((px - drag.x0) / W) * drag.view0.span;
      setView(clampView({ start: drag.view0.start - dt, span: drag.view0.span }, full.start, full.start + full.span));
    } else if (cursors) setCursors({ ...cursors, [drag.kind]: tAt(px) });
  };
  const onPointerUp = () => {
    if (drag?.kind === "trigger" && dragPre !== null) setPre(dragPre);
    setDrag(null);
    setDragPre(null);
  };

  // Channels to draw: the capture's, or the live traces (in ms).
  const rows = pins.map((name) => {
    if (showCapture) {
      const ch = capture.channels.find((c) => c.name === name);
      return { name, ch, live: undefined };
    }
    return { name, ch: undefined, live: traces.current.get(name) };
  });

  const sourceStats: PulseStats | undefined = useMemo(() => {
    if (showCapture) {
      const ch = capture.channels.find((c) => c.name === capture.source);
      if (!ch) return undefined;
      const [a, b] = validSpan(ch, capture.startNs, capture.endNs);
      return measurePulses(ch, a, b);
    }
    const t = traces.current.get(source);
    if (!t) return undefined;
    return measurePulses(liveNs(t, now), -windowNs, 0);
    // The live traces change in place with each frame (`now`).
  }, [showCapture, capture, source, now, windowNs]);

  const truncated =
    showCapture && capture.channels.some((c) => c.fromNs > capture.startNs || c.toNs < capture.endNs);
  const height = TOP + pins.length * ROW + AXIS;
  const markerPre = dragPre ?? pre;
  const markerX = showCapture && dragPre === null ? x(0) : markerPre * W;

  return (
    <div className="waveform">
      <div className="wave-controls">
        <label>
          핀 추가{" "}
          <select
            value=""
            aria-label="프로브 핀 추가"
            onChange={(e) => {
              const n = e.target.value;
              if (!n) return;
              setPins((p) => (p.includes(n) ? p : [...p, n]));
              if (!pins.includes(source)) setSource(n);
            }}
          >
            <option value="">…</option>
            {PIN_NAMES.filter((n) => !pins.includes(n)).map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <label>
          시간/눈금{" "}
          <select value={divIdx} onChange={(e) => setDivIdx(Number(e.target.value))} aria-label="시간/눈금">
            {TIMEBASE_NS.map((ns, i) => (
              <option key={ns} value={i}>
                {divLabel(ns)}
              </option>
            ))}
          </select>
        </label>
        <span className="hint">핀의 실제 레벨(입력 포함)을 보여 줍니다.</span>
      </div>
      <div className="wave-controls scope-controls">
        <b>트리거</b>
        <label>
          소스{" "}
          <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="트리거 소스">
            {!pins.includes(source) && <option value={source}>{source} (프로브 안 됨)</option>}
            {pins.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <label>
          에지{" "}
          <select value={edge} onChange={(e) => setEdge(e.target.value as EdgeKind)} aria-label="트리거 에지">
            <option value="rising">상승 ↑</option>
            <option value="falling">하강 ↓</option>
            <option value="either">양쪽 ↕</option>
          </select>
        </label>
        <label>
          모드{" "}
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode)} aria-label="트리거 모드">
            <option value="auto">자동 (Auto)</option>
            <option value="normal">일반 (Normal)</option>
            <option value="single">단일 (Single)</option>
          </select>
        </label>
        <label>
          펄스 폭{" "}
          <select value={widthCmp} onChange={(e) => setWidthCmp(e.target.value as "off" | "lt" | "gt")} aria-label="펄스 폭 조건">
            <option value="off">조건 없음</option>
            <option value="lt">보다 좁은 펄스 &lt;</option>
            <option value="gt">보다 넓은 펄스 &gt;</option>
          </select>
          {widthCmp !== "off" && (
            <>
              {" "}
              <input
                type="number"
                min={0.01}
                step="any"
                value={widthUs}
                onChange={(e) => Number(e.target.value) > 0 && setWidthUs(Number(e.target.value))}
                aria-label="펄스 폭 (µs)"
                className="num"
              />{" "}
              µs
            </>
          )}
        </label>
        <label>
          위치{" "}
          <input
            type="range"
            min={10}
            max={90}
            step={5}
            value={Math.round(pre * 100)}
            onChange={(e) => setPre(Number(e.target.value) / 100)}
            aria-label="트리거 위치"
          />{" "}
          {Math.round(markerPre * 100)}%
        </label>
        <label>
          <input type="checkbox" checked={pause} onChange={(e) => setPause(e.target.checked)} /> 트리거 시 일시정지
        </label>
        {mode === "single" && <button onClick={armTrigger}>다시 대기 (Arm)</button>}
        <label>
          <input
            type="checkbox"
            checked={cursors !== null}
            onChange={(e) => setCursors(e.target.checked ? { a: v.start + v.span * 0.25, b: v.start + v.span * 0.75 } : null)}
          />{" "}
          커서
        </label>
        {showCapture && view && <button onClick={() => setView(null)}>전체 보기</button>}
        <span className="scope-state" data-testid="scope-state" data-state={state}>
          {state === "nosource" || !pins.includes(source)
            ? STATE_TEXT.nosource
            : live
              ? `${STATE_TEXT[state]}${state === "armed" ? " (자동: 실시간 표시)" : ""}`
              : STATE_TEXT[state]}
        </span>
      </div>
      {active && (
        <>
          <div className="scope-body">
            <div className="wave-labels" style={{ paddingTop: TOP }}>
              {rows.map(({ name, ch, live: t }) => (
                <div key={name} className="wave-label" data-probe={name} style={{ height: ROW }}>
                  <b className={name === source ? "trig-src" : undefined}>{name}</b>
                  <button aria-label={`${name} 제거`} onClick={() => setPins((p) => p.filter((q) => q !== name))}>
                    ×
                  </button>
                  <div className="dim" data-testid={`probe-${name}`}>
                    {rowText(ch, t, v, now, windowNs)}
                  </div>
                </div>
              ))}
            </div>
            <svg
              ref={plot}
              className={`scope-svg${showCapture ? " zoomable" : ""}`}
              height={height}
              viewBox={`0 0 ${W} ${height}`}
              data-testid="scope-plot"
              data-view={showCapture ? "capture" : live ? "live" : "waiting"}
              data-seq={showCapture ? capture.seq : undefined}
              data-view-start={v.start}
              data-view-span={v.span}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <Grid width={W} top={TOP} rows={pins.length} view={v} />
              {rows.map(({ name, ch, live: t }, i) => {
                const y0 = TOP + i * ROW;
                let points = "";
                if (ch) points = tracePoints(ch, v.start, v.start + v.span, W, y0 + 6, y0 + ROW - 6);
                else if (t && live) points = tracePoints(t, now - windowMs, now, W, y0 + 6, y0 + ROW - 6);
                return (
                  <g key={name} data-trace={name}>
                    {ch && <Invalid ch={ch} x={x} y={y0} capture={capture!} />}
                    <polyline points={points} />
                  </g>
                );
              })}
              {!showCapture && !live && (
                <text x={W / 2} y={TOP + (pins.length * ROW) / 2} className="scope-wait" textAnchor="middle">
                  트리거 대기 중…
                </text>
              )}
              {/* Trigger marker: T at t = 0, drag to move the trigger position. */}
              {markerX >= -1 && markerX <= W + 1 && (
                <g className={`trig-marker${showCapture && dragPre === null ? "" : " pending"}`} transform={`translate(${markerX},0)`}>
                  <line y1={TOP} y2={TOP + pins.length * ROW} />
                  <path d="M -6 0 L 6 0 L 0 10 Z" data-drag="trigger" data-testid="trigger-marker">
                    <title>트리거 (t = 0) — 끌어서 위치 변경</title>
                  </path>
                  <text y={9} x={8}>
                    T
                  </text>
                </g>
              )}
              {cursors && (
                <>
                  <Cursor x={x(cursors.a)} label="A" h={TOP + pins.length * ROW} id="a" />
                  <Cursor x={x(cursors.b)} label="B" h={TOP + pins.length * ROW} id="b" />
                </>
              )}
            </svg>
          </div>
          {truncated && (
            <div className="scope-note" data-testid="scope-truncated">
              에지가 너무 많아 버퍼(핀당 {CAPTURE_EDGES.toLocaleString()}개)를 넘었습니다 — 빗금 구간은 기록되지 않았습니다. 시간/눈금을 줄이세요.
            </div>
          )}
          <Measurements stats={sourceStats} source={showCapture ? capture.source : source} cursors={cursors} live={!showCapture} />
        </>
      )}
    </div>
  );
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));

/** The live trace of a pin with times in ns relative to now. */
function liveNs(t: Trace, now: number) {
  return { level0: t.level0, edges: t.edges.map(([ms, l]) => [(ms - now) * 1e6, l] as [number, boolean]) };
}

const rowHz = (f: number) =>
  f >= 1e6 ? `${(f / 1e6).toFixed(3)} MHz` : f >= 1000 ? `${(f / 1000).toFixed(2)} kHz` : `${f.toFixed(1)} Hz`;

/** Frequency and duty of a row over what is shown. */
function rowText(ch: CaptureChannel | undefined, t: Trace | undefined, v: View, now: number, windowNs: number) {
  let m: PulseStats | undefined;
  if (ch) m = measurePulses(ch, v.start, v.start + v.span);
  else if (t) m = measurePulses(liveNs(t, now), -windowNs, 0);
  if (!m) return "—";
  return (
    (m.freq !== undefined ? `${rowHz(m.freq)} · ` : "") +
    (m.duty !== undefined ? `${(m.duty * 100).toFixed(0)}% H` : "—") +
    (!ch && t?.dense ? " · 너무 빠름" : "")
  );
}

function Grid({ width, top, rows, view }: { width: number; top: number; rows: number; view: View }) {
  const h = rows * ROW;
  const step = view.span / DIVISIONS;
  return (
    <g className="scope-grid">
      <rect x={0} y={top} width={width} height={h} />
      {Array.from({ length: DIVISIONS + 1 }, (_, i) => {
        const x = (i / DIVISIONS) * width;
        const t = view.start + i * step;
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={top} y2={top + h} />
            {i < DIVISIONS && (
              <text x={x + 2} y={top + h + 13}>
                {fmtTime(Math.abs(t) < step / 1e6 ? 0 : t)}
              </text>
            )}
          </g>
        );
      })}
      {Array.from({ length: rows - 1 }, (_, i) => (
        <line key={`r${i}`} className="row-line" x1={0} x2={width} y1={top + (i + 1) * ROW} y2={top + (i + 1) * ROW} />
      ))}
    </g>
  );
}

/** Hatched parts of a capture row that were not recorded. */
function Invalid({ ch, x, y, capture }: { ch: CaptureChannel; x: (t: number) => number; y: number; capture: ScopeCapture }) {
  const parts: [number, number][] = [];
  if (ch.fromNs > capture.startNs) parts.push([capture.startNs, ch.fromNs]);
  if (ch.toNs < capture.endNs) parts.push([ch.toNs, capture.endNs]);
  return (
    <>
      {parts.map(([a, b]) => (
        <rect key={a} className="scope-invalid" x={x(a)} width={Math.max(0, x(b) - x(a))} y={y + 2} height={ROW - 4} />
      ))}
    </>
  );
}

function Cursor({ x, label, h, id }: { x: number; label: string; h: number; id: "a" | "b" }) {
  return (
    <g className="scope-cursor" transform={`translate(${x},0)`}>
      <line y1={TOP} y2={h} />
      <line y1={TOP} y2={h} className="grab" data-drag={id} data-testid={`cursor-${id}`} />
      <text y={TOP - 3} x={3}>
        {label}
      </text>
    </g>
  );
}

function WidthCell({ w, id }: { w?: Widths; id: string }) {
  if (!w) return <td data-testid={id}>—</td>;
  return (
    <td data-testid={id} data-min={w.min} data-max={w.max} data-last={w.last}>
      {fmtTime(w.last)} <span className="dim">(최소 {fmtTime(w.min)} · 최대 {fmtTime(w.max)} · {w.count}개)</span>
    </td>
  );
}

function Measurements({
  stats,
  source,
  cursors,
  live,
}: {
  stats?: PulseStats;
  source: string;
  cursors: { a: number; b: number } | null;
  live: boolean;
}) {
  const dt = cursors ? cursors.b - cursors.a : 0;
  return (
    <div className="scope-measure">
      <table>
        <tbody>
          <tr>
            <th>{source} 측정{live ? " (실시간)" : " (캡처)"}</th>
            <td>
              주파수 <b data-testid="scope-freq" data-hz={stats?.freq}>{stats?.freq !== undefined ? fmtHz(stats.freq) : "—"}</b>
            </td>
            <td>
              주기 <b data-testid="scope-period" data-ns={stats?.period}>{stats?.period !== undefined ? fmtTime(stats.period) : "—"}</b>
            </td>
            <td>
              듀티 <b data-testid="scope-duty">{stats?.duty !== undefined ? `${(stats.duty * 100).toFixed(1)}%` : "—"}</b>
            </td>
            {cursors && (
              <>
                <th>커서</th>
                <td data-testid="cursor-dt" data-ns={dt}>
                  Δt <b>{fmtTime(dt)}</b>
                </td>
                <td data-testid="cursor-freq">1/Δt {dt !== 0 ? fmtHz(1e9 / Math.abs(dt)) : "—"}</td>
              </>
            )}
          </tr>
          <tr>
            <th>H 폭</th>
            <WidthCell w={stats?.high} id="scope-high" />
            <th>L 폭</th>
            <WidthCell w={stats?.low} id="scope-low" />
            {cursors && (
              <td colSpan={3} className="dim">
                A {fmtTime(cursors.a)} · B {fmtTime(cursors.b)}
              </td>
            )}
          </tr>
        </tbody>
      </table>
    </div>
  );
}
