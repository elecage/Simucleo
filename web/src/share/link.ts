// Share links (M30): a project — circuit, firmware, waveform settings,
// optionally the open lesson and a lesson result — packed into the URL
// fragment, so no server ever sees it (browsers do not send `#…`).
//
//   https://…/Simucleo/#s1=<base64url>
//
// `s1` names the format version. The base64url bytes are one method byte
// (0: stored, 1: deflate-raw via CompressionStream) and the body:
//
//   u32 LE  length of the JSON
//   JSON    ShareDoc (UTF-8)
//   bytes   the uploaded ELF, if any (`elf.size` bytes)
//
// The ELF goes in as bytes, not base64 inside the JSON, so it is encoded
// to text only once. Everything read from a link is untrusted: sizes are
// capped before and while inflating, the project goes through the project
// file parser, the result through the teacher view's parser with its hash.
// Pure, unit tested in test/m30.test.ts.
import { parseWith, FORMAT, VERSION, type CatalogEntry, type FirmwareRef, type Loaded, type ProjectFile } from "../editor/projectFormat.ts";
import type { Project } from "../editor/model";
import { parseResults, type LoadedResult } from "../lessons/teacher.ts";
import type { ResultsFile } from "../lessons/progress.ts";
import { ElfError, readElf, stripElf, type Strip } from "./elf.ts";
import { forShare } from "../code/project.ts";

export const SHARE_FORMAT = "simucleo-share";
export const SHARE_VERSION = 1;
/** Longest link we make or read: about Chrome's URL limit (2 MB). */
export const MAX_LINK_CHARS = 2_000_000;
/** Most bytes a link may unpack to (a "zip bomb" stops here). */
export const MAX_UNPACKED_BYTES = 8 * 1024 * 1024;
/** Above this, chat apps and text messages may cut the link. */
export const CHAT_SAFE_CHARS = 4000;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 1;
const EXAMPLE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.elf$/;
const LESSON_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

export class ShareError extends Error {}

/** The JSON part of a link. */
export interface ShareDoc {
  format: typeof SHARE_FORMAT;
  version: number;
  /** The project file (its firmware without `data`: the ELF follows the JSON). */
  project: ProjectFile;
  /** The uploaded ELF that follows the JSON. */
  elf?: { size: number; originalSize: number; strip: Strip };
  /** Lesson open when the link was made. */
  lesson?: string;
  /** A sealed lesson results file ("선생님께 보내기"). */
  result?: ResultsFile;
}

export interface ShareInput {
  project: Project;
  name?: string;
  /** A bundled example by file name, or the bytes of an uploaded ELF. */
  firmware?: { name: string; example?: string; bytes?: Uint8Array };
  strip?: Strip;
  lesson?: string;
  result?: ResultsFile;
}

export interface Encoded {
  /** `s1=…`, without the `#`. */
  fragment: string;
  jsonBytes: number;
  elfBytes: number;
  /** The ELF before stripping. */
  elfOriginalBytes: number;
  /** Body bytes before and after compression. */
  rawBytes: number;
  packedBytes: number;
  compressed: boolean;
}

export interface Received {
  loaded: Loaded;
  elf?: ShareDoc["elf"];
  lesson?: string;
  /** The lesson result, read and verified like a dropped results file. */
  result?: LoadedResult;
  /** Characters of the fragment. */
  chars: number;
}

// ------------------------------------------------------------ bytes

export function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new ShareError("링크가 손상되었습니다 (허용되지 않는 글자).");
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const hasStreams = () => typeof CompressionStream === "function" && typeof DecompressionStream === "function";

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Inflate, stopping as soon as the output passes `cap` bytes. */
export async function inflate(bytes: Uint8Array, cap = MAX_UNPACKED_BYTES): Promise<Uint8Array> {
  if (!hasStreams()) throw new ShareError("이 브라우저는 압축된 링크를 풀 수 없습니다. 최신 크롬·엣지·파이어폭스·사파리로 여세요.");
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  writer.write(bytes as BufferSource).catch(() => {});
  writer.close().catch(() => {});
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) {
        void reader.cancel().catch(() => {});
        throw new ShareError(`링크의 내용이 너무 큽니다 (풀면 ${Math.round(cap / 1048576)} MB 넘음). 열지 않았습니다.`);
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof ShareError) throw e;
    throw new ShareError("링크가 손상되었습니다 (압축을 풀 수 없음). 링크가 중간에 잘렸는지 확인하세요.");
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ------------------------------------------------------------ encoding

