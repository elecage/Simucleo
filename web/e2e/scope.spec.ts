import { expect, test, type Page } from "@playwright/test";

// M20: the waveform view's oscilloscope trigger — captures taken edge by
// edge in the simulator, so short pulses are shown and measured exactly.
// Uses the example firmware and projects bundled by `npm run examples`.

const status = (page: Page) => page.getByTestId("run-status");
const consoleOut = (page: Page) => page.getByTestId("console-output");
const plot = (page: Page) => page.getByTestId("scope-plot");
const CYCLE_NS = 1e9 / 84e6;

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
});

async function loadExampleProject(page: Page, name: string) {
  await page.getByLabel("예제 펌웨어").selectOption(`${name}.elf`);
  await expect(status(page)).toContainText(name);
  await page.getByRole("button", { name: "▶ 실행" }).click();
}

/** Open the waveform view probing only `pin`, the trigger source. */
async function probeOnly(page: Page, pin: string) {
  await page.getByRole("button", { name: "파형 (프로브)" }).click();
  await page.getByLabel("프로브 핀 추가").selectOption(pin);
  await page.getByLabel("트리거 소스").selectOption(pin);
  await page.getByRole("button", { name: "PA5 제거" }).click();
}

const num = async (page: Page, id: string, attr: string) =>
  Number(await page.getByTestId(id).getAttribute(attr));

