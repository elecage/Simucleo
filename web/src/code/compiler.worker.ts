// The compiler worker (M33): clang + ld.lld (WebAssembly) in their own
// thread, started only when the student first builds. The toolchain files
// come from toolchain/ next to the page (the service worker serves them when
// "편집기 오프라인으로 받기" cached them).
import { buildProject, installSdk, type SourceFile, type ToolSession } from "./build.ts";
import { downloadBytes, prepare, type ClangModule } from "./toolchain.ts";
import type { Template, ToolchainManifest } from "./sdk.ts";

export type ToCompiler = { type: "load"; base: string } | { type: "build"; id: number; base: string; files: SourceFile[]; template?: Template };

export type FromCompiler =
  | { type: "progress"; phase: "download" | "start"; done: number; total: number }
  | { type: "ready"; ms: number; version: string; llvm: string; bytes: number }
  | { type: "failed"; error: string }
  | ({ type: "built"; id: number } & Omit<Awaited<ReturnType<typeof buildProject>>, "elf"> & { elf: Uint8Array | null; ms: { compile: number; link: number; total: number } });

const post = (m: FromCompiler, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

let ready: Promise<{ session: ToolSession; written: Set<string> }> | null = null;

/** Fetch one file, counting its bytes as they arrive. */
async function fetchCounting(url: string, onBytes: (n: number) => void): Promise<Uint8Array> {
  const where = url.slice(url.lastIndexOf("/") + 1);
  const r = await fetch(url).catch((e: Error) => {
    throw new Error(`${where}: ${e.message}`);
  });
  if (!r.ok || !r.body) throw new Error(`${where}: HTTP ${r.status}`);
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read().catch((e: Error) => {
      throw new Error(`${where}: ${e.message}`);
    });
    if (done) break;
    chunks.push(value);
    total += value.length;
    onBytes(value.length);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function load(base: string) {
  let step = "manifest.json";
  ready ??= (async () => {
    const t0 = performance.now();
    const mr = await fetch(new URL("toolchain/manifest.json", base));
    if (!mr.ok) throw new Error(mr.status === 404 ? "이 사이트에는 컴파일러가 들어 있지 않습니다 (빌드할 때 toolchain/이 만들어지지 않음)" : `toolchain/manifest.json: HTTP ${mr.status}`);
    const manifest = (await mr.json()) as ToolchainManifest;
    step = "clang.js";
    const mod = (await import(/* @vite-ignore */ new URL("toolchain/clang.js", base).href)) as ClangModule;
    step = "download";
    const total = downloadBytes(manifest);
    const loaded = await prepare(mod, manifest, (url, onBytes) => fetchCounting(new URL(url, base).href, onBytes), (done) =>
      post({ type: "progress", phase: done >= total ? "start" : "download", done, total }),
    );
    step = "SDK";
    const session = loaded.module.createSession();
    await installSdk(session, loaded.sdk);
    // The first command downloads and compiles the WebAssembly.
    step = "start";
    const rc = await session.clang(["clang", "--version"], { stderr: () => {} });
    if (rc !== 0) throw new Error(`clang --version: ${rc}`);
    post({ type: "ready", ms: performance.now() - t0, version: manifest.version, llvm: manifest.llvm, bytes: total });
    return { session, written: new Set<string>() };
  })().catch((e: Error) => {
    throw new Error((e.message.startsWith(step) ? e.message : `${step}: ${e.message}`));
  });
  ready.catch((e: Error) => {
    ready = null;
    post({ type: "failed", error: e.message });
  });
  return ready;
}

// Builds run one at a time.
let queue: Promise<unknown> = Promise.resolve();

self.onmessage = (e: MessageEvent<ToCompiler>) => {
  const m = e.data;
  if (m.type === "load") void load(m.base).catch(() => {});
  else if (m.type === "build") {
    queue = queue.then(async () => {
      try {
        const t0 = performance.now();
        const { session, written } = await load(m.base);
        const r = await buildProject(session, m.files, written, m.template ?? "hal");
        // A copy: the file system's own buffer must not be transferred away.
        const elf = r.elf ? r.elf.slice() : null;
        post({ type: "built", id: m.id, ...r, elf, ms: { ...r.ms, total: performance.now() - t0 } }, elf ? [elf.buffer] : []);
      } catch (err) {
        post({
          type: "built",
          id: m.id,
          ok: false,
          elf: null,
          log: String((err as Error).message),
          diagnostics: [{ file: null, line: null, column: null, severity: "error", message: (err as Error).message, flag: null, tool: "clang", notes: [] }],
          ms: { compile: 0, link: 0, total: 0 },
        });
      }
    });
  }
};
