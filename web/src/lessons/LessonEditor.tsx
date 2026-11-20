// "레슨 편집기" (M24): make or change a lesson in the app — its text, steps,
// hints and checks (a form per check type), wiring checks generated from
// the circuit on screen, a try-run on the current project, and saving to
// "내 레슨" or a JSON file. The lesson is checked as it is edited.
import { useMemo, useState } from "react";
import type { Project } from "../editor/model";
import { download } from "../editor/project";
import { t } from "../i18n";
import { PARTS, PART_BY_KIND } from "../parts";
import type { Example } from "../run/RunControls";
import { checksFromWiring, POWER } from "./fromWiring";
import { LESSONS } from "./index";
import { normalizeLesson } from "./mine";
import { BEHAVIOUR_TYPES, WIRING_TYPES, type Check, type Lesson, type LessonStep, type Stimulus } from "./types";
import { REQUIRED, THROUGH, validateLesson } from "./validate";
import type { WiringContext } from "./wiring";

interface Props {
  draft: Lesson;
  onChange(l: Lesson): void;
  examples: Example[];
  project: Project;
  wiring: WiringContext;
  /** Store in "내 레슨". */
  onSaveMine(l: Lesson): void;
  /** Run the draft on the current project. */
  onPreview(l: Lesson): void;
  onNew(): void;
  onClose(): void;
}

const KINDS = new Set(Object.keys(PART_BY_KIND));
const TYPE_KO: Record<string, string> = {
  part: t("부품 있음 (part)"),
  connected: t("핀 연결 (connected)"),
  series: t("직렬 연결 (series)"),
  noWarnings: t("전기 규칙 경고 없음 (noWarnings)"),
  period: t("핀 주기 (period)"),
  brightness: t("LED 밝기 (brightness)"),
  console: t("콘솔 출력 (console)"),
  consoleValues: t("콘솔 숫자 변화 (consoleValues)"),
  duty: t("PWM 듀티비 (duty)"),
  motion: t("서보·모터 움직임 (motion)"),
  display: t("디스플레이 표시 (display)"),
  running: t("펌웨어가 멈추지 않음 (running)"),
};

