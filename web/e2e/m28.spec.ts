import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// M28: motor windings in the circuit's solve (a bridge output's voltage on
// an analog channel), TIM1 center-aligned PWM with the repetition counter
// (pulses centred on the underflow), and the sensorless BLDC example
// (back-EMF zero crossings). Uses the example firmware and projects bundled
// by `npm run examples`.

const status = (page: Page) => page.getByTestId("run-status");
const consoleOut = (page: Page) => page.getByTestId("console-output");
const plot = (page: Page) => page.getByTestId("scope-plot");
const CYCLE_NS = 1e9 / 84e6;
const RPM = "[data-id=mot] [data-rpm]";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
});

async function loadExampleProject(page: Page, name: string) {
  await page.getByLabel("예제 펌웨어").selectOption(`${name}.elf`);
  await expect(status(page)).toContainText(name);
  await page.getByRole("button", { name: "▶ 실행" }).click();
}

const rpm = async (page: Page) => Number(await page.locator(RPM).first().getAttribute("data-rpm"));

async function setPot(page: Page, position: number) {
  await page.locator("[data-id=pot]").first().click({ force: true });
  await page.getByLabel("position").fill(String(position));
}

/** The exported capture: header and rows of numbers. */
async function exportCsv(page: Page): Promise<{ head: string[]; rows: number[][] }> {
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV 내보내기" }).click();
  const csv = readFileSync((await (await dl).path())!, "utf8").trim().split("\n");
  return { head: csv[0].split(","), rows: csv.slice(1).map((r) => r.split(",").map(Number)) };
}

/** High pulses (rise, fall) of column `c` in the CSV rows. */
function pulses(rows: number[][], c: number): [number, number][] {
  const out: [number, number][] = [];
  let rise: number | null = null;
  for (let i = 1; i < rows.length; i++) {
    const [was, now] = [rows[i - 1][c], rows[i][c]];
    if (!was && now) rise = rows[i][0];
    if (was && !now && rise !== null) {
      out.push([rise, rows[i][0]]);
      rise = null;
    }
  }
  return out;
}

test("an analog channel on a bridge output shows the PWM phase voltage", async ({ page }) => {
  test.setTimeout(60000);
  await loadExampleProject(page, "hal-bldc-pwm");
  await expect(consoleOut(page)).toContainText("rpm", { timeout: 10000 });
  await page.getByRole("button", { name: "파형 (프로브)" }).click();
  await page.getByLabel("프로브 핀 추가").selectOption("PA8");
  await page.getByLabel("프로브 핀 추가").selectOption("PA7");
  await page.getByRole("button", { name: "PA5 제거" }).click();
  await page.getByLabel("아날로그 채널 추가").selectOption("br.OUTA");
  await expect(page.locator("[data-analog='br.OUTA']")).toBeVisible();
  // PA8 rising, 10 µs/div: two PWM periods of the chopping phase.
  await page.getByLabel("트리거 소스").selectOption("PA8");
  await page.getByLabel("트리거 에지").selectOption("rising");
  await page.getByLabel("시간/눈금").selectOption({ label: "10 µs/div" });
  await page.getByLabel("트리거 위치").fill("20");
  await page.getByLabel("트리거 모드").selectOption("single");
  await expect(plot(page)).toHaveAttribute("data-view", "capture", { timeout: 10000 });
  await expect(page.locator("[data-atrace='br.OUTA'] polyline")).toHaveAttribute("points", /\d/);
  const { head, rows } = await exportCsv(page);
  expect(head).toEqual(["time_ns", "PA8", "PA7", "V(br.OUTA)"]);
  // The output is at PVDD (12 V less the switch's drop) while the high
  // side is on, at ground while the low side is — the PWM itself, not
  // an average.
  // (Both off: the dead time, or phase A left floating at a commutation.)
  const on = rows.filter((r) => r[1] === 1);
  const off = rows.filter((r) => r[2] === 1);
  expect(on.length).toBeGreaterThan(3);
  expect(off.length).toBeGreaterThan(3);
  for (const r of on) expect(r[3]).toBeGreaterThan(11);
  for (const r of off) expect(r[3]).toBeLessThan(1);
  // Its mean is the duty × the supply (pot in the middle: 49 %).
  const mean = Number(await page.getByTestId("analog-br.OUTA").getAttribute("data-mean"));
  expect(mean).toBeGreaterThan(4.5);
  expect(mean).toBeLessThan(7.5);
});

