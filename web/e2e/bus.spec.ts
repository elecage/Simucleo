import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// M6: I2C and SPI modules driven by the example firmware.

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

const pixels = (page: Page, id: string) =>
  page.locator(`[data-id="${id}"] [data-pixels]`).evaluate((e) => Number((e as HTMLElement).dataset.pixels));

test("I2C: the OLED shows the RTC time and the AHT20 reading", async ({ page }) => {
  await loadExampleProject(page, "hal-i2c-oled");
  await expect(consoleOut(page)).toContainText("scan: 0x38 0x3C 0x68", { timeout: 5000 });
  await expect(consoleOut(page)).toContainText("23.5 C 45.0 %RH", { timeout: 5000 });
  await expect.poll(() => pixels(page, "oled")).toBeGreaterThan(300);
  await expect(page.locator("[data-id=rtc] [data-rtc]")).toHaveAttribute("data-rtc", /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);

  // Warmer: the sensor slider reaches the firmware.
  await page.locator("[data-id=aht] .module-pcb").dispatchEvent("pointerdown", { bubbles: true });
  await page.locator("[data-id=aht] .module-pcb").dispatchEvent("pointerup", { bubbles: true });
  await expect(page.locator(".inspector")).toContainText("AHT20");
  await page.getByLabel("temp").fill("30");
  await expect(consoleOut(page)).toContainText("30.0 C", { timeout: 5000 });
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);
  await page.screenshot({ path: "test-results/m6-i2c.png" });
});

test("SPI: the logger formats the SD card; the image downloads with LOG.CSV", async ({ page }) => {
  await loadExampleProject(page, "hal-spi-sd-logger");
  await expect(consoleOut(page)).toContainText("blank card: formatting... done", { timeout: 8000 });
  await expect(consoleOut(page)).toContainText(/,21\.0,55\.0/, { timeout: 8000 });
  await expect.poll(() => pixels(page, "oled")).toBeGreaterThan(300);

  await page.locator("[data-id=sd] .module-pcb").dispatchEvent("pointerdown", { bubbles: true });
  await page.locator("[data-id=sd] .module-pcb").dispatchEvent("pointerup", { bubbles: true });
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "이미지 내려받기" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("sd.img");
  const img = readFileSync((await file.path())!);
  expect(img.length).toBe(32 << 20);
  expect(img.includes(Buffer.from("LOG     CSV"))).toBe(true);
  expect(img.includes(Buffer.from("time,temp_c,humidity_pct\n"))).toBe(true);
  await page.screenshot({ path: "test-results/m6-spi.png" });
});
