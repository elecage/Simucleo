import { expect, test, type Page } from "@playwright/test";

// M35: K-type thermocouple amplifiers (MAX6675, MAX31855K) on SPI1
// receive-only. The example firmware prints both every 250 ms; the
// temperature follows the probe and an unplugged probe is a fault.

const status = (page: Page) => page.getByTestId("run-status");
const consoleOut = (page: Page) => page.getByTestId("console-output");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
});

async function centre(page: Page, selector: string) {
  const b = (await page.locator(selector).first().boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** The last reading line on the console. */
async function lastLine(page: Page) {
  const text = (await consoleOut(page).textContent()) ?? "";
  return text.split(/\r?\n/).filter((l) => l.startsWith("MAX6675")).at(-1) ?? "";
}

test("thermocouples: the console follows the probe temperature, an unplugged probe is a fault", async ({ page }) => {
  test.setTimeout(60000);
  await page.getByLabel("예제 펌웨어").selectOption("hal-thermocouple.elf");
  await expect(status(page)).toContainText("hal-thermocouple");
  await page.getByRole("button", { name: "▶ 실행" }).click();
  await expect(consoleOut(page)).toContainText("SPI1 RX-only", { timeout: 8000 });
  await expect(consoleOut(page)).toContainText("MAX6675 25.00 C | MAX31855 25.00 C (cold 25.00 C) | heater on", { timeout: 8000 });
  // The parts show the word the next read gives.
  await expect(page.locator("[data-id=k] [data-word]")).toHaveAttribute("data-word", "0320");
  await expect(page.locator("[data-id=j] [data-reading]")).toHaveAttribute("data-reading", "25");
  await expect.poll(async () => Number(await page.locator("[data-id=led] [data-brightness]").first().getAttribute("data-brightness"))).toBeGreaterThan(0.5);

  // The probe tips to 200 °C from the inspector.
  await page.locator("[data-id=k] .chip").click({ force: true });
  await page.getByLabel("temp").fill("200");
  await expect(consoleOut(page)).toContainText("MAX6675 199.00 C | MAX31855 25.00 C", { timeout: 8000 });
  await page.locator("[data-id=j] .chip").click({ force: true });
  await page.getByLabel("temp").fill("200");
  await expect(consoleOut(page)).toContainText("MAX6675 199.00 C | MAX31855 198.00 C (cold 25.00 C) | heater off", { timeout: 8000 });
  await expect.poll(async () => Number(await page.locator("[data-id=led] [data-brightness]").first().getAttribute("data-brightness"))).toBeLessThan(0.1);

  // Ice water on the MAX6675's probe: it cools towards 0 °C.
  const ice = await centre(page, "[data-id=k] [data-drag=ice]");
  await page.mouse.move(ice.x, ice.y);
  await page.mouse.down();
  await expect(page.locator("[data-id=k] [data-ice]")).toHaveCount(1);
  await expect
    .poll(async () => Number((await lastLine(page)).match(/^MAX6675 ([\d.]+) C/)?.[1] ?? 999), { timeout: 15000 })
    .toBeLessThan(20);
  await page.mouse.up();

  // Pull the MAX31855's probe out of its terminals.
  await page.locator("[data-id=j] [data-drag=plug] rect").first().click({ force: true });
  await expect(page.locator("[data-id=j] [data-unplugged]")).toHaveAttribute("data-unplugged", "1");
  await expect(consoleOut(page)).toContainText("MAX31855 FAULT OC (open) (cold 25.00 C) | heater off", { timeout: 8000 });
  await expect(page.locator("[data-id=j] [data-reading]")).toHaveAttribute("data-reading", "OC");
  await page.locator(".canvas-wrap").screenshot({ path: "test-results/m35-thermocouple.png" });
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);
});

test("thermocouples in the schematic: module boxes with SPI read only", async ({ page }) => {
  await page.getByLabel("예제 펌웨어").selectOption("hal-thermocouple.elf");
  await expect(status(page)).toContainText("hal-thermocouple");
  await page.getByRole("group", { name: "보기" }).getByRole("button", { name: "회로도" }).click();
  const sch = page.locator("svg.schematic");
  await expect(sch.locator("[data-part=k]")).toContainText("K형 열전대 앰프 (MAX6675)");
  await expect(sch.locator("[data-part=j]")).toContainText("K형 열전대 앰프 (MAX31855K)");
  const pins = (part: string) => sch.locator(`[data-part=${part}] .sym-pin`).evaluateAll((els) => els.map((e) => e.getAttribute("data-pin")));
  expect(await pins("k")).toEqual(["VCC", "GND", "SCK", "CS", "SO"]);
  expect(await pins("j")).toEqual(["VIN", "3Vo", "GND", "CLK", "CS", "DO"]);
});
