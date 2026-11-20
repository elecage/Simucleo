// A light C scanner for the editor (M33): comments and strings masked out
// (offsets kept), top-level function definitions, declarations. Not a C
// parser — enough for the symbol index, completion and the lint rules, on
// code shaped like the HAL and the examples.

export interface Comment {
  start: number;
  end: number;
  text: string;
  /** Started on a line with code before it (a trailing `/*!< … *\/`). */
  trailing: boolean;
}

/**
 * The text with comments, string and character literals replaced by spaces
 * (quotes kept, newlines kept), so offsets and line numbers stay the same.
 * `preprocessor` also blanks `#…` lines (with their continuations).
 */
export function maskC(text: string, opts: { preprocessor?: boolean } = {}): string {
  const out = text.split("");
  const n = text.length;
  let i = 0;
  let lineStart = true;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < n) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "*") {
      const e = text.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      let e = text.indexOf("\n", i);
      if (e < 0) e = n;
      blank(i, e);
      i = e;
      continue;
    }
    if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < n && text[k] !== c && text[k] !== "\n") k += text[k] === "\\" ? 2 : 1;
      blank(i + 1, Math.min(k, n));
      i = k + 1;
      lineStart = false;
      continue;
    }
    if (opts.preprocessor && lineStart && c === "#") {
      let k = i;
      for (;;) {
        let e = text.indexOf("\n", k);
        if (e < 0) e = n;
        // A comment that starts on the line may run over the newline.
        const cm = text.slice(k, e).indexOf("/*");
        if (cm >= 0 && text.indexOf("*/", k + cm) > e) e = text.indexOf("\n", text.indexOf("*/", k + cm));
        if (e < 0) e = n;
        if (text[e - 1] === "\\" || text[e - 2] === "\\") {
          k = e + 1;
          continue;
        }
        blank(i, e);
        i = e;
        break;
      }
      continue;
    }
    if (c === "\n") lineStart = true;
    else if (c !== " " && c !== "\t" && c !== "\r") lineStart = false;
    i++;
  }
  return out.join("");
}

/** Every comment with its position. */
export function comments(text: string): Comment[] {
  const out: Comment[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '"' || c === "'") {
      let k = i + 1;
      while (k < n && text[k] !== c && text[k] !== "\n") k += text[k] === "\\" ? 2 : 1;
      i = k + 1;
      continue;
    }
    if (c === "/" && (text[i + 1] === "*" || text[i + 1] === "/")) {
      const block = text[i + 1] === "*";
      let end = block ? text.indexOf("*/", i + 2) : text.indexOf("\n", i);
      end = end < 0 ? n : block ? end + 2 : end;
      const ls = text.lastIndexOf("\n", i - 1) + 1;
      out.push({ start: i, end, text: text.slice(i, end), trailing: text.slice(ls, i).trim() !== "" });
      i = end;
      continue;
    }
    i++;
  }
  return out;
}

/** The words of a comment: no `/*`, `*\/`, `//`, `!<`, leading `*`. */
export function commentText(c: string): string {
  return c
    .replace(/^\/\*+!?<?|\*+\/$|^\/\/+!?<?/g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\*+ ?/, "").trim())
    .join("\n")
    .trim();
}

/** A doc comment's first sentence or `@brief` paragraph, on one line. */
export function brief(c: string): string {
  let t = commentText(c);
  const b = /[@\\]brief\s+([\s\S]*?)(?=\n\s*\n|\n\s*[@\\]\w|$)/.exec(t);
  if (b) t = b[1];
  else if (/^\s*[@\\]/.test(t)) return "";
  t = t.split(/\n\s*\n/)[0];
  return t.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** 1-based line of offset `at`. */
export function lineOf(text: string, at: number): number {
  let n = 1;
  for (let i = 0; i < at && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Offsets of each line start (for many lookups). */
export function lineStarts(text: string): number[] {
  const s = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) s.push(i + 1);
  return s;
}

export function lineAt(starts: number[], at: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= at) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** The `}` matching the `{` at `open` in masked text (or the end). */
export function matchBrace(masked: string, open: number, o = "{", c = "}"): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === o) depth++;
    else if (masked[i] === c && --depth === 0) return i;
  }
  return masked.length;
}

export interface FunctionDef {
  name: string;
  /** The text of the parameter list. */
  params: string;
  /** Return type and qualifiers before the name. */
  type: string;
  /** Offset of the name, the `{` and the matching `}`. */
  nameAt: number;
  bodyStart: number;
  bodyEnd: number;
}

const NOT_FUNCTIONS = new Set(["if", "for", "while", "switch", "return", "sizeof", "do", "else"]);

/**
 * Top-level function definitions in masked text (preprocessor lines blanked
 * too, or `#define X() {…}` would count).
 */