export async function encodeShare(input: ShareInput, opts: { compress?: boolean } = {}): Promise<Encoded> {
  const fw = input.firmware;
  const original = fw?.example ? undefined : fw?.bytes;
  const elf = original ? stripElf(original, input.strip ?? "none") : undefined;
  const firmware: FirmwareRef | undefined = fw && (fw.example || elf) ? { name: fw.name, ...(fw.example ? { example: fw.example } : {}) } : undefined;
  const doc: ShareDoc = {
    format: SHARE_FORMAT,
    version: SHARE_VERSION,
    project: {
      format: FORMAT,
      version: VERSION,
      name: input.name,
      parts: input.project.parts,
      wires: input.project.wires,
      ...(firmware ? { firmware } : {}),
      ...(input.project.scope ? { scope: input.project.scope } : {}),
      // M33: the student's sources, not the ELF built from them nor the
      // snapshot (the receiver rebuilds; sources compress to a few hundred bytes).
      ...(input.project.code ? { code: forShare(input.project.code) } : {}),
    },
    ...(elf && original ? { elf: { size: elf.length, originalSize: original.length, strip: input.strip ?? "none" } } : {}),
    ...(input.lesson ? { lesson: input.lesson } : {}),
    ...(input.result ? { result: input.result } : {}),
  };
  const json = new TextEncoder().encode(JSON.stringify(doc));
  const body = new Uint8Array(4 + json.length + (elf?.length ?? 0));
  new DataView(body.buffer).setUint32(0, json.length, true);
  body.set(json, 4);
  if (elf) body.set(elf, 4 + json.length);
  // Every receiver refuses more than this unpacked (decodeShare), however
  // well it compresses: no link that cannot be opened.
  if (body.length > MAX_UNPACKED_BYTES) {
    throw new ShareError(
      `내용이 너무 큽니다(${fmtBytes(body.length)}, 받는 쪽 한도 ${fmtBytes(MAX_UNPACKED_BYTES)}). 디버그 정보를 빼거나 파일로 저장해 보내세요.`,
    );
  }
  const compress = (opts.compress ?? true) && hasStreams();
  const packed = compress ? await deflate(body) : body;
  const all = new Uint8Array(1 + packed.length);
  all[0] = compress ? METHOD_DEFLATE : METHOD_STORED;
  all.set(packed, 1);
  return {
    fragment: `s${SHARE_VERSION}=${toBase64Url(all)}`,
    jsonBytes: json.length,
    elfBytes: elf?.length ?? 0,
    elfOriginalBytes: original?.length ?? 0,
    rawBytes: body.length,
    packedBytes: packed.length,
    compressed: compress,
  };
}

/** The page address (no query or fragment) with the share fragment. */
export const shareUrl = (page: string, fragment: string) => `${page.split("#")[0]}#${fragment}`;

