// Behaviour checks, evaluated over a run of the firmware from the frames
// the simulation worker sends (pins, part visuals, console, probes). Pure:
// unit tested with Node (`npm test`).
import { josa } from "./korean.ts";
import type { BehaviourCheck, CheckResult, Lesson } from "./types.ts";
import { isWiring } from "./types.ts";

/** The parts of a `SimFrame` the graders read. */
export interface FrameLike {
  timeMs: number;
  stopped: string | null;
  pins: { port: string; pin: number; level: boolean; duty: number }[];
  parts: {
    id: string;
    brightness?: number[];
    angle?: number;
    rpm?: number;
    screen?: string;
    lcd?: { rows: number[][] };
  }[];
  circuitWarnings: string[];
  probes: { name: string; level0: boolean; edges: [number, boolean][] }[];
}

interface Sample {
  t: number;
  frame: FrameLike;
}

/** Everything seen during one grading run. */
export class Recording {
  samples: Sample[] = [];
  console = "";
  stopped: string | null = null;
  warnings = new Set<string>();
  /** Edges of probed pins, [time ms, level]. */
  edges = new Map<string, { level0: boolean; edges: [number, boolean][] }>();
  t0: number | null = null;
  lastT = 0;

  add(frame: FrameLike, consoleText: string) {
    if (this.t0 === null) this.t0 = frame.timeMs;
    this.lastT = frame.timeMs;
    this.samples.push({ t: frame.timeMs - this.t0, frame });
    this.console += consoleText;
    if (frame.stopped) this.stopped = frame.stopped;
    for (const w of frame.circuitWarnings) this.warnings.add(w);
    for (const p of frame.probes) {
      let e = this.edges.get(p.name);
      if (!e) this.edges.set(p.name, (e = { level0: p.level0, edges: [] }));
      e.edges.push(...p.edges);
    }
  }

  /** Simulated time recorded so far, in ms. */
  get elapsed(): number {
    return this.t0 === null ? 0 : this.lastT - this.t0;
  }
}

/** Part ids of a kind, for checks that name parts by kind. */
export type PartsOfKind = (kind: string) => string[];

/** Simulated time a check needs to be judged. */
export function windowMs(c: BehaviourCheck): number {
  switch (c.type) {
    case "period":
      // Three full periods after a start-up allowance.
      return Math.max(1000, 3.5 * c.ms + 300);
    case "brightness":
    case "duty":
    case "motion":
      return 2500;
    case "display":
    case "console":
    case "consoleValues":
      return 2000;
    case "running":
      return 1000;
  }
}

/** How long to run when grading a lesson: the longest check, or the lesson's own. */
export function gradeMs(lesson: Lesson): number {
  const checks = lesson.steps.flatMap((s) => s.checks).filter((c): c is BehaviourCheck => !isWiring(c));
  const stim = Math.max(0, ...(lesson.grade?.stimuli ?? []).map((s) => s.at + ("ms" in s && s.ms ? s.ms : 100) + 500));
  return lesson.grade?.ms ?? Math.max(stim, ...checks.map(windowMs), 0);
}

const fmt = (ms: number) => (ms >= 100 ? ms.toFixed(0) : ms.toFixed(1));
const pct = (x: number) => `${Math.round(x * 100)}%`;

const pinOf = (name: string) => {
  const m = /^P([A-H])(\d+)$/.exec(name);
  return m ? { port: m[1], pin: Number(m[2]) } : null;
};

