// A whole project folder or zip (M39): from what the student picked or
// dropped, find the firmware ELF and the source files, without reading what
// we do not need (object files, build output, images).
import { t } from "../i18n/index.ts";
import { isZip, readZip, ZipError, MAX_UNPACKED } from "./zip.ts";

/** A file from a picked or dropped folder, read only when needed. */
export interface PickedFile {
  /** Path relative to what was picked (`blinky/Core/Src/main.c`). */
  path: string;
  size: number;
  mtime: number;
  bytes(): Promise<Uint8Array>;
}

export interface ElfCandidate {
  path: string;
  size: number;
  mtime: number;
  bytes: Uint8Array;
}

export interface SourceFile {
  path: string;
  text: string;
}

export interface Collected {
  elfs: ElfCandidate[];
  sources: SourceFile[];
  /** Files looked at and left out (not source, binary, too large). */
  skipped: number;
}

/** One source file larger than this is left out (generated tables, …). */
export const MAX_SOURCE_FILE = 2 * 1024 * 1024;
/** An ELF larger than this is not firmware for a 512 KB flash part. */
export const MAX_ELF = 32 * 1024 * 1024;

const SOURCE_EXT = new Set(["c", "h", "s", "cpp", "cc", "cxx", "hpp", "hh", "hxx", "inc", "asm", "ino"]);
const ELF_EXT = new Set(["elf", "axf", "out"]);

const ext = (p: string) => {
  const b = p.slice(p.lastIndexOf("/") + 1);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i + 1).toLowerCase() : "";
};
export const isSourcePath = (p: string) => SOURCE_EXT.has(ext(p));
export const isElfPath = (p: string) => ELF_EXT.has(ext(p));
export const isZipPath = (p: string) => ext(p) === "zip";
export const isElf = (b: Uint8Array) => b.length >= 52 && b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46;

/**
 * The order to offer ELFs in: an `.elf` in a `Debug/` or `Release/` folder
 * (where CubeIDE puts it) first, then other `.elf`, then `.axf`/`.out`;
 * newest first within each.
 */
export function elfRank(path: string): number {
  const parts = path.toLowerCase().split("/");
  const dir = parts[parts.length - 2];
  const e = ext(path);
  if (e === "elf" && (dir === "debug" || dir === "release")) return 0;
  return e === "elf" ? 1 : 2;
}
export const sortElfs = <T extends { path: string; mtime: number }>(l: T[]): T[] =>
  [...l].sort((a, b) => elfRank(a.path) - elfRank(b.path) || b.mtime - a.mtime || a.path.localeCompare(b.path));

/** Source text: UTF-8, else EUC-KR (Korean comments saved by older editors); null for binary. */
export function decodeSource(b: Uint8Array): string | null {
  if (b.subarray(0, 8192).includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    try {
      return new TextDecoder("euc-kr").decode(b);
    } catch {
      return new TextDecoder("utf-8").decode(b);
    }
  }
}

/** Files and zips → the ELFs (checked by their magic) and the source files. */
export async function collect(files: PickedFile[]): Promise<Collected> {
  const out: Collected = { elfs: [], sources: [], skipped: 0 };
  let unpacked = 0;
  const take = async (path: string, size: number, mtime: number, bytes: () => Promise<Uint8Array>) => {
    if (isSourcePath(path)) {
      if (size > MAX_SOURCE_FILE) return void out.skipped++;
      const text = decodeSource(await bytes());
      if (text === null) return void out.skipped++;
      out.sources.push({ path, text });
    } else if (isElfPath(path)) {
      if (size > MAX_ELF) return void out.skipped++;
      const b = await bytes();
      if (isElf(b)) out.elfs.push({ path, size, mtime, bytes: b });
      else out.skipped++;
    } else out.skipped++;
  };
  for (const f of files) {
    if (isZipPath(f.path)) {
      const buf = await f.bytes();
      if (!isZip(buf)) throw new ZipError(t("{name}: zip 파일이 아닙니다.", { name: f.path }));
      const want = (e: { path: string; size: number }) =>
        (isSourcePath(e.path) && e.size <= MAX_SOURCE_FILE) || (isElfPath(e.path) && e.size <= MAX_ELF);
      const inner = await readZip(buf, want, MAX_UNPACKED - unpacked);
      for (const e of inner) {
        unpacked += e.data.length;
        await take(e.path, e.data.length, e.mtime, async () => e.data);
      }
    } else await take(f.path, f.size, f.mtime, f.bytes);
  }
  out.elfs = sortElfs(out.elfs);
  return out;
}

// ------------------------------------------------- from the browser

const fromFile = (f: File, path?: string): PickedFile => ({
  path: (path ?? (f.webkitRelativePath || f.name)).replace(/\\/g, "/").replace(/^\/+/, ""),
  size: f.size,
  mtime: f.lastModified,
  bytes: async () => new Uint8Array(await f.arrayBuffer()),
});

/** Files of an `<input type=file>` (with or without `webkitdirectory`). */
export const fromFileList = (l: FileList | File[]): PickedFile[] => Array.from(l, (f) => fromFile(f));

/** Folders skipped while walking a dropped tree (version control, build caches). */
const SKIP_DIRS = new Set([".git", ".svn", ".settings", "node_modules", ".metadata"]);

async function walk(entry: FileSystemEntry, prefix: string, out: PickedFile[]): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    out.push(fromFile(file, path));
  } else if (entry.isDirectory && !SKIP_DIRS.has(entry.name)) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // readEntries returns a batch at a time (100 in Chrome) until empty.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await walk(e, path, out);
    }
  }
}

/** What was dropped: folders walked, plain files and zips as they are. */
export async function fromDataTransfer(dt: DataTransfer): Promise<PickedFile[]> {
  const items = Array.from(dt.items ?? []).filter((i) => i.kind === "file");
  // Take the entries first: the DataTransfer is emptied after the event.
  const entries = items.map((i) => (typeof i.webkitGetAsEntry === "function" ? i.webkitGetAsEntry() : null));
  const plain = items.map((i) => i.getAsFile());
  const out: PickedFile[] = [];
  for (let i = 0; i < items.length; i++) {
    const e = entries[i];
    if (e) await walk(e, "", out);
    else if (plain[i]) out.push(fromFile(plain[i]!));
  }
  if (!items.length) out.push(...fromFileList(dt.files));
  return out;
}