test("a servo pulse is captured on its rising edge, measured, and Single holds it", async ({ page }) => {
  await loadExampleProject(page, "hal-adc-servo");
  // The width the firmware sets: "… servo 1499 us …" (pot at mid-travel).
  await expect(consoleOut(page)).toContainText(/servo +\d+ us/, { timeout: 5000 });
  const text = await consoleOut(page).textContent();
  const us = Number([...text!.matchAll(/servo +(\d+) us/g)].pop()![1]);
  expect(us).toBeGreaterThan(1300);
  expect(us).toBeLessThan(1700);

  await probeOnly(page, "PC7");
  await page.getByLabel("시간/눈금").selectOption({ label: "500 µs/div" });
  await page.getByLabel("트리거 위치").fill("10");
  await page.getByLabel("트리거 모드").selectOption("single");
  await expect(plot(page)).toHaveAttribute("data-view", "capture", { timeout: 5000 });
  await expect(page.getByTestId("scope-state")).toHaveAttribute("data-state", "stopped");

  // One high pulse of the width set, to the CPU cycle (timer ticks are 1 µs).
  await expect(page.getByTestId("scope-high")).toContainText("1개");
  const high = await num(page, "scope-high", "data-last");
  expect(Math.abs(high - us * 1000)).toBeLessThanOrEqual(1000 + CYCLE_NS);
  // The window: 0.5 ms before the trigger, 4.5 ms after.
  expect(await num(page, "scope-plot", "data-view-start")).toBe(-500e3);
  expect(await num(page, "scope-plot", "data-view-span")).toBe(5e6);

  // Single: the capture does not change while the firmware runs on.
  const seq = await plot(page).getAttribute("data-seq");
  const time0 = await status(page).textContent();
  await page.waitForTimeout(800);
  expect(await status(page).textContent()).not.toBe(time0); // still running
  await expect(plot(page)).toHaveAttribute("data-seq", seq!);
  expect(await num(page, "scope-high", "data-last")).toBe(high);

  // Arm again: a new capture.
  await page.getByRole("button", { name: "다시 대기 (Arm)" }).click();
  await expect(plot(page)).not.toHaveAttribute("data-seq", seq!, { timeout: 5000 });
  await expect(page.getByTestId("scope-state")).toHaveAttribute("data-state", "stopped");

  // Wheel zoom over the frozen capture, then back to the whole window.
  const box = (await plot(page).boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.mouse.wheel(0, -300);
  await expect.poll(() => num(page, "scope-plot", "data-view-span")).toBeLessThan(5e6);
  await page.getByRole("button", { name: "전체 보기" }).click();
  expect(await num(page, "scope-plot", "data-view-span")).toBe(5e6);

  // Two cursors: Δt between them, and its inverse.
  await page.getByLabel("커서").check();
  expect(await num(page, "cursor-dt", "data-ns")).toBe(2.5e6);
  await expect(page.getByTestId("cursor-freq")).toContainText("400 Hz");
});

test("pause on trigger stops the run right after the capture", async ({ page }) => {
  await loadExampleProject(page, "hal-adc-servo");
  await expect(consoleOut(page)).toContainText(/servo +\d+ us/, { timeout: 5000 });
  await probeOnly(page, "PC7");
  await page.getByLabel("시간/눈금").selectOption({ label: "500 µs/div" });
  await page.getByLabel("트리거 모드").selectOption("normal");
  await page.getByLabel("트리거 시 일시정지").check();
  // The run pauses by itself.
  await expect(page.getByRole("button", { name: "▶ 실행" })).toBeVisible({ timeout: 5000 });
  await expect(plot(page)).toHaveAttribute("data-view", "capture");
  const seq = await plot(page).getAttribute("data-seq");
  const time0 = await status(page).textContent();
  await page.waitForTimeout(500);
  expect(await status(page).textContent()).toBe(time0);
  // Running again stops at the next capture (Normal re-arms).
  await page.getByRole("button", { name: "▶ 실행" }).click();
  await expect(plot(page)).not.toHaveAttribute("data-seq", seq!, { timeout: 5000 });
  await expect(page.getByRole("button", { name: "▶ 실행" })).toBeVisible();
});

test("NeoPixel bits of 0.4 and 0.8 µs are visible at 1 µs/div", async ({ page }) => {
  await loadExampleProject(page, "hal-neopixel-dma");
  await probeOnly(page, "PB4");
  await page.getByLabel("시간/눈금").selectOption({ label: "1 µs/div" });
  // The end of a frame: the falling edge that starts the long low latch
  // gap (a low pulse wider than 40 µs), with 90% of the window before it.
  await page.getByLabel("트리거 에지").selectOption("falling");
  await page.getByLabel("펄스 폭 조건").selectOption("gt");
  await page.getByLabel("펄스 폭 (µs)").fill("40");
  await page.getByLabel("트리거 위치").fill("90");
  await page.getByLabel("트리거 모드").selectOption("single");
  await expect(plot(page)).toHaveAttribute("data-view", "capture", { timeout: 5000 });
  expect(await num(page, "scope-plot", "data-view-start")).toBe(-9000);
  // 800 kHz: one bit every 1.25 µs (105 timer ticks); a 0 is 34 ticks
  // high, a 1 is 67.
  const period = await num(page, "scope-period", "data-ns");
  expect(Math.abs(period - 105 * CYCLE_NS)).toBeLessThan(CYCLE_NS);
  for (const attr of ["data-min", "data-max"]) {
    const w = await num(page, "scope-high", attr);
    expect(Math.min(Math.abs(w - 34 * CYCLE_NS), Math.abs(w - 67 * CYCLE_NS))).toBeLessThanOrEqual(CYCLE_NS);
  }
  // Every bit is drawn: 7 whole pulses before the trigger, a rise and a
  // fall each.
  await expect(page.getByTestId("scope-high")).toContainText("7개");
  const points = (await page.locator("[data-trace=PB4] polyline").getAttribute("points"))!.split(" ").length;
  expect(points).toBeGreaterThanOrEqual(2 + 7 * 4);

  // A positive pulse wider than 0.6 µs: a 1 bit, at t = 0.
  await page.getByLabel("트리거 에지").selectOption("rising");
  await page.getByLabel("펄스 폭 (µs)").fill("0.6");
  await page.getByLabel("트리거 위치").fill("10");
  // New settings drop the old capture and wait for one taken with them.
  await expect(plot(page)).toHaveAttribute("data-view", "capture", { timeout: 5000 });
  expect(await num(page, "scope-plot", "data-view-start")).toBe(-1000);
  const wide = await num(page, "scope-high", "data-max");
  expect(Math.abs(wide - 67 * CYCLE_NS)).toBeLessThanOrEqual(CYCLE_NS);
});

test("without a trigger the view waits, Auto rolls, an unprobed source is flagged", async ({ page }) => {
  await loadExampleProject(page, "hal-blinky");
  await page.getByRole("button", { name: "파형 (프로브)" }).click();
  // LD2 (PA5) toggles every 500 ms: at 20 µs/div most windows have no edge.
  await page.getByLabel("시간/눈금").selectOption({ label: "20 µs/div" });
  await page.getByLabel("트리거 모드").selectOption("normal");
  await page.getByLabel("트리거 에지").selectOption("falling");
  await expect(page.getByTestId("scope-state")).toContainText("트리거 대기 중…");
  // Auto shows the live trace meanwhile.
  await page.getByLabel("트리거 모드").selectOption("auto");
  await expect(plot(page)).toHaveAttribute("data-view", /live|capture/);
  // Normal: an edge comes within a second and is held.
  await page.getByLabel("트리거 모드").selectOption("normal");
  await expect(plot(page)).toHaveAttribute("data-view", "capture", { timeout: 3000 });
  // Both levels drawn (rows: high at y = 20, low at y = 42). The view can
  // switch to the capture a render before its trace is drawn: wait for it.
  const trace = page.locator("[data-trace=PA5] polyline");
  await expect(trace).toHaveAttribute("points", /,20\b/);
  await expect(trace).toHaveAttribute("points", /,42\b/);
  // The source pin removed from the probes.
  await page.getByLabel("프로브 핀 추가").selectOption("PA6");
  await page.getByRole("button", { name: "PA5 제거" }).click();
  await expect(page.getByTestId("scope-state")).toContainText("프로브되지 않았습니다");
});
