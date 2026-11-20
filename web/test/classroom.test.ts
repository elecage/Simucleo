// Unit tests of the classroom features (M24): result-file integrity, the
// teacher view's merging, cells, pass rates and CSV, the lesson schema
// check, "내 레슨" helpers and wiring checks generated from a circuit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, seal, sha256Hex, verify } from "../src/lessons/integrity.ts";
import { resultsCsv, resultsJson, type LessonProgress, type ResultsFile } from "../src/lessons/progress.ts";
import {
  entryKey,
  fmtDuration,
  lessonCell,
  mergeResults,
  parseCsv,
  parseResults,
  passRates,
  tableCsv,
  tableRows,
  type LoadedResult,
} from "../src/lessons/teacher.ts";
import { parseLesson, validateLesson } from "../src/lessons/validate.ts";
import { checksFromWiring, involved } from "../src/lessons/fromWiring.ts";
import { evaluateWiring, type PinRef, type WiringContext } from "../src/lessons/wiring.ts";
import { blankLesson, normalizeLesson, removeLesson, upsertLesson } from "../src/lessons/mine.ts";
import type { Lesson, WiringCheck } from "../src/lessons/types.ts";

// ------------------------------------------------------------- fixtures

/** A student's progress on lesson 1: steps 0 and 1 passed, step 2 half. */
function progress(student: string, opts: { complete?: boolean; start?: string } = {}): LessonProgress {
  const start = opts.start ?? "2026-03-02T09:00:00.000Z";
  const at = (min: number) => new Date(Date.parse(start) + min * 60_000).toISOString();
  return {
    id: "led-blink",
    title: "LED 깜빡이 배선",
    startedAt: start,
    attempts: opts.complete ? 2 : 1,
    ...(opts.complete ? { completedAt: at(12) } : {}),
    checks: {
      "0.0": { step: 0, label: "LED 놓기", pass: true, at: at(1) },
      "0.1": { step: 0, label: "저항 놓기", pass: true, at: at(2) },
      "1.0": { step: 1, label: `PA5 → 저항 → LED → GND (${student})`, pass: true, at: at(5) },
      "2.0": { step: 2, label: "PA5 주기", pass: true, at: at(12), detail: "측정 주기 1002 ms" },
      "2.1": { step: 2, label: "LED", pass: !!opts.complete, at: at(12), ...(opts.complete ? {} : { hint: "LED가 켜지지 않습니다" }) },
    },
  };
}

function file(student: string, exportedAt: string, opts: { complete?: boolean } = {}): ResultsFile {
  return resultsJson({ "led-blink": progress(student, opts) }, student, exportedAt, [], {
    "led-blink": ["부품 놓기", "배선", "채점"],
  });
}

const json = (f: unknown) => JSON.stringify(f, null, 2);

// ------------------------------------------------------------ integrity

test("canonical JSON sorts keys at every level, so key order does not change the hash", async () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: null }], u: undefined }), '{"a":[{"c":null,"d":2}],"b":1}');
  assert.equal(await sha256Hex(canonicalJson({ x: 1, y: 2 })), await sha256Hex(canonicalJson({ y: 2, x: 1 })));
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("a sealed results file verifies; any edit, even a reordered copy edited back, is caught", async () => {
  const sealed = await seal(file("kim 01", "2026-03-02T10:00:00Z"));
  assert.equal(sealed.integrity.alg, "SHA-256");
  assert.match(sealed.integrity.hash, /^[0-9a-f]{64}$/);
  assert.equal(await verify(sealed), "verified");
  // Round trip through text (what the teacher gets).
  assert.equal(await verify(JSON.parse(json(sealed))), "verified");
  // A student flips a failed check to pass.
  const edited = JSON.parse(json(sealed));
  edited.lessons[0].checks[4].pass = true;
  assert.equal(await verify(edited), "tampered");
  // ...or renames the file's student.
  const renamed = { ...JSON.parse(json(sealed)), student: "park 02" };
  assert.equal(await verify(renamed), "tampered");
  // A broken integrity field is tampered too, not "unverified".
  assert.equal(await verify({ ...sealed, integrity: { alg: "MD5", hash: sealed.integrity.hash } }), "tampered");
  assert.equal(await verify({ ...sealed, integrity: null }), "tampered");
});

