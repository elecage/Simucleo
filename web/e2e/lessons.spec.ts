import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// Guided exercises (M16): wiring checks follow the circuit live, "채점"
// runs the firmware and judges what it did. Uses the example firmware
// bundled by `npm run examples` and firmware/lesson-blink-2hz.

const SOLUTION_ELF = "../firmware/lesson-blink-2hz/build/lesson-blink-2hz.elf";

const status = (page: Page) => page.getByTestId("run-status");
const panel = (page: Page) => page.getByRole("complementary", { name: "실습" });
const check = (page: Page, key: string) => panel(page).locator(`[data-check="${key}"]`);

async function pin(page: Page, part: string, id: string) {
  const box = await page.locator(`[data-pins="${part}"] [data-pin="${id}"]`).boundingBox();
  if (!box) throw new Error(`pin ${part}.${id} not found`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function partId(page: Page, prefix: string) {
  const ids = await page.locator("[data-id]").evaluateAll((l) => l.map((g) => (g as HTMLElement).dataset.id!));
  return ids.find((i) => i.startsWith(prefix))!;
}

async function startLesson(page: Page, id: string) {
  await page.getByRole("button", { name: "📝 실습" }).click();
  await panel(page).locator(`[data-lesson="${id}"]`).getByRole("button", { name: "시작" }).click();
  await expect(panel(page).locator(".lesson-title")).toBeVisible();
}

async function openProject(page: Page, project: object) {
  await page.getByTestId("project-input").setInputFiles({
    name: "p.simucleo.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ format: "simucleo-project", version: 1, ...project })),
  });
}

async function grade(page: Page) {
  await panel(page).getByRole("button", { name: "채점", exact: true }).click();
  await expect(panel(page).getByTestId("grade-progress")).toBeVisible();
  await expect(panel(page).getByTestId("grade-progress")).toHaveCount(0, { timeout: 30_000 });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
});

test("lesson 1: wiring on the canvas turns the checks green, grading completes it, results export", async ({ page }) => {
  await startLesson(page, "led-blink");
  await expect(status(page)).toContainText("hal-blinky");
  await expect(check(page, "0.0")).toHaveAttribute("data-status", "fail");
  await expect(check(page, "0.0")).toContainText("LED가 없습니다");
  // Behaviour checks wait for "채점".
  await expect(check(page, "2.1")).toHaveAttribute("data-status", "pending");
  await expect(panel(page).locator(".lesson-step.current")).toHaveAttribute("data-step", "0");

  await page.getByRole("button", { name: "LED 5mm" }).click();
  await page.getByRole("button", { name: "저항", exact: true }).click();
  await expect(check(page, "0.0")).toHaveAttribute("data-status", "pass");
  await expect(check(page, "0.1")).toHaveAttribute("data-status", "pass");
  await expect(panel(page).locator(".lesson-step.current")).toHaveAttribute("data-step", "1");

  // Same moves as the editor test: plug both parts into the breadboard,
  // then D13 → resistor, LED cathode → GND.
  const led = await partId(page, "led");
  const res = await partId(page, "resistor");
  const drag = async (part: string, pinId: string, target: { x: number; y: number }) => {
    const body = await page.locator(`[data-id="${part}"] :is(.resistor-body, .led-body)`).first().boundingBox();
    const from = await pin(page, part, pinId);
    const bx = body!.x + body!.width / 2;
    const by = body!.y + body!.height / 2;
    await page.mouse.move(bx, by);
    await page.mouse.down();
    await page.mouse.move(bx + target.x - from.x, by + target.y - from.y, { steps: 8 });
    await page.mouse.up();
  };
  const wire = async (a: [string, string], b: [string, string]) => {
    const p = await pin(page, ...a);
    const q = await pin(page, ...b);
    await page.mouse.click(p.x, p.y);
    await page.mouse.click(q.x, q.y);
  };
  await drag(led, "K", await pin(page, "bb1", "e12"));
  await drag(res, "1", await pin(page, "bb1", "c9"));
  await wire(["nucleo", "D13"], ["bb1", "a9"]);
  await expect(check(page, "1.0")).toContainText("LED가 이어진 길이 없습니다");
  await wire(["nucleo", "GND_P1"], ["bb1", "tn1"]);
  await wire(["bb1", "tn11"], ["bb1", "a12"]);
  await expect(check(page, "1.0")).toHaveAttribute("data-status", "pass");
  await expect(panel(page).locator(".lesson-step.current")).toHaveAttribute("data-step", "2");
  await expect(panel(page).getByTestId("lesson-complete")).toHaveCount(0);

  await grade(page);
  for (const key of ["2.0", "2.1", "2.2", "2.3"]) await expect(check(page, key)).toHaveAttribute("data-status", "pass");
  await expect(check(page, "2.1")).toContainText(/측정 주기 100\d ms/);
  await expect(panel(page).getByTestId("lesson-complete")).toContainText("실습 완료");

  // A reload with the lesson open brings it back, results and all.
  await page.waitForTimeout(800);
  await page.reload();
  await expect(panel(page).getByTestId("lesson-complete")).toBeVisible();
  await expect(check(page, "2.1")).toHaveAttribute("data-status", "pass");
  await expect(check(page, "1.0")).toHaveAttribute("data-status", "pass");

  // The list marks it done; the results file has the student, lesson and checks.
  await panel(page).getByRole("button", { name: "← 목록" }).click();
  await expect(panel(page).locator('[data-lesson="led-blink"]')).toContainText("✅");
  await panel(page).getByLabel("학생 이름").fill("kim 01");
  const csvDownload = page.waitForEvent("download");
  await panel(page).getByRole("button", { name: "결과 내보내기 (CSV)" }).click();
  const csvFile = await csvDownload;
  expect(csvFile.suggestedFilename()).toBe("lesson-results_kim_01.csv");
  const csv = readFileSync((await csvFile.path())!, "utf8");
  expect(csv).toContain("student,lesson_id,lesson_title,completed_at");
  expect(csv).toMatch(/kim 01,led-blink,LED 깜빡이 배선,20\d\d-.*,1,3,PA5 주기 1000 ms ±5%,pass,/);
  expect(csv.split("\r\n").filter((l) => l.includes(",led-blink,")).length).toBe(7);

  const jsonDownload = page.waitForEvent("download");
  await panel(page).getByRole("button", { name: "JSON", exact: true }).click();
  const results = JSON.parse(readFileSync((await (await jsonDownload).path())!, "utf8"));
  expect(results.format).toBe("simucleo-lesson-results");
  expect(results.student).toBe("kim 01");
  expect(results.lessons[0]).toMatchObject({ id: "led-blink", passed: 7, total: 7, attempts: 1 });
  expect(results.lessons[0].completedAt).toBeTruthy();

  // Progress survives a reload.
  await page.waitForTimeout(800);
  await page.reload();
  await expect(panel(page)).toHaveCount(0); // no lesson open: the panel stays closed
  await page.getByRole("button", { name: "📝 실습" }).click();
  await expect(panel(page).locator('[data-lesson="led-blink"]')).toContainText("✅");
  await expect(panel(page).getByLabel("학생 이름")).toHaveValue("kim 01");
});

test("lesson 1: a missing resistor and the wrong pin get the right hints", async ({ page }) => {
  await startLesson(page, "led-blink");
  const board = { id: "nucleo", kind: "nucleo-f401re", x: 4, y: 2, props: {} };
  const led = { id: "myLed", kind: "led-5mm", x: 46, y: 9, props: { color: "red" } };
  const res = { id: "R7", kind: "resistor", x: 46, y: 20, props: { ohms: "220" } };
  await openProject(page, {
    parts: [board, led, res],
    wires: [
      { id: "w1", a: { part: "nucleo", pin: "D13" }, b: { part: "myLed", pin: "A" } },
      { id: "w2", a: { part: "myLed", pin: "K" }, b: { part: "nucleo", pin: "GND_D" } },
    ],
  });
  await expect(check(page, "0.0")).toHaveAttribute("data-status", "pass");
  await expect(check(page, "1.0")).toHaveAttribute("data-status", "fail");
  await expect(check(page, "1.0").locator(".check-hint")).toHaveText("PA5가 GND로 가는 길에 저항이 없습니다.");

  await openProject(page, {
    parts: [board, led, res],
    wires: [
      { id: "w1", a: { part: "nucleo", pin: "D12" }, b: { part: "R7", pin: "1" } },
      { id: "w2", a: { part: "R7", pin: "2" }, b: { part: "myLed", pin: "A" } },
      { id: "w3", a: { part: "myLed", pin: "K" }, b: { part: "nucleo", pin: "GND_D" } },
    ],
  });
  await expect(check(page, "1.0").locator(".check-hint")).toHaveText(
    "저항과 LED가 PA6 (D12)에 연결되어 있습니다. PA5 (D13)에 연결하세요.",
  );

  // Graded on the wrong pin, the LED never lights.
  await grade(page);
  await expect(check(page, "2.1")).toHaveAttribute("data-status", "pass"); // PA5 (LD2) still blinks
  await expect(check(page, "2.2")).toHaveAttribute("data-status", "fail");
  await expect(check(page, "2.2").locator(".check-hint")).toContainText("LED가 한 번도 켜지지 않았습니다");
  await expect(panel(page).getByTestId("lesson-complete")).toHaveCount(0);
});

test("upload-your-own lesson: hal-blinky gets the period hint, the 2 Hz solution passes", async ({ page }) => {
  await startLesson(page, "blink-2hz");
  await expect(panel(page)).toContainText("HAL_Delay(250);");
  await expect(panel(page).locator(".lesson-code")).toBeVisible();
  await panel(page).getByRole("button", { name: "채점", exact: true }).click();
  await expect(panel(page).getByRole("alert")).toContainText("ELF 업로드");

  await page.getByTestId("elf-input").setInputFiles("public/examples/hal-blinky.elf");
  await expect(status(page)).toContainText("hal-blinky.elf");
  await grade(page);
  await expect(check(page, "1.0")).toHaveAttribute("data-status", "pass");
  await expect(check(page, "1.1")).toHaveAttribute("data-status", "fail");
  await expect(check(page, "1.1").locator(".check-hint")).toHaveText(/^깜빡임 주기가 100\d ms입니다\. 목표는 500 ms \(±5%\)입니다\.$/);
  await expect(panel(page).getByTestId("lesson-complete")).toHaveCount(0);

  await page.getByTestId("elf-input").setInputFiles(SOLUTION_ELF);
  await expect(status(page)).toContainText("lesson-blink-2hz.elf");
  await grade(page);
  await expect(check(page, "1.1")).toHaveAttribute("data-status", "pass");
  await expect(check(page, "1.1")).toContainText(/측정 주기 50\d ms \(1\.99 Hz\)/);
  await expect(panel(page).getByTestId("lesson-complete")).toBeVisible();
});

// The other lessons, wired as their examples are: everything passes.
for (const [lesson, example] of [
  ["button-exti", "hal-button-exti"],
  ["pwm-rgb", "hal-pwm-led"],
  ["adc-servo", "hal-adc-servo"],
  ["i2c-oled", "hal-i2c-oled"],
]) {
  test(`lesson ${lesson} passes with the wiring of ${example}`, async ({ page }) => {
    await startLesson(page, lesson);
    await expect(status(page)).toContainText(example);
    await page.getByTestId("project-input").setInputFiles(`public/examples/${example}.simucleo.json`);
    // Every wiring check is green before running.
    await expect(panel(page).locator('[data-status="fail"]')).toHaveCount(0);
    await grade(page);
    const failed = await panel(page).locator('[data-status="fail"]').allTextContents();
    expect(failed).toEqual([]);
    await expect(panel(page).getByTestId("lesson-complete")).toBeVisible();
  });
}

test("starting a lesson over unsaved work asks first and keeps a backup", async ({ page }) => {
  await page.getByRole("button", { name: "LED 5mm" }).click();
  await page.getByRole("button", { name: "📝 실습" }).click();
  let message = "";
  page.once("dialog", (d) => {
    message = d.message();
    void d.dismiss();
  });
  await panel(page).locator('[data-lesson="led-blink"]').getByRole("button", { name: "시작" }).click();
  await expect.poll(() => message).toContain("백업");
  await expect(page.locator("[data-id^=led]")).toHaveCount(1); // cancelled: nothing replaced

  page.once("dialog", (d) => void d.accept());
  await panel(page).locator('[data-lesson="led-blink"]').getByRole("button", { name: "시작" }).click();
  await expect(page.locator("[data-id^=led]")).toHaveCount(0);
  await panel(page).getByRole("button", { name: "← 목록" }).click();
  page.once("dialog", (d) => void d.accept());
  await panel(page).getByRole("button", { name: "실습 전 프로젝트 되돌리기" }).click();
  await expect(page.locator("[data-id^=led]")).toHaveCount(1);
});

test("button presses keep their length when grading at full speed", async ({ page }) => {
  await startLesson(page, "button-exti");
  await expect(status(page)).toContainText("hal-button-exti");
  await page.getByTestId("project-input").setInputFiles("public/examples/hal-button-exti.simucleo.json");
  // At "최대" a frame could hold both the press and the release: the
  // firmware would never see the button down.
  await page.getByLabel("실행 속도").selectOption("최대");
  await grade(page);
  expect(await panel(page).locator('[data-status="fail"]').allTextContents()).toEqual([]);
  await expect(panel(page).getByTestId("lesson-complete")).toBeVisible();
});

test("stopping grading during a button press lets the button go", async ({ page }) => {
  await startLesson(page, "button-exti");
  await expect(status(page)).toContainText("hal-button-exti");
  await page.getByTestId("project-input").setInputFiles("public/examples/hal-button-exti.simucleo.json");
  await panel(page).getByRole("button", { name: "채점", exact: true }).click();
  // Stop while the first automatic press (500–650 ms) is held down.
  await page.waitForFunction(() => {
    const p = document.querySelector<HTMLProgressElement>("[data-testid=grade-progress]");
    if (!p || p.value < 540 || p.value > 620) return false;
    [...document.querySelectorAll("button")].find((b) => b.textContent === "중지")!.click();
    return true;
  }, undefined, { polling: 5, timeout: 20_000 });
  await expect(panel(page).getByTestId("grade-progress")).toHaveCount(0);
  await expect(page.getByTestId("console-output")).toContainText("D2 pressed (1)");
  // A press by hand now reaches the firmware: the switch was released.
  await page.getByRole("button", { name: "▶ 실행" }).click();
  const sw = await partId(page, "sw");
  const cap = (await page.locator(`[data-id="${sw}"] [data-action=press] circle`).first().boundingBox())!;
  await page.mouse.move(cap.x + cap.width / 2, cap.y + cap.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.up();
  await expect(page.getByTestId("console-output")).toContainText("D2 pressed (2)", { timeout: 5000 });
});
