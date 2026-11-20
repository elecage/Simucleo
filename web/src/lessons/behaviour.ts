// Behaviour checks, evaluated over a run of the firmware from the frames
// the simulation worker sends (pins, part visuals, console, probes). Pure:
// unit tested with Node (`npm test`).
import { t } from "../i18n/index.ts";
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
    /** TM1637: segment bytes per digit (M32). */
    digits?: { segments: number[]; on: boolean };
    /** NeoPixels: 0xRRGGBB per LED (M32). */
    leds?: number[];
  }[];
  circuitWarnings: string[];
  probes: { name: string; level0: boolean; edges: [number, boolean][]; dense?: boolean }[];
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
  edges = new Map<string, { level0: boolean; edges: [number, boolean][]; dense?: boolean }>();
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
      // (Some edges of a frame did not fit: the list is not the signal.)
      if (p.dense) e.dense = true;
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
      hint: t("{pin|이/가} 한 번도 바뀌지 않았습니다. 펌웨어가 {pin|을/를} 출력으로 설정하고 토글하나요?", { pin: c.pin }),
    };
  }
  if (marks.length < 3) {
    return {
      pass: false,
      hint: t("{pin|이/가} 채점 시간 동안 {n}번만 바뀌었습니다. 너무 느리거나 멈췄습니다. 목표 주기는 {target}입니다.", {
        pin: c.pin,
        n: e.length,
        target,
      }),
    };
  }
  const used = marks.slice(1);
  const measured = (used[used.length - 1] - used[0]) / (used.length - 1);
  const detail = t("측정 주기 {ms} ms ({hz} Hz)", { ms: fmt(measured), hz: (1000 / measured).toFixed(2) });
  if (Math.abs(measured - c.ms) <= tol * c.ms) return { pass: true, detail };
  return { pass: false, detail, hint: t("깜빡임 주기가 {ms} ms입니다. 목표는 {target}입니다.", { ms: fmt(measured), target }) };
}

function brightness(c: Extract<BehaviourCheck, { type: "brightness" }>, rec: Recording, ids: string[], name: string): CheckResult {
  if (!ids.length) return { pass: false, hint: t("{name|이/가} 회로에 없습니다.", { name }) };
  const ch = c.channel ?? 0;
  let best: { max: number; min: number } | null = null;
  for (const id of ids) {
    let max = 0;
    let min = 1;
    for (const s of rec.samples) {
      const part = s.frame.parts.find((p) => p.id === id);
      const v = part?.brightness?.[ch] ?? (part?.leds ? pixelLevel(part.leds, c.channel) : 0);
      max = Math.max(max, v);
      min = Math.min(min, v);
    }
    const ok = (c.above === undefined || max > c.above) && (c.below === undefined || min < c.below);
    if (ok) return { pass: true, detail: t("밝기 {min}–{max}", { min: pct(min), max: pct(max) }) };
    if (!best || max > best.max) best = { max, min };
  }
  const { max, min } = best!;
  const detail = t("밝기 {min}–{max}", { min: pct(min), max: pct(max) });
  if (c.above !== undefined && max <= c.above) {
    return {
      pass: false,
      detail,
      hint:
        max === 0
          ? t("{name|이/가} 한 번도 켜지지 않았습니다. 배선과 LED 방향, 펌웨어가 쓰는 핀을 확인하세요.", { name })
          : t("{name|이/가} 충분히 밝아지지 않았습니다 (최대 {max}, 목표 {above} 초과). 저항값이 너무 큰가요?", {
              name,
              max: pct(max),
              above: pct(c.above),
            }),
    };
  }
  return { pass: false, detail, hint: t("{name|이/가} 꺼지지 않았습니다 (최소 {min}). 계속 켜져 있으면 깜빡이지 않는 것입니다.", { name, min: pct(min) }) };
}

/** The brightest NeoPixel of a chain, 0–1: one colour (`channel` 0 R, 1 G, 2 B) or any. */
export function pixelLevel(leds: number[], channel?: number): number {
  let best = 0;
  for (const rgb of leds) {
    const c = [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff];
    best = Math.max(best, channel === undefined ? Math.max(...c) : (c[channel] ?? 0));
  }
  return best / 255;
}

