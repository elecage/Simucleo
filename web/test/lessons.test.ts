// Unit tests of the lesson graders and the lesson files (`npm test`, Node's
// own test runner with type stripping; no extra dependencies).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateWiring, type WiringContext, type PinRef } from "../src/lessons/wiring.ts";
import { evaluateBehaviour, dutyWindows, gradeMs, litPixels, Recording, type FrameLike } from "../src/lessons/behaviour.ts";
import { josa } from "../src/lessons/korean.ts";
import { validateLesson } from "../src/lessons/validate.ts";
import { record, resultsCsv, resultsJson, type LessonProgress } from "../src/lessons/progress.ts";
import type { BehaviourCheck, Lesson, WiringCheck } from "../src/lessons/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..");

// ------------------------------------------------------------------ wiring

const BOARD: Record<string, string> = { D13: "PA5", D12: "PA6", D2: "PA10", D7: "PA8", GND_P1: "GND", GND_D: "GND", "3V3": "3V3" };
const HEADERS: Record<string, string> = { PA5: "D13", PA6: "D12" };

/** A context from wires between part pins (nets joined by union-find). */
function circuit(parts: [string, string][], wires: [string, string][], warnings: string[] = []): WiringContext {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    const p = parent.get(k) ?? k;
    if (p === k) return k;
    const r = find(p);
    parent.set(k, r);
    return r;
  };
  const all = new Set<string>();
  for (const [a, b] of wires) {
    all.add(a);
    all.add(b);
    parent.set(find(a), find(b));
  }
  // The board buses its GND pins.
  const gnds = [...all].filter((k) => k.startsWith("nucleo:GND"));
  for (const g of gnds) parent.set(find(g), find(gnds[0]));
  const nets = new Map<string, PinRef[]>();
  for (const k of all) {
    const [part, pin] = k.split(":");
    const r = find(k);
    nets.set(r, [...(nets.get(r) ?? []), { part, pin }]);
  }
  return {
    parts: [["nucleo", "nucleo-f401re"], ...parts].map(([id, kind]) => ({ id, kind })),
    nets: [...nets.values()].map((pins) => ({ pins })),
    boardSignal: (kind, pin) => (kind === "nucleo-f401re" ? BOARD[pin] : undefined),
    nameOf: (k) => k,
    headerOf: (s) => HEADERS[s],
    warnings,
  };
}

const series: WiringCheck = { type: "series", from: "PA5", to: "GND", through: ["resistor", "led-5mm"] };
const LED_R: [string, string][] = [["r1", "resistor"], ["led1", "led-5mm"]];

test("a resistor and an LED from PA5 to GND pass the series check, in either order", () => {
  const a = circuit(LED_R, [["nucleo:D13", "r1:1"], ["r1:2", "led1:A"], ["led1:K", "nucleo:GND_P1"]]);
  assert.equal(evaluateWiring(series, a).pass, true);
  const b = circuit(LED_R, [["nucleo:D13", "led1:A"], ["led1:K", "r1:2"], ["r1:1", "nucleo:GND_D"]]);
  assert.equal(evaluateWiring(series, b).pass, true);
});

test("an LED without its resistor is named in the hint", () => {
  const c = circuit(LED_R, [["nucleo:D13", "led1:A"], ["led1:K", "nucleo:GND_P1"]]);
  const r = evaluateWiring(series, c);
  assert.equal(r.pass, false);
  assert.equal(r.hint, "PA5가 GND로 가는 길에 저항이 없습니다.");
});

test("a reversed LED and a chain on the wrong pin get their own hints", () => {
  const rev = circuit(LED_R, [["nucleo:D13", "r1:1"], ["r1:2", "led1:K"], ["led1:A", "nucleo:GND_P1"]]);
  assert.match(evaluateWiring(series, rev).hint!, /LED 방향이 반대/);
  const wrong = circuit(LED_R, [["nucleo:D12", "r1:1"], ["r1:2", "led1:A"], ["led1:K", "nucleo:GND_P1"]]);
  const r = evaluateWiring(series, wrong);
  assert.equal(r.pass, false);
  assert.equal(r.hint, "저항과 LED가 PA6 (D12)에 연결되어 있습니다. PA5 (D13)에 연결하세요.");
  const short = circuit([], [["nucleo:D13", "nucleo:GND_P1"]]);
  assert.match(evaluateWiring(series, short).hint!, /단락/);
});

