// The page's side of the compiler worker (M33): one worker, created on the
// first build (or "컴파일러 받기"), its download progress and the builds.
import { useSyncExternalStore } from "react";
import type { FromCompiler, ToCompiler } from "./compiler.worker";
import { lang, t } from "../i18n/index.ts";
import type { SourceFile } from "./build.ts";
import type { Diagnostic } from "./diagnostics.ts";
import type { Template } from "./sdk.ts";

export interface CompilerState {
  phase: "idle" | "loading" | "ready" | "failed";
  /** Bytes downloaded and to download. */
  done: number;
  total: number;
  /** "start": the download is complete and the WebAssembly is being compiled. */
  starting: boolean;
  error: string | null;
  /** Load time (download + start) and the toolchain's description. */
  loadMs: number | null;
  llvm: string | null;
  version: string | null;
  building: boolean;
}

export interface BuildOutput {
  ok: boolean;
  elf: Uint8Array | null;
  diagnostics: Diagnostic[];
  log: string;
  ms: { compile: number; link: number; total: number };
}

let state: CompilerState = { phase: "idle", done: 0, total: 0, starting: false, error: null, loadMs: null, llvm: null, version: null, building: false };
const listeners = new Set<() => void>();
const set = (s: Partial<CompilerState>) => {
  state = { ...state, ...s };
  for (const f of listeners) f();
};

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (r: BuildOutput) => void>();
const base = () => new URL("./", document.baseURI).href;

function ensureWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./compiler.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (e: MessageEvent<FromCompiler>) => {
    const m = e.data;
    if (m.type === "progress") set({ phase: "loading", done: m.done, total: m.total, starting: m.phase === "start" });
    else if (m.type === "ready") set({ phase: "ready", loadMs: m.ms, llvm: m.llvm, version: m.version, starting: false, error: null, done: m.bytes, total: m.bytes });
    else if (m.type === "failed") set({ phase: "failed", error: m.error, starting: false });
    else if (m.type === "built") {
      const done = pending.get(m.id);
      pending.delete(m.id);
      if (!pending.size) set({ building: false });
      done?.({ ok: m.ok, elf: m.elf, diagnostics: m.diagnostics, log: m.log, ms: m.ms });
    }
  };
  w.onerror = (e) => set({ phase: "failed", error: e.message || t("컴파일러 워커를 시작하지 못했습니다") });
  worker = w;
  return w;
}

const send = (m: ToCompiler) => ensureWorker().postMessage(m);

export const compiler = {
  state: () => state,
  subscribe(f: () => void) {
    listeners.add(f);
    return () => listeners.delete(f);
  },
  /** Download and start the toolchain (no build). */
  load() {
    if (state.phase === "ready" || state.phase === "loading") return;
    set({ phase: "loading", error: null });
    send({ type: "load", base: base(), lang: lang() });
  },
  build(files: SourceFile[], template: Template = "hal"): Promise<BuildOutput> {
    if (state.phase !== "ready") set({ phase: "loading", error: null });
    set({ building: true });
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      send({ type: "build", id, base: base(), lang: lang(), files, template });
    });
  },
};

export const useCompiler = () => useSyncExternalStore(compiler.subscribe, compiler.state);