function period(c: Extract<BehaviourCheck, { type: "period" }>, rec: Recording): CheckResult {
  const tol = c.tolerance ?? 0.05;
  const e = rec.edges.get(c.pin)?.edges ?? [];
  // Measure on whole periods, rising edge to rising edge (falling if there are
  // not enough rising ones), skipping the first one (start-up).
  const rises = e.filter((x) => x[1]).map((x) => x[0]);
  const falls = e.filter((x) => !x[1]).map((x) => x[0]);
  const marks = rises.length >= falls.length ? rises : falls;
  const target = `${fmt(c.ms)} ms (±${Math.round(tol * 100)}%)`;
  if (e.length === 0) {
    return {
      pass: false,
      hint: `${josa(c.pin, "이/가")} 한 번도 바뀌지 않았습니다. 펌웨어가 ${josa(c.pin, "을/를")} 출력으로 설정하고 토글하나요?`,
    };
  }
  if (marks.length < 3) {
    return {
      pass: false,
      hint: `${josa(c.pin, "이/가")} 채점 시간 동안 ${e.length}번만 바뀌었습니다. 너무 느리거나 멈췄습니다. 목표 주기는 ${target}입니다.`,
    };
  }
  const used = marks.slice(1);
  const measured = (used[used.length - 1] - used[0]) / (used.length - 1);
  const detail = `측정 주기 ${fmt(measured)} ms (${(1000 / measured).toFixed(2)} Hz)`;
  if (Math.abs(measured - c.ms) <= tol * c.ms) return { pass: true, detail };
  return { pass: false, detail, hint: `깜빡임 주기가 ${fmt(measured)} ms입니다. 목표는 ${target}입니다.` };
}

function brightness(c: Extract<BehaviourCheck, { type: "brightness" }>, rec: Recording, ids: string[], name: string): CheckResult {
  if (!ids.length) return { pass: false, hint: `${josa(name, "이/가")} 회로에 없습니다.` };
  const ch = c.channel ?? 0;
  let best: { max: number; min: number } | null = null;
  for (const id of ids) {
    let max = 0;
    let min = 1;
    for (const s of rec.samples) {
      const v = s.frame.parts.find((p) => p.id === id)?.brightness?.[ch] ?? 0;
      max = Math.max(max, v);
      min = Math.min(min, v);
    }
    const ok = (c.above === undefined || max > c.above) && (c.below === undefined || min < c.below);
    if (ok) return { pass: true, detail: `밝기 ${pct(min)}–${pct(max)}` };
    if (!best || max > best.max) best = { max, min };
  }
  const { max, min } = best!;
  const detail = `밝기 ${pct(min)}–${pct(max)}`;
  if (c.above !== undefined && max <= c.above) {
    return {
      pass: false,
      detail,
      hint:
        max === 0
          ? `${josa(name, "이/가")} 한 번도 켜지지 않았습니다. 배선과 LED 방향, 펌웨어가 쓰는 핀을 확인하세요.`
          : `${josa(name, "이/가")} 충분히 밝아지지 않았습니다 (최대 ${pct(max)}, 목표 ${pct(c.above)} 초과). 저항값이 너무 큰가요?`,
    };
  }
  return { pass: false, detail, hint: `${josa(name, "이/가")} 꺼지지 않았습니다 (최소 ${pct(min)}). 계속 켜져 있으면 깜빡이지 않는 것입니다.` };
}

function consoleCheck(c: Extract<BehaviourCheck, { type: "console" }>, rec: Recording): CheckResult {
  const re = new RegExp(c.pattern, (c.flags ?? "").replace("g", "") + "g");
  const n = [...rec.console.matchAll(re)].length;
  const need = c.count ?? 1;
  if (n >= need) return { pass: true, detail: `${n}번 출력` };
  return {
    pass: false,
    detail: `${n}번 출력`,
    hint: rec.console.trim()
      ? `콘솔에 기대한 출력(/${c.pattern}/)이 ${need > 1 ? `${need}번 나와야 하는데 ${n}번 나왔습니다` : "없습니다"}.`
      : "콘솔(USART2)에 아무것도 출력되지 않았습니다.",
  };
}