test("a results file from before M24 (no integrity field) is unverified, not tampered", async () => {
  assert.equal(await verify(file("kim 01", "2026-03-02T10:00:00Z")), "unverified");
  const [r] = await parseResults("old.json", json(file("kim 01", "t")));
  assert.equal(r.integrity, "unverified");
  assert.equal(r.file?.student, "kim 01");
});

// -------------------------------------------------------------- parsing

test("parseResults reads sealed, tampered and broken files", async () => {
  const sealed = await seal(file("kim 01", "2026-03-02T10:00:00Z"));
  assert.equal((await parseResults("a.json", "﻿" + json(sealed)))[0].integrity, "verified");
  const t = JSON.parse(json(sealed));
  t.lessons[0].checks[4].pass = true;
  assert.equal((await parseResults("b.json", json(t)))[0].integrity, "tampered");
  assert.match((await parseResults("c.json", "{ nope"))[0].error!, /JSON 오류/);
  assert.match((await parseResults("d.json", '{"format":"x"}'))[0].error!, /실습 결과 파일이 아닙니다/);
  assert.match((await parseResults("e.json", '{"format":"simucleo-lesson-results","student":"a","lessons":[{"id":"x"}]}'))[0].error!, /checks/);
});

test("the CSV export reads back, and concatenated CSVs give one result per student", async () => {
  const a = resultsCsv(file("kim 01", "t"));
  const b = resultsCsv(file('park, "02"', "t", { complete: true }));
  const both = a + b.replace(/^﻿/, ""); // header and all: what a teacher pastes together
  const rs = await parseResults("all.csv", both);
  assert.equal(rs.length, 2);
  assert.deepEqual(
    rs.map((r) => [r.file!.student, r.kind, r.integrity]),
    [
      ["kim 01", "csv", "unverified"],
      ['park, "02"', "csv", "unverified"],
    ],
  );
  const l = rs[1].file!.lessons[0];
  assert.equal(l.checks.length, 5);
  assert.deepEqual(
    l.checks.map((c) => c.key),
    ["0.0", "0.1", "1.0", "2.0", "2.1"],
  );
  assert.equal(l.completedAt, "2026-03-02T09:12:00.000Z");
  assert.equal(l.checks[3].detail, "측정 주기 1002 ms");
  assert.equal(rs[0].file!.lessons[0].checks[4].hint, "LED가 켜지지 않습니다");
  assert.deepEqual(parseCsv('a,"b ""c""",d\r\n"x\ny",,\r\n'), [
    ["a", 'b "c"', "d"],
    ["x\ny", "", ""],
  ]);
  assert.match((await parseResults("z.csv", "foo,bar\n1,2"))[0].error!, /CSV/);
});

// -------------------------------------------------------------- merging

async function load(...files: [string, ResultsFile | string][]): Promise<LoadedResult[]> {
  const out: LoadedResult[] = [];
  for (const [name, f] of files) out.push(...(await parseResults(name, typeof f === "string" ? f : json(f))));
  return out;
}

test("duplicates (same student and lesson) keep the latest export, whatever the load order", async () => {
  const old = file("kim 01", "2026-03-02T10:00:00Z");
  const fresh = file("kim  01 ", "2026-03-09T10:00:00Z", { complete: true }); // spacing differs
  for (const order of [
    [["old.json", old], ["new.json", fresh]],
    [["new.json", fresh], ["old.json", old]],
  ] as [string, ResultsFile][][]) {
    const m = mergeResults(await load(...order));
    assert.deepEqual(m.students, ["kim 01"]);
    assert.equal(m.entries[entryKey("kim 01", "led-blink")].source, "new.json");
    assert.equal(m.duplicates.length, 1);
    assert.deepEqual(m.duplicates[0], { student: "kim 01", lessonId: "led-blink", kept: "new.json", dropped: "old.json" });
  }
  // Different students: no duplicate. Unreadable files are listed.
  const m = mergeResults(await load(["a.json", old], ["b.json", file("lee 03", "t")], ["c.json", "{"]));
  assert.equal(m.students.length, 2);
  assert.equal(m.duplicates.length, 0);
  assert.equal(m.errors.length, 1);
  assert.deepEqual(
    m.lessons[0].steps.map((s) => s.title),
    ["부품 놓기", "배선", "채점"],
  );
});

