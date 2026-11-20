// 성능 모드 and the device check in the UI (M31). The button sits in the
// status slot at the right end of the bottom tab row (next to the offline
// status, M29); the popover floats above it (position: fixed). Neither the
// toolbar nor the canvas ever moves for them.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { dismissPerfNotice, setPerfMode, usePerf } from "../sim/perfStore";
import { formatRatio, ENOUGH, SLOW, type PerfMode } from "../sim/perf";
import { CHECK_EXAMPLES, runDeviceCheck, type CheckResult } from "../sim/deviceCheck";
import type { BenchReply } from "../sim/benchWorker";
import type { Runner } from "../sim/useRunner";

const MODE_LABEL: Record<PerfMode, string> = { auto: "자동", off: "끄기", on: "켜기" };
const MODE_HINT: Record<PerfMode, string> = {
  auto: "화면 그리기 때문에 실시간을 못 따라가면 저절로 켠다",
  off: "항상 모든 프레임을 그린다",
  on: "항상 가볍게 그린다",
};

/** The 성능 button (and the notice when auto mode switched on) for the status slot. */
export function PerfStatus({ runner }: { runner: Runner }) {
  const p = usePerf();
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const label = p.notice ? "⚡ 성능 모드 켜짐" : p.lite ? "⚡ 성능 모드" : "⚡ 성능";
  return (
    <>
      <button
        ref={btn}
        className={p.notice ? "perf-btn notice" : p.lite ? "perf-btn on" : "perf-btn"}
        data-testid="perf-button"
        data-lite={p.lite ? "1" : "0"}
        onClick={() => {
          setOpen(!open);
          dismissPerfNotice();
        }}
        aria-expanded={open}
        title={
          p.notice
            ? "화면을 그리느라 시뮬레이션이 실시간을 못 따라가서 성능 모드를 켰습니다. 시뮬레이션 결과는 그대로이고 화면만 덜 자주 그립니다."
            : "성능 모드와 기기 점검 (이 기기에서 잘 돌아갈까?)"
        }
      >
        {label}
      </button>
      {/* On the body: out of the slot's overflow clipping, over everything. */}
      {open && createPortal(<PerfPopover runner={runner} anchor={btn} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function PerfPopover({ runner, anchor, onClose }: { runner: Runner; anchor: RefObject<HTMLButtonElement | null>; onClose: () => void }) {
  const p = usePerf();
  // Above the button, right edges lined up; kept there on resize.
  const [at, setAt] = useState({ right: 8, bottom: 8, maxHeight: 400 });
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r || r.height === 0) return;
      const bottom = Math.max(8, window.innerHeight - r.top + 6);
      setAt({ right: Math.max(8, window.innerWidth - r.right), bottom, maxHeight: Math.max(160, window.innerHeight - bottom - 8) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor, p]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="perf-pop" style={at} role="dialog" aria-label="성능 모드" data-testid="perf-popover">
      <div className="perf-head">
        <b>성능 모드</b>
        <button className="perf-close" onClick={onClose} aria-label="성능 모드 닫기">
          ✕
        </button>
      </div>
      <div className="perf-modes" role="radiogroup" aria-label="성능 모드 설정">
        {(["auto", "off", "on"] as PerfMode[]).map((m) => (
          <label key={m} title={MODE_HINT[m]}>
            <input type="radio" name="perf-mode" checked={p.mode === m} onChange={() => setPerfMode(m)} /> {MODE_LABEL[m]}
          </label>
        ))}
      </div>
      <p className="hint">
        {MODE_HINT[p.mode]}. 켜면 화면을 덜 자주 그리고(초당 30 → 15 → 10 → 5번), 화면 밖 부품과 빛 번짐 효과는 그리지 않고, 파형은 초당 10번까지만 다시 그린다.
        시뮬레이션 결과(펌웨어 동작, 채점, 파형 캡처)는 똑같다.
      </p>
      <dl className="perf-stats" data-testid="perf-stats">
        <dt>상태</dt>
        <dd data-testid="perf-state">{p.lite ? (p.mode === "auto" ? "켜짐 (자동)" : "켜짐") : "꺼짐"}</dd>
        <dt>실제 배속</dt>
        <dd data-testid="perf-ratio">{p.ratio === null ? "—" : formatRatio(p.ratio)}</dd>
        <dt>화면 갱신</dt>
        <dd>
          초당 {p.updateHz.toFixed(0)}번{p.lite ? ` (최대 ${p.hz})` : ""}
        </dd>
        <dt>화면 그리기</dt>
        <dd data-testid="perf-ui">
          {p.uiMs.toFixed(1)} ms/번 · 화면 스레드 {Math.round(p.busy * 100)}%
        </dd>
      </dl>
      <DeviceCheck runner={runner} />
    </div>
  );
}

const VERDICT_HINT: Record<string, string> = {
  충분: "이 기기는 예제를 실시간으로 넉넉히 돌린다.",
  "성능 모드 권장": "실시간은 되지만 여유가 적다. 성능 모드를 켜거나 자동으로 둔다.",
  느림: "화면 없이도 실시간을 못 따라간다. 시간은 느리게 가지만 결과는 같다.",
};

/** 이 기기에서 잘 돌아갈까? */
function DeviceCheck({ runner }: { runner: Runner }) {
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<BenchReply[]>([]);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setBusy(true);
    setRows([]);
    setResult(null);
    setError(null);
    // The check needs the processor to itself.
    const wasRunning = runner.running;
    if (wasRunning) runner.pause();
    try {
      setResult(await runDeviceCheck((r) => setRows((x) => [...x, r])));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      if (wasRunning) runner.run();
    }
  };
  return (
    <section className="device-check" data-testid="device-check">
      <h4>이 기기에서 잘 돌아갈까?</h4>
      <p className="hint">
        예제 {CHECK_EXAMPLES.length}개를 화면 없이 몇 초씩 최대 속도로 돌려 본다(약 10초). 실행 중이던 시뮬레이션은 그동안 멈춘다.
      </p>
      <button onClick={() => void start()} disabled={busy} data-testid="device-check-run">
        {busy ? `점검 중… (${rows.length}/${CHECK_EXAMPLES.length})` : "기기 점검"}
      </button>
      {rows.length > 0 && (
        <table className="device-rows">
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td>{r.name}</td>
                <td data-testid="device-ratio">{r.error ? "오류" : formatRatio(r.ratio)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {result && (
        <p className={`verdict v-${result.verdict === "충분" ? "ok" : result.verdict === "느림" ? "slow" : "mid"}`} data-testid="device-verdict">
          <b>{result.verdict}</b> — 가장 느린 예제 {formatRatio(result.worst)}. {VERDICT_HINT[result.verdict]}
          <span className="hint"> (×{ENOUGH} 이상 충분, ×{SLOW}–×{ENOUGH} 성능 모드 권장, 그 아래 느림)</span>
        </p>
      )}
      {error && <p className="error">점검 실패: {error}</p>}
    </section>
  );
}