test("part and connected checks match parts by kind, whatever their ids", () => {
  const c = circuit([["myLed", "led-5mm"]], [["nucleo:D12", "myLed:A"]]);
  assert.equal(evaluateWiring({ type: "part", kind: "led-5mm" }, c).pass, true);
  assert.match(evaluateWiring({ type: "part", kind: "resistor" }, c).hint!, /^저항이 없습니다/);
  assert.equal(evaluateWiring({ type: "part", kind: "led-5mm", count: 2 }, c).hint, "LED 2개가 필요합니다 (지금 1개).");
  const r = evaluateWiring({ type: "connected", kind: "led-5mm", pin: "A", to: "PA5" }, c);
  assert.equal(r.hint, "LED의 A 핀이 PA5 (D13)에 연결되어 있지 않습니다. 지금은 PA6 (D12)에 연결되어 있습니다.");
  assert.equal(evaluateWiring({ type: "connected", kind: "led-5mm", pin: "A", to: "PA6" }, c).pass, true);
});

test("a button between D2 and GND passes a series check across the switch", () => {
  const c = circuit([["sw", "tact-switch"]], [["nucleo:D2", "sw:1b"], ["sw:2a", "nucleo:GND_P1"], ["sw:1a", "sw:1b"]]);
  assert.equal(evaluateWiring({ type: "series", from: "PA10", to: "GND", through: ["tact-switch"] }, c).pass, true);
});

test("electrical-rule warnings fail the noWarnings check", () => {
  assert.equal(evaluateWiring({ type: "noWarnings" }, circuit([], [])).pass, true);
  assert.match(evaluateWiring({ type: "noWarnings" }, circuit([], [], ["PA5: too much"])).hint!, /PA5: too much/);
});

test("Korean particles follow the last sound, Latin letters and digits included", () => {
  assert.equal(josa("PA5", "이/가"), "PA5가");
  assert.equal(josa("저항", "이/가"), "저항이");
  assert.equal(josa("LED", "이/가"), "LED가");
  assert.equal(josa("3V3", "으로/로"), "3V3으로");
  assert.equal(josa("GND", "으로/로"), "GND로");
  assert.equal(josa("PA7", "으로/로"), "PA7로");
  assert.equal(josa("저항", "와/과"), "저항과");
  assert.equal(josa("LED", "와/과"), "LED와");
  assert.equal(josa("PA6", "이/가"), "PA6이");
});

// --------------------------------------------------------------- behaviour

function frame(timeMs: number, extra: Partial<FrameLike> = {}): FrameLike {
  return { timeMs, stopped: null, pins: [], parts: [], circuitWarnings: [], probes: [], ...extra };
}

/** A recording of PA5 toggling every `half` ms for `ms`, in 16 ms frames. */
function blink(half: number, ms: number): Recording {
  const rec = new Recording();
  let level = false;
  let next = half;
  for (let t = 1000; t <= 1000 + ms; t += 16) {
    const edges: [number, boolean][] = [];
    while (next + 1000 <= t) {
      level = !level;
      edges.push([next + 1000, level]);
      next += half;
    }
    const on = level ? 1 : 0;
    rec.add(frame(t, { probes: [{ name: "PA5", level0: false, edges }], parts: [{ id: "led1", brightness: [on] }] }), "");
  }
  return rec;
}

const ids = (kind: string) => (kind === "led-5mm" ? ["led1"] : kind === "oled-ssd1306" ? ["oled"] : []);
const judge = (c: BehaviourCheck, rec: Recording) => evaluateBehaviour(c, rec, ids, (k) => (k === "led-5mm" ? "LED" : k));

test("the period is measured from the edges, and a wrong one is reported in ms", () => {
  const rec = blink(501, 3800);
  assert.equal(judge({ type: "period", pin: "PA5", ms: 1000 }, rec).pass, true);
  const r = judge({ type: "period", pin: "PA5", ms: 500, tolerance: 0.05 }, rec);
  assert.equal(r.pass, false);
  assert.equal(r.hint, "깜빡임 주기가 1002 ms입니다. 목표는 500 ms (±5%)입니다.");
  assert.equal(judge({ type: "period", pin: "PA5", ms: 500 }, blink(251, 2100)).pass, true);
  assert.match(judge({ type: "period", pin: "PA6", ms: 500 }, rec).hint!, /PA6이 한 번도 바뀌지 않았습니다/);
});

