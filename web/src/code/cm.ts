// CodeMirror 6 for the code tab (M33): C highlighting, line numbers, bracket
// matching, search, undo, autocomplete from the symbol index, a signature
// hint inside calls, and the build's and the rules' diagnostics inline.
// CodeMirror: small, modular (only these packages are bundled, in the code
// tab's own chunk), MIT, works with IME input (Korean comments).
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { cpp } from "@codemirror/lang-cpp";
import { bracketMatching, defaultHighlightStyle, foldGutter, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { linter, lintGutter, lintKeymap, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  showTooltip,
  type Tooltip,
} from "@codemirror/view";
import { candidates, signatureAt, type Candidate, type SymbolTable } from "./complete.ts";
import type { Diagnostic } from "./diagnostics.ts";
import { lint, RULE_TITLE, type LintFile, type LintIssue, type MacroLookup } from "./lint.ts";

/** Build messages for one file, kept in place while the text is edited. */
interface PlacedDiag {
  from: number;
  to: number;
  d: Diagnostic;
}

export const setBuildDiagnostics = StateEffect.define<Diagnostic[]>();

/** Offsets of a 1-based line and (byte) column, clamped to the document. */
function place(state: EditorState, d: Diagnostic): PlacedDiag {
  const n = Math.min(Math.max(d.line ?? 1, 1), state.doc.lines);
  const line = state.doc.line(n);
  if (!d.column) return { from: line.from, to: line.to, d };
  // clang counts bytes; Korean in a line before the column shifts it.
  const enc = new TextEncoder();
  let col = 0;
  let bytes = 0;
  while (col < line.length && bytes < d.column - 1) bytes += enc.encode(line.text[col++]).length;
  const from = line.from + col;
  const word = /^[A-Za-z_]\w*|^./.exec(line.text.slice(col));
  const to = Math.min(line.to, from + (word ? word[0].length : 0));
  // At the end of the line ("expected ';'"): underline the last character.
  if (to === from && from > line.from) return { from: from - 1, to: from, d };
  return { from, to, d };
}

const buildDiagField = StateField.define<PlacedDiag[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setBuildDiagnostics)) return e.value.map((d) => place(tr.state, d));
    if (!tr.docChanged) return value;
    return value.map((p) => ({ ...p, from: tr.changes.mapPos(p.from, 1), to: Math.max(tr.changes.mapPos(p.from, 1), tr.changes.mapPos(p.to, -1)) }));
  },
});

const KIND_TYPE: Record<Candidate["kind"], string> = {
  function: "function",
  macro: "constant",
  type: "type",
  member: "property",
  enum: "enum",
  variable: "variable",
  keyword: "keyword",
};

function completionSource(table: () => SymbolTable | null) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const t = table();
    if (!t) return null;
    const text = ctx.state.doc.toString();
    const r = candidates(text, ctx.pos, t, { explicit: ctx.explicit });
    if (!r || !r.options.length) return null;
    const options: Completion[] = r.options.map((o) => ({
      label: o.label,
      type: KIND_TYPE[o.kind],
      detail: o.detail && o.detail.length > 60 ? o.detail.slice(0, 57) + "…" : o.detail,
      info: o.doc || o.detail ? () => info(o) : undefined,
      boost: o.boost,
    }));
    return { from: r.from, options, validFor: /^\w*$/ };
  };
}

function info(o: Candidate): Node {
  const div = document.createElement("div");
  div.className = "cm-sym-info";
  if (o.detail) {
    const code = document.createElement("code");
    code.textContent = o.detail;
    div.append(code);
  }
  if (o.doc) {
    const p = document.createElement("p");
    p.textContent = o.doc;
    div.append(p);
  }
  return div;
}

