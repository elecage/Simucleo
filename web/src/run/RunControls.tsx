import { useEffect, useState } from "react";
import type { Runner } from "../sim/useRunner";
import { usePerf } from "../sim/perfStore";
import { formatRatio } from "../sim/perf";
import { t } from "../i18n";

export interface Example {
  name: string;
  file: string;
  description: string;
  /** A project file with the wiring this firmware expects. */
  project?: string;
  /** M33: the code tab can start from it (its main.c under examples/src/). */
  code?: { template: "hal"; main: string };
}

const SPEEDS: [string, number][] = [
  ["×0.01", 0.01],
  ["×0.1", 0.1],
  ["×0.5", 0.5],
  [t("×1 실시간"), 1],
  ["×2", 2],
  ["×10", 10],
  [t("최대"), Infinity],
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
  onUserLoad,
}: {
  runner: Runner;
  examples: Example[];
  /** Load the wiring that comes with an example. */
  onExampleProject?: (ex: Example) => void;
  /** Firmware loaded here (an upload, an example without wiring): newer than any load still on its way. */
  onUserLoad?: () => void;
}) {
  const [speedLabel, setSpeedLabel] = useState(t("×1 실시간"));
  const f = runner.frame;
  // What the screen shows (M31): the slower of the worker's pace and the page's.
  const shown = usePerf().ratio;
  const loaded = runner.firmware !== null;

  const loadExample = async (file: string) => {
    const ex = examples.find((e) => e.file === file);
    if (!ex) return;
    if (ex.project && onExampleProject) {
      onExampleProject(ex); // loads the wiring and the firmware
      return;
    }
    onUserLoad?.();
    const bytes = await (await fetch(`./examples/${ex.file}`)).arrayBuffer();
    runner.load(ex.name, bytes, ex.file);
  };

  return (
    <div className="run-controls">
      <label className="file-btn">
        {t("ELF 업로드")}
        <input
          type="file"
          accept=".elf"
          hidden
          data-testid="elf-input"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) {
              onUserLoad?.();
              runner.load(file.name, await file.arrayBuffer());
            }
            e.target.value = "";
          }}
        />
      </label>
      {examples.length > 0 && (
        <select
          aria-label={t("예제 펌웨어")}
          value=""
          onChange={(e) => loadExample(e.target.value)}
          title={t("CubeMX HAL 등으로 만든 예제 펌웨어")}
        >
          <option value="">{t("예제 불러오기…")}</option>
          {examples.map((ex) => (
            <option key={ex.file} value={ex.file} title={ex.description}>
              {ex.name}
              {ex.project ? t(" (배선 포함)") : ""}
            </option>
          ))}
        </select>
      )}
      {/* Run and Pause share one width, the wider label's (the other is laid
          out but hidden, and not part of the button's name): starting the
          simulation must not reflow the toolbar. */}
      {runner.running ? (
        <button className="run-toggle" onClick={() => runner.pause()}>
          <span>{t("⏸ 일시정지")}</span>
          <span className="ghost" aria-hidden="true">{t("▶ 실행")}</span>
        </button>
      ) : (
        <button className="run-toggle" onClick={runner.run} disabled={!loaded || !!f?.stopped}>
          <span>{t("▶ 실행")}</span>
          <span className="ghost" aria-hidden="true">{t("⏸ 일시정지")}</span>
        </button>
      )}
      <button onClick={runner.reset} disabled={!loaded} title={t("B2 RESET 버튼과 같습니다")}>
        {t("⟲ 리셋")}
      </button>
      <select
        aria-label={t("실행 속도")}
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
          ? t("시뮬레이터 로딩 중…")
          : runner.loadError
            ? t("로드 실패: {error}", { error: runner.loadError })
            : loaded && f
              ? `${runner.firmware} · ${(f.timeMs / 1000).toFixed(3)} s · ${(f.clockHz / 1e6).toFixed(1)} MHz` +
                (runner.running ? t(" · 실제 {ratio}", { ratio: formatRatio(shown ?? runner.speed) }) : "")
              : t("펌웨어(ELF)를 올리거나 예제를 고르세요")}
      </span>
    </div>
  );
}
