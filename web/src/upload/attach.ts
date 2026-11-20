// Sources attached to an uploaded ELF (M39): which DWARF file shows which
// uploaded text, what is missing, and what is kept in IndexedDB.
import { matchSources, segments, suffixLength, type MatchTie } from "./match.ts";
import { crc32 } from "./zip.ts";
import type { SourceFile } from "./folder.ts";

/** Stored sources above this are kept for this session only. */
export const MAX_STORED_SOURCES = 16 * 1024 * 1024;

export interface Attached {
  /** The ELF these sources belong to (`elfKey`). */
  key: string;
  /** Changes with every upload (cache key for the texts on screen). */
  id: string;
  /** DWARF path → the uploaded file it matched and its text. */
  files: Record<string, { from: string; text: string }>;
  /** DWARF files with code in the project that no uploaded file matched. */
  missing: string[];
  /**
   * Unmatched DWARF files outside the project folder (the compiler's own
   * newlib/libgcc, built elsewhere): no source is expected for them.
   */
  outside: string[];
  ties: MatchTie[];
  /** Kept in IndexedDB (false: over `MAX_STORED_SOURCES`). */
  stored: boolean;
  bytes: number;
}

/** Identifies an ELF (its size and CRC-32), to find its stored sources again. */
export const elfKey = (b: Uint8Array) => `${b.length}:${crc32(b).toString(16).padStart(8, "0")}`;

const textBytes = (s: string) => new TextEncoder().encode(s).length;

/** Match `sources` to the DWARF files of the loaded ELF. */
export function attachSources(key: string, dwarfPaths: string[], sources: SourceFile[]): Attached {
  const byPath = new Map(sources.map((s) => [s.path, s.text]));
  const m = matchSources(dwarfPaths, [...byPath.keys()]);
  const files: Attached["files"] = {};
  let bytes = 0;
  // Where the project was on the build PC: each matched DWARF path minus
  // the part the uploaded path shares with it.
  const roots = new Set<string>();
  for (const [d, from] of Object.entries(m.matched)) {
    const text = byPath.get(from)!;
    files[d] = { from, text };
    bytes += textBytes(text);
    const ds = segments(d);
    roots.add(ds.slice(0, ds.length - suffixLength(ds, segments(from))).join("/") + "/");
  }
  const inProject = (d: string) => !roots.size || [...roots].some((r) => (segments(d).join("/") + "/").startsWith(r));
  return {
    key,
    id: `${Date.now()}-${Math.random()}`,
    files,
    missing: m.missing.filter(inProject),
    outside: m.missing.filter((d) => !inProject(d)),
    ties: m.ties,
    stored: bytes <= MAX_STORED_SOURCES,
    bytes,
  };
}

/** "소스 12개 연결 · DWARF에 있지만 없는 파일 3개(HAL 드라이버 등)". */
export function summary(a: Attached): string {
  const n = Object.keys(a.files).length;
  let s = `소스 ${n}개 연결`;
  if (a.missing.length) {
    const drivers = a.missing.some((p) => /\/(drivers|middlewares)\//i.test(p));
    s += ` · DWARF에 있지만 없는 파일 ${a.missing.length}개${drivers ? "(HAL 드라이버 등)" : ""}`;
  }
  if (a.ties.length) s += ` · 이름이 같은 후보가 여럿인 파일 ${a.ties.length}개`;
  return s;
}

/** Shape check of what IndexedDB gave back (an older or broken entry is ignored). */
export function isAttached(x: unknown): x is Attached {
  if (!x || typeof x !== "object") return false;
  const a = x as Attached;
  return (
    typeof a.key === "string" &&
    typeof a.id === "string" &&
    !!a.files &&
    typeof a.files === "object" &&
    Object.values(a.files).every((f) => f && typeof f.from === "string" && typeof f.text === "string") &&
    Array.isArray(a.missing) &&
    Array.isArray(a.outside) &&
    Array.isArray(a.ties)
  );
}
