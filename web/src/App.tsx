import { useCallback, useEffect, useMemo, useState } from "react";
import { Canvas } from "./editor/Canvas";
import { defaultProject, newId, pinKey, toCircuit, type PinRef, type Project } from "./editor/model";
import { PARTS, PART_BY_KIND } from "./parts";
import { nucleoSignal } from "./parts/nucleo";
import { createSimulator, type Netlist, type SimHandle } from "./sim/simulator";

const WIRE_COLORS = ["#e53935", "#1e88e5", "#43a047", "#fdd835", "#fb8c00", "#8e24aa", "#212121"];
const CATEGORY_LABEL: Record<string, string> = {
  board: "보드", basic: "기본", input: "입력", output: "출력",
  actuator: "구동", display: "디스플레이", sensor: "센서", module: "모듈",
};

export function App() {
  const [sim, setSim] = useState<SimHandle | null>(null);
  const [simError, setSimError] = useState<string | null>(null);
  const [project, setProject] = useState<Project>(defaultProject);
  const [selected, setSelected] = useState<string | null>(null);
  const [wireColor, setWireColor] = useState(WIRE_COLORS[0]);
  const [firmware, setFirmware] = useState<string | null>(null);

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
    // Drop new parts below the default board/breadboard, staggered so they never stack.
    const n = project.parts.length;
    const x = 42 + ((n * 4) % 28);
    const y = 32 + 4 * Math.floor(n / 7);
    setProject((p) => ({ ...p, parts: [...p.parts, { id, kind, x, y, props: { ...def.props } }] }));
    setSelected(id);
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

  const onElf = async (file: File) => {
    if (!sim) return;
    try {
      sim.loadElf(new Uint8Array(await file.arrayBuffer()));
      setFirmware(`${file.name} — reset PC = 0x${sim.pc().toString(16).padStart(8, "0")}`);
    } catch (e) {
      setFirmware(`로드 실패: ${e}`);
    }
  };

  const selectedPart = project.parts.find((p) => p.id === selected);
  const selectedDef = selectedPart && PART_BY_KIND[selectedPart.kind];
  const categories = [...new Set(PARTS.map((p) => p.category))];

  return (
    <div className="app">
      <header className="toolbar">
        <strong>Simucleo</strong>
        <label className="file-btn">
          ELF 업로드
          <input type="file" accept=".elf" hidden onChange={(e) => e.target.files?.[0] && onElf(e.target.files[0])} />
        </label>
        <button disabled title="CPU 코어 구현 후 활성화 (M0)">▶ 실행</button>
        <span className="status">
          {simError ? `WASM 로드 실패: ${simError}` : sim ? `core v${sim.version}` : "WASM 로딩 중…"}
          {firmware && ` · ${firmware}`}
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
          onAddWire={(a, b) =>
            setProject((p) => ({ ...p, wires: [...p.wires, { id: newId("w", taken()), a, b, color: wireColor }] }))
          }
        />
      </main>

      <aside className="inspector">
        <h3>속성</h3>
        {selectedPart && selectedDef ? (
          <>
            <p><b>{selectedPart.id}</b> · {selectedDef.name}</p>
            {Object.entries(selectedPart.props).map(([k, v]) => (
              <label key={k} className="prop">
                {k}
                <input
                  value={String(v)}
                  onChange={(e) =>
                    setProject((p) => ({
                      ...p,
                      parts: p.parts.map((q) => (q.id === selectedPart.id ? { ...q, props: { ...q.props, [k]: e.target.value } } : q)),
                    }))
                  }
                />
              </label>
            ))}
            <button onClick={deleteSelected}>삭제</button>
          </>
        ) : (
          <p className="hint">부품이나 와이어를 선택하세요.<br />핀 클릭 → 다른 핀 클릭으로 배선, Esc 취소, Delete 삭제, 휠로 확대.</p>
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
