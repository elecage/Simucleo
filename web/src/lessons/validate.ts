// Structural check of a lesson file, so a typo in a teacher's lesson shows
// up as a message instead of a broken panel. Pure (unit tested with Node).
import { BEHAVIOUR_TYPES, WIRING_TYPES, type Lesson } from "./types.ts";

const KNOWN = new Set<string>([...WIRING_TYPES, ...BEHAVIOUR_TYPES]);

/** Required fields per check type (besides `type`). */
const REQUIRED: Record<string, string[]> = {
  part: ["kind"],
  connected: ["kind", "pin", "to"],
  series: ["from", "to", "through"],
  noWarnings: [],
  period: ["pin", "ms"],
  brightness: ["kind"],
  console: ["pattern"],
  consoleValues: ["pattern", "minSpread"],
  duty: ["pin", "min", "max"],
  motion: ["kind", "field", "minSpread"],
  display: ["kind"],
  running: [],
};

/** Problems found in a lesson (empty: fine). `kinds`: known part kinds, if given. */
export function validateLesson(raw: unknown, kinds?: Set<string>): string[] {
  const errors: string[] = [];
  const l = raw as Partial<Lesson>;
  if (!l || typeof l !== "object") return ["JSON 객체가 아닙니다"];
  for (const k of ["id", "title", "level", "goal"] as const) {
    if (typeof l[k] !== "string" || !l[k]) errors.push(`'${k}'가 없습니다`);
  }
  if (typeof l.order !== "number") errors.push("'order'(숫자)가 없습니다");
  const s = l.start;
  if (!(s === "empty" || (s && typeof s === "object" && ("example" in s || "project" in s)))) {
    errors.push("'start'는 \"empty\", {\"example\": …} 또는 {\"project\": …}이어야 합니다");
  }
  const f = l.firmware;
  if (f !== undefined && f !== "upload" && !(f && typeof f === "object" && typeof f.example === "string")) {
    errors.push("'firmware'는 \"upload\" 또는 {\"example\": \"….elf\"}이어야 합니다");
  }
  if (!Array.isArray(l.steps) || !l.steps.length) {
    errors.push("'steps'가 비어 있습니다");
    return errors;
  }
  l.steps.forEach((step, i) => {
    const at = `단계 ${i + 1}`;
    if (typeof step?.title !== "string") errors.push(`${at}: 'title'이 없습니다`);
    if (!(typeof step?.text === "string" || Array.isArray(step?.text))) errors.push(`${at}: 'text'가 없습니다`);
    if (!Array.isArray(step?.checks)) {
      errors.push(`${at}: 'checks'가 없습니다`);
      return;
    }
    step.checks.forEach((c, j) => {
      const where = `${at} 검사 ${j + 1}`;
      if (!KNOWN.has(c?.type)) {
        errors.push(`${where}: 알 수 없는 검사 '${String(c?.type)}'`);
        return;
      }
      for (const k of REQUIRED[c.type]) {
        if ((c as unknown as Record<string, unknown>)[k] === undefined) errors.push(`${where} (${c.type}): '${k}'가 없습니다`);
      }
      const kind = (c as { kind?: string }).kind;
      if (kinds && kind && !kinds.has(kind)) errors.push(`${where}: 알 수 없는 부품 종류 '${kind}'`);
      if ("pattern" in c) {
        try {
          new RegExp(c.pattern);
        } catch {
          errors.push(`${where}: 정규식 오류 /${c.pattern}/`);
        }
      }
    });
  });
  return errors;
}