function consoleCheck(c: Extract<BehaviourCheck, { type: "console" }>, rec: Recording): CheckResult {
  const re = new RegExp(c.pattern, (c.flags ?? "").replace("g", "") + "g");
  const n = [...rec.console.matchAll(re)].length;
  const need = c.count ?? 1;
  if (n >= need) return { pass: true, detail: t("{n}번 출력", { n }) };
  return {
    pass: false,
    detail: t("{n}번 출력", { n }),
    hint: rec.console.trim()
      ? need > 1
        ? t("콘솔에 기대한 출력(/{pattern}/)이 {need}번 나와야 하는데 {n}번 나왔습니다.", { pattern: c.pattern, need, n })
        : t("콘솔에 기대한 출력(/{pattern}/)이 없습니다.", { pattern: c.pattern })
      : t("콘솔(USART2)에 아무것도 출력되지 않았습니다."),
  };
}

function consoleValues(c: Extract<BehaviourCheck, { type: "consoleValues" }>, rec: Recording): CheckResult {
  const re = new RegExp(c.pattern, "g");
  const values = [...rec.console.matchAll(re)].map((m) => Number(m[1])).filter(Number.isFinite);
  if (!values.length) return { pass: false, hint: t("콘솔에서 값을 찾지 못했습니다 (/{pattern}/).", { pattern: c.pattern }) };
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const detail = t("값 {lo}–{hi}", { lo, hi });
  if (hi - lo >= c.minSpread) return { pass: true, detail };
  return { pass: false, detail, hint: t("값이 거의 변하지 않았습니다 (최소 {lo}, 최대 {hi}). {spread} 이상 바뀌어야 합니다.", { lo, hi, spread: c.minSpread }) };
}

/** Duty windows are at least this long in simulated time (ms). */
export const DUTY_WINDOW_MS = 16;

/**
 * Frame duties (each averaged over its frame, from the one before it)
 * merged into windows of at least `DUTY_WINDOW_MS`, weighted by their
 * length. A slow machine makes short frames — a millisecond or two, a few
 * PWM periods — whose duty is off by the part of a period they cut, so a
 * steady 25 % read as 33 % (M31); a window is what one frame at ×1
 * speed covers. The first sample has no frame before it and is skipped.
 */
/**
 * The duty of each PWM period, rising edge to rising edge, from a probed
 * pin's edges — exact whatever the display frames cover (a 20 ms servo
 * period never fits a frame's window, so frame duties of a 12.5 % pulse
 * read 0 or 16 %). A stretch at one level much longer than the periods
 * (a duty of 0 or 100 % held) counts as that level. Null when the edges
 * cannot tell (too few, or some did not fit a frame): the frames then.
 */
export function edgeDuties(
  rec: { level0: boolean; edges: [number, boolean][]; dense?: boolean } | undefined,
  start: number,
  end: number,
): number[] | null {
  if (!rec || rec.dense) return null;
  const e = rec.edges;
  const rises = e.filter((x) => x[1]).map((x) => x[0]);
  if (rises.length < 3) return null;
  const out: number[] = [];
  const periods: number[] = [];
  let k = 0;
  for (let i = 0; i + 1 < rises.length; i++) {
    const [a, b] = [rises[i], rises[i + 1]];
    while (k < e.length && e[k][0] <= a) k++;
    // The fall within this period.
    const fall = e.slice(k).find((x) => !x[1] && x[0] < b);
    if (!fall) continue;
    periods.push(b - a);
    out.push((fall[0] - a) / (b - a));
  }
  if (!out.length) return null;
  // Held levels: a gap between edges (or before the first, after the last)
  // longer than 4 typical periods.
  const sorted = [...periods].sort((x, y) => x - y);
  const typical = sorted[Math.floor(sorted.length / 2)];
  const marks: [number, boolean][] = [[start, rec.level0], ...e, [end, e.length ? e[e.length - 1][1] : rec.level0]];
  for (let i = 0; i + 1 < marks.length; i++) {
    if (marks[i + 1][0] - marks[i][0] > 4 * typical) out.push(marks[i][1] ? 1 : 0);
  }
  return out;
}

