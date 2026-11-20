// "내 레슨" (M24): lessons made in the editor or loaded from files, kept in
// the browser's IndexedDB next to the progress. Pure list helpers.
import type { Lesson } from "./types.ts";

export const MINE_KEY = "lessons:mine";
/** The lesson being edited (so a reload does not lose it). */
export const DRAFT_KEY = "lessons:draft";
/** Id of the lesson the editor's "미리 보기" runs. */
export const PREVIEW_ID = "__preview";

/** The list with `lesson` added, or replacing the one with its id. */
export function upsertLesson(list: Lesson[], lesson: Lesson): Lesson[] {
  const i = list.findIndex((l) => l.id === lesson.id);
  return i < 0 ? [...list, lesson] : list.map((l, j) => (j === i ? lesson : l));
}

export const removeLesson = (list: Lesson[], id: string) => list.filter((l) => l.id !== id);

/** A fresh lesson for the editor. */
export function blankLesson(taken: string[] = []): Lesson {
  let n = 1;
  while (taken.includes(`my-lesson-${n}`)) n++;
  return {
    id: `my-lesson-${n}`,
    order: 100 + n,
    title: "새 실습",
    level: "입문",
    goal: "",
    start: "empty",
    steps: [{ title: "1단계", text: "", checks: [] }],
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/**
 * A lesson the editor and the lesson list can show without crashing, from
 * whatever was loaded (a file, IndexedDB): missing or mistyped fields get
 * safe defaults, so `validateLesson` can name what is wrong. Fields that
 * are fine are kept as they are. `null`: not a lesson at all (not an object).
 */
export function normalizeLesson(raw: unknown): Lesson | null {
  if (!isObject(raw)) return null;
  const l = raw as Record<string, unknown>;
  const s = l.start;
  let start: Lesson["start"] = "empty";
  if (isObject(s) && "project" in s) {
    const p = isObject(s.project) ? s.project : {};
    start = { project: { ...p, parts: Array.isArray(p.parts) ? p.parts : [], wires: Array.isArray(p.wires) ? p.wires : [] } as never };
  } else if (isObject(s) && "example" in s) start = { example: str(s.example) };
  const steps = (Array.isArray(l.steps) ? l.steps : []).map((x) => {
    const step = isObject(x) ? x : {};
    const text = step.text;
    return {
      ...step,
      title: str(step.title),
      text: typeof text === "string" ? text : Array.isArray(text) ? text.map(str) : "",
      checks: (Array.isArray(step.checks) ? step.checks : []).filter(isObject),
    };
  }) as unknown as Lesson["steps"];
  const out = {
    ...l,
    id: str(l.id),
    title: str(l.title),
    level: str(l.level),
    goal: str(l.goal),
    order: typeof l.order === "number" && Number.isFinite(l.order) ? l.order : 100,
    start,
    steps,
  } as Lesson;
  const f = l.firmware;
  if (!(f === undefined || f === "upload" || (isObject(f) && typeof f.example === "string"))) delete out.firmware;
  if (l.grade !== undefined && !isObject(l.grade)) delete out.grade;
  const c = l.code;
  if (c !== undefined && !(isObject(c) && typeof c.example === "string" && (c.main === undefined || typeof c.main === "string" || Array.isArray(c.main)))) delete out.code;
  return out;
}
