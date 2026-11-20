// The symbol index for autocomplete (M33, stage 1): built from the HAL, CMSIS
// and newlib headers at build time (scripts/editor-sdk.mjs →
// public/editor/hal-symbols.json) — functions with their signatures and the
// first sentence of their doc comment (from the header, or from the HAL
// driver's .c where ST keeps them), macros (`GPIO_PIN_5`, `GPIOA`), struct
// members (`GPIO_InitTypeDef.Pin`), enum values, typedefs, extern variables.
import { brief, comments, functionDefs, lineStarts, lineAt, maskC, matchBrace, type Comment } from "./cscan.ts";

export type SymKind = "function" | "macro" | "type" | "member" | "enum" | "variable";

export interface Sym {
  name: string;
  kind: SymKind;
  /** function: the signature; macro: its value (shortened); member, variable: the type; enum: the value. */
  detail?: string;
  /** The first sentence of its documentation. */
  doc?: string;
  /** member, enum value: the type it belongs to. */
  parent?: string;
  /** function, function-like macro: the parameters (`GPIO_TypeDef *GPIOx`). */
  params?: string[];
  /** member: a pointer (`->` goes on from it). */
  pointer?: boolean;
  /** macro: the pointer type it casts to (`GPIOA` → `GPIO_TypeDef`). */
  castTo?: string;
  file?: string;
  line?: number;
}

/** The file as shipped: short keys, a file table. */
export interface SymbolIndex {
  version: 1;
  files: string[];
  symbols: PackedSym[];
}

type PackedSym = { n: string; k: string; d?: string; doc?: string; p?: string; a?: string[]; ptr?: 1; c?: string; f?: number; l?: number };

const KIND_CODE: Record<SymKind, string> = { function: "f", macro: "m", type: "t", member: "s", enum: "e", variable: "v" };
const CODE_KIND = Object.fromEntries(Object.entries(KIND_CODE).map(([k, v]) => [v, k])) as Record<string, SymKind>;

export function packIndex(symbols: Sym[]): SymbolIndex {
  const files: string[] = [];
  const fileIdx = new Map<string, number>();
  const out: PackedSym[] = [];
  for (const s of symbols) {
    const p: PackedSym = { n: s.name, k: KIND_CODE[s.kind] };
    if (s.detail) p.d = s.detail;
    if (s.doc) p.doc = s.doc;
    if (s.parent) p.p = s.parent;
    if (s.params) p.a = s.params;
    if (s.pointer) p.ptr = 1;
    if (s.castTo) p.c = s.castTo;
    if (s.file) {
      if (!fileIdx.has(s.file)) {
        fileIdx.set(s.file, files.length);
        files.push(s.file);
      }
      p.f = fileIdx.get(s.file);
      p.l = s.line;
    }
    out.push(p);
  }
  return { version: 1, files, symbols: out };
}

export function unpackIndex(index: SymbolIndex): Sym[] {
  return index.symbols.map((p) => ({
    name: p.n,
    kind: CODE_KIND[p.k] ?? "macro",
    ...(p.d ? { detail: p.d } : {}),
    ...(p.doc ? { doc: p.doc } : {}),
    ...(p.p ? { parent: p.p } : {}),
    ...(p.a ? { params: p.a } : {}),
    ...(p.ptr ? { pointer: true } : {}),
    ...(p.c ? { castTo: p.c } : {}),
    ...(p.f !== undefined ? { file: index.files[p.f], line: p.l } : {}),
  }));
}

/** Split a parameter list at top-level commas: `void`, `...` and empty give none. */
export function splitParams(params: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of params) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  const norm = out.map((p) =>
    p
      .replace(/\s+/g, " ")
      .replace(/(\w)\s*(\*+)\s*/g, "$1 $2")
      .replace(/\(\s*\*\s*/g, "(*"),
  );
  return norm.length === 1 && norm[0] === "void" ? [] : norm;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** The doc comment just before `at` (only blank space between), if any. */
function docBefore(text: string, cms: Comment[], at: number): string | undefined {
  // The last comment that ends before `at`.
  let lo = 0;
  let hi = cms.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cms[mid].end <= at) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (best < 0) return undefined;
  const c = cms[best];
  if (c.trailing || text.slice(c.end, at).trim() !== "") return undefined;
  // Only documentation comments (`/**`, `/*!`, `///`), not section banners.
  if (!/^\/(\*\*|\*!|\/\/)/.test(c.text) || /^\/\*\*+\s*$/m.test(c.text.split("\n")[0]) && /\*{6,}/.test(c.text)) return undefined;
  const b = brief(c.text);
  return b || undefined;
}