test("cells: step status, score and the time taken", async () => {
  const m = mergeResults(await load(["a.json", file("kim 01", "t")], ["b.json", file("park 02", "t", { complete: true })]));
  const kim = lessonCell(m.entries[entryKey("kim 01", "led-blink")]);
  assert.equal(kim.completed, false);
  assert.equal(kim.score, 80);
  assert.equal(kim.timeMs, undefined);
  assert.deepEqual(kim.steps[0], { status: "pass", passed: 2, total: 2, timeMs: 2 * 60_000 });
  assert.equal(kim.steps[2].status, "partial");
  assert.equal(kim.steps[2].timeMs, undefined);
  const park = lessonCell(m.entries[entryKey("park 02", "led-blink")]);
  assert.equal(park.completed, true);
  assert.equal(park.score, 100);
  assert.equal(park.timeMs, 12 * 60_000);
  assert.equal(park.attempts, 2);
  assert.equal(fmtDuration(park.timeMs), "12분");
  assert.equal(fmtDuration(95_000), "1분 35초");
  assert.equal(fmtDuration(42_000), "42초");
  assert.equal(fmtDuration(3_900_000), "1시간 5분");
});

test("per-step pass rates count the students who handed in the lesson", async () => {
  const fail: ResultsFile = file("choi 04", "t");
  fail.lessons[0].checks = fail.lessons[0].checks.map((c) => (c.step === 1 ? { ...c, pass: false } : c));
  const other = resultsJson(
    { other: { id: "other", title: "다른 실습", startedAt: "t", attempts: 0, checks: { "0.0": { step: 0, label: "x", pass: true, at: "t" } } } },
    "lee 03",
    "t",
  );
  const m = mergeResults(
    await load(["a.json", file("kim 01", "t")], ["b.json", file("park 02", "t", { complete: true })], ["c.json", fail], ["d.json", other]),
  );
  const r = passRates(m);
  assert.deepEqual(r["led-blink"].completed, { passed: 1, n: 3 });
  assert.deepEqual(r["led-blink"].steps[0], { passed: 3, n: 3 });
  assert.deepEqual(r["led-blink"].steps[1], { passed: 2, n: 3 });
  assert.deepEqual(r["led-blink"].steps[2], { passed: 1, n: 3 });
  assert.deepEqual(r.other.steps[0], { passed: 1, n: 1 });
});

test("table rows: sorting, filters and the worst integrity of a student's files", async () => {
  const sealedPark = await seal(file("park 02", "t", { complete: true }));
  const tampered = JSON.parse(json(await seal(file("choi 04", "t"))));
  tampered.lessons[0].checks[4].pass = true;
  const m = mergeResults(await load(["k.json", file("kim 01", "t")], ["p.json", sealedPark], ["c.json", JSON.stringify(tampered)]));
  const names = (opts: Parameters<typeof tableRows>[1]) => tableRows(m, opts).map((r) => r.student);
  assert.deepEqual(names({}), ["choi 04", "kim 01", "park 02"]);
  assert.deepEqual(names({ sort: { by: "student", desc: true } }), ["park 02", "kim 01", "choi 04"]);
  // The edited file claims 100 % (but no completion): ties keep the load order.
  assert.deepEqual(names({ sort: { by: "score:led-blink", desc: true } }), ["park 02", "choi 04", "kim 01"]);
  assert.deepEqual(names({ sort: { by: "score:led-blink" } }), ["kim 01", "park 02", "choi 04"]);
  // Only park completed: the others have no time and sort last.
  assert.deepEqual(names({ sort: { by: "time:led-blink" } }), ["park 02", "kim 01", "choi 04"]);
  assert.deepEqual(names({ sort: { by: "step:led-blink:2" } }), ["kim 01", "park 02", "choi 04"]);
  assert.deepEqual(names({ filter: "KIM" }), ["kim 01"]);
  assert.deepEqual(names({ incompleteOnly: true }), ["choi 04", "kim 01"]);
  assert.deepEqual(names({ incompleteOnly: true, lesson: "led-blink", filter: "ch" }), ["choi 04"]);
  assert.deepEqual(names({ tamperedOnly: true }), ["choi 04"]);
  const rows = tableRows(m);
  assert.deepEqual(
    rows.map((r) => r.integrity),
    ["tampered", "unverified", "verified"],
  );
  assert.deepEqual(names({ sort: { by: "integrity", desc: true } }), ["choi 04", "kim 01", "park 02"]);
});

