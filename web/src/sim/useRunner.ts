// React hook around the simulation worker.
import type { DataPlaced, SwvData, SwvSettings } from "../run/swv";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  BluetoothFrame,
  BreakpointSpec,
  DebugFile,
  DebugState,
  DisasmRow,
  FrameMsg,
  FromWorker,
  SimFrame,
  ToWorker,
  WatchpointPlaced,
  WatchpointSpec,
  TriggerConfig,
  WatchValue,
} from "./protocol";
import type { CircuitJson } from "../editor/model";
import { boardSignals, busCatalog } from "../parts";
import { dropStaleCaptures } from "./staleCapture";
import { t } from "../i18n";
import { connectPerf, perfLongTask, perfRunning, perfUpdate, perfWorkerShare } from "./perfStore";

const CONSOLE_LIMIT = 20_000;
const CHAT_LIMIT = 200;

/** One bubble of the Bluetooth chat. */
export interface BtMessage {
  from: "mcu" | "phone" | "system";
  text: string;
  /** Some bytes were re-sampled at a mismatched baud rate. */
  garbled?: boolean;
  /** An MCU message still waiting for its line end. */
  open?: boolean;
}

/** An HC-05 module's phone: its link and the conversation. */
export interface BtChat {
  status: BluetoothFrame;
  messages: BtMessage[];
}

/** Data passes between the MCU and the phone. */
export const btLinked = (s: BluetoothFrame) => s.powered && s.connected && !s.atMode;

/** Fold one frame's HC-05 reports into the chats. */
function mergeBluetooth(prev: Record<string, BtChat>, frames: BluetoothFrame[]): Record<string, BtChat> {
  let changed = frames.length !== Object.keys(prev).length;
  const next: Record<string, BtChat> = {};
  for (const f of frames) {
    const old = prev[f.id];
    const { received, ...rest } = f;
    const sameStatus =
      old && Object.entries(rest).every(([k, v]) => (old.status as unknown as Record<string, unknown>)[k] === v);
    if (old && sameStatus && received.length === 0) {
      next[f.id] = old;
      continue;
    }
    changed = true;
    const messages = old ? [...old.messages] : [];
    for (const [b, garbled] of received) {
      let last = messages[messages.length - 1];
      if (b === 10) {
        if (last?.from === "mcu" && last.open) messages[messages.length - 1] = { ...last, open: false };
        continue;
      }
      if (b === 13) continue;
      if (!(last?.from === "mcu" && last.open)) {
        last = { from: "mcu", text: "", open: true };
        messages.push(last);
      }
      const ch = b >= 32 && b < 127 ? String.fromCharCode(b) : "\uFFFD";
      messages[messages.length - 1] = { ...last, text: last.text + ch, garbled: last.garbled || garbled };
    }
    next[f.id] = { status: { ...f, received: [] }, messages: messages.slice(-CHAT_LIMIT) };
  }
  return changed ? next : prev;
}
const CATALOG = JSON.stringify(busCatalog());
const SIGNALS = JSON.stringify(boardSignals());

