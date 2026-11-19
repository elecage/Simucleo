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

  // Machine code: the current instruction is the call on line 92.
  await page.getByLabel("기계어").check();
  await expect(page.getByTestId("disassembly").locator(".asm-row.here")).toContainText("bl");
  await expect(page.getByTestId("disassembly").locator(".asm-row.here")).toContainText("<SystemClock_Config>");
  await expect(page.getByTestId("disassembly")).toContainText("main.c:92");
  await page.getByLabel("기계어").uncheck();

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

test("watch expressions and a conditional breakpoint", async ({ page }) => {
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
  await page.getByLabel("예제 펌웨어").selectOption("hal-7seg-keypad.elf");
  await expect(status(page)).toContainText("hal-7seg-keypad");
  await page.getByRole("button", { name: "소스 (디버그)" }).click();
  await expect(page.locator(".src-line[data-line='46']")).toContainText("current = (current + 1) & 3;");

  // Watches, added before running.
  const watch = page.getByLabel("감시식", { exact: true });
  for (const w of ["current", "current * 10 + 1", "KEYS[1]", "nosuch"]) {
    await watch.fill(w);
    await watch.press("Enter");
  }

  // In the 1 ms timer callback `current` counts 0..3; stop only at 2.
  await page.getByTestId("gutter-46").click();
  await page.getByLabel("main.c:46 조건").fill("current == 2");
  await page.getByLabel("main.c:46 조건").press("Enter");
  await expect(page.getByTestId("gutter-46")).toHaveClass(/cond/);
  await page.getByRole("button", { name: "▶ 실행" }).click();
  await expect(page.getByTestId("debug-status")).toContainText("중단점", { timeout: 5000 });
  await expect(page.locator(".src-line.here")).toHaveAttribute("data-line", "46");

  const value = (w: string) => page.getByTestId("watches").locator(`[data-watch="${w}"]`);
  await expect(value("current").locator(".var-value").first()).toHaveText("2");
  await expect(value("current * 10 + 1").locator(".var-value").first()).toHaveText("21");
  await expect(value("KEYS[1]").locator(".var-value").first()).toHaveText('"456B"');
  await expect(value("nosuch")).toContainText("nosuch");

  // Continue: it stops at 2 again; one step later the watch shows 3.
  await page.locator(".source-bar").getByRole("button", { name: "▶ 계속" }).click();
  await expect(page.getByTestId("debug-status")).toContainText("중단점", { timeout: 5000 });
  await expect(value("current").locator(".var-value").first()).toHaveText("2");
  await page.getByRole("button", { name: "⤼ 한 줄" }).click();
  await expect(page.locator(".src-line.here")).toHaveAttribute("data-line", "47");
  await expect(value("current").locator(".var-value").first()).toHaveText("3");
  await page.screenshot({ path: "test-results/m10-watch.png" });

  // Set a variable: double-click its value, type, Enter.
  await value("current").locator(".var-value").first().dblclick();
  await page.getByLabel("(current) 값").fill("1");
  await page.getByLabel("(current) 값").press("Enter");
  await expect(value("current").locator(".var-value").first()).toHaveText("1");
  await expect(value("current * 10 + 1").locator(".var-value").first()).toHaveText("11");
  // A computed value cannot be set: the reason is shown.
  await value("current * 10 + 1").locator(".var-value").first().dblclick();
  await page.getByLabel("(current * 10 + 1) 값").fill("5");
  await page.getByLabel("(current * 10 + 1) 값").press("Enter");
  await expect(page.getByTestId("edit-error")).toContainText("not a variable");
  // A global's element in the tree.
  const digits = page.getByTestId("globals").locator("li", { hasText: "digits" }).first();
  await digits.locator(".var-value[data-var='[0]']").dblclick();
  await page.getByLabel("digits[0] 값").fill("0x3F");
  await page.getByLabel("digits[0] 값").press("Enter");
  await expect(digits.locator(".var-value[data-var='[0]']")).toHaveText("63");
  await expect(page.getByTestId("edit-error")).toHaveCount(0);
  await page.screenshot({ path: "test-results/m11-set-variable.png" });
});