test("time sorting puts students without a time last, in both directions", async () => {
  const fast = file("a", "t", { complete: true });
  const slow = resultsJson({ "led-blink": { ...progress("b", { complete: true }), completedAt: "2026-03-02T09:30:00.000Z" } }, "b", "t");
  const none = file("c", "t");
  const m = mergeResults(await load(["1", none], ["2", slow], ["3", fast]));
  assert.deepEqual(
    tableRows(m, { sort: { by: "time:led-blink" } }).map((r) => r.student),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    tableRows(m, { sort: { by: "time:led-blink", desc: true } }).map((r) => r.student),
    ["b", "a", "c"],
  );
});

test("the table CSV has a row per student, step columns and the pass rates", async () => {
  const m = mergeResults(await load(["k.json", file("kim, 01", "t")], ["p.json", await seal(file("park 02", "t", { complete: true }))]));
  const csv = tableCsv(m, tableRows(m));
  assert.ok(csv.startsWith("﻿student,integrity,files,"));
  const lines = parseCsv(csv);
  assert.equal(lines.length, 4);
  assert.deepEqual(lines[0].slice(3, 11), [
    "LED 깜빡이 배선 점수",
    "LED 깜빡이 배선 통과",
    "LED 깜빡이 배선 완료",
    "LED 깜빡이 배선 시간(초)",
    "LED 깜빡이 배선 채점 횟수",
    "LED 깜빡이 배선 1. 부품 놓기",
    "LED 깜빡이 배선 2. 배선",
    "LED 깜빡이 배선 3. 채점",
  ]);
  assert.deepEqual(lines[1], ["kim, 01", "검증 안 됨", "k.json", "80", "4/5", "no", "", "1", "pass", "pass", "partial 1/2"]);
  assert.deepEqual(lines[2], ["park 02", "검증됨", "p.json", "100", "5/5", "yes", "720", "2", "pass", "pass", "pass"]);
  assert.deepEqual(lines[3], ["통과율", "", "", "", "", "50% (1/2)", "", "", "100% (2/2)", "100% (2/2)", "50% (1/2)"]);
  assert.match(csv, /\r\n"kim, 01",/);
});

// ------------------------------------------------------------- schema

const KINDS = new Set(["nucleo-f401re", "led-5mm", "resistor", "tact-switch", "potentiometer", "rgb-led", "oled-ssd1306", "servo", "breadboard-half"]);
const good = (): Lesson => ({
  id: "my-blink",
  order: 101,
  title: "내 깜빡이",
  level: "입문",
  goal: "LED를 깜빡입니다.",
  start: "empty",
  firmware: { example: "hal-blinky.elf" },
  grade: { ms: 3000, stimuli: [{ at: 500, press: "B1" }] },
  steps: [{ title: "배선", text: ["a", "b"], checks: [{ type: "series", from: "PA5", to: "GND", through: ["resistor", "led-5mm"] }] }],
});

