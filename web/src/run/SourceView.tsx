// Source-level debugging: the firmware's C sources with the current line,
// breakpoints in the gutter, stepping, the call stack and variables. Line
// information comes from the ELF's DWARF; the source text from the bundled
// example sources or from files the user adds.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Runner } from "../sim/useRunner";
import type { BreakpointSpec, DebugValue, WatchpointSpec } from "../sim/protocol";
import type { SourceUpload } from "../upload/useSourceUpload";
import { UploadBar } from "../upload/UploadBar";

const base = "./";

/** Path of a DWARF source file under the repository's firmware/ directory. */
function firmwareRel(path: string): string | null {
  const i = path.lastIndexOf("/firmware/");
  return i >= 0 ? path.slice(i + "/firmware/".length) : null;
}

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

let bundled: Promise<Set<string>> | null = null;
function bundledSources(): Promise<Set<string>> {
  bundled ??= fetch(`${base}examples/sources.json`)
    .then((r) => (r.ok ? r.json() : []))
    .then((l: string[]) => new Set(l))
    .catch(() => new Set<string>());
  return bundled;
}

/** The C expression naming a child of the value at `path`. */
const childPath = (path: string, name: string) => (name.startsWith("[") ? `${path}${name}` : `${path}.${name}`);

/** Setting a variable: the expression naming it and the new value. */
type OnEdit = (path: string, value: string) => void;

function ValueTree({
  v,
  path,
  onEdit,
  depth = 0,
}: {
  v: DebugValue;
  /** The expression for this value (null: not settable). */
  path: string | null;
  onEdit?: OnEdit;
  depth?: number;
}) {
  const [editing, setEditing] = useState(false);
  const leaf = !v.children?.length;
  // Numbers, enums and pointers (not a char array shown as a string).
  const canEdit = leaf && !v.type.endsWith("]") && path !== null && onEdit !== undefined;
  // The number in values like "66 'B'" or "0x40014400 <TIM10>".
  const initial = v.value.split(" ")[0];
  const row = (
    <span className="var-row">
      <span className="var-name">{v.name}</span> <span className="var-type">{v.type}</span>{" "}
      {editing ? (
        <input
          className="var-edit"
          aria-label={`${path} 값`}
          autoFocus
          defaultValue={initial}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              onEdit!(path!, e.currentTarget.value);
              setEditing(false);
            } else if (e.key === "Escape") setEditing(false);
          }}
          onBlur={() => setEditing(false)}
        />
      ) : (
        <span
          className={`var-value${canEdit ? " editable" : ""}`}
          data-var={v.name}
          title={canEdit ? "두 번 클릭: 값 바꾸기" : undefined}
          onDoubleClick={canEdit ? () => setEditing(true) : undefined}
        >
          {v.value}
        </span>
      )}
    </span>
  );
  if (leaf) return <li>{row}</li>;
  return (
    <li>
      <details open={depth === 0 && v.children!.length <= 8}>
        <summary>{row}</summary>
        <ul>
          {v.children!.map((c, i) => (
            <ValueTree
              key={i}
              v={c}
              path={path === null ? null : childPath(path, c.name)}
              onEdit={onEdit}
              depth={depth + 1}
            />
          ))}
        </ul>
      </details>
    </li>
  );
}

const TASK_STATE: Record<string, string> = {
  running: "실행 중",
  ready: "준비",
  blocked: "대기",
  suspended: "일시중단",
  deleted: "삭제됨",
};

const KIND_TEXT = { write: "쓰기", read: "읽기", access: "읽기·쓰기" } as const;

/** Why execution paused, for the status line. */
function pauseText(reason: string): string {
  const fixed: Record<string, string> = {
    breakpoint: "중단점",
    done: "스텝",
    pause: "일시정지",
    limit: "스텝이 너무 길어 멈춤",
    trigger: "오실로스코프 트리거",
  };
  if (fixed[reason]) return fixed[reason];
  // "watchpoint write 0x20000010"
  const w = /^watchpoint (write|read) (0x[0-9a-f]+)$/.exec(reason);
  if (w) return `감시점 — ${w[2]}에 ${w[1] === "write" ? "쓰기" : "읽기"}`;
  return reason;
}