export function dutyWindows(samples: { t: number; duty: number | undefined }[]): number[] {
  const out: number[] = [];
  let area = 0;
  let span = 0;
  /** Duties of frames that took no time (e.g. sent while paused). */
  const still: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const { duty } = samples[i];
    const dt = samples[i].t - samples[i - 1].t;
    if (duty === undefined) continue;
    if (dt <= 0) {
      still.push(duty);
      continue;
    }
    area += duty * dt;
    span += dt;
    if (span >= DUTY_WINDOW_MS) {
      out.push(area / span);
      area = span = 0;
    }
  }
  // What is left: a window of its own only when there is no other (a
  // short tail is the noisy kind).
  if (span > 0 && !out.length) out.push(area / span);
  return out.length ? out : still;
}

function duty(c: Extract<BehaviourCheck, { type: "duty" }>, rec: Recording): CheckResult {
  const pin = pinOf(c.pin);
  const fromEdges = edgeDuties(rec.edges.get(c.pin), rec.t0 ?? 0, rec.lastT);
  const values =
    fromEdges ??
    dutyWindows(rec.samples.map((s) => ({ t: s.t, duty: s.frame.pins.find((p) => pin && p.port === pin.port && p.pin === pin.pin)?.duty })));
  if (!values.length) return { pass: false, hint: t("{pin|이/가} 출력으로 쓰이지 않았습니다.", { pin: c.pin }) };
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const detail = t("듀티 {lo}–{hi}", { lo: pct(lo), hi: pct(hi) });
  const inside = (v: number) => v >= c.min - 1e-6 && v <= c.max + 1e-6;
  const range = `${pct(c.min)}–${pct(c.max)}`;
  if (c.mode === "always") {
    if (values.every(inside)) return { pass: true, detail };
    return { pass: false, detail, hint: t("{pin}의 PWM 듀티가 {range}를 벗어났습니다 ({lo}–{hi}).", { pin: c.pin, range, lo: pct(lo), hi: pct(hi) }) };
  }
  if (values.some(inside)) return { pass: true, detail };
  return { pass: false, detail, hint: t("{pin}의 PWM 듀티가 한 번도 {range}에 들지 않았습니다 (측정 {lo}–{hi}).", { pin: c.pin, range, lo: pct(lo), hi: pct(hi) }),
  };
}

