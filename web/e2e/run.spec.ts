import { expect, test, type Page } from "@playwright/test";

// These tests run the example firmware bundled by `npm run examples`
// (built with arm-none-eabi-gcc in CI).

const status = (page: Page) => page.getByTestId("run-status");
const consoleOut = (page: Page) => page.getByTestId("console-output");
const ld2On = (page: Page) => page.locator("[data-led=LD2]").evaluate((e) => Number(getComputedStyle(e).opacity) > 0.5);

async function loadExample(page: Page, file: string) {
  await page.getByLabel("예제 펌웨어").selectOption(file);
  await expect(status(page)).toContainText(file.replace(".elf", ""));
}

/** Count LD2 on/off changes while sampling for `ms` of wall time. */
async function ld2Toggles(page: Page, ms: number) {
  let last: boolean | null = null;
  let n = 0;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const on = await ld2On(page);
    if (last !== null && on !== last) n++;
    last = on;
    await page.waitForTimeout(20);
  }
  return n;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
});

test("printf reaches the virtual COM port and typed text is echoed", async ({ page }) => {
  await loadExample(page, "hal-uart-printf.elf");
  await page.getByRole("button", { name: "▶ 실행" }).click();
  await expect(consoleOut(page)).toContainText("Hello from Simucleo! SystemCoreClock = 84000000 Hz", { timeout: 5000 });
  await expect(consoleOut(page)).toContainText("tick 0 at 259 ms");
  const input = page.getByLabel("콘솔 입력");
  await input.fill("abc");
  await input.press("Enter");
  await expect(consoleOut(page)).toContainText("ABC", { timeout: 5000 });
  await expect(status(page)).toContainText("84.0 MHz");
});

test("LD2 blinks in real time and B1 speeds it up", async ({ page }) => {
  await loadExample(page, "hal-blinky.elf");
  await page.getByRole("button", { name: "▶ 실행" }).click();
  await page.waitForTimeout(300);
  // 500 ms period: about 4 changes in 2 s of wall time.
  expect(await ld2Toggles(page, 2000)).toBeGreaterThanOrEqual(3);
  expect(await ld2Toggles(page, 2000)).toBeLessThanOrEqual(5);

  const b1 = (await page.locator("[data-action=b1]").boundingBox())!;
  await page.mouse.move(b1.x + b1.width / 2, b1.y + b1.height / 2);
  await page.mouse.down();
  // 100 ms period while held: well over 10 changes in 2 s.
  expect(await ld2Toggles(page, 2000)).toBeGreaterThanOrEqual(12);
  await page.mouse.up();
});

test("a wrong clock setup is diagnosed", async ({ page }) => {
  await loadExample(page, "hal-blinky-hse-crystal.elf");
  await page.getByRole("button", { name: "▶ 실행" }).click();
  await expect(page.getByRole("alert")).toContainText("Error_Handler() was called from SystemClock_Config()");
  await expect(page.getByRole("button", { name: "▶ 실행" })).toBeDisabled();
});

test("uploaded ELF runs; registers and memory are visible", async ({ page }) => {
  await page.getByTestId("elf-input").setInputFiles("public/examples/bare-blinky.elf");
  await expect(status(page)).toContainText("bare-blinky.elf");
  await page.getByRole("button", { name: "레지스터" }).click();
  await expect(page.locator(".registers")).toContainText("<Reset_Handler>");
  await page.getByRole("button", { name: "▶ 실행" }).click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "⏸ 일시정지" }).click();
  await expect(page.locator(".registers")).toContainText("<main>");

  await page.getByRole("button", { name: "메모리" }).click();
  await page.getByLabel("메모리 주소").fill("0x08000000");
  // First word of the vector table: initial SP 0x20018000, little-endian.
  await expect(page.locator(".memory tr").first()).toContainText("00 80 01 20");
});
