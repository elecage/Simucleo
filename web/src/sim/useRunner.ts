// React hook around the simulation worker.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BreakpointSpec, DebugFile, DebugState, DisasmRow, FromWorker, SimFrame, ToWorker, WatchValue } from "./protocol";
import type { CircuitJson } from "../editor/model";
import { boardSignals, busCatalog } from "../parts";

const CONSOLE_LIMIT = 20_000;
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
  pause(): void;
  reset(): void;
  setSpeed(v: number): void;
  /** Press or release a switch: a tact-switch part id, or "B1". */
  press(part: string, pressed: boolean): void;
  setWiring(circuit: CircuitJson): void;
  setProbes(pins: string[]): void;
  sendConsole(text: string): void;
  clearConsole(): void;
  readMemory(addr: number, len: number): void;
  /** The SD card in part `part` as a disk image (empty: no card). */
  sdImage(part: string): Promise<Uint8Array>;
  sdLoad(part: string, bytes: ArrayBuffer): void;
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
}

export function useRunner(): Runner {
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
  const [memory, setMemory] = useState<{ addr: number; bytes: Uint8Array } | null>(null);
  const sdWaiters = useRef(new Map<string, (b: Uint8Array) => void>());
  const [debugFiles, setDebugFiles] = useState<DebugFile[]>([]);
  const [breakpoints, setPlaced] = useState<{ file: number; line: number }[]>([]);
  const [pauseEvent, setPause] = useState({ n: 0, reason: "" });
  const [debugState, setDebugState] = useState<DebugState | null>(null);
  const [disasm, setDisasm] = useState<DisasmRow[]>([]);
  const [watch, setWatch] = useState<WatchValue[]>([]);

  useEffect(() => {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.current = w;
    w.onmessage = (e: MessageEvent<FromWorker>) => {
      const m = e.data;
      switch (m.type) {
        case "ready":
          setReady(true);
          break;
        case "loaded":
          setFirmware(m.error ? null : m.name);
          setLoadError(m.error ?? null);
          setConsole("");
          setDebugState(null);
          setPlaced([]);
          setWatch([]);
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
        case "frame":
          setFrame(m.frame);
          setRunning(m.running);
          setSpeedState(m.speed);
          if (m.console) setConsole((c) => (c + m.console).slice(-CONSOLE_LIMIT));
          break;
        case "memory":
          setMemory({ addr: m.addr, bytes: m.bytes });
          break;
        case "sdImage":
          sdWaiters.current.get(m.part)?.(m.bytes);
          sdWaiters.current.delete(m.part);
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
      pause: () => send({ type: "pause" }),
      reset: () => send({ type: "reset" }),
      setSpeed: (value: number) => send({ type: "speed", value }),
      press: (part: string, pressed: boolean) => send({ type: "press", part, pressed }),
      setWiring: (circuit: CircuitJson) =>
        send({ type: "wiring", circuit: JSON.stringify(circuit), catalog: CATALOG, signals: SIGNALS }),
      setProbes: (pins: string[]) => send({ type: "probes", pins }),
      sendConsole: (text: string) => send({ type: "console", text }),
      clearConsole: () => setConsole(""),
      readMemory: (addr: number, len: number) => send({ type: "readMemory", addr, len }),
      sdImage: (part: string) =>
        new Promise<Uint8Array>((resolve) => {
          sdWaiters.current.set(part, resolve);
          send({ type: "sdImage", part });
        }),
      sdLoad: (part: string, bytes: ArrayBuffer) => send({ type: "sdLoad", part, bytes }, [bytes]),
      rotate: (part: string, detents: number) => send({ type: "rotate", part, detents }),
      setBreakpoints: (list: BreakpointSpec[]) => send({ type: "breakpoints", list }),
      step: (kind: "instruction" | "into" | "over" | "out") => send({ type: "step", kind }),
      requestDebugState: (frame: number, globalsFile: number) => send({ type: "debugState", frame, globalsFile }),
      requestDisasm: (addr: number | null) => send({ type: "disassemble", addr }),
      requestWatch: (exprs: string[], frame: number) => send({ type: "evaluate", exprs, frame }),
    }),
    [send],
  );

  return {
    ready, firmware, firmwareBytes, firmwareExample, loadError, running, speed, frame, console: consoleText, memory,
    debugFiles, breakpoints, pauseEvent, debugState, disasm, watch, ...actions,
  };
}
