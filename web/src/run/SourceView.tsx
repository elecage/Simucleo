// Source-level debugging: the firmware's C sources with the current line,
// breakpoints in the gutter, stepping, the call stack and variables. Line
// information comes from the ELF's DWARF; the source text from the bundled
// example sources or from files the user adds.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Runner } from "../sim/useRunner";
import type { DebugValue } from "../sim/protocol";

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

function ValueTree({ v, depth = 0 }: { v: DebugValue; depth?: number }) {
  const row = (
    <span className="var-row">
      <span className="var-name">{v.name}</span> <span className="var-type">{v.type}</span>{" "}
      <span className="var-value" data-var={v.name}>
        {v.value}
      </span>
    </span>
  );
  if (!v.children?.length) return <li>{row}</li>;
  return (
    <li>
      <details open={depth === 0 && v.children.length <= 8}>
        <summary>{row}</summary>
        <ul>
          {v.children.map((c, i) => (
            <ValueTree key={i} v={c} depth={depth + 1} />
          ))}
        </ul>
      </details>
    </li>
  );
}

export function SourceView({ runner }: { runner: Runner }) {
  const files = runner.debugFiles;
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [uploaded, setUploaded] = useState<Record<string, string>>({});
  const [available, setAvailable] = useState<Set<string>>(new Set());
  const [fileIdx, setFileIdx] = useState<number | null>(null);
  const [frame, setFrame] = useState(0);
  const [wanted, setWanted] = useState<{ file: number; line: number }[]>([]);
  const codeRef = useRef<HTMLDivElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  const { setBreakpoints, requestDebugState, debugState, pauseEvent: pause, running } = runner;

  useEffect(() => {
    bundledSources().then(setAvailable);
  }, []);

  /** Source text for a file, if we have it. */
  const sourceKey = (path: string): string | null => {
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
    setFrame(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, available]);

  const current = files.find((f) => f.index === fileIdx) ?? null;
  const key = current ? sourceKey(current.path) : null;

  // Fetch the text of the shown file.
  useEffect(() => {
    if (!key || texts[key] !== undefined) return;
    if (key.startsWith("u:")) {
      setTexts((t) => ({ ...t, [key]: uploaded[key.slice(2)] }));
      return;
    }
    fetch(`${base}examples/src/${key.slice(2)}`)
      .then((r) => (r.ok ? r.text() : ""))
      .then((text) => setTexts((t) => ({ ...t, [key]: text })));
  }, [key, texts, uploaded]);

  useEffect(() => setBreakpoints(wanted), [wanted, setBreakpoints]);

  // Paused: fetch where we are and show it.
  useEffect(() => {
    if (pause.n === 0) return;
    setFrame(0);
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
  const lines = key && texts[key] !== undefined ? texts[key].split("\n") : null;

  const toggle = (line: number) => {
    if (fileIdx === null || !codeLines.has(line)) return;
    setWanted((w) =>
      w.some((b) => b.file === fileIdx && b.line === line)
        ? w.filter((b) => !(b.file === fileIdx && b.line === line))
        : [...w, { file: fileIdx, line }],
    );
  };

  if (!runner.firmware) return <p className="hint">펌웨어를 불러오면 소스가 보입니다.</p>;
  if (files.length === 0)
    return <p className="hint">이 펌웨어에는 디버그 정보(DWARF)가 없습니다. <code>-g</code>로 빌드하세요.</p>;

  return (
    <div className="source-view">
      <div className="source-main">
        <div className="source-bar">
          <select aria-label="소스 파일" value={fileIdx ?? ""} onChange={(e) => setFileIdx(Number(e.target.value))}>
            {[...withSource, ...files.filter((f) => !sourceKey(f.path))].map((f) => (
              <option key={f.index} value={f.index}>
                {firmwareRel(f.path) ?? f.path}
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
            {running ? "실행 중 — 중단점에서 멈춥니다" : paused ? `멈춤: ${({ breakpoint: "중단점", done: "스텝", pause: "일시정지", limit: "스텝이 너무 길어 멈춤" } as Record<string, string>)[pause.reason] ?? pause.reason}` : ""}
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
                    className={`gutter${placed.has(n) ? " bp" : ""}`}
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
              {current ? `${current.path}의 소스가 없습니다. ‘소스 추가…’로 파일을 넣으면 보입니다.` : ""}
            </p>
          )}
        </div>
      </div>
      <aside className="debug-side">
        <h4>호출 스택</h4>
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
            <ValueTree key={i} v={v} />
          ))}
        </ul>
        <h4>전역 변수 (이 파일)</h4>
        <ul className="vars" data-testid="globals">
          {(paused ? (debugState!.globals ?? []) : []).map((v, i) => (
            <ValueTree key={i} v={v} />
          ))}
        </ul>
        {!paused && <p className="hint">중단점을 걸고 실행하거나 일시정지 후 스텝하면 변수가 보입니다.</p>}
      </aside>
    </div>
  );
}
