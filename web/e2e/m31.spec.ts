import { expect, test, type Browser, type CDPSession, type Page } from "@playwright/test";

// M31: low-spec devices. A slow page thread (CPU throttling of the page)
// switches performance mode on by itself, which lightens the page without
// slowing the simulation; the simulation is the same with the mode off or
// forced on; hidden tabs do not redraw; the device check gives a verdict;
// none of it moves the toolbar or the canvas.

test.describe.configure({ timeout: 120_000 });

const status = (page: Page) => page.getByTestId("run-status");
const perfButton = (page: Page) => page.getByTestId("perf-button");
const popover = (page: Page) => page.getByTestId("perf-popover");

interface Perf {
  mode: string;
  lite: boolean;
  autoOn: boolean;
  hz: number;
  ratio: number | null;
  workerRatio: number | null;
  busy: number;
  uiMs: number;
}
const perf = (page: Page) => page.evaluate(() => (window as unknown as { __simucleoPerf: { get(): Perf } }).__simucleoPerf.get());
const setMode = (page: Page, mode: "auto" | "off" | "on") =>
  page.evaluate((m) => (window as unknown as { __simucleoPerf: { setMode(m: string): void } }).__simucleoPerf.setMode(m), mode);
const renders = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { __simucleoRenders: Record<string, number> }).__simucleoRenders }));

/** A page of its own (no autosave, mode or lesson from an earlier run). */
async function fresh(browser: Browser, baseURL: string | undefined): Promise<Page> {
  const ctx = await browser.newContext({ baseURL, viewport: { width: 1400, height: 820 } });
  return ctx.newPage();
}

async function open(page: Page, elf: string) {
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
  await expect(page.locator(".version").first()).toContainText("core v");
  await page.getByLabel("예제 펌웨어").selectOption(elf);
  await expect(status(page)).toContainText(elf.replace(/\.elf$/, ""));
}

async function throttle(page: Page, rate: number): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  await cdp.send("Performance.enable");
  return cdp;
}

/** Page-thread task time (s) so far, from the browser's own metrics. */
async function taskSeconds(cdp: CDPSession) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return metrics.find((m) => m.name === "TaskDuration")!.value;
}

/** The toolbar's items and the canvas: where they are. */
const layout = (page: Page) =>
  page.evaluate(() => {
    const m = document.querySelector("main")!.getBoundingClientRect();
    const t = document.querySelector(".toolbar")!;
    const items = [...t.children].map((c) => {
      const r = c.getBoundingClientRect();
      return `${r.left},${r.top},${r.width},${r.height}`;
    });
    const body = document.querySelector(".tab-body")!.getBoundingClientRect();
    return `${m.top} ${m.left} ${m.width} ${m.height} ${t.getBoundingClientRect().height} ${body.top} | ${items.join(" ")}`;
  });

test("a slow page thread switches performance mode on by itself, with a notice that moves nothing", async ({ page }) => {
  await open(page, "hal-shift-register.elf");
  await setMode(page, "auto");
  const before = await layout(page);
  await expect(perfButton(page)).toHaveText("⚡ 성능");
  const cdp = await throttle(page, 6);
  await page.getByRole("button", { name: "▶ 실행" }).click();
  // ENTER_MS (3 s) of struggling, after the meters have settled.
  await expect(perfButton(page)).toHaveText("⚡ 성능 모드 켜짐", { timeout: 30_000 });
  await expect(perfButton(page)).toHaveAttribute("data-lite", "1");
  const p = await perf(page);
  expect(p.mode).toBe("auto");
  expect(p.autoOn).toBe(true);
  expect(p.hz).toBeLessThanOrEqual(30);
  expect(await page.locator(".app.perf-lite").count()).toBe(1);
  // The notice, the button and the popover take no room of their own.
  expect(await layout(page)).toBe(before);
  await perfButton(page).click();
  await expect(popover(page)).toBeVisible();
  await expect(popover(page).getByTestId("perf-state")).toHaveText("켜짐 (자동)");
  expect(await layout(page)).toBe(before);
  // Clicking it read the notice: back to the plain label.
  await expect(perfButton(page)).toHaveText("⚡ 성능 모드");
  await popover(page).getByRole("button", { name: "성능 모드 닫기" }).click();
  await expect(popover(page)).toHaveCount(0);
  expect(await layout(page)).toBe(before);
  // Without the throttling the page has room again: auto mode stays on
  // for EXIT_MS at least (hysteresis), not off at the first fast frame.
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await page.waitForTimeout(3000);
  expect((await perf(page)).lite).toBe(true);
});

/**
 * Run `ms` of wall time throttled: the achieved ratio, the page thread's
 * busy share by our meter, and its task time by the browser's.
 */
