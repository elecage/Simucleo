import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// M23: TIM1 complementary outputs with dead time driving the 3-phase
// bridge by PWM — the pot sets the duty and so the BLDC's speed, B1 breaks
// (EGR.BG), and the oscilloscope shows the dead time between CH1 (PA8)
// and CH1N (PA7). Uses the example firmware and project bundled by
// `npm run examples`.

const status = (page: Page) => page.getByTestId("run-status");
const consoleOut = (page: Page) => page.getByTestId("console-output");
const plot = (page: Page) => page.getByTestId("scope-plot");
const CYCLE_NS = 1e9 / 84e6;
const MOT = "[data-id=mot] [data-halls]";
const BR = "[data-id=br] [data-duty]";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
});

async function loadExampleProject(page: Page, name: string) {
  await page.getByLabel("예제 펌웨어").selectOption(`${name}.elf`);
  await expect(status(page)).toContainText(name);
  await page.getByRole("button", { name: "▶ 실행" }).click();
}

const num = async (page: Page, selector: string, name: string) => Number(await page.locator(selector).first().getAttribute(name));

async function pressB1(page: Page) {
  const b = (await page.locator("[data-action=b1]").first().boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.up();
}

/** The bridge's duty bars: INH A–C, then INL A–C. */
async function duties(page: Page): Promise<number[]> {
  const d = (await page.locator(BR).first().getAttribute("data-duty")) ?? "";
  return d ? d.split(",").map(Number) : [];
}

test("BLDC on TIM1 PWM: the pot sets the speed, B1 breaks and the motor coasts", async ({ page }) => {
  test.setTimeout(90000);
  await loadExampleProject(page, "hal-bldc-pwm");
  await expect(consoleOut(page)).toContainText("dead time 500 ns", { timeout: 8000 });
  // Pot in the middle: half the duty, about half the speed.
  await expect(consoleOut(page)).toContainText(/run {3}duty {2}49 % {2}rpm 1\d{3}/, { timeout: 15000 });
  await expect.poll(async () => num(page, MOT, "data-rpm"), { timeout: 10000 }).toBeGreaterThan(1200);
  const half = await num(page, MOT, "data-rpm");
  expect(half).toBeLessThan(2100);
  // Every switch chops in its sectors: all six bars show some duty.
  await expect.poll(async () => (await duties(page)).filter((d) => d > 0.05).length, { timeout: 5000 }).toBe(6);
  await expect(page.locator(BR)).toHaveAttribute("data-shoot", "0");
  await expect(page.locator("[data-id=br] [data-shoot-warning]")).toHaveCount(0);
  await page.locator(".canvas-wrap").screenshot({ path: "test-results/m23-bldc-pwm.png" });
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);

  // Turn the pot towards 3V3: 90 % duty, faster.
  await page.locator("[data-id=pot]").first().click({ force: true });
  await page.getByLabel("position").fill("0.1");
  await expect(consoleOut(page)).toContainText(/duty {2}(89|90) %/, { timeout: 10000 });
  await expect.poll(async () => num(page, MOT, "data-rpm"), { timeout: 15000 }).toBeGreaterThan(half * 1.5);

  // B1: software break — BIF, MOE off, the outputs idle, it runs down.
  await pressB1(page);
  await expect(consoleOut(page)).toContainText("break: BIF set, MOE off - outputs idle, the motor coasts", { timeout: 8000 });
  await expect.poll(async () => Math.max(...(await duties(page))), { timeout: 5000 }).toBe(0);
  const fast = await num(page, MOT, "data-rpm");
  await expect.poll(async () => num(page, MOT, "data-rpm"), { timeout: 15000 }).toBeLessThan(fast * 0.5);
  await expect(consoleOut(page)).toContainText("break duty", { timeout: 5000 });
  // B1 again: MOE on, driving again.
  await pressB1(page);
  await expect(consoleOut(page)).toContainText("resumed: MOE on", { timeout: 8000 });
  await expect.poll(async () => num(page, MOT, "data-rpm"), { timeout: 15000 }).toBeGreaterThan(half * 1.5);
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);
});

test("the oscilloscope shows 500 ns of dead time between CH1 (PA8) falling and CH1N (PA7) rising", async ({ page }) => {
  test.setTimeout(60000);
  await loadExampleProject(page, "hal-bldc-pwm");
  await expect(consoleOut(page)).toContainText("rpm", { timeout: 10000 });
  await page.getByRole("button", { name: "파형 (프로브)" }).click();
  await page.getByLabel("프로브 핀 추가").selectOption("PA8");
  await page.getByLabel("프로브 핀 추가").selectOption("PA7");
  await page.getByRole("button", { name: "PA5 제거" }).click();
  await page.getByLabel("트리거 소스").selectOption("PA8");
  await page.getByLabel("트리거 에지").selectOption("falling");
  await page.getByLabel("시간/눈금").selectOption({ label: "1 µs/div" });
  await page.getByLabel("트리거 위치").fill("20");
  await page.getByLabel("트리거 모드").selectOption("single");
  await expect(plot(page)).toHaveAttribute("data-view", "capture", { timeout: 10000 });
  await expect(page.getByTestId("scope-state")).toHaveAttribute("data-state", "stopped");
  // Both traces are drawn: CH1 falls at the trigger, CH1N rises later.
  await expect(page.locator("[data-trace=PA8] polyline")).toHaveAttribute("points", /\d/);
  await expect(page.locator("[data-trace=PA7] polyline")).toHaveAttribute("points", /\d/);
  await page.locator(".waveform").screenshot({ path: "test-results/m23-deadtime.png" });

  // Measure it on the exported capture: the gap, to the CPU cycle.
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV 내보내기" }).click();
  const csv = readFileSync((await (await dl).path())!, "utf8").trim().split("\n");
  expect(csv[0]).toBe("time_ns,PA8,PA7");
  const rows = csv.slice(1).map((r) => r.split(",").map(Number));
  // Before the trigger CH1 is on and CH1N off; never both on.
  const first = rows[0];
  expect(first[1]).toBe(1);
  expect(first[2]).toBe(0);
  for (const r of rows) expect(r[1] + r[2]).toBeLessThan(2);
  const fall = rows.find((r) => r[0] >= 0 && r[1] === 0)!;
  expect(fall[0]).toBe(0);
  const rise = rows.find((r) => r[0] > 0 && r[2] === 1)!;
  const dead = rise[0] - fall[0];
  expect(dead).toBeGreaterThan(0);
  expect(Math.abs(dead - 42 * CYCLE_NS)).toBeLessThanOrEqual(CYCLE_NS);
  // Both off in between.
  expect(rows.filter((r) => r[0] > 0 && r[0] < rise[0]).every((r) => r[1] === 0 && r[2] === 0)).toBe(true);
});
