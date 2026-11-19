/// <reference types="vite/client" />
// The lessons bundled with the site: every web/lessons/*.json, in `order`.
import { PART_BY_KIND } from "../parts";
import type { Lesson } from "./types";
import { validateLesson } from "./validate";

const files = import.meta.glob<Lesson>("../../lessons/*.json", { eager: true, import: "default" });

export interface LessonEntry {
  lesson: Lesson;
  /** Problems in the file (shown in the list instead of a start button). */
  errors: string[];
}

export const LESSONS: LessonEntry[] = Object.entries(files)
  .map(([path, lesson]) => ({
    lesson: { ...lesson, id: lesson.id ?? path.replace(/^.*\/|\.json$/g, "") },
    errors: validateLesson(lesson, new Set(Object.keys(PART_BY_KIND))),
  }))
  .sort((a, b) => (a.lesson.order ?? 0) - (b.lesson.order ?? 0));
