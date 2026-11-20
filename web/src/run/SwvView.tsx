// The SWV tab: STM32CubeIDE's Serial Wire Viewer views — the ITM data
// console, a data trace graph of up to four variables, the statistical
// profile from PC sampling and the exception trace (statistics and a
// timeline) — while the program runs, without stopping it.
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n";
import type { Runner } from "../sim/useRunner";
import {
  addFrame,
  DEFAULT_SETTINGS,
  emptyState,
  profileRows,
  samplePeriod,
  typedValue,
  type DataMode,
  type DataPlaced,
  type SwvSettings,
  type SwvState,
} from "./swv";

type View = "itm" | "data" | "profile" | "exceptions";

const SAMPLING: [string, [number, boolean] | null][] = [
  ["off", null],
  ["1024", [0, true]],
  ["4096", [3, true]],
  ["16384", [15, true]],
];

const COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea"];

const ms = (ns: number) => ns / 1e6;
const fmtUs = (ns: number) => (ns >= 1e6 ? `${(ns / 1e6).toFixed(2)} ms` : `${(ns / 1e3).toFixed(1)} µs`);

/** The trace the frames bring, kept while the tab is hidden; cleared for new firmware. */
export function useSwvState(runner: Runner, on: boolean): [SwvState, () => void] {
  const [state, setState] = useState<SwvState>(emptyState);
  const { onFrame, firmware } = runner;
  useEffect(() => setState(emptyState()), [firmware]);
  useEffect(() => {
    if (!on) return;
    return onFrame((m) => {
      if (m.swv) setState((s) => addFrame(s, m.swv!, m.frame.timeMs * 1e6));
    });
  }, [onFrame, on]);
  return [state, () => setState(emptyState())];
}

