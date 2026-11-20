import { expect, test, type Page } from "@playwright/test";

// M35: a colour SPI TFT (ST7735S) driven by the hal-tft-st7735 example over
// SPI1. The picture reaches the page as RGB565 bytes only when it changes
// and is drawn on a canvas in the part: its pixels are checked here.

const status = (page: Page) => page.getByTestId("run-status");
const consoleOut = (page: Page) => page.getByTestId("console-output");
const screen = (page: Page) => page.locator("[data-id=tft] [data-tft-lit]");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
});

/** RGB of canvas pixel (x, y) of the display (its own 128×160 pixels). */
const pixel = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([x, y]) => {
      const c = document.querySelector<HTMLCanvasElement>("[data-id=tft] canvas[data-tft-canvas]")!;
      const d = c.getContext("2d")!.getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    [x, y],
  );

/** Top-left corner of the orange box (255, 165, 0 in RGB565: 0xFD20), as "x,y". */
const box = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>("[data-id=tft] canvas[data-tft-canvas]")!;
    const d = c.getContext("2d")!.getImageData(0, 0, 128, 160).data;
    for (let y = 82; y < 160; y++)
      for (let x = 0; x < 128; x++) {
        const i = 4 * (y * 128 + x);
        if (d[i] === 255 && d[i + 1] === 166 && d[i + 2] === 0) return `${x},${y}`;
      }
    return "";
  });

test("ST7735S on SPI1: colour bars, text and a moving box on the canvas; B1 inverts", async ({ page }) => {
  test.setTimeout(60000);
  await page.getByLabel("예제 펌웨어").selectOption("hal-tft-st7735.elf");
  await expect(status(page)).toContainText("hal-tft-st7735");
  await expect(page.locator("[data-id=tft]")).toBeVisible();
  // Not initialised yet: dark.
  await expect(screen(page)).toHaveAttribute("data-tft-lit", "0");
  await page.getByRole("button", { name: "▶ 실행" }).click();
  await expect(consoleOut(page)).toContainText("init done, drawing", { timeout: 10000 });
  await expect(screen(page)).toHaveAttribute("data-tft-lit", "1", { timeout: 5000 });
  await expect(screen(page)).toHaveAttribute("data-backlight", "1.00");

  // The eight colour bars (RGB565 expanded to 8 bits per channel).
  const bars = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [255, 255, 0],
    [0, 255, 255],
    [255, 0, 255],
    [255, 255, 255],
    [132, 130, 132],
  ];
  await expect.poll(() => pixel(page, 8, 30), { timeout: 5000 }).toEqual(bars[0]);
  for (let i = 0; i < 8; i++) expect(await pixel(page, 16 * i + 8, 30), `bar ${i}`).toEqual(bars[i]);
  expect(await pixel(page, 1, 1)).toEqual([0, 0, 123]); // navy title bar

  // The box moves, and only a changed picture is sent: the version moves with it.
  const seen = new Set<string>();
  await expect
    .poll(
      async () => {
        const b = await box(page);
        if (b) seen.add(b);
        return seen.size;
      },
      { timeout: 10000, intervals: [50] },
    )
    .toBeGreaterThanOrEqual(3);
  const v1 = await screen(page).getAttribute("data-tft-version");
  await expect.poll(() => screen(page).getAttribute("data-tft-version")).not.toBe(v1);
  await expect(consoleOut(page)).toContainText("count 2 box", { timeout: 5000 });
  await page.locator(".canvas-wrap").screenshot({ path: "test-results/tft-st7735.png" });
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);

  // B1: INVON — red shows cyan.
  const b1 = (await page.locator("[data-action=b1]").first().boundingBox())!;
  await page.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.up();
  await expect(consoleOut(page)).toContainText("B1: colours inverted", { timeout: 3000 });
  await expect(screen(page)).toHaveAttribute("data-inverted", "1");
  await expect.poll(() => pixel(page, 8, 30), { timeout: 3000 }).toEqual([0, 255, 255]);

  // The schematic draws it as a box with its SPI pins.
  await page.getByRole("button", { name: "회로도" }).click();
  await expect(page.locator(".schematic [data-part=tft]")).toContainText("ST7735S");
  await expect(page.locator(".schematic [data-part=tft]")).toContainText("RESET");
});