test("centre-aligned PWM on the scope: the pulses stay centred when the duty changes", async ({ page }) => {
  test.setTimeout(120000);
  await loadExampleProject(page, "hal-bldc-sensorless");
  await expect(consoleOut(page)).toContainText(/closed duty {2}54 %/, { timeout: 20000 });
  await page.getByRole("button", { name: "파형 (프로브)" }).click();
  await page.getByLabel("프로브 핀 추가").selectOption("PA8");
  await page.getByLabel("프로브 핀 추가").selectOption("PA7");
  await page.getByRole("button", { name: "PA5 제거" }).click();
  await page.getByLabel("트리거 소스").selectOption("PA8");
  await page.getByLabel("트리거 에지").selectOption("rising");
  await page.getByLabel("시간/눈금").selectOption({ label: "50 µs/div" });
  await page.getByLabel("트리거 위치").fill("60");
  // The first pulse wider than 35 µs after the pot goes from 54 % to 87 %:
  // the narrow pulses before it are in the window if the change came
  // while phase A chops (else go back and try again).
  await page.getByLabel("펄스 폭 조건").selectOption("gt");
  await page.getByLabel("펄스 폭 (µs)").fill("35");
  const period = 50000;
  for (let attempt = 0; ; attempt++) {
    expect(attempt).toBeLessThan(8);
    const seq = (await plot(page).getAttribute("data-seq")) ?? "";
    await page.getByLabel("트리거 모드").selectOption("normal");
    await page.getByLabel("트리거 모드").selectOption("single");
    // (What comes before the trigger is recorded from the arming on.)
    await page.waitForTimeout(300);
    await setPot(page, 0.1);
    await expect(plot(page)).not.toHaveAttribute("data-seq", seq, { timeout: 15000 });
    await expect(plot(page)).toHaveAttribute("data-view", "capture");
    const { rows } = await exportCsv(page);
    const p = pulses(rows, 1);
    const w = p.map(([r, f]) => f - r);
    if (w.filter((x) => x < 30000).length < 2 || w.filter((x) => x > 40000).length < 2) {
      await setPot(page, 0.5);
      await page.waitForTimeout(400 + 150 * attempt);
      continue;
    }
    // Every pulse is centred on the 50 µs grid of the underflows but one:
    // the update event (RCR 1, at the underflow) loads the new duty in its
    // middle, so it rises at the old width and falls at the new.
    const c0 = (p[0][0] + p[0][1]) / 2;
    const offGrid = (t: number) => Math.abs(t - c0 - Math.round((t - c0) / period) * period);
    const odd = p.filter(([r, f]) => offGrid((r + f) / 2) > 2 * CYCLE_NS);
    expect(odd.length).toBe(1);
    const [wOld, wNew] = [w[0], w.at(-1)!];
    expect(offGrid(odd[0][0] + wOld / 2)).toBeLessThanOrEqual(2 * CYCLE_NS);
    expect(Math.abs(odd[0][1] - (odd[0][0] + wOld / 2) - wNew / 2)).toBeLessThanOrEqual(2 * CYCLE_NS);
    // The rising edges moved: they are not on one grid.
    expect(p.some(([r]) => offGrid(r + wOld / 2) > 1000)).toBe(true);
    // CH1N (PA7) is centred half a period off, 500 ns after CH1 falls.
    const lows = pulses(rows, 2);
    const last = p.at(-1)!;
    const low = lows.find(([r]) => r > last[1]);
    if (low) {
      expect(Math.abs(low[0] - last[1] - 42 * CYCLE_NS)).toBeLessThanOrEqual(CYCLE_NS);
    }
    await page.locator(".waveform").screenshot({ path: "test-results/m28-centred.png" });
    break;
  }
});

