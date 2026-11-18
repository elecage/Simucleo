import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas } from "./editor/Canvas";
import { defaultProject, newId, pinKey, toCircuit, type PinRef, type Project } from "./editor/model";
import { PARTS, PART_BY_KIND } from "./parts";
import { nucleoSignal } from "./parts/nucleo";
import { BottomPanel } from "./run/BottomPanel";
import { RunControls, useExamples, type Example } from "./run/RunControls";
import { ProjectMenu } from "./run/ProjectMenu";
import { fromBase64, idbGet, idbSet, parse, serialize, toBase64, type Loaded } from "./editor/project";
import { createSimulator, type Netlist, type SimHandle } from "./sim/simulator";
import { useRunner } from "./sim/useRunner";
import { unlockAudio, useBuzzerAudio } from "./sim/audio";
import type { VisualState } from "./parts/types";
import { colorCode, eSeries, formatOhms, parseOhms, type BandCount } from "./parts/ohms";

const WIRE_COLORS = ["#e53935", "#1e88e5", "#43a047", "#fdd835", "#fb8c00", "#8e24aa", "#212121"];
const CATEGORY_LABEL: Record<string, string> = {
  board: "보드", basic: "기본", input: "입력", output: "출력",
  actuator: "구동", display: "디스플레이", sensor: "센서", module: "모듈",
};

const PROP_LABEL: Record<string, string> = {
  bands: "색띠 수",
  tolerance: "오차",
  tempco: "온도계수 (ppm/K, 6띠)",
  color: "색",
  common: "공통 단자",
  address: "I2C 주소",
  size: "카드 용량 (MB)",
  model: "모델",
  layout: "모양",
  count: "LED 수",
};

const BAND_KO: Record<string, string> = {
  black: "검정", brown: "갈색", red: "빨강", orange: "주황", yellow: "노랑", green: "초록", blue: "파랑",
  violet: "보라", grey: "회색", white: "흰색", gold: "금색", silver: "은색", pink: "분홍",
};

/** Parsed resistance, its colour code in words and its E series. */
function OhmsInfo({ r, props }: { r: number | null; props: Record<string, string | number> }) {
  if (!r) {
    return (
      <span className="error" data-testid="ohms-parsed">
        알 수 없는 값 (예: 220, 4.7k, 4k7, 1M)
      </span>
    );
  }
  const n = Number(props.bands);
  const bands = (n === 3 || n === 5 || n === 6 ? n : 4) as BandCount;
  const code = colorCode(r, bands, String(props.tolerance), String(props.tempco));
  const series = eSeries(r);
  return (
    <span className="dim" data-testid="ohms-parsed">
      {formatOhms(r)} · {code.colors.map((c) => BAND_KO[c] ?? c).join("-")}
      <br />
      {series ? `표준값 ${series}` : "E 계열 표준값이 아닙니다"}
      {code.rounded && (
        <>
          <br />
          <span className="error">
            {bands}띠로는 {formatOhms(code.coded)}로 표시됩니다 (유효숫자 {bands >= 5 ? 3 : 2}자리)
          </span>
        </>
      )}
      {code.outOfRange && (
        <>
          <br />
          <span className="error">색띠로 나타낼 수 있는 범위를 벗어났습니다</span>
        </>
      )}
      {bands === 3 && (
        <>
          <br />
          3띠는 오차 띠가 없습니다 (±20%)
        </>
      )}
    </span>
  );
}

