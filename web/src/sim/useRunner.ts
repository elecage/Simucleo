// React hook around the simulation worker.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FromWorker, SimFrame, ToWorker } from "./protocol";

const CONSOLE_LIMIT = 20_000;

export interface Runner {
  ready: boolean;
  firmware: string | null;
  loadError: string | null;
  running: boolean;
  speed: number;
  frame: SimFrame | null;
  console: string;
  memory: { addr: number; bytes: Uint8Array } | null;
  load(name: string, bytes: ArrayBuffer): void;
  run(): void;
  pause(): void;
  reset(): void;
  setSpeed(v: number): void;
  setButton(pressed: boolean): void;
  sendConsole(text: string): void;
  clearConsole(): void;
  readMemory(addr: number, len: number): void;
}

export function useRunner(): Runner {
  const worker = useRef<Worker | null>(null);
  const [ready, setReady] = useState(false);
  const [firmware, setFirmware] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [speed, setSpeedState] = useState(0);
  const [frame, setFrame] = useState<SimFrame | null>(null);
  const [consoleText, setConsole] = useState("");
  const [memory, setMemory] = useState<{ addr: number; bytes: Uint8Array } | null>(null);

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
      }
    };
    return () => w.terminate();
  }, []);

  const send = useCallback((m: ToWorker, transfer?: Transferable[]) => worker.current?.postMessage(m, transfer ?? []), []);

  // Stable action identities, so components can use them in effect deps.
  const actions = useMemo(
    () => ({
      load: (name: string, bytes: ArrayBuffer) => send({ type: "load", name, bytes }, [bytes]),
      run: () => send({ type: "run" }),
      pause: () => send({ type: "pause" }),
      reset: () => send({ type: "reset" }),
      setSpeed: (value: number) => send({ type: "speed", value }),
      setButton: (pressed: boolean) => send({ type: "button", pressed }),
      sendConsole: (text: string) => send({ type: "console", text }),
      clearConsole: () => setConsole(""),
      readMemory: (addr: number, len: number) => send({ type: "readMemory", addr, len }),
    }),
    [send],
  );

  return { ready, firmware, loadError, running, speed, frame, console: consoleText, memory, ...actions };
}
