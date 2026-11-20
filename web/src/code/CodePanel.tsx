// The code tab (M33): edit the project's C files, build them in the browser
// and run the result. Loaded only when the tab is opened (its own chunk with
// CodeMirror); the compiler (about 20 MB) only on the first build.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Runner } from "../sim/useRunner";
import type { Example } from "../run/RunControls";
import { extensions, setBuildDiagnostics } from "./cm.ts";
import { localSymbols, makeTable, withLocal, type SymbolTable } from "./complete.ts";
import { compiler, useCompiler, type BuildOutput } from "./compiler.ts";
import { countText, type Diagnostic } from "./diagnostics.ts";
import { lint, RULE_TITLE, type LintIssue } from "./lint.ts";
import { CODE_ELF, isStale, MAIN_C, newFilePath, type CodeProject } from "./project.ts";
import { unpackIndex, type Sym, type SymbolIndex } from "./symbols.ts";
import { readTar } from "./tar.ts";
import { maybeGunzip } from "./toolchain.ts";
import { useEditorOffline } from "./offline.ts";
import { elfKey } from "../upload/attach.ts";
import type { SourceFile } from "./build.ts";
import "./code.css";

// ---------------------------------------------------------- shared data

let indexOnce: Promise<{ syms: Sym[]; table: SymbolTable; files: string[] }> | null = null;
function symbolIndex() {
  indexOnce ??= fetch("./editor/hal-symbols.json")
    .then((r) => (r.ok ? (r.json() as Promise<SymbolIndex>) : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((ix) => {
      const syms = unpackIndex(ix);
      return { syms, table: makeTable(syms), files: ix.files };
    })
    .catch(() => {
      indexOnce = null;
      return { syms: [], table: makeTable([]), files: [] };
    });
  return indexOnce;
}

let headersOnce: Promise<Map<string, string>> | null = null;
/** The SDK's headers (for the read-only view), from the SDK bundle. */
function sdkHeaders() {
  headersOnce ??= (async () => {
    const m = await (await fetch("./toolchain/manifest.json")).json();
    const r = await fetch(`./${m.sdk.url}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const out = new Map<string, string>();
    const dec = new TextDecoder("latin1");
    for (const e of readTar(await maybeGunzip(new Uint8Array(await r.arrayBuffer())))) {
      if (e.name.startsWith("sdk/include/") && e.name.endsWith(".h")) out.set(e.name.slice("sdk/include/".length), dec.decode(e.data));
    }
    return out;
  })();
  headersOnce.catch(() => (headersOnce = null));
  return headersOnce;
}

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const mb = (n: number) => (n / 1048576).toFixed(1);

const SEVERITY_LABEL = { error: "오류", warning: "경고", note: "참고", info: "제안" } as const;

export interface CodePanelProps {
  runner: Runner;
  code: CodeProject | undefined;
  onCode: (c: CodeProject | undefined) => void;
  examples: Example[];
  /** Changes when the project's code was replaced from outside (opened, link, lesson). */
  codeSeq: number;
  /** Build once now (a received link with code but no firmware), then call `onAutoBuilt`. */
  autoBuild?: boolean;
  onAutoBuilt?: () => void;
  /** The code tab is on screen (it stays mounted while hidden). */
  visible?: boolean;
  /** The last session is back (its code may still be on its way before). */
  restored?: boolean;
}

export default function CodePanel({ runner, code, onCode, examples, codeSeq, autoBuild = false, onAutoBuilt, visible = true, restored = true }: CodePanelProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const states = useRef(new Map<string, EditorState>());
  const filesRef = useRef<SourceFile[]>(code?.files ?? []);
  const codeRef = useRef(code);
  codeRef.current = code;
  const [active, setActive] = useState<string>(code?.active ?? MAIN_C);
  const [header, setHeader] = useState<string | null>(null);
  const [headerList, setHeaderList] = useState<string[]>([]);
  const [table, setTable] = useState<SymbolTable | null>(null);
  const tableRef = useRef<SymbolTable | null>(null);
  const [macroBase, setMacroBase] = useState<Map<string, string>>(new Map());
  const [result, setResult] = useState<(BuildOutput & { at: number }) | null>(null);
  const [issues, setIssues] = useState<LintIssue[]>([]);
  const [why, setWhy] = useState<string | null>(null);
  const [big, setBig] = useState(false);
  const [menuAt, setMenuAt] = useState<{ right: number; top?: number | "auto"; bottom?: number | "auto" }>({ right: 0 });
  const [notice, setNotice] = useState<string | null>(null);
  // Bumped when this tab replaces the code itself (an example's main.c).
  const [localSeq, setLocalSeq] = useState(0);
  const comp = useCompiler();
  const { offline, cacheOffline } = useEditorOffline();
  const editable = examples.filter((e) => e.code);

  useEffect(() => {
    void symbolIndex().then((ix) => {
      setTable(ix.table);
      setHeaderList(ix.files);
      setMacroBase(new Map(ix.syms.filter((s) => s.kind === "macro" && s.detail).map((s) => [s.name, s.detail!])));
    });
  }, []);

  // The table with the student's own symbols, refreshed as they type (debounced).
  const refreshTable = useCallback(() => {
    if (!table) return;
    tableRef.current = withLocal(table, localSymbols(filesRef.current));
  }, [table]);
  useEffect(refreshTable, [refreshTable]);

  const macroLookup = useCallback((n: string) => macroBase.get(n), [macroBase]);

  const relint = useCallback(() => setIssues(lint(filesRef.current, macroLookup)), [macroLookup]);

  // ------------------------------------------------ editor states per file
  const emit = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onText = useCallback(
    (path: string, text: string) => {
      filesRef.current = filesRef.current.map((f) => (f.path === path ? { ...f, text } : f));
      if (emit.current) clearTimeout(emit.current);
      emit.current = setTimeout(() => {
        const c = codeRef.current;
        if (c) onCode({ ...c, files: filesRef.current, active: path });
        refreshTable();
        relint();
      }, 300);
    },
    [onCode, refreshTable, relint],
  );

  const stateFor = useCallback(
    (path: string, text: string) =>
      EditorState.create({
        doc: text,
        extensions: extensions({
          path,
          table: () => tableRef.current,
          files: () => filesRef.current,
          macros: macroLookup,
          onChange: (t) => onText(path, t),
          onWhy: (i) => setWhy(`${i.file}:${i.line}:${i.rule}`),
        }),
      }),
    [macroLookup, onText],
  );

  // (Re)build every file's state when the code is replaced from outside.
  useEffect(() => {
    if (emit.current) clearTimeout(emit.current);
    filesRef.current = code?.files ?? [];
    states.current = new Map(filesRef.current.map((f) => [f.path, stateFor(f.path, f.text)]));
    const first = code?.active && filesRef.current.some((f) => f.path === code.active) ? code.active : (filesRef.current[0]?.path ?? MAIN_C);
    setActive(first);
    setHeader(null);
    setResult(null);
    refreshTable();
    relint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeSeq, localSeq, !!code, stateFor]);

  // The view shows the active file (or a header, read-only).
  const [headerText, setHeaderText] = useState<string | null>(null);
  useEffect(() => {
    // The view lives in `host`, which is not there while the tab has no
    // code (its start screen): a view kept from before would get the new
    // state but stay off screen, and the editor showed no text.
    if (view.current && view.current.dom.parentNode !== host.current) {
      view.current.destroy();
      view.current = null;
    }
    if (!host.current) return;
    let state: EditorState | undefined;
    if (header !== null) {
      state = EditorState.create({ doc: headerText ?? "/* 불러오는 중… */", extensions: extensions({ path: header, readOnly: true, table: () => null, files: () => [], macros: () => undefined }) });
    } else state = states.current.get(active);
    if (!state) {
      view.current?.destroy();
      view.current = null;
      return;
    }
    if (!view.current) view.current = new EditorView({ state, parent: host.current });
    else view.current.setState(state);
  }, [active, header, headerText, codeSeq, localSeq, !!code]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => view.current?.destroy(), []);

  const switchTo = (path: string) => {
    if (view.current && header === null && states.current.has(active)) states.current.set(active, view.current.state);
    setHeader(null);
    setActive(path);
  };
  const openHeader = async (file: string) => {
    if (view.current && header === null && states.current.has(active)) states.current.set(active, view.current.state);
    setHeader(file);
    setHeaderText(null);
    try {
      const h = await sdkHeaders();
      setHeaderText(h.get(file) ?? `/* ${file}: SDK에 없습니다 */`);
    } catch {
      setHeaderText(`/* 헤더를 받지 못했습니다 (오프라인이면 먼저 '편집기 오프라인으로 받기') */`);
    }
  };

  // ------------------------------------------------ build
  // (Read when a build finishes, not when it began: the student may have
  // opened another file or a header meanwhile, and the view then holds
  // that one — its state must not be saved under the file built from.)
  const activeRef = useRef(active);
  activeRef.current = active;
  const headerRef = useRef(header);
  headerRef.current = header;
  const pushDiagnostics = useCallback((diags: Diagnostic[]) => {
    const now = activeRef.current;
    const shown = headerRef.current === null && view.current && states.current.has(now) ? now : null;
    for (const [path, st] of states.current) {
      const mine = diags.filter((d) => d.file === path);
      if (path === shown) {
        // The open file: in place (keeps its scroll and selection).
        view.current!.dispatch({ effects: setBuildDiagnostics.of(mine) });
        states.current.set(path, view.current!.state);
      } else states.current.set(path, st.update({ effects: setBuildDiagnostics.of(mine) }).state);
    }
    // The first error of the open file comes into view.
    const first = diags.find((d) => d.severity === "error" && d.file === shown && d.line);
    if (first && view.current) {
      const doc = view.current.state.doc;
      const l = doc.line(Math.min(Math.max(first.line!, 1), doc.lines));
      view.current.dispatch({ selection: { anchor: l.to }, scrollIntoView: true });
    }
  }, []);

  const build = useCallback(async () => {
    const c = codeRef.current;
    if (!c || comp.building) return;
    if (emit.current) {
      clearTimeout(emit.current);
      emit.current = null;
      refreshTable();
      relint();
    }
    const files = filesRef.current;
    onCode({ ...c, files });
    setNotice(null);
    const r = await compiler.build(files);
    setResult({ ...r, at: Date.now() });
    pushDiagnostics(r.diagnostics);
    if (r.ok && r.elf) {
      const key = elfKey(r.elf);
      // The project keeps the files as they are now (edited during the
      // build, maybe); `built` is what this ELF was made from.
      onCode({ ...codeRef.current!, built: { key, files } });
      runner.load(CODE_ELF, r.elf.slice().buffer as ArrayBuffer);
      runner.run();
    }
  }, [comp.building, onCode, pushDiagnostics, runner, refreshTable, relint]);

  // A build asked for from outside (a received link with code).
  useEffect(() => {
    if (!autoBuild || !table) return;
    onAutoBuilt?.();
    if (codeRef.current) void build();
  }, [autoBuild, table, build, onAutoBuilt]);

  // Ctrl/Cmd+B builds.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b" && host.current?.contains(document.activeElement)) {
        e.preventDefault();
        void build();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [build]);

  // ------------------------------------------------ files
  /** Start the code from an example's main.c; false if it could not be read. */
  const startFrom = async (file: string): Promise<boolean> => {
    const ex = editable.find((e) => e.file === file);
    if (!ex?.code) return false;
    const r = await fetch(`./examples/src/${ex.code.main}`).catch(() => null);
    if (!r?.ok) {
      setNotice(`${ex.code.main}을(를) 받지 못했습니다.`);
      return false;
    }
    onCode({ template: "hal", base: ex.file, files: [{ path: MAIN_C, text: await r.text() }], active: MAIN_C });
    setLocalSeq((k) => k + 1);
    return true;
  };
  const addFile = async () => {
    const name = window.prompt("새 파일 이름 (.c 또는 .h, 예: led.c, led.h, main.h)", "");
    if (!name || !codeRef.current) return;
    const path = newFilePath(name);
    if (!path) return setNotice(`'${name}'은(는) 쓸 수 없는 파일 이름입니다 (영문·숫자·_·-, .c/.h).`);
    if (filesRef.current.some((f) => f.path === path)) return switchTo(path);
    let text = path.endsWith(".h") ? `#ifndef ${baseName(path).replace(/\W/g, "_").toUpperCase()}\n#define ${baseName(path).replace(/\W/g, "_").toUpperCase()}\n\n\n#endif\n` : `#include "main.h"\n\n`;
    // main.h: start from the template's (it then replaces it for every file).
    if (path === "Core/Inc/main.h") {
      const r = await fetch("./examples/src/hal-common/Inc/main.h");
      if (r.ok) text = await r.text();
    }
    const files = [...filesRef.current, { path, text }];
    filesRef.current = files;
    states.current.set(path, stateFor(path, text));
    onCode({ ...codeRef.current, files, active: path });
    switchTo(path);
  };
  const removeFile = (path: string) => {
    if (path === MAIN_C || !codeRef.current || !window.confirm(`${path}을(를) 지울까요?`)) return;
    const files = filesRef.current.filter((f) => f.path !== path);
    filesRef.current = files;
    states.current.delete(path);
    onCode({ ...codeRef.current, files, active: MAIN_C });
    if (active === path) switchTo(MAIN_C);
  };
  const resetToExample = async () => {
    const c = codeRef.current;
    const ex = c?.base && editable.find((e) => e.file === c.base);
    if (!ex || !window.confirm("편집한 코드를 지우고 예제의 원래 main.c로 되돌릴까요?")) return;
    await startFrom(ex.file);
  };
  // No code yet and the firmware running is an example that can be
  // edited: open its main.c when the tab is shown, rather than an empty
  // tab that asks for an example (loading an example's project, its
  // circuit with it, replaces the project's code — and may arrive after
  // its firmware, dropping a main.c opened meanwhile: it opens again).
  // Not after "코드 지우기" for that firmware, nor again after a failure.
  const dismissed = useRef<string | null>(null);
  const opening = useRef(false);
  useEffect(() => {
    const fw = runner.firmwareExample;
    if (code || !visible || !restored || !fw || opening.current || dismissed.current === fw || !editable.some((e) => e.file === fw)) return;
    opening.current = true;
    void startFrom(fw)
      .then((ok) => {
        if (!ok) dismissed.current = fw;
      })
      .finally(() => (opening.current = false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, visible, restored, runner.firmwareExample, editable]);

  const removeCode = () => {
    if (!window.confirm("이 프로젝트의 코드를 모두 지울까요? (회로와 펌웨어는 그대로)")) return;
    dismissed.current = runner.firmwareExample ?? null;
    onCode(undefined);
  };

  // ------------------------------------------------ problems
  const problems = useMemo(() => {
    const out: { key: string; file: string | null; line: number | null; severity: keyof typeof SEVERITY_LABEL; source: string; message: string; why?: string }[] = [];
    for (const [i, d] of (result?.diagnostics ?? []).entries()) {
      out.push({ key: `b${i}`, file: d.file, line: d.line, severity: d.severity, source: d.tool === "ld" ? "링커" : "컴파일러", message: d.message + (d.flag ? ` [${d.flag}]` : "") });
    }
    for (const i of issues) out.push({ key: `${i.file}:${i.line}:${i.rule}`, file: i.file, line: i.line, severity: i.severity, source: `규칙: ${RULE_TITLE[i.rule]}`, message: i.message, why: i.why });
    return out;
  }, [result, issues]);
  const goto = (file: string | null, line: number | null) => {
    if (!file) return;
    if (filesRef.current.some((f) => f.path === file)) {
      if (file !== active || header !== null) switchTo(file);
      setTimeout(() => {
        const v = view.current;
        if (!v || !line) return;
        const l = v.state.doc.line(Math.min(Math.max(line, 1), v.state.doc.lines));
        v.dispatch({ selection: { anchor: l.from }, scrollIntoView: true });
        v.focus();
      }, 0);
    }
  };

  // ------------------------------------------------ status line
  const stale = code ? isStale(code) : false;
  const loadedIsCode = !!code?.built && !!runner.firmwareBytes && elfKey(runner.firmwareBytes) === code.built.key;
  let status: string;
  if (comp.phase === "loading" && !comp.starting) status = comp.total ? `컴파일러 받는 중 ${Math.floor((comp.done / comp.total) * 100)}% (${mb(comp.done)} / ${mb(comp.total)} MB)` : "컴파일러 받는 중…";
  else if (comp.phase === "loading") status = "컴파일러 시작 중…";
  else if (comp.phase === "failed") status = `컴파일러를 시작하지 못했습니다: ${comp.error}`;
  else if (comp.building) status = "빌드 중…";
  else if (result && !result.ok) status = `${countText(result.diagnostics)} — 빌드하지 못했습니다`;
  else if (result?.ok) status = `빌드 성공 (${(result.ms.total / 1000).toFixed(1)}초)${loadedIsCode ? " · 실행 중인 펌웨어" : ""}${stale ? " · 그 뒤 고침" : ""}`;
  else if (loadedIsCode) status = stale ? "고친 뒤 아직 빌드하지 않았습니다" : "이 코드로 빌드한 펌웨어가 실행 중입니다";
  else status = code?.built && !loadedIsCode ? "지금 펌웨어는 이 코드로 빌드한 것이 아닙니다" : "‘빌드’를 누르면 브라우저 안에서 컴파일합니다";

  if (!code) {
    return (
      <div className="code-panel code-empty" data-testid="code-panel">
        <p>
          예제의 <code>main.c</code>를 고쳐 브라우저 안에서 빌드하고 바로 실행합니다. 회로는 그대로 둡니다. 처음 빌드할 때 컴파일러(약 20 MB)를
          한 번 받습니다.
        </p>
        <label>
          예제에서 시작{" "}
          <select aria-label="코드를 시작할 예제" defaultValue="" onChange={(e) => e.target.value && void startFrom(e.target.value)}>
            <option value="">고르세요…</option>
            {runner.firmwareExample && editable.some((e) => e.file === runner.firmwareExample) && (
              <option value={runner.firmwareExample}>지금 펌웨어: {runner.firmwareExample}</option>
            )}
            {editable.map((e) => (
              <option key={e.file} value={e.file}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
        {notice && <p className="error">{notice}</p>}
      </div>
    );
  }

  return (
    <div className={big ? "code-panel big" : "code-panel"} data-testid="code-panel">
      <div className="code-bar">
        <nav className="code-files" aria-label="코드 파일">
          {code.files.map((f) => (
            <span key={f.path} className={header === null && f.path === active ? "code-file on" : "code-file"}>
              <button onClick={() => switchTo(f.path)} title={f.path} data-file={f.path}>
                {baseName(f.path)}
              </button>
              {f.path !== MAIN_C && (
                <button className="code-file-x" onClick={() => removeFile(f.path)} aria-label={`${f.path} 지우기`}>
                  ×
                </button>
              )}
            </span>
          ))}
          {header !== null && <span className="code-file on header-file" title={header}>🔒 {baseName(header)}</span>}
          <button onClick={() => void addFile()} title="새 .c/.h 파일 (main.h는 템플릿의 것을 복사해 바꿈)">
            + 파일
          </button>
          <select aria-label="HAL 헤더 보기" value="" onChange={(e) => e.target.value && void openHeader(e.target.value)}>
            <option value="">헤더 보기…</option>
            {headerList.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        </nav>
        <span className={result && !result.ok ? "code-status error" : "code-status"} data-testid="build-status">
          {status}
        </span>
        <button className="primary" onClick={() => void build()} disabled={comp.building || comp.phase === "loading"} title="브라우저 안에서 컴파일·링크하고 실행합니다 (Ctrl+B)">
          ▶ 빌드
        </button>
        <button onClick={() => setBig(!big)} aria-pressed={big} title={big ? "작게" : "크게 (회로 위에 띄움)"}>
          {big ? "⤡ 작게" : "⤢ 크게"}
        </button>
        <details
          className="code-menu"
          onToggle={(e) => {
            // Fixed to the window: the tab body scrolls and would clip it.
            const d = e.currentTarget;
            const r = d.querySelector("summary")!.getBoundingClientRect();
            setMenuAt({ right: window.innerWidth - r.right, ...(big ? { top: r.bottom + 2, bottom: "auto" } : { bottom: window.innerHeight - r.top + 2, top: "auto" }) });
          }}
        >
          <summary aria-label="코드 메뉴">⋯</summary>
          <div className="upload-pop" style={{ position: "fixed", left: "auto", ...menuAt }}>
            {offline.state !== "off" && (
              <button onClick={() => void cacheOffline()} disabled={offline.state === "caching" || offline.state === "ready"} data-testid="editor-offline">
                {offline.state === "ready"
                  ? "✓ 편집기 오프라인 준비됨"
                  : offline.state === "caching"
                    ? `편집기 받는 중 ${offline.total ? Math.floor(((offline.done ?? 0) / offline.total) * 100) : 0}%`
                    : "⬇ 편집기 오프라인으로 받기 (약 20 MB)"}
              </button>
            )}
            {offline.state === "off" && <span className="hint">오프라인 저장은 설치된 앱(서비스 워커)에서만 됩니다</span>}
            {offline.state === "error" && <span className="error">오프라인으로 받지 못했습니다: {offline.error}</span>}
            <button onClick={() => compiler.load()} disabled={comp.phase !== "idle" && comp.phase !== "failed"}>
              컴파일러 미리 받기
            </button>
            {code.base && <button onClick={() => void resetToExample()}>예제 원래 코드로 되돌리기</button>}
            <button onClick={removeCode}>코드 지우기</button>
            {comp.llvm && <span className="hint">{comp.llvm}{comp.loadMs ? ` · 시작 ${(comp.loadMs / 1000).toFixed(1)}초` : ""}</span>}
          </div>
        </details>
      </div>
      {comp.phase === "loading" && !comp.starting && comp.total > 0 && (
        <progress className="code-progress" max={comp.total} value={comp.done} data-testid="compiler-progress" />
      )}
      <div className="code-main">
        <div className="code-editor" ref={host} data-testid="code-editor" />
        <div className="code-problems" data-testid="problems">
          <div className="code-problems-title">
            문제 <span className="dim">{problems.length ? countText(problems.filter((p) => p.severity !== "info").map((p) => ({ severity: p.severity })) as Diagnostic[]) : "없음"}</span>
          </div>
          {notice && <p className="error">{notice}</p>}
          <ul>
            {problems.map((p) => (
              <li key={p.key} className={`problem p-${p.severity}`} data-severity={p.severity} data-line={p.line ?? ""} data-file={p.file ?? ""}>
                <button className="problem-where" onClick={() => goto(p.file, p.line)}>
                  <b>{SEVERITY_LABEL[p.severity]}</b> {p.file ? `${baseName(p.file)}${p.line ? `:${p.line}` : ""}` : ""}
                </button>{" "}
                <span className="problem-source">{p.source}</span> <span className="problem-msg">{p.message}</span>
                {p.why && (
                  <>
                    {" "}
                    <button className="why" onClick={() => setWhy(why === p.key ? null : p.key)} aria-expanded={why === p.key}>
                      왜?
                    </button>
                    {why === p.key && <p className="why-text">{p.why}</p>}
                  </>
                )}
              </li>
            ))}
          </ul>
          {result?.ok && result.diagnostics.length === 0 && <p className="dim">빌드: 경고 없음</p>}
        </div>
      </div>
    </div>
  );
}
