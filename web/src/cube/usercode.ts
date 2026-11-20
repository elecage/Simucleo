// USER CODE regions (M36), as CubeMX keeps them: what sits between
// `/* USER CODE BEGIN name */` and `/* USER CODE END name */` belongs to the
// student and survives regeneration, matched by name. Code in a region the
// new configuration no longer has (a peripheral switched off) is not dropped:
// it goes into one region at the end of the file, `#if 0`-ed out with a note
// saying where it came from. Pure; unit tested.

const BEGIN = /\/\*\s*USER CODE BEGIN (.+?)\s*\*\//g;

export interface Region {
  name: string;
  /** Text between the end of the BEGIN comment and the start of the END comment. */
  body: string;
  /** Offsets of the body in the file. */
  start: number;
  end: number;
}

/** The regions of a file, in order. A BEGIN without its END is skipped. */
export function regions(text: string): Region[] {
  const out: Region[] = [];
  BEGIN.lastIndex = 0;
  for (let m = BEGIN.exec(text); m; m = BEGIN.exec(text)) {
    const name = m[1];
    const start = m.index + m[0].length;
    const endRe = new RegExp(`/\\*\\s*USER CODE END ${escape(name)}\\s*\\*/`, "g");
    endRe.lastIndex = start;
    const e = endRe.exec(text);
    if (!e) continue;
    // A BEGIN inside this region would be a nested region: not CubeMX's.
    out.push({ name, body: text.slice(start, e.index), start, end: e.index });
    BEGIN.lastIndex = e.index + e[0].length;
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The region that collects user code of regions that are gone. */
export const ORPHAN_REGION = "Orphaned";
const ORPHAN_NOTE = (name: string) => `/* 설정에서 없어진 USER CODE 영역 '${name}'의 코드 (다시 생성할 때 옮겨 둠) */`;

/** Only whitespace (an untouched region). */
const blank = (s: string) => s.trim() === "";

export interface MergeResult {
  text: string;
  /** Regions whose user code was put back. */
  kept: string[];
  /** Regions that no longer exist and whose code went to the orphan block. */
  orphaned: string[];
}

/**
 * Put the user code of `old` into the freshly generated `fresh`: every region
 * of `fresh` takes the body of the region of the same name in `old` (if
 * that is not blank); bodies of regions that `fresh` lacks go, `#if 0`-ed,
 * into an `Orphaned` region appended to the file.
 */
export function mergeUserCode(fresh: string, old: string | null | undefined): MergeResult {
  if (!old) return { text: fresh, kept: [], orphaned: [] };
  const oldRegions = regions(old);
  const byName = new Map(oldRegions.map((r) => [r.name, r]));
  const freshRegions = regions(fresh);
  const freshNames = new Set(freshRegions.map((r) => r.name));
  const kept: string[] = [];
  let out = "";
  let at = 0;
  for (const r of freshRegions) {
    out += fresh.slice(at, r.start);
    const o = byName.get(r.name);
    if (o && !blank(o.body)) {
      out += o.body;
      if (o.body !== r.body) kept.push(r.name);
    } else out += r.body;
    at = r.end;
  }
  out += fresh.slice(at);

  // Orphans: the old Orphaned region as it was, then newly orphaned bodies.
  const orphaned: string[] = [];
  let orphanBody = "";
  const prev = byName.get(ORPHAN_REGION);
  if (prev && !blank(prev.body) && !freshNames.has(ORPHAN_REGION)) orphanBody = prev.body.replace(/\s+$/, "") + "\n";
  for (const r of oldRegions) {
    if (r.name === ORPHAN_REGION || freshNames.has(r.name) || blank(r.body)) continue;
    orphaned.push(r.name);
    orphanBody += `${orphanBody ? "\n" : "\n"}${ORPHAN_NOTE(r.name)}\n#if 0\n${r.body.replace(/^\n/, "").replace(/\s+$/, "")}\n#endif\n`;
  }
  if (orphanBody) {
    if (!orphanBody.startsWith("\n")) orphanBody = "\n" + orphanBody;
    out = out.replace(/\s*$/, "\n") + `\n/* USER CODE BEGIN ${ORPHAN_REGION} */${orphanBody}/* USER CODE END ${ORPHAN_REGION} */\n`;
  }
  return { text: out, kept, orphaned };
}

/**
 * Lines of `old` outside every region that differ from `fresh`'s — what
 * regeneration overwrites (shown as a warning before generating).
 */
export function editsOutsideRegions(fresh: string, old: string): number {
  const strip = (t: string) => {
    let s = "";
    let at = 0;
    for (const r of regions(t)) {
      s += t.slice(at, r.start);
      at = r.end;
    }
    return (s + t.slice(at)).split("\n").map((l) => l.trimEnd());
  };
  const a = strip(old);
  const b = new Set(strip(fresh));
  return a.filter((l) => l.trim() && !b.has(l)).length;
}

/** Replace the body of one region (for starter code); no-op if absent. */
export function setRegion(text: string, name: string, body: string): string {
  const r = regions(text).find((x) => x.name === name);
  if (!r) return text;
  return text.slice(0, r.start) + body + text.slice(r.end);
}