function consoleValues(c: Extract<BehaviourCheck, { type: "consoleValues" }>, rec: Recording): CheckResult {
  const re = new RegExp(c.pattern, "g");
  const values = [...rec.console.matchAll(re)].map((m) => Number(m[1])).filter(Number.isFinite);
  if (!values.length) return { pass: false, hint: `콘솔에서 값을 찾지 못했습니다 (/${c.pattern}/).` };
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const detail = `값 ${lo}–${hi}`;
  if (hi - lo >= c.minSpread) return { pass: true, detail };
  return { pass: false, detail, hint: `값이 거의 변하지 않았습니다 (최소 ${lo}, 최대 ${hi}). ${c.minSpread} 이상 바뀌어야 합니다.` };
}

function duty(c: Extract<BehaviourCheck, { type: "duty" }>, rec: Recording): CheckResult {
  const pin = pinOf(c.pin);
  const values = rec.samples
    .slice(1)
    .map((s) => s.frame.pins.find((p) => pin && p.port === pin.port && p.pin === pin.pin)?.duty)
    .filter((v): v is number => v !== undefined);
  if (!values.length) return { pass: false, hint: `${josa(c.pin, "이/가")} 출력으로 쓰이지 않았습니다.` };
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const detail = `듀티 ${pct(lo)}–${pct(hi)}`;
  const inside = (v: number) => v >= c.min - 1e-6 && v <= c.max + 1e-6;
  const range = `${pct(c.min)}–${pct(c.max)}`;
  if (c.mode === "always") {
    if (values.every(inside)) return { pass: true, detail };
    return { pass: false, detail, hint: `${c.pin}의 PWM 듀티가 ${range}를 벗어났습니다 (${pct(lo)}–${pct(hi)}).` };
  }
  if (values.some(inside)) return { pass: true, detail };
  return { pass: false, detail, hint: `${c.pin}의 PWM 듀티가 한 번도 ${range}에 들지 않았습니다 (측정 ${pct(lo)}–${pct(hi)}).` };
}

function motion(c: Extract<BehaviourCheck, { type: "motion" }>, rec: Recording, ids: string[], name: string): CheckResult {
  if (!ids.length) return { pass: false, hint: `${josa(name, "이/가")} 회로에 없습니다.` };
  const unit = c.field === "angle" ? "°" : " rpm";
  let spread = 0;
  let range = "";
  for (const id of ids) {
    const v = rec.samples.map((s) => s.frame.parts.find((p) => p.id === id)?.[c.field]).filter((x): x is number => x !== undefined);
    if (!v.length) continue;
    const lo = Math.min(...v);
    const hi = Math.max(...v);
    if (hi - lo >= spread) {
      spread = hi - lo;
      range = `${lo.toFixed(0)}–${hi.toFixed(0)}${unit}`;
    }
  }
  const detail = range ? `범위 ${range}` : undefined;
  if (spread >= c.minSpread) return { pass: true, detail };
  return {
    pass: false,
    detail,
    hint: `${josa(name, "이/가")} 거의 움직이지 않았습니다 (${spread.toFixed(0)}${unit}). ${c.minSpread}${unit} 이상 움직여야 합니다.`,
  };
}

/** Lit pixels of an OLED frame (base64, 1 bit per pixel). */
export function litPixels(screen: string | undefined): number {
  if (!screen) return 0;
  const s = atob(screen);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    let b = s.charCodeAt(i);
    while (b) {
      n += b & 1;
      b >>= 1;
    }
  }
  return n;
}

const lcdText = (lcd: { rows: number[][] } | undefined) =>
  lcd ? lcd.rows.map((r) => r.map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : " ")).join("")).join("\n") : "";