/** The signature of the call the cursor is in, the current argument in bold. */
function signatureField(table: () => SymbolTable | null) {
  const compute = (state: EditorState): Tooltip | null => {
    const t = table();
    const sel = state.selection.main;
    if (!t || !sel.empty) return null;
    const s = signatureAt(state.doc.toString(), sel.head, t);
    if (!s) return null;
    return {
      pos: sel.head,
      above: true,
      strictSide: true,
      arrow: false,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "cm-signature";
        dom.setAttribute("data-testid", "signature-hint");
        const sig = document.createElement("code");
        const ret = (s.fn.detail ?? "").split(`${s.fn.name}(`)[0];
        sig.append(document.createTextNode(`${ret}${s.fn.name}(`));
        s.fn.params!.forEach((p, i) => {
          if (i) sig.append(document.createTextNode(", "));
          const el = document.createElement(i === s.arg ? "b" : "span");
          el.textContent = p;
          sig.append(el);
        });
        sig.append(document.createTextNode(")"));
        dom.append(sig);
        if (s.fn.doc) {
          const p = document.createElement("div");
          p.className = "cm-signature-doc";
          p.textContent = s.fn.doc;
          dom.append(p);
        }
        return { dom };
      },
    };
  };
  return StateField.define<Tooltip | null>({
    create: compute,
    update: (v, tr) => (tr.docChanged || tr.selection ? compute(tr.state) : v),
    provide: (f) => showTooltip.from(f),
  });
}

export interface EditorHooks {
  /** The path of this editor's file. */
  path: string;
  readOnly?: boolean;
  table: () => SymbolTable | null;
  /** Every file of the project as it is now (the rules look across files). */
  files: () => LintFile[];
  macros: MacroLookup;
  onChange?: (text: string) => void;
  /** "왜?" on a rule's diagnostic. */
  onWhy?: (issue: LintIssue) => void;
}

const BUILD_SEVERITY = { error: "error", warning: "warning", note: "info" } as const;

export function extensions(h: EditorHooks): Extension[] {
  const exts: Extension[] = [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    bracketMatching(),
    closeBrackets(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    cpp(),
    EditorState.tabSize.of(2),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, ...lintKeymap, indentWithTab]),
    EditorView.theme({
      "&": { height: "100%", fontSize: "13px" },
      ".cm-scroller": { fontFamily: 'ui-monospace, "D2Coding", "Nanum Gothic Coding", "Noto Sans Mono CJK KR", "Malgun Gothic", Consolas, monospace' },
    }),
  ];
  if (h.readOnly) {
    exts.push(EditorState.readOnly.of(true));
    return exts;
  }
  exts.push(
    buildDiagField,
    autocompletion({ override: [completionSource(h.table)], activateOnTyping: true, maxRenderedOptions: 80, icons: true }),
    signatureField(h.table),
    lintGutter(),
    linter(
      (view) => {
        const out: CmDiagnostic[] = view.state.field(buildDiagField).map((p) => ({
          from: p.from,
          to: p.to,
          severity: BUILD_SEVERITY[p.d.severity],
          source: p.d.tool === "ld" ? "링커" : "컴파일러",
          message: p.d.message + (p.d.flag ? ` [${p.d.flag}]` : ""),
        }));
        // The rules see every file; the editor shows this file's.
        const files = h.files().map((f) => (f.path === h.path ? { ...f, text: view.state.doc.toString() } : f));
        for (const i of lint(files, h.macros)) {
          if (i.file !== h.path || i.to > view.state.doc.length) continue;
          out.push({
            from: i.from,
            to: i.to,
            severity: i.severity,
            source: `규칙: ${RULE_TITLE[i.rule]}`,
            message: i.message,
            actions: h.onWhy ? [{ name: "왜?", apply: () => h.onWhy!(i) }] : [],
          });
        }
        return out;
      },
      { delay: 400, needsRefresh: (u) => u.transactions.some((t) => t.effects.some((e) => e.is(setBuildDiagnostics))) },
    ),
  );
  if (h.onChange) {
    const cb = h.onChange;
    exts.push(EditorView.updateListener.of((u) => u.docChanged && cb(u.state.doc.toString())));
  }
  return exts;
}
