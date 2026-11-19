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

// M13: MPU-6050 + MAX7219, NEC IR remote.

test("dragging the MPU-6050 tilts it and the dot on the MAX7219 matrix follows", async ({ page }) => {
  await loadExampleProject(page, "hal-imu-matrix");
  await expect(consoleOut(page)).toContainText("WHO_AM_I 0x68", { timeout: 5000 });
  await expect(consoleOut(page)).toContainText("dot row 3 col 3", { timeout: 5000 });
  const matrix = () => page.locator("[data-id=mx] [data-matrix]").getAttribute("data-matrix");
  await expect.poll(matrix, { timeout: 5000 }).toBe("00,00,00,10,00,00,00,00");
  const imu = page.locator("[data-id=imu]");
  const placed = await imu.getAttribute("transform");

  // Drag right 40 px and down 30 px on the sensor: roll 40°, pitch 30°.
  const box = (await page.locator("[data-id=imu] [data-drag-tilt] .imu-dial").boundingBox())!;
  const [x0, y0] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  for (let i = 1; i <= 20; i++) {
    await page.mouse.move(x0 + 2 * i, y0 + 1.5 * i);
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
  await expect(page.locator("[data-id=imu] [data-roll]")).toHaveAttribute("data-roll", "40");
  await expect(page.locator("[data-id=imu] [data-roll]")).toHaveAttribute("data-pitch", "30");
  expect(await imu.getAttribute("transform"), "the part did not move").toBe(placed);
  // While it turned, the gyroscope saw a positive rate about X; then 0.
  await expect(consoleOut(page)).toContainText(/gyro [1-9]\d*\.\d /, { timeout: 5000 });
  await expect(page.getByLabel("gx")).toHaveValue("0");
  await expect(consoleOut(page)).toContainText("roll 40.0 pitch 30.0 | gyro 0.0 0.0 0.0 dps", { timeout: 5000 });
  // The ball rolls right and down: row 6, column 7.
  await expect.poll(matrix, { timeout: 5000 }).toBe("00,00,00,00,00,00,01,00");

  // The slider is the precise alternative and shows the dragged value.
  await expect(page.getByLabel("roll")).toHaveValue("40");
  await page.getByLabel("roll").fill("-45");
  await expect(consoleOut(page)).toContainText("roll -45.0 pitch 30.0", { timeout: 5000 });
  await expect.poll(matrix, { timeout: 5000 }).toBe("00,00,00,00,00,00,80,00");
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);
  await page.screenshot({ path: "test-results/m13-imu-matrix.png" });
});

test("remote buttons are decoded as NEC codes, holding one repeats", async ({ page }) => {
  await loadExampleProject(page, "hal-ir-remote");
  await expect(consoleOut(page)).toContainText("NEC IR receiver on D3", { timeout: 5000 });
  await click(page, `[data-id=ir] [data-key="5"] circle`);
  await expect(consoleOut(page)).toContainText("NEC addr 0x00 cmd 0x40 key 5", { timeout: 5000 });
  await click(page, `[data-id=ir] [data-key="RIGHT"] circle`);
  await expect(consoleOut(page)).toContainText("NEC addr 0x00 cmd 0x5A key RIGHT", { timeout: 5000 });
  // Hold OK: the frame, then repeat codes every 108 ms.
  const ok = page.locator(`[data-id=ir] [data-key="OK"] circle`);
  await ok.dispatchEvent("pointerdown", { bubbles: true });
  await page.waitForTimeout(600);
  await ok.dispatchEvent("pointerup", { bubbles: true });
  await expect(consoleOut(page)).toContainText("NEC addr 0x00 cmd 0x1C key OK\r\nrepeat\r\nrepeat", { timeout: 5000 });
  await expect(page.locator("[data-id=ir] [data-ir-code]")).toHaveAttribute("data-ir-code", "0x1C ⟳");
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);
});