async function measure(browser: Browser, baseURL: string | undefined, mode: "off" | "on", ms: number) {
  const page = await fresh(browser, baseURL);
  await open(page, "hal-shift-register.elf");
  await setMode(page, mode);
  const cdp = await throttle(page, 6);
  await page.getByRole("button", { name: "▶ 실행" }).click();
  await page.waitForTimeout(2500); // warm up, meters settle
  const t0 = await taskSeconds(cdp);
  const s0 = await page.evaluate(() => performance.now());
  await page.waitForTimeout(ms);
  const t1 = await taskSeconds(cdp);
  const s1 = await page.evaluate(() => performance.now());
  const p = await perf(page);
  await page.getByRole("button", { name: "⏸ 일시정지" }).click();
  await page.context().close();
  return { ratio: p.ratio!, busy: p.busy, lite: p.lite, hz: p.hz, task: (t1 - t0) / ((s1 - s0) / 1000) };
}

test("throttled, performance mode lightens the page thread and keeps the simulation at real time", async ({ browser, baseURL }) => {
  const off = await measure(browser, baseURL, "off", 5000);
  const on = await measure(browser, baseURL, "on", 5000);
  console.log(`off: ${JSON.stringify(off)}\non: ${JSON.stringify(on)}`);
  expect(off.lite).toBe(false);
  expect(on.lite).toBe(true);
  expect(on.hz).toBeLessThanOrEqual(30);
  // The simulation keeps real time either way (it runs in its own thread);
  // performance mode must never make it slower.
  expect(on.ratio).toBeGreaterThan(0.9);
  expect(on.ratio).toBeGreaterThanOrEqual(off.ratio - 0.05);
  // The page thread: mode off is (nearly) saturated, mode on has room.
  expect(off.busy).toBeGreaterThan(0.6);
  expect(on.busy).toBeLessThan(off.busy * 0.75);
  // … and the browser's own task time agrees.
  expect(on.task).toBeLessThan(off.task * 0.75);
});

interface Rec {
  console: string;
  edges: Record<string, [number, boolean][]>;
  last: number;
  frames: number;
}

/** Run until `simMs` of simulated time, recording every frame by simulated time. */
async function record(browser: Browser, baseURL: string | undefined, mode: "off" | "on", rate: number, simMs: number): Promise<Rec & { lite: boolean; hz: number }> {
  const page = await fresh(browser, baseURL);
  await open(page, "freertos-two-tasks.elf");
  await setMode(page, mode);
  await page.evaluate(() => {
    const w = window as unknown as {
      __rec: Rec;
      __simucleoRunner: { onFrame(l: (e: { frame: { timeMs: number; probes: { name: string; edges: [number, boolean][] }[] }; console: string }) => void): () => void; setProbes(p: string[], owner: string): void };
    };
    const rec: Rec = { console: "", edges: {}, last: 0, frames: 0 };
    w.__rec = rec;
    // LD2 and the USART2 TX line (drawn from the bytes sent).
    w.__simucleoRunner.setProbes(["PA5", "PA2"], "m31");
    w.__simucleoRunner.onFrame((e) => {
      rec.console += e.console;
      for (const p of e.frame.probes) (rec.edges[p.name] ??= []).push(...p.edges);
      rec.last = e.frame.timeMs;
      rec.frames++;
    });
  });
  const cdp = await throttle(page, rate);
  await page.getByRole("button", { name: "▶ 실행" }).click();
  await page.waitForFunction((ms) => (window as unknown as { __rec: Rec }).__rec.last >= ms, simMs, { timeout: 60_000 });
  const p = await perf(page);
  await page.getByRole("button", { name: "⏸ 일시정지" }).click();
  const rec = await page.evaluate(() => (window as unknown as { __rec: Rec }).__rec);
  await page.context().close();
  return { ...rec, lite: p.lite, hz: p.hz };
}

test("the simulation is the same with performance mode off and forced on (by simulated time)", async ({ browser, baseURL }) => {
  const off = await record(browser, baseURL, "off", 1, 3000);
  const on = await record(browser, baseURL, "on", 6, 3000);
  expect(off.lite).toBe(false);
  expect(on.lite).toBe(true);
  expect(on.hz).toBeLessThanOrEqual(30);
  // Everything up to the shorter run's end (less a margin: the last frame of each).
  const until = Math.min(off.last, on.last) - 50;
  expect(until).toBeGreaterThan(2500);
  for (const pin of ["PA5", "PA2"]) {
    // (Not the first PA2 edge: the instant the USART takes the pin over is
    // drawn at the start of the run step it happened in, which depends on
    // wall time — a limitation since M22, mode or no mode.)
    const from = (r: Rec) => (pin === "PA2" ? r.edges[pin].slice(1) : r.edges[pin]);
    const a = from(off).filter(([t]) => t < until);
    const b = from(on).filter(([t]) => t < until);
    expect(a.length, `${pin} edges`).toBeGreaterThan(pin === "PA5" ? 2 : 100);
    expect(b).toEqual(a);
  }
  // The console: one run's text is the start of the other's.
  const [short, long] = off.console.length <= on.console.length ? [off.console, on.console] : [on.console, off.console];
  expect(short.length).toBeGreaterThan(50);
  expect(long.startsWith(short)).toBe(true);
});

