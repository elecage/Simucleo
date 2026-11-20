// Logic probe with an oscilloscope-style trigger: the level of chosen MCU
// pins, either scrolling live (the last 10 divisions) or as a capture around
// a trigger, taken edge by edge in the simulator (crates/wasm/src/scope.rs),
// so pulses of a few cycles are shown and measured exactly.
// M22: analog channels (net voltages) with a level trigger, protocol
// decoders (UART, I2C, SPI) over the digital channels, CSV/VCD export.
// M25: 1-Wire, TM1637 and WS2812 decoders, a trigger on decoded content
// (decoded here, from the live stream), the settings kept in the project.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Runner } from "../sim/useRunner";
import type { CaptureAnalog, CaptureChannel, ScopeCapture, ScopeState, TriggerConfig } from "../sim/protocol";
import { PART_BY_KIND } from "../parts";
import {
  DIVISIONS,
  TIMEBASE_NS,
  VOLTS_DIV,
  analogPoints,
  clampView,
  divLabel,
  fmtHz,
  fmtTime,
  fmtVolts,
  levelAt,
  lowerBound,
  measureAnalog,
  measurePulses,
  tracePoints,
  validSpan,
  zoomView,
  type AnalogStats,
  type PulseStats,
  type Widths,
} from "./scope";
import {
  annotationLabel,
  decodeI2c,
  decodeNec,
  decodeOneWire,
  decodeSpi,
  decodeTm1637,
  decodeUart,
  decodeWs2812,
  fmtByte,
  fmtColor,
  necLast,
  scanStep,
  tm1637Display,
  uartText,
  ws2812Frame,
  type Annotation,
  type AnnotationKind,
  type Format,
  type Line,
  type Parity,
  type ContentMatch,
  type ScanState,
} from "./decode";
import {
  DECODER_NAMES,
  DECODER_TYPES,
  PIN_ROLES,
  contentKinds,
  contentMatch,
  defaultScope,
  exactContent,
  newDecoder,
  type ContentCfg,
  type DecoderCfg,
  type DecoderType,
  type ScopeSettings,
  type TriggerSettings,
} from "./scopeSettings";
import { captureCsv, captureVcd } from "./export";

const PIN_NAMES = [
  ...["A", "B", "C"].flatMap((p) => Array.from({ length: 16 }, (_, i) => `P${p}${i}`)),
  "PD2",
  "PH0",
  "PH1",
];
const ROW = 34;
const LANE = 22; // a decoder's annotation lane
const AROW = 96; // an analog channel
const ADIVS = 4; // vertical divisions of an analog row
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
  /** Known from here on (ms). */
  since: number;
}

/** Live samples of an analog channel (ms). */
interface ATrace {
  v0: number;
  samples: [number, number][];
}

const KIND_TEXT: Record<AnnotationKind, string> = {
  data: "데이터",
  address: "주소",
  start: "START",
  restart: "재START",
  stop: "STOP",
  reset: "리셋",
  triplet: "탐색",
  pixel: "픽셀",
  leader: "리더",
  repeat: "반복",
};
const CONTENT_KIND_TEXT: Record<ContentCfg["kind"], string> = {
  byte: "바이트",
  text: "텍스트",
  address: "주소",
  pixel: "픽셀",
  nec: "명령",
};
/** A content trigger decodes at most this far back (ns) for the context it needs. */
const CONTENT_SPAN = 200e6;
/** … and builds its capture once the stream is this far past the window (synthesized edges come late). */
const CONTENT_MARGIN = 1e6;
/** Rows a decoded table shows. */
const TABLE_ROWS = 400;

