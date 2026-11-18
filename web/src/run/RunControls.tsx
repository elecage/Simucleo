import { useEffect, useState } from "react";
import type { Runner } from "../sim/useRunner";

export interface Example {
  name: string;
  file: string;
  description: string;
  /** A project file with the wiring this firmware expects. */
  project?: string;
}

const SPEEDS: [string, number][] = [
  ["×0.01", 0.01],
  ["×0.1", 0.1],
  ["×0.5", 0.5],
  ["×1 실시간", 1],
  ["×2", 2],
  ["×10", 10],
  ["최대", Infinity],
];

/** Example firmware bundled with the site (built in CI). */
export function useExamples(): Example[] {
  const [examples, setExamples] = useState<Example[]>([]);
  useEffect(() => {
    fetch("./examples/index.json")
      .then((r) => (r.ok ? r.json() : []))
      .then(setExamples, () => setExamples([]));
  }, []);
  return examples;
}

export function RunControls({
  runner,
  examples,
  onExampleProject,
}: {
  runner: Runner;
  examples: Example[];
  /** Load the wiring that comes with an example. */
  onExampleProject?: (ex: Example) => void;
}) {
  const [speedLabel, setSpeedLabel] = useState("×1 실시간");
  const f = runner.frame;
  const loaded = runner.firmware !== null;

  const loadExample = async (file: string) => {
    const ex = examples.find((e) => e.file === file);
    if (!ex) return;
    if (ex.project && onExampleProject) {
      onExampleProject(ex); // loads the wiring and the firmware
      return;
    }
    const bytes = await (await fetch(`./examples/${ex.file}`)).arrayBuffer();
    runner.load(ex.name, bytes, ex.file);
  };

  return (
    <div className="run-controls">
      <label className="file-btn">
        ELF 업로드
        <input
          type="file"
          accept=".elf"
          hidden
          data-testid="elf-input"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) runner.load(file.name, await file.arrayBuffer());
            e.target.value = "";
          }}
        />
      </label>
      {examples.length > 0 && (
        <select
          aria-label="예제 펌웨어"
          value=""
          onChange={(e) => loadExample(e.target.value)}
          title="CubeMX HAL 등으로 만든 예제 펌웨어"
        >
          <option value="">예제 불러오기…</option>
          {examples.map((ex) => (
            <option key={ex.file} value={ex.file} title={ex.description}>
              {ex.name}
              {ex.project ? " (배선 포함)" : ""}
            </option>
          ))}
        </select>
      )}
      {runner.running ? (
        <button onClick={runner.pause}>⏸ 일시정지</button>
      ) : (
        <button onClick={runner.run} disabled={!loaded || !!f?.stopped}>
          ▶ 실행
        </button>
      )}
      <button onClick={runner.reset} disabled={!loaded} title="B2 RESET 버튼과 같습니다">
        ⟲ 리셋
      </button>
      <select
        aria-label="실행 속도"
        value={speedLabel}
        onChange={(e) => {
          setSpeedLabel(e.target.value);
          runner.setSpeed(SPEEDS.find(([l]) => l === e.target.value)![1]);
        }}
      >
        {SPEEDS.map(([l]) => (
          <option key={l}>{l}</option>
        ))}
      </select>
      <span className="status" data-testid="run-status">
        {!runner.ready
          ? "시뮬레이터 로딩 중…"
          : runner.loadError
            ? `로드 실패: ${runner.loadError}`
            : loaded && f
              ? `${runner.firmware} · ${(f.timeMs / 1000).toFixed(3)} s · ${(f.clockHz / 1e6).toFixed(1)} MHz` +
                (runner.running ? ` · 실제 ×${runner.speed >= 100 ? runner.speed.toFixed(0) : runner.speed.toFixed(2)}` : "")
              : "펌웨어(ELF)를 올리거나 예제를 고르세요"}
      </span>
    </div>
  );
}