test("lesson grading gives the same result with performance mode off and forced on", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const gradeWith = async (mode: "off" | "on") => {
    const page = await fresh(browser, baseURL);
    const panel = page.getByRole("complementary", { name: "실습" });
    await page.goto("/");
    await expect(status(page)).toContainText("예제를");
    await setMode(page, mode);
    await page.getByRole("button", { name: "📝 실습" }).click();
    await panel.locator('[data-lesson="knight-rider"]').getByRole("button", { name: "시작" }).click();
    await page.getByTestId("project-input").setInputFiles("public/examples/lesson-knight-rider.simucleo.json");
    await expect(panel.locator(".lesson-check").first()).toBeVisible();
    const cdp = await throttle(page, mode === "on" ? 4 : 1);
    await panel.getByRole("button", { name: "채점", exact: true }).click();
    await expect(panel.getByTestId("grade-progress")).toBeVisible();
    await expect(panel.getByTestId("grade-progress")).toHaveCount(0, { timeout: 90_000 });
    const lite = (await perf(page)).lite;
    await cdp.detach();
    const checks = await panel
      .getByTestId("lesson-check")
      .evaluateAll((l) => l.map((e) => `${e.getAttribute("data-status")} ${e.textContent}`));
    await page.context().close();
    return { checks, lite };
  };
  const off = await gradeWith("off");
  const on = await gradeWith("on");
  expect(off.lite).toBe(false);
  expect(on.lite).toBe(true);
  expect(off.checks.length).toBeGreaterThan(2);
  expect(off.checks.every((c) => c.startsWith("pass"))).toBe(true);
  expect(on.checks).toEqual(off.checks);
});

test("grading in performance mode: keypad presses timed on frames still reach the firmware", async ({ page }) => {
  // Frames batched at a few hertz would bring a 150 ms press and its
  // release to the page together, after the simulation passed both:
  // grading takes single frames instead.
  test.setTimeout(120_000);
  const panel = page.getByRole("complementary", { name: "실습" });
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
  await setMode(page, "on");
  await page.getByRole("button", { name: "📝 실습" }).click();
  await panel.locator('[data-lesson="seven-segment"]').getByRole("button", { name: "시작" }).click();
  await page.getByTestId("project-input").setInputFiles("public/examples/hal-7seg-keypad.simucleo.json");
  await expect(panel.locator(".lesson-check").first()).toBeVisible();
  const cdp = await throttle(page, 4);
  await panel.getByRole("button", { name: "채점", exact: true }).click();
  await expect(panel.getByTestId("grade-progress")).toBeVisible();
  await expect(panel.getByTestId("grade-progress")).toHaveCount(0, { timeout: 90_000 });
  expect((await perf(page)).lite).toBe(true);
  await cdp.detach();
  const checks = await panel
    .getByTestId("lesson-check")
    .evaluateAll((l) => l.map((e) => `${e.getAttribute("data-status")} ${e.textContent}`));
  expect(checks.length).toBeGreaterThan(2);
  expect(checks.filter((c) => !c.startsWith("pass"))).toEqual([]);
});

test("hidden tabs do not redraw while the simulation runs", async ({ page }) => {
  await open(page, "hal-shift-register.elf");
  await setMode(page, "off");
  // Open the waveform view once (it stays mounted), then back to the console.
  await page.getByRole("button", { name: "파형 (프로브)" }).click();
  await page.getByRole("button", { name: "가상 콘솔 (USART2)" }).click();
  const r0 = await renders(page);
  await page.getByRole("button", { name: "▶ 실행" }).click();
  await expect(status(page)).toContainText("실제 ×");
  await page.waitForTimeout(2000);
  const r1 = await renders(page);
  // Frames came (the canvas redrew for them) …
  expect(r1.canvas - r0.canvas).toBeGreaterThan(30);
  // … the hidden source and waveform views did not (a pause or a run state
  // change may redraw them once or twice).
  expect(r1.source - r0.source).toBeLessThanOrEqual(3);
  expect(r1.waveform - r0.waveform).toBeLessThanOrEqual(3);
  // Shown, the waveform view follows the frames again.
  await page.getByRole("button", { name: "파형 (프로브)" }).click();
  await page.waitForTimeout(1000);
  const r2 = await renders(page);
  expect(r2.waveform - r1.waveform).toBeGreaterThan(20);
  // A memoized part redraws only when its own state changes: far fewer
  // part draws than parts × frames.
  const frames = r2.canvas - r0.canvas;
  expect(r2.part - r0.part).toBeLessThan(frames * 20 * 0.5);
});

