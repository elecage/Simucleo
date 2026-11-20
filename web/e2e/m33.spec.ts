import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";

// M33: write C in the browser, build it with clang/lld (WebAssembly) and run
// it. One page keeps the compiler warm for the editing tests (its first load
// downloads about 20 MB and compiles the WebAssembly); the offline and share
// tests use their own contexts.

test.describe.configure({ mode: "serial", timeout: 240_000 });
test.skip(!existsSync("dist/toolchain/manifest.json"), "build with the toolchain first (make -C ../firmware/editor-sdk && npm run build)");

const BLINKY = existsSync("public/examples/src/hal-blinky/main.c") ? readFileSync("public/examples/src/hal-blinky/main.c", "utf8").split("\n") : [];
/** The line of hal-blinky's main.c with the 500 ms delay (the one the tests edit). */
const DELAY_LINE = BLINKY.findIndex((l) => l.includes("HAL_Delay(500);")) + 1;

const status = (page: Page) => page.getByTestId("run-status");
const buildStatus = (page: Page) => page.getByTestId("build-status");
const editor = (page: Page) => page.getByTestId("code-editor");
const line = (page: Page, text: string) => editor(page).locator(".cm-line", { hasText: text });

/** Toolbar items and the canvas: none may move (M29/M30/M39 guard). */
const layout = (page: Page) =>
  page.evaluate(() => {
    const m = document.querySelector("main")!.getBoundingClientRect();
    const items = [...document.querySelector(".toolbar")!.children].map((c) => {
      const r = c.getBoundingClientRect();
      return `${r.left},${r.top},${r.width},${r.height}`;
    });
    return `${m.top} ${m.height} ${document.querySelector(".toolbar")!.getBoundingClientRect().height} | ${items.join(" ")}`;
  });

/** LD2's brightness and the simulated time ("code.elf · 1.234 s · 84.0 MHz"), read together. */
const sample = (page: Page) =>
  page.evaluate(() => {
    const o = Number(getComputedStyle(document.querySelector("[data-led=LD2]")!).opacity);
    const m = /· ([\d.]+) s ·/.exec(document.querySelector("[data-testid=run-status]")?.textContent ?? "");
    return { o, t: m ? Number(m[1]) : NaN };
  });

/**
 * The time between LD2 toggles over `simMs` of simulated time, in ms (the
 * median of the intervals). A frame in which LD2 toggled shows it half
 * bright: only clearly on (> 0.8) or off (< 0.2) counts.
 */
