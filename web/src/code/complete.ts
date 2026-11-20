// Autocomplete logic (M33, stage 1), independent of the editor: what is being
// typed at the cursor, what the names there mean (the symbol index plus a
// quick scan of the student's own files), the candidates and the signature
// of the call the cursor is in. Unit tested in test/m33.test.ts.
import { functionDefs, maskC, topStatements, varDecls, KEYWORDS } from "./cscan.ts";
import { indexHeader, splitParams, type Sym } from "./symbols.ts";

export type Context =
  /** `GPIO_InitStruct.Mo|`, `huart2.Init.|`, `GPIOA->OD|`. */
  | { kind: "member"; object: string; from: number; prefix: string }
  /** A name being typed. */
  | { kind: "ident"; from: number; prefix: string }
  /** In a comment, a string or a preprocessor directive name. */
  | { kind: "none" };

/** What is typed at `pos`. */
export function completionContext(text: string, pos: number): Context {
  const masked = maskC(text.slice(0, pos) + " ");
  // Inside a comment or string the masked text has a space where the text has not.
  if (pos > 0 && masked[pos - 1] === " " && text[pos - 1] !== " " && text[pos - 1] !== "\t" && text[pos - 1] !== "\n") return { kind: "none" };
  const before = masked.slice(0, pos);
  const word = /[A-Za-z_]\w*$/.exec(before);
  const from = word ? pos - word[0].length : pos;
  const prefix = word ? word[0] : "";
  if (/^\s*#\s*\w*$/.test(before.slice(before.lastIndexOf("\n") + 1))) return { kind: "none" };
  const acc = /((?:[A-Za-z_]\w*(?:\s*\[[^\]]*\])?\s*(?:\.|->)\s*)*[A-Za-z_]\w*(?:\s*\[[^\]]*\])?)\s*(\.|->)\s*$/.exec(before.slice(0, from));
  if (acc) return { kind: "member", object: acc[1].replace(/\s+/g, ""), from, prefix };
  if (/\d\.?$/.test(before.slice(0, from))) return { kind: "none" };
  return { kind: "ident", from, prefix };
}

/** The call the cursor is an argument of: `HAL_GPIO_WritePin(GPIOA, |` → fn, argument index 1. */
export function callContext(text: string, pos: number): { fn: string; arg: number; open: number } | null {
  const masked = maskC(text.slice(0, pos));
  let depth = 0;
  let arg = 0;
  // Look back to the unclosed `(`, not past the start of the statement.
  for (let i = pos - 1; i >= 0 && i > pos - 2000; i--) {
    const ch = masked[i];
    if (ch === ")" || ch === "]") depth++;
    else if (ch === "[") depth--;
    else if (ch === "(") {
      if (depth === 0) {
        const name = /([A-Za-z_]\w*)\s*$/.exec(masked.slice(0, i));
        if (!name || KEYWORDS.has(name[1])) return null;
        return { fn: name[1], arg, open: i };
      }
      depth--;
    } else if (ch === "," && depth === 0) arg++;
    else if ((ch === ";" || ch === "{" || ch === "}") && depth === 0) return null;
  }
  return null;
}

// ------------------------------------------------------------ symbols

export interface SymbolTable {
  /** Everything but members and enum values by... well, everything that a bare name can be. */
  globals: Sym[];
  byName: Map<string, Sym>;
  members: Map<string, Sym[]>;
}

export function makeTable(symbols: Sym[]): SymbolTable {
  const globals: Sym[] = [];
  const byName = new Map<string, Sym>();
  const members = new Map<string, Sym[]>();
  for (const s of symbols) {
    if (s.kind === "member") {
      members.set(s.parent!, [...(members.get(s.parent!) ?? []), s]);
      continue;
    }
    globals.push(s);
    if (!byName.has(s.name)) byName.set(s.name, s);
  }
  return { globals, byName, members };
}

/** The student's own files as symbols: functions, macros, types, file-scope variables. */
export function localSymbols(files: { path: string; text: string }[]): Sym[] {
  const out: Sym[] = [];
  for (const f of files) {
    out.push(...indexHeader(f.text, f.path));
    const masked = maskC(f.text, { preprocessor: true });
    for (const st of topStatements(masked)) {
      if (/^\s*(typedef)\b/.test(st.text) || /\(/.test(st.text.split("=")[0])) continue;
      for (const v of varDecls(st.text, st.start)) out.push({ name: v.name, kind: "variable", detail: v.type + (v.pointer ? " *" : ""), pointer: v.pointer, file: f.path });
    }
    for (const d of functionDefs(masked)) {
      if (!out.some((s) => s.kind === "function" && s.name === d.name)) {
        out.push({ name: d.name, kind: "function", params: splitParams(d.params), detail: `${d.type} ${d.name}(${d.params})`, file: f.path });
      }
    }
  }
  return out;
}

/** `GPIO_InitTypeDef`, `UART_HandleTypeDef *` → the type name members are listed under. */
const baseType = (t: string) =>
  t
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\b(const|volatile|struct|union|enum|static|__IO|__I|__O)\b/g, "")
    .replace(/\*/g, "")
    .trim();

/** The type of a variable named `name` seen at `pos`: the nearest declaration before it, then globals. */
function variableType(name: string, text: string, pos: number, table: SymbolTable): string | null {
  const masked = maskC(text.slice(0, pos), { preprocessor: true });
  const decls = varDecls(masked).filter((d) => d.name === name);
  if (decls.length) return baseType(decls[decls.length - 1].type);
  // A parameter: `void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart)`.
  const param = new RegExp(`\\(([^()]*\\b${name}\\b[^()]*)\\)\\s*\\{[^]*$`).exec(masked);
  if (param) {
    for (const p of splitParams(param[1])) {
      const m = new RegExp(`^(.*?)\\*?\\s*\\b${name}\\s*(\\[[^\\]]*\\])?$`).exec(p);
      if (m) return baseType(m[1]);
    }
  }
  const g = table.byName.get(name);
  if (g?.kind === "variable" && g.detail) return baseType(g.detail);
  if (g?.kind === "macro" && g.castTo) return g.castTo;
  return null;
}

