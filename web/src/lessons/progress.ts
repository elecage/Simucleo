// Per-lesson progress (kept in IndexedDB) and the results file students
// hand in. Pure apart from the storage helpers, which callers pass in.
import type { IntegrityField } from "./integrity.ts";
import type { CheckResult } from "./types.ts";

export interface CheckRecord {
  step: number;
  label: string;
  pass: boolean;
  /** When this result was last seen (ISO time). */
  at: string;
  hint?: string;
  detail?: string;
}

export interface LessonProgress {
  id: string;
  title: string;
  startedAt: string;
  /** First time every check passed at once. */
  completedAt?: string;
  /** Last "채점" run. */
  gradedAt?: string;
  /** Number of "채점" runs. */
  attempts: number;
  /** By check key (`step.check`, from 0). */
  checks: Record<string, CheckRecord>;
}

export type Progress = Record<string, LessonProgress>;

export const PROGRESS_KEY = "lessons:progress";
export const STUDENT_KEY = "lessons:student";
export const ACTIVE_KEY = "lessons:active";
export const BACKUP_KEY = "lessons:backup";

export const checkKey = (step: number, check: number) => `${step}.${check}`;

/** Record results; only changes in pass/fail move a check's time stamp. */
export function record(
  p: LessonProgress,
  results: { key: string; step: number; label: string; result: CheckResult }[],
  now: string,
): LessonProgress {
  const checks = { ...p.checks };
  let changed = false;
  for (const { key, step, label, result } of results) {
    const old = checks[key];
    if (old && old.pass === result.pass && old.hint === result.hint && old.detail === result.detail && old.label === label) continue;
    changed = true;
    checks[key] = {
      step,
      label,
      pass: result.pass,
      at: old && old.pass === result.pass ? old.at : now,
      ...(result.hint ? { hint: result.hint } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
    };
  }
  return changed ? { ...p, checks } : p;
}

/** A check the lesson has, as the results file lists it. */
export interface ExpectedCheck {
  key: string;
  step: number;
  label: string;
}

/** A check in a results file: a result, or `pending` (never run, e.g. not graded yet). */
export type ResultCheck = CheckRecord & { key: string; pending?: true };

export interface ResultsFile {
  format: "simucleo-lesson-results";
  version: 1;
  student: string;
  exportedAt: string;
  /** SHA-256 of the rest of the file (M24; older files have none). See integrity.ts. */
  integrity?: IntegrityField;
  lessons: {
    id: string;
    title: string;
    /** Step titles (M24; for the teacher view's column headers). */
    steps?: string[];
    startedAt: string;
    completedAt: string | null;
    attempts: number;
    passed: number;
    total: number;
    /** Every check of the lesson, `pending` ones too (older files: the
     * recorded ones only). */
    checks: ResultCheck[];
  }[];
}

export function resultsJson(
  progress: Progress,
  student: string,
  now: string,
  order: string[] = [],
  stepTitles: Record<string, string[]> = {},
  /** Every check of each lesson: those without a result are listed as
   * pending, results of checks the lesson no longer has are left out. */
  expected: Record<string, ExpectedCheck[]> = {},
): ResultsFile {
  const ids = Object.keys(progress).sort((a, b) => (order.indexOf(a) - order.indexOf(b)) || a.localeCompare(b));
  return {
    format: "simucleo-lesson-results",
    version: 1,
    student,
    exportedAt: now,
    lessons: ids.map((id) => {
      const p = progress[id];
      const want = expected[id];
      const checks: ResultCheck[] = want
        ? want.map((e) => (p.checks[e.key] ? { key: e.key, ...p.checks[e.key] } : { ...e, pass: false, pending: true, at: "" }))
        : Object.entries(p.checks)
            .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
            .map(([key, c]) => ({ key, ...c }));
      return {
        id,
        title: p.title,
        ...(stepTitles[id] ? { steps: stepTitles[id] } : {}),
        startedAt: p.startedAt,
        completedAt: p.completedAt ?? null,
        attempts: p.attempts,
        passed: checks.filter((c) => c.pass).length,
        total: checks.length,
        checks,
      };
    }),
  };
}

const csvCell = (v: string | number | boolean | null | undefined) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per check; with a BOM so spreadsheet programs read Korean right. */
export function resultsCsv(file: ResultsFile): string {
  const rows: (string | number | boolean | null)[][] = [
    ["student", "lesson_id", "lesson_title", "completed_at", "attempts", "step", "check", "result", "checked_at", "detail", "hint"],
  ];
  for (const l of file.lessons) {
    if (!l.checks.length) rows.push([file.student, l.id, l.title, l.completedAt, l.attempts, "", "", "", "", "", ""]);
    for (const c of l.checks) {
      rows.push([
        file.student,
        l.id,
        l.title,
        l.completedAt,
        l.attempts,
        c.step + 1,
        c.label,
        c.pending ? "pending" : c.pass ? "pass" : "fail",
        c.at,
        c.detail ?? "",
        c.pass ? "" : (c.hint ?? ""),
      ]);
    }
  }
  return "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