export function SwvView({ runner, on, setOn, settings, setSettings, state, clear }: {
  runner: Runner;
  on: boolean;
  setOn: (on: boolean) => void;
  settings: SwvSettings;
  setSettings: (s: SwvSettings) => void;
  state: SwvState;
  clear: () => void;
}) {
  const [view, setView] = useState<View>("itm");
  const ports = [0, 1, 2, 3];
  const sampling = SAMPLING.find(([, v]) => JSON.stringify(v) === JSON.stringify(settings.pcSampling))?.[0] ?? "16384";
  return (
    <div className="swv" data-testid="swv">
      <div className="swv-bar">
        <label>
          <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} data-testid="swv-on" />{" "}
          {t("SWV 추적 켜기")}
        </label>
        <span className="swv-ports" title={t("ITM 자극 포트: 펌웨어가 이 포트에 쓴 값만 지나갑니다 (ITM_TER)")}>
          {t("ITM 포트")}
          {ports.map((p) => (
            <label key={p}>
              <input
                type="checkbox"
                checked={(settings.ports & (1 << p)) !== 0}
                onChange={(e) => setSettings({ ...settings, ports: e.target.checked ? settings.ports | (1 << p) : settings.ports & ~(1 << p) })}
              />
              {p}
            </label>
          ))}
        </span>
        <label title={t("DWT가 이만큼의 사이클마다 PC를 하나 샘플링합니다 (통계 프로파일)")}>
          {t("PC 샘플링")}{" "}
          <select
            value={sampling}
            onChange={(e) => setSettings({ ...settings, pcSampling: SAMPLING.find(([k]) => k === e.target.value)?.[1] ?? null })}
            aria-label={t("PC 샘플링")}
          >
            {SAMPLING.map(([k]) => (
              <option key={k} value={k}>
                {k === "off" ? t("끄기") : t("{n} 사이클마다", { n: k })}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input type="checkbox" checked={settings.exceptions} onChange={(e) => setSettings({ ...settings, exceptions: e.target.checked })} />{" "}
          {t("예외 추적")}
        </label>
        <button onClick={clear}>{t("지우기")}</button>
        {state.dropped > 0 && <span className="error">{t("놓친 패킷 {n}개", { n: state.dropped })}</span>}
      </div>
      {!on && <p className="hint">{t("SWV는 프로그램을 멈추지 않고 SWO 핀으로 정보를 내보냅니다. 켜면 디버거처럼 DEMCR.TRCENA, ITM, DWT를 설정합니다. 펌웨어는 ITM_SendChar()로 포트 0에 글자를 보냅니다.")}</p>}
      <nav className="swv-views">
        {(
          [
            ["itm", t("ITM 콘솔")],
            ["data", t("데이터 그래프")],
            ["profile", t("통계 프로파일")],
            ["exceptions", t("예외 추적")],
          ] as [View, string][]
        ).map(([id, label]) => (
          <button key={id} className={view === id ? "tab on" : "tab"} onClick={() => setView(id)}>
            {label}
          </button>
        ))}
      </nav>
      {view === "itm" && <ItmConsole state={state} />}
      {view === "data" && <DataGraph runner={runner} settings={settings} setSettings={setSettings} state={state} />}
      {view === "profile" && <Profile state={state} settings={settings} />}
      {view === "exceptions" && <Exceptions state={state} enabled={settings.exceptions} />}
    </div>
  );
}

function ItmConsole({ state }: { state: SwvState }) {
  const ports = [...new Set([...state.text.keys(), ...state.words.keys()])].sort((a, b) => a - b);
  const [port, setPort] = useState(0);
  const shown = ports.includes(port) ? port : (ports[0] ?? 0);
  const pre = useRef<HTMLPreElement>(null);
  const text = state.text.get(shown) ?? "";
  const words = state.words.get(shown) ?? [];
  useEffect(() => {
    if (pre.current) pre.current.scrollTop = pre.current.scrollHeight;
  }, [text, words.length]);
  return (
    <div className="swv-itm">
      <div className="swv-sub">
        {ports.length === 0 && <span className="hint">{t("아직 ITM 출력이 없습니다.")}</span>}
        {ports.map((p) => (
          <button key={p} className={p === shown ? "tab on" : "tab"} onClick={() => setPort(p)}>
            {t("포트 {p}", { p })}
          </button>
        ))}
      </div>
      <pre ref={pre} className="console-out swv-text" data-testid="swv-itm">
        {text}
        {words.map(([tNs, v]) => `${ms(tNs).toFixed(3)} ms  ${v >>> 0} (0x${(v >>> 0).toString(16).toUpperCase().padStart(8, "0")})\n`).join("")}
      </pre>
    </div>
  );
}

const WINDOWS = [0.1, 1, 10];

function DataGraph({ runner, settings, setSettings, state }: {
  runner: Runner;
  settings: SwvSettings;
  setSettings: (s: SwvSettings) => void;
  state: SwvState;
}) {
  const [draft, setDraft] = useState(() => settings.data.map((d) => ({ ...d })));
  const [windowS, setWindowS] = useState(1);
  useEffect(() => setDraft(settings.data.map((d) => ({ ...d }))), [settings.data]);
  const rows = [...draft, ...Array.from({ length: 4 - draft.length }, () => ({ expr: "", mode: "write" as DataMode }))].slice(0, 4);
  const apply = () => setSettings({ ...settings, data: rows.filter((r) => r.expr.trim()).map((r) => ({ expr: r.expr.trim(), mode: r.mode })) });
  const placed = runner.swvPlaced;
  // The placed entries are in the order of the non-empty expressions.
  const traced = settings.data.map((d, i) => ({ ...d, placed: placed[i] as DataPlaced | undefined }));
  const end = state.lastNs;
  const start = end - windowS * 1e9;
  const lines = traced.map((d, i) => {
    const p = d.placed && "addr" in d.placed ? d.placed : null;
    const series = p ? (state.series.get(p.addr) ?? []) : [];
    const pts = series.filter(([tNs]) => tNs >= start).map(([tNs, v]) => [tNs, typedValue(v, p!.len, p!.type)] as [number, number]);
    const last = series.length ? typedValue(series[series.length - 1][1], p!.len, p!.type) : null;
    return { d, i, p, pts, last, count: series.length };
  });
  // Each variable on its own scale (its minimum at the bottom, maximum at
  // the top), as variables of very different sizes share the graph.
  const scales = lines.map((l) => {
    const vs = l.pts.map(([, v]) => v);
    const lo = vs.length ? Math.min(...vs) : 0;
    const hi = vs.length ? Math.max(...vs) : 1;
    return { lo, hi };
  });
  const any = lines.some((l) => l.pts.length);
  const W = 600;
  const H = 160;
  const x = (tNs: number) => ((tNs - start) / (windowS * 1e9)) * W;
  const yOf = (i: number) => (v: number) => {
    const { lo, hi } = scales[i];
    return H - 8 - ((v - lo) / (hi - lo || 1)) * (H - 16);
  };
  return (
    <div className="swv-data">
      <div className="swv-vars">
        {rows.map((r, i) => {
          const d = traced[i];
          const status = d?.placed ? ("error" in d.placed ? d.placed.error : `@0x${d.placed.addr.toString(16).toUpperCase()} · ${d.placed.len} B${d.placed.type ? ` · ${d.placed.type}` : ""}`) : "";
          return (
            <div key={i} className="swv-var">
              <span className="swatch" style={{ background: COLORS[i] }} />
              <input
                value={r.expr}
                placeholder={t("변수 (예: wave, counter, buf[2])")}
                aria-label={t("추적할 변수 {n}", { n: i + 1 })}
                onChange={(e) => setDraft(rows.map((x, j) => (j === i ? { ...x, expr: e.target.value } : x)))}
                onKeyDown={(e) => e.key === "Enter" && apply()}
              />
              <select
                value={r.mode}
                aria-label={t("추적 방식 {n}", { n: i + 1 })}
                onChange={(e) => setDraft(rows.map((x, j) => (j === i ? { ...x, mode: e.target.value as DataMode } : x)))}
              >
                <option value="write">{t("쓰기")}</option>
                <option value="read">{t("읽기")}</option>
                <option value="rw">{t("읽기·쓰기")}</option>
              </select>
              <span className={d?.placed && "error" in d.placed ? "error" : "dim"}>{status}</span>
              {lines[i] && lines[i].last !== null && (
                <span data-testid={`swv-series-${i}`} data-count={lines[i].count}>
                  = {lines[i].last}
                </span>
              )}
            </div>
          );
        })}
        <button onClick={apply}>{t("추적 적용")}</button>
        <label>
          {t("시간 폭")}{" "}
          <select value={windowS} onChange={(e) => setWindowS(Number(e.target.value))} aria-label={t("시간 폭")}>
            {WINDOWS.map((w) => (
              <option key={w} value={w}>
                {w} s
              </option>
            ))}
          </select>
        </label>
      </div>
      <svg className="swv-graph" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" data-testid="swv-graph">
        <line x1={0} x2={W} y1={H / 2} y2={H / 2} className="axis" />
        {lines.map(({ i, pts }) => {
          const y = yOf(i);
          return pts.length ? (
            <polyline
              key={i}
              fill="none"
              stroke={COLORS[i]}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
              // A step plot: the value holds until the next access.
              points={pts.map(([tNs, v], k) => `${k ? `${x(tNs)},${y(pts[k - 1][1])} ` : ""}${x(tNs)},${y(v)}`).join(" ") + ` ${W},${y(pts[pts.length - 1][1])}`}
            />
          ) : null;
        })}
      </svg>
      <div className="swv-axis dim">
        <span>
          {any
            ? lines
                .filter((l) => l.pts.length)
                .map((l) => (
                  <span key={l.i} style={{ color: COLORS[l.i], marginRight: 12 }}>
                    {l.d.expr}: {t("최소")} {scales[l.i].lo} · {t("최대")} {scales[l.i].hi}
                  </span>
                ))
            : t("추적한 값이 아직 없습니다.")}
        </span>
        <span>{t("최근 {w} s (시뮬레이션 시간)", { w: windowS })}</span>
      </div>
    </div>
  );
}

function Profile({ state, settings }: { state: SwvState; settings: SwvSettings }) {
  const rows = useMemo(() => profileRows(state), [state.profile, state.sleepSamples]); // eslint-disable-line react-hooks/exhaustive-deps
  const total = rows.reduce((a, r) => a + r.samples, 0) + state.sleepSamples;
  if (!settings.pcSampling) return <p className="hint">{t("PC 샘플링이 꺼져 있습니다.")}</p>;
  return (
    <div className="swv-profile">
      <p className="dim">
        {t("{n}개 샘플 ({cycles} 사이클마다 PC 하나)", { n: total, cycles: samplePeriod(settings.pcSampling) })}
      </p>
      <table data-testid="swv-profile">
        <thead>
          <tr>
            <th>{t("함수")}</th>
            <th>{t("샘플")}</th>
            <th>%</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 30).map((r) => (
            <tr key={r.function}>
              <td>{r.function}</td>
              <td>{r.samples}</td>
              <td>{(r.share * 100).toFixed(1)}</td>
              <td className="bar-cell">
                <span className="bar" style={{ width: `${r.share * 100}%` }} />
              </td>
            </tr>
          ))}
          {state.sleepSamples > 0 && (
            <tr className="dim">
              <td>{t("(잠자기: WFI/WFE)")}</td>
              <td>{state.sleepSamples}</td>
              <td>{((state.sleepSamples / total) * 100).toFixed(1)}</td>
              <td className="bar-cell">
                <span className="bar sleep" style={{ width: `${(state.sleepSamples / total) * 100}%` }} />
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const TIMELINE_NS = 20e6;

function Exceptions({ state, enabled }: { state: SwvState; enabled: boolean }) {
  if (!enabled) return <p className="hint">{t("예외 추적이 꺼져 있습니다.")}</p>;
  const stats = [...state.exc.values()].sort((a, b) => a.number - b.number);
  const end = state.lastNs;
  const start = end - TIMELINE_NS;
  // Bars: enter → exit (or the end) per exception in the last 20 ms.
  const rows = stats.map((s) => s.number);
  const bars: { n: number; from: number; to: number }[] = [];
  const open = new Map<number, number>();
  for (const e of state.events) {
    if (e.kind === "enter") open.set(e.number, e.t);
    else if (e.kind === "exit" && open.has(e.number)) {
      const from = open.get(e.number)!;
      open.delete(e.number);
      if (e.t >= start) bars.push({ n: e.number, from, to: e.t });
    }
  }
  for (const [n, from] of open) bars.push({ n, from, to: end });
  const W = 600;
  const rowH = 14;
  const x = (tNs: number) => Math.max(0, ((tNs - start) / TIMELINE_NS) * W);
  return (
    <div className="swv-exc">
      <table data-testid="swv-exc">
        <thead>
          <tr>
            <th>{t("예외")}</th>
            <th>{t("횟수")}</th>
            <th>{t("초당")}</th>
            <th>{t("평균 시간")}</th>
            <th>{t("최대 시간")}</th>
            <th>{t("CPU 점유")}</th>
          </tr>
        </thead>
        <tbody>
          {stats.map((s) => {
            const span = Math.max(end - s.firstNs, 1);
            return (
              <tr key={s.number} data-exc={s.name}>
                <td>
                  {s.name} <span className="dim">({s.number})</span>
                </td>
                <td>{s.count}</td>
                <td>{s.count > 1 ? ((s.count / span) * 1e9).toFixed(0) : "–"}</td>
                <td>{s.count ? fmtUs(s.totalNs / s.count) : "–"}</td>
                <td>{fmtUs(s.maxNs)}</td>
                <td>{((s.totalNs / span) * 100).toFixed(2)} %</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {stats.length === 0 && <p className="hint">{t("아직 예외가 없습니다.")}</p>}
      {stats.length > 0 && (
        <>
          <svg className="swv-timeline" viewBox={`0 0 ${W} ${rows.length * rowH + 2}`} preserveAspectRatio="none">
            {rows.map((n, r) => (
              <line key={n} x1={0} x2={W} y1={r * rowH + rowH / 2} y2={r * rowH + rowH / 2} className="axis" />
            ))}
            {bars.map((b, k) => {
              const r = rows.indexOf(b.n);
              return <rect key={k} x={x(b.from)} y={r * rowH + 2} width={Math.max(1, x(b.to) - x(b.from))} height={rowH - 4} className="exc-bar" />;
            })}
          </svg>
          <p className="dim">{t("최근 20 ms: 줄마다 위 표의 예외 하나, 막대는 처리 루틴이 돈 구간")}</p>
        </>
      )}
    </div>
  );
}

export { DEFAULT_SETTINGS };
