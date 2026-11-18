// RTOS view: the FreeRTOS tasks of the running firmware (state, priority,
// stack, CPU share) and a timeline of which task ran when.
import { useRef, useState } from "react";
import type { RtosTask } from "../sim/protocol";
import type { Runner } from "../sim/useRunner";

const STATE_KO: Record<RtosTask["state"], string> = {
  running: "실행 중",
  ready: "준비",
  blocked: "대기",
  suspended: "일시중단",
  deleted: "삭제됨",
};

/** CMSIS-RTOS2 priority names (osPriority values); ST's wrapper runs tasks at osPriority − 1. */
function cmsisPriority(kernel: number): string {
  const p = kernel + 1;
  const base: [number, string][] = [
    [1, "Idle"],
    [8, "Low"],
    [16, "BelowNormal"],
    [24, "Normal"],
    [32, "AboveNormal"],
    [40, "High"],
    [48, "Realtime"],
  ];
  if (p === 56) return "ISR";
  for (let i = base.length - 1; i >= 0; i--) {
    const [v, name] = base[i];
    if (p >= v) return p === v ? name : `${name}${p - v}`;
  }
  return String(p);
}

/** Tasks the kernel creates itself (not through CMSIS-RTOS2). */
const KERNEL_TASKS = new Set(["IDLE", "Tmr Svc"]);

const WINDOWS: [string, number][] = [
  ["20 ms", 20],
  ["200 ms", 200],
  ["2 s", 2000],
];
const WIDTH = 1000;
const ROW = 22;

export function RtosView({ runner }: { runner: Runner }) {
  const [windowMs, setWindowMs] = useState(20);
  // History of switches: (time ms, tcb), plus the task before the first one.
  const hist = useRef<{ start: number | null; switches: [number, number][]; last: unknown; time: number }>({
    start: null,
    switches: [],
    last: null,
    time: 0,
  });
  const cpuAvg = useRef(new Map<number, number>());
  const f = runner.frame;
  const rtos = f?.rtos;
  if (f && rtos && f !== hist.current.last) {
    const h = hist.current;
    h.last = f;
    if (f.timeMs < h.time) {
      h.switches = [];
      h.start = null;
      cpuAvg.current.clear();
    }
    h.time = f.timeMs;
    if (h.start === null && h.switches.length === 0) h.start = rtos.snapshot.current;
    h.switches.push(...rtos.switches);
    const keepFrom = f.timeMs - 2 * WINDOWS[WINDOWS.length - 1][1];
    let drop = 0;
    while (drop < h.switches.length && h.switches[drop][0] < keepFrom) drop++;
    if (drop > 0) {
      h.start = h.switches[drop - 1][1];
      h.switches.splice(0, drop);
    }
    // CPU share, smoothed over about a second of frames.
    for (const t of rtos.snapshot.tasks) {
      const now = rtos.cpu[String(t.tcb)] ?? 0;
      const prev = cpuAvg.current.get(t.tcb);
      cpuAvg.current.set(t.tcb, prev === undefined ? now : prev * 0.94 + now * 0.06);
    }
  }

  if (!f) return <p className="hint">펌웨어를 불러오면 RTOS 태스크가 보입니다.</p>;
  if (!rtos) {
    return (
      <p className="hint">
        이 펌웨어에서 RTOS를 찾지 못했습니다. FreeRTOS(CubeMX의 CMSIS-RTOS v2 포함)를 쓰는 펌웨어를 불러오세요.
      </p>
    );
  }
  const snap = rtos.snapshot;
  const cmsis = snap.api === "CMSIS-RTOS2";
  const tasks = [...snap.tasks].sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));

  // Running segments per task in the window.
  const now = f.timeMs;
  const from = now - windowMs;
  const x = (t: number) => ((Math.max(t, from) - from) / windowMs) * WIDTH;
  const segments = new Map<number, [number, number][]>();
  let cur = hist.current.start;
  let since = -Infinity;
  for (const [t, tcb] of hist.current.switches) {
    if (cur !== null && t > from) (segments.get(cur) ?? segments.set(cur, []).get(cur)!).push([since, t]);
    cur = tcb;
    since = t;
  }
  if (cur !== null) (segments.get(cur) ?? segments.set(cur, []).get(cur)!).push([since, now]);

  return (
    <div className="rtos">
      <div className="wave-controls">
        <b>
          {snap.kernel}
          {snap.api ? ` · ${snap.api}` : ""}
        </b>
        <span className="dim">
          tick {snap.tick} · 태스크 {snap.tasks.length}
          {snap.schedulerRunning ? "" : " · 스케줄러 시작 전"}
        </span>
        <label>
          타임라인 폭{" "}
          <select value={windowMs} onChange={(e) => setWindowMs(Number(e.target.value))} aria-label="타임라인 폭">
            {WINDOWS.map(([l, v]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        {rtos.dense && <span className="error">전환이 너무 잦아 일부만 표시</span>}
      </div>
      <table className="rtos-tasks">
        <thead>
          <tr>
            <th>태스크</th>
            <th>상태</th>
            <th>우선순위</th>
            <th>스택 (최대 사용)</th>
            <th>CPU</th>
            <th className="lane-head">실행 타임라인 (최근 {windowMs} ms)</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => {
            const used = t.stackSize !== null && t.stackFreeMin !== null ? t.stackSize - t.stackFreeMin : null;
            const ratio = used !== null && t.stackSize ? used / t.stackSize : null;
            const cpu = cpuAvg.current.get(t.tcb) ?? 0;
            return (
              <tr key={t.tcb} data-task={t.name}>
                <td>
                  <b>{t.name || "(이름 없음)"}</b>
                </td>
                <td>
                  <span className={`badge ${t.state}`} data-testid={`task-state-${t.name}`}>
                    {STATE_KO[t.state]}
                  </span>
                </td>
                <td title={cmsis ? "CMSIS osPriority (FreeRTOS 우선순위)" : "FreeRTOS 우선순위"}>
                  {cmsis && !KERNEL_TASKS.has(t.name) ? `${cmsisPriority(t.priority)} (${t.priority})` : t.priority}
                </td>
                <td>
                  {used !== null ? (
                    <span className={ratio! > 0.9 ? "stack danger" : ratio! > 0.75 ? "stack warn" : "stack"}>
                      <span className="stack-bar">
                        <span style={{ width: `${Math.min(100, ratio! * 100)}%` }} />
                      </span>
                      {used} / {t.stackSize} B
                    </span>
                  ) : (
                    <span className="dim">알 수 없음</span>
                  )}
                </td>
                <td data-testid={`task-cpu-${t.name}`}>{(cpu * 100).toFixed(cpu < 0.1 ? 1 : 0)}%</td>
                <td className="lane">
                  <svg viewBox={`0 0 ${WIDTH} ${ROW}`} preserveAspectRatio="none" className="lane-svg">
                    {(segments.get(t.tcb) ?? []).map(([a, b], i) => (
                      <rect key={i} x={x(a)} width={Math.max(0.8, x(b) - x(a))} y={3} height={ROW - 6} className={t.name === "IDLE" ? "run idle" : "run"} />
                    ))}
                  </svg>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
