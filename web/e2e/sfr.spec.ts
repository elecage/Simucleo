import { expect, test, type Page } from "@playwright/test";

// The SFR tab: peripheral registers from the SVD, live and editable.

const status = (page: Page) => page.getByTestId("run-status");
const periph = (page: Page, name: string) => page.locator(`[data-testid=sfr-periph][data-name="${name}"]`);
const reg = (page: Page, key: string) => page.locator(`[data-testid=sfr-reg][data-key="${key}"]`).first();
const ld2On = (page: Page) => page.locator("[data-led=LD2]").evaluate((e) => Number(getComputedStyle(e).opacity) > 0.5);
const odr = (page: Page) => reg(page, "GPIOA.ODR").getAttribute("data-value");

async function openSfr(page: Page) {
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
  await page.getByLabel("예제 펌웨어").selectOption("hal-blinky.elf");
  await expect(status(page)).toContainText("hal-blinky");
  await page.getByRole("button", { name: "SFR", exact: true }).click();
  await expect(page.getByTestId("sfr-view")).toBeVisible();
}

async function expand(page: Page, name: string) {
  const head = periph(page, name).locator(".sfr-periph-head");
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
}

test("GPIOA.ODR follows the blinking LED; its ODR5 checkbox switches LD2 while paused", async ({ page }) => {
  await openSfr(page);
  await expect(periph(page, "GPIOA")).toContainText("0x40020000");
  await expand(page, "GPIOA");
  await expect(reg(page, "GPIOA.ODR")).toHaveAttribute("data-value", /^0x/);
  await page.getByRole("button", { name: "▶ 실행" }).click();
  // ODR bit 5 toggles every 500 ms of simulated time.
  const seen = new Set<string | null>();
  await expect
    .poll(
      async () => {
        seen.add(await odr(page));
        return seen.size;
      },
      { timeout: 10_000, intervals: [100] },
    )
    .toBeGreaterThan(1);
  await page.getByRole("button", { name: "⏸ 일시정지" }).click();
  await expect(page.getByRole("button", { name: "▶ 실행" })).toBeVisible();

  // Open ODR's fields and drive PA5 by hand.
  await reg(page, "GPIOA.ODR").locator(".sfr-reg-name").click();
  const odr5 = page.getByLabel("GPIOA.ODR.ODR5", { exact: true });
  // (Paused with the LED on or off.)
  if (await odr5.isChecked()) {
    await odr5.click();
    await expect(odr5).not.toBeChecked();
  }
  await expect.poll(() => odr(page)).toBe("0x00000000");
  await expect.poll(() => ld2On(page)).toBe(false);
  await odr5.click();
  await expect.poll(() => odr(page)).toBe("0x00000020");
  await expect.poll(() => ld2On(page)).toBe(true);
  await expect(page.locator('[data-testid=sfr-field][data-name="GPIOA.ODR.ODR5"]')).toHaveAttribute("data-value", "1");
  await odr5.click();
  await expect.poll(() => ld2On(page)).toBe(false);
  await expect(odr5).not.toBeChecked();
  // The reset value is marked once the value differs from it.
  await odr5.click();
  await expect(reg(page, "GPIOA.ODR").locator(".sfr-reset")).toHaveClass(/differs/);
  // An enumerated field: MODER5 is "Output".
  await reg(page, "GPIOA.MODER").locator(".sfr-reg-name").click();
  await expect(page.locator('[data-testid=sfr-field][data-name="GPIOA.MODER.MODER5"]')).toContainText("Output");
});

