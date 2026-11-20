// Opening a share link (M30): what the link holds, and nothing replaced
// until the receiver says "열기". Every string here comes from the link and
// is shown as text only.
import { fmtBytes, type Received } from "./link";
import { t } from "../i18n";

interface Props {
  incoming: { received?: Received; error?: string };
  /** The receiver's project, as it would be lost. */
  current: { name: string; parts: number; wires: number; dirty: boolean };
  /** Title of the link's lesson in this browser, or null if it has none. */
  lessonTitle: string | null;
  onOpen(): void;
  onCancel(): void;
  onSaveCurrent(): void;
  /** Add the link's lesson result to the teacher view (without opening the project). */
  onAddResult?: () => void;
}

const BADGE: Record<string, string> = { verified: t("✅ 검증됨"), tampered: t("⚠ 변조됨"), unverified: t("검증 안 됨") };
const STRIP: Record<string, string> = { none: "", debug: t(", 디버그 정보 뺌"), all: t(", 디버그 정보·기호표 뺌") };
const cut = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function ReceiveDialog({ incoming, current, lessonTitle, onOpen, onCancel, onSaveCurrent, onAddResult }: Props) {
  const r = incoming.received;
  return (
    <div className="overlay" role="dialog" aria-label={t("공유 링크 열기")}>
      <div className="overlay-box share-box receive-box">
        <header>
          <b>{t("🔗 공유 링크 열기")}</b>
        </header>
        <div className="share-main">
          {!r ? (
            <>
              <p className="error" role="alert" data-testid="receive-error">
                {t("이 링크를 열 수 없습니다:")} {incoming.error}
              </p>
              <p className="hint">{t("지금 프로젝트는 그대로입니다.")}</p>
              <div className="share-row">
                <button onClick={onCancel}>{t("닫기")}</button>
              </div>
            </>
          ) : (
            <>
              <p>{t("이 링크에 든 것:")}</p>
              <ul className="share-summary" data-testid="receive-summary">
                <li>
                  {t("프로젝트")} <b data-testid="receive-name">{cut(r.loaded.name ?? t("(이름 없음)"))}</b> ·{" "}
                  {t("부품 {parts}개 · 와이어 {wires}개", { parts: r.loaded.project.parts.length, wires: r.loaded.project.wires.length })}
                  {r.loaded.project.scope ? ` · ${t("파형 설정")}` : ""}
                </li>
                <li data-testid="receive-firmware">
                  {t("펌웨어:")}{" "}
                  {!r.loaded.firmware
                    ? t("없음")
                    : r.elf
                      ? t("{name} (링크에 든 ELF {size}{strip})", { name: cut(r.loaded.firmware.name, 60), size: fmtBytes(r.elf.size), strip: STRIP[r.elf.strip] })
                      : t("예제 {name}", { name: cut(r.loaded.firmware.example ?? "", 60) })}
                </li>
                {r.lesson && <li>{t("실습:")} {lessonTitle ?? t("{id} (이 브라우저에 없는 실습이라 열지 않음)", { id: r.lesson })}</li>}
                {r.result && (
                  <li data-testid="receive-result">
                    {t("실습 결과:")}{" "}
                    {r.result.file ? (
                      <>
                        {cut(r.result.file.student || t("(이름 없음)"), 40)} · {t("실습 {n}개", { n: r.result.file.lessons.length })}{" "}
                        <span className={`badge ${r.result.integrity}`}>{BADGE[r.result.integrity]}</span>
                      </>
                    ) : (
                      <span className="error">{r.result.error}</span>
                    )}
                  </li>
                )}
                {r.loaded.notes.map((n) => (
                  <li key={n} className="dim">
                    {cut(n, 200)}
                  </li>
                ))}
              </ul>
              {current.dirty ? (
                <p className="hint warn" data-testid="receive-warning">
                  {t("⚠ 열면 지금 프로젝트")} <b>{cut(current.name, 40)}</b>
                  {t("(부품 {parts}개, 와이어 {wires}개)가 이 링크의 회로로 바뀝니다. 남기려면 먼저", { parts: current.parts, wires: current.wires })}{" "}
                  <button className="small" onClick={onSaveCurrent}>
                    {t("지금 프로젝트를 파일로 저장")}
                  </button>
                  {t("하세요.")}
                </p>
              ) : (
                <p className="hint">{t("열면 지금 빈 보드가 이 링크의 회로로 바뀝니다.")}</p>
              )}
              <div className="share-row">
                <button className="primary" onClick={onOpen}>
                  {t("열기")}
                </button>
                <button onClick={onCancel}>{t("취소")}</button>
                {r.result?.file && onAddResult && (
                  <button onClick={onAddResult} title={t("회로는 열지 않고 결과만 선생님용 모아보기 표에 넣습니다")}>
                    {t("👩‍🏫 결과 모아보기에 추가")}
                  </button>
                )}
              </div>
              <p className="dim">{t("취소하면 아무것도 바뀌지 않습니다.")}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
