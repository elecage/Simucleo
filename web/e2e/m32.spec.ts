import { expect, test, type Page } from "@playwright/test";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// M32: the curriculum. Every bundled lesson, loaded with its reference
// circuit and solution firmware, passes all of its checks; and for each
// track a deliberately wrong setup fails the checks that should catch it.

test.describe.configure({ mode: "parallel" });

interface Lesson {
  id: string;
  track?: string;
  title: string;
  firmware?: { example: string } | "upload";
  grade?: { ms?: number };
  steps: { checks: { type: string; label?: string }[] }[];
}

const LESSONS: Lesson[] = readdirSync("lessons")
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join("lessons", f), "utf8")) as Lesson);

const example = (name: string) => `public/examples/${name}.simucleo.json`;
const solution = (name: string) => `e2e/solutions/${name}.simucleo.json`;
const elf = (dir: string, name = dir) => `../firmware/${dir}/build/${name}.elf`;

/**
 * The reference solution of each lesson: the circuit to open over the
 * start circuit (none: the start circuit is the solution) and, for the
 * lessons where the student builds or fixes the firmware, the ELF.
 */
const SOLUTIONS: Record<string, { project?: string; elf?: string }> = {
  // A. 기초
  "led-on": { project: example("lesson-led-on") },
  "led-blink": { project: solution("led-blink") },
  "blink-2hz": { elf: elf("lesson-blink-2hz") },
  "button-poll": { project: example("lesson-button-poll") },
  "button-exti": { project: example("hal-button-exti") },
  "knight-rider": { project: example("lesson-knight-rider") },
  "seven-segment": { project: example("hal-7seg-keypad") },
  // B. 타이머·PWM
  "timer-irq": { project: example("lesson-timer-irq") },
  "pwm-breathe": { project: solution("pwm-breathe") },
  "pwm-rgb": { project: example("hal-pwm-led") },
  "buzzer-melody": { project: example("hal-buzzer-melody") },
  "servo-angle": { project: example("hal-servos-multi") },
  // C. 아날로그
  "pot-serial": { project: example("hal-adc-servo") },
  "adc-servo": { project: example("hal-adc-servo") },
  "ldr-nightlight": { project: example("lesson-ldr-nightlight") },
  "tmp36": { project: example("hal-adc-servo") },
  "joystick-servos": { project: example("lesson-joystick-servos") },
  // D. 통신
  "uart-command": {},
  "i2c-oled": { project: example("hal-i2c-oled") },
  "i2c-rtc": { project: example("hal-i2c-oled") },
  "spi-595": { project: example("hal-shift-register") },
  "tm1637": { project: example("hal-tm1637-clock") },
  "onewire-ds18b20": { project: example("hal-onewire-multi") },
  "bluetooth-hc05": { project: example("hal-bluetooth-led") },
  // E. 센서·액추에이터
  "sonar-alarm": { project: example("lesson-parking") },
  "pir-alarm": { project: example("hal-pir-alarm") },
  "dht-logger": { project: example("hal-dht-capture") },
  "stepper-a4988": { project: example("hal-stepper-a4988") },
  "dc-motor": { project: example("hal-adc-servo") },
  "relay": { project: example("hal-relay") },
  // F. 고급
  "dma-neopixel": { project: example("hal-neopixel-dma") },
  "rtos-queue": {},
  "sleep-wfi": { project: example("lesson-sleep-wfi") },
  "scope-measure": { project: example("lesson-scope-mystery") },
  "debugger": { project: example("lesson-debug-average"), elf: elf("lesson-debug-average-fixed") },
  // G. 프로젝트
  "thermostat": { project: example("lesson-thermostat") },
  "parking-assist": { project: example("lesson-parking") },
  "digital-clock": { project: example("lesson-digital-clock") },
};

const panel = (page: Page) => page.getByRole("complementary", { name: "실습" });
const status = (page: Page) => page.getByTestId("run-status");
const checkByLabel = (page: Page, label: string) =>
  panel(page).getByTestId("lesson-check").filter({ hasText: label });

