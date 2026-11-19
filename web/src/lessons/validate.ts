// Structural check of a lesson file, so a typo in a teacher's lesson shows
// up as a message instead of a broken panel. Pure (unit tested with Node).
// M24: field types, enums and grading stimuli too, for the lesson editor.
import { BEHAVIOUR_TYPES, WIRING_TYPES, type Lesson } from "./types.ts";

const KNOWN = new Set<string>([...WIRING_TYPES, ...BEHAVIOUR_TYPES]);

/** Required fields per check type (besides `type`). */
export const REQUIRED: Record<string, string[]> = {
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

/** What a `series` check may go through. */
export const THROUGH = ["resistor", "led-5mm", "tact-switch", "potentiometer", "rgb-led:R", "rgb-led:G", "rgb-led:B"];

const NUMBERS = ["count", "ms", "tolerance", "channel", "above", "below", "min", "max", "minSpread", "minPixels"];
const STRINGS = ["kind", "pin", "to", "from", "pattern", "flags", "text", "label", "hint"];
/** Lesson ids: also keys of saved progress and results files. */
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Problems found in a lesson (empty: fine). `kinds`: known part kinds, if given. */
export function validateLesson(raw: unknown, kinds?: Set<string>): string[] {
  const errors: string[] = [];
  const l = raw as Partial<Lesson>;
  if (!l || typeof l !== "object" || Array.isArray(l)) return ["JSON 객체가 아닙니다"];
  for (const k of ["id", "title", "level", "goal"] as const) {
    if (typeof l[k] !== "string" || !l[k]) errors.push(`'${k}'가 없습니다`);
  }
  if (typeof l.id === "string" && l.id && !ID_PATTERN.test(l.id)) errors.push(`'id'는 영문·숫자·-·_만 씁니다 ('${l.id}')`);
  if (typeof l.order !== "number" || !Number.isFinite(l.order)) errors.push("'order'(숫자)가 없습니다");
  const s = l.start;
  if (!(s === "empty" || (s && typeof s === "object" && ("example" in s || "project" in s)))) {
    errors.push("'start'는 \"empty\", {\"example\": …} 또는 {\"project\": …}이어야 합니다");
  } else if (s && typeof s === "object" && "project" in s) {
    const p = s.project as Partial<{ parts: unknown; wires: unknown }>;
    if (!p || !Array.isArray(p.parts) || !Array.isArray(p.wires)) errors.push("'start.project'에는 'parts'와 'wires' 배열이 있어야 합니다");
  } else if (s && typeof s === "object" && typeof (s as { example: unknown }).example !== "string") {
    errors.push("'start.example'은 예제 파일 이름(문자열)이어야 합니다");
  }
  const f = l.firmware;
  if (f !== undefined && f !== "upload" && !(f && typeof f === "object" && typeof f.example === "string")) {
    errors.push("'firmware'는 \"upload\" 또는 {\"example\": \"….elf\"}이어야 합니다");
  }
  const g = l.grade;
  if (g !== undefined) {
    if (!g || typeof g !== "object") errors.push("'grade'는 객체여야 합니다");
    else {
      if (g.ms !== undefined && (typeof g.ms !== "number" || g.ms <= 0)) errors.push("'grade.ms'는 0보다 큰 숫자여야 합니다");
      if (g.stimuli !== undefined && !Array.isArray(g.stimuli)) errors.push("'grade.stimuli'는 배열이어야 합니다");
      (Array.isArray(g.stimuli) ? g.stimuli : []).forEach((st, i) => {
        const at = `조작 ${i + 1}`;
        const x = st as Record<string, unknown>;
        if (typeof x?.at !== "number") errors.push(`${at}: 'at'(ms, 숫자)이 없습니다`);
        if (typeof x?.press === "string") {
          if (x.ms !== undefined && typeof x.ms !== "number") errors.push(`${at}: 'ms'는 숫자여야 합니다`);
        } else if (x?.set && typeof x.set === "object") {
          const set = x.set as Record<string, unknown>;
          if (typeof set.kind !== "string" || typeof set.prop !== "string" || set.value === undefined) {
            errors.push(`${at}: 'set'에는 'kind', 'prop', 'value'가 있어야 합니다`);
          } else if (kinds && !kinds.has(set.kind)) errors.push(`${at}: 알 수 없는 부품 종류 '${set.kind}'`);
        } else errors.push(`${at}: 'press' 또는 'set'이 있어야 합니다`);
      });
    }
  }
  if (!Array.isArray(l.steps) || !l.steps.length) {
    errors.push("'steps'가 비어 있습니다");
    return errors;
  }
  l.steps.forEach((step, i) => {
    const at = `단계 ${i + 1}`;
    if (typeof step?.title !== "string" || !step.title) errors.push(`${at}: 'title'이 없습니다`);
    if (!(typeof step?.text === "string" || (Array.isArray(step?.text) && step.text.every((t) => typeof t === "string")))) {
      errors.push(`${at}: 'text'가 없습니다`);
    }
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
      const x = c as unknown as Record<string, unknown>;
      for (const k of REQUIRED[c.type]) {
        if (x[k] === undefined || x[k] === "") errors.push(`${where} (${c.type}): '${k}'가 없습니다`);
      }
      for (const k of NUMBERS) {
        if (x[k] !== undefined && (typeof x[k] !== "number" || !Number.isFinite(x[k]))) errors.push(`${where} (${c.type}): '${k}'는 숫자여야 합니다`);
      }
      for (const k of STRINGS) {
        if (x[k] !== undefined && typeof x[k] !== "string") errors.push(`${where} (${c.type}): '${k}'는 문자열이어야 합니다`);
      }
      const kind = x.kind;
      if (kinds && typeof kind === "string" && kind && !kinds.has(kind)) errors.push(`${where}: 알 수 없는 부품 종류 '${kind}'`);
      if (c.type === "series") {
        if (!Array.isArray(c.through) || !c.through.length) errors.push(`${where} (series): 'through'는 비어 있지 않은 배열이어야 합니다`);
        else {
          for (const t of c.through) if (!THROUGH.includes(t)) errors.push(`${where} (series): 'through'에 쓸 수 없는 것 '${String(t)}'`);
        }
      }
      if (c.type === "motion" && c.field !== undefined && c.field !== "angle" && c.field !== "rpm") {
        errors.push(`${where} (motion): 'field'는 "angle" 또는 "rpm"입니다`);
      }
      if (c.type === "duty" && c.mode !== undefined && c.mode !== "some" && c.mode !== "always") {
        errors.push(`${where} (duty): 'mode'는 "some" 또는 "always"입니다`);
      }
      if ("pattern" in c && typeof c.pattern === "string") {
        try {
          new RegExp(c.pattern, "flags" in c && typeof c.flags === "string" ? c.flags : undefined);
        } catch {
          errors.push(`${where}: 정규식 오류 /${c.pattern}/`);
        }
      }
    });
  });
  return errors;
}

/** A lesson file's text: the lesson, or why it is not one. */
export function parseLesson(text: string, kinds?: Set<string>): { lesson?: Lesson; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    return { errors: [`JSON 오류: ${(e as Error).message}`] };
  }
  const errors = validateLesson(raw, kinds);
  return errors.length ? { errors } : { lesson: raw as Lesson, errors };
}