type FieldType = "kind" | "signal" | "text" | "number" | "through" | "select";
interface Field {
  k: string;
  label: string;
  t: FieldType;
  options?: string[];
  placeholder?: string;
}
const FIELDS: Record<string, Field[]> = {
  part: [
    { k: "kind", label: t("부품 종류"), t: "kind" },
    { k: "count", label: t("개수 (기본 1)"), t: "number" },
  ],
  connected: [
    { k: "kind", label: t("부품 종류"), t: "kind" },
    { k: "pin", label: t("부품 핀"), t: "text", placeholder: "SDA" },
    { k: "to", label: t("연결할 신호"), t: "signal" },
  ],
  series: [
    { k: "from", label: t("시작 신호"), t: "signal" },
    { k: "to", label: t("끝 신호"), t: "signal" },
    { k: "through", label: t("사이의 부품 (쉼표로)"), t: "through" },
  ],
  noWarnings: [],
  period: [
    { k: "pin", label: t("핀"), t: "signal" },
    { k: "ms", label: t("주기 (ms)"), t: "number" },
    { k: "tolerance", label: t("허용 오차 (0.05 = ±5%)"), t: "number" },
  ],
  brightness: [
    { k: "kind", label: t("LED 종류"), t: "kind" },
    { k: "channel", label: t("RGB 채널 (0 R, 1 G, 2 B)"), t: "number" },
    { k: "above", label: t("이보다 밝은 순간 (0–1)"), t: "number" },
    { k: "below", label: t("이보다 어두운 순간 (0–1)"), t: "number" },
  ],
  console: [
    { k: "pattern", label: t("정규식"), t: "text", placeholder: "hello" },
    { k: "flags", label: t("정규식 플래그"), t: "text", placeholder: "i" },
    { k: "count", label: t("횟수 (기본 1)"), t: "number" },
  ],
  consoleValues: [
    { k: "pattern", label: t("정규식 (첫 괄호가 숫자)"), t: "text", placeholder: "pot\\s+(\\d+)" },
    { k: "minSpread", label: t("최소 변화량"), t: "number" },
  ],
  duty: [
    { k: "pin", label: t("핀"), t: "signal" },
    { k: "min", label: t("최소 (0–1)"), t: "number" },
    { k: "max", label: t("최대 (0–1)"), t: "number" },
    { k: "mode", label: t("언제"), t: "select", options: ["", "some", "always"] },
  ],
  motion: [
    { k: "kind", label: t("부품 종류"), t: "kind" },
    { k: "field", label: t("값"), t: "select", options: ["angle", "rpm"] },
    { k: "minSpread", label: t("최소 변화량"), t: "number" },
  ],
  display: [
    { k: "kind", label: t("디스플레이 종류"), t: "kind" },
    { k: "minPixels", label: t("최소 픽셀 (OLED, 기본 20)"), t: "number" },
    { k: "text", label: t("글자 정규식 (LCD)"), t: "text" },
  ],
  running: [],
};
const DEFAULTS: Record<string, Record<string, unknown>> = {
  part: { kind: "led-5mm" },
  connected: { kind: "led-5mm", pin: "A", to: "PA5" },
  series: { from: "PA5", to: "GND", through: ["resistor", "led-5mm"] },
  noWarnings: {},
  period: { pin: "PA5", ms: 1000, tolerance: 0.05 },
  brightness: { kind: "led-5mm", above: 0.5, below: 0.1 },
  console: { pattern: "hello" },
  consoleValues: { pattern: "(\\d+)", minSpread: 100 },
  duty: { pin: "PA5", min: 0.4, max: 0.6 },
  motion: { kind: "servo", field: "angle", minSpread: 90 },
  display: { kind: "oled-ssd1306" },
  running: {},
};
const SIGNALS = [...POWER, ...["A", "B", "C"].flatMap((p) => Array.from({ length: 16 }, (_, i) => `P${p}${i}`))];

