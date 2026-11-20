// The source tab's row for M39: "📁 프로젝트 폴더·zip 올리기" (a folder or
// zip/files picker), what was connected, what is missing, and the ELF
// choice when an upload has several.
import { useRef, useState } from "react";
import type { DebugFile } from "../sim/protocol";
import { fromFileList } from "./folder";
import { summary } from "./attach";
import { lang, t } from "../i18n";
import type { SourceUpload } from "./useSourceUpload";

const when = (ms: number) => (ms > 0 ? new Date(ms).toLocaleString(lang() === "ko" ? "ko-KR" : "en-US") : "");
const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);

export function UploadBar({ upload, files }: { upload: SourceUpload; files: DebugFile[] }) {
  const folder = useRef<HTMLInputElement>(null);
  const bundle = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  const [pick, setPick] = useState(0);
  const { attached, message, choice } = upload;
  // Only files with code in this ELF count (the attachment may be older).
  const shown = attached ? files.filter((f) => attached.files[f.path]) : [];
  const missing = attached ? files.filter((f) => attached.missing.includes(f.path)) : [];
  const outside = attached ? files.filter((f) => attached.outside.includes(f.path)) : [];
  const pickFrom = (input: HTMLInputElement) => {
    const l = fromFileList(input.files ?? []);
    input.value = "";
    if (menu.current) menu.current.open = false;
    void upload.upload(l);
  };
  return (
    <div className="upload-bar">
      <details className="upload-menu" ref={menu}>
        <summary title={t("STM32CubeIDE 프로젝트 폴더나 zip: ELF(Debug/*.elf)와 소스를 한꺼번에 불러옵니다")}>{t("📁 프로젝트 폴더·zip 올리기")}</summary>
        <div className="upload-pop">
          <button onClick={() => folder.current?.click()}>{t("폴더 고르기…")}</button>
          <button onClick={() => bundle.current?.click()}>{t("zip·파일 고르기…")}</button>
          <p className="hint">{t("앱 어디에나 폴더나 zip을 끌어다 놓아도 됩니다. 파일은 이 브라우저 안에서만 읽습니다.")}</p>
        </div>
      </details>
      <input
        ref={folder}
        type="file"
        hidden
        multiple
        data-testid="folder-input"
        {...{ webkitdirectory: "" }}
        onChange={(e) => pickFrom(e.currentTarget)}
      />
      <input
        ref={bundle}
        type="file"
        hidden
        multiple
        accept=".zip,.elf,.axf,.out,.c,.h,.s,.S,.cpp,.hpp,application/zip"
        data-testid="bundle-input"
        onChange={(e) => pickFrom(e.currentTarget)}
      />
      {upload.busy ? (
        <span className="hint">{t("읽는 중…")}</span>
      ) : message ? (
        <span className={message.kind === "error" ? "upload-msg error" : "upload-msg"} data-testid="upload-status">
          {message.text}
        </span>
      ) : attached ? (
        <span className="upload-msg" data-testid="upload-status">
          {summary(attached)}
        </span>
      ) : null}
      {attached && (shown.length > 0 || missing.length > 0 || outside.length > 0) && (
        <details className="upload-files" data-testid="upload-files">
          <summary>
            {t("연결 {shown} · 없음 {missing}", { shown: shown.length, missing: missing.length })}
            {outside.length ? t(" · 프로젝트 밖 {n}", { n: outside.length }) : ""}
          </summary>
          <div className="upload-pop wide">
            <b>{t("연결된 소스")}</b>
            <ul data-testid="matched-files">
              {shown.map((f) => (
                <li key={f.index} title={f.path}>
                  {attached.files[f.path].from}
                </li>
              ))}
            </ul>
            {missing.length > 0 && (
              <>
                <b>{t("DWARF에 있지만 올린 것에 없는 파일")}</b>
                <ul data-testid="missing-files">
                  {missing.map((f) => (
                    <li key={f.index}>{f.path}</li>
                  ))}
                </ul>
              </>
            )}
            {outside.length > 0 && (
              <>
                <b>{t("프로젝트 밖 (컴파일러 라이브러리 — 소스가 없어도 됩니다)")}</b>
                <ul data-testid="outside-files">
                  {outside.map((f) => (
                    <li key={f.index}>{f.path}</li>
                  ))}
                </ul>
              </>
            )}
            {attached.ties.length > 0 && (
              <>
                <b>{t("이름이 같은 후보가 여럿 (첫 파일을 씀)")}</b>
                <ul>
                  {attached.ties.map((tie) => (
                    <li key={tie.dwarf}>
                      {tie.dwarf}: {tie.candidates.join(", ")}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </details>
      )}
      {choice && (
        <div className="elf-choice" role="dialog" aria-label={t("ELF 고르기")} data-testid="elf-choice">
          <b>{t("불러올 ELF")}</b>
          {choice.elfs.map((e, i) => (
            <label key={e.path}>
              <input type="radio" name="elf-choice" checked={pick === i} onChange={() => setPick(i)} /> {e.path}{" "}
              <span className="hint">
                {kb(e.size)} {when(e.mtime)}
              </span>
            </label>
          ))}
          <span>
            <button
              onClick={() => {
                upload.choose(choice.elfs[pick] ?? choice.elfs[0]);
                setPick(0);
              }}
            >
              {t("불러오기")}
            </button>{" "}
            <button onClick={() => upload.choose(null)}>{t("취소")}</button>
          </span>
        </div>
      )}
    </div>
  );
}
