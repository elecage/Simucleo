// "🔗 공유" and "선생님께 보내기" (M30): the project as a link and, when it
// fits, a QR code. The link is built in the browser; nothing is uploaded.
import { useEffect, useMemo, useState } from "react";
import type { Project } from "../editor/model";
import type { ResultsFile } from "../lessons/progress";
import { CHAT_SAFE_CHARS, encodeShare, fmtBytes, MAX_LINK_CHARS, shareUrl, type Encoded } from "./link";
import { encodeQr, qrPath, QR_MAX_BYTES } from "./qr";
import type { Strip } from "./elf";

export interface ShareFirmware {
  name: string;
  example?: string;
  bytes?: Uint8Array;
}

interface Props {
  project: Project;
  name: string;
  firmware?: ShareFirmware;
  /** The lesson open now, if any. */
  lesson?: { id: string; title: string };
  /** A sealed results file ("선생님께 보내기"). */
  result?: ResultsFile;
  /** "teacher": opened from the lesson panel, the result in by default. */
  mode?: "share" | "teacher";
  onSaveFile(): void;
  onClose(): void;
}

const num = (n: number) => n.toLocaleString("ko-KR");

export function ShareDialog({ project, name, firmware, lesson, result, mode = "share", onSaveFile, onClose }: Props) {
  const uploaded = !!firmware && !firmware.example && !!firmware.bytes;
  const [withFirmware, setWithFirmware] = useState(true);
  const [stripDebug, setStripDebug] = useState(true);
  const [keepSymbols, setKeepSymbols] = useState(true);
  const [withLesson, setWithLesson] = useState(true);
  const [withResult, setWithResult] = useState(true);
  const [built, setBuilt] = useState<{ url: string; enc: Encoded } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const strip: Strip = !stripDebug ? "none" : keepSymbols ? "debug" : "all";

  useEffect(() => {
    let live = true;
    setCopied(false);
    const fw = firmware && (firmware.example || (uploaded && withFirmware)) ? firmware : undefined;
    encodeShare({
      project,
      name,
      firmware: fw,
      strip,
      lesson: lesson && withLesson ? lesson.id : undefined,
      result: result && withResult ? result : undefined,
    }).then(
      (enc) => {
        if (!live) return;
        setBuilt({ url: shareUrl(location.href, enc.fragment), enc });
        setError(null);
      },
      (e: Error) => live && (setBuilt(null), setError(e.message)),
    );
    return () => {
      live = false;
    };
  }, [project, name, firmware, uploaded, withFirmware, strip, lesson, withLesson, result, withResult]);

  const url = built?.url ?? "";
  const tooLong = url.length > MAX_LINK_CHARS;
  const qr = useMemo(() => (url && url.length <= QR_MAX_BYTES ? encodeQr(new TextEncoder().encode(url), "M") : null), [url]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const t = document.querySelector<HTMLTextAreaElement>("[data-testid=share-link]");
      t?.select();
      document.execCommand("copy");
    }
    setCopied(true);
  };
  const parts = project.parts.length;
  const wires = project.wires.length;
  const title = mode === "teacher" ? "📤 선생님께 보내기" : "🔗 링크·QR로 공유";

  return (
    <div className="overlay" role="dialog" aria-label={mode === "teacher" ? "선생님께 보내기" : "공유"} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="overlay-box share-box">
        <header>
          <b>{title}</b>
          <button className="close" onClick={onClose} aria-label="공유 닫기">
            ×
          </button>
        </header>
        <div className="share-body">
          <div className="share-main">
            <p className="hint">
              링크를 연 사람의 브라우저에서 이 회로가 그대로 열립니다. 내용은 주소의 <code>#</code> 뒤에 들어 있어 어느 서버에도
              보내지지 않지만, 링크를 가진 사람은 누구나 볼 수 있습니다.
            </p>
            <ul className="share-summary" data-testid="share-summary">
              <li>
                프로젝트 <b>{name || "(이름 없음)"}</b> · 부품 {parts}개 · 와이어 {wires}개
              </li>
              <li>
                펌웨어:{" "}
                {!firmware
                  ? "없음"
                  : firmware.example
                    ? `예제 ${firmware.example} (이름만 넣음 — 받는 쪽 앱에 들어 있음)`
                    : uploaded && withFirmware && built
                      ? `${firmware.name} ${fmtBytes(built.enc.elfOriginalBytes)}${built.enc.elfBytes !== built.enc.elfOriginalBytes ? ` → ${fmtBytes(built.enc.elfBytes)}` : ""}`
                      : `${firmware.name} (넣지 않음)`}
              </li>
              {lesson && withLesson && <li>실습: {lesson.title}</li>}
              {result && withResult && (
                <li>
                  실습 결과: {result.student || "(이름 없음)"} · 실습 {result.lessons.length}개 (SHA-256 해시 포함)
                </li>
              )}
            </ul>
            <div className="share-options">
              {uploaded && (
                <>
                  <label>
                    <input type="checkbox" checked={withFirmware} onChange={(e) => setWithFirmware(e.target.checked)} /> 올린 펌웨어(ELF) 넣기
                  </label>
                  <label title="DWARF 디버그 정보를 빼고 실행에 필요한 부분(로드 세그먼트)만 넣습니다">
                    <input type="checkbox" checked={stripDebug} disabled={!withFirmware} onChange={(e) => setStripDebug(e.target.checked)} /> 디버그 정보 빼기
                    <span className="dim"> (링크가 훨씬 짧아짐, 받는 쪽에서 소스 보기·변수 보기는 안 됨)</span>
                  </label>
                  <label title="Error_Handler 감지와 RTOS 보기에 쓰는 함수·변수 이름">
                    <input type="checkbox" checked={keepSymbols} disabled={!withFirmware || !stripDebug} onChange={(e) => setKeepSymbols(e.target.checked)} /> 기호표(함수·변수 이름) 남기기
                  </label>
                </>
              )}
              {lesson && (
                <label>
                  <input type="checkbox" checked={withLesson} onChange={(e) => setWithLesson(e.target.checked)} /> 지금 실습({lesson.title}) 함께 열기
                </label>
              )}
              {result && (
                <label>
                  <input type="checkbox" checked={withResult} onChange={(e) => setWithResult(e.target.checked)} /> 실습 결과 넣기 (선생님용 모아보기에서 검증)
                </label>
              )}
            </div>
            {error && (
              <div className="error" role="alert">
                링크를 만들지 못했습니다: {error}
              </div>
            )}
            {built && !tooLong && (
              <>
                <textarea className="share-link" data-testid="share-link" readOnly value={url} rows={3} onFocus={(e) => e.target.select()} aria-label="공유 링크" />
                <div className="share-row">
                  <button onClick={() => void copy()} className="primary">
                    {copied ? "✓ 복사됨" : "링크 복사"}
                  </button>
                  <span className="dim" data-testid="share-size" data-chars={url.length}>
                    링크 {num(url.length)}자 · 내용 {fmtBytes(built.enc.rawBytes)}
                    {built.enc.compressed ? ` → 압축 ${fmtBytes(built.enc.packedBytes)}` : " (압축 안 함: 이 브라우저에 압축 기능이 없음)"}
                  </span>
                </div>
                {url.length > CHAT_SAFE_CHARS && (
                  <p className="hint warn" data-testid="share-long">
                    ⚠ 링크가 깁니다({num(url.length)}자). 메일·학급 게시판·브라우저 주소창에는 괜찮지만 일부 메신저나 문자는 긴 링크를 자릅니다.
                    잘리면 받는 쪽에서 "링크가 손상되었습니다"라고 나옵니다. 그럴 때는 파일로 저장해 보내세요.
                  </p>
                )}
              </>
            )}
            {built && tooLong && (
              <p className="error" data-testid="share-too-long">
                링크로 보내기에는 너무 큽니다({num(url.length)}자, 브라우저 한도 약 {num(MAX_LINK_CHARS)}자). 디버그 정보를 빼거나 파일로 저장해
                보내세요.
              </p>
            )}
            <div className="share-row">
              <button onClick={onSaveFile} title="프로젝트 파일(.simucleo.json)로 저장해 메일·드라이브로 보냅니다">
                💾 파일로 저장
              </button>
            </div>
          </div>
          <div className="share-qr-box">
            {qr ? (
              <figure>
                <svg
                  className="share-qr"
                  data-testid="share-qr"
                  data-version={qr.version}
                  data-ecc={qr.ecc}
                  viewBox={`0 0 ${qr.size + 8} ${qr.size + 8}`}
                  role="img"
                  aria-label="공유 링크 QR 코드"
                  shapeRendering="crispEdges"
                >
                  <rect width={qr.size + 8} height={qr.size + 8} fill="#fff" />
                  <path d={qrPath(qr)} fill="#000" />
                </svg>
                <figcaption className="dim">
                  휴대폰·태블릿 카메라로 찍으면 열립니다 (QR 버전 {qr.version}, 오류 정정 {qr.ecc})
                </figcaption>
              </figure>
            ) : (
              built && (
                <p className="hint" data-testid="share-no-qr">
                  QR 코드 없음: QR 코드에는 약 {num(QR_MAX_BYTES)}자까지만 들어가는데 이 링크는 {num(url.length)}자입니다. 예제 펌웨어를 쓰는 회로는
                  보통 QR에 들어가지만, 직접 올린 펌웨어는 디버그 정보를 빼도 대개 너무 큽니다. 링크를 복사해 보내거나 파일로 저장하세요.
                </p>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
