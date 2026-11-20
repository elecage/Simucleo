// The in-browser build (M33): compile the student's .c files with clang and
// link them with ld.lld against the prebuilt SDK. Runs wherever the
// toolchain does — the compiler worker in the browser, Node in the tests —
// over the toolchain package's session (a virtual file system that outlives
// one command).
import { t } from "../i18n/index.ts";
import { parseDiagnostics, type Diagnostic } from "./diagnostics.ts";
import { compileFlags, ELF_PATH, linkArgs, objectPath, PROJECT_ROOT, SDK_ROOT, type Template } from "./sdk.ts";
import type { TarEntry } from "./tar.ts";

/** What the build needs of the toolchain's session (`createSession()`). */
export interface ToolSession {
  clang(argv: string[], options?: { stderr?: (b: Uint8Array | null) => void }): Promise<number>;
  exec(argv: string[], options?: { stderr?: (b: Uint8Array | null) => void }): Promise<number>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  readFile(path: string): Promise<Uint8Array | null>;
  remove(path: string): Promise<void>;
}

export interface SourceFile {
  /** Relative to the project: `Core/Src/main.c`, `Core/Inc/app.h`. */
  path: string;
  text: string;
}

export interface BuildResult {
  ok: boolean;
  elf: Uint8Array | null;
  diagnostics: Diagnostic[];
  /** Everything the tools printed, for the build log. */
  log: string;
  /** Milliseconds: compile (all files), link. */
  ms: { compile: number; link: number };
}

/** A project path we accept: relative, no `..`, a C source or header. */
export function safeSourcePath(p: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_./-]*\.(c|h)$/.test(p) && !p.split("/").some((s) => s === ".." || s === "." || s === "");
}

/** Put the SDK bundle into the session (once per session). */
export async function installSdk(session: ToolSession, entries: TarEntry[]): Promise<void> {
  for (const e of entries) {
    if (e.name.startsWith("sdk/")) await session.writeFile(`${SDK_ROOT}/${e.name.slice(4)}`, e.data);
  }
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** Build `files` into an ELF against the `template`'s prebuilt parts. Errors stop before the link. */
export async function buildProject(session: ToolSession, files: SourceFile[], written: Set<string> = new Set(), template: Template = "hal"): Promise<BuildResult> {
  const td = new TextDecoder();
  let log = "";
  // Files of an earlier build that are gone now must not be found by #include.
  for (const old of written) {
    if (!files.some((f) => f.path === old)) await session.remove(`${PROJECT_ROOT}/${old}`);
  }
  written.clear();
  for (const f of files) {
    if (!safeSourcePath(f.path)) throw new Error(t("허용되지 않는 파일 이름: {name}", { name: f.path }));
    await session.writeFile(`${PROJECT_ROOT}/${f.path}`, f.text);
    written.add(f.path);
  }
  // Header folders of the project, searched before the SDK's (Core/Inc/main.h
  // replaces the template's).
  const incDirs = [...new Set(files.filter((f) => f.path.endsWith(".h")).map((f) => f.path.slice(0, f.path.lastIndexOf("/")) || "."))]
    .filter((d) => d !== ".")
    .sort();
  if (files.some((f) => f.path.endsWith(".h") && !f.path.includes("/"))) incDirs.unshift(".");
  const flags = compileFlags(incDirs.map((d) => (d === "." ? "" : d)), template).map((f) => f.replace(/\/$/, ""));
  const sources = files.filter((f) => f.path.endsWith(".c"));
  const diagnostics: Diagnostic[] = [];
  const objects: string[] = [];
  const t0 = now();
  let failed = false;
  for (const src of sources) {
    let err = "";
    const obj = objectPath(src.path);
    await session.remove(obj);
    const rc = await session.clang(["clang", ...flags, "-c", `${PROJECT_ROOT}/${src.path}`, "-o", obj], {
      stderr: (b) => {
        if (b) err += td.decode(b, { stream: true });
      },
    });
    log += err;
    const d = parseDiagnostics(err, PROJECT_ROOT);
    diagnostics.push(...d);
    if (rc !== 0 || d.some((x) => x.severity === "error")) {
      failed = true;
      if (!d.some((x) => x.severity === "error")) {
        diagnostics.push({ file: src.path, line: null, column: null, severity: "error", message: `clang exited with ${rc}`, flag: null, tool: "clang", notes: [] });
      }
    }
    objects.push(obj);
  }
  const t1 = now();
  if (!sources.length) {
    diagnostics.push({ file: null, line: null, column: null, severity: "error", message: "no .c file to build", flag: null, tool: "clang", notes: [] });
    failed = true;
  }
  if (failed) return { ok: false, elf: null, diagnostics, log, ms: { compile: t1 - t0, link: 0 } };

  let err = "";
  await session.remove(ELF_PATH);
  const rc = await session.exec(linkArgs(objects, template), {
    stderr: (b) => {
      if (b) err += td.decode(b, { stream: true });
    },
  });
  log += err;
  const ld = parseDiagnostics(err, PROJECT_ROOT);
  diagnostics.push(...ld);
  const elf = rc === 0 ? await session.readFile(ELF_PATH) : null;
  if (rc !== 0 && !ld.some((d) => d.severity === "error")) {
    diagnostics.push({ file: null, line: null, column: null, severity: "error", message: `ld.lld exited with ${rc}`, flag: null, tool: "ld", notes: [] });
  }
  return { ok: rc === 0 && !!elf, elf, diagnostics, log, ms: { compile: t1 - t0, link: now() - t1 } };
}