export function App() {
  const [sim, setSim] = useState<SimHandle | null>(null);
  const [simError, setSimError] = useState<string | null>(null);
  const [project, setProject] = useState<Project>(defaultProject);
  const [selected, setSelected] = useState<string | null>(null);
  const [wireColor, setWireColor] = useState(WIRE_COLORS[0]);
  const runner = useRunner();
  const examples = useExamples();
  const [projectName, setProjectName] = useState("새 프로젝트");
  const [notice, setNotice] = useState<string | null>(null);
  const [fitKey, setFitKey] = useState(0);
  /** Centre of the visible canvas, in grid units: where new parts go. */
  const viewCenter = useRef({ x: 60, y: 30 });
  const [reveal, setReveal] = useState<{ id: string; seq: number } | undefined>();

  // ------------------------------------------------ project files
  const { load } = runner;
  const applyLoaded = useCallback(
    async (l: Loaded) => {
      setProject(l.project);
      setFitKey((k) => k + 1);
      setSelected(null);
      setProjectName(l.name ?? "프로젝트");
      setNotice(l.notes.length ? l.notes.join("\n") : null);
      const fw = l.firmware;
      if (fw?.data) {
        load(fw.name, fromBase64(fw.data).buffer as ArrayBuffer, fw.example);
      } else if (fw?.example) {
        const r = await fetch(`./examples/${fw.example}`);
        if (r.ok) load(fw.name, await r.arrayBuffer(), fw.example);
        else setNotice(`예제 펌웨어 ${fw.example}을 찾지 못했습니다.`);
      }
    },
    [load],
  );
  const openText = useCallback(
    (text: string) => {
      try {
        void applyLoaded(parse(text));
      } catch (e) {
        setNotice(`프로젝트를 열지 못했습니다: ${(e as Error).message}`);
      }
    },
    [applyLoaded],
  );
  const dirty = project.wires.length > 0 || project.parts.length > defaultProject().parts.length;
  const confirmReplace = () => !dirty || window.confirm("지금 배선을 바꿀까요? 저장하지 않은 내용은 사라집니다.");
  const onNew = () => {
    if (!confirmReplace()) return;
    setProject(defaultProject());
    setProjectName("새 프로젝트");
    setSelected(null);
  };
  const onExampleProject = async (ex: Example) => {
    if (!confirmReplace()) return;
    const r = await fetch(`./examples/${ex.project}`);
    if (r.ok) openText(await r.text());
  };

  // Autosave to IndexedDB, and restore the last session once the
  // simulator is ready (so its firmware can be loaded too).
  const restored = useRef(false);
  useEffect(() => {
    if (!runner.ready || restored.current) return;
    void idbGet<string>("autosave").then((text) => {
      restored.current = true;
      if (!text) return;
      try {
        void applyLoaded(parse(text));
      } catch {
        // A broken autosave is not worth a message.
      }
    });
  }, [runner.ready, applyLoaded]);
  const { firmware, firmwareBytes, firmwareExample } = runner;
  useEffect(() => {
    if (!restored.current) return;
    const t = setTimeout(() => {
      const fw = firmware
        ? { name: firmware, example: firmwareExample ?? undefined, data: firmwareBytes ? toBase64(firmwareBytes) : undefined }
        : undefined;
      void idbSet("autosave", serialize(project, projectName, fw));
    }, 400);
    return () => clearTimeout(t);
  }, [project, projectName, firmware, firmwareBytes, firmwareExample]);

  // What each part shows, from the circuit simulation. The board's LD2 is
  // simulated like any LED (PA5 → resistor → LED → GND).
  const boardId = project.parts.find((p) => p.kind === "nucleo-f401re")?.id;
  const visuals = useMemo<Record<string, VisualState>>(() => {
    const out: Record<string, VisualState> = {};
    for (const v of runner.frame?.parts ?? []) {
      const state: VisualState = {
        brightness: v.brightness?.[0],
        channels: v.brightness,
        overcurrent: v.overcurrent,
        on: v.on,
        freq: v.freq,
        angle: v.angle,
        rpm: v.rpm,
        unpowered: v.unpowered,
        screen: v.screen,
        text: v.text,
        leds: v.leds,
      };
      if (v.id === "LD2") {
        if (boardId) out[boardId] = { ...out[boardId], brightness: state.brightness, overcurrent: state.overcurrent };
      } else if (v.id !== "B1") {
        out[v.id] = state;
      }
    }
    return out;
  }, [runner.frame, boardId]);
  const [sound, setSound] = useState(false);
  useBuzzerAudio(visuals, project.parts, sound && runner.running);

  const { press, reset, setWiring, ready } = runner;
  const onPartAction = useCallback(
    (part: string, action: string, down: boolean) => {
      if (action === "b1") press("B1", down);
      else if (action === "reset") {
        if (down) reset();
      } else if (action === "press") press(part, down);
    },
    [press, reset],
  );

  // Hot-plug into the running simulation: every edit re-sends the wiring.
  useEffect(() => {
    if (ready) setWiring(toCircuit(project));
  }, [ready, project, setWiring]);

  useEffect(() => {
    createSimulator().then(setSim, (e) => setSimError(String(e)));
  }, []);

  // Hot-plug: every edit re-sends the circuit, even while firmware runs.
  const netlist: Netlist = useMemo(
    () => (sim ? sim.setCircuit(toCircuit(project)) : { nets: [] }),
    [sim, project],
  );
  const netIndex = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const net of netlist.nets) {
      const set = new Set(net.pins.map(pinKey));
      for (const k of set) m.set(k, set);
    }
    return m;
  }, [netlist]);
  const netOf = useCallback((p: PinRef) => netIndex.get(pinKey(p)) ?? new Set([pinKey(p)]), [netIndex]);

  // Nets that join two or more parts (breadboards excluded), with Nucleo pins
  // shown by signal so D13 and CN10-11 both read "nucleo.PA5".
  const visibleNets = useMemo(() => {
    const out: string[] = [];
    for (const net of netlist.nets) {
      const names = new Set<string>();
      const parts = new Set<string>();
      for (const p of net.pins) {
        const kind = project.parts.find((q) => q.id === p.part)?.kind;
        if (kind?.startsWith("breadboard")) continue;
        names.add(kind === "nucleo-f401re" ? `${p.part}.${nucleoSignal(p.pin)}` : `${p.part}.${p.pin}`);
        parts.add(p.part);
      }
      if (parts.size >= 2) out.push([...names].sort().join(" — "));
    }
    return out.sort();
  }, [netlist, project.parts]);

  const taken = () => new Set([...project.parts.map((p) => p.id), ...project.wires.map((w) => w.id)]);

  const addPart = (kind: string) => {
    const def = PART_BY_KIND[kind];
    const id = newId(kind.split("-")[0], taken());
    // Drop the part where the user is looking: the first free spot around
    // the centre of the view, where none of its pins lands on an existing
    // pin (pins at the same point are connected) or inside its body.
    const used = new Set<string>();
    for (const p of project.parts) {
      for (const q of PART_BY_KIND[p.kind]?.pins ?? []) used.add(`${p.x + q.x},${p.y + q.y}`);
    }
    const c = viewCenter.current;
    const fits = (x: number, y: number) =>
      def.pins.every((q) => {
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (used.has(`${x + q.x + dx},${y + q.y + dy}`)) return false;
        return true;
      }) &&
      // Nor over another part's body (a board or breadboard would also plug
      // it in by accident); keep a one-step margin, and room for labels above.
      !project.parts.some((p) => {
        const d = PART_BY_KIND[p.kind];
        return d && x + def.w + 1 >= p.x && x - 1 <= p.x + d.w && y + def.h + 1 >= p.y - 1 && y - 2 <= p.y + d.h;
      });
    let x = Math.round(c.x - def.w / 2);
    let y = Math.round(c.y - def.h / 2);
    search: for (let ring = 0; ring < 40; ring++) {
      for (let i = -ring; i <= ring; i++) {
        for (const [dx, dy] of [[i * 2, -ring * 2], [i * 2, ring * 2], [-ring * 2, i * 2], [ring * 2, i * 2]]) {
          if (fits(x + dx, y + dy)) {
            x += dx;
            y += dy;
            break search;
          }
        }
      }
    }
    setProject((p) => ({ ...p, parts: [...p.parts, { id, kind, x, y, props: { ...def.props } }] }));
    setSelected(id);
    setReveal((r) => ({ id, seq: (r?.seq ?? 0) + 1 }));
  };

  const deleteSelected = useCallback(() => {
    if (!selected) return;
    setProject((p) => ({
      parts: p.parts.filter((x) => x.id !== selected),
      wires: p.wires.filter((w) => w.id !== selected && w.a.part !== selected && w.b.part !== selected),
    }));
    setSelected(null);
  }, [selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "Delete" || e.key === "Backspace") && !(e.target instanceof HTMLInputElement)) deleteSelected();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteSelected]);

  const selectedPart = project.parts.find((p) => p.id === selected);
  const selectedWire = project.wires.find((w) => w.id === selected);
  const selectedDef = selectedPart && PART_BY_KIND[selectedPart.kind];
  const categories = [...new Set(PARTS.map((p) => p.category))];

  return (
    <div className="app">
      <header className="toolbar">
        <strong>Simucleo</strong>
        <input
          className="project-name"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          aria-label="프로젝트 이름"
        />
        <ProjectMenu project={project} name={projectName} runner={runner} onNew={onNew} onOpenText={openText} />
        <RunControls runner={runner} examples={examples} onExampleProject={onExampleProject} />
        <label className="sound-toggle" title="부저 소리 (브라우저 정책상 클릭으로 켜야 합니다)">
          <input
            type="checkbox"
            checked={sound}
            onChange={(e) => {
              if (e.target.checked) unlockAudio();
              setSound(e.target.checked);
            }}
          />{" "}
          🔊 소리
        </label>
        <span className="version" title="시뮬레이터 코어 버전">
          {simError ? `WASM 로드 실패: ${simError}` : sim ? `core v${sim.version}` : "WASM 로딩 중…"}
        </span>
      </header>

      <aside className="library">
        {categories.map((cat) => (
          <section key={cat}>
            <h3>{CATEGORY_LABEL[cat]}</h3>
            {PARTS.filter((p) => p.category === cat).map((p) => (
              <button key={p.kind} onClick={() => addPart(p.kind)}>{p.name}</button>
            ))}
          </section>
        ))}
        <section>
          <h3>와이어 색</h3>
          <div className="swatches">
            {WIRE_COLORS.map((c) => (
              <button
                key={c}
                className={c === wireColor ? "swatch on" : "swatch"}
                style={{ background: c }}
                onClick={() => setWireColor(c)}
                aria-label={c}
              />
            ))}
          </div>
        </section>
      </aside>

      <main>
        <Canvas
          project={project}
          netOf={netOf}
          selected={selected}
          onSelect={setSelected}
          onMovePart={(id, x, y) =>
            setProject((p) => ({ ...p, parts: p.parts.map((q) => (q.id === id ? { ...q, x, y } : q)) }))
          }
          visuals={visuals}
          onPartAction={onPartAction}
          fitKey={fitKey}
          onViewCenter={(p) => (viewCenter.current = p)}
          reveal={reveal}
          onAddWire={(a, b, points) =>
            setProject((p) => {
              // Both ends must exist when the wire is made (#2).
              const exists = (r: PinRef) => p.parts.some((q) => q.id === r.part);
              if (!exists(a) || !exists(b)) return p;
              const wire = { id: newId("w", taken()), a, b, color: wireColor, ...(points.length ? { points } : {}) };
              return { ...p, wires: [...p.wires, wire] };
            })
          }
          onPropChange={(id, key, value) =>
            setProject((p) => ({
              ...p,
              parts: p.parts.map((q) => (q.id === id ? { ...q, props: { ...q.props, [key]: value } } : q)),
            }))
          }
          onMoveWireEnd={(id, end, pin) =>
            setProject((p) => ({ ...p, wires: p.wires.map((w) => (w.id === id ? { ...w, [end]: pin } : w)) }))
          }
          onUpdateWire={(id, points) =>
            setProject((p) => ({ ...p, wires: p.wires.map((w) => (w.id === id ? { ...w, points } : w)) }))
          }
        />
        {runner.frame?.stopped && (
          <div className="diagnosis" role="alert">
            <b>펌웨어가 멈췄습니다.</b> {runner.frame.stopped}
          </div>
        )}
        {notice && (
          <div className="notice" role="status">
            {notice} <button onClick={() => setNotice(null)} aria-label="닫기">×</button>
          </div>
        )}
        <div className="warnings">
          {runner.frame?.circuitWarnings.map((w) => (
            <div key={w} className="warning circuit" data-testid="circuit-warning">
              ⚡ 전기 규칙: {w}
            </div>
          ))}
          {runner.frame?.warnings.map((w) => (
            <div key={w} className="warning">
              ⚠ {w}
            </div>
          ))}
        </div>
      </main>

      <BottomPanel runner={runner} />

      <aside className="inspector">
        <h3>속성</h3>
        {selectedPart && selectedDef ? (
          <>
            <p><b>{selectedPart.id}</b> · {selectedDef.name}</p>
            {selectedDef.description && <p className="hint">{selectedDef.description}</p>}
            {Object.entries(selectedPart.props).map(([k, v]) => {
              // Resistor: tolerance has no band on 3-band parts, the
              // temperature coefficient only on 6-band parts.
              const nb = String(selectedPart.props.bands ?? "");
              if ((k === "tolerance" && nb === "3") || (k === "tempco" && nb !== "6")) return null;
              const set = (value: string) =>
                setProject((p) => ({
                  ...p,
                  parts: p.parts.map((q) => (q.id === selectedPart.id ? { ...q, props: { ...q.props, [k]: value } } : q)),
                }));
              const setNum = (value: number) =>
                setProject((p) => ({
                  ...p,
                  parts: p.parts.map((q) => (q.id === selectedPart.id ? { ...q, props: { ...q.props, [k]: value } } : q)),
                }));
              const options = selectedDef.propOptions?.[k];
              const range = selectedDef.ranges?.[k];
              if (range) {
                // Live input: a slider (log scale for light), plus the value.
                const num = Number(v);
                const toSlider = (x: number) => (range.log ? Math.log10(Math.max(range.min, x)) : x);
                const fromSlider = (x: number) => (range.log ? Math.round(10 ** x) : x);
                return (
                  <label key={k} className="prop">
                    {range.label}: {range.unit ? `${num} ${range.unit}` : `${Math.round(num * 100)}%`}
                    <input
                      type="range"
                      aria-label={k}
                      min={toSlider(range.min)}
                      max={toSlider(range.max)}
                      step={range.log ? 0.01 : range.step}
                      value={toSlider(num)}
                      onChange={(e) => setNum(fromSlider(Number(e.target.value)))}
                    />
                  </label>
                );
              }
              if (k === "ohms") {
                // Any value: typed, or picked from common ones.
                const r = parseOhms(v);
                return (
                  <label key={k} className="prop">
                    저항값 (Ω)
                    <input value={String(v)} onChange={(e) => set(e.target.value)} list="ohms-list" aria-label={k} />
                    <datalist id="ohms-list">
                      {options?.map((o) => <option key={o} value={o} />)}
                    </datalist>
                    <OhmsInfo r={r} props={selectedPart.props} />
                  </label>
                );
              }
              return (
                <label key={k} className="prop">
                  {PROP_LABEL[k] ?? k}
                  {options ? (
                    <select value={String(v)} onChange={(e) => set(e.target.value)} aria-label={k}>
                      {[...new Set([...options, String(v)])].map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  ) : (
                    <input value={String(v)} onChange={(e) => set(e.target.value)} aria-label={k} />
                  )}
                </label>
              );
            })}
            {selectedPart.kind === "sd-card" && <SdImageButtons part={selectedPart.id} runner={runner} />}
            <button onClick={deleteSelected}>삭제</button>
          </>
        ) : selectedWire ? (
          <>
            <p>
              <b>와이어</b> {selectedWire.a.part}.{selectedWire.a.pin} — {selectedWire.b.part}.{selectedWire.b.pin}
            </p>
            <div className="swatches">
              {WIRE_COLORS.map((c) => (
                <button
                  key={c}
                  className={c === selectedWire.color ? "swatch on" : "swatch"}
                  style={{ background: c }}
                  aria-label={`와이어 색 ${c}`}
                  onClick={() =>
                    setProject((p) => ({ ...p, wires: p.wires.map((w) => (w.id === selectedWire.id ? { ...w, color: c } : w)) }))
                  }
                />
              ))}
            </div>
            <p className="hint">양 끝의 네모를 끌어 다른 핀에 놓으면 끝점이 옮겨집니다. 꺾는 점은 끌어서 옮기고, 더블클릭하면 지웁니다.</p>
            {(selectedWire.points?.length ?? 0) > 0 && (
              <button
                onClick={() =>
                  setProject((p) => ({ ...p, wires: p.wires.map((w) => (w.id === selectedWire.id ? { ...w, points: [] } : w)) }))
                }
              >
                꺾는 점 모두 지우기
              </button>
            )}{" "}
            <button onClick={deleteSelected}>삭제</button>
          </>
        ) : (
          <p className="hint">
            부품이나 와이어를 선택하세요.
            <br />
            배선: 핀을 클릭한 뒤 다른 핀을 클릭하거나, 핀에서 끌어다 놓기. 가는 길에 빈 곳을 클릭하면 꺾는 점.
            <br />
            Delete 삭제 · 휠/＋−로 확대·축소 · 빈 곳 끌기로 이동
          </p>
        )}
        <h3>넷리스트 ({visibleNets.length})</h3>
        <ul className="nets">
          {visibleNets.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

/** Download or replace the contents of a simulated SD card. */
function SdImageButtons({ part, runner }: { part: string; runner: ReturnType<typeof useRunner> }) {
  const input = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="prop">
      카드 내용 (디스크 이미지)
      <div>
        <button
          onClick={async () => {
            const img = await runner.sdImage(part);
            if (!img.length) return setMsg("카드가 아직 회로에 없습니다.");
            const url = URL.createObjectURL(new Blob([img], { type: "application/octet-stream" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = `${part}.img`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            setMsg(`${(img.length / 1048576).toFixed(0)} MB 이미지를 내려받았습니다.`);
          }}
        >
          이미지 내려받기
        </button>{" "}
        <button onClick={() => input.current?.click()}>이미지 넣기</button>
        <input
          ref={input}
          type="file"
          accept=".img,.bin,application/octet-stream"
          hidden
          data-testid="sd-image-input"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            runner.sdLoad(part, await f.arrayBuffer());
            setMsg(`${f.name}을(를) 카드에 넣었습니다.`);
          }}
        />
      </div>
      {msg && <span className="hint">{msg}</span>}
    </div>
  );
}
