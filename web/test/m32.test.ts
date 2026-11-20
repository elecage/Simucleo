// M32: the curriculum — every bundled lesson is complete and points at
// firmware and circuits that exist; the course fields, the new stimuli and
// the TM1637 / NeoPixel readings of the display and brightness checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { digitsText, evaluateBehaviour, pixelLevel, Recording, type FrameLike } from "../src/lessons/behaviour.ts";
import { validateLesson } from "../src/lessons/validate.ts";
import type { BehaviourCheck, Lesson } from "../src/lessons/types.ts";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const firmware = join(web, "..", "firmware");
const lessons = readdirSync(join(web, "lessons"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => [f, JSON.parse(readFileSync(join(web, "lessons", f), "utf8")) as Lesson] as const);

/** The example list of scripts/examples.mjs: [firmware folder, ELF file]. */
const examples = [...readFileSync(join(web, "scripts", "examples.mjs"), "utf8").matchAll(/^\s*\["([a-z0-9-]+)", "([a-z0-9-]+\.elf)"/gm)].map(
  (m) => [m[1], m[2]] as const,
);

test("the curriculum has at least 25 lessons in tracks A–G, each with goals, time, mistakes and challenges", () => {
  assert.ok(lessons.length >= 25, `${lessons.length} lessons`);
  const ids = new Set<string>();
  const tracks = new Map<string, number>();
  for (const [f, l] of lessons) {
    assert.ok(!ids.has(l.id), `${f}: duplicate id ${l.id}`);
    ids.add(l.id);
    assert.match(l.track ?? "", /^[A-G]\. /, `${f}: track`);
    tracks.set(l.track!, (tracks.get(l.track!) ?? 0) + 1);
    assert.ok((l.minutes ?? 0) > 0, `${f}: minutes`);
    assert.ok((l.objectives ?? []).length >= 2, `${f}: objectives`);
    assert.ok((l.mistakes ?? []).length >= 1, `${f}: mistakes`);
    assert.ok((l.challenges ?? []).length >= 1, `${f}: challenges`);
    assert.ok(l.prereq, `${f}: prereq`);
    // Something to grade, and a concept box somewhere.
    assert.ok(l.steps.some((s) => s.checks.length > 0), `${f}: checks`);
    assert.ok(l.steps.some((s) => s.theory), `${f}: theory`);
  }
  assert.equal(tracks.size, 7);
  for (const [t, n] of tracks) assert.ok(n >= 3, `${t}: ${n} lessons`);
  // A track's lessons are next to each other in the list order.
  const byOrder = lessons.map(([, l]) => l).sort((a, b) => a.order - b.order);
  const seen: string[] = [];
  for (const l of byOrder) if (seen[seen.length - 1] !== l.track) seen.push(l.track!);
  assert.equal(seen.length, 7, `tracks in order: ${seen.join(", ")}`);
});

test("every lesson's firmware is a bundled example built from a firmware folder, and its start circuit exists", () => {
  for (const [f, l] of lessons) {
    if (typeof l.firmware === "object") {
      const elf = l.firmware.example;
      const e = examples.find(([, file]) => file === elf);
      assert.ok(e, `${f}: ${l.firmware.example} is not in examples.mjs`);
      assert.ok(existsSync(join(firmware, e[0], "Makefile")), `${f}: firmware/${e[0]}/Makefile`);
    }
    if (typeof l.start === "object" && "example" in l.start) assert.ok(existsSync(join(web, "examples", l.start.example)), `${f}: ${l.start.example}`);
  }
  // The new lesson firmware is built by CI (both lists) and has its source.
  const ci = readFileSync(join(web, "..", ".github", "workflows", "ci.yml"), "utf8");
  for (const [dir] of examples.filter(([d]) => d.startsWith("lesson-"))) {
    assert.ok(existsSync(join(firmware, dir, "main.c")), dir);
    assert.equal([...ci.matchAll(new RegExp(` ${dir}[ ;]`, "g"))].length, 2, `${dir} in both CI build lists`);
  }
});

const base = { id: "x", order: 1, title: "t", level: "입문", goal: "g", start: "empty", steps: [{ title: "s", text: "", checks: [] }] };

test("the course fields and the new stimuli are checked", () => {
  assert.deepEqual(
    validateLesson({
      ...base,
      track: "A. 기초",
      minutes: 20,
      objectives: ["a"],
      prereq: ["b", "c"],
      mistakes: ["m"],
      challenges: ["c"],
      steps: [{ title: "s", text: "", theory: ["x"], hint: "h", checks: [] }],
      grade: { stimuli: [{ at: 1, send: "led on" }, { at: 2, send: "on", to: "hc05" }, { at: 3, connect: "hc05" }, { at: 4, press: "keypad-4x4:5" }] },
    }, new Set(["hc05", "keypad-4x4"])),
    [],
  );
  assert.deepEqual(
    validateLesson({
      ...base,
      track: "",
      minutes: -1,
      objectives: "a",
      challenges: [1],
      steps: [{ title: "s", text: "", theory: 3, checks: [] }],
      grade: { stimuli: [{ at: 1, send: "x", to: "warp-drive" }, { at: 2, connect: "warp-drive" }, { at: 3 }] },
    }, new Set(["hc05"])),
    [
      "조작 1: 알 수 없는 부품 종류 'warp-drive'",
      "조작 2: 알 수 없는 부품 종류 'warp-drive'",
      "조작 3: 'press' 또는 'set'(또는 'send', 'connect')이 있어야 합니다",
      "'track'은 비어 있지 않은 문자열이어야 합니다",
      "'minutes'는 0보다 큰 숫자여야 합니다",
      "'objectives'는 문자열 배열이어야 합니다",
      "'challenges'는 문자열 배열이어야 합니다",
      "단계 1: 'theory'는 문자열 또는 문자열 배열이어야 합니다",
    ],
  );
});

function frame(timeMs: number, parts: FrameLike["parts"]): FrameLike {
  return { timeMs, stopped: null, pins: [], parts, circuitWarnings: [], probes: [] };
}

test("a TM1637 reads as text for the display check, the colon included", () => {
  // 1 2 : 3 4 — digit 1's bit 7 is the colon.
  const on = { segments: [0x06, 0x5b | 0x80, 0x4f, 0x66], on: true };
  assert.equal(digitsText(on), "12:34");
  assert.equal(digitsText({ ...on, segments: [0x06, 0x5b, 0x4f, 0x66] }), "1234");
  assert.equal(digitsText({ ...on, on: false }), "");
  assert.equal(digitsText({ segments: [0x40, 0x40, 0, 0x76], on: true }), "--  H".replace("  ", " "));
  const rec = new Recording();
  rec.add(frame(0, [{ id: "d", digits: { ...on, on: false } }]), "");
  rec.add(frame(100, [{ id: "d", digits: on }]), "");
  const c: BehaviourCheck = { type: "display", kind: "tm1637", text: "\\d\\d:?\\d\\d" };
  assert.deepEqual(evaluateBehaviour(c, rec, () => ["d"], () => "TM1637"), { pass: true, detail: '"12:34"' });
  const dark = new Recording();
  dark.add(frame(0, [{ id: "d", digits: { ...on, on: false } }]), "");
  const r = evaluateBehaviour({ type: "display", kind: "tm1637" }, dark, () => ["d"], () => "TM1637");
  assert.equal(r.pass, false);
  assert.match(r.hint!, /CLK·DIO/);
});

test("NeoPixels count for the brightness check: their brightest colour", () => {
  assert.equal(pixelLevel([0x000000, 0x80ff00]), 1);
  assert.equal(pixelLevel([0x330000], 0), 0x33 / 255);
  assert.equal(pixelLevel([0x330000], 1), 0);
  const rec = new Recording();
  rec.add(frame(0, [{ id: "ring", leds: [0, 0] }]), "");
  rec.add(frame(100, [{ id: "ring", leds: [0x202020, 0x00ff00] }]), "");
  assert.equal(evaluateBehaviour({ type: "brightness", kind: "neopixel-ring", above: 0.5, below: 0.1 }, rec, () => ["ring"], () => "링").pass, true);
  assert.equal(evaluateBehaviour({ type: "brightness", kind: "neopixel-ring", above: 0.5, channel: 0 }, rec, () => ["ring"], () => "링").pass, false);
});
