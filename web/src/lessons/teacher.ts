// "선생님용 결과 모아보기" (M24): many students' results files in one
// table. Pure (unit tested with Node): parsing (JSON, and the CSV the panel
// also exports), merging with duplicates dropped, cells, pass rates and the
// CSV of the table. Nothing leaves the teacher's browser.
import { verify, type Integrity } from "./integrity.ts";
import type { ResultsFile } from "./progress.ts";

export type ResultLesson = ResultsFile["lessons"][number];

/** One student's results from one file (a CSV may hold several students). */
export interface LoadedResult {
  /** File name. */
  source: string;
  kind: "json" | "csv";
  integrity: Integrity;
  file?: ResultsFile;
  /** Why the file could not be read. */
  error?: string;
}

// ---------------------------------------------------------------- parsing

/** Rows of a CSV (RFC 4180: quotes, doubled quotes, CRLF), without a BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c !== ""));
}

/** Structural problems of a results JSON (empty: fine). */
function resultsErrors(f: Partial<ResultsFile>): string[] {
  if (!f || typeof f !== "object") return ["JSON 객체가 아닙니다"];
  if (f.format !== "simucleo-lesson-results") return ["Simucleo 실습 결과 파일이 아닙니다 (format)"];
  const errors: string[] = [];
  if (typeof f.student !== "string") errors.push("'student'가 없습니다");
  if (!Array.isArray(f.lessons)) return [...errors, "'lessons'가 없습니다"];
  f.lessons.forEach((l, i) => {
    if (typeof l?.id !== "string") errors.push(`실습 ${i + 1}: 'id'가 없습니다`);
    if (!Array.isArray(l?.checks)) errors.push(`실습 ${i + 1}: 'checks'가 없습니다`);
    else if (l.checks.some((c) => typeof c?.step !== "number" || typeof c?.pass !== "boolean")) {
      errors.push(`실습 ${i + 1}: 검사 결과 형식이 맞지 않습니다`);
    }
  });
  return errors;
}

/** Students' results from the CSV export (one file per student in it). */
function fromCsv(source: string, text: string): LoadedResult[] {
  const rows = parseCsv(text);
  const head = rows[0] ?? [];
  const col = (name: string) => head.indexOf(name);
  if (col("student") < 0 || col("lesson_id") < 0) return [{ source, kind: "csv", integrity: "unverified", error: "실습 결과 CSV가 아닙니다 (머리글)" }];
  const get = (r: string[], name: string) => (col(name) >= 0 ? (r[col(name)] ?? "") : "");
  const byStudent = new Map<string, ResultsFile>();
  for (const r of rows.slice(1)) {
    if (r.join(",") === head.join(",")) continue; // a header of a pasted-on file
    const student = get(r, "student");
    let file = byStudent.get(student);
    if (!file) {
      file = { format: "simucleo-lesson-results", version: 1, student, exportedAt: "", lessons: [] };
      byStudent.set(student, file);
    }
    const id = get(r, "lesson_id");
    let lesson = file.lessons.find((l) => l.id === id);
    if (!lesson) {
      lesson = {
        id,
        title: get(r, "lesson_title"),
        startedAt: "",
        completedAt: get(r, "completed_at") || null,
        attempts: Number(get(r, "attempts")) || 0,
        passed: 0,
        total: 0,
        checks: [],
      };
      file.lessons.push(lesson);
    }
    const step = Number(get(r, "step"));
    if (!get(r, "step") || !Number.isFinite(step)) continue;
    const index = lesson.checks.filter((c) => c.step === step - 1).length;
    const at = get(r, "checked_at");
    const pass = get(r, "result") === "pass";
    lesson.checks.push({
      key: `${step - 1}.${index}`,
      step: step - 1,
      label: get(r, "check"),
      pass,
      at,
      ...(get(r, "detail") ? { detail: get(r, "detail") } : {}),
      ...(get(r, "hint") ? { hint: get(r, "hint") } : {}),
    });
    lesson.total++;
    if (pass) lesson.passed++;
    // The CSV has no export time: the latest time in it stands in.
    for (const t of [at, lesson.completedAt ?? ""]) if (t > file.exportedAt) file.exportedAt = t;
  }
  return [...byStudent.values()].map((file) => ({ source, kind: "csv", integrity: "unverified", file }));
}