test("the lesson schema check accepts a good lesson and names each problem", () => {
  assert.deepEqual(validateLesson(good(), KINDS), []);
  const bad = (f: (l: Lesson) => void) => {
    const l = good();
    f(l);
    return validateLesson(l, KINDS);
  };
  assert.match(bad((l) => (l.id = "내 레슨"))[0], /'id'는 영문/);
  assert.match(bad((l) => ((l as { order: unknown }).order = "1"))[0], /order/);
  assert.match(bad((l) => (l.start = { project: { parts: [], wires: undefined as never } }))[0], /start.project/);
  assert.match(bad((l) => (l.grade = { ms: -1 }))[0], /grade.ms/);
  assert.match(bad((l) => (l.grade = { stimuli: [{ at: 1 } as never] }))[0], /'press' 또는 'set'/);
  assert.match(bad((l) => (l.grade = { stimuli: [{ at: 1, set: { kind: "lamp", prop: "x", value: 1 } }] }))[0], /알 수 없는 부품 종류 'lamp'/);
  assert.match(bad((l) => (l.steps[0].checks = [{ type: "series", from: "PA5", to: "GND", through: ["led"] }]))[0], /쓸 수 없는 것 'led'/);
  assert.match(bad((l) => (l.steps[0].checks = [{ type: "series", from: "PA5", to: "GND", through: [] }]))[0], /비어 있지 않은 배열/);
  assert.match(bad((l) => (l.steps[0].checks = [{ type: "period", pin: "PA5", ms: "1000" as never }]))[0], /'ms'는 숫자/);
  assert.match(bad((l) => (l.steps[0].checks = [{ type: "duty", pin: "PA5", min: 0, max: 1, mode: "often" as never }]))[0], /mode/);
  assert.match(bad((l) => (l.steps[0].checks = [{ type: "motion", kind: "servo", field: "speed" as never, minSpread: 1 }]))[0], /field/);
  assert.match(bad((l) => (l.steps[0].checks = [{ type: "console", pattern: "(" }]))[0], /정규식 오류/);
  assert.match(bad((l) => (l.steps[0].checks = [{ type: "connected", kind: "led-5mm", pin: "", to: "PA5" }]))[0], /'pin'가 없습니다/);
  assert.match(bad((l) => (l.steps[0].checks = [{ type: "blink" } as never]))[0], /알 수 없는 검사 'blink'/);
  assert.match(bad((l) => (l.steps[0].text = [1] as never))[0], /'text'/);
  assert.match(bad((l) => (l.steps = []))[0], /steps/);
  // A blank lesson from the editor only lacks its goal.
  assert.deepEqual(validateLesson(blankLesson(), KINDS), ["'goal'가 없습니다"]);
  assert.deepEqual(parseLesson(JSON.stringify(good()), KINDS).errors, []);
  assert.match(parseLesson("{", KINDS).errors[0], /JSON 오류/);
  assert.equal(parseLesson(JSON.stringify({ ...good(), goal: "" }), KINDS).lesson, undefined);
});

test("내 레슨: saving replaces a lesson with the same id, removing drops it", () => {
  const a = good();
  const b = { ...good(), id: "other" };
  let list = upsertLesson(upsertLesson([], a), b);
  list = upsertLesson(list, { ...a, title: "고침" });
  assert.deepEqual(
    list.map((l) => [l.id, l.title]),
    [
      ["my-blink", "고침"],
      ["other", "내 깜빡이"],
    ],
  );
  assert.deepEqual(removeLesson(list, "my-blink").map((l) => l.id), ["other"]);
  assert.equal(blankLesson(["my-lesson-1"]).id, "my-lesson-2");
});

// ---------------------------------------------------- checks from wiring

const BOARD: Record<string, string> = {
  D13: "PA5", D12: "PA6", D2: "PA10", D3: "PB3", D5: "PB4", D6: "PB10", D9: "PC7", D14: "PB9", D15: "PB8", A0: "PA0",
  GND_P1: "GND", GND_D: "GND", GND_P2: "GND", "3V3": "3V3", "5V": "5V",
};

/** A context from wires between part pins (nets joined by union-find), as the core gives it. */
function circuit(parts: [string, string][], wires: [string, string][]): WiringContext {
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
  const gnds = [...all].filter((k) => k.startsWith("nucleo:GND"));
  for (const g of gnds) parent.set(find(g), find(gnds[0]));
  const nets = new Map<string, PinRef[]>();
  for (const k of all) {
    const [part, pin] = k.split(":");
    nets.set(find(k), [...(nets.get(find(k)) ?? []), { part, pin }]);
  }
  return {
    parts: [["nucleo", "nucleo-f401re"], ...parts].map(([id, kind]) => ({ id, kind })),
    nets: [...nets.values()].map((pins) => ({ pins })),
    boardSignal: (kind, pin) => (kind === "nucleo-f401re" ? BOARD[pin] : undefined),
    nameOf: (k) => k,
    warnings: [],
  };
}

const allPass = (checks: WiringCheck[], ctx: WiringContext) =>
  checks.map((c) => [JSON.stringify(c), evaluateWiring(c, ctx).pass]).filter(([, p]) => !p);