test("brightness must go above and below the thresholds", () => {
  assert.equal(judge({ type: "brightness", kind: "led-5mm", above: 0.5, below: 0.1 }, blink(500, 2000)).pass, true);
  const off = new Recording();
  off.add(frame(0, { parts: [{ id: "led1", brightness: [0] }] }), "");
  assert.match(judge({ type: "brightness", kind: "led-5mm", above: 0.5 }, off).hint!, /LED가 한 번도 켜지지 않았습니다/);
  assert.match(judge({ type: "brightness", kind: "resistor", above: 0.5 }, off).hint!, /회로에 없습니다/);
});

test("console checks count matches and the spread of captured values", () => {
  const rec = new Recording();
  rec.add(frame(0), "D2 pressed (1)\r\npot  100 servo\r\n");
  rec.add(frame(16), "D2 pressed (2)\r\npot 3900 servo\r\n");
  assert.equal(judge({ type: "console", pattern: "D2 pressed \\(\\d+\\)", count: 2 }, rec).pass, true);
  assert.equal(judge({ type: "console", pattern: "D2 pressed", count: 3 }, rec).pass, false);
  assert.equal(judge({ type: "consoleValues", pattern: "pot\\s+(\\d+)", minSpread: 2000 }, rec).pass, true);
  assert.match(judge({ type: "consoleValues", pattern: "pot\\s+(\\d+)", minSpread: 5000 }, rec).hint!, /최소 100, 최대 3900/);
});

test("PWM duty: at some moment, or all the time", () => {
  const rec = new Recording();
  for (const [t, d] of [[0, 0], [16, 0.2], [32, 0.5], [48, 0.95]]) {
    rec.add(frame(t, { pins: [{ port: "B", pin: 3, level: true, duty: d }] }), "");
  }
  assert.equal(judge({ type: "duty", pin: "PB3", min: 0.9, max: 1 }, rec).pass, true);
  assert.equal(judge({ type: "duty", pin: "PB3", min: 0.1, max: 1, mode: "always" }, rec).pass, true);
  assert.equal(judge({ type: "duty", pin: "PB3", min: 0.3, max: 1, mode: "always" }, rec).pass, false);
  assert.match(judge({ type: "duty", pin: "PB4", min: 0, max: 1 }, rec).hint!, /PB4가 출력으로 쓰이지 않았습니다/);
});

test("PWM duty on a slow machine: short frames are judged over 16 ms windows", () => {
  // A steady 25 % at 2 kHz in frames of 1.5 ms (three periods): each frame
  // cuts a period, so one reads 1/3 and the next 1/6 — 25 % on average.
  const rec = new Recording();
  for (let i = 0; i <= 64; i++) {
    rec.add(frame(i * 1.5, { pins: [{ port: "B", pin: 4, level: true, duty: i % 2 ? 1 / 3 : 1 / 6 }] }), "");
  }
  const r = judge({ type: "duty", pin: "PB4", min: 0.2, max: 0.3, mode: "always" }, rec);
  assert.equal(r.pass, true, r.hint);
  // A frame as long as the window is judged on its own, the last one too.
  assert.deepEqual(dutyWindows([{ t: 0, duty: 0 }, { t: 16, duty: 0.2 }, { t: 32, duty: 0.95 }]), [0.2, 0.95]);
  // Short frames add up by their length; a short tail after them is left out.
  assert.deepEqual(dutyWindows([{ t: 0, duty: 0 }, { t: 4, duty: 0.1 }, { t: 16, duty: 0.5 }, { t: 18, duty: 1 }]), [0.4]);
  // Frames that took no time count only when there is nothing else.
  assert.deepEqual(dutyWindows([{ t: 5, duty: 0 }, { t: 5, duty: 0.7 }]), [0.7]);
});

test("a stopped firmware fails the running check; displays count lit pixels", () => {
  const rec = new Recording();
  rec.add(frame(0), "");
  rec.add(frame(16, { stopped: "Error_Handler() was called" }), "");
  assert.match(judge({ type: "running" }, rec).hint!, /Error_Handler/);
  const screen = btoa(String.fromCharCode(0xff, 0x0f, ...new Array(1022).fill(0)));
  assert.equal(litPixels(screen), 12);
  const d = new Recording();
  d.add(frame(0, { parts: [{ id: "oled", screen }] }), "");
  assert.equal(judge({ type: "display", kind: "oled-ssd1306", minPixels: 10 }, d).pass, true);
  assert.equal(judge({ type: "display", kind: "oled-ssd1306", minPixels: 50 }, d).pass, false);
});

