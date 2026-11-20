// "실습": guided exercises with automatic grading (M16). Wiring checks
// follow the circuit live; "채점" runs the firmware for long enough and
// judges the behaviour checks on what the frames showed.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "../editor/model";
import { download, idbGet, idbSet } from "../editor/project";
import { PART_BY_KIND } from "../parts";
import { nucleoSignal } from "../parts/nucleo";
import type { Netlist } from "../sim/simulator";
import type { Runner } from "../sim/useRunner";
import { behaviourLabel, evaluateBehaviour, gradeMs, probedPins, Recording } from "./behaviour";
import { involved, type Involved } from "./fromWiring";
import { LESSONS, type LessonEntry } from "./index";
import { seal } from "./integrity";
import { Markdown } from "./Markdown";
import { PREVIEW_ID } from "./mine";
import { parseLesson, validateLesson } from "./validate";
import {
  ACTIVE_KEY,
  checkKey,
  PROGRESS_KEY,
  record,
  resultsCsv,
  resultsJson,
  STUDENT_KEY,
  type ExpectedCheck,
  type LessonProgress,
  type Progress,
} from "./progress";
import { isWiring, type BehaviourCheck, type CheckResult, type Lesson, type WiringCheck } from "./types";
import { evaluateWiring, shortName, wiringLabel, type WiringContext } from "./wiring";

const nameOf = (kind: string) => PART_BY_KIND[kind]?.name ?? kind;
const short = (kind: string) => shortName({ nameOf }, kind);
const BOARD = "nucleo-f401re";
/** Arduino header name of an MCU signal (PA5 → D13). */
const HEADER = new Map<string, string>();
for (const p of PART_BY_KIND[BOARD]?.pins ?? []) {
  const s = nucleoSignal(p.id);
  if (s && /^(D\d+|A\d)$/.test(p.id) && !HEADER.has(s)) HEADER.set(s, p.id);
}

interface Props {
  runner: Runner;
  project: Project;
  netlist: Netlist;
  /** Load the lesson's starting circuit and firmware; false if the student cancelled. */
  onStart(lesson: Lesson): Promise<boolean>;
  /** Change a property of the first part of `kind` (grading stimuli). */
  onSetProp(kind: string, prop: string, value: number | string): void;
  /** A project saved before the last lesson replaced it, if any. */
  onRestoreBackup?: () => void;
  hasBackup: boolean;
  onClose(): void;
  /** "내 레슨" (M24). */
  myLessons?: Lesson[];
  onSaveMine?: (lessons: Lesson[]) => void;
  onRemoveMine?: (id: string) => void;
  /** Open the lesson editor: on a copy of a lesson, or on the current draft. */
  onEdit?: (lesson: Lesson | null) => void;
  /** Open the teacher's results view. */
  onTeacher?: () => void;
  /** The editor's lesson, run on the current project ("미리 보기"). */
  preview?: { lesson: Lesson; seq: number } | null;
  /** Wiring checks that failed at the last grading, for the schematic. */
  onMarks?: (marks: Involved[] | null) => void;
}

const now = () => new Date().toISOString();
const fmtTime = (iso: string) => new Date(iso).toLocaleString("ko-KR");
const KINDS = new Set(Object.keys(PART_BY_KIND));

