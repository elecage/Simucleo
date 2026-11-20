// The configuration tool's window (M36), "⚙ 설정(.ioc)": pinout (LQFP64
// package and a list), clock tree, peripheral forms and a code generation
// preview, like STM32CubeMX's. It floats over the canvas (position: fixed),
// so the toolbar and the circuit never move. It edits a draft of the
// configuration; "코드 생성" writes the files into the code tab's project,
// keeping the USER CODE regions.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CodeProject } from "../code/project.ts";
import { AHB_DIVS, APB_DIVS, computeClock, HSE_HZ, HSI_HZ, PLLP_VALUES, type ClockConfig, type ClockIssue } from "./clock.ts";
import {
  assignPin,
  clone,
  disablePeripheralWithPins,
  enablePeripheralWithPins,
  hasErrors,
  I2CS,
  labelMacro,
  nucleoDefaults,
  peripherals,
  pwmInfo,
  SPIS,
  timChannels,
  TIMS,
  USARTS,
  usedIrqs,
  validate,
  type CubeConfig,
  type Issue,
  type PinConfig,
  type TimName,
} from "./config.ts";
import { adcPin, boardNames, IO_PINS, ONBOARD, PACKAGE_PINS, peripheralOf, pinsFor, signalChoices, type PackagePin } from "./mcu.ts";
import { exportIoc, parseIoc } from "./ioc.ts";
import { DEFAULT_PACK, PACKS } from "./packs.ts";
import { applyRegeneration, newCubeProject, planRegeneration, projectConfig, type FileChange } from "./tree.ts";
import { diffLines, diffStats, foldDiff } from "./diff.ts";
import { wiringCheck, type WiredPins } from "./wiring.ts";
import { download } from "../editor/project.ts";
import "./cube.css";

export interface ConfigPanelProps {
  /** The project's code: a configuration-tool project is edited, anything else replaced. */
  code: CodeProject | undefined;
  /** Start from these settings (a new project) instead of the project's .ioc. */
  start?: CubeConfig;
  onApply: (p: CodeProject) => void;
  onClose: () => void;
  /** MCU pin → parts wired to it on the canvas (배선 대조). */
  wired?: WiredPins;
  /** Messages to show first (what an import left out). */
  notes?: string[];
}

type Tab = "pins" | "clock" | "peripherals" | "code";

const mhz = (hz: number) => `${+(hz / 1e6).toFixed(3)} MHz`;

