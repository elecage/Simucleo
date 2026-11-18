import { expect, test, type Page } from "@playwright/test";

// M7: DMA-driven NeoPixel ring and a DHT22 read with input capture.

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

const ledColors = (page: Page) =>
  page.locator("[data-id=ring] [data-led]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.color));

test("NeoPixel: a rainbow turns around the ring", async ({ page }) => {
  await loadExampleProject(page, "hal-neopixel-dma");
  await expect(consoleOut(page)).toContainText("frames", { timeout: 5000 });
  await expect.poll(async () => new Set(await ledColors(page)).size).toBeGreaterThan(9);
  const first = await ledColors(page);
  await page.waitForTimeout(300);
  expect(await ledColors(page)).not.toEqual(first); // it moves
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);
  await page.screenshot({ path: "test-results/m7-neopixel.png" });
});

test("DHT22: the reading follows the sensor's sliders", async ({ page }) => {
  await loadExampleProject(page, "hal-dht-capture");
  await expect(consoleOut(page)).toContainText("humidity 48.3 %  temperature 22.5 C", { timeout: 8000 });
  await page.locator("[data-id=dht] .module-pcb").dispatchEvent("pointerdown", { bubbles: true });
  await page.locator("[data-id=dht] .module-pcb").dispatchEvent("pointerup", { bubbles: true });
  await expect(page.locator(".inspector")).toContainText("DHT22");
  await page.getByLabel("temp").fill("-5");
  await expect(consoleOut(page)).toContainText("temperature -5.0 C", { timeout: 8000 });
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);
  await page.screenshot({ path: "test-results/m7-dht.png" });
});
