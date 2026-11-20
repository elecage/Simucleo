// The student's code in a project (M33): the files they edit, the example it
// started from, and a snapshot of the files the current ELF was built from
// (so the source view shows those lines even after more edits). Saved with
// the project (autosave, project file) and, without the snapshot, in share
// links. Pure; unit tested in test/m33.test.ts.
import { safeSourcePath, type SourceFile } from "./build.ts";

export interface CodeProject {
  /**
   * The prebuilt SDK the build links against: "hal" links hal-common's
   * start-up, handlers, MSP and clock (M33); "cube" is a project of the
   * configuration tool (M36), whose stm32f4xx_it.c, MSP and
   * SystemClock_Config are its own files, built from source.
   */
  template: "hal" | "cube";
  /** The bundled example it started from (`hal-blinky.elf`), if any. */
  base?: string;
  files: SourceFile[];
  /** The file shown in the editor. */
  active?: string;
  /** What the loaded ELF was built from: the files and the ELF's `elfKey`. */
  built?: { key: string; files: SourceFile[] };
  /** M36 ("cube"): the configuration as a CubeMX .ioc text. */
  ioc?: string;
  /** M36 ("cube"): the STM32CubeF4 bundle its Drivers/ come from (packs.ts). */
  drivers?: string;
}

export const MAIN_C = "Core/Src/main.c";
export const MAX_FILES = 32;
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_CODE_BYTES = 1024 * 1024;
/** The name the built firmware gets. */
export const CODE_ELF = "code.elf";
/** The largest .ioc a project keeps. */
export const MAX_IOC_BYTES = 64 * 1024;

const bytes = (s: string) => new TextEncoder().encode(s).length;

function sanitizeFiles(x: unknown, notes: string[]): SourceFile[] {
  if (!Array.isArray(x)) return [];
  const out: SourceFile[] = [];
  let total = 0;
  for (const f of x as Partial<SourceFile>[]) {
    if (!f || typeof f.path !== "string" || typeof f.text !== "string") continue;
    if (!safeSourcePath(f.path)) {
      notes.push(`코드 파일 이름 '${String(f.path).slice(0, 60)}'은(는) 쓸 수 없어 건너뜁니다.`);
      continue;
    }
    if (out.some((o) => o.path === f.path)) continue;
    const n = bytes(f.text);
    if (n > MAX_FILE_BYTES || total + n > MAX_CODE_BYTES || out.length >= MAX_FILES) {
      notes.push(`코드 파일 ${f.path}은(는) 너무 커서(또는 너무 많아서) 건너뜁니다.`);
      continue;
    }
    total += n;
    out.push({ path: f.path, text: f.text });
  }
  return out;
}

/** Check what a project file (or link) says about code; undefined if none or unusable. */
export function sanitizeCode(x: unknown, notes: string[] = []): CodeProject | undefined {
  if (!x || typeof x !== "object") return undefined;
  const c = x as Partial<CodeProject>;
  if (c.template !== "hal" && c.template !== "cube") {
    notes.push(`알 수 없는 코드 템플릿 '${String(c.template)}'은(는) 건너뜁니다.`);
    return undefined;
  }
  const files = sanitizeFiles(c.files, notes);
  if (!files.length) return undefined;
  const out: CodeProject = { template: c.template, files };
  if (c.template === "cube") {
    if (typeof c.ioc === "string" && bytes(c.ioc) <= MAX_IOC_BYTES) out.ioc = c.ioc;
    else if (c.ioc !== undefined) notes.push("설정(.ioc)이 너무 커서 건너뜁니다.");
    if (typeof c.drivers === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(c.drivers)) out.drivers = c.drivers;
  }
  if (typeof c.base === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*\.elf$/.test(c.base)) out.base = c.base;
  if (typeof c.active === "string" && files.some((f) => f.path === c.active)) out.active = c.active;
  if (c.built && typeof c.built === "object" && typeof c.built.key === "string" && /^\d+:[0-9a-f]{8}$/.test(c.built.key)) {
    const bf = sanitizeFiles(c.built.files, []);
    if (bf.length) out.built = { key: c.built.key, files: bf };
  }
  return out;
}

/** What a share link carries: the files to edit and rebuild, not the snapshot. */
export function forShare(c: CodeProject): CodeProject {
  return {
    template: c.template,
    ...(c.base ? { base: c.base } : {}),
    files: c.files,
    ...(c.active ? { active: c.active } : {}),
    ...(c.ioc ? { ioc: c.ioc } : {}),
    ...(c.drivers ? { drivers: c.drivers } : {}),
  };
}

/** The files differ from what was built (the ELF is stale). */
export function isStale(c: CodeProject): boolean {
  if (!c.built) return true;
  if (c.built.files.length !== c.files.length) return true;
  return c.files.some((f) => c.built!.files.find((b) => b.path === f.path)?.text !== f.text);
}

/** Where a new file goes: `led.c` → Core/Src/led.c, `led.h` → Core/Inc/led.h. */
export function newFilePath(name: string): string | null {
  const n = name.trim().replace(/\\/g, "/");
  const p = n.includes("/") ? n : n.endsWith(".h") ? `Core/Inc/${n}` : `Core/Src/${n.endsWith(".c") ? n : n + ".c"}`;
  return safeSourcePath(p) ? p : null;
}

/** A lesson's starter code (M33): an example's main.c, or the lesson's own text. */
export interface LessonCode {
  /** The example the build template and circuit belong to (`hal-blinky.elf`). */
  example: string;
  /** The starting main.c (lines joined with "\n"); the example's main.c if absent. */
  main?: string | string[];
}

/** The files a "write the code" lesson starts with (null: the example's source is not there). */
export async function lessonStarter(
  c: LessonCode,
  examples: { file: string; code?: { main: string } }[],
  get: (url: string) => Promise<string | null> = (u) => fetch(u).then((r) => (r.ok ? r.text() : null), () => null),
): Promise<SourceFile[] | null> {
  if (c.main !== undefined) return [{ path: MAIN_C, text: Array.isArray(c.main) ? c.main.join("\n") + "\n" : c.main }];
  const ex = examples.find((e) => e.file === c.example);
  if (!ex?.code) return null;
  const text = await get(`./examples/src/${ex.code.main}`);
  return text === null ? null : [{ path: MAIN_C, text }];
}