/** A trailing comment on the line where `at` is (`/*!< … *\/` after a member). */
function docAfter(text: string, cms: Comment[], at: number): string | undefined {
  const eol = text.indexOf("\n", at);
  const end = eol < 0 ? text.length : eol;
  const c = cms.find((x) => x.start >= at && x.start < end);
  if (!c) return undefined;
  if (text.slice(at, c.start).replace(/[;,\s]/g, "") !== "") return undefined;
  const b = brief(c.text);
  return b || undefined;
}

const MACRO = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)(\(([^)]*)\))?(.*)$/;

function macros(text: string, file: string, cms: Comment[], starts: number[]): Sym[] {
  const out: Sym[] = [];
  const lines = text.split("\n");
  let off = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineOff = off;
    let line = lines[i];
    off += lines[i].length + 1;
    const m = MACRO.exec(line);
    if (!m) continue;
    // Continuation lines.
    while (/\\\s*$/.test(line) && i + 1 < lines.length) {
      line = line.replace(/\\\s*$/, " ") + lines[++i];
      off += lines[i].length + 1;
    }
    const full = MACRO.exec(line)!;
    const name = full[1];
    const valueRaw = maskC(full[4]).trim();
    // Include guards and configuration switches without a value.
    if (!valueRaw && (/_H_?$/.test(name) || name.startsWith("__") || /_H__$/.test(name))) continue;
    const value = norm(valueRaw);
    const at = lineOff + line.indexOf(name);
    const lineEnd = off - 1;
    const trailing = cms.find((c) => c.start > at && c.start < lineEnd && c.trailing);
    const sym: Sym = {
      name,
      kind: "macro",
      file,
      line: lineAt(starts, at),
    };
    if (value) sym.detail = value.length > 90 ? value.slice(0, 87) + "…" : value;
    const d = (trailing && brief(trailing.text)) || docBefore(text, cms, lineOff);
    if (d) sym.doc = d;
    if (full[2] !== undefined) sym.params = splitParams(full[3]);
    // `((GPIO_TypeDef *) GPIOA_BASE)`: `GPIOA->` goes on with GPIO_TypeDef's members.
    const cast = /^\(\s*\(\s*([A-Za-z_]\w*)\s*\*\s*\)/.exec(value);
    if (cast) sym.castTo = cast[1];
    out.push(sym);
  }
  return out;
}

/** Members of a struct/union body (masked, preprocessor blanked), with docs from the original text. */
function members(masked: string, text: string, cms: Comment[], from: number, to: number, parent: string, file: string, starts: number[]): Sym[] {
  const out: Sym[] = [];
  let i = from;
  let stmt = from;
  while (i < to) {
    const ch = masked[i];
    if (ch === "{") {
      // A nested struct/union: its members belong to the parent (anonymous)
      // or to a member named after the `}`.
      const end = matchBrace(masked, i);
      out.push(...members(masked, text, cms, i + 1, end, parent, file, starts));
      i = end + 1;
      stmt = i;
      // Skip the name after a nested body (`} b;`).
      const semi = masked.indexOf(";", i);
      if (semi >= 0 && semi < to) {
        const nm = /([A-Za-z_]\w*)\s*(\[[^\]]*\]\s*)*$/.exec(masked.slice(i, semi));
        if (nm) out.push({ name: nm[1], kind: "member", parent, detail: "struct", file, line: lineAt(starts, i + nm.index) });
        i = semi + 1;
        stmt = i;
      }
      continue;
    }
    if (ch === ";") {
      const decl = masked.slice(stmt, i);
      const fp = /\(\s*\*\s*([A-Za-z_]\w*)\s*\)\s*\(/.exec(decl);
      if (fp) {
        const sym: Sym = { name: fp[1], kind: "member", parent, detail: norm(decl.replace(fp[1], "")), pointer: true, file, line: lineAt(starts, stmt + fp.index) };
        const doc = docAfter(text, cms, i + 1);
        if (doc) sym.doc = doc;
        out.push(sym);
        stmt = i + 1;
        i++;
        continue;
      }
      for (const part of decl.split(",").map((p, k) => ({ p, k }))) {
        const m = /(\*?)\s*([A-Za-z_]\w*)\s*(\[[^\]]*\]\s*)*(:\s*\w+\s*)?$/.exec(part.p);
        if (!m) continue;
        const typeText = part.k === 0 ? norm(part.p.slice(0, m.index)) : norm(decl.split(",")[0].replace(/[A-Za-z_]\w*\s*(\[[^\]]*\]\s*)*$/, ""));
        const type = norm(typeText.replace(/\b(__IO|__I|__O|__IM|__OM|__IOM|volatile|const)\b/g, ""));
        if (!type) continue;
        const ptr = m[1] === "*" || /\*$/.test(typeText) || /\(\s*\*/.test(part.p);
        const at = stmt + decl.indexOf(m[2], part.k === 0 ? 0 : decl.indexOf(","));
        const sym: Sym = { name: m[2], kind: "member", parent, detail: (type + (ptr && !type.endsWith("*") ? " *" : "") + (m[3] ? norm(m[3]) : "")).replace(/\s+\*/, " *"), file, line: lineAt(starts, at) };
        if (ptr) sym.pointer = true;
        const doc = docAfter(text, cms, i + 1) ?? docBefore(text, cms, stmt + (decl.length - decl.trimStart().length));
        if (doc) sym.doc = doc;
        out.push(sym);
      }
      stmt = i + 1;
    }
    i++;
  }
  return out;
}

