import { expect, test, type Page } from "@playwright/test";

// SWV (Serial Wire Viewer): with hal-swv-trace running, the SWV tab shows
// the ITM text, a data trace graph of `wave`, the statistical profile
// (filter() on top) and the exception trace (TIM2 a thousand times a
// second) — and nothing while the trace is off.

const status = (page: Page) => page.getByTestId("run-status");

async function load(page: Page) {
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
  await page.locator('select:has(option[value="hal-swv-trace.elf"])').selectOption("hal-swv-trace.elf");
  await expect(status(page)).toContainText("hal-swv-trace");
  await page.locator("nav.tabs button.tab", { hasText: "SWV" }).click();
}

/** Run for at least `ms` of simulated time; returns how long it actually ran (ms). */
async function runFor(page: Page, ms: number): Promise<number> {
  const t0 = await simMs(page);
  await page.getByRole("button", { name: "▶ 실행" }).click();
  await expect.poll(async () => (await simMs(page)) - t0, { timeout: 30_000, intervals: [50] }).toBeGreaterThan(ms);
  await page.getByRole("button", { name: "⏸ 일시정지" }).click();
  await expect(page.getByRole("button", { name: "▶ 실행" })).toBeVisible();
  return (await simMs(page)) - t0;
}

const simMs = async (page: Page) => {
  const m = /([\d.]+) s ·/.exec((await status(page).textContent()) ?? "");
  return m ? Number(m[1]) * 1000 : 0;
};

test("SWV: ITM console, data graph, profile and exception trace of hal-swv-trace", async ({ page }) => {
  await load(page);
  const swv = page.getByTestId("swv");

  // Off: the program runs, the trace stays empty.
  await runFor(page, 300);
  await expect(swv.getByTestId("swv-itm")).toHaveText("");

  // On, with `wave` traced.
  await swv.getByTestId("swv-on").check();
  await swv.getByRole("button", { name: "데이터 그래프" }).click();
  await swv.getByLabel("추적할 변수 1").fill("wave");
  await swv.getByRole("button", { name: "추적 적용" }).click();
  await expect(swv.locator(".swv-var").first()).toContainText("@0x2000");
  await expect(swv.locator(".swv-var").first()).toContainText("4 B");
  const ran = await runFor(page, 1000);

  // Data trace: wave is written every 5 ms, within −100…100.
  const series = swv.getByTestId("swv-series-0");
  const count = Number(await series.getAttribute("data-count"));
  expect(Math.abs(count - ran / 5)).toBeLessThanOrEqual(3);
  const last = Number((await series.textContent())!.replace("=", "").trim());
  expect(Math.abs(last)).toBeLessThanOrEqual(104);
  await expect(swv.getByTestId("swv-graph").locator("polyline")).toHaveCount(1);

  // ITM console: a line every 100 ms on port 0; port 1 has the words.
  await swv.getByRole("button", { name: "ITM 콘솔" }).click();
  const lines = ((await swv.getByTestId("swv-itm").textContent()) ?? "").split("\n").filter((l) => l.startsWith("loop "));
  expect(Math.abs(lines.length - ran / 100)).toBeLessThanOrEqual(1);

  // Profile: filter() is where the awake core spends its time.
  await swv.getByRole("button", { name: "통계 프로파일" }).click();
  const first = swv.getByTestId("swv-profile").locator("tbody tr").first();
  await expect(first.locator("td").first()).toHaveText("filter");
  await expect(swv.getByTestId("swv-profile")).toContainText("(잠자기: WFI/WFE)");

  // Exception trace: TIM2 about 1000 times a second, once per interrupt.
  await swv.getByRole("button", { name: "예외 추적" }).click();
  const tim2 = swv.locator('[data-exc="TIM2"] td');
  const n = Number(await tim2.nth(1).textContent());
  expect(Math.abs(n - ran)).toBeLessThanOrEqual(2);
  const perSecond = Number(await tim2.nth(2).textContent());
  expect(perSecond).toBeGreaterThan(980);
  expect(perSecond).toBeLessThan(1020);
  await expect(swv.locator('[data-exc="SysTick"]')).toBeVisible();

  // Off again: no more packets.
  await swv.getByTestId("swv-on").uncheck();
  const before = Number(await tim2.nth(1).textContent());
  await runFor(page, 200);
  expect(Number(await swv.locator('[data-exc="TIM2"] td').nth(1).textContent())).toBe(before);
});