export interface Runner {
  ready: boolean;
  firmware: string | null;
  /** The loaded ELF (a copy kept for saving projects) and its example name. */
  firmwareBytes: Uint8Array | null;
  firmwareExample: string | null;
  loadError: string | null;
  running: boolean;
  speed: number;
  frame: SimFrame | null;
  console: string;
  memory: { addr: number; bytes: Uint8Array } | null;
  load(name: string, bytes: ArrayBuffer, example?: string): void;
  run(): void;
  /** Pause; `reason` "trigger" for the waveform view's content trigger. */
  pause(reason?: string): void;
  reset(): void;
  /** Reset, tagging the frames that follow with `epoch` (see `onFrame`). */
  resetEpoch(epoch: number): void;
  /**
   * Called with every frame as it arrives (none is skipped, unlike the
   * `frame` state, which React may batch). Returns the unsubscribe.
   */
  onFrame(listener: FrameListener): () => void;
  setSpeed(v: number): void;
  /** Cap the speed (Infinity lifts it), e.g. while grading times button presses. */
  setSpeedCap(v: number): void;
  /** Press or release a switch: a tact-switch part id, or "B1". */
  press(part: string, pressed: boolean): void;
  setWiring(circuit: CircuitJson): void;
  /** Pins whose edges the frames report; each `owner` (default: the
   * waveform view) keeps its own list and the union is probed. */
  setProbes(pins: string[], owner?: string): void;
  /** Analog probes (net voltages): "PA1" or "part.pin". */
  setAnalogProbes(specs: string[]): void;
  /** Oscilloscope trigger over the probed pins (null: none); re-arms. */
  setTrigger(config: TriggerConfig | null): void;
  /** Wait for the next trigger (after a Single capture). */
  armTrigger(): void;
  sendConsole(text: string): void;
  clearConsole(): void;
  /** HC-05 modules by part id: link status and chat. */
  bluetooth: Record<string, BtChat>;
  /** The phone of HC-05 `part` sends `text` (a line end is added). */
  bluetoothSend(part: string, text: string): void;
  bluetoothConnect(part: string, on: boolean): void;
  clearBluetooth(part: string): void;
  readMemory(addr: number, len: number): void;
  /** The SD card in part `part` as a disk image (empty: no card). */
  sdImage(part: string): Promise<Uint8Array>;
  sdLoad(part: string, bytes: ArrayBuffer): void;
  /** The card's blocks in use (what is kept in IndexedDB; empty: no card). */
  sdSnapshot(part: string): Promise<Uint8Array>;
  /** Put back what `sdSnapshot` gave. */
  sdRestore(part: string, bytes: ArrayBuffer): void;
  /** Erase the card: all zeros, no file system. */
  sdWipe(part: string): void;
  /** Turn a rotary encoder by detents (negative: counter-clockwise). */
  rotate(part: string, detents: number): void;
  /** Source files of the loaded firmware (from its debug information). */
  debugFiles: DebugFile[];
  /** Where each breakpoint landed (the line with code). */
  breakpoints: { file: number; line: number }[];
  setBreakpoints(list: BreakpointSpec[]): void;
  step(kind: "instruction" | "into" | "over" | "out"): void;
  /** Bumped whenever the debugger paused execution; with the reason. */
  pauseEvent: { n: number; reason: string };
  debugState: DebugState | null;
  requestDebugState(frame: number, globalsFile: number): void;
  /** Machine code around an address (null: the pc). */
  disasm: DisasmRow[];
  requestDisasm(addr: number | null): void;
  /** Values of watch expressions, in the order asked. */
  watch: WatchValue[];
  requestWatch(exprs: string[], frame: number): void;
  /** Set a variable; the outcome arrives in `assigned` (bumped each time). */
  setVariable(target: string, value: string, frame: number): void;
  /** Data watchpoints, resolved in call-stack frame `frame`. */
  setWatchpoints(list: WatchpointSpec[], frame: number): void;
  watchpoints: WatchpointPlaced[];
  /** SWV: start the trace with these settings, or stop it (null). The
   * trace comes with each frame (`onFrame`, `FrameMsg.swv`). */
  setSwv(settings: SwvSettings | null): void;
  /** Where each SWV data trace expression landed. */
  swvPlaced: DataPlaced[];
  /** Bumped by every successful firmware load, also of the same file again
   * (a rebuild): what describes the last run starts over. */
  loadGen: number;
  /** Look at an RTOS task's call stack (null: the running code). */
  selectTask(tcb: number | null): void;
  assigned: { n: number; target: string; result: WatchValue | null };
}

/** A frame as delivered by the worker, with the console text it brought. */
export interface FrameEvent {
  frame: SimFrame;
  console: string;
  running: boolean;
  epoch: number;
  /** See `FrameMsg.triggerGen`. */
  triggerGen: number;
  /** SWV trace since the last frame (while the trace is on). */
  swv?: SwvData;
}
export type FrameListener = (e: FrameEvent) => void;

/**
 * `cb(ms)` once the browser has drawn what was just committed: `ms` is the
 * style, layout and paint work of that frame (from its animation-frame
 * callbacks to the next task). A hidden page draws nothing: 0 after 200 ms.
 */
function afterPaint(cb: (paintMs: number) => void) {
  let done = false;
  const finish = (ms: number) => {
    if (done) return;
    done = true;
    cb(ms);
  };
  requestAnimationFrame(() => {
    const t = performance.now();
    const ch = new MessageChannel();
    ch.port1.onmessage = () => finish(performance.now() - t);
    ch.port2.postMessage(0);
  });
  setTimeout(() => finish(0), 200);
}

