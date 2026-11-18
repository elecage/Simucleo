import { expect, test, type Page } from "@playwright/test";

// M8: 7-segment + keypad, encoder → stepper + LCD, sonar + DS18B20.

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

async function click(page: Page, selector: string) {
  const el = page.locator(selector);
  await el.dispatchEvent("pointerdown", { bubbles: true });
  await page.waitForTimeout(120);
  await el.dispatchEvent("pointerup", { bubbles: true });
  await page.waitForTimeout(120);
}

test("keypad digits appear on the multiplexed 7-segment display", async ({ page }) => {
  await loadExampleProject(page, "hal-7seg-keypad");
  await expect(consoleOut(page)).toContainText("type digits", { timeout: 5000 });
  for (const k of ["1", "7", "#"]) await click(page, `[data-id=kp] [data-key="${k}"] rect`);
  await expect(consoleOut(page)).toContainText("value 17", { timeout: 5000 });
  // Digit 4 shows 7: segments a, b, c lit.
  const lit = () =>
    page
      .locator("[data-id=disp] [data-brightness]")
      .evaluate((e) => (e as HTMLElement).dataset.brightness!.split(",").map(Number).slice(24, 31).map((b) => b > 0.05));
  await expect.poll(lit).toEqual([true, true, true, false, false, false, false]);
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);
  await page.screenshot({ path: "test-results/m8-7seg.png" });
});

test("the encoder turns the stepper; the LCD shows the angle", async ({ page }) => {
  await loadExampleProject(page, "hal-encoder-stepper-lcd");
  const lcd = () => page.locator("[data-id=lcd] [data-lcd]").getAttribute("data-lcd");
  await expect.poll(lcd, { timeout: 5000 }).toContain("NTC 25.0");
  const start = Number(await page.locator("[data-id=mot] [data-angle]").getAttribute("data-angle"));
  await click(page, "[data-id=enc] [data-action=cw] circle");
  await expect(consoleOut(page)).toContainText("detents 1 target 204", { timeout: 5000 });
  await expect
    .poll(async () => {
      const a = Number(await page.locator("[data-id=mot] [data-angle]").getAttribute("data-angle"));
      return (a - start + 360) % 360;
    }, { timeout: 5000 })
    .toBeGreaterThan(17.5);
  await expect.poll(lcd, { timeout: 5000 }).toMatch(/Pos +1[78]\.\d°/);
  await page.screenshot({ path: "test-results/m8-lcd.png" });
});

test("sonar distance and DS18B20 temperature follow the sliders", async ({ page }) => {
  await loadExampleProject(page, "hal-sonar-onewire");
  await expect(consoleOut(page)).toContainText("distance 50.0 cm | temperature 24.50 C", { timeout: 8000 });
  await click(page, "[data-id=us] .module-pcb");
  await page.getByLabel("distance").fill("120");
  await expect(consoleOut(page)).toContainText("distance 120.0 cm", { timeout: 8000 });
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);
});
