// Opening a share link (M30): what the link holds, and nothing replaced
// until the receiver says "열기". Every string here comes from the link and
// is shown as text only.
import { fmtBytes, type Received } from "./link";

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

const BADGE: Record<string, string> = { verified: "✅ 검증됨", tampered: "⚠ 변조됨", unverified: "검증 안 됨" };
const STRIP: Record<string, string> = { none: "", debug: ", 디버그 정보 뺌", all: ", 디버그 정보·기호표 뺌" };
const cut = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function ReceiveDialog({ incoming, current, lessonTitle, onOpen, onCancel, onSaveCurrent, onAddResult }: Props) {
  const r = incoming.received;
  return (
    <div className="overlay" role="dialog" aria-label="공유 링크 열기">
      <div className="overlay-box share-box receive-box">
        <header>
          <b>🔗 공유 링크 열기</b>
        </header>
        <div className="share-main">
          {!r ? (
            <>
              <p className="error" role="alert" data-testid="receive-error">
                이 링크를 열 수 없습니다: {incoming.error}
              </p>
              <p className="hint">지금 프로젝트는 그대로입니다.</p>
              <div className="share-row">
                <button onClick={onCancel}>닫기</button>
              </div>
            </>
          ) : (
            <>
              <p>이 링크에 든 것:</p>
              <ul className="share-summary" data-testid="receive-summary">
                <li>
                  프로젝트 <b data-testid="receive-name">{cut(r.loaded.name ?? "(이름 없음)")}</b> · 부품 {r.loaded.project.parts.length}개 · 와이어{" "}
                  {r.loaded.project.wires.length}개{r.loaded.project.scope ? " · 파형 설정" : ""}
                </li>
                <li data-testid="receive-firmware">
                  펌웨어:{" "}
                  {!r.loaded.firmware
                    ? "없음"
                    : r.elf
                      ? `${cut(r.loaded.firmware.name, 60)} (링크에 든 ELF ${fmtBytes(r.elf.size)}${STRIP[r.elf.strip]})`
                      : `예제 ${cut(r.loaded.firmware.example ?? "", 60)}`}
                </li>
                {r.lesson && <li>실습: {lessonTitle ?? `${r.lesson} (이 브라우저에 없는 실습이라 열지 않음)`}</li>}
                {r.result && (
                  <li data-testid="receive-result">
                    실습 결과:{" "}
                    {r.result.file ? (
                      <>
                        {cut(r.result.file.student || "(이름 없음)", 40)} · 실습 {r.result.file.lessons.length}개{" "}
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
                  ⚠ 열면 지금 프로젝트 <b>{cut(current.name, 40)}</b>(부품 {current.parts}개, 와이어 {current.wires}개)가 이 링크의 회로로 바뀝니다. 남기려면 먼저{" "}
                  <button className="small" onClick={onSaveCurrent}>
                    지금 프로젝트를 파일로 저장
                  </button>
                  하세요.
                </p>
              ) : (
                <p className="hint">열면 지금 빈 보드가 이 링크의 회로로 바뀝니다.</p>
              )}
              <div className="share-row">
                <button className="primary" onClick={onOpen}>
                  열기
                </button>
                <button onClick={onCancel}>취소</button>
                {r.result?.file && onAddResult && (
                  <button onClick={onAddResult} title="회로는 열지 않고 결과만 선생님용 모아보기 표에 넣습니다">
                    👩‍🏫 결과 모아보기에 추가
                  </button>
                )}
              </div>
              <p className="dim">취소하면 아무것도 바뀌지 않습니다.</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
