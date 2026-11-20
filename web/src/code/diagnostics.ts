// Compiler and linker messages → records for the editor (M33). clang prints
// `file:line:col: severity: message [-Wflag]` (we pass -fno-caret-diagnostics,
// so no source excerpts follow); ld.lld prints `ld.lld: error: message` with
// `>>> referenced by main.c:23 (/project/Core/Src/main.c:23)` lines that say
// where. Messages stay as the tools print them (English); only the labels
// around them are Korean.

export type Severity = "error" | "warning" | "note";

export interface Diagnostic {
  /** Path relative to the project (`Core/Src/main.c`), or as printed, or null (no file). */
  file: string | null;
  line: number | null;
  column: number | null;
  severity: Severity;
  message: string;
  /** `-Wunused-variable` from `[-Wunused-variable]`. */
  flag: string | null;
  /** Who said it. */
  tool: "clang" | "ld";
  /** clang's notes, and for the linker the further places it lists. */
  notes: { file: string | null; line: number | null; column: number | null; message: string }[];
}

/** `/project/Core/Src/main.c` → `Core/Src/main.c`. */
export function projectPath(path: string, root = "/project"): string {
  const p = path.replace(/\\/g, "/");
  return p.startsWith(root + "/") ? p.slice(root.length + 1) : p;
}

const CLANG = /^(.+?):(\d+):(\d+): (fatal error|error|warning|note|remark): (.*)$/;
const CLANG_NOLOC = /^(?:clang(?:-\d+)?|yowasp-llvm|error|warning): (?:(fatal error|error|warning|note): )?(.*)$/;
const LLD = /^(?:ld\.lld|lld|ld): (error|warning): (.*)$/;
const LLD_WHERE = /^>>> (?:referenced by|defined at) (.+?)(?::(\d+))?(?: \((.+?):(\d+)\))?$/;
const FLAG = /\s\[(-W[^\],]+)(?:,[^\]]*)?\]$/;

function sev(s: string): Severity {
  return s === "warning" ? "warning" : s === "note" || s === "remark" ? "note" : "error";
}

/** Parse what clang or ld.lld wrote to stderr. Unknown lines are ignored. */
export function parseDiagnostics(output: string, root = "/project"): Diagnostic[] {
  const out: Diagnostic[] = [];
  let last: Diagnostic | null = null;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    let m = CLANG.exec(line);
    if (m) {
      const [, file, l, c, s, rest] = m;
      const f = FLAG.exec(rest);
      const message = f ? rest.slice(0, f.index) : rest;
      if (sev(s) === "note" && last) {
        last.notes.push({ file: projectPath(file, root), line: Number(l), column: Number(c), message });
        continue;
      }
      last = {
        file: projectPath(file, root),
        line: Number(l),
        column: Number(c),
        severity: sev(s),
        message,
        flag: f ? f[1] : null,
        tool: "clang",
        notes: [],
      };
      out.push(last);
      continue;
    }
    m = LLD.exec(line);
    if (m) {
      last = { file: null, line: null, column: null, severity: sev(m[1]), message: m[2], flag: null, tool: "ld", notes: [] };
      out.push(last);
      continue;
    }
    m = LLD_WHERE.exec(line);
    if (m && last?.tool === "ld") {
      // "main.c:23 (/project/Core/Src/main.c:23)": the full path when given.
      const file = m[3] ? projectPath(m[3], root) : m[2] ? projectPath(m[1], root) : null;
      const at = m[4] ?? m[2];
      if (file && last.file === null) {
        last.file = file;
        last.line = at ? Number(at) : null;
      } else if (file) last.notes.push({ file, line: at ? Number(at) : null, column: null, message: line.slice(4) });
      continue;
    }
    if (/^(In file included from|\d+ (errors?|warnings?)( and \d+ warnings?)? generated\.|>>>)/.test(line)) continue;
    m = CLANG_NOLOC.exec(line);
    if (m && /error|warning/.test(line.slice(0, line.indexOf(":") + 20))) {
      last = { file: null, line: null, column: null, severity: sev(m[1] ?? (line.includes("warning:") ? "warning" : "error")), message: m[2], flag: null, tool: "clang", notes: [] };
      out.push(last);
    }
  }
  return out;
}

/** "오류 2개 · 경고 1개". */
export function countText(diags: Diagnostic[]): string {
  const e = diags.filter((d) => d.severity === "error").length;
  const w = diags.filter((d) => d.severity === "warning").length;
  if (!e && !w) return "문제 없음";
  return [e && `오류 ${e}개`, w && `경고 ${w}개`].filter(Boolean).join(" · ");
}
