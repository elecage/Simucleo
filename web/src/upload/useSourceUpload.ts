// M39: uploading a whole project folder or zip. Finds the ELF (asks when
// there are several), loads it, matches the sources once the core has read
// its DWARF paths, and keeps them in IndexedDB with the firmware.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Runner } from "../sim/useRunner";
import { idbGet, idbSet } from "../editor/project";
import { attachSources, elfKey, isAttached, summary, type Attached } from "./attach";
import { collect, type ElfCandidate, type PickedFile, type SourceFile } from "./folder";

const STORE_KEY = "m39-sources";

export interface UploadMessage {
  kind: "error" | "info";
  text: string;
}

export interface SourceUpload {
  /** Sources attached to the loaded ELF (null: none). */
  attached: Attached | null;
  message: UploadMessage | null;
  /** Several ELFs in the upload: the student picks one. */
  choice: { elfs: ElfCandidate[]; sources: SourceFile[] } | null;
  busy: boolean;
  /** Changes on every upload, so the source tab can come to the front. */
  seq: number;
  upload(files: PickedFile[]): Promise<void>;
  choose(elf: ElfCandidate | null): void;
}

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export function useSourceUpload(runner: Runner): SourceUpload {
  const [attached, setAttached] = useState<Attached | null>(null);
  const [message, setMessage] = useState<UploadMessage | null>(null);
  const [choice, setChoice] = useState<SourceUpload["choice"]>(null);
  const [busy, setBusy] = useState(false);
  const [seq, setSeq] = useState(0);
  // Sources waiting for the DWARF paths of the ELF just loaded.
  const pending = useRef<{ sources: SourceFile[]; before: Runner["debugFiles"]; name: string } | null>(null);
  const { load, firmwareBytes, debugFiles, firmware, loadError } = runner;

  const keep = useCallback((a: Attached) => {
    setAttached(a);
    if (a.stored) void idbSet(STORE_KEY, a);
  }, []);
  const report = useCallback((a: Attached, extra = "") => {
    const n = Object.keys(a.files).length;
    setMessage({
      kind: n ? "info" : "error",
      text:
        (n ? summary(a) : "연결된 소스가 없습니다: 파일 이름이 ELF의 디버그 정보(DWARF)와 맞지 않습니다.") +
        extra +
        (a.stored ? "" : ` 소스가 ${(a.bytes / 1048576).toFixed(1)} MB로 커서 이 브라우저에 저장하지 않았습니다(새로 고치면 사라집니다).`),
    });
  }, []);

  const loadElf = useCallback(
    (elf: ElfCandidate, sources: SourceFile[]) => {
      const name = baseName(elf.path);
      pending.current = { sources, before: debugFiles, name };
      load(name, elf.bytes.slice().buffer as ArrayBuffer);
    },
    [load, debugFiles],
  );

  const upload = useCallback(
    async (files: PickedFile[]) => {
      setBusy(true);
      setSeq((s) => s + 1);
      try {
        if (!files.length) return;
        const got = await collect(files);
        if (got.elfs.length > 1) {
          setChoice({ elfs: got.elfs, sources: got.sources });
          setMessage({ kind: "info", text: `ELF가 ${got.elfs.length}개 있습니다. 불러올 것을 고르세요.` });
        } else if (got.elfs.length === 1) {
          setChoice(null);
          setMessage({ kind: "info", text: `${got.elfs[0].path} 불러오는 중…` });
          loadElf(got.elfs[0], got.sources);
        } else if (!got.sources.length) {
          setMessage({ kind: "error", text: "ELF도 소스 파일(.c, .h, .s)도 없습니다. CubeIDE 프로젝트 폴더(Debug 폴더 포함)나 그 zip을 올리세요." });
        } else if (!firmwareBytes || !firmware) {
          setMessage({ kind: "error", text: "ELF가 없습니다. Debug 폴더의 .elf를 함께 올리거나 먼저 펌웨어를 불러오세요." });
        } else {
          // Sources only: attach them to the firmware already loaded.
          const a = attachSources(elfKey(firmwareBytes), debugFiles.map((f) => f.path), got.sources);
          if (Object.keys(a.files).length) keep(a);
          report(a, ` (지금 펌웨어 ${firmware}에 붙임)`);
        }
      } catch (e) {
        setMessage({ kind: "error", text: `올리지 못했습니다: ${(e as Error).message}` });
      } finally {
        setBusy(false);
      }
    },
    [loadElf, firmwareBytes, firmware, debugFiles, keep, report],
  );

  const choose = useCallback(
    (elf: ElfCandidate | null) => {
      const c = choice;
      setChoice(null);
      if (!c || !elf) return setMessage(null);
      setMessage({ kind: "info", text: `${elf.path} 불러오는 중…` });
      loadElf(elf, c.sources);
    },
    [choice, loadElf],
  );

  // The ELF just loaded has its DWARF paths: match the waiting sources.
  useEffect(() => {
    const p = pending.current;
    if (!p || debugFiles === p.before) return;
    pending.current = null;
    if (loadError || firmware !== p.name || !firmwareBytes) {
      setMessage({ kind: "error", text: `ELF를 불러오지 못했습니다: ${loadError ?? p.name}` });
      return;
    }
    if (!debugFiles.length) {
      setAttached(null);
      setMessage({ kind: "error", text: `${p.name}을 불러왔지만 디버그 정보(DWARF)가 없어 소스를 연결할 수 없습니다. -g로 빌드하세요(CubeIDE의 Debug 구성).` });
      return;
    }
    const a = attachSources(elfKey(firmwareBytes), debugFiles.map((f) => f.path), p.sources);
    keep(a);
    report(a);
  }, [debugFiles, firmware, firmwareBytes, loadError, keep, report]);

  // Another firmware: its stored sources, if this ELF had some.
  useEffect(() => {
    if (!firmwareBytes) return void setAttached(null);
    const key = elfKey(firmwareBytes);
    setAttached((a) => (a?.key === key ? a : null));
    // Firmware from elsewhere (an example, ELF 업로드): the last upload's note is stale.
    if (!pending.current) setMessage(null);
    let live = true;
    void idbGet<unknown>(STORE_KEY).then((s) => {
      if (live && isAttached(s) && s.key === key) setAttached((a) => (a?.key === key ? a : s));
    });
    return () => {
      live = false;
    };
  }, [firmwareBytes]);

  return { attached, message, choice, busy, seq, upload, choose };
}