const textOf = (s: string | string[]) => (Array.isArray(s) ? s.join("\n") : s);
const move = <T,>(list: T[], i: number, d: number) => {
  const j = i + d;
  if (j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
};

function CheckForm({ c, onChange, onRemove, onMove }: { c: Check; onChange(c: Check): void; onRemove(): void; onMove(d: number): void }) {
  const x = c as unknown as Record<string, unknown>;
  const set = (k: string, v: unknown) => {
    const next = { ...x };
    if (v === undefined || v === "") delete next[k];
    else next[k] = v;
    onChange(next as unknown as Check);
  };
  const field = (f: Field) => {
    const v = x[f.k];
    const id = `${f.k}`;
    let input;
    if (f.t === "kind")
      input = (
        <select value={String(v ?? "")} onChange={(e) => set(f.k, e.target.value)} aria-label={f.label}>
          <option value="">{t("(고르기)")}</option>
          {PARTS.filter((p) => p.category !== "board").map((p) => (
            <option key={p.kind} value={p.kind}>
              {p.name} ({p.kind})
            </option>
          ))}
        </select>
      );
    else if (f.t === "select")
      input = (
        <select value={String(v ?? "")} onChange={(e) => set(f.k, e.target.value || undefined)} aria-label={f.label}>
          {f.options!.map((o) => (
            <option key={o} value={o}>
              {o || t("(기본)")}
            </option>
          ))}
        </select>
      );
    else if (f.t === "number")
      input = (
        <input
          type="number"
          step="any"
          value={v === undefined ? "" : String(v)}
          onChange={(e) => set(f.k, e.target.value === "" ? undefined : Number(e.target.value))}
          aria-label={f.label}
        />
      );
    else if (f.t === "through")
      input = (
        <input
          value={Array.isArray(v) ? v.join(", ") : ""}
          list="lesson-through"
          onChange={(e) =>
            set(
              f.k,
              e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
          aria-label={f.label}
          placeholder="resistor, led-5mm"
        />
      );
    else
      input = (
        <input
          value={String(v ?? "")}
          list={f.t === "signal" ? "lesson-signals" : undefined}
          onChange={(e) => set(f.k, e.target.value)}
          aria-label={f.label}
          placeholder={f.placeholder}
        />
      );
    return (
      <label key={id} className={REQUIRED[c.type]?.includes(f.k) ? "req" : undefined}>
        <span>{f.label}</span>
        {input}
      </label>
    );
  };
  return (
    <li className="editor-check" data-type={c.type}>
      <div className="editor-row">
        <select
          value={c.type}
          aria-label={t("검사 종류")}
          onChange={(e) => {
            const type = e.target.value;
            onChange({ type, ...DEFAULTS[type], ...(c.label ? { label: c.label } : {}), ...(c.hint ? { hint: c.hint } : {}) } as Check);
          }}
        >
          <optgroup label={t("배선 검사 (바로바로)")}>
            {WIRING_TYPES.map((type) => (
              <option key={type} value={type}>
                {TYPE_KO[type]}
              </option>
            ))}
          </optgroup>
          <optgroup label={t("동작 검사 (채점)")}>
            {BEHAVIOUR_TYPES.map((type) => (
              <option key={type} value={type}>
                {TYPE_KO[type]}
              </option>
            ))}
          </optgroup>
        </select>
        <button className="small" onClick={() => onMove(-1)} aria-label={t("검사 위로")}>
          ↑
        </button>
        <button className="small" onClick={() => onMove(1)} aria-label={t("검사 아래로")}>
          ↓
        </button>
        <button className="small" onClick={onRemove} aria-label={t("검사 삭제")}>
          {t("삭제")}
        </button>
      </div>
      <div className="editor-fields">
        {FIELDS[c.type]?.map(field)}
        <label>
          <span>{t("표시 이름 (비우면 자동)")}</span>
          <input value={c.label ?? ""} onChange={(e) => set("label", e.target.value)} aria-label={t("표시 이름")} />
        </label>
        <label>
          <span>{t("틀렸을 때 안내 (비우면 자동)")}</span>
          <input value={c.hint ?? ""} onChange={(e) => set("hint", e.target.value)} aria-label={t("안내")} />
        </label>
      </div>
    </li>
  );
}

export function LessonEditor({ draft, onChange, examples, project, wiring, onSaveMine, onPreview, onNew, onClose }: Props) {
  const [stimuliText, setStimuliText] = useState(() => JSON.stringify(draft.grade?.stimuli ?? [], null, 1));
  const [stimuliError, setStimuliError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const errors = useMemo(() => {
    const e = validateLesson(draft, KINDS);
    if (LESSONS.some((b) => b.lesson.id === draft.id)) e.push(t("id '{id}'는 기본 실습의 id입니다. 다른 id를 쓰세요", { id: draft.id }));
    if (stimuliError) e.push(t("채점 중 조작: {error}", { error: stimuliError }));
    return e;
  }, [draft, stimuliError]);

  const set = <K extends keyof Lesson>(k: K, v: Lesson[K]) => onChange({ ...draft, [k]: v });
  const setStep = (i: number, s: LessonStep) => set("steps", draft.steps.map((x, j) => (j === i ? s : x)));
  const elfs = examples.map((e) => e.file).filter((f) => f.endsWith(".elf"));
  const projects = [...new Set(examples.flatMap((e) => (e.project ? [e.project] : [])))];

  const startKind =
    typeof draft.start === "object" && draft.start && "example" in draft.start ? "example" : typeof draft.start === "object" && draft.start ? "project" : "empty";
  const currentCircuit = () => ({
    parts: project.parts.map((p) => ({ id: p.id, kind: p.kind, x: p.x, y: p.y, ...(Object.keys(p.props).length ? { props: p.props } : {}) })),
    wires: project.wires.map((w) => ({ id: w.id, a: w.a, b: w.b, ...(w.color ? { color: w.color } : {}), ...(w.points?.length ? { points: w.points } : {}) })),
  });

  const generate = (i: number) => {
    const checks = checksFromWiring(wiring);
    if (!checks.length) {
      setNote(t("지금 회로에 보드 말고 부품이 없어 만들 검사가 없습니다."));
      return;
    }
    const s = draft.steps[i];
    const key = (c: Check) => JSON.stringify(c);
    const have = new Set(s.checks.map(key));
    const added = checks.filter((c) => !have.has(key(c)));
    setStep(i, { ...s, checks: [...s.checks, ...added] });
    setNote(t("배선 검사 {n}개를 단계 {step}에 넣었습니다 (지금 회로는 모두 통과).", { n: added.length, step: i + 1 }));
  };

  const json = JSON.stringify(draft, null, 2) + "\n";
  const loadFile = async (f: File | undefined) => {
    if (!f) return;
    let raw: unknown;
    try {
      raw = JSON.parse((await f.text()).replace(/^﻿/, ""));
    } catch (e) {
      setLoadError(t("{file}: JSON 오류: {message}", { file: f.name, message: (e as Error).message }));
      return;
    }
    const r = raw as Partial<Lesson> | null;
    // Missing or mistyped fields get safe defaults (the error list names them);
    // something that is not a lesson at all is refused.
    const l = normalizeLesson(raw);
    if (!l || !Array.isArray(r?.steps) || !r.steps.every((s) => s && typeof s === "object" && Array.isArray(s.checks))) {
      setLoadError(t("{file}: 레슨 파일이 아닙니다 ('steps'와 각 단계의 'checks'가 필요합니다)", { file: f.name }));
      return;
    }
    setLoadError(null);
    setStimuliText(JSON.stringify(l.grade?.stimuli ?? [], null, 1));
    setStimuliError(null);
    onChange(l);
  };

  return (
    <div className="overlay" role="dialog" aria-label={t("레슨 편집기")}>
      <div className="overlay-box editor">
        <datalist id="lesson-signals">
          {SIGNALS.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <datalist id="lesson-through">
          {THROUGH.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <header>
          <b>{t("✏️ 레슨 편집기")}</b>
          <button
            onClick={() => {
              if (!window.confirm(t("편집 중인 레슨을 버리고 새로 만들까요? (내 레슨에 저장한 것은 남습니다)"))) return;
              onNew();
              setStimuliText("[]");
              setStimuliError(null);
              setLoadError(null);
              setNote(null);
            }}
          >
            {t("새 레슨")}
          </button>
          <label className="file-btn">
            {t("JSON 불러오기")}
            <input
              type="file"
              accept=".json,application/json"
              hidden
              data-testid="editor-load"
              onChange={(e) => {
                void loadFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          <button className="close" onClick={onClose} aria-label={t("레슨 편집기 닫기")}>
            ×
          </button>
        </header>

        <div className="editor-body">
          <section className="editor-main">
            <fieldset>
              <legend>{t("기본 정보")}</legend>
              <div className="editor-fields">
                <label className="req">
                  <span>{t("id (영문, 진행·결과 파일의 열쇠)")}</span>
                  <input value={draft.id} onChange={(e) => set("id", e.target.value)} aria-label={t("레슨 id")} />
                </label>
                <label className="req">
                  <span>{t("제목")}</span>
                  <input value={draft.title} onChange={(e) => set("title", e.target.value)} aria-label={t("레슨 제목")} />
                </label>
                <label className="req">
                  <span>{t("수준")}</span>
                  <input value={draft.level} list="lesson-levels" onChange={(e) => set("level", e.target.value)} aria-label={t("수준")} />
                  <datalist id="lesson-levels">
                    {[t("입문"), t("초급"), t("중급"), t("고급")].map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                </label>
                <label className="req">
                  <span>{t("순서")}</span>
                  <input type="number" value={draft.order} onChange={(e) => set("order", Number(e.target.value))} aria-label={t("순서")} />
                </label>
                <label className="req wide">
                  <span>{t("목표 (한두 문장)")}</span>
                  <input value={draft.goal} onChange={(e) => set("goal", e.target.value)} aria-label={t("목표")} />
                </label>
                <label>
                  <span>{t("시작 회로")}</span>
                  <select
                    value={startKind}
                    aria-label={t("시작 회로")}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "empty") set("start", "empty");
                      else if (v === "example") set("start", { example: projects[0] ?? "" });
                      else set("start", { project: currentCircuit() });
                    }}
                  >
                    <option value="empty">{t("빈 보드 + 브레드보드")}</option>
                    <option value="example">{t("예제 프로젝트")}</option>
                    <option value="project">{t("레슨에 담은 회로")}</option>
                  </select>
                </label>
                {startKind === "example" && typeof draft.start === "object" && "example" in draft.start && (
                  <label>
                    <span>{t("예제")}</span>
                    <select value={draft.start.example} onChange={(e) => set("start", { example: e.target.value })} aria-label={t("시작 예제")}>
                      {projects.map((p) => (
                        <option key={p}>{p}</option>
                      ))}
                    </select>
                  </label>
                )}
                {startKind === "project" && typeof draft.start === "object" && "project" in draft.start && (
                  <label>
                    <span>
                      {t("부품 {parts}개 · 와이어 {wires}개", { parts: draft.start.project.parts.length, wires: draft.start.project.wires.length })}
                    </span>
                    <button onClick={() => set("start", { project: currentCircuit() })} title={t("지금 화면의 회로를 시작 회로로 담습니다")}>
                      {t("현재 회로를 시작 회로로")}
                    </button>
                  </label>
                )}
                <label>
                  <span>{t("펌웨어")}</span>
                  <select
                    aria-label={t("펌웨어")}
                    value={draft.firmware === undefined ? "" : draft.firmware === "upload" ? "upload" : draft.firmware.example}
                    onChange={(e) => {
                      const v = e.target.value;
                      const next = { ...draft };
                      if (!v) delete next.firmware;
                      else next.firmware = v === "upload" ? "upload" : { example: v };
                      onChange(next);
                    }}
                  >
                    <option value="">{t("바꾸지 않음")}</option>
                    <option value="upload">{t("학생이 직접 빌드해 올림")}</option>
                    {elfs.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>{t("채점 시간 (ms, 비우면 자동)")}</span>
                  <input
                    type="number"
                    aria-label={t("채점 시간")}
                    value={draft.grade?.ms ?? ""}
                    onChange={(e) => {
                      const grade = { ...draft.grade };
                      if (e.target.value === "") delete grade.ms;
                      else grade.ms = Number(e.target.value);
                      const next: Lesson = { ...draft, grade };
                      if (!Object.keys(grade).length) delete next.grade;
                      onChange(next);
                    }}
                  />
                </label>
                <label className="wide">
                  <span>
                    {t("채점 중 조작 (JSON 배열, 예: ")}
                    <code>{`[{ "at": 500, "press": "tact-switch", "ms": 150 }]`}</code>)
                  </span>
                  <textarea
                    rows={2}
                    aria-label={t("채점 중 조작")}
                    value={stimuliText}
                    onChange={(e) => {
                      setStimuliText(e.target.value);
                      try {
                        const v = JSON.parse(e.target.value || "[]") as Stimulus[];
                        if (!Array.isArray(v)) throw new Error(t("배열이 아닙니다"));
                        setStimuliError(null);
                        const grade = { ...draft.grade };
                        if (v.length) grade.stimuli = v;
                        else delete grade.stimuli;
                        const next: Lesson = { ...draft, grade };
                        if (!Object.keys(grade).length) delete next.grade;
                        onChange(next);
                      } catch (err) {
                        setStimuliError((err as Error).message);
                      }
                    }}
                  />
                </label>
              </div>
            </fieldset>

            <ol className="editor-steps">
              {draft.steps.map((s, i) => (
                <li key={i} className="editor-step" data-step={i}>
                  <div className="editor-row">
                    <b>{t("단계 {n}", { n: i + 1 })}</b>
                    <input value={s.title} onChange={(e) => setStep(i, { ...s, title: e.target.value })} aria-label={t("단계 {n} 제목", { n: i + 1 })} />
                    <button className="small" onClick={() => set("steps", move(draft.steps, i, -1))} aria-label={t("단계 위로")}>
                      ↑
                    </button>
                    <button className="small" onClick={() => set("steps", move(draft.steps, i, 1))} aria-label={t("단계 아래로")}>
                      ↓
                    </button>
                    <button
                      className="small"
                      onClick={() => set("steps", draft.steps.filter((_, j) => j !== i))}
                      disabled={draft.steps.length < 2}
                      aria-label={t("단계 삭제")}
                    >
                      {t("삭제")}
                    </button>
                  </div>
                  <label className="wide">
                    <span>{t("설명 (간단한 Markdown: **굵게**, `코드`, - 목록, 빈 줄로 문단)")}</span>
                    <textarea rows={3} value={textOf(s.text)} onChange={(e) => setStep(i, { ...s, text: e.target.value })} aria-label={t("단계 {n} 설명", { n: i + 1 })} />
                  </label>
                  <ul className="editor-checks">
                    {s.checks.map((c, j) => (
                      <CheckForm
                        key={j}
                        c={c}
                        onChange={(nc) => setStep(i, { ...s, checks: s.checks.map((x, k) => (k === j ? nc : x)) })}
                        onRemove={() => setStep(i, { ...s, checks: s.checks.filter((_, k) => k !== j) })}
                        onMove={(d) => setStep(i, { ...s, checks: move(s.checks, j, d) })}
                      />
                    ))}
                  </ul>
                  <div className="editor-row">
                    <button onClick={() => setStep(i, { ...s, checks: [...s.checks, { type: "part", kind: "led-5mm" }] })}>{t("+ 검사")}</button>
                    <button onClick={() => generate(i)} title={t("지금 회로의 부품·직렬 연결·핀 연결을 검사로 만듭니다")}>
                      {t("현재 배선에서 검사 만들기")}
                    </button>
                  </div>
                </li>
              ))}
            </ol>
            <button onClick={() => set("steps", [...draft.steps, { title: t("{n}단계", { n: draft.steps.length + 1 }), text: "", checks: [] }])}>{t("+ 단계")}</button>
          </section>

          <aside className="editor-side">
            <div className={errors.length ? "editor-errors" : "editor-ok"} data-testid="editor-errors" role="status">
              {errors.length ? (
                <>
                  <b>{t("레슨 오류 {n}개", { n: errors.length })}</b>
                  <ul>
                    {errors.map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </>
              ) : (
                t("✅ 레슨 형식이 맞습니다")
              )}
            </div>
            {loadError && (
              <div className="error" role="alert">
                {loadError}
              </div>
            )}
            {note && <div className="hint" data-testid="editor-note">{note}</div>}
            <div className="editor-actions">
              <button
                className="primary"
                disabled={errors.length > 0}
                onClick={() => {
                  onSaveMine(draft);
                  setNote(t("'{title}'을(를) 내 레슨에 저장했습니다.", { title: draft.title }));
                }}
              >
                {t("내 레슨에 저장")}
              </button>
              <button
                disabled={errors.length > 0}
                onClick={() => download(`${draft.id}.json`, new Blob([json], { type: "application/json" }))}
                title={t("web/lessons/에 넣거나 다른 선생님께 줄 수 있는 파일")}
              >
                {t("JSON 파일로 내려받기")}
              </button>
              <button disabled={errors.length > 0} onClick={() => onPreview(draft)} title={t("시작 회로를 불러오지 않고 지금 회로·펌웨어로 실행해 봅니다")}>
                {t("미리 보기 (현재 프로젝트로)")}
              </button>
            </div>
            <details>
              <summary>{t("JSON 보기")}</summary>
              <pre className="editor-json" data-testid="editor-json">
                {json}
              </pre>
            </details>
          </aside>
        </div>
      </div>
    </div>
  );
}