test("checks from the current wiring: an LED and resistor on a breadboard", () => {
  const wires: [string, string][] = [
    ["nucleo:D13", "bb:a9"],
    ["bb:a9", "r1:1"],
    ["r1:2", "bb:c12"],
    ["bb:c12", "led1:A"],
    ["led1:K", "bb:tn1"],
    ["bb:tn1", "nucleo:GND_P1"],
  ];
  const ctx = circuit([["bb", "breadboard-half"], ["r1", "resistor"], ["led1", "led-5mm"]], wires);
  const checks = checksFromWiring(ctx);
  assert.deepEqual(checks, [
    { type: "part", kind: "led-5mm" },
    { type: "part", kind: "resistor" },
    { type: "series", from: "PA5", to: "GND", through: ["resistor", "led-5mm"] },
  ]);
  assert.deepEqual(allPass(checks, ctx), []);
  // The generated checks catch the mistakes they are about.
  const noRes = circuit([["led1", "led-5mm"]], [["nucleo:D13", "led1:A"], ["led1:K", "nucleo:GND_P1"]]);
  assert.equal(evaluateWiring(checks[2], noRes).pass, false);
  const wrongPin = circuit([["r1", "resistor"], ["led1", "led-5mm"]], [["nucleo:D12", "r1:1"], ["r1:2", "led1:A"], ["led1:K", "nucleo:GND_D"]]);
  assert.equal(evaluateWiring(checks[2], wrongPin).pass, false);
});

test("checks from the current wiring: a reversed LED gives a chain that points the LED's way", () => {
  const ctx = circuit([["r1", "resistor"], ["led1", "led-5mm"]], [["nucleo:D13", "r1:1"], ["r1:2", "led1:K"], ["led1:A", "nucleo:GND_P1"]]);
  const checks = checksFromWiring(ctx);
  assert.deepEqual(checks[2], { type: "series", from: "GND", to: "PA5", through: ["led-5mm", "resistor"] });
  assert.deepEqual(allPass(checks, ctx), []);
});

test("checks from the current wiring: button, potentiometer, OLED, servo and an RGB LED", () => {
  const parts: [string, string][] = [
    ["sw", "tact-switch"], ["pot", "potentiometer"], ["oled", "oled-ssd1306"], ["servo", "servo"],
    ["rgb", "rgb-led"], ["rr", "resistor"], ["rg", "resistor"], ["rb", "resistor"],
  ];
  const ctx = circuit(parts, [
    ["nucleo:D2", "sw:1a"], ["sw:1a", "sw:1b"], ["sw:2a", "nucleo:GND_P1"],
    ["pot:1", "nucleo:3V3"], ["pot:2", "nucleo:GND_P2"], ["pot:W", "nucleo:A0"],
    ["oled:VCC", "nucleo:3V3"], ["oled:GND", "nucleo:GND_D"], ["oled:SCL", "nucleo:D15"], ["oled:SDA", "nucleo:D14"],
    ["servo:V+", "nucleo:5V"], ["servo:GND", "nucleo:GND_D"], ["servo:SIG", "nucleo:D9"],
    ["nucleo:D3", "rr:1"], ["rr:2", "rgb:R"], ["nucleo:D5", "rg:2"], ["rg:1", "rgb:G"], ["nucleo:D6", "rb:1"], ["rb:2", "rgb:B"], ["rgb:COM", "nucleo:GND_D"],
  ]);
  const checks = checksFromWiring(ctx);
  assert.deepEqual(allPass(checks, ctx), []);
  const has = (c: WiringCheck) => assert.ok(checks.some((x) => JSON.stringify(x) === JSON.stringify(c)), `missing ${JSON.stringify(c)}`);
  has({ type: "part", kind: "resistor", count: 3 });
  has({ type: "series", from: "PA10", to: "GND", through: ["tact-switch"] });
  has({ type: "series", from: "3V3", to: "GND", through: ["potentiometer"] });
  has({ type: "series", from: "PB3", to: "GND", through: ["resistor", "rgb-led:R"] });
  has({ type: "series", from: "PB4", to: "GND", through: ["resistor", "rgb-led:G"] });
  has({ type: "series", from: "PB10", to: "GND", through: ["resistor", "rgb-led:B"] });
  has({ type: "connected", kind: "potentiometer", pin: "W", to: "PA0" });
  has({ type: "connected", kind: "oled-ssd1306", pin: "SDA", to: "PB9" });
  has({ type: "connected", kind: "oled-ssd1306", pin: "SCL", to: "PB8" });
  has({ type: "connected", kind: "oled-ssd1306", pin: "VCC", to: "3V3" });
  has({ type: "connected", kind: "servo", pin: "SIG", to: "PC7" });
  has({ type: "connected", kind: "servo", pin: "V+", to: "5V" });
  // Pins already in a series chain get no connected check of their own.
  assert.ok(!checks.some((c) => c.type === "connected" && (c.kind === "resistor" || c.kind === "tact-switch" || c.kind === "rgb-led")));
  // Swapping SDA and SCL fails the generated checks.
  const swapped = circuit(parts, [["oled:SCL", "nucleo:D14"], ["oled:SDA", "nucleo:D15"]]);
  assert.equal(evaluateWiring({ type: "connected", kind: "oled-ssd1306", pin: "SDA", to: "PB9" }, swapped).pass, false);
});