async function start(page: Page, l: Lesson) {
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
  await page.getByRole("button", { name: "📝 실습" }).click();
  await panel(page).locator(`[data-lesson="${l.id}"]`).getByRole("button", { name: "시작" }).click();
  await expect(panel(page).locator(".lesson-title")).toHaveText(l.title);
  if (typeof l.firmware === "object") await expect(status(page)).toContainText(l.firmware.example.replace(/\.elf$/, ""));
}

async function openProject(page: Page, path: string) {
  await page.getByTestId("project-input").setInputFiles(path);
}

async function grade(page: Page) {
  await panel(page).getByRole("button", { name: "채점", exact: true }).click();
  await expect(panel(page).getByTestId("grade-progress")).toBeVisible();
  await expect(panel(page).getByTestId("grade-progress")).toHaveCount(0, { timeout: 60_000 });
}

/** Load a lesson with the given circuit and firmware, and grade it. */
async function setUp(page: Page, l: Lesson, s: { project?: string; elf?: string }) {
  await start(page, l);
  if (s.project) {
    await openProject(page, s.project);
    await expect(page.locator(".lesson-check").first()).toBeVisible();
  }
  if (s.elf) {
    await page.getByTestId("elf-input").setInputFiles(s.elf);
    await expect(status(page)).toContainText(s.elf.replace(/^.*\//, ""));
  }
}

const failed = (page: Page) =>
  panel(page)
    .locator('[data-testid="lesson-check"][data-status="fail"]')
    .evaluateAll((l) => l.map((e) => e.textContent ?? ""));

test("the curriculum: at least 25 lessons in tracks, each with a reference solution", () => {
  expect(LESSONS.length).toBeGreaterThanOrEqual(25);
  const tracks = new Set(LESSONS.map((l) => l.track));
  expect([...tracks].sort()).toEqual(["A", "B", "C", "D", "E", "F", "G"].map((t) => [...tracks].find((x) => x?.startsWith(`${t}.`))).sort());
  for (const l of LESSONS) {
    const s = SOLUTIONS[l.id];
    expect(s, `${l.id} has a reference solution`).toBeTruthy();
    for (const f of [s.project, s.elf]) if (f) expect(existsSync(f), `${l.id}: ${f}`).toBe(true);
  }
});

for (const l of LESSONS) {
  test(`${l.track?.slice(0, 1)} ${l.id}: the reference solution passes every check`, async ({ page }) => {
    test.setTimeout(90_000);
    await setUp(page, l, SOLUTIONS[l.id] ?? {});
    // Wiring checks are live: all green before grading.
    expect(await failed(page)).toEqual([]);
    await grade(page);
    expect(await failed(page)).toEqual([]);
    await expect(panel(page).locator('[data-testid="lesson-check"][data-status="pending"]')).toHaveCount(0);
    await expect(panel(page).getByTestId("lesson-complete")).toBeVisible();
  });
}

// ------------------------------------------------- the checks discriminate

type Project = { parts: { id: string; kind: string }[]; wires: { a: { part: string; pin: string }; b: { part: string; pin: string } }[] };

/** A copy of a project file with `edit` applied, in a temporary folder. */
function variant(path: string, file: string, edit: (p: Project) => void): string {
  const p = JSON.parse(readFileSync(path, "utf8")) as Project;
  edit(p);
  const out = join(mkdtempSync(join(tmpdir(), "m32-")), `${file}.simucleo.json`);
  writeFileSync(out, JSON.stringify(p));
  return out;
}

/** Move the wire ends at `from` ('part.pin') to `to`. */
const rewire = (p: Project, from: string, to: string) => {
  const [tp, tq] = to.split(".");
  for (const w of p.wires) {
    for (const end of [w.a, w.b]) if (`${end.part}.${end.pin}` === from) Object.assign(end, { part: tp, pin: tq });
  }
};
/** Swap two pins' wires. */
const swap = (p: Project, x: string, y: string) => {
  rewire(p, x, "swap.tmp");
  rewire(p, y, x);
  rewire(p, "swap.tmp", y);
};
const unwire = (p: Project, end: string) => {
  p.wires = p.wires.filter((w) => `${w.a.part}.${w.a.pin}` !== end && `${w.b.part}.${w.b.pin}` !== end);
};

interface Wrong {
  lesson: string;
  what: string;
  /** The circuit and firmware to grade (none: the lesson's start circuit and firmware). */
  setup: () => { project?: string; elf?: string };
  /** Labels of the checks that must fail. */
  fails: string[];
}

const WRONG: Wrong[] = [
  {
    lesson: "led-on",
    what: "the LED the wrong way round",
    setup: () => ({ project: variant(example("lesson-led-on"), "reversed", (p) => swap(p, "led1.A", "led1.K")) }),
    fails: ["D7(PA8) → 저항 → LED → GND", "LED가 켜짐"],
  },
  {
    lesson: "button-poll",
    what: "the broken start circuit (button to 3V3, LED reversed)",
    setup: () => ({}),
    fails: ["D2(PA10) → 버튼 → GND", "D7(PA8) → 저항 → LED → GND", "콘솔에 'pressed' 두 번", "누르면 켜지고 떼면 꺼짐"],
  },
  {
    lesson: "timer-irq",
    what: "a HAL_Delay blinky instead of the timer interrupt firmware",
    setup: () => ({ project: example("lesson-timer-irq"), elf: "public/examples/hal-blinky.elf" }),
    fails: ["D7(PA8) 주기 100 ms ±1%", "메인 루프가 콘솔에 tick 출력"],
  },
  {
    lesson: "servo-angle",
    what: "a servo signal on D6 instead of D9",
    setup: () => ({ project: variant(example("hal-servos-multi"), "servo-d6", (p) => rewire(p, "nucleo.D9", "nucleo.D6")) }),
    fails: ["서보 SIG → D9(PC7)"],
  },
  {
    lesson: "tmp36",
    what: "the TMP36 output on A1 instead of A2",
    setup: () => ({
      project: variant(example("hal-adc-servo"), "tmp36-a1", (p) => {
        unwire(p, "r1.2");
        unwire(p, "ldr.1");
        rewire(p, "nucleo.A2", "nucleo.A1");
      }),
    }),
    fails: ["OUT → A2(PA4)", "TMP36 값이 40 °C 이상 변함", "50 °C 근처(46–54 °C)를 읽음"],
  },
  {
    lesson: "bluetooth-hc05",
    what: "TX and RX not crossed",
    setup: () => ({ project: variant(example("hal-bluetooth-led"), "bt-swapped", (p) => swap(p, "bt.RXD", "bt.TXD")) }),
    fails: ["모듈 RXD ← D8(PA9, TX)", "모듈 TXD → D2(PA10, RX)", "휴대폰 명령 수신", "휴대폰에 응답"],
  },
  {
    lesson: "relay",
    what: "the broken start circuit (module on 3V3, IN on D8)",
    setup: () => ({}),
    fails: ["릴레이 VCC → 5V", "릴레이 IN → D7(PA8)", "램프가 켜지고 꺼짐"],
  },
  {
    lesson: "debugger",
    what: "the firmware with the bug",
    setup: () => ({ project: example("lesson-debug-average") }),
    fails: ["avg가 3000 이상 변함", "avg가 2048을 넘어 LED on", "LED가 켜지고 꺼짐"],
  },
  {
    lesson: "scope-measure",
    what: "LED1 on the 1 kHz 75 % signal (D6) instead of the 2 kHz 25 % one",
    setup: () => ({ project: variant(example("lesson-scope-mystery"), "scope-d6", (p) => rewire(p, "nucleo.D5", "nucleo.D6")) }),
    fails: ["LED1: 2 kHz·25 % 신호의 핀"],
  },
  {
    lesson: "thermostat",
    what: "the relay input on D8",
    setup: () => ({ project: variant(example("lesson-thermostat"), "thermo-d8", (p) => rewire(p, "nucleo.D7", "nucleo.D8")) }),
    fails: ["IN → D7(PA8)", "램프가 켜졌다 꺼짐"],
  },
  {
    lesson: "parking-assist",
    what: "the yellow LED on D11 instead of D5",
    setup: () => ({ project: variant(example("lesson-parking"), "park-d11", (p) => rewire(p, "nucleo.D5", "nucleo.D11")) }),
    fails: ["노랑: D5(PB4)"],
  },
];

test("every track has a wrong setup that fails", () => {
  const tracks = new Set(WRONG.map((w) => LESSONS.find((l) => l.id === w.lesson)?.track?.slice(0, 1)));
  expect([...tracks].sort()).toEqual(["A", "B", "C", "D", "E", "F", "G"]);
});

for (const w of WRONG) {
  const l = LESSONS.find((x) => x.id === w.lesson)!;
  test(`${l.track?.slice(0, 1)} ${w.lesson} fails with ${w.what}`, async ({ page }) => {
    test.setTimeout(90_000);
    await setUp(page, l, w.setup());
    await grade(page);
    for (const label of w.fails) await expect(checkByLabel(page, label), label).toHaveAttribute("data-status", "fail");
    await expect(panel(page).getByTestId("lesson-complete")).toHaveCount(0);
  });
}

test("the scope lesson's hints do not give the answer away", async ({ page }) => {
  const l = LESSONS.find((x) => x.id === "scope-measure")!;
  await setUp(page, l, { project: variant(example("lesson-scope-mystery"), "scope-d9", (p) => rewire(p, "nucleo.D5", "nucleo.D9")) });
  const c = checkByLabel(page, "LED1: 2 kHz·25 % 신호의 핀");
  await expect(c).toHaveAttribute("data-status", "fail");
  await expect(c).toContainText("스코프로 주파수와 듀티를 다시 재 보세요");
  await expect(c).not.toContainText("PB4");
});

test("the lesson list groups the lessons by track, with time estimates; a lesson shows its concept boxes, hints, mistakes and challenges", async ({ page }) => {
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
  await page.getByRole("button", { name: "📝 실습" }).click();
  const tracks = panel(page).locator(".lesson-track");
  await expect(tracks).toHaveCount(7);
  await expect(tracks.first().locator("summary")).toContainText("A. 기초 (GPIO·시간)");
  await expect(tracks.first().locator("summary")).toContainText(`0/${LESSONS.filter((l) => l.track?.startsWith("A.")).length} 완료`);
  // In order: the first lesson of track A, the last of track G.
  await expect(tracks.first().locator("[data-lesson]").first()).toHaveAttribute("data-lesson", "led-on");
  await expect(tracks.last().locator("[data-lesson]").last()).toHaveAttribute("data-lesson", "digital-clock");
  await expect(panel(page).locator('[data-lesson="led-on"]')).toContainText("약 20분");
  // A track folds away.
  await tracks.first().locator("summary").click();
  await expect(panel(page).locator('[data-lesson="led-on"]')).toBeHidden();
  await tracks.first().locator("summary").click();

  await panel(page).locator('[data-lesson="button-poll"]').getByRole("button", { name: "시작" }).click();
  await expect(panel(page).locator(".lesson-intro")).toContainText("풀업(pull-up)");
  await expect(panel(page).locator(".lesson-intro")).toContainText("선수 학습");
  await expect(panel(page).locator(".lesson-theory").first()).toContainText("폴링");
  const hint = panel(page).locator(".lesson-hint").first();
  await expect(hint.locator("summary")).toHaveText("💡 힌트");
  await expect(hint).not.toHaveAttribute("open");
  await panel(page).locator(".lesson-mistakes summary").click();
  await expect(panel(page).locator(".lesson-mistakes")).toContainText("3V3에 연결");
  await expect(panel(page).locator(".lesson-challenges")).toContainText("에지 검출");
});