function enumValues(masked: string, text: string, cms: Comment[], from: number, to: number, parent: string, file: string, starts: number[]): Sym[] {
  const out: Sym[] = [];
  let stmt = from;
  for (let i = from; i <= to; i++) {
    if (i === to || masked[i] === ",") {
      const part = masked.slice(stmt, i);
      const m = /^\s*([A-Za-z_]\w*)\s*(?:=\s*([\s\S]+?))?\s*$/.exec(part);
      if (m) {
        const sym: Sym = { name: m[1], kind: "enum", parent, file, line: lineAt(starts, stmt + part.indexOf(m[1])) };
        if (m[2]) sym.detail = norm(m[2]);
        const doc = docAfter(text, cms, stmt + part.trimEnd().length) ?? docBefore(text, cms, stmt + (part.length - part.trimStart().length));
        if (doc) sym.doc = doc;
        out.push(sym);
      }
      stmt = i + 1;
    }
  }
  return out;
}

const ATTRS = /(?:\b_ATTRIBUTE\s*\(\(.*?\)\)|\b__attribute__\s*\(\(.*?\)\)|\b_NOTHROW\b|\b__THROW\b|\b__nonnull\s*\(.*?\)|\b__result_use_check\b|\b__pure2\b|\b__dead2\b|\b_EXFUN_NOTHROW\b|\b__asm__\s*\(.*?\))/g;