test("the device check runs three examples and gives a verdict", async ({ page }) => {
  await open(page, "hal-blinky.elf");
  await page.getByRole("button", { name: "▶ 실행" }).click();
  await perfButton(page).click();
  const before = await layout(page);
  await popover(page).getByTestId("device-check-run").click();
  await expect(popover(page).getByTestId("device-verdict")).toBeVisible({ timeout: 60_000 });
  const verdict = await popover(page).getByTestId("device-verdict").textContent();
  expect(verdict).toMatch(/^(충분|성능 모드 권장|느림) — 가장 느린 예제 ×\d/);
  const ratios = await popover(page).getByTestId("device-ratio").allTextContents();
  expect(ratios).toHaveLength(3);
  for (const r of ratios) expect(Number(r.slice(1))).toBeGreaterThan(0);
  // This machine is no Chromebook: the examples run many times real time.
  expect(verdict).toMatch(/^충분/);
  // The simulation that was running runs again.
  await expect(page.getByRole("button", { name: "⏸ 일시정지" })).toBeVisible();
  expect(await layout(page)).toBe(before);
});

test("the mode is kept in this browser", async ({ page }) => {
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
  await perfButton(page).click();
  await expect(popover(page).getByRole("radio", { name: "자동" })).toBeChecked();
  await popover(page).getByRole("radio", { name: "켜기" }).check();
  await expect(popover(page).getByTestId("perf-state")).toHaveText("켜짐");
  await expect(perfButton(page)).toHaveText("⚡ 성능 모드");
  await page.reload();
  await expect(status(page)).toContainText("예제를");
  await expect(perfButton(page)).toHaveText("⚡ 성능 모드");
  await perfButton(page).click();
  await expect(popover(page).getByRole("radio", { name: "켜기" })).toBeChecked();
  await popover(page).getByRole("radio", { name: "끄기" }).check();
  await page.reload();
  await expect(perfButton(page)).toHaveText("⚡ 성능");
  expect((await perf(page)).mode).toBe("off");
});

test("the worker spends most of its time simulating: flat out it gets near the headless speed", async ({ page }) => {
  await open(page, "hal-bldc-pwm.elf");
  // Its headless speed here (the core flat out in a worker, no page).
  const [raw] = await page.evaluate(() =>
    (window as unknown as { __simucleoBench(n: string[], f?: unknown, ms?: number): Promise<{ ratio: number }[]> }).__simucleoBench(["hal-bldc-pwm"], undefined, 3000),
  );
  // The worker computes 12 ms of every 16, so "최대" reaches about ×0.75 of
  // that; before M31 it slept 16 ms after each 12 ms of work: about ×0.43,
  // and a heavy example fell below real time on a machine fast enough for it.
  await page.getByLabel("실행 속도").selectOption("최대");
  await page.getByRole("button", { name: "▶ 실행" }).click();
  await page.waitForTimeout(5000);
  const p = await perf(page);
  console.log(`headless ×${raw.ratio.toFixed(2)}, flat out in the app ×${p.workerRatio!.toFixed(2)}`);
  expect(p.workerRatio! / raw.ratio).toBeGreaterThan(0.6);
});

test("the ratio on the status line is what really happens: simulated time over wall time", async ({ page }) => {
  await open(page, "hal-blinky.elf");
  await page.getByLabel("실행 속도").selectOption("×0.5");
  await page.getByRole("button", { name: "▶ 실행" }).click();
  await page.waitForTimeout(1500);
  const read = async () => {
    const s = (await status(page).textContent())!;
    return { sim: Number(/ · ([\d.]+) s · /.exec(s)![1]), wall: await page.evaluate(() => performance.now()), ratio: Number(/실제 ×([\d.]+)/.exec(s)![1]) };
  };
  const a = await read();
  await page.waitForTimeout(4000);
  const b = await read();
  const real = (b.sim - a.sim) / ((b.wall - a.wall) / 1000);
  expect(Math.abs(real - 0.5)).toBeLessThan(0.05);
  expect(Math.abs(b.ratio - real)).toBeLessThan(0.05);
});
