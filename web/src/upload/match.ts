// Matching uploaded files to the ELF's DWARF source paths (M39).
//
// The DWARF paths are where the student's PC built the firmware
// (`C:/Users/kim/STM32CubeIDE/workspace/blinky/Core/Src/main.c`, or
// `/home/kim/…`); the uploaded folder only has `blinky/Core/Src/main.c`. A
// file matches a DWARF path by the number of trailing path segments they
// share (case-insensitive, `\` = `/`); the file name must match at least.
// The longest shared suffix wins, a file serves one DWARF path, and equal
// best suffixes are reported as ties (the first by path is used).
//
// This lives in TypeScript, not in the Rust core: the uploaded file tree is
// only in the browser and the core already gives the DWARF paths
// (`debugFiles`), so nothing has to cross into the worker but the result.

export interface MatchTie {
  dwarf: string;
  candidates: string[];
}

export interface MatchResult {
  /** DWARF path → uploaded file path. */
  matched: Record<string, string>;
  /** DWARF paths no uploaded file matched. */
  missing: string[];
  ties: MatchTie[];
}

/** Path segments to compare: `/` or `\`, no empty, `.` or `..` parts, lower case. */
export function segments(path: string): string[] {
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "" && s !== "." && s !== "..")
    .map((s) => s.toLowerCase());
}

/** How many trailing segments two paths share. */
export function suffixLength(a: string[], b: string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

export function matchSources(dwarfPaths: string[], filePaths: string[]): MatchResult {
  const files = filePaths.map((p) => ({ p, s: segments(p) }));
  const byName = new Map<string, typeof files>();
  for (const f of files) {
    const name = f.s[f.s.length - 1];
    if (name === undefined) continue;
    byName.set(name, [...(byName.get(name) ?? []), f]);
  }
  // Every (DWARF path, file) pair with a common file name, best first.
  const pairs: { d: string; f: string; n: number }[] = [];
  for (const d of dwarfPaths) {
    const ds = segments(d);
    for (const f of byName.get(ds[ds.length - 1]) ?? []) pairs.push({ d, f: f.p, n: suffixLength(ds, f.s) });
  }
  pairs.sort((a, b) => b.n - a.n || a.f.localeCompare(b.f));
  const matched: Record<string, string> = {};
  const used = new Set<string>();
  const ties: MatchTie[] = [];
  for (const { d, f, n } of pairs) {
    if (matched[d] !== undefined || used.has(f)) continue;
    const same = pairs.filter((q) => q.d === d && q.n === n && !used.has(q.f)).map((q) => q.f);
    if (same.length > 1) ties.push({ dwarf: d, candidates: same });
    matched[d] = f;
    used.add(f);
  }
  return { matched, missing: dwarfPaths.filter((d) => matched[d] === undefined), ties };
}