/** Index one header (or source, for doc comments). */
export function indexHeader(text: string, file: string): Sym[] {
  const cms = comments(text);
  const starts = lineStarts(text);
  const out: Sym[] = macros(text, file, cms, starts);
  const masked = maskC(text, { preprocessor: true });
  // Inline functions defined in the header (CMSIS __STATIC_INLINE, HAL's).
  const defs = functionDefs(masked);
  for (const d of defs) {
    const type = norm(d.type.replace(/\b(__STATIC_INLINE|__STATIC_FORCEINLINE|static|inline|__inline|__attribute__\s*\(\(.*?\)\))\b/g, ""));
    if (/\b(typedef|struct|enum|union)\b/.test(type) && /[{}]/.test(type)) continue;
    const sym: Sym = { name: d.name, kind: "function", params: splitParams(d.params), file, line: lineAt(starts, d.nameAt) };
    sym.detail = `${type.replace(ATTRS, "").trim()} ${d.name}(${sym.params!.join(", ")})`.trim();
    const ls = startOfLine(text, d.nameAt);
    const doc = docBefore(text, cms, ls) ?? (ls > 0 ? docBefore(text, cms, startOfLine(text, ls - 1)) : undefined);
    if (doc) sym.doc = doc;
    out.push(sym);
  }
  // Top level: typedefs, structs, enums, prototypes, externs.
  let depth = 0;
  let stmt = 0;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "{") {
      const head = masked.slice(stmt, i);
      const def = defs.find((d) => d.bodyStart === i);
      if (def) {
        i = def.bodyEnd;
        stmt = i + 1;
        continue;
      }
      const agg = /\b(typedef\s+)?(struct|union|enum)\s*([A-Za-z_]\w*)?\s*$/.exec(head);
      if (agg && depth === 0) {
        const end = matchBrace(masked, i);
        const semi = masked.indexOf(";", end);
        const tail = masked.slice(end + 1, semi < 0 ? masked.length : semi);
        const names = agg[1] ? tail.split(",").map((s) => s.replace(/[*\s]/g, "")).filter((s) => /^[A-Za-z_]\w*$/.test(s)) : [];
        const tag = agg[3];
        const typeName = names[0] ?? tag;
        if (typeName) {
          const at = stmt + head.length - head.trimStart().length;
          const doc = docBefore(text, cms, startOfLine(text, at)) ?? undefined;
          for (const n of new Set([...names, ...(tag ? [tag] : [])])) {
            const t: Sym = { name: n, kind: "type", detail: `${agg[2]}${tag && n !== tag ? " " + tag : ""}`, file, line: lineAt(starts, n === tag ? i : end) };
            if (doc) t.doc = doc;
            out.push(t);
          }
          if (agg[2] === "enum") out.push(...enumValues(masked, text, cms, i + 1, end, typeName, file, starts));
          else {
            const ms = members(masked, text, cms, i + 1, end, typeName, file, starts);
            out.push(...ms);
            // The struct tag's members too, for `struct __UART_HandleTypeDef *`.
            if (tag && tag !== typeName) out.push(...ms.map((m) => ({ ...m, parent: tag })));
          }
        }
        i = semi < 0 ? masked.length : semi;
        stmt = i + 1;
        continue;
      }
      depth++;
      // `extern "C" {` (masked to `extern " " {`) is transparent.
      if (/extern\s*"\s*"\s*$/.test(head)) depth--;
      stmt = i + 1;
      continue;
    }
    if (ch === "}") {
      depth = Math.max(0, depth - 1);
      stmt = i + 1;
      continue;
    }
    if (ch !== ";" || depth !== 0) continue;
    const s = masked.slice(stmt, i).replace(ATTRS, " ");
    const stmt0 = stmt;
    const start = stmt + (masked.slice(stmt, i).length - masked.slice(stmt, i).trimStart().length);
    stmt = i + 1;
    const st = norm(s);
    if (!st) continue;
    if (st.startsWith("typedef ")) {
      // `typedef uint32_t X;`, `typedef void (*pFunc)(void);`
      const fp = /\(\s*\*\s*([A-Za-z_]\w*)\s*\)\s*\(/.exec(st);
      const m = fp ?? /([A-Za-z_]\w*)\s*(\[[^\]]*\])?$/.exec(st);
      if (m) out.push({ name: m[1], kind: "type", detail: norm(st.slice(8, fp ? undefined : m.index)) || undefined, file, line: lineAt(starts, start) });
      continue;
    }
    const fn = /^(.*?)\b([A-Za-z_]\w*)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)$/.exec(st);
    if (fn && !/[=]/.test(fn[1]) && fn[1].trim()) {
      const type = norm(fn[1].replace(/\bextern\b/g, ""));
      const params = splitParams(fn[3]);
      const sym: Sym = { name: fn[2], kind: "function", params, detail: `${type} ${fn[2]}(${params.join(", ")})`.replace(/\* /g, "*").replace(/(\w)\*/g, "$1 *"), file, line: lineAt(starts, stmt0 + s.indexOf(fn[2])) };
      const doc = docBefore(text, cms, startOfLine(text, start));
      if (doc) sym.doc = doc;
      out.push(sym);
      continue;
    }
    const v = /^extern\s+(.*?)(\*?)\s*\b([A-Za-z_]\w*)\s*(\[[^\]]*\])?$/.exec(st);
    if (v) {
      const sym: Sym = { name: v[3], kind: "variable", detail: norm(v[1].replace(/\b(volatile|const)\b/g, "")) + (v[2] ? " *" : ""), file, line: lineAt(starts, start) };
      if (v[2]) sym.pointer = true;
      const doc = docAfter(text, cms, i + 1) ?? docBefore(text, cms, startOfLine(text, start));
      if (doc) sym.doc = doc;
      out.push(sym);
    }
  }
  return out;
}

function startOfLine(text: string, at: number): number {
  return text.lastIndexOf("\n", at - 1) + 1;
}

/** Doc comments of function definitions in a .c file (the HAL keeps them there). */
export function docsFromSource(text: string): Map<string, string> {
  const cms = comments(text);
  const masked = maskC(text, { preprocessor: true });
  const out = new Map<string, string>();
  for (const d of functionDefs(masked)) {
    const doc = docBefore(text, cms, startOfLine(text, d.nameAt));
    if (doc) out.set(d.name, doc);
  }
  return out;
}

/** The whole index: every header, docs filled in from sources, one entry per name and parent. */
export function buildIndex(headers: { file: string; text: string }[], sources: { text: string }[] = []): Sym[] {
  const docs = new Map<string, string>();
  for (const s of sources) for (const [k, v] of docsFromSource(s.text)) if (!docs.has(k)) docs.set(k, v);
  const seen = new Map<string, Sym>();
  for (const h of headers) {
    for (const s of indexHeader(h.text, h.file)) {
      const key = `${s.kind === "member" || s.kind === "enum" ? s.parent + "." : ""}${s.name}`;
      const old = seen.get(key);
      // A prototype beats a macro of the same name only if the macro has no value; keep the first otherwise.
      if (old && !(old.kind === "macro" && !old.detail && s.kind !== "macro")) {
        if (!old.doc && s.doc) old.doc = s.doc;
        continue;
      }
      // The HAL documents its functions in the driver's .c.
      if (s.kind === "function" && docs.has(s.name)) s.doc = docs.get(s.name);
      seen.set(key, s);
    }
  }
  return [...seen.values()];
}
