import { expect, test, type Page } from "@playwright/test";

// M9: source-level debugging in the browser.

const status = (page: Page) => page.getByTestId("run-status");

test("breakpoint, step over/into/out, call stack and variables", async ({ page }) => {
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
  await page.getByLabel("예제 펌웨어").selectOption("hal-7seg-keypad.elf");
  await expect(status(page)).toContainText("hal-7seg-keypad");
  await page.getByRole("button", { name: "소스 (디버그)" }).click();
  await expect(page.getByLabel("소스 파일")).toHaveValue(/\d+/);
  await expect(page.locator(".src-line[data-line='92']")).toContainText("SystemClock_Config();");

  // Break on line 92 and run.
  await page.getByTestId("gutter-92").click();
  await expect(page.getByTestId("gutter-92")).toHaveClass(/bp/);
  // Looking at another tab keeps the breakpoint.
  await page.getByRole("button", { name: "가상 콘솔 (USART2)" }).click();
  await page.getByRole("button", { name: "소스 (디버그)" }).click();
  await expect(page.getByTestId("gutter-92")).toHaveClass(/bp/);
  await page.getByRole("button", { name: "▶ 실행" }).click();
  await expect(page.getByTestId("debug-status")).toContainText("중단점", { timeout: 5000 });
  await expect(page.locator(".src-line.here")).toHaveAttribute("data-line", "92");

  // Step over, then into MX_GPIO_Init and out again.
  await page.getByRole("button", { name: "⤼ 한 줄" }).click();
  await expect(page.locator(".src-line.here")).toHaveAttribute("data-line", "93");
  await page.getByRole("button", { name: "↘ 들어가기" }).click();
  await expect(page.locator(".frames li").first()).toContainText("MX_GPIO_Init");
  await expect(page.locator(".frames li").nth(1)).toContainText("main");
  await page.getByRole("button", { name: "↗ 나오기" }).click();
  await expect(page.locator(".frames li").first()).toContainText("main");

  // Globals of main.c with their values.
  await expect(page.getByTestId("globals")).toContainText("KEYS");
  await expect(page.getByTestId("globals")).toContainText('"456B"');
  await page.screenshot({ path: "test-results/m9-debug.png" });

  // Remove the breakpoint and continue: it runs.
  await page.getByTestId("gutter-92").click();
  await page.locator(".source-bar").getByRole("button", { name: "▶ 계속" }).click();
  await expect(page.getByTestId("debug-status")).toContainText("실행 중");
});