/** The share fragment (`s1=…`) in a URL, a fragment or pasted text, if any. */
export function findFragment(text: string): string | null {
  const m = /(?:^|#)(s\d+=[A-Za-z0-9_-]*)/.exec(text.trim());
  return m ? m[1] : null;
}

/** Every share link in pasted text (one per line, or separated by spaces). */
export function findFragments(text: string): string[] {
  return [...text.matchAll(/(?:^|#)(s\d+=[A-Za-z0-9_-]*)/gm)].map((m) => m[1]);
}

// ------------------------------------------------------------ decoding

/** Read a share link. Throws ShareError with a message for people. */
export async function decodeShare(text: string, catalog: Record<string, CatalogEntry | undefined>): Promise<Received> {
  const frag = findFragment(text);
  if (!frag) throw new ShareError("Simucleo 공유 링크가 아닙니다.");
  const [, ver, data] = /^s(\d+)=(.*)$/.exec(frag)!;
  if (Number(ver) !== SHARE_VERSION) {
    throw new ShareError(
      Number(ver) > SHARE_VERSION
        ? `이 링크는 더 새 버전의 Simucleo에서 만들었습니다 (형식 ${ver}). 페이지를 새로 고쳐 최신 버전으로 여세요.`
        : `알 수 없는 링크 형식입니다 (형식 ${ver}).`,
    );
  }
  if (data.length > MAX_LINK_CHARS) throw new ShareError(`링크가 너무 깁니다 (${data.length.toLocaleString("ko-KR")}자). 열지 않았습니다.`);
  const all = fromBase64Url(data);
  if (all.length < 2) throw new ShareError("링크가 손상되었습니다 (내용이 없음).");
  let body: Uint8Array;
  if (all[0] === METHOD_STORED) body = all.subarray(1);
  else if (all[0] === METHOD_DEFLATE) body = await inflate(all.subarray(1));
  else throw new ShareError(`링크가 손상되었습니다 (알 수 없는 압축 방식 ${all[0]}).`);
  if (body.length > MAX_UNPACKED_BYTES) throw new ShareError("링크의 내용이 너무 큽니다. 열지 않았습니다.");
  if (body.length < 4) throw new ShareError("링크가 손상되었습니다 (너무 짧음).");
  const jsonLen = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0, true);
  if (jsonLen > body.length - 4) throw new ShareError("링크가 손상되었습니다 (길이가 맞지 않음). 링크가 중간에 잘렸는지 확인하세요.");
  let doc: Partial<ShareDoc>;
  try {
    doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(4, 4 + jsonLen)));
  } catch {
    throw new ShareError("링크가 손상되었습니다 (내용을 읽을 수 없음).");
  }
  if (!doc || typeof doc !== "object" || doc.format !== SHARE_FORMAT) throw new ShareError("Simucleo 공유 링크가 아닙니다 (형식).");
  if (doc.version !== SHARE_VERSION) throw new ShareError(`공유 형식 버전 ${String(doc.version)}은 이 시뮬레이터가 읽지 못합니다.`);
  if (!doc.project || typeof doc.project !== "object") throw new ShareError("링크에 프로젝트가 없습니다.");

  const rest = body.subarray(4 + jsonLen);
  const notes: string[] = [];
  const project: Record<string, unknown> = { ...doc.project };
  const fw = doc.project.firmware as Partial<FirmwareRef> | undefined;
  delete project.firmware;
  let elf: ShareDoc["elf"];
  if (doc.elf) {
    const e = doc.elf;
    if (!Number.isInteger(e.size) || e.size !== rest.length) throw new ShareError("링크가 손상되었습니다 (펌웨어 크기가 맞지 않음).");
    try {
      readElf(rest);
    } catch (err) {
      throw new ShareError(`링크 안의 펌웨어가 올바른 ELF가 아닙니다: ${err instanceof ElfError ? err.message : String(err)}`);
    }
    const strip: Strip = e.strip === "debug" || e.strip === "all" ? e.strip : "none";
    elf = { size: rest.length, originalSize: Number.isInteger(e.originalSize) ? e.originalSize : rest.length, strip };
    project.firmware = { name: typeof fw?.name === "string" ? fw.name : "firmware.elf", data: b64(rest) };
  } else {
    if (rest.length) throw new ShareError("링크가 손상되었습니다 (남는 내용이 있음).");
    if (fw && typeof fw.name === "string" && typeof fw.example === "string") {
      if (EXAMPLE_FILE.test(fw.example)) project.firmware = { name: fw.name, example: fw.example };
      else notes.push(`알 수 없는 예제 펌웨어 이름은 건너뜁니다.`);
    }
  }
  let loaded: Loaded;
  try {
    loaded = parseWith(JSON.stringify(project), catalog);
  } catch (err) {
    throw new ShareError(`링크의 프로젝트를 읽지 못했습니다: ${(err as Error).message}`);
  }
  loaded = { ...loaded, notes: [...loaded.notes, ...notes] };

  let lesson: string | undefined;
  if (doc.lesson !== undefined) {
    if (typeof doc.lesson === "string" && LESSON_ID.test(doc.lesson)) lesson = doc.lesson;
    else loaded.notes.push("알 수 없는 실습 id는 건너뜁니다.");
  }
  let result: LoadedResult | undefined;
  if (doc.result !== undefined) {
    const student = (doc.result as Partial<ResultsFile>)?.student;
    const source = `링크: ${typeof student === "string" && student.trim() ? student.trim().slice(0, 60) : "(이름 없음)"}`;
    [result] = await parseResults(source, JSON.stringify(doc.result));
  }
  return { loaded, elf, lesson, result, chars: frag.length };
}

/** "12.3 KB". */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