/** Read one dropped file: a results JSON (checked against its hash) or CSV. */
export async function parseResults(source: string, text: string): Promise<LoadedResult[]> {
  const t = text.replace(/^﻿/, "").trim();
  if (!t.startsWith("{")) return fromCsv(source, t);
  let raw: unknown;
  try {
    raw = JSON.parse(t);
  } catch (e) {
    return [{ source, kind: "json", integrity: "unverified", error: `JSON 오류: ${(e as Error).message}` }];
  }
  const errors = resultsErrors(raw as Partial<ResultsFile>);
  if (errors.length) return [{ source, kind: "json", integrity: "unverified", error: errors.join("; ") }];
  return [{ source, kind: "json", integrity: await verify(raw), file: raw as ResultsFile }];
}

// ---------------------------------------------------------------- merging

export interface Entry {
  student: string;
  source: string;
  integrity: Integrity;
  exportedAt: string;
  lesson: ResultLesson;
}

export interface Duplicate {
  student: string;
  lessonId: string;
  /** File kept (the latest export). */
  kept: string;
  dropped: string;
}

export interface LessonColumn {
  id: string;
  title: string;
  steps: { index: number; title: string }[];
}

export interface Merged {
  students: string[];
  lessons: LessonColumn[];
  /** By `entryKey(student, lesson)`. */
  entries: Record<string, Entry>;
  duplicates: Duplicate[];
  /** Files that could not be read. */
  errors: { source: string; error: string }[];
}

export const entryKey = (student: string, lessonId: string) => `${student}\n${lessonId}`;
/** Same student whatever the spacing: "kim  01 " is "kim 01". */
export const normStudent = (s: string) => s.trim().replace(/\s+/g, " ") || "(이름 없음)";

/** All files in one table: for each student and lesson the latest export only. */
export function mergeResults(loaded: LoadedResult[]): Merged {
  const entries: Record<string, Entry> = {};
  const duplicates: Duplicate[] = [];
  const errors: Merged["errors"] = [];
  const students: string[] = [];
  const lessons: LessonColumn[] = [];
  for (const r of loaded) {
    if (!r.file) {
      errors.push({ source: r.source, error: r.error ?? "읽지 못했습니다" });
      continue;
    }
    const student = normStudent(r.file.student);
    if (!students.includes(student)) students.push(student);
    for (const lesson of r.file.lessons) {
      const key = entryKey(student, lesson.id);
      const entry: Entry = { student, source: r.source, integrity: r.integrity, exportedAt: r.file.exportedAt ?? "", lesson };
      const old = entries[key];
      if (old) {
        // Ties go to the file loaded later.
        const newer = entry.exportedAt >= old.exportedAt;
        duplicates.push({ student, lessonId: lesson.id, kept: newer ? entry.source : old.source, dropped: newer ? old.source : entry.source });
        if (!newer) continue;
      }
      entries[key] = entry;
      let column = lessons.find((c) => c.id === lesson.id);
      if (!column) {
        column = { id: lesson.id, title: lesson.title || lesson.id, steps: [] };
        lessons.push(column);
      }
      const indices = new Set([...lesson.checks.map((c) => c.step), ...(lesson.steps ?? []).map((_, i) => i)]);
      for (const index of indices) {
        const title = lesson.steps?.[index];
        const have = column.steps.find((s) => s.index === index);
        if (!have) column.steps.push({ index, title: title ?? `단계 ${index + 1}` });
        else if (title && /^단계 \d+$/.test(have.title)) have.title = title;
      }
      column.steps.sort((a, b) => a.index - b.index);
    }
  }
  return { students, lessons, entries, duplicates, errors };
}

// ------------------------------------------------------------------ cells

export interface StepCell {
  status: "pass" | "partial" | "fail";
  passed: number;
  total: number;
  /** From the start of the lesson to the step's last check passing. */
  timeMs?: number;
}