test("a peripheral with its clock off is marked; enabling it in RCC lets TIM2.PSC be edited", async ({ page }) => {
  await openSfr(page);
  // Out of reset every gated clock is off, GPIOA's too.
  await expect(periph(page, "GPIOA").getByTestId("sfr-clock-off")).toBeVisible();
  // Let the firmware's initialisation run.
  await page.getByRole("button", { name: "▶ 실행" }).click();
  await expect(periph(page, "GPIOA").getByTestId("sfr-clock-off")).toHaveCount(0);
  await page.getByRole("button", { name: "⏸ 일시정지" }).click();
  // hal-blinky enables only GPIOA/C/H (and PWR, SYSCFG): SPI2 and TIM2 are off.
  await expect(periph(page, "SPI2").getByTestId("sfr-clock-off")).toBeVisible();
  await expect(periph(page, "TIM2").getByTestId("sfr-clock-off")).toBeVisible();
  await expect(periph(page, "GPIOA").getByTestId("sfr-clock-off")).toHaveCount(0);
  await expect(periph(page, "RCC").getByTestId("sfr-clock-off")).toHaveCount(0);
  // WWDG has no behavioural model.
  await expect(periph(page, "WWDG").getByTestId("sfr-regfile")).toBeVisible();
  await expect(periph(page, "TIM2").getByTestId("sfr-regfile")).toHaveCount(0);

  // RCC_APB1ENR.TIM2EN through its checkbox (a read-modify-write of the register).
  await page.getByTestId("sfr-search").fill("RCC.APB1ENR.TIM2EN");
  const en = page.getByLabel("RCC.APB1ENR.TIM2EN", { exact: true });
  await expect(en).not.toBeChecked();
  await en.click();
  await expect(en).toBeChecked();
  await expect(periph(page, "TIM2").getByTestId("sfr-clock-off")).toHaveCount(0);

  // TIM2.PSC: click the value, type, Enter.
  await page.getByTestId("sfr-search").fill("TIM2.PSC");
  const psc = reg(page, "TIM2.PSC");
  await expect(psc).toHaveAttribute("data-value", "0x00000000");
  await psc.getByTestId("sfr-value").click();
  const input = page.getByTestId("sfr-input");
  await input.fill("0x1F3");
  await input.press("Enter");
  await expect(psc).toHaveAttribute("data-value", "0x000001F3");
  // Esc cancels an edit.
  await psc.getByTestId("sfr-value").click();
  await page.getByTestId("sfr-input").fill("7");
  await page.getByTestId("sfr-input").press("Escape");
  await expect(page.getByTestId("sfr-input")).toHaveCount(0);
  await expect(psc).toHaveAttribute("data-value", "0x000001F3");
  // A write-only register says so; a read-only one is not editable.
  await page.getByTestId("sfr-search").fill("TIM2.EGR");
  await expect(reg(page, "TIM2.EGR")).toContainText("쓰기 전용");
  await page.getByTestId("sfr-search").fill("GPIOA.IDR");
  const idr = reg(page, "GPIOA.IDR");
  await expect(idr).toContainText("읽기 전용");
  await expect(idr.getByRole("button", { name: "GPIOA.IDR 값 편집" })).toHaveCount(0);
  await idr.locator(".sfr-reg-name").click();
  const idr13 = page.locator('[data-testid=sfr-field][data-name="GPIOA.IDR.IDR13"]');
  await expect(idr13).toContainText("읽기 전용");
  await expect(idr13.locator("input")).toHaveCount(0);
});

test("search finds USART2, and a pinned register stays watched after a reload", async ({ page }) => {
  await openSfr(page);
  await page.getByTestId("sfr-search").fill("USART2");
  await expect(page.getByTestId("sfr-periph").first()).toHaveAttribute("data-name", "USART2");
  await expect(periph(page, "GPIOA")).toHaveCount(0);
  await expand(page, "USART2");
  await expect(reg(page, "USART2.SR")).toBeVisible();
  await expect(reg(page, "USART2.BRR")).toBeVisible();
  // Pin USART2.SR and GPIOA.ODR.
  await reg(page, "USART2.SR").getByRole("button", { name: "USART2.SR 감시" }).click();
  await page.getByTestId("sfr-search").fill("GPIOA.ODR");
  await reg(page, "GPIOA.ODR").getByRole("button", { name: "GPIOA.ODR 감시" }).click();
  const watched = page.getByTestId("sfr-watched");
  await expect(watched.locator("[data-testid=sfr-reg]")).toHaveCount(2);

  await page.reload();
  // (The project comes back with its firmware.)
  await expect(status(page)).toContainText("hal-blinky");
  await page.getByRole("button", { name: "SFR", exact: true }).click();
  await expect(watched.locator("[data-testid=sfr-reg]")).toHaveCount(2);
  await expect(watched.locator('[data-key="GPIOA.ODR"]')).toHaveAttribute("data-value", /^0x/);
  await expect(watched.locator('[data-key="USART2.SR"]')).toContainText("USART2.SR");
  // Unpin one.
  await watched.getByRole("button", { name: "USART2.SR 감시 해제" }).click();
  await expect(watched.locator("[data-testid=sfr-reg]")).toHaveCount(1);
});