/** The type of `a.b->c` (null: unknown). */
export function resolveType(object: string, text: string, pos: number, table: SymbolTable): string | null {
  const parts = object.split(/\.|->/).map((p) => p.replace(/\[.*\]$/, ""));
  let type = variableType(parts[0], text, pos, table);
  for (const p of parts.slice(1)) {
    if (!type) return null;
    const m = membersOf(type, table).find((x) => x.name === p);
    if (!m?.detail) return null;
    type = baseType(m.detail);
  }
  return type ? followTypedef(type, table) : null;
}

/** `typedef struct __X X;` style aliases: the name members are filed under. */
function followTypedef(type: string, table: SymbolTable): string {
  let t = type;
  for (let i = 0; i < 4 && !table.members.has(t); i++) {
    const s = table.byName.get(t);
    const next = s?.kind === "type" && s.detail ? baseType(s.detail) : "";
    if (!next || next === t || !/^[A-Za-z_]\w*$/.test(next)) break;
    t = next;
  }
  return t;
}

export function membersOf(type: string, table: SymbolTable): Sym[] {
  return table.members.get(followTypedef(type, table)) ?? [];
}

export interface Candidate {
  label: string;
  kind: Sym["kind"] | "keyword";
  detail?: string;
  doc?: string;
  /** Text to insert when it differs from the label (`HAL_Delay()` → with parentheses). */
  apply?: string;
  boost?: number;
}

const C_WORDS = ["if", "else", "while", "for", "do", "switch", "case", "default", "break", "continue", "return", "static", "volatile", "const", "unsigned", "struct", "typedef", "sizeof", "void", "int", "char", "float", "uint8_t", "uint16_t", "uint32_t", "int32_t"];

const MAX = 300;

/** Candidates at `pos` (null: nothing to offer here). */
export function candidates(text: string, pos: number, table: SymbolTable, opts: { explicit?: boolean } = {}): { from: number; options: Candidate[] } | null {
  const ctx = completionContext(text, pos);
  if (ctx.kind === "none") return null;
  if (ctx.kind === "member") {
    const type = resolveType(ctx.object, text, pos, table);
    if (!type) return null;
    const ms = membersOf(type, table);
    if (!ms.length) return null;
    return { from: ctx.from, options: ms.map((m) => ({ label: m.name, kind: "member", detail: m.detail, doc: m.doc })) };
  }
  if (!ctx.prefix && !opts.explicit) return null;
  const p = ctx.prefix.toLowerCase();
  const seen = new Set<string>();
  const options: Candidate[] = [];
  const add = (c: Candidate) => {
    if (seen.has(c.label)) return;
    seen.add(c.label);
    options.push(c);
  };
  // Locals of the function the cursor is in, then the rest.
  const masked = maskC(text, { preprocessor: true });
  const fn = functionDefs(masked).find((f) => f.bodyStart < pos && pos <= f.bodyEnd);
  if (fn) {
    for (const prm of splitParams(fn.params)) {
      const m = /([A-Za-z_]\w*)\s*(\[[^\]]*\])?$/.exec(prm);
      if (m && m[1].toLowerCase().startsWith(p)) add({ label: m[1], kind: "variable", detail: prm, boost: 3 });
    }
    for (const v of varDecls(masked.slice(fn.bodyStart, pos))) {
      if (v.name.toLowerCase().startsWith(p)) add({ label: v.name, kind: "variable", detail: v.type + (v.pointer ? " *" : ""), boost: 3 });
    }
  }
  for (const s of table.globals) {
    if (options.length >= MAX) break;
    const n = s.name.toLowerCase();
    if (!(p ? n.startsWith(p) : true)) continue;
    add({ label: s.name, kind: s.kind, detail: s.detail, doc: s.doc, boost: s.name.startsWith("HAL_") ? 1 : 0 });
  }
  // Then names that contain what was typed (`Toggle` finds HAL_GPIO_TogglePin).
  if (p.length >= 3) {
    for (const s of table.globals) {
      if (options.length >= MAX) break;
      if (s.name.toLowerCase().includes(p)) add({ label: s.name, kind: s.kind, detail: s.detail, doc: s.doc, boost: -1 });
    }
  }
  for (const w of C_WORDS) if (w.startsWith(p) && p) add({ label: w, kind: "keyword", boost: -2 });
  return { from: ctx.from, options };
}

/** The signature help for the call at `pos`. */
export function signatureAt(text: string, pos: number, table: SymbolTable): { fn: Sym; arg: number } | null {
  const c = callContext(text, pos);
  if (!c) return null;
  const fn = table.byName.get(c.fn);
  if (!fn || !(fn.kind === "function" || (fn.kind === "macro" && fn.params)) || !fn.params) return null;
  return { fn, arg: c.arg };
}

/** The index's table with the student's own symbols in front. */
export function withLocal(base: SymbolTable, local: Sym[]): SymbolTable {
  const l = makeTable(local);
  const byName = new Map(base.byName);
  for (const [k, v] of l.byName) byName.set(k, v);
  const members = new Map(base.members);
  for (const [k, v] of l.members) members.set(k, v);
  return { globals: [...l.globals, ...base.globals], byName, members };
}