export interface LessonCell {
  passed: number;
  total: number;
  /** 0–100. */
  score: number;
  completed: boolean;
  attempts: number;
  /** Start to completion. */
  timeMs?: number;
  steps: Record<number, StepCell>;
  integrity: Integrity;
  source: string;
}

const ms = (a: string | null | undefined, b: string | null | undefined) => {
  const d = Date.parse(b ?? "") - Date.parse(a ?? "");
  return Number.isFinite(d) && d >= 0 ? d : undefined;
};

export function lessonCell(e: Entry): LessonCell {
  const l = e.lesson;
  const steps: Record<number, StepCell> = {};
  for (const index of [...new Set(l.checks.map((c) => c.step))]) {
    const checks = l.checks.filter((c) => c.step === index);
    const passed = checks.filter((c) => c.pass).length;
    const status = passed === checks.length ? "pass" : passed ? "partial" : "fail";
    const last = checks.map((c) => c.at).sort().at(-1);
    steps[index] = { status, passed, total: checks.length, ...(status === "pass" && ms(l.startedAt, last) !== undefined ? { timeMs: ms(l.startedAt, last) } : {}) };
  }
  // Counted from the checks, not the file's own totals.
  const total = l.checks.length;
  const passed = l.checks.filter((c) => c.pass).length;
  const time = l.completedAt ? ms(l.startedAt, l.completedAt) : undefined;
  return {
    passed,
    total,
    score: total ? Math.round((100 * passed) / total) : 0,
    completed: !!l.completedAt,
    attempts: l.attempts ?? 0,
    ...(time !== undefined ? { timeMs: time } : {}),
    steps,
    integrity: e.integrity,
    source: e.source,
  };
}

export interface Rate {
  passed: number;
  /** Students who handed in this lesson (with checks in this step). */
  n: number;
}

export interface LessonRates {
  completed: Rate;
  steps: Record<number, Rate>;
}

/** Per lesson: how many students completed it, and passed each step. */
export function passRates(m: Merged): Record<string, LessonRates> {
  const out: Record<string, LessonRates> = {};
  for (const col of m.lessons) {
    const rates: LessonRates = { completed: { passed: 0, n: 0 }, steps: {} };
    for (const s of col.steps) rates.steps[s.index] = { passed: 0, n: 0 };
    for (const student of m.students) {
      const e = m.entries[entryKey(student, col.id)];
      if (!e) continue;
      const cell = lessonCell(e);
      rates.completed.n++;
      if (cell.completed) rates.completed.passed++;
      for (const [i, sc] of Object.entries(cell.steps)) {
        const r = (rates.steps[Number(i)] ??= { passed: 0, n: 0 });
        r.n++;
        if (sc.status === "pass") r.passed++;
      }
    }
    out[col.id] = rates;
  }
  return out;
}

export const ratePercent = (r: Rate | undefined) => (r && r.n ? Math.round((100 * r.passed) / r.n) : null);

// ------------------------------------------------------------------- rows

export interface Row {
  student: string;
  /** The worst of the student's files: tampered, unverified, verified. */
  integrity: Integrity;
  sources: string[];
  cells: Record<string, LessonCell | undefined>;
}

const RANK: Record<Integrity, number> = { verified: 0, unverified: 1, tampered: 2 };

export interface TableOptions {
  /** Part of a student's name. */
  filter?: string;
  /** Only this lesson's columns count (for `incompleteOnly`). */
  lesson?: string;
  /** Students who have not completed (the lesson, or some lesson). */
  incompleteOnly?: boolean;
  /** Only students with a tampered file. */
  tamperedOnly?: boolean;
  /** `student`, `integrity`, `score:<lesson>`, `time:<lesson>`, `step:<lesson>:<index>`. */
  sort?: { by: string; desc?: boolean };
}

function sortValue(r: Row, by: string): number | string | undefined {
  if (by === "student") return r.student;
  if (by === "integrity") return RANK[r.integrity];
  const [what, id, index] = by.split(":");
  const c = r.cells[id];
  if (!c) return undefined;
  if (what === "score") return c.score;
  if (what === "time") return c.timeMs;
  if (what === "step") {
    const s = c.steps[Number(index)];
    return s ? (s.status === "pass" ? 2 : s.status === "partial" ? 1 : 0) : undefined;
  }
  return undefined;
}