test("sensorless BLDC: aligns, ramps, closes the loop on the zero crossings and follows the pot", async ({ page }) => {
  test.setTimeout(120000);
  await loadExampleProject(page, "hal-bldc-sensorless");
  await expect(consoleOut(page)).toContainText("center-aligned 20 kHz, RCR 1", { timeout: 10000 });
  await expect(consoleOut(page)).toContainText(/ramp {3}duty {2}30 %/, { timeout: 15000 });
  await expect(consoleOut(page)).toContainText(/closed duty {2}54 % {2}rpm 1\d{3} {2}zc \d+/, { timeout: 20000 });
  await expect.poll(async () => rpm(page), { timeout: 10000 }).toBeGreaterThan(1400);
  const mid = await rpm(page);
  expect(mid).toBeLessThan(2000);
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);
  // The floating phase on an analog channel, with the virtual neutral.
  await page.getByRole("button", { name: "파형 (프로브)" }).click();
  await page.getByRole("button", { name: "PA5 제거" }).click();
  // Phase U itself (0–12 V) and, through its divider, against the
  // virtual neutral: the back-EMF slopes through it while U floats.
  for (const [spec, vdiv, offset] of [["mot.U", "5", "6"], ["ru1.2", "0.5", "1"], ["rnu.2", "0.5", "1"]]) {
    await page.getByLabel("아날로그 채널 추가").selectOption(spec);
    await page.getByLabel(`V(${spec}) V/눈금`).selectOption(vdiv);
    await page.getByLabel(`V(${spec}) 오프셋 (V)`).fill(offset);
  }
  await expect(page.locator("[data-atrace='mot.U'] polyline")).toHaveAttribute("points", /\d/);
  await page.getByLabel("트리거 소스").selectOption("V(mot.U)");
  await page.getByLabel("트리거 레벨 (V)").fill("6");
  await page.getByLabel("트리거 에지").selectOption("rising");
  await page.getByLabel("시간/눈금").selectOption({ label: "1 ms/div" });
  await page.getByLabel("트리거 위치").fill("10");
  await page.getByLabel("트리거 모드").selectOption("single");
  await expect(plot(page)).toHaveAttribute("data-view", "capture", { timeout: 10000 });
  // The neutral sits between the rails' divided levels; phase U spans them.
  const row = (spec: string) => page.getByTestId(`analog-${spec}`);
  expect(Number(await row("mot.U").getAttribute("data-max"))).toBeGreaterThan(11);
  expect(Number(await row("mot.U").getAttribute("data-min"))).toBeLessThan(1);
  const n = Number(await row("rnu.2").getAttribute("data-mean"));
  expect(n).toBeGreaterThan(0.2);
  expect(n).toBeLessThan(1.5);
  await page.locator(".canvas-wrap").screenshot({ path: "test-results/m28-sensorless.png" });
  await page.locator(".waveform").screenshot({ path: "test-results/m28-phase.png" });
  // The pot towards 3V3: more duty, faster; towards GND: slower.
  await setPot(page, 0.1);
  await page.getByRole("button", { name: "가상 콘솔 (USART2)" }).click();
  await expect(consoleOut(page)).toContainText(/closed duty {2}8\d %/, { timeout: 10000 });
  await expect.poll(async () => rpm(page), { timeout: 15000 }).toBeGreaterThan(mid * 1.3);
  await setPot(page, 0.9);
  await expect(consoleOut(page)).toContainText(/closed duty {2}2\d %/, { timeout: 10000 });
  await expect.poll(async () => rpm(page), { timeout: 20000 }).toBeLessThan(mid * 0.7);
  expect(await rpm(page)).toBeGreaterThan(200);
  await expect(consoleOut(page)).not.toContainText("lost the rotor");
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);
});