test("checks from the current wiring: nothing but the board gives no checks", () => {
  assert.deepEqual(checksFromWiring(circuit([["bb", "breadboard-half"]], [["nucleo:D13", "bb:a1"]])), []);
});

test("involved: the pins and signals a failed wiring check is about", () => {
  const ctx = circuit([["r1", "resistor"], ["led1", "led-5mm"], ["oled", "oled-ssd1306"]], []);
  assert.deepEqual(involved({ type: "series", from: "PA5", to: "GND", through: ["resistor", "led-5mm"] }, ctx), {
    pins: [
      { part: "r1", pin: "1" },
      { part: "r1", pin: "2" },
      { part: "led1", pin: "A" },
      { part: "led1", pin: "K" },
    ],
    signals: ["PA5", "GND"],
  });
  assert.deepEqual(involved({ type: "connected", kind: "oled-ssd1306", pin: "SDA", to: "PB9" }, ctx), {
    pins: [{ part: "oled", pin: "SDA" }],
    signals: ["PB9"],
  });
  assert.deepEqual(involved({ type: "part", kind: "led-5mm" }, ctx), { pins: [], signals: [] });
});

// ------------------------------------------- review fixes (PR #29)

test("a malformed lesson draft is normalized to something the editor can show, with its errors", () => {
  // The reviewer's example: passed the editor's guard and crashed on `start`.
  const l = normalizeLesson({ steps: [{ title: "Step", text: "", checks: [] }] })!;
  assert.equal(l.start, "empty");
  assert.deepEqual([l.id, l.title, l.level, l.goal], ["", "", "", ""]);
  assert.equal(typeof l.order, "number");
  assert.deepEqual(l.steps, [{ title: "Step", text: "", checks: [] }]);
  const errors = validateLesson(l, KINDS);
  assert.ok(errors.includes("'id'가 없습니다") && errors.includes("'goal'가 없습니다"), errors.join("; "));
  // Garbage everywhere: every field the editor and the list read has its type.
  const g = normalizeLesson({
    id: 7,
    title: { x: 1 },
    start: { project: null },
    firmware: null,
    grade: [1],
    steps: [null, { title: 3, text: [1, "a"], checks: [null, 2, { type: "part", kind: "led-5mm" }] }],
  })!;
  assert.equal(g.id, "7");
  assert.equal(g.title, "");
  assert.deepEqual(g.start, { project: { parts: [], wires: [] } });
  assert.equal("firmware" in g, false);
  assert.equal("grade" in g, false);
  assert.deepEqual(g.steps[0], { title: "", text: "", checks: [] });
  assert.deepEqual(g.steps[1], { title: "3", text: ["1", "a"], checks: [{ type: "part", kind: "led-5mm" }] });
  assert.deepEqual(normalizeLesson({ start: { example: {} }, steps: "x" })!.start, { example: "" });
  for (const x of [null, undefined, 3, "lesson", [], [{ steps: [] }]]) assert.equal(normalizeLesson(x), null);
  // A good lesson comes through unchanged.
  assert.deepEqual(normalizeLesson(good()), good());
  assert.deepEqual(normalizeLesson({ ...good(), firmware: "upload" }), { ...good(), firmware: "upload" });
  // The schema check itself never throws on garbage (the "레슨 파일 불러오기" path).
  for (const x of [{ steps: [null] }, { steps: [{ checks: [null, 1, { type: "series", through: "x" }] }] }, { start: null, grade: { stimuli: [null] } }]) {
    assert.ok(validateLesson(x, KINDS).length > 0);
  }
});