export function tableRows(m: Merged, opts: TableOptions = {}): Row[] {
  let rows: Row[] = m.students.map((student) => {
    const cells: Row["cells"] = {};
    const sources = new Set<string>();
    let integrity: Integrity = "verified";
    for (const col of m.lessons) {
      const e = m.entries[entryKey(student, col.id)];
      if (!e) continue;
      cells[col.id] = lessonCell(e);
      sources.add(e.source);
      if (RANK[e.integrity] > RANK[integrity]) integrity = e.integrity;
    }
    return { student, integrity, sources: [...sources], cells };
  });
  const f = opts.filter?.trim().toLowerCase();
  if (f) rows = rows.filter((r) => r.student.toLowerCase().includes(f));
  if (opts.tamperedOnly) rows = rows.filter((r) => r.integrity === "tampered");
  if (opts.incompleteOnly) {
    rows = rows.filter((r) =>
      opts.lesson ? !r.cells[opts.lesson]?.completed : m.lessons.some((c) => !r.cells[c.id]?.completed),
    );
  }
  const sort = opts.sort ?? { by: "student" };
  const dir = sort.desc ? -1 : 1;
  return rows
    .map((r, i) => ({ r, i, v: sortValue(r, sort.by) }))
    .sort((a, b) => {
      // Missing values last, whichever way.
      if (a.v === undefined || b.v === undefined) return a.v === b.v ? a.i - b.i : a.v === undefined ? 1 : -1;
      const d = typeof a.v === "string" ? a.v.localeCompare(b.v as string, "ko", { numeric: true }) : a.v - (b.v as number);
      return d * dir || a.i - b.i;
    })
    .map((x) => x.r);
}

// -------------------------------------------------------------------- CSV

export const INTEGRITY_KO: Record<Integrity, string> = { verified: "검증됨", tampered: "변조됨", unverified: "검증 안 됨" };

/** "3분 20초" */
export function fmtDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}분 ${s % 60}초` : `${m}분`;
  return m % 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${Math.floor(m / 60)}시간`;
}

const csvCell = (v: string | number | null | undefined) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The table as CSV (BOM for spreadsheets): one row per student, then the pass rates. */
export function tableCsv(m: Merged, rows: Row[], lesson?: string): string {
  const cols = m.lessons.filter((c) => !lesson || c.id === lesson);
  const head = ["student", "integrity", "files"];
  for (const c of cols) {
    head.push(`${c.title} 점수`, `${c.title} 통과`, `${c.title} 완료`, `${c.title} 시간(초)`, `${c.title} 채점 횟수`);
    for (const s of c.steps) head.push(`${c.title} ${s.index + 1}. ${s.title}`);
  }
  const out: (string | number | null)[][] = [head];
  for (const r of rows) {
    const line: (string | number | null)[] = [r.student, INTEGRITY_KO[r.integrity], r.sources.join(" ")];
    for (const c of cols) {
      const cell = r.cells[c.id];
      if (!cell) {
        line.push("", "", "", "", "", ...c.steps.map(() => ""));
        continue;
      }
      line.push(
        cell.score,
        `${cell.passed}/${cell.total}`,
        cell.completed ? "yes" : "no",
        cell.timeMs !== undefined ? Math.round(cell.timeMs / 1000) : "",
        cell.attempts,
      );
      for (const s of c.steps) {
        const sc = cell.steps[s.index];
        line.push(!sc ? "" : sc.status === "partial" ? `partial ${sc.passed}/${sc.total}` : sc.status);
      }
    }
    out.push(line);
  }
  const rates = passRates(m);
  const pct = (r: Rate | undefined) => (ratePercent(r) === null ? "" : `${ratePercent(r)}% (${r!.passed}/${r!.n})`);
  const footer: (string | number | null)[] = ["통과율", "", ""];
  for (const c of cols) {
    footer.push("", "", pct(rates[c.id]?.completed), "", "");
    for (const s of c.steps) footer.push(pct(rates[c.id]?.steps[s.index]));
  }
  out.push(footer);
  return "﻿" + out.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