function motion(c: Extract<BehaviourCheck, { type: "motion" }>, rec: Recording, ids: string[], name: string): CheckResult {
  if (!ids.length) return { pass: false, hint: t("{name|이/가} 회로에 없습니다.", { name }) };
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
  const detail = range ? t("범위 {range}", { range }) : undefined;
  if (spread >= c.minSpread) return { pass: true, detail };
  return {
    pass: false,
    detail,
    hint: t("{name|이/가} 거의 움직이지 않았습니다 ({spread}{unit}). {need}{unit} 이상 움직여야 합니다.", {
      name,
      spread: spread.toFixed(0),
      unit,
      need: c.minSpread,
    }),
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

/** 7-segment patterns (bit 0 = a … bit 6 = g) and what they read as. */
const SEGMENT_CHARS: Record<number, string> = {
  0x3f: "0", 0x06: "1", 0x5b: "2", 0x4f: "3", 0x66: "4", 0x6d: "5", 0x7d: "6", 0x07: "7", 0x7f: "8", 0x6f: "9",
  0x77: "A", 0x7c: "b", 0x39: "C", 0x5e: "d", 0x79: "E", 0x71: "F", 0x76: "H", 0x38: "L", 0x73: "P", 0x3e: "U",
  0x5c: "o", 0x54: "n", 0x50: "r", 0x78: "t", 0x40: "-", 0x00: " ",
};

/** What a TM1637 shows as text ("12:34"; the colon is bit 7 of digit 1), "" when off. */
export function digitsText(d: { segments: number[]; on: boolean } | undefined): string {
  if (!d || !d.on) return "";
  return d.segments.map((b, i) => (SEGMENT_CHARS[b & 0x7f] ?? "?") + (i === 1 && b & 0x80 ? ":" : "")).join("");
}

function display(c: Extract<BehaviourCheck, { type: "display" }>, rec: Recording, ids: string[], name: string): CheckResult {
  if (!ids.length) return { pass: false, hint: t("{name|이/가} 회로에 없습니다.", { name }) };
  let most = 0;
  let lastText = "";
  const re = c.text ? new RegExp(c.text) : null;
  for (const s of rec.samples) {
    for (const p of s.frame.parts) {
      if (!ids.includes(p.id)) continue;
      if (p.lcd || p.digits) {
        const text = p.lcd ? lcdText(p.lcd) : digitsText(p.digits);
        if (text.trim()) lastText = text;
        if (re ? re.test(text) : text.trim().length > 0) return { pass: true, detail: `"${text.trim().replace(/\s+/g, " ")}"` };
      } else {
        most = Math.max(most, litPixels(p.screen));
        if (!re && most >= (c.minPixels ?? 20)) return { pass: true, detail: t("켜진 픽셀 {n}개", { n: most }) };
      }
    }
  }
  if (lastText) return { pass: false, hint: t("{name}에 기대한 글자가 나오지 않았습니다. 지금: \"{text}\"", { name, text: lastText.trim().replace(/\s+/g, " ") }),
    };
  return {
    pass: false,
    detail: most ? t("켜진 픽셀 {n}개", { n: most }) : undefined,
    hint: t("{name|이/가} 아무것도 표시하지 않았습니다. 전원(VCC, GND)과 {pins} 배선을 확인하세요.", {
      name,
      pins: c.kind === "tm1637" ? "CLK·DIO" : "SDA·SCL",
    }),
  };
}

/** Judge one behaviour check on a finished recording. */
export function evaluateBehaviour(c: BehaviourCheck, rec: Recording, partsOfKind: PartsOfKind, nameOf: (kind: string) => string): CheckResult {
  if (!rec.samples.length) return { pass: false, hint: t("펌웨어가 실행되지 않았습니다.") };
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
        ? { pass: false, hint: t("펌웨어가 멈췄습니다: {reason}", { reason: rec.stopped }) }
        : { pass: true, detail: t("{s} s 동안 실행", { s: (rec.elapsed / 1000).toFixed(1) }) };
  }
}

/** The default checklist line for a behaviour check. */
export function behaviourLabel(c: BehaviourCheck, nameOf: (kind: string) => string): string {
  switch (c.type) {
    case "period":
      return t("{pin} 주기 {ms} ms ±{tol}%", { pin: c.pin, ms: fmt(c.ms), tol: Math.round((c.tolerance ?? 0.05) * 100) });
    case "brightness":
      return `${nameOf(c.kind)}${c.channel !== undefined ? ` ${"RGB"[c.channel] ?? c.channel}` : ""} ${[
        c.above !== undefined ? t("밝기 {pct} 초과", { pct: pct(c.above) }) : "",
        c.below !== undefined ? t("{pct} 미만", { pct: pct(c.below) }) : "",
      ]
        .filter(Boolean)
        .join(", ")}`;
    case "console":
      return c.count && c.count > 1
        ? t("콘솔 출력 /{pattern}/ {n}번", { pattern: c.pattern, n: c.count })
        : t("콘솔 출력 /{pattern}/", { pattern: c.pattern });
    case "consoleValues":
      return t("콘솔 값 변화 {n} 이상", { n: c.minSpread });
    case "duty":
      {
      const v = { pin: c.pin, min: pct(c.min), max: pct(c.max) };
      return c.mode === "always" ? t("{pin} PWM 듀티 {min}–{max} 유지", v) : t("{pin} PWM 듀티 {min}–{max}", v);
    }
    case "motion":
      return c.field === "angle"
        ? t("{name} {n}° 이상 회전", { name: nameOf(c.kind), n: c.minSpread })
        : t("{name} {n} rpm 이상 변화", { name: nameOf(c.kind), n: c.minSpread });
    case "display":
      return c.text ? t("{name}에 표시 /{text}/", { name: nameOf(c.kind), text: c.text }) : t("{name}에 표시", { name: nameOf(c.kind) });
    case "running":
      return t("펌웨어가 멈추지 않음");
  }
}

/** MCU pins whose edges a lesson's checks need (probes during grading). */
export function probedPins(lesson: Lesson): string[] {
  return [
    ...new Set(
      lesson.steps
        .flatMap((s) => s.checks)
        // (Duty checks too: measured period by period from the edges.)
        .filter((c) => c.type === "period" || c.type === "duty")
        .map((c) => (c as { pin: string }).pin),
    ),
  ];
}
