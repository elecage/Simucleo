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