export function LessonPanel({
  runner,
  project,
  netlist,
  onStart,
  onSetProp,
  onRestoreBackup,
  hasBackup,
  onClose,
  myLessons = [],
  onSaveMine,
  onRemoveMine,
  onEdit,
  onTeacher,
  preview,
  onMarks,
}: Props) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress>({});
  const [student, setStudent] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [grading, setGrading] = useState<{ elapsed: number; total: number } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const cancelGrade = useRef<(() => void) | null>(null);

  useEffect(() => {
    void Promise.all([idbGet<Progress>(PROGRESS_KEY), idbGet<string>(STUDENT_KEY), idbGet<string>(ACTIVE_KEY)]).then(([p, s, a]) => {
      setProgress(p ?? {});
      setStudent(s ?? "");
      // "내 레슨" may still be loading: an id not found just shows the list.
      if (a && a !== PREVIEW_ID) setActiveId(a);
      setLoaded(true);
    });
  }, []);
  useEffect(() => {
    if (loaded) void idbSet(PROGRESS_KEY, progress);
  }, [progress, loaded]);
  useEffect(() => {
    if (loaded) void idbSet(STUDENT_KEY, student);
  }, [student, loaded]);
  useEffect(() => {
    if (loaded) void idbSet(ACTIVE_KEY, activeId && activeId !== PREVIEW_ID ? activeId : "");
  }, [activeId, loaded]);
  // Stop a grading run when the panel goes away.
  useEffect(() => () => cancelGrade.current?.(), []);

  // Bundled lessons, then "내 레슨" (an id of a bundled one is an error), then the preview.
  const mineEntries: LessonEntry[] = useMemo(
    () =>
      myLessons.map((l) => ({
        lesson: l,
        errors: [
          ...validateLesson(l, KINDS),
          ...(LESSONS.some((e) => e.lesson.id === l.id) ? [`id '${l.id}'가 기본 실습과 같습니다`] : []),
        ],
      })),
    [myLessons],
  );
  const previewLesson = useMemo(
    () => (preview ? { ...preview.lesson, id: PREVIEW_ID, title: `(미리 보기) ${preview.lesson.title}` } : null),
    [preview],
  );
  const all = useMemo(
    () => [...LESSONS, ...mineEntries, ...(previewLesson ? [{ lesson: previewLesson, errors: [] }] : [])],
    [mineEntries, previewLesson],
  );
  const lesson = all.find((e) => e.lesson.id === activeId)?.lesson ?? null;
  const mine = lesson ? progress[lesson.id] : undefined;

  // ------------------------------------------------------ live wiring checks
  const warnings = runner.frame?.circuitWarnings;
  const ctx: WiringContext = useMemo(
    () => ({
      parts: project.parts,
      nets: netlist.nets,
      boardSignal: (kind, pin) => (kind === BOARD ? nucleoSignal(pin) : undefined),
      nameOf,
      headerOf: (s) => HEADER.get(s),
      warnings: warnings ?? [],
    }),
    [project.parts, netlist, warnings],
  );
  const live = useMemo(() => {
    const out: { key: string; step: number; label: string; result: CheckResult }[] = [];
    lesson?.steps.forEach((s, i) =>
      s.checks.forEach((c, j) => {
        if (isWiring(c)) out.push({ key: checkKey(i, j), step: i, label: c.label ?? wiringLabel(c, { nameOf }), result: evaluateWiring(c, ctx) });
      }),
    );
    return out;
  }, [lesson, ctx]);

  const update = useCallback(
    (id: string, f: (p: LessonProgress) => LessonProgress) =>
      setProgress((all) => {
        const p = all[id];
        if (!p) return all;
        const next = f(p);
        return next === p ? all : { ...all, [id]: next };
      }),
    [],
  );
  useEffect(() => {
    if (lesson && mine) update(lesson.id, (p) => record(p, live, now()));
  }, [lesson, mine, live, update]);

  // Results by key: live for wiring, the last grading run for behaviour.
  const result = (key: string, wiring: boolean): CheckResult | undefined =>
    wiring ? live.find((l) => l.key === key)?.result : mine?.checks[key] && !grading ? mine.checks[key] : undefined;

  const allChecks = lesson?.steps.flatMap((s, i) => s.checks.map((c, j) => ({ c, key: checkKey(i, j), step: i }))) ?? [];
  const passed = (k: { c: WiringCheck | BehaviourCheck; key: string }) => result(k.key, isWiring(k.c))?.pass === true;
  const complete = allChecks.length > 0 && allChecks.every(passed);
  const currentStep = lesson ? lesson.steps.findIndex((s, i) => s.checks.some((c, j) => !passed({ c, key: checkKey(i, j) }))) : -1;
  const stepsRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    stepsRef.current?.querySelector(".lesson-step.current")?.scrollIntoView?.({ block: "nearest" });
  }, [currentStep, activeId]);
  // After grading, show the first check that failed (with its hint).
  const gradedAt = mine?.gradedAt;
  useEffect(() => {
    if (gradedAt) stepsRef.current?.querySelector(".lesson-check.fail")?.scrollIntoView?.({ block: "center" });
  }, [gradedAt]);
  useEffect(() => {
    if (lesson && complete && mine && !mine.completedAt) update(lesson.id, (p) => ({ ...p, completedAt: now() }));
  }, [lesson, complete, mine, update]);

  // --------------------------------------------------------------- start
  const start = async (l: Lesson) => {
    if (!(await onStart(l))) return;
    setActiveId(l.id);
    setMessage(null);
    setMarksOn(false);
    // Starting over clears the last results (attempts and the first completion stay).
    setProgress((all) => ({
      ...all,
      [l.id]: all[l.id] ? { ...all[l.id], checks: {} } : { id: l.id, title: l.title, startedAt: now(), attempts: 0, checks: {} },
    }));
  };

  // The editor's "미리 보기": the lesson on the project as it is (no start circuit).
  useEffect(() => {
    if (!preview || !loaded) return;
    setActiveId(PREVIEW_ID);
    setMessage(null);
    setProgress((all) => ({
      ...all,
      [PREVIEW_ID]: { id: PREVIEW_ID, title: preview.lesson.title, startedAt: now(), attempts: 0, checks: {} },
    }));
  }, [preview, loaded]);

  // ------------------------------------------- grading marks (M24)
  // After "채점", the wiring checks that fail mark their pins and nets on
  // the schematic (and breadboard) until they pass or another lesson opens.
  const [marksOn, setMarksOn] = useState(false);
  useEffect(() => setMarksOn(false), [activeId]);
  const marks = useMemo(() => {
    if (!marksOn || !lesson) return null;
    const out: Involved[] = [];
    lesson.steps.forEach((s, i) =>
      s.checks.forEach((c, j) => {
        if (!isWiring(c) || live.find((l) => l.key === checkKey(i, j))?.result.pass !== false) return;
        const inv = involved(c, ctx);
        if (inv.pins.length || inv.signals.length) out.push(inv);
      }),
    );
    return out.length ? out : null;
  }, [marksOn, lesson, live, ctx]);
  const marksKey = JSON.stringify(marks);
  const onMarksRef = useRef(onMarks);
  onMarksRef.current = onMarks;
  useEffect(() => onMarksRef.current?.(marksKey === "null" ? null : (JSON.parse(marksKey) as Involved[])), [marksKey]);
  useEffect(() => () => onMarksRef.current?.(null), []);

  // ------------------------------------------------------------- grading
  const grade = () => {
    if (!lesson) return;
    if (!runner.firmware) {
      setMessage(
        lesson.firmware === "upload"
          ? "먼저 직접 만든 펌웨어를 'ELF 업로드'로 올리세요."
          : "펌웨어가 없습니다. 실습을 다시 시작하거나 예제를 불러오세요.",
      );
      return;
    }
    setMessage(null);
    const total = gradeMs(lesson);
    const stimuli = (lesson.grade?.stimuli ?? []).map((s) => ({ s, done: false, released: false }));
    const rec = new Recording();
    const epoch = (Date.now() % 1_000_000_000) + 1;
    const partOf = (kind: string) => project.parts.find((p) => p.kind === kind)?.id;
    setGrading({ elapsed: 0, total });
    runner.setProbes(probedPins(lesson), "lesson");
    // Stimuli are timed on frames: at ×1 a frame covers at most ~100 ms of
    // simulated time, so a press never starts and ends in one frame (which
    // would give the firmware no time to see it) at a faster setting.
    runner.setSpeedCap(1);
    let finished = false;
    /** Let go of whatever grading still holds and stop the run. */
    const stop = () => {
      finished = true;
      unsubscribe();
      cancelGrade.current = null;
      runner.pause();
      runner.setSpeedCap(Infinity);
      runner.setProbes([], "lesson");
      for (const st of stimuli) {
        if ("press" in st.s && st.done && !st.released) {
          st.released = true;
          runner.press(st.s.press === "B1" ? "B1" : (partOf(st.s.press) ?? st.s.press), false);
        }
      }
    };
    const finish = () => {
      if (finished) return;
      stop();
      const partsOfKind = (kind: string) => project.parts.filter((p) => p.kind === kind).map((p) => p.id);
      const results: { key: string; step: number; label: string; result: CheckResult }[] = [];
      lesson.steps.forEach((s, i) =>
        s.checks.forEach((c, j) => {
          if (isWiring(c)) return;
          results.push({
            key: checkKey(i, j),
            step: i,
            label: c.label ?? behaviourLabel(c, short),
            result: evaluateBehaviour(c, rec, partsOfKind, short),
          });
        }),
      );
      const t = now();
      update(lesson.id, (p) => ({ ...record(p, results, t), gradedAt: t, attempts: p.attempts + 1 }));
      setGrading(null);
      setMarksOn(true);
    };
    const unsubscribe = runner.onFrame((e) => {
      if (e.epoch !== epoch || finished) return;
      rec.add(e.frame, e.console);
      const t = rec.elapsed;
      for (const st of stimuli) {
        const s = st.s;
        if (!st.done && t >= s.at) {
          st.done = true;
          if ("press" in s) runner.press(s.press === "B1" ? "B1" : (partOf(s.press) ?? s.press), true);
          else onSetProp(s.set.kind, s.set.prop, s.set.value);
        }
        if ("press" in s && st.done && !st.released && t >= s.at + (s.ms ?? 100)) {
          st.released = true;
          runner.press(s.press === "B1" ? "B1" : (partOf(s.press) ?? s.press), false);
        }
      }
      setGrading({ elapsed: t, total });
      if (t >= total || rec.stopped) finish();
    });
    cancelGrade.current = () => {
      stop();
      setGrading(null);
    };
    runner.resetEpoch(epoch);
    runner.run();
  };

  // -------------------------------------------------------------- export
  const exportResults = async (kind: "json" | "csv") => {
    const order = all.map((e) => e.lesson.id);
    // Not the editor's preview runs.
    const handedIn = Object.fromEntries(Object.entries(progress).filter(([id]) => id !== PREVIEW_ID));
    const titles = Object.fromEntries(all.map((e) => [e.lesson.id, e.lesson.steps.map((s) => s.title)]));
    // Every check of each lesson: those not run yet (behaviour checks before
    // "채점") go in as pending, so the teacher does not see unfinished work as done.
    const expected: Record<string, ExpectedCheck[]> = Object.fromEntries(
      all.map((e) => [
        e.lesson.id,
        e.lesson.steps.flatMap((s, i) =>
          s.checks.map((c, j) => ({
            key: checkKey(i, j),
            step: i,
            label: c.label ?? (isWiring(c) ? wiringLabel(c, { nameOf }) : behaviourLabel(c, short)),
          })),
        ),
      ]),
    );
    const file = resultsJson(handedIn, student.trim(), now(), order, titles, expected);
    const base = `lesson-results_${student.trim().replace(/[^\p{L}\p{N}.-]+/gu, "_") || "noname"}`;
    if (kind === "json") {
      // With a SHA-256 of its content: the teacher view flags casual edits (M24).
      const sealed = await seal(file);
      download(`${base}.json`, new Blob([JSON.stringify(sealed, null, 2) + "\n"], { type: "application/json" }));
    } else download(`${base}.csv`, new Blob([resultsCsv(file)], { type: "text/csv" }));
  };

  // ------------------------------------------------------- my lessons
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const importLessons = async (files: File[]) => {
    const ok: Lesson[] = [];
    const errors: string[] = [];
    for (const f of files) {
      const r = parseLesson(await f.text(), KINDS);
      if (r.lesson && LESSONS.some((e) => e.lesson.id === r.lesson!.id)) errors.push(`${f.name}: id '${r.lesson.id}'가 기본 실습과 같습니다`);
      else if (r.lesson) ok.push(r.lesson);
      else errors.push(`${f.name}: ${r.errors.join("; ")}`);
    }
    if (ok.length) onSaveMine?.(ok);
    setImportErrors(errors);
  };

  const lessonItem = ({ lesson: l, errors }: LessonEntry, mineList: boolean) => {
    const p = progress[l.id];
    return (
      <li key={l.id} data-lesson={l.id}>
        <div>
          <b>{l.title}</b> <span className="lesson-level">{l.level}</span>
          {p?.completedAt && <span title={`완료 ${fmtTime(p.completedAt)}`}> ✅</span>}
        </div>
        <div className="hint">{l.goal}</div>
        {errors.length ? (
          <div className="error">레슨 파일 오류: {errors.join("; ")}</div>
        ) : (
          <div className="lesson-actions">
            {p ? (
              <>
                <button onClick={() => (setActiveId(l.id), setMessage(null))} title="지금 회로 그대로 이어서 합니다">
                  이어서 하기
                </button>{" "}
                <button onClick={() => void start(l)} title="시작 회로와 펌웨어를 다시 불러옵니다">
                  처음부터
                </button>
              </>
            ) : (
              <button onClick={() => void start(l)}>시작</button>
            )}
          </div>
        )}
        {(onEdit || (mineList && onRemoveMine)) && (
          <div className="lesson-actions">
            {onEdit && (
              <button className="small" onClick={() => onEdit(mineList ? l : { ...l, id: `${l.id}-copy`, title: `${l.title} (복사본)` })}>
                {mineList ? "편집" : "복사해서 편집"}
              </button>
            )}{" "}
            {mineList && onRemoveMine && (
              <button
                className="small"
                onClick={() => window.confirm(`'${l.title}'을(를) 내 레슨에서 지울까요?`) && onRemoveMine(l.id)}
                aria-label={`${l.title} 삭제`}
              >
                삭제
              </button>
            )}
          </div>
        )}
      </li>
    );
  };

  const studentRow = (
    <div className="lesson-student">
      <label>
        이름{" "}
        <input value={student} onChange={(e) => setStudent(e.target.value)} placeholder="학번 이름" aria-label="학생 이름" />
      </label>
      <div>
        <button onClick={() => void exportResults("csv")} title="실습별 검사 결과를 CSV로 저장 (선생님께 제출)">
          결과 내보내기 (CSV)
        </button>{" "}
        <button onClick={() => void exportResults("json")} title="같은 내용을 JSON으로 저장 (변조 확인용 해시 포함, 선생님용 모아보기에 권장)">
          JSON
        </button>
      </div>
    </div>
  );

  return (
    <aside className="lesson-panel" aria-label="실습">
      <header>
        <b>실습</b>
        {lesson && (
          <button onClick={() => (cancelGrade.current?.(), setActiveId(null))} title="실습 목록으로">
            ← 목록
          </button>
        )}
        <button className="close" onClick={onClose} aria-label="실습 닫기">
          ×
        </button>
      </header>

      {!lesson ? (
        <>
          <p className="hint">실습을 고르면 시작 회로와 펌웨어를 불러옵니다. 배선 검사는 바로바로, 동작 검사는 '채점'으로 확인합니다.</p>
          <ol className="lesson-list">{LESSONS.map((e) => lessonItem(e, false))}</ol>
          <section className="lesson-mine" aria-label="내 레슨">
            <h3>내 레슨</h3>
            {mineEntries.length ? (
              <ol className="lesson-list">{mineEntries.map((e) => lessonItem(e, true))}</ol>
            ) : (
              <p className="hint">레슨 편집기로 만들거나 레슨 파일(JSON)을 불러오면 여기에 나옵니다. 이 브라우저에만 저장됩니다.</p>
            )}
            <div className="lesson-actions">
              {onEdit && <button onClick={() => onEdit(null)}>✏️ 레슨 편집기</button>}{" "}
              <label className="file-btn small" title="레슨 JSON 파일을 내 레슨에 추가합니다">
                레슨 파일 불러오기
                <input
                  type="file"
                  accept=".json,application/json"
                  multiple
                  hidden
                  data-testid="lesson-import"
                  onChange={(e) => {
                    void importLessons([...(e.target.files ?? [])]);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
            {importErrors.map((e) => (
              <div key={e} className="error" role="alert">
                {e}
              </div>
            ))}
          </section>
          {onTeacher && (
            <p>
              <button onClick={onTeacher} title="여러 학생의 결과 파일을 한 표로 모아 봅니다 (파일은 이 브라우저 밖으로 나가지 않습니다)">
                👩‍🏫 선생님용 결과 모아보기
              </button>
            </p>
          )}
          {hasBackup && onRestoreBackup && (
            <p>
              <button onClick={onRestoreBackup} title="실습을 시작하기 전에 열려 있던 프로젝트">
                실습 전 프로젝트 되돌리기
              </button>
            </p>
          )}
          {studentRow}
        </>
      ) : (
        <>
          <h2 className="lesson-title">{lesson.title}</h2>
          {lesson.id === PREVIEW_ID && (
            <div className="lesson-preview" data-testid="lesson-preview">
              편집 중인 레슨을 <b>지금 회로와 펌웨어</b>로 실행합니다 (시작 회로는 불러오지 않음).{" "}
              {onEdit && <button onClick={() => onEdit(null)}>편집기로 돌아가기</button>}
            </div>
          )}
          <p className="hint">
            <span className="lesson-level">{lesson.level}</span> {lesson.goal}
          </p>
          <p className="hint" data-testid="lesson-firmware">
            펌웨어: {runner.firmware ?? "없음"}
            {lesson.firmware === "upload" && " — 직접 빌드한 ELF를 'ELF 업로드'로 올리세요."}
          </p>
          {complete && mine?.completedAt && (
            <div className="lesson-complete" data-testid="lesson-complete" role="status">
              🎉 실습 완료! <span className="dim">({fmtTime(mine.completedAt)})</span>
            </div>
          )}
          <ol className="lesson-steps" ref={stepsRef}>
            {lesson.steps.map((s, i) => {
              // A step with nothing to check (reading, building firmware) is never "done".
              const stepDone = s.checks.length > 0 && s.checks.every((c, j) => passed({ c, key: checkKey(i, j) }));
              return (
                <li key={i} className={i === currentStep ? "lesson-step current" : stepDone ? "lesson-step done" : "lesson-step"} data-step={i}>
                  <h3>
                    {stepDone ? "✅ " : ""}
                    {i + 1}. {s.title}
                  </h3>
                  {stepDone && i !== currentStep ? (
                    <details>
                      <summary className="dim">설명 보기</summary>
                      <Markdown text={s.text} />
                    </details>
                  ) : (
                    <Markdown text={s.text} />
                  )}
                  <ul className="lesson-checks">
                    {s.checks.map((c, j) => {
                      const key = checkKey(i, j);
                      const wiring = isWiring(c);
                      const r = result(key, wiring);
                      const label = c.label ?? (wiring ? wiringLabel(c, { nameOf }) : behaviourLabel(c, short));
                      const status = r ? (r.pass ? "pass" : "fail") : "pending";
                      return (
                        <li key={key} className={`lesson-check ${status}`} data-check={key} data-status={status} data-testid="lesson-check">
                          <span className="mark">{status === "pass" ? "✅" : status === "fail" ? "❌" : "⬜"}</span>
                          <span>
                            {label}
                            {!wiring && <span className="dim"> · 채점</span>}
                            {r?.detail && <span className="dim"> · {r.detail}</span>}
                            {r && !r.pass && <span className="check-hint">{c.hint ?? r.hint}</span>}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ol>
          <div className="lesson-grade">
            {grading ? (
              <>
                <progress value={grading.elapsed} max={grading.total} data-testid="grade-progress" />{" "}
                <span className="dim">
                  채점 중… {(grading.elapsed / 1000).toFixed(1)} / {(grading.total / 1000).toFixed(1)} s
                </span>{" "}
                <button onClick={() => cancelGrade.current?.()}>중지</button>
              </>
            ) : (
              <>
                <button className="primary" onClick={grade} title="펌웨어를 리셋하고 정해진 시간 동안 실행해 동작을 검사합니다">
                  채점
                </button>{" "}
                <span className="dim">
                  {(gradeMs(lesson) / 1000).toFixed(1)} s 동안 실행합니다
                  {mine?.gradedAt ? ` · 마지막 채점 ${fmtTime(mine.gradedAt)}` : ""}
                </span>
              </>
            )}
            {message && (
              <div className="error" role="alert">
                {message}
              </div>
            )}
            {marks && !grading && (
              <div className="hint lesson-marks" data-testid="lesson-marks">
                🔴 틀린 배선 검사 {marks.length}개와 관련된 핀·넷을 회로도와 브레드보드에 빨갛게 표시했습니다.
              </div>
            )}
          </div>
          {studentRow}
        </>
      )}
    </aside>
  );
}