async function ld2Period(page: Page, simMs: number): Promise<number> {
  const start = await sample(page);
  let last: boolean | null = null;
  const edges: number[] = [];
  for (;;) {
    const { o, t } = await sample(page);
    const on = o > 0.8 ? true : o < 0.2 ? false : null;
    if (on !== null) {
      if (last !== null && on !== last) edges.push(t);
      last = on;
    }
    if ((t - start.t) * 1000 >= simMs) break;
    await page.waitForTimeout(10);
  }
  expect(edges.length).toBeGreaterThanOrEqual(3);
  const gaps = edges.slice(1).map((t, i) => (t - edges[i]) * 1000).sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

async function openCodeTab(page: Page) {
  await page.getByRole("button", { name: "코드", exact: true }).click();
  await expect(page.getByTestId("code-panel")).toBeVisible();
}

async function startFromBlinky(page: Page) {
  await openCodeTab(page);
  await page.getByLabel("코드를 시작할 예제").selectOption("hal-blinky.elf");
  await expect(line(page, "HAL_Delay(500);")).toBeVisible();
}

/** hal-blinky's main.c as the first test edits it (500 → 120 ms). */
const EDITED = BLINKY.join("\n").replace("HAL_Delay(500);", "HAL_Delay(120);");

/** Replace the whole text of the open file. */
async function setText(page: Page, text: string) {
  await editor(page).locator(".cm-content").focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(text);
}

/** Put the cursor at the end of the first line containing `text`. */
async function endOf(page: Page, text: string) {
  await line(page, text).first().click();
  await page.keyboard.press("End");
}

async function build(page: Page, expectOk = true) {
  await page.getByRole("button", { name: "▶ 빌드" }).click();
  await expect(buildStatus(page)).toContainText(expectOk ? "빌드 성공" : "빌드하지 못했습니다", { timeout: 180_000 });
}

let shared: { context: BrowserContext; page: Page } | null = null;
async function warmPage(browser: Browser) {
  if (shared) return shared.page;
  const context = await browser.newContext({ viewport: { width: 1400, height: 820 } });
  const page = await context.newPage();
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
  shared = { context, page };
  return page;
}
test.afterAll(async () => {
  await shared?.context.close();
});

test("edit hal-blinky's main.c, build in the browser: LD2 blinks faster; the toolbar and canvas stay", async ({ browser }) => {
  const page = await warmPage(browser);
  await page.getByLabel("예제 펌웨어").selectOption("hal-blinky.elf");
  await expect(status(page)).toContainText("hal-blinky");
  await page.getByRole("button", { name: "▶ 실행" }).click();
  const before = await ld2Period(page, 2200);
  expect(before).toBeGreaterThan(450);
  expect(before).toBeLessThan(560);
  const shape = await layout(page);

  await startFromBlinky(page);
  expect(await layout(page)).toBe(shape);
  // 500 → 120 ms (100 ms is already in the B1 branch).
  await endOf(page, "HAL_Delay(500);");
  for (let i = 0; i < "500);".length; i++) await page.keyboard.press("Backspace");
  await page.keyboard.insertText("120);");
  await expect(line(page, "HAL_Delay(120);")).toBeVisible();
  const t0 = Date.now();
  await build(page);
  console.log(`first build (compiler download + start + build): ${Date.now() - t0} ms`);
  await expect(status(page)).toContainText("code.elf");
  // The build runs it at once.
  await expect(page.getByRole("button", { name: "⏸ 일시정지" })).toBeVisible();
  const after = await ld2Period(page, 1200);
  expect(after).toBeGreaterThan(105);
  expect(after).toBeLessThan(150);

  // A second build is quick: the compiler stays loaded.
  const t1 = Date.now();
  await build(page);
  const warm = Date.now() - t1;
  console.log(`warm build: ${warm} ms`);
  expect(warm).toBeLessThan(15_000);
  expect(await layout(page)).toBe(shape);
});

test("autocomplete offers HAL_GPIO_TogglePin, struct members and a signature hint", async ({ browser }) => {
  const page = await warmPage(browser);
  await endOf(page, "HAL_GPIO_TogglePin(LD2_GPIO_Port, LD2_Pin);");
  await page.keyboard.press("Enter");
  await page.keyboard.type("HAL_GPIO_T");
  const list = page.locator(".cm-tooltip-autocomplete");
  await expect(list).toBeVisible();
  await expect(list.locator("li", { hasText: "HAL_GPIO_TogglePin" }).first()).toBeVisible();
  await expect(list.locator("li", { hasText: "HAL_GPIO_WritePin" })).toHaveCount(0);
  // Its documentation.
  await expect(page.locator(".cm-completionInfo")).toContainText("Toggles the specified GPIO pins.");
  await list.locator("li", { hasText: "HAL_GPIO_TogglePin" }).first().click(); // take it
  await expect(line(page, "HAL_GPIO_TogglePin").nth(1)).toBeVisible();
  await page.keyboard.type("(");
  const hint = page.getByTestId("signature-hint");
  await expect(hint).toContainText("void HAL_GPIO_TogglePin(GPIO_TypeDef *GPIOx, uint16_t GPIO_Pin)");
  await expect(hint.locator("b")).toHaveText("GPIO_TypeDef *GPIOx");
  await page.keyboard.type("GPIOA, ");
  await expect(hint.locator("b")).toHaveText("uint16_t GPIO_Pin");
  await page.keyboard.press("Escape");
  await setText(page, EDITED);

  // Members after "GPIO_InitStruct.".
  await endOf(page, "GPIO_InitStruct.Pull = GPIO_NOPULL;");
  await page.keyboard.press("Enter");
  await page.keyboard.type("GPIO_InitStruct.");
  await expect(list.locator("li", { hasText: "Speed" })).toBeVisible();
  await expect(list.locator("li", { hasText: "Alternate" })).toBeVisible();
  await page.keyboard.press("Escape");
  // Back to the built text.
  await setText(page, EDITED);
  await expect(buildStatus(page)).not.toContainText("고침");
});

test("a rule suggestion with its why, a syntax error inline and the build blocked", async ({ browser }) => {
  const page = await warmPage(browser);
  // HAL_Delay in an interrupt callback.
  await editor(page).locator(".cm-content").focus();
  await page.keyboard.press("Control+End");
  await page.keyboard.insertText("\nvoid HAL_GPIO_EXTI_Callback(uint16_t GPIO_Pin)\n{\n  HAL_Delay(10);\n}\n");
  const rule = page.getByTestId("problems").locator(".problem", { hasText: "인터럽트 처리 함수 HAL_GPIO_EXTI_Callback 안에서 HAL_Delay" });
  await expect(rule).toBeVisible();
  await expect(rule).toHaveAttribute("data-severity", "warning");
  await rule.getByRole("button", { name: "왜?" }).click();
  await expect(rule.locator(".why-text")).toContainText("SysTick");
  await expect(editor(page).locator(".cm-lintRange-warning")).toHaveCount(1);
  await setText(page, EDITED);
  await expect(rule).toHaveCount(0);

  // A missing ';': inline error at its line, and the running firmware stays.
  const firmwareBefore = await status(page).textContent();
  await endOf(page, "HAL_Delay(120);");
  await page.keyboard.press("Backspace");
  const lineNo = DELAY_LINE;
  await build(page, false);
  const err = page.getByTestId("problems").locator(".problem.p-error").first();
  await expect(err).toHaveAttribute("data-line", String(lineNo));
  await expect(err).toContainText("expected ';'");
  await expect(editor(page).locator(".cm-lintRange-error")).toHaveCount(1);
  await expect(line(page, "HAL_Delay(120)").locator(".cm-lintRange-error")).toHaveCount(1);
  expect((await status(page).textContent())?.split(" · ")[0]).toBe(firmwareBefore?.split(" · ")[0]);
  const period = await ld2Period(page, 600);
  expect(period).toBeLessThan(150); // the earlier 120 ms build still runs

  // Clicking the problem puts the cursor there; fix and rebuild.
  await err.locator(".problem-where").click();
  await expect(editor(page).locator(".cm-activeLine")).toContainText("HAL_Delay(120)");
  await endOf(page, "HAL_Delay(120)");
  await page.keyboard.insertText(";");
  await expect(line(page, "HAL_Delay(120);")).toBeVisible();
  await build(page);
  await expect(page.getByTestId("problems").locator(".problem.p-error")).toHaveCount(0);
});

test("a breakpoint on an edited line stops there; a reload keeps the code and its firmware", async ({ browser }) => {
  const page = await warmPage(browser);
  const lineNo = DELAY_LINE;
  await page.getByRole("button", { name: "소스 (디버그)" }).click();
  await expect(page.getByLabel("소스 파일").locator("option:checked")).toHaveText("Core/Src/main.c");
  await expect(page.locator(`.src-line[data-line='${lineNo}']`)).toContainText("HAL_Delay(120);");
  await page.getByTestId(`gutter-${lineNo}`).click();
  await expect(page.getByTestId(`gutter-${lineNo}`)).toHaveClass(/bp/);
  await expect(page.getByTestId("debug-status")).toContainText("중단점", { timeout: 10_000 });
  await expect(page.locator(".src-line.here")).toHaveAttribute("data-line", String(lineNo));
  await expect(page.locator(".frames li").first()).toContainText("main");
  await page.getByTestId(`gutter-${lineNo}`).click();

  // Autosave: the code, the built firmware and its sources come back.
  await page.waitForTimeout(800);
  await page.reload();
  await expect(status(page)).toContainText("code.elf");
  await openCodeTab(page);
  await expect(line(page, "HAL_Delay(120);")).toBeVisible();
  await expect(buildStatus(page)).toContainText("이 코드로 빌드한 펌웨어");
  await page.getByRole("button", { name: "소스 (디버그)" }).click();
  await expect(page.locator(`.src-line[data-line='${lineNo}']`)).toContainText("HAL_Delay(120);");
});

test("a 'write the code' lesson: start, edit main.c, build, graded as usual", async ({ browser }) => {
  const page = await warmPage(browser);
  page.on("dialog", (d) => void d.accept());
  const panel = page.getByRole("complementary", { name: "실습" });
  await page.getByRole("button", { name: "📝 실습" }).click();
  await panel.locator('[data-lesson="blink-2hz"]').getByRole("button", { name: "시작" }).click();
  await expect(panel.locator(".lesson-title")).toHaveText("내 펌웨어 만들기: 2 Hz 깜빡이");
  await expect(panel.getByTestId("lesson-firmware")).toContainText("코드");
  // The code tab comes forward with the example's main.c.
  await expect(page.getByTestId("code-panel")).toBeVisible();
  await expect(line(page, "HAL_Delay(500);")).toBeVisible();
  await endOf(page, "HAL_Delay(500);");
  for (let i = 0; i < "500);".length; i++) await page.keyboard.press("Backspace");
  await page.keyboard.insertText("250);");
  await build(page);
  await panel.getByRole("button", { name: "채점", exact: true }).click();
  await expect(panel.getByTestId("grade-progress")).toHaveCount(0, { timeout: 30_000 });
  await expect(panel.locator('[data-check="1.1"]')).toHaveAttribute("data-status", "pass");
  await expect(panel.getByTestId("lesson-complete")).toBeVisible();
  await page.getByRole("button", { name: "📝 실습" }).click();
});

test("a share link carries the sources; the receiver builds them", async ({ browser }) => {
  const page = await warmPage(browser);
  await page.getByRole("button", { name: "🔗 공유" }).click();
  const dlg = page.getByRole("dialog", { name: "공유" });
  await expect(dlg.getByTestId("share-code")).toContainText("main.c");
  await expect(dlg.getByTestId("share-summary")).not.toContainText("code.elf");
  const link = await dlg.getByTestId("share-link").inputValue();
  // Sources only: a short link.
  expect(link.length).toBeLessThan(4000);
  await dlg.getByRole("button", { name: "닫기" }).first().click();

  const other = await browser.newContext({ viewport: { width: 1400, height: 820 } });
  try {
    const p2 = await other.newPage();
    await p2.goto(link);
    const recv = p2.getByRole("dialog", { name: "공유 링크 열기" });
    await recv.getByRole("button", { name: "열기" }).click();
    await expect(p2.getByTestId("code-panel")).toBeVisible();
    await expect(line(p2, "HAL_Delay(250);")).toBeVisible();
    await expect(buildStatus(p2)).toContainText("빌드 성공", { timeout: 180_000 });
    await expect(status(p2)).toContainText("code.elf");
  } finally {
    await other.close();
  }
});

test("offline: after '편집기 오프라인으로 받기' the build works with the network off", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 820 } });
  try {
    const page = await context.newPage();
    await page.goto("/");
    await expect(page.getByTestId("offline-status")).toHaveText("오프라인 사용 준비됨", { timeout: 90_000 });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    // The compiler is not in the default offline cache.
    expect(await page.evaluate(() => caches.keys())).toHaveLength(1);
    await startFromBlinky(page);
    await page.locator(".code-menu > summary").click();
    await page.getByTestId("editor-offline").click();
    await expect(page.getByTestId("editor-offline")).toHaveText("✓ 편집기 오프라인 준비됨", { timeout: 120_000 });
    const names = await page.evaluate(() => caches.keys());
    expect(names.some((n) => /^simucleo-editor-[0-9a-f]{12}$/.test(n))).toBe(true);

    await context.setOffline(true);
    await page.reload();
    await expect(status(page)).toContainText(/예제를|·/);
    await openCodeTab(page);
    await endOf(page, "HAL_Delay(500);");
    for (let i = 0; i < "500);".length; i++) await page.keyboard.press("Backspace");
    await page.keyboard.insertText("120);");
    await build(page);
    await expect(status(page)).toContainText("code.elf");
  } finally {
    await context.close();
  }
});