export function functionDefs(masked: string): FunctionDef[] {
  const out: FunctionDef[] = [];
  let depth = 0;
  let stmt = 0; // start of the current top-level statement
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "{") {
      if (depth === 0) {
        const head = masked.slice(stmt, i);
        const m = /([A-Za-z_]\w*)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*(?:__attribute__\s*\(\(.*?\)\)\s*)?$/s.exec(head);
        if (m && !NOT_FUNCTIONS.has(m[1]) && !/=\s*$/.test(head) && !/\b(struct|enum|union)\s+\w*\s*$/.test(head)) {
          const end = matchBrace(masked, i);
          const type = head.slice(0, m.index).replace(/\s+/g, " ").trim();
          if (!/[=;]/.test(type) && type !== "") {
            out.push({ name: m[1], params: m[2].replace(/\s+/g, " ").trim(), type, nameAt: stmt + m.index, bodyStart: i, bodyEnd: end });
            i = end;
            stmt = i + 1;
            continue;
          }
        }
        // `extern "C" {` (under #ifdef __cplusplus) wraps whole headers.
        if (/extern\s*"\s*"\s*$/.test(head)) {
          stmt = i + 1;
          continue;
        }
      }
      depth++;
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
      if (depth === 0) stmt = i + 1;
    } else if (ch === ";" && depth === 0) stmt = i + 1;
  }
  return out;
}

/** Top-level `;`-statements of masked text (outside every brace), with offsets. */
export function topStatements(masked: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  let depth = 0;
  let stmt = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "{") {
      if (depth === 0 && /\)\s*$/.test(masked.slice(stmt, i)) && !/=/.test(masked.slice(stmt, i))) {
        // A function body: skip it.
        i = matchBrace(masked, i);
        stmt = i + 1;
        continue;
      }
      depth++;
    } else if (ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === ";" && depth === 0) {
      out.push({ text: masked.slice(stmt, i), start: stmt });
      stmt = i + 1;
    }
  }
  return out;
}

export interface VarDecl {
  name: string;
  /** Base type without qualifiers (`GPIO_InitTypeDef`, `uint32_t`). */
  type: string;
  pointer: boolean;
  volatile: boolean;
  at: number;
}

const QUALIFIERS = /\b(static|extern|const|volatile|__IO|__I|__O|__IM|__OM|__IOM|register|inline|__STATIC_INLINE|__weak)\b/g;
const BASE = /^(?:(?:unsigned|signed|long|short)\s+)*(?:struct\s+|enum\s+|union\s+)?[A-Za-z_]\w*$/;

/**
 * Variable declarations in a piece of masked code: `T name`, `T *name = …`,
 * `T a, b[4];`. Finds them anywhere (locals in bodies too); `for (int i…`
 * counts. Keywords and casts are left out by shape.
 */
export function varDecls(masked: string, base = 0): VarDecl[] {
  const out: VarDecl[] = [];
  const re =
    /(?:^|[;{}(,]\s*)((?:(?:static|extern|const|volatile|__IO|register)\s+)*(?:(?:unsigned|signed|long|short)\s+)*(?:struct\s+|enum\s+|union\s+)?[A-Za-z_]\w*(?:\s+(?:const|volatile))?)\s*(\*+\s*)?([A-Za-z_]\w*)\s*(\[[^\]]*\]\s*)*(?=[=;,)\[]|$)/dg;
  for (const m of masked.matchAll(re)) {
    const full = m[1];
    const type = full.replace(QUALIFIERS, " ").replace(/\s+/g, " ").trim();
    if (!BASE.test(type) || /^(return|else|case|goto|typedef|sizeof|do)$/.test(type)) continue;
    if (/^(return|case|goto|sizeof)\b/.test(full.trim())) continue;
    const name = m[3];
    const last = type.split(" ").pop()!;
    if (KEYWORDS.has(name) || (KEYWORDS.has(last) && !TYPE_WORDS.has(last))) continue;
    const at = base + m.indices![3][0];
    out.push({ name, type, pointer: !!m[2], volatile: /\bvolatile\b|__IO\b/.test(full), at });
  }
  return out;
}

const TYPE_WORDS = new Set(["int", "char", "float", "double", "void", "long", "short", "unsigned", "signed", "_Bool", "bool"]);
export const KEYWORDS = new Set([
  "auto", "break", "case", "char", "const", "continue", "default", "do", "double", "else", "enum", "extern", "float",
  "for", "goto", "if", "inline", "int", "long", "register", "restrict", "return", "short", "signed", "sizeof", "static",
  "struct", "switch", "typedef", "union", "unsigned", "void", "volatile", "while", "_Bool", "bool", "true", "false",
]);