function display(c: Extract<BehaviourCheck, { type: "display" }>, rec: Recording, ids: string[], name: string): CheckResult {
  if (!ids.length) return { pass: false, hint: `${josa(name, "이/가")} 회로에 없습니다.` };
  let most = 0;
  let lastText = "";
  const re = c.text ? new RegExp(c.text) : null;
  for (const s of rec.samples) {
    for (const p of s.frame.parts) {
      if (!ids.includes(p.id)) continue;
      if (p.lcd) {
        const t = lcdText(p.lcd);
        if (t.trim()) lastText = t;
        if (re ? re.test(t) : t.trim().length > 0) return { pass: true, detail: `"${t.trim().replace(/\s+/g, " ")}"` };
      } else {
        most = Math.max(most, litPixels(p.screen));
        if (!re && most >= (c.minPixels ?? 20)) return { pass: true, detail: `켜진 픽셀 ${most}개` };
      }
    }
  }
  if (lastText) return { pass: false, hint: `${name}에 기대한 글자가 나오지 않았습니다. 지금: "${lastText.trim().replace(/\s+/g, " ")}"` };
  return {
    pass: false,
    detail: most ? `켜진 픽셀 ${most}개` : undefined,
    hint: `${josa(name, "이/가")} 아무것도 표시하지 않았습니다. 전원(VCC, GND)과 SDA·SCL 배선을 확인하세요.`,
  };
}

/** Judge one behaviour check on a finished recording. */
export function evaluateBehaviour(c: BehaviourCheck, rec: Recording, partsOfKind: PartsOfKind, nameOf: (kind: string) => string): CheckResult {
  if (!rec.samples.length) return { pass: false, hint: "펌웨어가 실행되지 않았습니다." };
  switch (c.type) {
    case "period":
      return period(c, rec);
    case "brightness":
      return brightness(c, rec, partsOfKind(c.kind), nameOf(c.kind));
    case "console":
      return consoleCheck(c, rec);
    case "consoleValues":
      return consoleValues(c, rec);
    case "duty":
      return duty(c, rec);
    case "motion":
      return motion(c, rec, partsOfKind(c.kind), nameOf(c.kind));
    case "display":
      return display(c, rec, partsOfKind(c.kind), nameOf(c.kind));
    case "running":
      return rec.stopped
        ? { pass: false, hint: `펌웨어가 멈췄습니다: ${rec.stopped}` }
        : { pass: true, detail: `${(rec.elapsed / 1000).toFixed(1)} s 동안 실행` };
  }
}

/** The default checklist line for a behaviour check. */
export function behaviourLabel(c: BehaviourCheck, nameOf: (kind: string) => string): string {
  switch (c.type) {
    case "period":
      return `${c.pin} 주기 ${fmt(c.ms)} ms ±${Math.round((c.tolerance ?? 0.05) * 100)}%`;
    case "brightness":
      return `${nameOf(c.kind)}${c.channel !== undefined ? ` ${"RGB"[c.channel] ?? c.channel}` : ""} ${[
        c.above !== undefined ? `밝기 ${pct(c.above)} 초과` : "",
        c.below !== undefined ? `${pct(c.below)} 미만` : "",
      ]
        .filter(Boolean)
        .join(", ")}`;
    case "console":
      return `콘솔 출력 /${c.pattern}/${c.count && c.count > 1 ? ` ${c.count}번` : ""}`;
    case "consoleValues":
      return `콘솔 값 변화 ${c.minSpread} 이상`;
    case "duty":
      return `${c.pin} PWM 듀티 ${pct(c.min)}–${pct(c.max)}${c.mode === "always" ? " 유지" : ""}`;
    case "motion":
      return `${nameOf(c.kind)} ${c.field === "angle" ? `${c.minSpread}° 이상 회전` : `${c.minSpread} rpm 이상 변화`}`;
    case "display":
      return `${nameOf(c.kind)}에 표시${c.text ? ` /${c.text}/` : ""}`;
    case "running":
      return "펌웨어가 멈추지 않음";
  }
}

/** MCU pins whose edges a lesson's checks need (probes during grading). */
export function probedPins(lesson: Lesson): string[] {
  return [
    ...new Set(
      lesson.steps
        .flatMap((s) => s.checks)
        .filter((c) => c.type === "period")
        .map((c) => (c as { pin: string }).pin),
    ),
  ];
}