/** Pins of the project's parts an analog probe can go on ("pot.W"). */
function partPins(parts: { id: string; kind: string }[]): string[] {
  return parts
    .filter((p) => !["nucleo-f401re", "breadboard-half", "breadboard-full"].includes(p.kind) && !p.kind.startsWith("breadboard"))
    .flatMap((p) => (PART_BY_KIND[p.kind]?.pins ?? []).map((pin) => `${p.id}.${pin.id}`));
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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

export function Waveform({
  runner,
  active = true,
  parts = [],
  settings,
  settingsSeq = 0,
  onSettings,
}: {
  runner: Runner;
  active?: boolean;
  parts?: { id: string; kind: string }[];
  /** Settings to start from (the project's), taken again when `settingsSeq` changes. */
  settings?: ScopeSettings;
  settingsSeq?: number;
  /** Called with the settings as they change (to keep them in the project). */
  onSettings?: (s: ScopeSettings) => void;
}) {
  const [cfg, setCfg] = useState<ScopeSettings>(() => settings ?? defaultScope());
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const onSettingsRef = useRef(onSettings);
  onSettingsRef.current = onSettings;
  // Another project opened: its settings. One without (older, an example,
  // a new one) keeps the view as it is, as before M25, and takes it along.
  const seenSeq = useRef(settingsSeq);
  useEffect(() => {
    if (seenSeq.current === settingsSeq) return;
    seenSeq.current = settingsSeq;
    if (settings) setCfg(settings);
    else onSettingsRef.current?.(cfgRef.current);
  }, [settings, settingsSeq]);
  useEffect(() => onSettingsRef.current?.(cfg), [cfg]);
  const field =
    <K extends keyof ScopeSettings>(k: K) =>
    (v: ScopeSettings[K] | ((old: ScopeSettings[K]) => ScopeSettings[K])) =>
      setCfg((c) => ({ ...c, [k]: typeof v === "function" ? (v as (old: ScopeSettings[K]) => ScopeSettings[K])(c[k]) : v }));
  const trig =
    <K extends keyof TriggerSettings>(k: K) =>
    (v: TriggerSettings[K]) =>
      setCfg((c) => ({ ...c, trigger: { ...c.trigger, [k]: v } }));
  const { pins, analog, decoders, fmt } = cfg;
  const { source, edge, mode, widthCmp, widthUs, pre, pause, level, hysteresis, content } = cfg.trigger;
  const setPins = field("pins");
  const setAnalog = field("analog");
  const setDecoders = field("decoders");
  const setFmt = field("fmt");
  const [setSource, setEdge, setMode, setWidthCmp, setWidthUs, setPre, setPause, setLevel, setHysteresis, setContent] = [
    trig("source"),
    trig("edge"),
    trig("mode"),
    trig("widthCmp"),
    trig("widthUs"),
    trig("pre"),
    trig("pause"),
    trig("level"),
    trig("hysteresis"),
    trig("content"),
  ];
  const divIdx = Math.max(0, TIMEBASE_NS.indexOf(cfg.divNs));
  const setDivIdx = (i: number) => field("divNs")(TIMEBASE_NS[i]);
  const [synthPins, setSynthPins] = useState<string>("");
  const [cursors, setCursors] = useState<{ a: number; b: number } | null>(null);
  const [capture, setCapture] = useState<ScopeCapture | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [dragPre, setDragPre] = useState<number | null>(null);
  const [plotWidth, setPlotWidth] = useState(800);
  const traces = useRef(new Map<string, Trace>());
  const atraces = useRef(new Map<string, ATrace>());
  /** The live (rolling) view is shown, not a capture. */
  const liveRef = useRef(false);
  const lastTime = useRef(0);
  const plot = useRef<SVGSVGElement>(null);
  const { setProbes, setAnalogProbes, setTrigger, armTrigger, onFrame, ready, pause: pauseRun } = runner;
  const divNs = TIMEBASE_NS[divIdx];
  const windowNs = divNs * DIVISIONS;
  const analogNames = analog.map((a) => `V(${a.spec})`);
  const analogSource = source.startsWith("V(");
  // A content trigger: the decoder it looks at and what it looks for.
  const contentDecoder = source.startsWith("dec:") ? decoders.find((d) => `dec:${d.id}` === source) : undefined;
  const contentSource = source.startsWith("dec:");
  const match = contentDecoder ? contentMatch(content, contentDecoder.type) : null;
  // M26: the simulator looks for it, on every edge as it is simulated;
  // otherwise (a condition it does not know) the view does, frame by frame.
  const exact = contentDecoder !== undefined && match !== null && exactContent(contentDecoder.type, match);
  const sourceProbed = pins.includes(source) || analogNames.includes(source) || contentDecoder !== undefined;

  useEffect(() => {
    if (ready) setProbes(pins);
  }, [pins, ready, setProbes]);
  const analogKey = analog.map((a) => a.spec).join("\n");
  useEffect(() => {
    if (ready) setAnalogProbes(analogKey ? analogKey.split("\n") : []);
    atraces.current.clear();
  }, [analogKey, ready, setAnalogProbes]);
  useEffect(() => () => setAnalogProbes([]), [setAnalogProbes]);

  // The simulator's trigger (none for a content trigger done here).
  const contentKey0 = exact ? JSON.stringify([contentDecoder, match]) : "";
  const config = useMemo<TriggerConfig | null>(() => {
    if (contentKey0) {
      const [decoder, m] = JSON.parse(contentKey0) as [DecoderCfg, ContentMatch];
      return { source, edge: "rising", mode, windowNs, pre, pause, content: { decoder, match: m } };
    }
    return contentSource
      ? null
      : {
            source,
            edge,
            mode,
            windowNs,
            pre,
            width: widthCmp === "off" || analogSource ? undefined : { cmp: widthCmp, ns: widthUs * 1000 },
            pause,
            ...(analogSource ? { level, hysteresis } : {}),
          };
  }, [contentKey0, contentSource, source, edge, mode, windowNs, pre, widthCmp, widthUs, pause, analogSource, level, hysteresis]);
  const configRef = useRef(config);
  configRef.current = config;
  // New settings: wait for a capture taken with them.
  useEffect(() => {
    if (ready) setTrigger(config);
    setCapture(null);
  }, [config, ready, setTrigger]);
  useEffect(() => () => setTrigger(null), [setTrigger]);

  // The content trigger, run on every frame (see `onFrame` below).
  const contentRef = useRef<ContentRun | null>(null);
  contentRef.current =
    contentDecoder && match && !exact ? { dec: contentDecoder, match, mode, pre, windowNs, pause, pins, analog: analogNames } : null;
  // (Probes added or removed do not re-arm.)
  const contentKey = contentRef.current ? JSON.stringify({ ...contentRef.current, pins: 0, analog: 0 }) : "";
  /** Where the content trigger stands (see `contentStep`), and the state shown. */
  const scan = useRef<ContentScan>({ st: null, pending: null, done: false, seq: 0 });
  const [contentState, setContentState] = useState<ScopeState>("armed");
  const rearm = () => {
    scan.current = { st: null, pending: null, done: false, seq: scan.current.seq };
    setContentState("armed");
  };
  useEffect(() => {
    rearm();
    if (contentKey) setCapture(null);
  }, [contentKey]);
  const pauseRef = useRef(pauseRun);
  pauseRef.current = pauseRun;

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
          atraces.current.clear();
          setCapture(null);
          if (scan.current.st) scan.current = { st: null, pending: null, done: false, seq: scan.current.seq };
        }
        lastTime.current = f.timeMs;
        const keepFrom = f.timeMs - KEEP_MS;
        for (const a of f.analog ?? []) {
          let t = atraces.current.get(a.name);
          if (!t) {
            t = { v0: a.v0, samples: [] };
            atraces.current.set(a.name, t);
          }
          for (const s of a.samples) t.samples.push(s);
          let drop = 0;
          while (drop < t.samples.length && t.samples[drop][0] < keepFrom) drop++;
          if (drop > 0) {
            t.v0 = t.samples[drop - 1][1];
            t.samples.splice(0, drop);
          }
        }
        const synth = f.probes
          .filter((p) => p.synth)
          .map((p) => p.name)
          .join(" ");
        setSynthPins((old) => (old === synth ? old : synth));
        for (const p of f.probes) {
          let t = traces.current.get(p.name);
          if (!t) {
            t = { level0: p.level0, edges: [], dense: false, since: f.timeMs };
            traces.current.set(p.name, t);
          }
          for (const e of p.edges) t.edges.push(e);
          t.dense = p.dense;
          let drop = 0;
          while (drop < t.edges.length && t.edges[drop][0] < keepFrom) drop++;
          if (drop > 0) {
            t.level0 = t.edges[drop - 1][1];
            t.edges.splice(0, drop);
          }
          t.since = Math.max(t.since, keepFrom);
        }
        const k = contentRef.current;
        if (k) {
          const c = contentStep(k, scan.current, f.timeMs, traces.current, atraces.current);
          if (c) {
            setCapture(c);
            if (k.pause) pauseRef.current("trigger");
          }
          const st: ScopeState = scan.current.done ? "stopped" : scan.current.pending !== null ? "collecting" : "armed";
          setContentState((old) => (old === st ? old : st));
          return;
        }
        const c = f.scope?.capture;
        // (One still on its way from before a change of settings is dropped.)
        const kc = configRef.current;
        if (c && kc && c.source === kc.source && near(c.endNs - c.startNs, kc.windowNs) && near(c.startNs, -kc.pre * kc.windowNs))
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
  const state: ScopeState = contentSource && !exact ? contentState : (f?.scope?.state ?? "armed");
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
  const arows = analog.map((cfg) => {
    const name = `V(${cfg.spec})`;
    if (showCapture) {
      const ch = capture.analog?.find((c) => c.name === name);
      return { cfg, name, ch, live: undefined };
    }
    return { cfg, name, ch: undefined, live: atraces.current.get(name) };
  });

  // What is measured: the trigger source, or a content trigger's decoder's first pin (its clock).
  const measured = showCapture && !capture.source.startsWith("dec:") ? capture.source : (contentDecoder?.pins[0] ?? source);
  const sourceStats: PulseStats | undefined = useMemo(() => {
    if (showCapture) {
      const ch = capture.channels.find((c) => c.name === measured);
      if (!ch) return undefined;
      const [a, b] = validSpan(ch, capture.startNs, capture.endNs);
      return measurePulses(ch, a, b);
    }
    const t = traces.current.get(measured);
    if (!t) return undefined;
    return measurePulses(liveNs(t, now), -windowNs, 0);
    // The live traces change in place with each frame (`now`).
  }, [showCapture, capture, measured, now, windowNs]);

  // Analog measurements over the capture (or the live window).
  const astats: (AnalogStats | undefined)[] = arows.map(({ ch, live: t }) => {
    if (ch) {
      const [a, b] = [Math.max(capture!.startNs, ch.fromNs), Math.min(capture!.endNs, ch.toNs)];
      return measureAnalog(ch, a, b);
    }
    if (t) return measureAnalog(t, now - windowMs, now);
    return undefined;
  });

  // Decoders, over the capture or the shown live window (ns).
  const lineOf = (name: string): { line: Line; to: number } | null => {
    if (!name) return null;
    if (showCapture) {
      const ch = capture.channels.find((c) => c.name === name);
      return ch ? { line: ch, to: Math.min(ch.toNs, capture.endNs) } : null;
    }
    const t = traces.current.get(name);
    if (!t) return null;
    const ns = liveNs(t, now);
    const level0 = levelAt(ns, -windowNs);
    return { line: { level0, edges: ns.edges.filter((e) => e[0] >= -windowNs) }, to: 0 };
  };
  const from = showCapture ? capture.startNs : -windowNs;
  const decoded: Annotation[][] = decoders.map((d) => runDecoder(d, lineOf, from));

  const truncated =
    showCapture && capture.channels.some((c) => c.fromNs > capture.startNs || c.toNs < capture.endNs);
  const digitalH = pins.length * ROW;
  const lanesTop = TOP + digitalH;
  const analogTop = lanesTop + decoders.length * LANE;
  const plotH = digitalH + decoders.length * LANE + analog.length * AROW;
  const height = TOP + plotH + AXIS;
  const markerPre = dragPre ?? pre;
  const markerX = showCapture && dragPre === null ? x(0) : markerPre * W;
  const separators = [
    ...pins.map((_, i) => TOP + (i + 1) * ROW),
    ...decoders.map((_, i) => lanesTop + (i + 1) * LANE),
    ...analog.map((_, i) => analogTop + (i + 1) * AROW),
  ].slice(0, -1);
  const synth = new Set(synthPins.split(" "));
  const allPins = [...new Set([...PIN_NAMES])];
  const analogChoices = [...PIN_NAMES.filter((n) => n.startsWith("PA") || n.startsWith("PB") || n.startsWith("PC")), ...partPins(parts)].filter(
    (n) => !analog.some((a) => a.spec === n),
  );
  const addPins = (list: string[]) => setPins((p) => [...p, ...list.filter((n) => n && !p.includes(n))]);
  const updateDecoder = (id: number, patch: Partial<DecoderCfg>) =>
    setDecoders((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)));

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
              if (!sourceProbed) setSource(n);
            }}
          >
            <option value="">…</option>
            {PIN_NAMES.filter((n) => !pins.includes(n)).map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <label>
          아날로그 추가{" "}
          <select
            value=""
            aria-label="아날로그 채널 추가"
            onChange={(e) => {
              const n = e.target.value;
              if (!n) return;
              setAnalog((a) => [...a, { spec: n, vdiv: 1, offset: 1.65 }]);
            }}
          >
            <option value="">…</option>
            {analogChoices.map((n) => (
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
        <button disabled={!showCapture} onClick={() => capture && download(`simucleo-capture-${capture.seq}.csv`, captureCsv(capture), "text/csv")}>
          CSV 내보내기
        </button>
        <button
          disabled={!showCapture}
          onClick={() => capture && download(`simucleo-capture-${capture.seq}.vcd`, captureVcd(capture), "text/plain")}
        >
          VCD 내보내기
        </button>
        <span className="hint">핀의 실제 레벨(입력 포함)과 네트 전압을 보여 줍니다.</span>
      </div>
      <div className="wave-controls scope-controls">
        <b>트리거</b>
        <label>
          소스{" "}
          <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="트리거 소스">
            {!sourceProbed && <option value={source}>{source} (프로브 안 됨)</option>}
            {pins.map((n) => (
              <option key={n}>{n}</option>
            ))}
            {analogNames.map((n) => (
              <option key={n}>{n}</option>
            ))}
            {decoders.map((d, di) => (
              <option key={d.id} value={`dec:${d.id}`}>
                해독 {di + 1}: {DECODER_NAMES[d.type]} {d.pins.filter(Boolean).join("/")}
              </option>
            ))}
          </select>
        </label>
        {!contentSource && (
          <label>
            에지{" "}
            <select value={edge} onChange={(e) => setEdge(e.target.value as EdgeKind)} aria-label="트리거 에지">
              <option value="rising">상승 ↑</option>
              <option value="falling">하강 ↓</option>
              <option value="either">양쪽 ↕</option>
            </select>
          </label>
        )}
        <label>
          모드{" "}
          <select value={mode} onChange={(e) => setMode(e.target.value as Mode)} aria-label="트리거 모드">
            <option value="auto">자동 (Auto)</option>
            <option value="normal">일반 (Normal)</option>
            <option value="single">단일 (Single)</option>
          </select>
        </label>
        {contentDecoder ? (
          <>
            <ContentControls cfg={content} type={contentDecoder.type} valid={match !== null} onChange={setContent} />
            {match && (
              <span
                className={`content-mode${exact ? " exact" : ""}`}
                data-testid="content-mode"
                data-mode={exact ? "exact" : "view"}
                title={
                  exact
                    ? "시뮬레이터가 모든 에지를 해독해 일치한 항목의 시작 사이클에 트리거합니다"
                    : "화면이 프레임마다 실시간 기록을 해독합니다 (빠른 신호는 놓칠 수 있음)"
                }
              >
                {exact ? "정확(시뮬레이터)" : "화면 해독"}
              </span>
            )}
          </>
        ) : contentSource ? null : analogSource ? (
          <>
            <label>
              레벨{" "}
              <input
                type="number"
                step="any"
                value={level}
                onChange={(e) => e.target.value !== "" && setLevel(Number(e.target.value))}
                aria-label="트리거 레벨 (V)"
                className="num"
              />{" "}
              V
            </label>
            <label>
              히스테리시스{" "}
              <input
                type="number"
                min={0}
                step="any"
                value={hysteresis}
                onChange={(e) => Number(e.target.value) >= 0 && setHysteresis(Number(e.target.value))}
                aria-label="히스테리시스 (V)"
                className="num"
              />{" "}
              V
            </label>
          </>
        ) : (
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
        )}
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
        {mode === "single" && <button onClick={contentSource && !exact ? rearm : armTrigger}>다시 대기 (Arm)</button>}
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
          {state === "nosource" || !sourceProbed
            ? STATE_TEXT.nosource
            : live
              ? `${STATE_TEXT[state]}${state === "armed" ? " (자동: 실시간 표시)" : ""}`
              : STATE_TEXT[state]}
        </span>
      </div>
      <div className="wave-controls scope-controls">
        <b>디코더</b>
        <label>
          추가{" "}
          <select
            value=""
            aria-label="디코더 추가"
            onChange={(e) => {
              const type = e.target.value as DecoderType;
              if (!type) return;
              const d = newDecoder(Math.max(0, ...decoders.map((q) => q.id)) + 1, type);
              setDecoders((ds) => [...ds, d]);
              addPins(d.pins);
            }}
          >
            <option value="">…</option>
            {DECODER_TYPES.map((t) => (
              <option key={t} value={t}>
                {DECODER_NAMES[t]}
              </option>
            ))}
          </select>
        </label>
        <label>
          표시{" "}
          <select value={fmt} onChange={(e) => setFmt(e.target.value as Format)} aria-label="표시 형식">
            <option value="hex">16진수</option>
            <option value="ascii">ASCII</option>
          </select>
        </label>
        {decoders.length === 0 && <span className="hint">UART·I2C·SPI·1-Wire·TM1637·WS2812·IR(NEC)을 파형 위에 풀어 보여 줍니다.</span>}
      </div>
      {decoders.map((d, di) => (
        <div key={d.id} className="wave-controls scope-controls decoder-cfg" data-testid={`decoder-${di}`}>
          <b>{DECODER_NAMES[d.type]}</b>
          {PIN_ROLES[d.type].map((role, k) => (
            <label key={role}>
              {role}{" "}
              <select
                value={d.pins[k]}
                aria-label={`${DECODER_NAMES[d.type]} ${role}`}
                onChange={(e) => {
                  const pinsNext = d.pins.map((p, j) => (j === k ? e.target.value : p));
                  updateDecoder(d.id, { pins: pinsNext });
                  addPins([e.target.value]);
                }}
              >
                {k >= 2 && <option value="">없음</option>}
                {allPins.map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
            </label>
          ))}
          {d.type === "uart" && (
            <>
              <label>
                보드레이트{" "}
                <input
                  type="number"
                  min={1}
                  value={d.baud}
                  onChange={(e) => Number(e.target.value) > 0 && updateDecoder(d.id, { baud: Number(e.target.value) })}
                  aria-label="UART 보드레이트"
                  className="num wide"
                />
              </label>
              <label>
                패리티{" "}
                <select value={d.parity} onChange={(e) => updateDecoder(d.id, { parity: e.target.value as Parity })} aria-label="UART 패리티">
                  <option value="none">없음 (8N1)</option>
                  <option value="even">짝수</option>
                  <option value="odd">홀수</option>
                </select>
              </label>
            </>
          )}
          {d.type === "spi" && (
            <>
              <label>
                모드{" "}
                <select value={d.mode} onChange={(e) => updateDecoder(d.id, { mode: Number(e.target.value) })} aria-label="SPI 모드">
                  {[0, 1, 2, 3].map((m) => (
                    <option key={m} value={m}>
                      {m} (CPOL {m >> 1}, CPHA {m & 1})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <input type="checkbox" checked={d.lsbFirst} onChange={(e) => updateDecoder(d.id, { lsbFirst: e.target.checked })} /> LSB 먼저
              </label>
            </>
          )}
          <button aria-label={`디코더 ${di + 1} 제거`} onClick={() => setDecoders((ds) => ds.filter((x) => x.id !== d.id))}>
            ×
          </button>
          <span className="dim">{decoded[di].length}개</span>
        </div>
      ))}
      {active && (
        <>
          <div className="scope-body">
            <div className="wave-labels" style={{ paddingTop: TOP }}>
              {rows.map(({ name, ch, live: t }) => (
                <div key={name} className="wave-label" data-probe={name} style={{ height: ROW }}>
                  <b className={name === source ? "trig-src" : undefined}>{name}</b>
                  {synth.has(name) && (
                    <span className="synth" title="USART·I2C·SPI가 옮긴 바이트로 만든 파형 (GPIO는 비트 단위로 토글하지 않습니다)">
                      합성
                    </span>
                  )}
                  <button aria-label={`${name} 제거`} onClick={() => setPins((p) => p.filter((q) => q !== name))}>
                    ×
                  </button>
                  <div className="dim" data-testid={`probe-${name}`}>
                    {rowText(ch, t, v, now, windowNs)}
                  </div>
                </div>
              ))}
              {decoders.map((d) => (
                <div key={d.id} className="wave-label lane-label" style={{ height: LANE }}>
                  {DECODER_NAMES[d.type]} {d.pins.filter(Boolean).join("/")}
                </div>
              ))}
              {arows.map(({ cfg, name }, i) => (
                <div key={name} className="wave-label analog-label" data-analog={cfg.spec} style={{ height: AROW }}>
                  <div>
                    <b className={name === source ? "trig-src" : undefined}>{name}</b>
                    <button aria-label={`${name} 제거`} onClick={() => setAnalog((a) => a.filter((q) => q.spec !== cfg.spec))}>
                      ×
                    </button>
                  </div>
                  <div>
                    <select
                      value={cfg.vdiv}
                      aria-label={`${name} V/눈금`}
                      onChange={(e) => setAnalog((a) => a.map((q) => (q.spec === cfg.spec ? { ...q, vdiv: Number(e.target.value) } : q)))}
                    >
                      {VOLTS_DIV.map((vd) => (
                        <option key={vd} value={vd}>
                          {fmtVolts(vd)}/div
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    중앙{" "}
                    <input
                      type="number"
                      step="any"
                      className="num"
                      value={cfg.offset}
                      aria-label={`${name} 오프셋 (V)`}
                      onChange={(e) =>
                        e.target.value !== "" &&
                        setAnalog((a) => a.map((q) => (q.spec === cfg.spec ? { ...q, offset: Number(e.target.value) } : q)))
                      }
                    />{" "}
                    V
                  </div>
                  <div className="dim">{astats[i] ? `평균 ${fmtVolts(astats[i]!.mean)}` : "—"}</div>
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
              <Grid width={W} top={TOP} height={plotH} separators={separators} view={v} />
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
              {decoders.map((d, di) => (
                <Lane
                  key={d.id}
                  anns={decoded[di]}
                  y={lanesTop + di * LANE}
                  x={(t) => (showCapture ? x(t) : ((t + windowNs) / windowNs) * W)}
                  from={showCapture ? v.start : -windowNs}
                  to={showCapture ? v.start + v.span : 0}
                  fmt={fmt}
                  width={W}
                  testId={`lane-${di}`}
                />
              ))}
              {arows.map(({ cfg, name, ch, live: t }, i) => {
                const y0 = analogTop + i * AROW;
                const yOf = (volts: number) => {
                  const y = y0 + AROW / 2 - ((volts - cfg.offset) / cfg.vdiv) * (AROW / ADIVS);
                  return Math.round(Math.min(y0 + AROW - 1, Math.max(y0 + 1, y)) * 2) / 2;
                };
                let points = "";
                if (ch) points = analogPoints(ch, v.start, v.start + v.span, W, yOf);
                else if (t && live) points = analogPoints(t, now - windowMs, now, W, yOf);
                const trigY = name === source ? yOf(level) : null;
                return (
                  <g key={name} data-atrace={cfg.spec} className="analog-trace">
                    {Array.from({ length: ADIVS - 1 }, (_, k) => (
                      <line key={k} className="adiv" x1={0} x2={W} y1={y0 + ((k + 1) * AROW) / ADIVS} y2={y0 + ((k + 1) * AROW) / ADIVS} />
                    ))}
                    {trigY !== null && <line className="alevel" x1={0} x2={W} y1={trigY} y2={trigY} />}
                    <polyline points={points} />
                  </g>
                );
              })}
              {!showCapture && !live && (
                <text x={W / 2} y={TOP + plotH / 2} className="scope-wait" textAnchor="middle">
                  트리거 대기 중…
                </text>
              )}
              {/* Trigger marker: T at t = 0, drag to move the trigger position. */}
              {markerX >= -1 && markerX <= W + 1 && (
                <g className={`trig-marker${showCapture && dragPre === null ? "" : " pending"}`} transform={`translate(${markerX},0)`}>
                  <line y1={TOP} y2={TOP + plotH} />
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
                  <Cursor x={x(cursors.a)} label="A" h={TOP + plotH} id="a" />
                  <Cursor x={x(cursors.b)} label="B" h={TOP + plotH} id="b" />
                </>
              )}
            </svg>
          </div>
          {truncated && (
            <div className="scope-note" data-testid="scope-truncated">
              에지가 너무 많아 버퍼(핀당 {CAPTURE_EDGES.toLocaleString()}개)를 넘었습니다 — 빗금 구간은 기록되지 않았습니다. 시간/눈금을 줄이세요.
            </div>
          )}
          <Measurements stats={sourceStats} source={measured} cursors={cursors} live={!showCapture} />
          {arows.length > 0 && <AnalogTable rows={arows.map((r, i) => ({ spec: r.cfg.spec, name: r.name, stats: astats[i] }))} live={!showCapture} />}
          {decoders.map((d, di) => (
            <DecodedTable key={d.id} index={di} cfg={d} anns={decoded[di]} fmt={fmt} />
          ))}
        </>
      )}
    </div>
  );
}

/** A decoder's annotations as boxes (errors in red). */
function Lane({
  anns,
  y,
  x,
  from,
  to,
  fmt,
  width,
  testId,
}: {
  anns: Annotation[];
  y: number;
  x: (t: number) => number;
  from: number;
  to: number;
  fmt: Format;
  width: number;
  testId: string;
}) {
  const shown = anns.filter((a) => a.end >= from && a.start <= to);
  if (shown.length > 3000) {
    return (
      <text x={4} y={y + LANE / 2 + 4} className="lane-dense" data-testid={testId}>
        {shown.length}개 — 확대하면 보입니다
      </text>
    );
  }
  return (
    <g data-testid={testId} className="lane">
      {shown.map((a, i) => {
        const x0 = Math.max(-2, x(a.start));
        const x1 = Math.min(width + 2, x(a.end));
        if (a.kind === "start" || a.kind === "restart" || a.kind === "stop") {
          return (
            <g key={i} className={`dec-mark ${a.kind}`}>
              <line x1={x0} x2={x0} y1={y + 2} y2={y + LANE - 2} />
              <text x={x0 + 2} y={y + LANE / 2 + 4}>
                {annotationLabel(a, fmt)}
              </text>
            </g>
          );
        }
        const label = annotationLabel(a, fmt);
        const w = x1 - x0;
        return (
          <g key={i} className={`dec-box${a.error ? " err" : ""}${a.kind === "pixel" ? " pixel" : ""}`}>
            <rect
              x={x0}
              y={y + 3}
              width={Math.max(1, w)}
              height={LANE - 6}
              rx={3}
              style={a.kind === "pixel" && !a.error ? { fill: fmtColor(a.value!) } : undefined}
            />
            {w > 6 * Math.min(label.length, 4) && (
              <text x={(x0 + x1) / 2} y={y + LANE / 2 + 4} textAnchor="middle">
                {w > 6.5 * label.length ? label : label.slice(0, Math.max(1, Math.floor(w / 6.5) - 1)) + "…"}
              </text>
            )}
            <title>
              {fmtTime(a.start)} {label}
              {a.error ? ` — ${a.error}` : ""}
            </title>
          </g>
        );
      })}
    </g>
  );
}

function DecodedTable({ index, cfg, anns, fmt }: { index: number; cfg: DecoderCfg; anns: Annotation[]; fmt: Format }) {
  const errors = anns.filter((a) => a.error).length;
  const shown = cfg.type === "tm1637" ? tm1637Display(anns) : null;
  const frame = cfg.type === "ws2812" ? ws2812Frame(anns) : null;
  const ir = cfg.type === "nec" ? necLast(anns) : null;
  return (
    <div className="decode-table">
      <table data-testid={`decode-table-${index}`}>
        <caption>
          {DECODER_NAMES[cfg.type]} {cfg.pins.filter(Boolean).join("/")} — {anns.length}개{errors > 0 && <span className="err"> · 오류 {errors}</span>}
          {cfg.type === "uart" && anns.length > 0 && (
            <span className="decode-text" data-testid={`decode-text-${index}`}>
              {" "}
              “{uartText(anns)}”
            </span>
          )}
          {shown && (
            <span className="decode-text" data-testid={`decode-display-${index}`} data-text={shown.text}>
              {" "}
              표시 “{shown.text}”
            </span>
          )}
          {ir && (
            <span className="decode-text" data-testid={`decode-ir-${index}`} data-addr={ir.addr} data-cmd={ir.cmd}>
              {" "}
              마지막 주소 {fmtByte(ir.addr, "hex")} · 명령 {fmtByte(ir.cmd, "hex")}
            </span>
          )}
          {frame && frame.length > 0 && (
            <span className="decode-text" data-testid={`decode-frame-${index}`} data-colors={frame.map(fmtColor).join(" ")}>
              {" "}
              마지막 프레임 {frame.length}픽셀{" "}
              {frame.slice(0, 64).map((c, k) => (
                <span key={k} className="swatch" style={{ background: fmtColor(c) }} title={`#${k} ${fmtColor(c)}`} />
              ))}
            </span>
          )}
        </caption>
        <thead>
          <tr>
            <th>시각</th>
            <th>종류</th>
            <th>값</th>
            <th>오류</th>
          </tr>
        </thead>
        <tbody>
          {anns.slice(0, TABLE_ROWS).map((a, i) => (
            <tr
              key={i}
              className={a.error ? "err" : undefined}
              data-kind={a.kind}
              data-t={a.start}
              data-value={a.value}
              data-note={a.note}
              data-index={a.index}
            >
              <td>{fmtTime(a.start)}</td>
              <td>{KIND_TEXT[a.kind]}</td>
              <td>
                {a.kind === "pixel" && !a.error && <span className="swatch" style={{ background: fmtColor(a.value!) }} />}
                {a.kind === "start" || a.kind === "restart" || a.kind === "stop" ? "" : annotationLabel(a, fmt)}
              </td>
              <td>{a.error ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {anns.length > TABLE_ROWS && <div className="dim">처음 {TABLE_ROWS}개만 표시합니다.</div>}
    </div>
  );
}

/** What a content trigger looks for: the kind (if the decoder has several) and its value. */
function ContentControls({ cfg, type, valid, onChange }: { cfg: ContentCfg; type: DecoderType; valid: boolean; onChange: (c: ContentCfg) => void }) {
  const kinds = contentKinds(type);
  const kind = kinds.includes(cfg.kind) ? cfg.kind : kinds[0];
  const set = (patch: Partial<ContentCfg>) => onChange({ ...cfg, kind, ...patch });
  return (
    <>
      <label>
        조건{" "}
        <select value={kind} onChange={(e) => set({ kind: e.target.value as ContentCfg["kind"] })} aria-label="해독 트리거 조건">
          {kinds.map((k) => (
            <option key={k} value={k}>
              {CONTENT_KIND_TEXT[k]}
            </option>
          ))}
        </select>
      </label>
      {kind === "pixel" ? (
        <>
          <label>
            번호{" "}
            <input
              type="number"
              min={0}
              step={1}
              className="num"
              value={cfg.index}
              aria-label="해독 트리거 픽셀 번호"
              onChange={(e) => Number.isInteger(Number(e.target.value)) && Number(e.target.value) >= 0 && set({ index: Number(e.target.value) })}
            />
          </label>
          <label>
            색{" "}
            <input
              className="num wide"
              value={cfg.color}
              placeholder="아무 색"
              aria-label="해독 트리거 픽셀 색"
              onChange={(e) => set({ color: e.target.value })}
            />
          </label>
        </>
      ) : (
        <label>
          {kind === "text" ? "글자" : kind === "address" ? "주소" : kind === "nec" ? "명령" : "값"}{" "}
          <input
            className="num wide"
            value={cfg.text}
            placeholder={kind === "text" ? "OK\\r\\n" : "0x41"}
            aria-label="해독 트리거 값"
            onChange={(e) => set({ text: e.target.value })}
          />
        </label>
      )}
      {kind === "nec" && (
        <label>
          주소{" "}
          <input
            className="num wide"
            value={cfg.addr}
            placeholder="아무 주소"
            aria-label="해독 트리거 IR 주소"
            onChange={(e) => set({ addr: e.target.value })}
          />
        </label>
      )}
      {kind === "address" && (
        <select value={cfg.rw} onChange={(e) => set({ rw: e.target.value as ContentCfg["rw"] })} aria-label="해독 트리거 R/W">
          <option value="any">R/W</option>
          <option value="W">W (쓰기)</option>
          <option value="R">R (읽기)</option>
        </select>
      )}
      {!valid && (
        <span className="err" data-testid="content-invalid">
          값을 읽을 수 없습니다 (예: 0x41, 'A', 65{kind === "pixel" ? ", #FF8000" : ""})
        </span>
      )}
    </>
  );
}

function AnalogTable({ rows, live }: { rows: { spec: string; name: string; stats?: AnalogStats }[]; live: boolean }) {
  const cell = (v: number | undefined) => (v === undefined ? "—" : fmtVolts(v));
  return (
    <div className="scope-measure">
      <table>
        <thead>
          <tr>
            <th>아날로그 측정{live ? " (실시간)" : " (캡처)"}</th>
            <th>최소</th>
            <th>최대</th>
            <th>평균</th>
            <th>Vpp</th>
            <th>RMS</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ spec, name, stats: s }) => (
            <tr
              key={spec}
              data-testid={`analog-${spec}`}
              data-min={s?.min}
              data-max={s?.max}
              data-mean={s?.mean}
              data-vpp={s?.vpp}
              data-rms={s?.rms}
            >
              <th>{name}</th>
              <td>{cell(s?.min)}</td>
              <td>{cell(s?.max)}</td>
              <td>{cell(s?.mean)}</td>
              <td>{cell(s?.vpp)}</td>
              <td>{cell(s?.rms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Lines of a decoder's pins: the line and how far it is known (ns). */
type LineOf = (pin: string) => { line: Line; to: number } | null;

/** Decoder `d` over its pins' lines, from `from` (ns). */
function runDecoder(d: DecoderCfg, lineOf: LineOf, from: number): Annotation[] {
  const ls = d.pins.map(lineOf);
  switch (d.type) {
    case "uart":
      return ls[0] ? decodeUart(ls[0].line, { baud: d.baud, parity: d.parity }, ls[0].to) : [];
    case "i2c":
      return ls[0] && ls[1] ? decodeI2c(ls[0].line, ls[1].line) : [];
    case "spi":
      return ls[0] && ls[1]
        ? decodeSpi(ls[0].line, ls[1].line, ls[2]?.line ?? null, ls[3]?.line ?? null, {
            cpol: (d.mode & 2) !== 0,
            cpha: (d.mode & 1) !== 0,
            msbFirst: !d.lsbFirst,
          })
        : [];
    case "onewire":
      return ls[0] ? decodeOneWire(ls[0].line, ls[0].to) : [];
    case "tm1637":
      return ls[0] && ls[1] ? decodeTm1637(ls[0].line, ls[1].line) : [];
    case "ws2812":
      return ls[0] ? decodeWs2812(ls[0].line, from, ls[0].to) : [];
    case "nec":
      return ls[0] ? decodeNec(ls[0].line) : [];
  }
}

/** A live trace (ms) from `from` on, in ns of the simulated clock. */
function liveLine(t: Trace, from: number): Line {
  const ms = from / 1e6;
  const i = lowerBound(t.edges, ms);
  return {
    level0: i === 0 ? t.level0 : t.edges[i - 1][1],
    edges: t.edges.slice(i).map(([m, l]) => [m * 1e6, l] as [number, boolean]),
  };
}

interface ContentRun {
  dec: DecoderCfg;
  match: ContentMatch;
  mode: Mode;
  pre: number;
  windowNs: number;
  pause: boolean;
  /** The probed pins and analog channels (`V(…)`) a capture holds. */
  pins: string[];
  analog: string[];
}
interface ContentScan {
  st: ScanState | null;
  /** A match (ns) whose window is not complete yet. */
  pending: number | null;
  /** Single: captured, until armed again. */
  done: boolean;
  seq: number;
}

/**
 * One frame of the content trigger: arm (from now), or decode what came
 * since the last frame and look for the condition, or — when the window
 * around a match is complete — return the capture, cut from the live
 * traces like the simulator's own (times relative to the match's start).
 * Normal and Auto look again after the window; Single waits to be armed.
 */
function contentStep(k: ContentRun, sc: ContentScan, nowMs: number, traces: Map<string, Trace>, atraces: Map<string, ATrace>): ScopeCapture | null {
  const now = nowMs * 1e6;
  if (!sc.st) {
    sc.st = { checked: now, anchor: now - CONTENT_SPAN };
    return null;
  }
  if (sc.pending === null && !sc.done) {
    const r = scanStep(
      (from) => runDecoder(k.dec, (pin) => (traces.get(pin) ? { line: liveLine(traces.get(pin)!, from), to: now } : null), from),
      k.dec.type,
      k.match,
      sc.st,
      now,
      CONTENT_SPAN,
    );
    sc.st = r.state;
    if (r.hits.length) sc.pending = r.hits[0];
  }
  if (sc.pending === null) return null;
  const t0 = sc.pending;
  const startNs = -k.pre * k.windowNs;
  const endNs = (1 - k.pre) * k.windowNs;
  if (now < t0 + endNs + CONTENT_MARGIN) return null;
  sc.pending = null;
  sc.st = { ...sc.st, checked: t0 + endNs };
  if (k.mode === "single") sc.done = true;
  const [a, b] = [(t0 + startNs) / 1e6, (t0 + endNs) / 1e6];
  const channels: CaptureChannel[] = k.pins.flatMap((name) => {
    const t = traces.get(name);
    if (!t) return [];
    const i = lowerBound(t.edges, a);
    const j = lowerBound(t.edges, b);
    return [
      {
        name,
        level0: i === 0 ? t.level0 : t.edges[i - 1][1],
        edges: t.edges.slice(i, j).map(([m, l]) => [m * 1e6 - t0, l] as [number, boolean]),
        fromNs: Math.min(endNs, Math.max(startNs, t.since * 1e6 - t0)),
        toNs: endNs,
      },
    ];
  });
  const analog: CaptureAnalog[] = k.analog.flatMap((name) => {
    const t = atraces.get(name);
    if (!t) return [];
    const i = lowerBound(t.samples, a);
    const j = lowerBound(t.samples, b);
    return [
      {
        name,
        v0: i === 0 ? t.v0 : t.samples[i - 1][1],
        samples: t.samples.slice(i, j).map(([m, v]) => [m * 1e6 - t0, v] as [number, number]),
        fromNs: startNs,
        toNs: endNs,
      },
    ];
  });
  return { seq: ++sc.seq, source: `dec:${k.dec.id}`, triggerMs: t0 / 1e6, startNs, endNs, channels, analog };
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

function Grid({ width, top, height, separators, view }: { width: number; top: number; height: number; separators: number[]; view: View }) {
  const h = height;
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
      {separators.map((y, i) => (
        <line key={`r${i}`} className="row-line" x1={0} x2={width} y1={y} y2={y} />
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