export function SourceView({ runner, upload: bundle }: { runner: Runner; upload?: SourceUpload }) {
  const files = runner.debugFiles;
  const attached = bundle?.attached ?? null;
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [uploaded, setUploaded] = useState<Record<string, string>>({});
  const [available, setAvailable] = useState<Set<string>>(new Set());
  const [fileIdx, setFileIdx] = useState<number | null>(null);
  const [frame, setFrame] = useState(0);
  const [showAsm, setShowAsm] = useState(false);
  const [wanted, setWanted] = useState<BreakpointSpec[]>([]);
  const [watches, setWatches] = useState<string[]>([]);
  const [newWatch, setNewWatch] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [watchpoints, setWatchpoints] = useState<WatchpointSpec[]>([]);
  // The RTOS task whose call stack is shown (null: the running code).
  const [task, setTask] = useState<number | null>(null);
  const tasks = runner.frame?.rtos?.snapshot.tasks ?? [];
  const [newWp, setNewWp] = useState<WatchpointSpec>({ expr: "", kind: "write" });
  const codeRef = useRef<HTMLDivElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  const { setBreakpoints, requestDebugState, debugState, pauseEvent: pause, running } = runner;

  useEffect(() => {
    bundledSources().then(setAvailable);
  }, []);

  /** Source text for a file, if we have it. */
  const sourceKey = (path: string): string | null => {
    // M39: a file from an uploaded project folder matched by its DWARF path.
    if (attached?.files[path]) return `a:${attached.id}:${path}`;
    const rel = firmwareRel(path);
    if (rel && available.has(rel)) return `b:${rel}`;
    if (uploaded[baseName(path)] !== undefined) return `u:${baseName(path)}`;
    return null;
  };
  const withSource = files.filter((f) => sourceKey(f.path));

  // A new firmware: open its main.c (or the first file we have), clear
  // breakpoints of the old one.
  useEffect(() => {
    const main = withSource.find((f) => baseName(f.path) === "main.c") ?? withSource[0];
    setFileIdx(main ? main.index : (files[0]?.index ?? null));
    setWanted([]);
    setWatchpoints([]);
    setFrame(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, available, attached]);

  const current = files.find((f) => f.index === fileIdx) ?? null;
  const key = current ? sourceKey(current.path) : null;

  // Fetch the text of the shown file.
  useEffect(() => {
    if (!key || texts[key] !== undefined) return;
    if (key.startsWith("a:")) {
      const f = attached?.files[current!.path];
      if (f) setTexts((t) => ({ ...t, [key]: f.text }));
      return;
    }
    if (key.startsWith("u:")) {
      setTexts((t) => ({ ...t, [key]: uploaded[key.slice(2)] }));
      return;
    }
    fetch(`${base}examples/src/${key.slice(2)}`)
      .then((r) => (r.ok ? r.text() : ""))
      .then((text) => setTexts((t) => ({ ...t, [key]: text })));
  }, [key, texts, uploaded, attached]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setBreakpoints(wanted), [wanted, setBreakpoints]);
  // Watchpoints: the memory each expression names, seen from the shown
  // frame (locals only while stopped where they live).
  const { setWatchpoints: placeWatchpoints } = runner;
  useEffect(() => placeWatchpoints(watchpoints, frame), [watchpoints, placeWatchpoints]); // eslint-disable-line react-hooks/exhaustive-deps
  const setCondition = (b: BreakpointSpec, condition: string) =>
    setWanted((w) => w.map((x) => (x.file === b.file && x.line === b.line ? { ...x, condition } : x)));

  // Paused: fetch where we are and show it.
  useEffect(() => {
    if (pause.n === 0) return;
    setFrame(0);
    setEditError(null);
    // A new stop: back to the code that runs.
    setTask(null);
    runner.selectTask(null);
    requestDebugState(0, fileIdx ?? -1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pause.n]);
  const paused = !running && debugState !== null;
  // Globals follow the file on screen (stepping into another file, or
  // picking one): ask again for the shown frame with this file's globals.
  useEffect(() => {
    if (paused && fileIdx !== null) requestDebugState(frame, fileIdx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileIdx]);
  const shownFrame = debugState?.frames[frame];
  // Setting a variable: show why it failed, or refresh what is shown.
  const { setVariable, assigned } = runner;
  const edit: OnEdit = (path, value) => setVariable(path, value, frame);
  useEffect(() => {
    if (assigned.n === 0) return;
    const r = assigned.result;
    setEditError(r && "error" in r ? `${assigned.target}: ${r.error}` : null);
    if (fileIdx !== null) requestDebugState(frame, fileIdx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assigned.n]);
  // Watch expressions are evaluated in the shown frame whenever it changes.
  const { requestWatch } = runner;
  useEffect(() => {
    if (paused && watches.length) requestWatch(watches, frame);
  }, [paused, debugState, frame, watches, requestWatch]);
  // Machine code around the shown frame's pc.
  const { requestDisasm } = runner;
  useEffect(() => {
    if (showAsm && paused && shownFrame) requestDisasm(shownFrame.pc);
  }, [showAsm, paused, shownFrame, requestDisasm]);
  useEffect(() => {
    const f = debugState?.frames[frame];
    if (f?.file != null && files.some((x) => x.index === f.file)) setFileIdx(f.file);
  }, [debugState, frame, files]);
  // Keep the current line in view.
  const here = paused && shownFrame?.file === fileIdx ? shownFrame?.line : null;
  useEffect(() => {
    if (here) codeRef.current?.querySelector(`[data-line="${here}"]`)?.scrollIntoView({ block: "center" });
  }, [here, key, texts]);

  const codeLines = useMemo(() => new Set(current?.lines ?? []), [current]);
  const placed = new Set(runner.breakpoints.filter((b) => b.file === fileIdx).map((b) => b.line));
  const conditional = new Set(wanted.filter((b) => b.file === fileIdx && b.condition?.trim()).map((b) => b.line));
  const lines = key && texts[key] !== undefined ? texts[key].split("\n") : null;

  const toggle = (line: number) => {
    if (fileIdx === null || !codeLines.has(line)) return;
    setWanted((w) =>
      w.some((b) => b.file === fileIdx && b.line === line)
        ? w.filter((b) => !(b.file === fileIdx && b.line === line))
        : [...w, { file: fileIdx, line }],
    );
  };

  const bar = bundle && <UploadBar upload={bundle} files={files} />;
  if (!runner.firmware)
    return (
      <div className="source-empty">
        {bar}
        <p className="hint">
          펌웨어를 불러오면 소스가 보입니다. STM32CubeIDE 프로젝트 폴더나 그 zip을 올리면 ELF와 소스를 한꺼번에 불러옵니다(앱 어디에나 끌어다 놓아도 됩니다).
        </p>
      </div>
    );
  if (files.length === 0)
    return (
      <div className="source-empty">
        {bar}
        <p className="hint">이 펌웨어에는 디버그 정보(DWARF)가 없습니다. <code>-g</code>로 빌드하세요.</p>
      </div>
    );

  /** The name shown for a DWARF file: the uploaded path, the example path, or the build path. */
  const label = (path: string) => attached?.files[path]?.from ?? firmwareRel(path) ?? path;

  return (
    <div className="source-view">
      <div className="source-main">
        {bar}
        <div className="source-bar">
          <select aria-label="소스 파일" value={fileIdx ?? ""} onChange={(e) => setFileIdx(Number(e.target.value))}>
            {[...withSource, ...files.filter((f) => !sourceKey(f.path))].map((f) => (
              <option key={f.index} value={f.index}>
                {label(f.path)}
                {sourceKey(f.path) ? "" : " (소스 없음)"}
              </option>
            ))}
          </select>
          <button onClick={() => runner.run()} disabled={running} title="다음 중단점까지 실행">
            ▶ 계속
          </button>
          <button onClick={() => runner.step("over")} disabled={running} title="다음 줄로 (함수 호출은 끝까지 실행)">
            ⤼ 한 줄
          </button>
          <button onClick={() => runner.step("into")} disabled={running} title="다음 줄로 (함수 안으로)">
            ↘ 들어가기
          </button>
          <button onClick={() => runner.step("out")} disabled={running} title="이 함수가 끝날 때까지">
            ↗ 나오기
          </button>
          <button onClick={() => runner.step("instruction")} disabled={running} title="기계어 명령 하나">
            명령 1개
          </button>
          <label className="asm-toggle">
            <input type="checkbox" checked={showAsm} onChange={(e) => setShowAsm(e.target.checked)} /> 기계어
          </label>
          <button onClick={() => upload.current?.click()}>소스 추가…</button>
          <input
            ref={upload}
            type="file"
            multiple
            hidden
            accept=".c,.h,.s,.cpp"
            data-testid="source-input"
            onChange={async (e) => {
              const add: Record<string, string> = {};
              for (const f of Array.from(e.target.files ?? [])) add[f.name] = await f.text();
              e.target.value = "";
              setUploaded((u) => ({ ...u, ...add }));
            }}
          />
          <span className="hint" data-testid="debug-status">
            {running ? "실행 중 — 중단점에서 멈춥니다" : paused ? `멈춤: ${pauseText(pause.reason)}` : ""}
          </span>
        </div>
        <div className="source-code" ref={codeRef}>
          {lines ? (
            lines.map((text, i) => {
              const n = i + 1;
              const code = codeLines.has(n);
              return (
                <div
                  key={n}
                  data-line={n}
                  className={`src-line${here === n ? " here" : ""}${code ? " code" : ""}`}
                >
                  <span
                    className={`gutter${placed.has(n) ? " bp" : ""}${conditional.has(n) ? " cond" : ""}`}
                    onClick={() => toggle(n)}
                    data-testid={`gutter-${n}`}
                    title={code ? "클릭: 중단점" : ""}
                  >
                    {n}
                  </span>
                  <span className="src-text">{text || " "}</span>
                </div>
              );
            })
          ) : (
            <p className="hint">
              {current ? `${current.path}의 소스가 없습니다. ‘소스 추가…’로 파일을 넣거나 ‘📁 프로젝트 폴더·zip 올리기’로 프로젝트를 올리면 보입니다.` : ""}
            </p>
          )}
        </div>
        {showAsm && (
          <div className="asm-view" data-testid="disassembly">
            {paused ? (
              runner.disasm.map((r, i) => {
                const prev = runner.disasm[i - 1];
                const newLine = r.line !== null && (!prev || prev.line !== r.line || prev.file !== r.file);
                const src = r.file !== null ? files.find((f) => f.index === r.file) : undefined;
                return (
                  <div key={r.addr}>
                    {newLine && (
                      <div className="asm-src">
                        {src ? baseName(src.path) : "?"}:{r.line}
                        {r.file === fileIdx && lines?.[r.line! - 1] ? `  ${lines[r.line! - 1].trim()}` : ""}
                      </div>
                    )}
                    <div className={`asm-row${r.addr === shownFrame?.pc ? " here" : ""}`} data-addr={r.addr}>
                      <span className="asm-addr">{r.addr.toString(16).padStart(8, "0")}</span>
                      <span className="asm-bytes">{r.bytes}</span>
                      <span className="asm-text">{r.text}</span>
                    </div>
                  </div>
                );
              })
            ) : (
              <p className="hint">멈추면 현재 위치의 기계어가 보입니다.</p>
            )}
          </div>
        )}
      </div>
      <aside className="debug-side">
        <h4>감시식</h4>
        <form
          className="watch-add"
          onSubmit={(e) => {
            e.preventDefault();
            const x = newWatch.trim();
            if (x && !watches.includes(x)) setWatches((w) => [...w, x]);
            setNewWatch("");
          }}
        >
          <input
            aria-label="감시식"
            placeholder="예: count * 2, buf[i], htim2.Instance->CNT"
            value={newWatch}
            onChange={(e) => setNewWatch(e.target.value)}
          />
          <button type="submit">추가</button>
        </form>
        <ul className="vars watches" data-testid="watches">
          {watches.map((x, i) => {
            const v = paused ? runner.watch[i] : undefined;
            return (
              <li key={x} className="watch">
                <button
                  className="watch-del"
                  title="감시식 지우기"
                  onClick={() => setWatches((w) => w.filter((y) => y !== x))}
                >
                  ×
                </button>
                {v && "error" in v ? (
                  <span className="var-row">
                    <span className="var-name">{x}</span>{" "}
                    <span className="watch-error" data-watch={x}>
                      {v.error}
                    </span>
                  </span>
                ) : v ? (
                  <ul className="vars" data-watch={x}>
                    <ValueTree v={v} path={`(${x})`} onEdit={edit} />
                  </ul>
                ) : (
                  <span className="var-name">{x}</span>
                )}
              </li>
            );
          })}
        </ul>
        <h4>감시점 (메모리 접근)</h4>
        <form
          className="watch-add"
          onSubmit={(e) => {
            e.preventDefault();
            const expr = newWp.expr.trim();
            if (expr && !watchpoints.some((w) => w.expr === expr && w.kind === newWp.kind))
              setWatchpoints((l) => [...l, { expr, kind: newWp.kind }]);
            setNewWp((w) => ({ ...w, expr: "" }));
          }}
        >
          <input
            aria-label="감시점 식"
            placeholder="예: current, buf[3], htim2.Instance->CNT"
            value={newWp.expr}
            onChange={(e) => setNewWp((w) => ({ ...w, expr: e.target.value }))}
          />
          <select
            aria-label="감시점 종류"
            value={newWp.kind}
            onChange={(e) => setNewWp((w) => ({ ...w, kind: e.target.value as WatchpointSpec["kind"] }))}
          >
            <option value="write">쓰기</option>
            <option value="read">읽기</option>
            <option value="access">읽기·쓰기</option>
          </select>
          <button type="submit">추가</button>
        </form>
        <ul className="bp-list" data-testid="watchpoints">
          {watchpoints.map((w, i) => {
            const p = runner.watchpoints[i];
            return (
              <li key={`${w.expr}:${w.kind}`}>
                <button
                  className="watch-del"
                  title="감시점 지우기"
                  onClick={() => setWatchpoints((l) => l.filter((x) => x !== w))}
                >
                  ×
                </button>
                <span className="bp-at">{w.expr}</span>
                <span className="var-type">{KIND_TEXT[w.kind]}</span>
                {p && "error" in p ? (
                  <span className="watch-error">{p.error}</span>
                ) : p ? (
                  <span className="var-type">
                    0x{p.addr.toString(16).padStart(8, "0")} · {p.len}바이트
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
        <h4>중단점</h4>
        <ul className="bp-list" data-testid="breakpoints">
          {wanted.map((b) => {
            const f = files.find((x) => x.index === b.file);
            const at = `${f ? baseName(f.path) : "?"}:${b.line}`;
            return (
              <li key={`${b.file}:${b.line}`}>
                <button className="watch-del" title="중단점 지우기" onClick={() => setWanted((w) => w.filter((x) => x !== b))}>
                  ×
                </button>
                <span className="bp-at" onClick={() => setFileIdx(b.file)}>
                  {at}
                </span>
                <input
                  aria-label={`${at} 조건`}
                  placeholder="조건 (예: i == 3)"
                  defaultValue={b.condition ?? ""}
                  onBlur={(e) => setCondition(b, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setCondition(b, e.currentTarget.value);
                  }}
                />
              </li>
            );
          })}
        </ul>
        {wanted.length === 0 && <p className="hint">줄 번호를 클릭하면 중단점이 생깁니다. 조건을 적으면 그 식이 참일 때만 멈춥니다.</p>}
        {editError && paused && (
          <p className="edit-error" data-testid="edit-error">
            {editError}
          </p>
        )}
        <h4>호출 스택</h4>
        {paused && tasks.length > 0 && (
          <select
            aria-label="태스크"
            className="task-select"
            value={task ?? ""}
            onChange={(e) => {
              const tcb = e.target.value === "" ? null : Number(e.target.value);
              setTask(tcb);
              runner.selectTask(tcb);
              setFrame(0);
              requestDebugState(0, fileIdx ?? -1);
            }}
          >
            <option value="">실행 중인 코드</option>
            {tasks.map((t) => (
              <option key={t.tcb} value={t.tcb}>
                {t.name} ({TASK_STATE[t.state] ?? t.state})
              </option>
            ))}
          </select>
        )}
        <ol className="frames">
          {(paused ? debugState!.frames : []).map((f, i) => (
            <li
              key={i}
              className={i === frame ? "on" : ""}
              onClick={() => {
                setFrame(i);
                requestDebugState(i, f.file ?? fileIdx ?? -1);
              }}
            >
              {f.exception && <span className="exc">⚡</span>}
              {f.function ?? `0x${f.pc.toString(16)}`}
              {f.line ? <span className="hint"> :{f.line}</span> : null}
            </li>
          ))}
        </ol>
        <h4>지역 변수</h4>
        <ul className="vars" data-testid="locals">
          {(paused ? (debugState!.locals ?? []) : []).map((v, i) => (
            <ValueTree key={i} v={v} path={v.name} onEdit={edit} />
          ))}
        </ul>
        <h4>전역 변수 (이 파일)</h4>
        <ul className="vars" data-testid="globals">
          {(paused ? (debugState!.globals ?? []) : []).map((v, i) => (
            <ValueTree key={i} v={v} path={v.name} onEdit={edit} />
          ))}
        </ul>
        {!paused && <p className="hint">중단점을 걸고 실행하거나 일시정지 후 스텝하면 변수가 보입니다.</p>}
      </aside>
    </div>
  );
}
