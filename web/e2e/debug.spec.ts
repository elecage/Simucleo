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

test("a data watchpoint stops right after the variable is written", async ({ page }) => {
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
  await page.getByLabel("예제 펌웨어").selectOption("hal-7seg-keypad.elf");
  await expect(status(page)).toContainText("hal-7seg-keypad");
  await page.getByRole("button", { name: "소스 (디버그)" }).click();
  await expect(page.locator(".src-line[data-line='46']")).toBeVisible();

  const wp = page.getByLabel("감시점 식");
  await wp.fill("current");
  await wp.press("Enter");
  await wp.fill("nosuch");
  await wp.press("Enter");
  const list = page.getByTestId("watchpoints");
  await expect(list.locator("li").first()).toContainText(/0x2000[0-9a-f]{4} · 4바이트/);
  await expect(list.locator("li").nth(1)).toContainText("no variable named nosuch");

  await page.getByRole("button", { name: "▶ 실행" }).click();
  await expect(page.getByTestId("debug-status")).toContainText("감시점", { timeout: 5000 });
  await expect(page.getByTestId("debug-status")).toContainText("쓰기");
  // First the startup code zero-fills .bss, `current` included.
  await expect(page.locator(".frames li").first()).toContainText("Reset_Handler");
  await page.locator(".source-bar").getByRole("button", { name: "▶ 계속" }).click();
  await expect(page.getByTestId("debug-status")).toContainText("감시점", { timeout: 5000 });
  // Then the timer callback: the store is on line 46; execution stopped
  // after it.
  await expect(page.locator(".src-line.here")).toHaveAttribute("data-line", "47");
  await expect(page.locator(".frames li").first()).toContainText("HAL_TIM_PeriodElapsedCallback");
  await page.screenshot({ path: "test-results/m11-watchpoint.png" });

  // Without it, execution runs on.
  await list.locator("li").first().getByTitle("감시점 지우기").click();
  await page.locator(".source-bar").getByRole("button", { name: "▶ 계속" }).click();
  await expect(page.getByTestId("debug-status")).toContainText("실행 중");
});

test("RTOS: each task's call stack and locals", async ({ page }) => {
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
  await page.getByLabel("예제 펌웨어").selectOption("freertos-two-tasks.elf");
  await expect(status(page)).toContainText("freertos-two-tasks");
  await page.getByRole("button", { name: "▶ 실행" }).click();
  // Count prints every second; let it print a few times.
  await page.getByRole("button", { name: "가상 콘솔 (USART2)" }).click();
  await expect(page.locator(".console")).toContainText("count 2", { timeout: 10000 });
  await page.getByRole("button", { name: "⏸ 일시정지" }).click();
  await page.getByRole("button", { name: "소스 (디버그)" }).click();
  await expect(page.getByTestId("debug-status")).toContainText("일시정지");

  // Count waits in osDelay, called from CountTask.
  const select = page.getByLabel("태스크");
  await select.selectOption({ label: "Count (대기)" });
  const frames = page.locator(".frames li");
  await expect(frames.filter({ hasText: "osDelay" })).toHaveCount(1);
  // The task function is the bottom of its stack.
  await expect(frames.last()).toContainText("CountTask");
  await frames.filter({ hasText: "CountTask" }).click();
  await expect(page.locator(".src-line.here")).toContainText("osDelay(1000);");
  await expect(page.getByTestId("locals")).toContainText("n");
  await expect(page.getByTestId("locals").locator(".var-value[data-var='n']")).toHaveText(/^[3-9]\d*$/);
  await page.screenshot({ path: "test-results/m11-rtos-stack.png" });

  // The button task waits on its semaphore.
  await select.selectOption({ label: "Button (대기)" });
  await expect(frames.filter({ hasText: "osSemaphoreAcquire" })).toHaveCount(1);
  await expect(frames.filter({ hasText: "ButtonTask" })).toHaveCount(1);
});

test("paused inside HAL_Delay: the HAL driver's source is shown, at the line that runs", async ({ page }) => {
  // Blinky spends nearly all its time in HAL_Delay: a pause stops there.
  // The site carries the HAL sources the examples are built from, so the
  // view shows stm32f4xx_hal.c rather than "no source".
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
  await page.getByLabel("예제 펌웨어").selectOption("hal-blinky.elf");
  await expect(status(page)).toContainText("hal-blinky");
  await page.getByRole("button", { name: "소스 (디버그)" }).click();
  await page.getByRole("button", { name: "▶ 실행" }).click();
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "⏸ 일시정지" }).first().click();
  await expect(page.getByTestId("debug-status")).toContainText("일시정지", { timeout: 5000 });
  await expect(page.locator(".frames li").first()).toContainText("HAL_");
  await expect(page.locator(".src-line.here")).toHaveCount(1);
  await expect(page.locator(".src-line").first()).toBeVisible();
  await expect(page.getByLabel("소스 파일").locator("option:checked")).toContainText("stm32f4xx_hal");
  await expect(page.locator(".source-view")).not.toContainText("의 소스가 없습니다");
});

test("stepping into code without a source (newlib's printf) shows the line that called it", async ({ page }) => {
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
  await page.getByLabel("예제 펌웨어").selectOption("hal-uart-printf.elf");
  await expect(status(page)).toContainText("hal-uart-printf");
  await page.getByRole("button", { name: "소스 (디버그)" }).click();
  await expect(page.locator(".src-line[data-line='22']")).toContainText('printf("Hello from Simucleo!');
  await page.getByTestId("gutter-22").click();
  await page.getByRole("button", { name: "▶ 실행" }).click();
  await expect(page.getByTestId("debug-status")).toContainText("중단점", { timeout: 5000 });
  await page.getByRole("button", { name: "↘ 들어가기" }).click();
  // In printf (newlib, no source here): the caller, main.c:22, with a note.
  await expect(page.locator(".frames li").first()).not.toContainText(/^main/);
  await expect(page.getByTestId("frame-skipped")).toBeVisible();
  await expect(page.locator(".frames li.on")).toContainText("main");
  await expect(page.locator(".src-line.here")).toHaveAttribute("data-line", "22");
  await expect(page.locator(".source-view")).not.toContainText("의 소스가 없습니다");
});