export function useRunner(): Runner {
  const listeners = useRef(new Set<FrameListener>());
  /** The `gen` of the last trigger message sent (see `FrameMsg.triggerGen`). */
  const triggerGen = useRef(0);
  const probeOwners = useRef(new Map<string, string[]>());
  const worker = useRef<Worker | null>(null);
  const [ready, setReady] = useState(false);
  const [firmware, setFirmware] = useState<string | null>(null);
  const [firmwareBytes, setFirmwareBytes] = useState<Uint8Array | null>(null);
  const [firmwareExample, setFirmwareExample] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [speed, setSpeedState] = useState(0);
  const [frame, setFrame] = useState<SimFrame | null>(null);
  const [consoleText, setConsole] = useState("");
  const [bluetooth, setBluetooth] = useState<Record<string, BtChat>>({});
  const bluetoothRef = useRef(bluetooth);
  bluetoothRef.current = bluetooth;
  const [memory, setMemory] = useState<{ addr: number; bytes: Uint8Array } | null>(null);
  const sdWaiters = useRef(new Map<string, (b: Uint8Array) => void>());
  const snapWaiters = useRef(new Map<string, ((b: Uint8Array) => void)[]>());
  const [debugFiles, setDebugFiles] = useState<DebugFile[]>([]);
  const [breakpoints, setPlaced] = useState<{ file: number; line: number }[]>([]);
  const [pauseEvent, setPause] = useState({ n: 0, reason: "" });
  const [debugState, setDebugState] = useState<DebugState | null>(null);
  const [disasm, setDisasm] = useState<DisasmRow[]>([]);
  const [watch, setWatch] = useState<WatchValue[]>([]);
  const [watchpoints, setWatchpointsPlaced] = useState<WatchpointPlaced[]>([]);
  const [swvPlaced, setSwvPlaced] = useState<DataPlaced[]>([]);
  const [loadGen, setLoadGen] = useState(0);
  const [assigned, setAssigned] = useState<{ n: number; target: string; result: WatchValue | null }>({
    n: 0,
    target: "",
    result: null,
  });

  // M31: what each display update costs the page thread. The message
  // handler, then the render (from this hook's call in App's render to the
  // commit), then the browser's drawing (see `afterPaint`).
  const cost = useRef({ handler: 0, frames: 0, renderStart: -1, pending: false, batched: false });
  if (cost.current.pending && cost.current.renderStart < 0) cost.current.renderStart = performance.now();
  const workerRatio = useRef(0);
  const asked = useRef({ speed: 1, cap: Infinity });
  const runningRef = useRef(false);
  const frameRef = useRef<SimFrame | null>(null);
  frameRef.current = frame;
  useLayoutEffect(() => {
    const c = cost.current;
    if (!c.pending) return;
    const commit = performance.now();
    const work = c.handler + (c.renderStart >= 0 ? commit - c.renderStart : 0);
    const { frames, batched } = c;
    cost.current = { handler: 0, frames: 0, renderStart: -1, pending: false, batched: false };
    afterPaint((paint) => {
      const f = frameRef.current;
      const want = Math.min(asked.current.speed, asked.current.cap);
      perfUpdate(performance.now(), work + paint, frames, f?.timeMs ?? 0, runningRef.current, workerRatio.current, want);
      if (batched) worker.current?.postMessage({ type: "ack" } satisfies ToWorker);
    });
  }, [frame]);
  useEffect(() => {
    if (typeof PerformanceObserver === "undefined" || !PerformanceObserver.supportedEntryTypes?.includes("longtask")) return;
    const po = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) perfLongTask(e.startTime + e.duration, e.duration);
    });
    po.observe({ type: "longtask" });
    return () => po.disconnect();
  }, []);

  useEffect(() => {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    connectPerf((hz) => w.postMessage({ type: "uiRate", hz } satisfies ToWorker));
    /** Frames from the worker, one or a batch (M31): every one to the listeners, the last one on screen. */
    const deliver = (msgs: FrameMsg[], speed: number, batched: boolean) => {
      const t0 = performance.now();
      msgs = dropStaleCaptures(msgs, triggerGen.current);
      for (const m of msgs) for (const l of listeners.current) l(m);
      const last = msgs[msgs.length - 1];
      setFrame(last.frame);
      setRunning(last.running);
      setSpeedState(speed);
      workerRatio.current = speed;
      if (last.running !== runningRef.current) {
        runningRef.current = last.running;
        perfRunning(last.running);
      }
      const text = msgs.length === 1 ? last.console : msgs.map((m) => m.console).join("");
      if (text) setConsole((c) => (c + text).slice(-CONSOLE_LIMIT));
      setBluetooth((b) => msgs.reduce((acc, m) => mergeBluetooth(acc, m.frame.bluetooth ?? []), b));
      const c = cost.current;
      c.handler += performance.now() - t0;
      c.frames += msgs.length;
      c.pending = true;
      c.batched ||= batched;
    };
    w.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      switch (m.type) {
        case "ready":
          setReady(true);
          break;
        case "loaded":
          setFirmware(m.error ? null : m.name);
          if (!m.error) setLoadGen((g) => g + 1);
          setLoadError(m.error ?? null);
          setConsole("");
          setDebugState(null);
          setPlaced([]);
          setWatch([]);
          setWatchpointsPlaced([]);
          w.postMessage({ type: "debugFiles" } satisfies ToWorker);
          break;
        case "debugFiles":
          setDebugFiles(m.files);
          break;
        case "breakpoints":
          setPlaced(m.placed.filter((p): p is { file: number; line: number } => p !== null));
          break;
        case "paused":
          setPause((p) => ({ n: p.n + 1, reason: m.reason }));
          break;
        case "debugState":
          setDebugState(m.state);
          break;
        case "disasm":
          setDisasm(m.rows);
          break;
        case "watch":
          setWatch(m.values);
          break;
        case "swvPlaced":
          setSwvPlaced(m.placed);
          break;
        case "watchpoints":
          setWatchpointsPlaced(m.placed);
          break;
        case "assigned":
          setAssigned((a) => ({ n: a.n + 1, target: m.target, result: m.result }));
          break;
        case "frame":
          perfWorkerShare(performance.now(), m.work);
          deliver([{ frame: m.frame, console: m.console, running: m.running, epoch: m.epoch, triggerGen: m.triggerGen, swv: m.swv }], m.speed, false);
          break;
        case "frames":
          perfWorkerShare(performance.now(), m.work);
          if (m.frames.length) deliver(m.frames, m.speed, true);
          else w.postMessage({ type: "ack" } satisfies ToWorker);
          break;
        case "memory":
          setMemory({ addr: m.addr, bytes: m.bytes });
          break;
        case "sdImage":
          sdWaiters.current.get(m.part)?.(m.bytes);
          sdWaiters.current.delete(m.part);
          break;
        case "sdSnapshot":
          snapWaiters.current.get(m.part)?.shift()?.(m.bytes);
          break;
      }
    };
    return () => w.terminate();
  }, []);

  const send = useCallback((m: ToWorker, transfer?: Transferable[]) => worker.current?.postMessage(m, transfer ?? []), []);

  // Stable action identities, so components can use them in effect deps.
  const actions = useMemo(
    () => ({
      load: (name: string, bytes: ArrayBuffer, example?: string) => {
        setFirmwareBytes(new Uint8Array(bytes.slice(0)));
        setFirmwareExample(example ?? null);
        send({ type: "load", name, bytes }, [bytes]);
      },
      run: () => send({ type: "run" }),
      // (A button's click event is no reason.)
      pause: (reason?: unknown) => send({ type: "pause", ...(typeof reason === "string" ? { reason } : {}) }),
      reset: () => send({ type: "reset" }),
      resetEpoch: (epoch: number) => send({ type: "reset", epoch }),
      onFrame: (l: FrameListener) => {
        listeners.current.add(l);
        return () => void listeners.current.delete(l);
      },
      setSpeed: (value: number) => {
        asked.current.speed = value;
        send({ type: "speed", value });
      },
      setSpeedCap: (value: number) => {
        asked.current.cap = value;
        send({ type: "speedCap", value });
      },
      press: (part: string, pressed: boolean) => send({ type: "press", part, pressed }),
      setWiring: (circuit: CircuitJson) =>
        send({ type: "wiring", circuit: JSON.stringify(circuit), catalog: CATALOG, signals: SIGNALS }),
      setProbes: (pins: string[], owner = "waveform") => {
        probeOwners.current.set(owner, pins);
        send({ type: "probes", pins: [...new Set([...probeOwners.current.values()].flat())] });
      },
      setAnalogProbes: (specs: string[]) => send({ type: "analogProbes", specs }),
      setTrigger: (config: TriggerConfig | null) => send({ type: "trigger", config, gen: ++triggerGen.current }),
      armTrigger: () => send({ type: "armTrigger", gen: ++triggerGen.current }),
      sendConsole: (text: string) => send({ type: "console", text }),
      clearConsole: () => setConsole(""),
      bluetoothSend: (part: string, text: string) => {
        const chat = bluetoothRef.current[part];
        const say = (msg: BtMessage) =>
          setBluetooth((b) => (b[part] ? { ...b, [part]: { ...b[part], messages: [...b[part].messages, msg].slice(-CHAT_LIMIT) } } : b));
        if (!chat || !btLinked(chat.status)) {
          say({
            from: "system",
            text: !chat?.status.powered
              ? t("모듈에 전원이 없어 보내지 못했습니다.")
              : chat.status.atMode
                ? t("AT 모드에서는 휴대폰과 통신하지 않습니다.")
                : t("휴대폰이 연결되지 않았습니다 — '연결'을 누르세요."),
          });
          return;
        }
        say({ from: "phone", text });
        send({ type: "bluetooth", part, text: text + "\r\n" });
      },
      bluetoothConnect: (part: string, on: boolean) => send({ type: "bluetoothConnect", part, on }),
      clearBluetooth: (part: string) =>
        setBluetooth((b) => (b[part] ? { ...b, [part]: { ...b[part], messages: [] } } : b)),
      readMemory: (addr: number, len: number) => send({ type: "readMemory", addr, len }),
      sdImage: (part: string) =>
        new Promise<Uint8Array>((resolve) => {
          sdWaiters.current.set(part, resolve);
          send({ type: "sdImage", part });
        }),
      sdLoad: (part: string, bytes: ArrayBuffer) => send({ type: "sdLoad", part, bytes }, [bytes]),
      sdSnapshot: (part: string) =>
        new Promise<Uint8Array>((resolve) => {
          snapWaiters.current.set(part, [...(snapWaiters.current.get(part) ?? []), resolve]);
          send({ type: "sdSnapshot", part });
        }),
      sdRestore: (part: string, bytes: ArrayBuffer) => send({ type: "sdRestore", part, bytes }, [bytes]),
      sdWipe: (part: string) => send({ type: "sdWipe", part }),
      rotate: (part: string, detents: number) => send({ type: "rotate", part, detents }),
      setBreakpoints: (list: BreakpointSpec[]) => send({ type: "breakpoints", list }),
      step: (kind: "instruction" | "into" | "over" | "out") => send({ type: "step", kind }),
      requestDebugState: (frame: number, globalsFile: number) => send({ type: "debugState", frame, globalsFile }),
      requestDisasm: (addr: number | null) => send({ type: "disassemble", addr }),
      requestWatch: (exprs: string[], frame: number) => send({ type: "evaluate", exprs, frame }),
      setWatchpoints: (list: WatchpointSpec[], frame: number) => send({ type: "watchpoints", list, frame }),
      setSwv: (settings: SwvSettings | null) => send({ type: "swv", settings }),
      selectTask: (tcb: number | null) => send({ type: "selectTask", tcb }),
      setVariable: (target: string, value: string, frame: number) =>
        send({ type: "setVariable", target, value, frame }),
    }),
    [send],
  );

  // Test hook (E2E, M31): every frame with its simulated time, and probes,
  // to compare runs by simulated time rather than by what was drawn.
  useEffect(() => {
    (window as unknown as { __simucleoRunner: unknown }).__simucleoRunner = { onFrame: actions.onFrame, setProbes: actions.setProbes };
  }, [actions]);

  return {
    ready, firmware, firmwareBytes, firmwareExample, loadError, running, speed, frame, console: consoleText, memory, bluetooth,
    debugFiles, breakpoints, pauseEvent, debugState, disasm, watch, assigned, watchpoints, swvPlaced, loadGen, ...actions,
  };
}
