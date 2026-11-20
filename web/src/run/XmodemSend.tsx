// The console's file transfer (M37): pick an image the example comes with,
// or one of your own .bin files, and send it to the board's bootloader with
// XMODEM. The transfer runs in the simulation worker (src/run/xmodem.ts).
import { useState } from "react";
import type { Runner } from "../sim/useRunner";
import type { XmodemTransfer } from "../sim/protocol";
import { t } from "../i18n";

/** A file to send that comes with an example (examples/index.json `files`). */
export interface SendFile {
  file: string;
  description: string;
}

/** A .bin file the student picked, kept while the page is open. */
export interface UploadedFile {
  name: string;
  bytes: ArrayBuffer;
}

/** What the status line says about a transfer. */
export function xmodemText(x: XmodemTransfer): string {
  const r = x.result;
  if (r) {
    if (r.kind === "ok") return t("전송 완료: {name} ({n}블록, {size}바이트)", { name: x.name, n: x.total, size: x.size });
    if (r.kind === "cancelled") return r.by === "user" ? t("전송을 취소했습니다") : t("수신 측이 전송을 취소했습니다 (CAN)");
    switch (r.reason) {
      case "no-start":
        return t("수신 측이 시작하지 않았습니다 ('C'나 NAK가 오지 않음)");
      case "retries":
        return t("{n}번 블록을 10번 다시 보내도 받지 않아 중단했습니다", { n: x.block });
      case "eot":
        return t("EOT에 응답이 없어 중단했습니다");
      case "reset":
        return t("보드가 리셋되어 전송을 중단했습니다");
      case "reload":
        return t("펌웨어를 다시 불러와 전송을 중단했습니다");
    }
  }
  if (x.state === "waiting") return t("수신 측을 기다리는 중 ('C')…");
  if (x.state === "eot") return t("EOT 보내는 중…");
  const pct = x.total ? Math.floor((100 * x.acked) / x.total) : 100;
  return t("블록 {n}/{total} ({pct}%)", { n: Math.min(x.block, x.total), total: x.total, pct }) +
    (x.resent ? t(" · 재전송 {n}", { n: x.resent }) : "");
}

export function XmodemSend({
  runner,
  files,
  uploaded,
  onUpload,
}: {
  runner: Runner;
  /** The loaded example's files to send. */
  files: SendFile[];
  uploaded: UploadedFile[];
  onUpload(f: UploadedFile): void;
}) {
  const [choice, setChoice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const x = runner.xmodem;
  const active = !!x && !x.result;
  const value = choice && (files.some((f) => `ex:${f.file}` === choice) || uploaded.some((f) => `up:${f.name}` === choice)) ? choice : "";

  const send = async () => {
    setError(null);
    if (value.startsWith("ex:")) {
      const file = value.slice(3);
      const r = await fetch(`./examples/${file}`).catch(() => null);
      if (!r?.ok) {
        setError(t("{file|을/를} 불러오지 못했습니다", { file }));
        return;
      }
      runner.xmodemSend(file, await r.arrayBuffer());
    } else if (value.startsWith("up:")) {
      const f = uploaded.find((u) => `up:${u.name}` === value);
      if (f) runner.xmodemSend(f.name, f.bytes.slice(0));
    }
  };

  const pct = x && x.total ? (100 * (x.result?.kind === "ok" ? x.total : x.acked)) / x.total : 0;
  return (
    <div className="xmodem" data-testid="xmodem">
      <span className="xmodem-title">{t("파일 보내기 (XMODEM)")}</span>
      <select value={value} onChange={(e) => setChoice(e.target.value)} aria-label={t("보낼 파일")} disabled={active}>
        <option value="">{t("파일 고르기…")}</option>
        {files.length > 0 && (
          <optgroup label={t("예제의 파일")}>
            {files.map((f) => (
              <option key={f.file} value={`ex:${f.file}`} title={f.description}>
                {f.file}
              </option>
            ))}
          </optgroup>
        )}
        {uploaded.length > 0 && (
          <optgroup label={t("올린 파일")}>
            {uploaded.map((f) => (
              <option key={f.name} value={`up:${f.name}`}>
                {f.name} ({f.bytes.byteLength} B)
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <label className="file-btn" title={t("내 .bin 파일을 목록에 추가")}>
        {t(".bin 올리기")}
        <input
          type="file"
          accept=".bin,application/octet-stream"
          hidden
          data-testid="xmodem-file"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            onUpload({ name: file.name, bytes: await file.arrayBuffer() });
            setChoice(`up:${file.name}`);
          }}
        />
      </label>
      {active ? (
        <button type="button" onClick={runner.xmodemCancel}>
          {t("취소")}
        </button>
      ) : (
        <button type="button" onClick={send} disabled={!value || !runner.firmware}>
          {t("보내기")}
        </button>
      )}
      {x && (
        <>
          <progress max={100} value={pct} aria-label={t("전송 진행")} />
          <span
            className={x.result ? (x.result.kind === "ok" ? "xmodem-status ok" : "xmodem-status bad") : "xmodem-status"}
            data-testid="xmodem-status"
            data-state={x.result ? x.result.kind : x.state}
            role="status"
          >
            {xmodemText(x)}
          </span>
          {x.result && (
            <button type="button" className="xmodem-close" onClick={runner.clearXmodem} aria-label={t("닫기")}>
              ×
            </button>
          )}
        </>
      )}
      {error && <span className="xmodem-status bad">{error}</span>}
      {!x && !error && <span className="hint">{t("부트로더가 'C'를 보내면 전송이 시작됩니다")}</span>}
    </div>
  );
}