export default function ConfigPanel({ code, start, onApply, onClose, wired, notes: notes0 = [] }: ConfigPanelProps) {
  const isCube = code?.template === "cube";
  const initial = useMemo(() => {
    if (start) return { config: clone(start), warnings: [] as string[] };
    if (isCube) return projectConfig(code!);
    return { config: nucleoDefaults(), warnings: [] as string[] };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [cfg, setCfg] = useState<CubeConfig>(() => ({ ...initial.config, drivers: initial.config.drivers || DEFAULT_PACK.id }));
  const [saved, setSaved] = useState(() => JSON.stringify(cfg));
  const [notes, setNotes] = useState<string[]>([...notes0, ...initial.warnings]);
  const [tab, setTab] = useState<Tab>("pins");
  const [done, setDone] = useState<string | null>(null);
  const tree = useMemo(() => computeClock(cfg.clock), [cfg.clock]);
  const issues = useMemo(() => validate(cfg, tree), [cfg, tree]);
  const wiring = useMemo(() => (wired ? wiringCheck(cfg, wired) : []), [cfg, wired]);
  const errors = issues.filter((i) => i.severity === "error").length;
  const warns = issues.length - errors;
  const dirty = JSON.stringify(cfg) !== saved || !isCube;
  const iocInput = useRef<HTMLInputElement>(null);

  const update = (f: (c: CubeConfig) => CubeConfig | void) =>
    setCfg((c0) => {
      const c = clone(c0);
      return f(c) ?? c;
    });

  const close = () => {
    if (isCube && JSON.stringify(cfg) !== saved && !window.confirm("코드를 생성하지 않은 설정 변경이 있습니다. 버리고 닫을까요?")) return;
    onClose();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLInputElement)) close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const generateNow = () => {
    if (hasErrors(issues)) return;
    let next: CodeProject;
    if (isCube) next = applyRegeneration(code!, cfg);
    else {
      if (code && !window.confirm("지금 코드 탭의 코드를 설정 도구 프로젝트로 바꿉니다(회로는 그대로). 계속할까요?")) return;
      next = newCubeProject(cfg);
    }
    onApply(next);
    setSaved(JSON.stringify(cfg));
    setDone(`코드를 생성했습니다 (${new Date().toLocaleTimeString()}). 코드 탭에서 ▶ 빌드하세요.`);
  };

  const loadIoc = async (f: File) => {
    const r = parseIoc(await f.text());
    setCfg({ ...r.config, drivers: r.config.drivers || DEFAULT_PACK.id });
    setNotes([`${f.name}을(를) 불러왔습니다.`, ...r.warnings]);
    setTab("pins");
  };

  return (
    <div className="cube-panel" data-testid="config-panel" role="dialog" aria-label="설정 도구">
      <div className="cube-bar">
        <b>⚙ 설정 (.ioc)</b>
        <label className="cube-name">
          프로젝트{" "}
          <input aria-label="CubeIDE 프로젝트 이름" value={cfg.projectName} onChange={(e) => update((c) => void (c.projectName = e.target.value))} size={14} />
        </label>
        <label>
          드라이버{" "}
          <select aria-label="STM32CubeF4 버전" value={cfg.drivers} onChange={(e) => update((c) => void (c.drivers = e.target.value))}>
            {PACKS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <span className={errors ? "cube-count bad" : warns ? "cube-count warn" : "cube-count ok"} data-testid="config-status">
          {errors ? `오류 ${errors}` : "오류 없음"}
          {warns ? ` · 경고 ${warns}` : ""}
        </span>
        <span className="cube-spacer" />
        <button onClick={() => iocInput.current?.click()} title="CubeMX .ioc 파일을 읽어 이 설정으로">
          .ioc 불러오기
        </button>
        <input ref={iocInput} type="file" accept=".ioc" hidden data-testid="ioc-input" onChange={(e) => e.target.files?.[0] && void loadIoc(e.target.files[0])} />
        <button onClick={() => download(`${cfg.projectName || "simucleo"}.ioc`, new Blob([exportIoc(cfg)], { type: "text/plain" }))}>.ioc 내보내기</button>
        <button className="primary" onClick={() => setTab("code")} title="바뀔 코드를 보고 생성합니다">
          코드 생성…
        </button>
        <button onClick={close} aria-label="설정 도구 닫기">
          ✕
        </button>
      </div>
      <nav className="cube-tabs" role="tablist">
        {(
          [
            ["pins", "핀 배치"],
            ["clock", "클럭"],
            ["peripherals", "주변장치"],
            ["code", "코드 생성"],
          ] as [Tab, string][]
        ).map(([t, name]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
            {name}
            {t === "clock" && tree.issues.some((i) => i.severity === "error") ? " ⚠" : ""}
          </button>
        ))}
      </nav>
      <div className="cube-body">
        {tab === "pins" && <PinTab cfg={cfg} setCfg={setCfg} issues={issues} wired={wired} />}
        {tab === "clock" && <ClockTab cfg={cfg} update={update} issues={tree.issues} />}
        {tab === "peripherals" && <PeripheralTab cfg={cfg} setCfg={setCfg} update={update} />}
        {tab === "code" && <CodeTab code={code} cfg={cfg} canGenerate={!hasErrors(issues)} generate={generateNow} done={done} dirty={dirty} />}
      </div>
      <Problems issues={issues} wiring={wiring} notes={notes} onNotes={() => setNotes([])} />
    </div>
  );
}

function Problems({ issues, wiring, notes, onNotes }: { issues: Issue[]; wiring: { pin: string; message: string }[]; notes: string[]; onNotes: () => void }) {
  if (!issues.length && !wiring.length && !notes.length) return <div className="cube-problems empty">문제 없음</div>;
  return (
    <div className="cube-problems" data-testid="config-problems">
      <ul>
        {issues.map((i, k) => (
          <li key={`i${k}`} className={i.severity === "error" ? "p-error" : "p-warning"} data-where={i.where}>
            <b>{i.severity === "error" ? "오류" : "경고"}</b> {i.message}
          </li>
        ))}
        {wiring.map((w, k) => (
          <li key={`w${k}`} className="p-wiring" data-pin={w.pin}>
            <b>배선 대조</b> {w.message}
          </li>
        ))}
        {notes.map((n, k) => (
          <li key={`n${k}`} className="p-note">
            <b>알림</b> {n}
          </li>
        ))}
      </ul>
      {notes.length > 0 && (
        <button className="cube-dismiss" onClick={onNotes}>
          알림 지우기
        </button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ pins

const SIGNAL_LABEL: Record<string, string> = { GPIO_Input: "GPIO 입력", GPIO_Output: "GPIO 출력", GPIO_Analog: "아날로그" };
const signalText = (s: string) => SIGNAL_LABEL[s] ?? (/^GPXTI(\d+)$/.test(s) ? `EXTI${s.slice(5)}` : s);

function pinClass(pin: PackagePin, cfg: CubeConfig, issues: Issue[]): string {
  if (pin.kind !== "io") return `pkg-pin ${pin.kind}`;
  const v = cfg.pins[pin.name];
  const bad = issues.filter((i) => i.where.split(", ").includes(pin.name));
  if (bad.some((i) => i.severity === "error")) return "pkg-pin io bad";
  if (!v) return "pkg-pin io";
  if (bad.length) return "pkg-pin io warn";
  return /^(SYS_|RCC_)/.test(v.signal) ? "pkg-pin io fixed" : "pkg-pin io set";
}

/** Pin `n` (1–64) of the LQFP64: position of its lead, and which side. */
function leadAt(n: number): { x: number; y: number; side: "l" | "b" | "r" | "t" } {
  const B0 = 120;
  const B1 = 360;
  const step = (B1 - B0 - 24) / 15;
  const i = (n - 1) % 16;
  const along = B0 + 12 + i * step;
  if (n <= 16) return { x: B0, y: along, side: "l" };
  if (n <= 32) return { x: along, y: B1, side: "b" };
  if (n <= 48) return { x: B1, y: B1 - (along - B0), side: "r" };
  return { x: B1 - (along - B0), y: B0, side: "t" };
}

function PackageView({ cfg, issues, selected, onPick }: { cfg: CubeConfig; issues: Issue[]; selected: string | null; onPick: (pin: string, at: { x: number; y: number }) => void }) {
  const L = 16;
  return (
    <svg className="pkg" viewBox="0 0 480 480" role="img" aria-label="STM32F401RETx LQFP64 핀 배치">
      <rect x={120} y={120} width={240} height={240} rx={6} className="pkg-body" />
      <circle cx={136} cy={136} r={5} className="pkg-dot" />
      <text x={240} y={232} className="pkg-name">
        STM32F401RETx
      </text>
      <text x={240} y={252} className="pkg-sub">
        LQFP64
      </text>
      {PACKAGE_PINS.map((p) => {
        const a = leadAt(p.number);
        const horiz = a.side === "l" || a.side === "r";
        const dx = a.side === "l" ? -L : a.side === "r" ? 0 : -4;
        const dy = a.side === "t" ? -L : a.side === "b" ? 0 : -4;
        const v = cfg.pins[p.name];
        const txt = v ? (v.label ? labelMacro(v.label) : signalText(v.signal)) : "";
        const out = a.side === "l" ? -L - 3 : a.side === "r" ? L + 3 : a.side === "t" ? -L - 3 : L + 3;
        const tx = horiz ? a.x + out : a.x;
        const ty = horiz ? a.y : a.y + out;
        const rot = horiz ? 0 : -90;
        const anchor = a.side === "l" || a.side === "b" ? "end" : "start";
        const pick = (e: React.MouseEvent) => {
          if (p.kind !== "io") return;
          const r = (e.currentTarget as SVGElement).ownerSVGElement!.getBoundingClientRect();
          onPick(p.name, { x: e.clientX - r.left, y: e.clientY - r.top });
        };
        return (
          <g key={p.number} className={pinClass(p, cfg, issues) + (selected === p.name ? " sel" : "")} data-pin={p.kind === "io" ? p.name : undefined} onClick={pick}>
            <title>{`${p.number}: ${p.name}${v ? ` — ${v.signal}${v.label ? ` (${v.label})` : ""}` : ""}${boardNames(p.name).length ? ` · ${boardNames(p.name).join(" · ")}` : ""}${ONBOARD[p.name] ? ` · ${ONBOARD[p.name]}` : ""}`}</title>
            <rect x={a.x + dx} y={a.y + dy} width={horiz ? L : 8} height={horiz ? 8 : L} />
            <text
              className="pkg-pin-name"
              transform={`translate(${horiz ? a.x + (a.side === "l" ? 3 : -3) : a.x} ${horiz ? a.y : a.y + (a.side === "t" ? 3 : -3)}) rotate(${rot})`}
              textAnchor={a.side === "l" || a.side === "b" ? "start" : "end"}
              dominantBaseline="central"
            >
              {p.name}
            </text>
            {txt && (
              <text className="pkg-pin-sig" transform={`translate(${tx} ${ty}) rotate(${rot})`} textAnchor={anchor} dominantBaseline="central">
                {txt}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function PinTab({ cfg, setCfg, issues, wired }: { cfg: CubeConfig; setCfg: (c: CubeConfig) => void; issues: Issue[]; wired?: WiredPins }) {
  const [sel, setSel] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ pin: string; x: number; y: number } | null>(null);
  const [view, setView] = useState<"package" | "list">("package");
  const [filter, setFilter] = useState<"all" | "used">("all");
  const assign = (pin: string, signal: string | null) => {
    setCfg(assignPin(cfg, pin, signal));
    setMenu(null);
    setSel(pin);
  };
  return (
    <div className="cube-pins">
      <div className="cube-pins-left">
        <div className="cube-seg">
          <button aria-pressed={view === "package"} onClick={() => setView("package")}>
            패키지
          </button>
          <button aria-pressed={view === "list"} onClick={() => setView("list")}>
            목록
          </button>
        </div>
        {view === "package" ? (
          <div className="pkg-wrap" onClick={(e) => e.target === e.currentTarget && setMenu(null)}>
            <PackageView
              cfg={cfg}
              issues={issues}
              selected={sel}
              onPick={(pin, at) => {
                setSel(pin);
                setMenu({ pin, ...at });
              }}
            />
            {menu && (
              <div className="pin-menu" style={{ left: Math.min(menu.x, 330), top: Math.min(menu.y, 300) }} data-testid="pin-menu" role="menu" aria-label={`${menu.pin} 신호`}>
                <div className="pin-menu-title">
                  {menu.pin} {boardNames(menu.pin).join(" · ")}
                </div>
                <button role="menuitem" onClick={() => assign(menu.pin, null)} data-signal="">
                  Reset_State (해제)
                </button>
                {signalChoices(menu.pin).map((s) => (
                  <button
                    role="menuitem"
                    key={s.signal}
                    data-signal={s.signal}
                    className={cfg.pins[menu.pin]?.signal === s.signal ? "on" : ""}
                    disabled={s.kind === "rcc" && !/^RCC_OSC_/.test(s.signal)}
                    onClick={() => assign(menu.pin, s.signal)}
                    title={s.unsupported ? "코드 생성은 아직 지원하지 않습니다(설정만 저장)" : undefined}
                  >
                    {s.signal}
                    {s.unsupported ? " (미지원)" : ""}
                  </button>
                ))}
                <button className="pin-menu-x" onClick={() => setMenu(null)} aria-label="닫기">
                  ✕
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="pin-list">
            <label>
              <input type="checkbox" checked={filter === "used"} onChange={(e) => setFilter(e.target.checked ? "used" : "all")} /> 쓰는 핀만
            </label>
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>핀</th>
                  <th>보드</th>
                  <th>신호</th>
                  <th>라벨</th>
                </tr>
              </thead>
              <tbody>
                {PACKAGE_PINS.filter((p) => p.kind === "io" && (filter === "all" || cfg.pins[p.name])).map((p) => (
                  <tr key={p.name} className={sel === p.name ? "sel" : ""} onClick={() => setSel(p.name)} data-row={p.name}>
                    <td>{p.number}</td>
                    <td>{p.name}</td>
                    <td className="dim">{boardNames(p.name).join(" ")}</td>
                    <td>
                      <select aria-label={`${p.name} 신호`} value={cfg.pins[p.name]?.signal ?? ""} onChange={(e) => assign(p.name, e.target.value || null)}>
                        <option value="">—</option>
                        {signalChoices(p.name).map((s) => (
                          <option key={s.signal} value={s.signal}>
                            {s.signal}
                            {s.unsupported ? " (미지원)" : ""}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>{cfg.pins[p.name]?.label ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="cube-pins-right">{sel ? <PinEditor pin={sel} cfg={cfg} setCfg={setCfg} wired={wired} /> : <p className="dim">핀을 누르면 신호를 고르고 설정합니다. 초록은 쓰는 핀, 빨강은 오류.</p>}</div>
    </div>
  );
}

function PinEditor({ pin, cfg, setCfg, wired }: { pin: string; cfg: CubeConfig; setCfg: (c: CubeConfig) => void; wired?: WiredPins }) {
  const v = cfg.pins[pin];
  const set = (patch: Partial<PinConfig>) => {
    const c = clone(cfg);
    c.pins[pin] = { ...c.pins[pin], ...patch };
    if (patch.label === "") delete c.pins[pin].label;
    setCfg(c);
  };
  const n = PACKAGE_PINS.find((p) => p.name === pin)!.number;
  const parts = wired?.[pin]?.filter((p) => p.kind !== "resistor") ?? [];
  return (
    <div className="pin-editor" data-testid="pin-editor" data-editing={pin}>
      <h4>
        {pin} <span className="dim">(핀 {n})</span>
      </h4>
      <p className="dim">
        {[...boardNames(pin), ONBOARD[pin]].filter(Boolean).join(" · ") || "보드 헤더에 없음"}
        {parts.length ? ` · 회로: ${parts.map((p) => `${p.name}(${p.part}.${p.pin})`).join(", ")}` : ""}
      </p>
      <label>
        신호{" "}
        <select aria-label={`${pin} 신호 고르기`} value={v?.signal ?? ""} onChange={(e) => setCfg(assignPin(cfg, pin, e.target.value || null))}>
          <option value="">Reset_State (해제)</option>
          {signalChoices(pin).map((s) => (
            <option key={s.signal} value={s.signal}>
              {s.signal}
              {s.unsupported ? " (미지원)" : ""}
            </option>
          ))}
        </select>
      </label>
      {v && (
        <>
          <label>
            라벨{" "}
            <input aria-label={`${pin} 라벨`} value={v.label ?? ""} placeholder="예: LD2" onChange={(e) => set({ label: e.target.value })} />
            {v.label && <span className="dim"> → {labelMacro(v.label)}_Pin</span>}
          </label>
          {/^GPIO_(Input|Output)$|^GPXTI/.test(v.signal) && (
            <label>
              풀업/풀다운{" "}
              <select aria-label={`${pin} 풀업`} value={v.pull ?? "none"} onChange={(e) => set({ pull: e.target.value as PinConfig["pull"] })}>
                <option value="none">없음</option>
                <option value="up">풀업</option>
                <option value="down">풀다운</option>
              </select>
            </label>
          )}
          {v.signal === "GPIO_Output" && (
            <>
              <label>
                처음 출력{" "}
                <select aria-label={`${pin} 처음 출력`} value={v.high ? "1" : "0"} onChange={(e) => set({ high: e.target.value === "1" })}>
                  <option value="0">Low</option>
                  <option value="1">High</option>
                </select>
              </label>
              <label>
                출력 방식{" "}
                <select aria-label={`${pin} 출력 방식`} value={v.openDrain ? "od" : "pp"} onChange={(e) => set({ openDrain: e.target.value === "od" })}>
                  <option value="pp">푸시풀</option>
                  <option value="od">오픈 드레인</option>
                </select>
              </label>
            </>
          )}
          {(v.signal === "GPIO_Output" || /^(USART|SPI|I2C|TIM)/.test(v.signal)) && (
            <label>
              속도{" "}
              <select aria-label={`${pin} 속도`} value={v.speed ?? (/^TIM|^GPIO/.test(v.signal) ? "low" : "very_high")} onChange={(e) => set({ speed: e.target.value as PinConfig["speed"] })}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="very_high">Very High</option>
              </select>
            </label>
          )}
          {/^GPXTI/.test(v.signal) && (
            <label>
              인터럽트{" "}
              <select aria-label={`${pin} 에지`} value={v.edge ?? "rising"} onChange={(e) => set({ edge: e.target.value as PinConfig["edge"] })}>
                <option value="rising">상승 에지</option>
                <option value="falling">하강 에지</option>
                <option value="both">양쪽 에지</option>
              </select>
            </label>
          )}
          {peripheralOf(v.signal) && <p className="dim">{peripheralOf(v.signal)}의 설정은 주변장치 탭에서.</p>}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ clock

function ClockTab({ cfg, update, issues }: { cfg: CubeConfig; update: (f: (c: CubeConfig) => void) => void; issues: ClockIssue[] }) {
  const k = cfg.clock;
  const t = computeClock(k);
  const bad = (n: ClockIssue["node"]) =>
    issues.find((i) => i.node === n && i.severity === "error") ?? issues.find((i) => i.node === n) ?? (n === "pllP" && k.sysclk === "PLL" ? issues.find((i) => i.node === "sysclk") : undefined);
  const box = (node: ClockIssue["node"] | null, title: string, value: ReactNode, children?: ReactNode) => {
    const b = node ? bad(node) : undefined;
    return (
      <div className={`ck-box${b ? (b.severity === "error" ? " bad" : " warn") : ""}`} data-node={node ?? undefined} title={b?.message}>
        <div className="ck-title">{title}</div>
        <div className="ck-val">{value}</div>
        {children}
      </div>
    );
  };
  const set = (f: (c: ClockConfig) => void) => update((c) => void f(c.clock));
  const num = (label: string, v: number, min: number, max: number, f: (n: number) => void) => (
    <input aria-label={label} type="number" min={min} max={max} value={v} onChange={(e) => f(Number(e.target.value))} />
  );
  return (
    <div className="ck">
      <div className="ck-row">
        <div className="ck-col">
          {box(null, "HSI", mhz(HSI_HZ), <span className="dim">내부 RC</span>)}
          {box(
            "hse",
            "HSE",
            k.hse === "off" ? "꺼짐" : mhz(HSE_HZ),
            <select aria-label="HSE" value={k.hse} onChange={(e) => update((c) => {
              c.clock.hse = e.target.value as ClockConfig["hse"];
              // HSE takes PH0/PH1 (OSC_IN/OSC_OUT), as in CubeMX's RCC mode.
              if (c.clock.hse === "off") for (const q of ["PH0", "PH1"]) { if (/^RCC_OSC_/.test(c.pins[q]?.signal ?? "")) delete c.pins[q]; }
              else { c.pins.PH0 = { signal: "RCC_OSC_IN" }; c.pins.PH1 = { signal: "RCC_OSC_OUT" }; }
            })}>
              <option value="off">끄기</option>
              <option value="bypass">바이패스 (ST-LINK 8 MHz)</option>
              <option value="crystal">크리스털</option>
            </select>,
          )}
        </div>
        <span className="ck-arrow">→</span>
        <div className="ck-col">
          {box(
            null,
            "PLL 소스",
            k.pllSource,
            <select aria-label="PLL 소스" value={k.pllSource} onChange={(e) => set((c) => void (c.pllSource = e.target.value as ClockConfig["pllSource"]))}>
              <option value="HSI">HSI</option>
              <option value="HSE">HSE</option>
            </select>,
          )}
          <label className="ck-check">
            <input type="checkbox" checked={k.pllOn} onChange={(e) => set((c) => void (c.pllOn = e.target.checked))} /> PLL 켜기
          </label>
        </div>
        <span className="ck-arrow">→</span>
        {box("pllM", "÷ M", <>{num("PLLM", k.pllM, 2, 63, (n) => set((c) => void (c.pllM = n)))}</>)}
        <span className="ck-arrow">→</span>
        {box("vcoIn", "VCO 입력", mhz(t.vcoIn), <span className="dim">0.95–2.1 MHz</span>)}
        <span className="ck-arrow">→</span>
        {box("pllN", "× N", <>{num("PLLN", k.pllN, 50, 432, (n) => set((c) => void (c.pllN = n)))}</>)}
        <span className="ck-arrow">→</span>
        {box("vcoOut", "VCO 출력", mhz(t.vcoOut), <span className="dim">192–432 MHz</span>)}
        <span className="ck-arrow">→</span>
        <div className="ck-col">
          {box(
            "pllP",
            "÷ P → PLLCLK",
            mhz(t.pllP),
            <select aria-label="PLLP" value={k.pllP} onChange={(e) => set((c) => void (c.pllP = Number(e.target.value)))}>
              {PLLP_VALUES.map((p) => (
                <option key={p} value={p}>
                  /{p}
                </option>
              ))}
            </select>,
          )}
          {box(
            k.usb48 ? "usb" : "pllQ",
            "÷ Q → 48 MHz",
            mhz(t.pllQ),
            <>
              {num("PLLQ", k.pllQ, 2, 15, (n) => set((c) => void (c.pllQ = n)))}
              <label className="ck-check">
                <input type="checkbox" checked={k.usb48} onChange={(e) => set((c) => void (c.usb48 = e.target.checked))} /> USB 48 MHz 확인
              </label>
            </>,
          )}
        </div>
      </div>
      <div className="ck-row">
        {box(
          "sysclk",
          "SYSCLK 선택",
          mhz(t.sysclk),
          <div className="ck-radio" role="radiogroup" aria-label="SYSCLK 소스">
            {(["HSI", "HSE", "PLL"] as const).map((s) => (
              <label key={s}>
                <input type="radio" name="sysclk" checked={k.sysclk === s} onChange={() => set((c) => void (c.sysclk = s))} /> {s === "PLL" ? "PLLCLK" : s}
              </label>
            ))}
          </div>,
        )}
        <span className="ck-arrow">→</span>
        {box(
          "hclk",
          "AHB ÷ → HCLK",
          mhz(t.hclk),
          <select aria-label="AHB 분주" value={k.ahbDiv} onChange={(e) => set((c) => void (c.ahbDiv = Number(e.target.value)))}>
            {AHB_DIVS.map((d) => (
              <option key={d} value={d}>
                /{d}
              </option>
            ))}
          </select>,
        )}
        <span className="ck-arrow">→</span>
        <div className="ck-col">
          {box(
            "apb1",
            "APB1 ÷ → PCLK1 (최대 42)",
            mhz(t.pclk1),
            <>
              <select aria-label="APB1 분주" value={k.apb1Div} onChange={(e) => set((c) => void (c.apb1Div = Number(e.target.value)))}>
                {APB_DIVS.map((d) => (
                  <option key={d} value={d}>
                    /{d}
                  </option>
                ))}
              </select>
              <span className="dim"> 타이머 {mhz(t.tim1)}</span>
            </>,
          )}
          {box(
            "apb2",
            "APB2 ÷ → PCLK2 (최대 84)",
            mhz(t.pclk2),
            <>
              <select aria-label="APB2 분주" value={k.apb2Div} onChange={(e) => set((c) => void (c.apb2Div = Number(e.target.value)))}>
                {APB_DIVS.map((d) => (
                  <option key={d} value={d}>
                    /{d}
                  </option>
                ))}
              </select>
              <span className="dim"> 타이머 {mhz(t.tim2)}</span>
            </>,
          )}
        </div>
        <span className="ck-arrow" />
        <div className="ck-col">
          {box(
            "latency",
            "플래시 대기",
            `${t.latency} WS`,
            <select aria-label="플래시 대기" value={k.latency ?? "auto"} onChange={(e) => set((c) => void (c.latency = e.target.value === "auto" ? null : Number(e.target.value)))}>
              <option value="auto">자동 ({t.minLatency})</option>
              {[0, 1, 2, 3, 4, 5, 6, 7].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>,
          )}
          {box(
            null,
            "전압 스케일",
            `Scale ${k.vos}`,
            <select aria-label="전압 스케일" value={k.vos} onChange={(e) => set((c) => void (c.vos = Number(e.target.value) as 2 | 3))}>
              <option value={2}>Scale 2 (≤ 84 MHz)</option>
              <option value={3}>Scale 3 (≤ 60 MHz)</option>
            </select>,
          )}
        </div>
      </div>
      <p className="dim">SysTick·Cortex 클럭 = HCLK ({mhz(t.hclk)}). 숫자는 고치는 대로 다시 계산하고, 넘는 값은 빨간 상자와 아래 목록으로 알려 준다.</p>
    </div>
  );
}

// ------------------------------------------------------------------ peripherals

const PERI_GROUPS: [string, string[]][] = [
  ["연결", [...USARTS, ...I2CS, ...SPIS]],
  ["타이머", [...TIMS]],
  ["아날로그", ["ADC1"]],
  ["시스템", ["GPIO", "NVIC", "SYS"]],
];

function PeripheralTab({ cfg, setCfg, update }: { cfg: CubeConfig; setCfg: (c: CubeConfig) => void; update: (f: (c: CubeConfig) => void) => void }) {
  const [sel, setSel] = useState<string>(() => peripherals(cfg)[0] ?? "GPIO");
  const on = new Set([...peripherals(cfg), "GPIO", "NVIC", "SYS"]);
  return (
    <div className="cube-peri">
      <nav className="peri-list" aria-label="주변장치">
        {PERI_GROUPS.map(([g, list]) => (
          <div key={g}>
            <div className="peri-group">{g}</div>
            {list.map((p) => (
              <button key={p} className={(sel === p ? "on " : "") + (on.has(p) ? "used" : "")} onClick={() => setSel(p)} data-peripheral={p}>
                {on.has(p) && !["GPIO", "NVIC", "SYS"].includes(p) ? "✓ " : ""}
                {p}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="peri-form" data-testid="peripheral-form" data-peripheral={sel}>
        <PeripheralForm p={sel} cfg={cfg} setCfg={setCfg} update={update} />
      </div>
    </div>
  );
}

function Enable({ p, cfg, setCfg, hint }: { p: string; cfg: CubeConfig; setCfg: (c: CubeConfig) => void; hint?: string }) {
  const on = peripherals(cfg).includes(p);
  return (
    <label className="peri-enable">
      <input type="checkbox" aria-label={`${p} 사용`} checked={on} onChange={(e) => setCfg(e.target.checked ? enablePeripheralWithPins(cfg, p) : disablePeripheralWithPins(cfg, p))} /> {p} 사용
      {hint && <span className="dim"> {hint}</span>}
    </label>
  );
}

function PinsOf({ p, cfg }: { p: string; cfg: CubeConfig }) {
  const pins = Object.entries(cfg.pins).filter(([, v]) => peripheralOf(v.signal) === p);
  if (!pins.length) return null;
  return <p className="dim">핀: {pins.map(([pin, v]) => `${v.signal} → ${pin}${boardNames(pin).length ? ` (${boardNames(pin)[0]})` : ""}`).join(", ")}</p>;
}

function Nvic({ irq, cfg, update, label }: { irq: string; cfg: CubeConfig; update: (f: (c: CubeConfig) => void) => void; label?: string }) {
  const n = cfg.nvic[irq];
  return (
    <div className="peri-nvic">
      <label>
        <input
          type="checkbox"
          aria-label={`${irq}_IRQn 인터럽트`}
          checked={!!n?.enabled}
          onChange={(e) => update((c) => void (c.nvic[irq] = { enabled: e.target.checked, preempt: c.nvic[irq]?.preempt ?? 0, sub: 0 }))}
        />{" "}
        {label ?? `${irq}_IRQn`} 인터럽트
      </label>
      {n?.enabled && (
        <label>
          {" "}
          우선순위{" "}
          <select aria-label={`${irq} 우선순위`} value={n.preempt} onChange={(e) => update((c) => void (c.nvic[irq].preempt = Number(e.target.value)))}>
            {Array.from({ length: 16 }, (_, i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

function PeripheralForm({ p, cfg, setCfg, update }: { p: string; cfg: CubeConfig; setCfg: (c: CubeConfig) => void; update: (f: (c: CubeConfig) => void) => void }) {
  const tree = computeClock(cfg.clock);
  if ((USARTS as readonly string[]).includes(p)) {
    const u = cfg.usart[p as (typeof USARTS)[number]];
    const name = p as (typeof USARTS)[number];
    return (
      <>
        <h4>{p} (UART 비동기)</h4>
        <Enable p={p} cfg={cfg} setCfg={setCfg} hint={p === "USART2" ? "PA2/PA3 = ST-LINK 가상 COM(콘솔)" : undefined} />
        <PinsOf p={p} cfg={cfg} />
        {u && (
          <div className="peri-grid">
            <label>
              보레이트 <input aria-label={`${p} 보레이트`} type="number" value={u.baud} onChange={(e) => update((c) => void (c.usart[name]!.baud = Number(e.target.value)))} /> bps
            </label>
            <label>
              워드 길이{" "}
              <select aria-label={`${p} 워드 길이`} value={u.wordLength} onChange={(e) => update((c) => void (c.usart[name]!.wordLength = Number(e.target.value) as 8 | 9))}>
                <option value={8}>8비트 (패리티 포함)</option>
                <option value={9}>9비트 (패리티 포함)</option>
              </select>
            </label>
            <label>
              패리티{" "}
              <select aria-label={`${p} 패리티`} value={u.parity} onChange={(e) => update((c) => void (c.usart[name]!.parity = e.target.value as "none"))}>
                <option value="none">없음</option>
                <option value="even">짝수</option>
                <option value="odd">홀수</option>
              </select>
            </label>
            <label>
              정지 비트{" "}
              <select aria-label={`${p} 정지 비트`} value={u.stopBits} onChange={(e) => update((c) => void (c.usart[name]!.stopBits = Number(e.target.value) as 1 | 2))}>
                <option value={1}>1</option>
                <option value={2}>2</option>
              </select>
            </label>
            <label>
              방향{" "}
              <select aria-label={`${p} 방향`} value={u.direction} onChange={(e) => update((c) => void (c.usart[name]!.direction = e.target.value as "tx_rx"))}>
                <option value="tx_rx">송수신</option>
                <option value="tx">송신만</option>
                <option value="rx">수신만</option>
              </select>
            </label>
            <Nvic irq={p} cfg={cfg} update={update} />
          </div>
        )}
      </>
    );
  }
  if ((I2CS as readonly string[]).includes(p)) {
    const v = cfg.i2c[p as (typeof I2CS)[number]];
    const name = p as (typeof I2CS)[number];
    return (
      <>
        <h4>{p}</h4>
        <Enable p={p} cfg={cfg} setCfg={setCfg} hint={p === "I2C1" ? "PB8/PB9 = D15/D14" : undefined} />
        <PinsOf p={p} cfg={cfg} />
        {v && (
          <div className="peri-grid">
            <label>
              속도{" "}
              <select aria-label={`${p} 속도`} value={v.speed} onChange={(e) => update((c) => void (c.i2c[name]!.speed = Number(e.target.value)))}>
                <option value={100000}>표준 100 kHz</option>
                <option value={400000}>빠른 400 kHz</option>
              </select>
            </label>
            {v.speed > 100000 && (
              <label>
                듀티{" "}
                <select aria-label={`${p} 듀티`} value={v.duty} onChange={(e) => update((c) => void (c.i2c[name]!.duty = e.target.value as "2"))}>
                  <option value="2">Tlow/Thigh = 2</option>
                  <option value="16_9">16/9</option>
                </select>
              </label>
            )}
            <label>
              자기 주소(7비트) <input aria-label={`${p} 주소`} type="number" min={0} max={127} value={v.ownAddress} onChange={(e) => update((c) => void (c.i2c[name]!.ownAddress = Number(e.target.value)))} />
            </label>
            <Nvic irq={`${p}_EV`} cfg={cfg} update={update} label={`${p} 이벤트`} />
            <Nvic irq={`${p}_ER`} cfg={cfg} update={update} label={`${p} 오류`} />
          </div>
        )}
      </>
    );
  }
  if ((SPIS as readonly string[]).includes(p)) {
    const v = cfg.spi[p as (typeof SPIS)[number]];
    const name = p as (typeof SPIS)[number];
    const bus = p === "SPI1" ? tree.pclk2 : tree.pclk1;
    return (
      <>
        <h4>{p}</h4>
        <Enable p={p} cfg={cfg} setCfg={setCfg} hint={p === "SPI1" ? "PA5/PA6/PA7 = D13/D12/D11 (PA5는 LD2와 같은 핀)" : undefined} />
        <PinsOf p={p} cfg={cfg} />
        {v && (
          <div className="peri-grid">
            <label>
              모드{" "}
              <select aria-label={`${p} 모드`} value={`${v.mode}:${v.direction}`} onChange={(e) => {
                const [mode, direction] = e.target.value.split(":") as ["master" | "slave", "2lines" | "tx_only"];
                let c = clone(cfg);
                c.spi[name] = { ...c.spi[name]!, mode, direction };
                if (direction === "tx_only") for (const [pin, pv] of Object.entries(c.pins)) if (pv.signal === `${p}_MISO`) delete c.pins[pin];
                if (direction === "2lines" && !Object.values(c.pins).some((pv) => pv.signal === `${p}_MISO`)) c = enablePeripheralWithPins(c, p);
                setCfg(c);
              }}>
                <option value="master:2lines">전이중 마스터</option>
                <option value="master:tx_only">송신 전용 마스터</option>
                <option value="slave:2lines">전이중 슬레이브</option>
              </select>
            </label>
            <label>
              데이터{" "}
              <select aria-label={`${p} 데이터 크기`} value={v.dataSize} onChange={(e) => update((c) => void (c.spi[name]!.dataSize = Number(e.target.value) as 8))}>
                <option value={8}>8비트</option>
                <option value={16}>16비트</option>
              </select>
            </label>
            <label>
              분주{" "}
              <select aria-label={`${p} 분주`} value={v.prescaler} onChange={(e) => update((c) => void (c.spi[name]!.prescaler = Number(e.target.value)))}>
                {[2, 4, 8, 16, 32, 64, 128, 256].map((d) => (
                  <option key={d} value={d}>
                    /{d} = {mhz(bus / d)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              CPOL{" "}
              <select aria-label={`${p} CPOL`} value={v.cpol} onChange={(e) => update((c) => void (c.spi[name]!.cpol = Number(e.target.value) as 0))}>
                <option value={0}>0 (Low)</option>
                <option value={1}>1 (High)</option>
              </select>
            </label>
            <label>
              CPHA{" "}
              <select aria-label={`${p} CPHA`} value={v.cpha} onChange={(e) => update((c) => void (c.spi[name]!.cpha = Number(e.target.value) as 0))}>
                <option value={0}>0 (첫 에지)</option>
                <option value={1}>1 (둘째 에지)</option>
              </select>
            </label>
            <label>
              비트 순서{" "}
              <select aria-label={`${p} 비트 순서`} value={v.firstBit} onChange={(e) => update((c) => void (c.spi[name]!.firstBit = e.target.value as "msb"))}>
                <option value="msb">MSB 먼저</option>
                <option value="lsb">LSB 먼저</option>
              </select>
            </label>
            <Nvic irq={p} cfg={cfg} update={update} />
          </div>
        )}
      </>
    );
  }
  if ((TIMS as readonly string[]).includes(p)) {
    const name = p as TimName;
    const v = cfg.tim[name];
    const irq = name === "TIM1" ? "TIM1_UP_TIM10" : name === "TIM9" ? "TIM1_BRK_TIM9" : name === "TIM10" ? "TIM1_UP_TIM10" : name === "TIM11" ? "TIM1_TRG_COM_TIM11" : name;
    const clk = /^TIM[2-5]$/.test(p) ? tree.tim1 : tree.tim2;
    return (
      <>
        <h4>{p}</h4>
        <Enable p={p} cfg={cfg} setCfg={setCfg} hint={`내부 클럭 ${mhz(clk)}`} />
        {v && (
          <>
            <div className="peri-grid">
              <label>
                분주(PSC) <input aria-label={`${p} 분주`} type="number" min={0} max={65535} value={v.prescaler} onChange={(e) => update((c) => void (c.tim[name]!.prescaler = Number(e.target.value)))} />
              </label>
              <label>
                주기(ARR) <input aria-label={`${p} 주기`} type="number" min={0} value={v.period} onChange={(e) => update((c) => void (c.tim[name]!.period = Number(e.target.value)))} />
              </label>
              <label>
                세기{" "}
                <select aria-label={`${p} 세기`} value={v.counterMode} onChange={(e) => update((c) => void (c.tim[name]!.counterMode = e.target.value as "up"))}>
                  <option value="up">위로</option>
                  <option value="down">아래로</option>
                  <option value="center1">가운데 정렬 1</option>
                  <option value="center2">가운데 정렬 2</option>
                  <option value="center3">가운데 정렬 3</option>
                </select>
              </label>
              <label>
                <input type="checkbox" checked={v.autoReloadPreload} onChange={(e) => update((c) => void (c.tim[name]!.autoReloadPreload = e.target.checked))} /> ARR 프리로드
              </label>
              <span className="dim">
                업데이트 {(clk / (v.prescaler + 1) / (v.period + 1) / (v.counterMode.startsWith("center") ? 2 : 1)).toFixed(3)} Hz
              </span>
              <Nvic irq={irq} cfg={cfg} update={update} label={`${irq}_IRQn (업데이트)`} />
            </div>
            <h5>PWM 출력 채널</h5>
            <table className="peri-ch">
              <tbody>
                {Array.from({ length: timChannels(p) }, (_, i) => {
                  const sig = `${p}_CH${i + 1}`;
                  const pin = Object.entries(cfg.pins).find(([, pv]) => pv.signal === sig)?.[0] ?? "";
                  const ch = v.channels[i];
                  const info = pwmInfo(cfg, name, i, tree);
                  return (
                    <tr key={i} data-channel={i + 1}>
                      <td>CH{i + 1}</td>
                      <td>
                        <select aria-label={`${sig} 핀`} value={pin} onChange={(e) => {
                          let c = cfg;
                          if (pin) c = assignPin(c, pin, null);
                          if (e.target.value) c = assignPin(c, e.target.value, sig, c.pins[e.target.value]?.label);
                          setCfg(c);
                        }}>
                          <option value="">끄기</option>
                          {pinsFor(sig).map((q) => (
                            <option key={q} value={q}>
                              {q} {boardNames(q)[0] ?? ""}
                              {cfg.pins[q] && cfg.pins[q].signal !== sig ? ` (${cfg.pins[q].signal})` : ""}
                            </option>
                          ))}
                        </select>
                      </td>
                      {ch && (
                        <>
                          <td>
                            펄스 <input aria-label={`${sig} 펄스`} type="number" min={0} value={ch.pulse} onChange={(e) => update((c) => void (c.tim[name]!.channels[i]!.pulse = Number(e.target.value)))} />
                          </td>
                          <td>
                            <select aria-label={`${sig} 모드`} value={ch.pwmMode} onChange={(e) => update((c) => void (c.tim[name]!.channels[i]!.pwmMode = Number(e.target.value) as 1))}>
                              <option value={1}>PWM1</option>
                              <option value={2}>PWM2</option>
                            </select>
                          </td>
                          <td>
                            <select aria-label={`${sig} 극성`} value={ch.polarity} onChange={(e) => update((c) => void (c.tim[name]!.channels[i]!.polarity = e.target.value as "high"))}>
                              <option value="high">High</option>
                              <option value="low">Low</option>
                            </select>
                          </td>
                          <td className="dim">{info ? `${info.hz.toFixed(info.hz < 10 ? 2 : 0)} Hz · ${(info.duty * 100).toFixed(1)}%` : ""}</td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="dim">PWM은 USER CODE에서 HAL_TIM_PWM_Start(&amp;htim{p.slice(3)}, TIM_CHANNEL_x)로 시작합니다.</p>
          </>
        )}
      </>
    );
  }
  if (p === "ADC1") {
    const v = cfg.adc.ADC1;
    return (
      <>
        <h4>ADC1</h4>
        <p className="dim">채널을 고르면 그 핀이 ADC1_INx가 됩니다. 순서(랭크)대로 변환합니다.</p>
        <div className="adc-ch">
          {Array.from({ length: 16 }, (_, ch) => {
            const pin = adcPin(ch)!;
            const used = cfg.pins[pin]?.signal === `ADC1_IN${ch}`;
            return (
              <label key={ch} title={boardNames(pin).join(" · ")}>
                <input type="checkbox" aria-label={`ADC1 IN${ch}`} checked={used} onChange={(e) => setCfg(assignPin(cfg, pin, e.target.checked ? `ADC1_IN${ch}` : null))} /> IN{ch} ({pin}
                {boardNames(pin)[0] && !boardNames(pin)[0].startsWith("CN") ? ` ${boardNames(pin)[0]}` : ""})
              </label>
            );
          })}
        </div>
        {v && (
          <>
            <div className="peri-grid">
              <label>
                분해능{" "}
                <select aria-label="ADC1 분해능" value={v.resolution} onChange={(e) => update((c) => void (c.adc.ADC1!.resolution = Number(e.target.value) as 12))}>
                  {[12, 10, 8, 6].map((r) => (
                    <option key={r} value={r}>
                      {r}비트
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <input type="checkbox" checked={v.scan} onChange={(e) => update((c) => void (c.adc.ADC1!.scan = e.target.checked))} /> 스캔
              </label>
              <label>
                <input type="checkbox" checked={v.continuous} onChange={(e) => update((c) => void (c.adc.ADC1!.continuous = e.target.checked))} /> 연속 변환
              </label>
              <label>
                EOC{" "}
                <select aria-label="ADC1 EOC" value={v.eocEachConversion ? "each" : "seq"} onChange={(e) => update((c) => void (c.adc.ADC1!.eocEachConversion = e.target.value === "each"))}>
                  <option value="each">변환마다</option>
                  <option value="seq">순서 끝에</option>
                </select>
              </label>
              <Nvic irq="ADC" cfg={cfg} update={update} />
            </div>
            <h5>랭크</h5>
            <ol className="adc-ranks">
              {v.ranks.map((r, i) => (
                <li key={r.channel}>
                  IN{r.channel} ({adcPin(r.channel)}){" "}
                  <select aria-label={`IN${r.channel} 샘플링`} value={r.sampling} onChange={(e) => update((c) => void (c.adc.ADC1!.ranks[i].sampling = Number(e.target.value)))}>
                    {[3, 15, 28, 56, 84, 112, 144, 480].map((s) => (
                      <option key={s} value={s}>
                        {s} 사이클
                      </option>
                    ))}
                  </select>{" "}
                  <button disabled={i === 0} onClick={() => update((c) => void c.adc.ADC1!.ranks.splice(i - 1, 0, ...c.adc.ADC1!.ranks.splice(i, 1)))} aria-label="위로">
                    ↑
                  </button>
                </li>
              ))}
            </ol>
          </>
        )}
      </>
    );
  }
  if (p === "GPIO") {
    const gpio = IO_PINS.filter((q) => /^(GPIO_|GPXTI)/.test(cfg.pins[q]?.signal ?? ""));
    return (
      <>
        <h4>GPIO</h4>
        {!gpio.length && <p className="dim">GPIO로 설정한 핀이 없습니다. 핀 배치 탭에서 핀을 누르세요.</p>}
        {gpio.map((q) => (
          <div key={q} className="gpio-row">
            <PinEditor pin={q} cfg={cfg} setCfg={setCfg} />
          </div>
        ))}
      </>
    );
  }
  if (p === "NVIC") {
    const irqs = usedIrqs(cfg);
    return (
      <>
        <h4>NVIC (우선순위 그룹 4: 선점 0–15)</h4>
        {irqs.map((i) => (
          <Nvic key={i} irq={i} cfg={cfg} update={update} />
        ))}
        <div className="peri-nvic">
          SysTick (HAL 시간){" "}
          <select aria-label="SysTick 우선순위" value={cfg.nvic.SysTick?.preempt ?? 15} onChange={(e) => update((c) => void (Number(e.target.value) === 15 ? delete c.nvic.SysTick : (c.nvic.SysTick = { enabled: true, preempt: Number(e.target.value), sub: 0 })))}>
            {Array.from({ length: 16 }, (_, i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
        </div>
      </>
    );
  }
  // SYS
  return (
    <>
      <h4>SYS</h4>
      <label>
        디버그{" "}
        <select
          aria-label="디버그"
          value={cfg.sys.debug}
          onChange={(e) => {
            let c = clone(cfg);
            c.sys.debug = e.target.value as "serial_wire";
            if (c.sys.debug === "serial_wire") {
              c = assignPin(c, "PA13", "SYS_JTMS-SWDIO", c.pins.PA13?.label ?? "TMS");
              c = assignPin(c, "PA14", "SYS_JTCK-SWCLK", c.pins.PA14?.label ?? "TCK");
            } else {
              for (const q of ["PA13", "PA14"]) if (/^SYS_/.test(c.pins[q]?.signal ?? "")) delete c.pins[q];
            }
            setCfg(c);
          }}
        >
          <option value="serial_wire">Serial Wire (SWD, ST-LINK)</option>
          <option value="none">없음</option>
        </select>
      </label>
      <p className="dim">시간 기준: SysTick. PA13/PA14를 다른 용도로 쓰면 ST-LINK 디버깅이 끊긴다.</p>
    </>
  );
}

// ------------------------------------------------------------------ code generation

function CodeTab({ code, cfg, canGenerate, generate, done, dirty }: { code: CodeProject | undefined; cfg: CubeConfig; canGenerate: boolean; generate: () => void; done: string | null; dirty: boolean }) {
  const isCube = code?.template === "cube";
  const plan: FileChange[] = useMemo(() => planRegeneration(isCube ? code! : { template: "cube", files: [] }, cfg), [code, cfg, isCube]);
  const [sel, setSel] = useState<string>("Core/Src/main.c");
  const ch = plan.find((p) => p.path === sel) ?? plan[0];
  const lines = useMemo(() => (ch ? foldDiff(diffLines(ch.before ?? "", ch.after)) : []), [ch]);
  const lost = plan.reduce((s, p) => s + p.lostEdits, 0);
  return (
    <div className="cube-code">
      <div className="cube-code-left">
        <p>
          {isCube ? "설정대로 다시 생성합니다. USER CODE BEGIN/END 사이의 코드는 그대로 남깁니다." : "이 설정으로 새 프로젝트(Core/, Drivers/는 고른 STM32CubeF4 버전)를 만들어 코드 탭에 엽니다."}
        </p>
        <ul className="cube-files" aria-label="바뀌는 파일">
          {plan.map((p) => {
            const st = diffStats(diffLines(p.before ?? "", p.after));
            const same = p.before === p.after;
            return (
              <li key={p.path}>
                <button className={p.path === ch?.path ? "on" : ""} onClick={() => setSel(p.path)} data-file={p.path}>
                  {p.path.replace(/^Core\//, "")}{" "}
                  <span className={same ? "dim" : "chg"}>{p.before === null ? "새 파일" : same ? "같음" : `+${st.added} −${st.removed}`}</span>
                  {p.kept.length > 0 && <span className="keep"> USER CODE {p.kept.length}곳 유지</span>}
                  {p.orphaned.length > 0 && <span className="orphan"> 없어진 영역 {p.orphaned.length}</span>}
                  {p.lostEdits > 0 && <span className="lost"> 영역 밖 수정 {p.lostEdits}줄 사라짐</span>}
                </button>
              </li>
            );
          })}
        </ul>
        {lost > 0 && <p className="error">USER CODE 영역 밖에서 고친 {lost}줄은 다시 생성하면 사라집니다(CubeMX와 같음). 남기려면 영역 안으로 옮기세요.</p>}
        {plan.some((p) => p.orphaned.length) && <p className="warn">설정에서 없어진 영역의 코드는 파일 끝 "USER CODE BEGIN Orphaned"에 #if 0으로 옮겨 둡니다.</p>}
        <button className="primary" onClick={generate} disabled={!canGenerate || (!dirty && plan.every((p) => p.before === p.after))} data-testid="generate">
          {isCube ? "코드 생성" : "프로젝트 만들기"}
        </button>
        {!canGenerate && <p className="error">오류를 먼저 고치세요(아래 목록).</p>}
        {done && <p className="ok" data-testid="generated">{done}</p>}
      </div>
      <div className="cube-diff" data-testid="diff">
        {ch && (
          <pre>
            {lines.map((l, i) =>
              l.kind === "skip" ? (
                <div key={i} className="d-skip">
                  ⋯ 같은 줄 {l.count}개
                </div>
              ) : (
                <div key={i} className={`d-${l.kind}`}>
                  <span className="d-sign">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
                  {l.text}
                </div>
              ),
            )}
          </pre>
        )}
      </div>
    </div>
  );
}

