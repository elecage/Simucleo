import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// M3: firmware driving parts on the breadboard, probes, project files.
// Uses the example firmware and projects bundled by `npm run examples`.

const status = (page: Page) => page.getByTestId("run-status");
const consoleOut = (page: Page) => page.getByTestId("console-output");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
});

async function loadExampleProject(page: Page, name: string) {
  await page.getByLabel("예제 펌웨어").selectOption(`${name}.elf`);
  await expect(status(page)).toContainText(name);
  await page.getByRole("button", { name: "▶ 실행" }).click();
}

/** Press a tact switch on the canvas for `ms`. */
async function pressSwitch(page: Page, id: string, ms = 150) {
  const cap = (await page.locator(`[data-id="${id}"] [data-action=press] circle`).boundingBox())!;
  await page.mouse.move(cap.x + cap.width / 2, cap.y + cap.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

const brightness = (page: Page, id: string) =>
  page.locator(`[data-id="${id}"] [data-brightness]`).evaluate((e) => Number((e as HTMLElement).dataset.brightness));

test("a wired button raises an EXTI interrupt that toggles an LED on the breadboard", async ({ page }) => {
  await loadExampleProject(page, "hal-button-exti");
  await expect(consoleOut(page)).toContainText("Press B1", { timeout: 5000 });
  expect(await brightness(page, "led1")).toBe(0);

  await pressSwitch(page, "sw1");
  await expect(consoleOut(page)).toContainText("D2 pressed (1)", { timeout: 3000 });
  await expect.poll(() => brightness(page, "led1")).toBeGreaterThan(0.8);
  await pressSwitch(page, "sw1");
  await expect(consoleOut(page)).toContainText("D2 pressed (2)", { timeout: 3000 });
  await expect.poll(() => brightness(page, "led1")).toBe(0);
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);
});

test("PWM sets LED brightness and RGB colour", async ({ page }) => {
  await loadExampleProject(page, "hal-pwm-led");
  await page.waitForTimeout(500);
  // The RGB LED cycles through colours and LD2 breathes: sample both.
  const rgb = new Set<string>();
  const ld2 = new Set<number>();
  for (let i = 0; i < 20; i++) {
    rgb.add(await page.locator("[data-id=rgb1] [data-rgb]").evaluate((e) => (e as HTMLElement).dataset.rgb!));
    ld2.add(
      await page.locator("[data-led=LD2]").evaluate((e) => Math.round(Number(getComputedStyle(e).opacity) * 10)),
    );
    await page.waitForTimeout(100);
  }
  expect(rgb.size).toBeGreaterThan(5);
  // Intermediate brightness levels, not just on/off.
  expect([...ld2].filter((v) => v > 0 && v < 10).length).toBeGreaterThan(2);
});

test("the probe measures the buzzer's tone", async ({ page }) => {
  await loadExampleProject(page, "hal-buzzer-melody");
  await expect(consoleOut(page)).toContainText("C4 D4", { timeout: 5000 });
  await page.getByRole("button", { name: "파형 (프로브)" }).click();
  await page.getByLabel("프로브 핀 추가").selectOption("PA9");
  // Probes survive loading firmware again.
  page.once("dialog", (d) => d.accept()); // "replace the wiring?"
  await page.getByLabel("예제 펌웨어").selectOption("hal-buzzer-melody.elf");
  await page.getByRole("button", { name: "▶ 실행" }).click();
  // The scale runs 262 … 523 Hz; at some point the probe reads a note.
  await expect(page.getByTestId("probe-PA9")).toContainText(/\d{3}\.\d Hz · (4|5)\d% H/, { timeout: 5000 });
  await expect(page.locator("[data-id=bz1] [data-sounding='1']")).toBeVisible();
});

test("an LED without a resistor breaks the electrical rules", async ({ page }) => {
  const project = {
    format: "simucleo-project",
    version: 1,
    name: "no resistor",
    parts: [
      { id: "nucleo", kind: "nucleo-f401re", x: 4, y: 2, props: {} },
      { id: "led1", kind: "led-5mm", x: 46, y: 9, props: { color: "red" } },
    ],
    wires: [
      { id: "w1", a: { part: "nucleo", pin: "D13" }, b: { part: "led1", pin: "A" }, color: "#e53935" },
      { id: "w2", a: { part: "led1", pin: "K" }, b: { part: "nucleo", pin: "GND_D" }, color: "#212121" },
    ],
    firmware: { name: "hal-blinky", example: "hal-blinky.elf" },
  };
  await page.getByTestId("project-input").setInputFiles({
    name: "bad.simucleo.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(project)),
  });
  await expect(status(page)).toContainText("hal-blinky");
  await page.getByRole("button", { name: "▶ 실행" }).click();
  await expect(page.getByTestId("circuit-warning").filter({ hasText: "led1" })).toContainText(
    "add a series resistor",
    { timeout: 5000 },
  );
  await expect(page.getByTestId("circuit-warning").filter({ hasText: "PA5: output high" })).toHaveCount(1);
  await expect(page.locator("[data-id=led1] [data-overcurrent]")).toBeVisible();
});

test("projects save, reopen and survive a reload", async ({ page }) => {
  await loadExampleProject(page, "hal-button-exti");
  await page.getByRole("button", { name: "⏸ 일시정지" }).click();
  // ASCII: headless Chromium in a C locale replaces non-ASCII file names.
  await page.getByLabel("프로젝트 이름").fill("my circuit");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("my_circuit.simucleo.json");
  const saved = JSON.parse(readFileSync((await file.path())!, "utf8"));
  expect(saved.format).toBe("simucleo-project");
  expect(saved.parts.map((p: { id: string }) => p.id)).toEqual(["nucleo", "bb1", "led1", "r1", "sw1"]);
  expect(saved.firmware.example).toBe("hal-button-exti.elf");
  expect(saved.firmware.data.length).toBeGreaterThan(1000); // ELF embedded

  // New project, then open the saved file again.
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "새로" }).click();
  await expect(page.locator("[data-id=sw1]")).toHaveCount(0);
  await page.getByTestId("project-input").setInputFiles((await file.path())!);
  await expect(page.locator("[data-id=sw1]")).toHaveCount(1);
  await expect(page.getByLabel("프로젝트 이름")).toHaveValue("my circuit");

  // Autosave: a reload brings back the circuit and the firmware.
  await page.waitForTimeout(800);
  await page.reload();
  await expect(page.locator("[data-id=sw1]")).toHaveCount(1);
  await expect(status(page)).toContainText("hal-button-exti");

  const svg = page.waitForEvent("download");
  await page.getByRole("button", { name: "SVG" }).click();
  const svgText = readFileSync((await (await svg).path())!, "utf8");
  expect(svgText).toContain("<svg");
  expect(svgText).toContain('data-id="sw1"');
});