// ------------------------------------------------------------ lesson files

const lessonDir = join(web, "lessons");
const lessons = readdirSync(lessonDir)
  .filter((f) => f.endsWith(".json"))
  .map((f) => [f, JSON.parse(readFileSync(join(lessonDir, f), "utf8")) as Lesson] as const);
const kinds = new Set(
  readdirSync(join(web, "src", "parts"))
    .filter((f) => f.endsWith(".tsx"))
    // `kind: "led-5mm"`, and kinds made by a factory (`buzzer("buzzer-passive", …)`).
    .flatMap((f) => [...readFileSync(join(web, "src", "parts", f), "utf8").matchAll(/kind: "([a-z0-9-]+)"|buzzer\(\s*"([a-z0-9-]+)"/g)].map((m) => m[1] ?? m[2])),
);
const bundled = readFileSync(join(web, "scripts", "examples.mjs"), "utf8");

test("every lesson file is valid and refers to bundled examples", () => {
  assert.ok(lessons.length >= 6);
  const ids = new Set<string>();
  for (const [f, l] of lessons) {
    assert.deepEqual(validateLesson(l, kinds), [], f);
    assert.ok(!ids.has(l.id), `${f}: duplicate id ${l.id}`);
    ids.add(l.id);
    if (typeof l.start === "object" && "example" in l.start) assert.ok(existsSync(join(web, "examples", l.start.example)), f);
    if (typeof l.firmware === "object") assert.ok(bundled.includes(`"${l.firmware.example}"`), `${f}: ${l.firmware.example} is not bundled`);
    if (typeof l.start === "object" && "project" in l.start) {
      for (const p of l.start.project.parts) assert.ok(kinds.has(p.kind), `${f}: ${p.kind}`);
    }
    // Long enough to see three periods of every period check.
    for (const c of l.steps.flatMap((s) => s.checks)) {
      if (c.type === "period") assert.ok(gradeMs(l) >= 3 * c.ms, f);
    }
  }
  const orders = lessons.map(([, l]) => l.order).sort((a, b) => a - b);
  assert.equal(new Set(orders).size, orders.length, "orders are unique");
});

test("the validator reports what is wrong", () => {
  const bad = { id: "x", order: 1, title: "t", level: "입문", goal: "g", start: "empty", steps: [{ title: "s", text: "", checks: [{ type: "period", pin: "PA5" }, { type: "nope" }, { type: "part", kind: "warp-drive" }] }] };
  assert.deepEqual(validateLesson(bad, kinds), [
    "단계 1 검사 1 (period): 'ms'가 없습니다",
    "단계 1 검사 2: 알 수 없는 검사 'nope'",
    "단계 1 검사 3: 알 수 없는 부품 종류 'warp-drive'",
  ]);
});

// ---------------------------------------------------------------- progress

test("progress keeps when a result last changed; the CSV is spreadsheet-ready", () => {
  let p: LessonProgress = { id: "led-blink", title: "LED", startedAt: "t0", attempts: 0, checks: {} };
  p = record(p, [{ key: "0.0", step: 0, label: "LED 놓기", result: { pass: false, hint: "LED가 없습니다." } }], "t1");
  p = record(p, [{ key: "0.0", step: 0, label: "LED 놓기", result: { pass: true } }], "t2");
  const same = record(p, [{ key: "0.0", step: 0, label: "LED 놓기", result: { pass: true } }], "t3");
  assert.equal(same, p);
  assert.equal(p.checks["0.0"].at, "t2");
  const file = resultsJson({ "led-blink": { ...p, completedAt: "t2" } }, "홍길동", "t4");
  assert.equal(file.lessons[0].passed, 1);
  const csv = resultsCsv(file);
  assert.ok(csv.startsWith("﻿student,lesson_id"));
  assert.match(csv, /홍길동,led-blink,LED,t2,0,1,LED 놓기,pass,t2/);
  const quoted = resultsCsv({ ...file, student: 'a,"b"' });
  assert.match(quoted, /^﻿.*\r\n"a,""b""",/);
});
