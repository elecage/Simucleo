// The FLASH tab (M37): the eight sectors of the F401RE's flash as a bar
// map — how much of each is programmed since its last erase, how often it
// was erased, the one being erased now — and the independent watchdog with
// the cause of the last reset. Updated with every frame.
import type { Runner } from "../sim/useRunner";
import type { FlashFrame } from "../sim/protocol";
import { t } from "../i18n";

const kb = (n: number) => (n >= 1024 ? `${n >> 10} KB` : `${n} B`);
const hex = (v: number) => "0x" + (v >>> 0).toString(16).toUpperCase().padStart(8, "0");

/** RCC_CSR[31:24] flag names, from bit 31 down (RMVF, bit 24, is not a flag). */
const CSR_FLAGS = ["LPWR", "WWDG", "IWDG", "SFT", "POR", "PIN", "BOR"];

export function resetCauseText(c: FlashFrame["resetCause"]): string {
  switch (c) {
    case "power":
      return t("전원 켜짐 (펌웨어 로드)");
    case "pin":
      return t("리셋 버튼 (NRST)");
    case "software":
      return t("소프트웨어 리셋 (SYSRESETREQ)");
    case "watchdog":
      return t("워치독 (IWDG)");
  }
}

function activityText(f: FlashFrame): string {
  switch (f.activity) {
    case "idle":
      return t("유휴");
    case "erase": {
      const s = f.sectors.map((x, i) => (x.erasing ? i : -1)).filter((i) => i >= 0);
      return s.length === f.sectors.length ? t("전체 지우는 중") : t("섹터 {n} 지우는 중", { n: s.join(", ") });
    }
    case "program":
      return t("쓰는 중");
    case "options":
      return t("옵션 바이트 쓰는 중");
  }
}

export function FlashView({ runner }: { runner: Runner }) {
  const f = runner.frame?.flash;
  if (!f) return <p className="hint">{t("펌웨어를 불러오면 플래시 섹터와 워치독이 보입니다.")}</p>;
  const w = f.watchdog;
  const flags = CSR_FLAGS.filter((_, i) => f.resetFlags & (0x80 >> i));
  return (
    <div className="flash-view" data-testid="flash-view">
      <div className="flash-head">
        <b>FLASH</b>
        <span className={f.busy ? "flash-busy on" : "flash-busy"} data-testid="flash-activity" data-activity={f.activity}>
          {activityText(f)}
        </span>
        <span className="dim">FLASH_CR {f.locked ? t("잠김 (LOCK)") : t("잠금 해제")}</span>
        <span className="dim">{t("옵션 바이트 {ob}", { ob: hex(f.optionBytes) })}</span>
      </div>
      <div className="flash-map" role="list" aria-label={t("플래시 섹터")}>
        {f.sectors.map((s, i) => {
          // Contents (the loaded image too), not only what was programmed since the erase.
          const used = s.size ? s.used / s.size : 0;
          const cls = ["flash-sector", s.erasing ? "erasing" : "", s.protected ? "protected" : ""].filter(Boolean).join(" ");
          return (
            <div
              key={s.start}
              className={cls}
              role="listitem"
              data-testid="flash-sector"
              data-erase-count={s.eraseCount}
              data-programmed={s.programmed}
              data-used={s.used}
              title={t("섹터 {n} · {start} · {size} · 내용 {used}바이트 · 지운 뒤 쓴 바이트 {bytes} · 지운 횟수 {count}", {
                n: i,
                start: hex(s.start),
                size: kb(s.size),
                used: s.used,
                bytes: s.programmed,
                count: s.eraseCount,
              })}
            >
              <div className="flash-fill" style={{ height: `${Math.min(100, used * 100)}%` }} />
              <div className="flash-label">
                <b>S{i}</b>
                {s.protected && <span title={t("쓰기 보호 (nWRP)")}> 🔒</span>}
                <span>{kb(s.size)}</span>
                <span className="dim">{s.used ? t("사용 {pct}%", { pct: (used * 100).toFixed(used < 0.1 ? 1 : 0) }) : t("비어 있음")}</span>
                <span className="dim">{t("지움 ×{n}", { n: s.eraseCount })}</span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flash-iwdg" data-testid="iwdg-status" data-running={w.running} data-resets={w.resets}>
        <b>IWDG</b>
        {w.running ? (
          <>
            <span className="flash-busy on">{t("동작 중")}</span>
            <span>{t("남은 시간 {ms} ms", { ms: (w.timeLeftMs ?? 0).toFixed(1) })}</span>
            <progress max={w.reload + 1} value={w.counter} aria-label={t("워치독 카운터")} />
            <span className="dim">
              {w.counter}/{w.reload} · LSI/{w.prescaler}
            </span>
          </>
        ) : (
          <span className="dim">{w.hardware ? t("꺼짐 (하드웨어 워치독: 리셋 후 시작)") : t("꺼짐")}</span>
        )}
        <span>{t("워치독 리셋 {n}회", { n: w.resets })}</span>
        <span data-testid="reset-cause" data-cause={f.resetCause}>
          {t("마지막 리셋: {cause}", { cause: resetCauseText(f.resetCause) })}
        </span>
        <span className="dim" title={t("RCC_CSR 리셋 플래그 (RMVF로 지울 때까지 쌓임)")}>
          CSR: {flags.join(" ") || "—"}
        </span>
      </div>
    </div>
  );
}
