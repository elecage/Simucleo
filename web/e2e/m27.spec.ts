import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// M27: math channels (A − B of two analog nets, a moving average of a PWM
// pin) and the spectrum view (the FFT of PWM pins: the fundamental at the
// firmware's frequency, the harmonics of the duty's sinc envelope), and
// their settings in the project file. Uses the example firmware and
// projects bundled by `npm run examples`.

const status = (page: Page) => page.getByTestId("run-status");
const plot = (page: Page) => page.getByTestId("scope-plot");
const runButton = (page: Page) => page.getByRole("button", { name: "▶ 실행" });
const consoleOut = (page: Page) => page.getByTestId("console-output");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
});

async function loadExample(page: Page, name: string) {
  await page.getByLabel("예제 펌웨어").selectOption(`${name}.elf`);
  await expect(status(page)).toContainText(name);
}

async function openScope(page: Page) {
  await page.getByRole("button", { name: "파형 (프로브)" }).click();
}

/** A number attribute of a test id. */
const num = (page: Page, id: string, attr: string) =>
  page
    .getByTestId(id)
    .getAttribute(attr)
    .then((v) => Number(v));

/** Turn the pot's knob (degrees, −90…90), as in scope2.spec.ts. */
async function turnPot(page: Page, from: number, to: number) {
  const k = (await page.locator("[data-id=pot] .pot-knob").boundingBox())!;
  const [kx, ky] = [k.x + k.width / 2, k.y + k.height / 2];
  const at = (a: number) => [kx + 40 * Math.sin((a * Math.PI) / 180), ky - 40 * Math.cos((a * Math.PI) / 180)] as const;
  await page.mouse.move(kx, ky);
  await page.mouse.down();
  const step = from < to ? 15 : -15;
  for (let a = from; step > 0 ? a <= to : a >= to; a += step) await page.mouse.move(...at(a));
  await page.mouse.up();
}

/** The harmonic's level relative to the fundamental (dB). */
const dbc = (page: Page, order: number) => num(page, `fft-h${order}`, "data-dbc");

test("math: A − B of the pot wiper and the LDR divider follows the knob", async ({ page }) => {
  await loadExample(page, "hal-adc-servo");
  await runButton(page).click();
  await expect(consoleOut(page)).toContainText("pot 2047", { timeout: 5000 });
  await openScope(page);
  await page.getByLabel("아날로그 채널 추가").selectOption("pot.W");
  await page.getByLabel("아날로그 채널 추가").selectOption("PA1");
  await page.getByRole("button", { name: "수학 채널 추가" }).click();
  // A new math channel is A − B of the first two channels.
  await expect(page.getByLabel("M1 연산")).toHaveValue("sub");
  await expect(page.getByLabel("M1 소스 A")).toHaveValue("V(pot.W)");
  await page.getByLabel("M1 소스 B").selectOption("V(PA1)");
  await expect(page.locator("[data-math=M1]")).toContainText("V(pot.W) − V(PA1)");
  const mean = (id: string) => num(page, `analog-${id}`, "data-mean");
  // The wiper at half of 3.3 V, the divider fixed (LDR at 300 lx).
  await expect.poll(() => mean("pot.W"), { timeout: 5000 }).toBeGreaterThan(1.6);
  const divider = await mean("PA1");
  expect(divider).toBeGreaterThan(0.1);
  expect(divider).toBeLessThan(3);
  await expect.poll(async () => Math.abs((await mean("M1")) - (1.65 - divider)), { timeout: 5000 }).toBeLessThan(0.02);
  expect(Math.abs((await mean("M1")) - ((await mean("pot.W")) - (await mean("PA1"))))).toBeLessThan(1e-6);
  await expect(page.locator("[data-mtrace=M1] polyline")).toHaveAttribute("points", /\d/);
  // Turned to the end: the difference grows by the wiper's 1.65 V; the divider does not move.
  await turnPot(page, -90, 90);
  await expect.poll(() => mean("pot.W"), { timeout: 5000 }).toBeGreaterThan(3.2);
  await expect.poll(() => num(page, "analog-M1", "data-vpp"), { timeout: 5000 }).toBeLessThan(0.01);
  expect(Math.abs((await mean("PA1")) - divider)).toBeLessThan(0.01);
  expect(Math.abs((await mean("M1")) - ((await mean("pot.W")) - divider))).toBeLessThan(0.01);
  expect(await mean("M1")).toBeGreaterThan(3.2 - divider);
  // −A of it, as M2, from M1.
  await page.getByRole("button", { name: "수학 채널 추가" }).click();
  await page.getByLabel("M2 연산").selectOption("neg");
  await page.getByLabel("M2 소스 A").selectOption("M1");
  await expect.poll(async () => (await mean("M2")) + (await mean("M1")), { timeout: 5000 }).toBeCloseTo(0, 6);
  await expect(page.getByRole("button", { name: "수학 채널 추가" })).toBeDisabled();
});

test("math: a moving average over one period of LD2's PWM reads duty × 3.3 V", async ({ page }) => {
  test.setTimeout(60000);
  await loadExample(page, "hal-pwm-led");
  await openScope(page);
  await page.getByLabel("아날로그 채널 추가").selectOption("PA5");
  await page.getByRole("button", { name: "수학 채널 추가" }).click();
  await page.getByLabel("M1 연산").selectOption("avg");
  await page.getByLabel("M1 소스 A").selectOption("V(PA5)");
  // 1 kHz PWM: one period.
  await page.getByLabel("M1 평균 창 (µs)").fill("1000");
  await expect(page.locator("[data-math=M1]")).toContainText("평균 1 ms (V(PA5))");
  // LD2 breathes, 1 % more every 10 ms: a pulse wider than 400 µs is a duty above 40 %.
  await page.getByLabel("트리거 소스").selectOption("PA5");
  await page.getByLabel("트리거 에지").selectOption("rising");
  await page.getByLabel("펄스 폭 조건").selectOption("gt");
  await page.getByLabel("펄스 폭 (µs)").fill("400");
  await page.getByLabel("시간/눈금").selectOption({ label: "1 ms/div" });
  await page.getByLabel("트리거 모드").selectOption("single");
  await runButton(page).click();
  await expect(plot(page)).toHaveAttribute("data-view", "capture", { timeout: 10000 });
  const duty = await num(page, "scope-duty", "data-duty");
  expect(duty).toBeGreaterThan(0.4);
  expect(duty).toBeLessThan(0.45);
  const vHigh = await num(page, "analog-PA5", "data-max");
  const m = { mean: await num(page, "analog-M1", "data-mean"), vpp: await num(page, "analog-M1", "data-vpp") };
  // (The duty may step by 1 % once inside the 10 ms window.)
  expect(Math.abs(m.mean - duty * vHigh)).toBeLessThan(0.035);
  expect(Math.abs(m.mean - duty * 3.3)).toBeLessThan(0.1);
  // Flat: only that one step of 1 % of the high level.
  expect(m.vpp).toBeLessThan(0.035);
  // The net itself swings the whole way.
  expect(await num(page, "analog-PA5", "data-vpp")).toBeGreaterThan(3);
  // The first millisecond (the window filling) is hatched.
  await expect(page.locator("[data-mtrace=M1] rect.scope-invalid")).toHaveCount(1);
  // A shorter window ripples: half a period swings between duty·2 and its mean.
  await page.getByLabel("M1 평균 창 (µs)").fill("500");
  await expect.poll(async () => Math.abs((await num(page, "analog-M1", "data-vpp")) - 2 * duty * vHigh)).toBeLessThan(0.08);
});

test("spectrum: the buzzer's 50 % PWM tone has its fundamental at 262 Hz and no even harmonics", async ({ page }) => {
  test.setTimeout(60000);
  await loadExample(page, "hal-buzzer-melody");
  await openScope(page);
  await page.getByLabel("프로브 핀 추가").selectOption("PA9");
  // The first note (C4: TIM1 at 1 MHz, ARR 3816 − 1, CCR 1908) from its first edge.
  await page.getByLabel("트리거 소스").selectOption("PA9");
  await page.getByLabel("트리거 에지").selectOption("rising");
  await page.getByLabel("시간/눈금").selectOption({ label: "20 ms/div" });
  await page.getByLabel("트리거 위치").fill("10");
  await page.getByLabel("트리거 모드").selectOption("single");
  await page.getByRole("button", { name: "시간 + 스펙트럼" }).click();
  await expect(page.getByRole("button", { name: "시간 + 스펙트럼" })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("스펙트럼 소스").selectOption("PA9");
  await runButton(page).click();
  await expect(plot(page)).toHaveAttribute("data-view", "capture", { timeout: 10000 });
  // Between the cursors (30 ms … 130 ms): only the note, 100 ms → 10 Hz bins.
  await page.getByLabel("커서", { exact: true }).check();
  await page.getByLabel("스펙트럼 구간").selectOption("cursors");
  await expect(page.getByTestId("fft-info")).toHaveAttribute("data-span", "100000000");
  const df = await num(page, "fft-info", "data-df");
  expect(df).toBeCloseTo(10, 6);
  const f = 1e6 / 3816;
  expect(Math.abs((await num(page, "fft-fund", "data-hz")) - f)).toBeLessThan(df);
  expect(await num(page, "fft-dc", "data-v")).toBeCloseTo(1.65, 1);
  // A 50 % square wave: odd harmonics at 1/k, even ones gone.
  for (const k of [2, 4, 6, 8, 10]) expect(await dbc(page, k)).toBeLessThan(-60);
  for (const k of [3, 5, 7]) expect(Math.abs((await dbc(page, k)) - 20 * Math.log10(1 / k))).toBeLessThan(0.5);
  // THD over harmonics 2–10 of an ideal square: √(1/9 + 1/25 + 1/49 + 1/81) = 42.9 %.
  expect(Math.abs((await num(page, "fft-thd", "data-ratio")) - 0.4287)).toBeLessThan(0.01);
  // The peak markers are the odd harmonics.
  const peaks = await page.getByTestId("fft-peaks").locator("tbody tr").evaluateAll((trs) => trs.map((tr) => Number((tr as HTMLElement).dataset.hz)));
  expect(peaks.map((p) => Math.round(p / f))).toEqual([1, 3, 5, 7, 9]);
  // The readout follows the keyboard: P jumps to the next peak, → one bin on.
  const sp = page.getByTestId("spectrum-plot");
  await sp.focus();
  await page.keyboard.press("Home");
  await expect(page.getByTestId("fft-cursor")).toHaveAttribute("data-hz", "0");
  await page.keyboard.press("p");
  const at = () => num(page, "fft-cursor", "data-hz");
  await expect.poll(async () => Math.abs((await at()) - f)).toBeLessThan(df);
  const bin = await at();
  await page.keyboard.press("ArrowRight");
  await expect.poll(at).toBeCloseTo(bin + df, 6);
  // A rectangular window of the same span still finds it; the spectrum alone hides the time plot.
  const fund = page.getByTestId("fft-fund");
  const hannLevel = await fund.getAttribute("data-vrms");
  await page.getByLabel("창 함수").selectOption("rect");
  await expect(fund).not.toHaveAttribute("data-vrms", hannLevel!);
  expect(Math.abs((await num(page, "fft-fund", "data-hz")) - f)).toBeLessThan(df);
  await page.getByRole("button", { name: "스펙트럼 (FFT)" }).click();
  await expect(plot(page)).toBeHidden();
  await page.getByRole("button", { name: "시간", exact: true }).click();
  await expect(page.getByTestId("spectrum")).toHaveCount(0);
  await expect(plot(page)).toBeVisible();
});

test("spectrum: the L298N's 2 kHz 80 % PWM — harmonics on the sinc envelope, 5th and 10th nulled", async ({ page }) => {
  test.setTimeout(60000);
  await loadExample(page, "hal-stepper-l298n");
  await openScope(page);
  await page.getByLabel("프로브 핀 추가").selectOption("PB4");
  await runButton(page).click();
  // (The PWM starts right after the clock and UART setup.)
  await expect.poll(async () => Number(await plot(page).getAttribute("data-now-ms")), { timeout: 5000 }).toBeGreaterThan(100);
  // Armed only now: the PWM runs through the whole window.
  await page.getByLabel("트리거 소스").selectOption("PB4");
  await page.getByLabel("시간/눈금").selectOption({ label: "2 ms/div" });
  await page.getByLabel("트리거 모드").selectOption("single");
  await expect(plot(page)).toHaveAttribute("data-view", "capture", { timeout: 10000 });
  await page.getByRole("button", { name: "시간 + 스펙트럼" }).click();
  await page.getByLabel("스펙트럼 소스").selectOption("PB4");
  await page.getByLabel("창 함수").selectOption("blackman");
  await expect(page.getByTestId("fft-info")).toHaveAttribute("data-df", "50");
  const df = await num(page, "fft-info", "data-df");
  expect(df).toBeCloseTo(50, 6);
  expect(Math.abs((await num(page, "fft-fund", "data-hz")) - 2000)).toBeLessThan(df);
  // Mean of a 0/3.3 V signal high 80 % of the time.
  expect(await num(page, "fft-dc", "data-v")).toBeCloseTo(2.64, 2);
  // |H_k / H_1| = |sin(πk·0.8)| / (k·sin(π·0.8)): zero at k = 5, 10.
  for (const k of [2, 3, 4, 6, 7, 8, 9]) {
    const want = 20 * Math.log10(Math.abs(Math.sin(Math.PI * k * 0.8)) / (k * Math.sin(Math.PI * 0.8)));
    expect(Math.abs((await dbc(page, k)) - want), `H${k}`).toBeLessThan(0.5);
  }
  expect(await dbc(page, 5)).toBeLessThan(-60);
  expect(await dbc(page, 10)).toBeLessThan(-60);
});

test("math and spectrum settings are saved in the project and opened again", async ({ page }) => {
  await loadExample(page, "hal-adc-servo");
  await openScope(page);
  await page.getByLabel("아날로그 채널 추가").selectOption("pot.W");
  await page.getByRole("button", { name: "수학 채널 추가" }).click();
  await page.getByLabel("M1 연산").selectOption("scale");
  await page.getByLabel("M1 배율 k").fill("2");
  await page.getByLabel("M1 더할 값 c (V)").fill("-1.5");
  await page.getByLabel("M1 V/눈금").selectOption({ label: "500 mV/div" });
  await page.getByRole("button", { name: "수학 채널 추가" }).click();
  await page.getByLabel("M2 연산").selectOption("avg");
  await page.getByLabel("M2 소스 A").selectOption("PA5");
  await page.getByLabel("M2 평균 창 (µs)").fill("2500");
  await page.getByRole("button", { name: "스펙트럼 (FFT)" }).click();
  await page.getByLabel("스펙트럼 소스").selectOption("M2");
  await page.getByLabel("창 함수").selectOption("blackman");
  await page.getByLabel("FFT 점 수").selectOption("16384");
  await page.getByLabel("크기 단위").selectOption("lin");
  await page.getByLabel("주파수축").selectOption("log");
  await page.getByLabel("피크 표시 개수").fill("3");
  await page.getByLabel("스펙트럼 구간").selectOption("cursors");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  const file = await (await download).path();
  const saved = JSON.parse(readFileSync(file!, "utf8"));
  expect(saved.scope.math).toEqual([
    { id: 1, op: "scale", a: "V(pot.W)", b: "PA5", gain: 2, bias: -1.5, windowUs: 1000, vdiv: 0.5, offset: 0 },
    { id: 2, op: "avg", a: "PA5", b: "PA5", gain: 1, bias: 0, windowUs: 2500, vdiv: 1, offset: 0 },
  ]);
  expect(saved.scope.spectrum).toEqual({ view: "spectrum", source: "M2", window: "blackman", n: 16384, db: false, logFreq: true, fit: true, peaks: 3, range: "cursors" });

  const shown = async () => ({
    math: await page.locator("[data-math]").evaluateAll((els) => els.map((e) => e.textContent)),
    op1: await page.getByLabel("M1 연산").inputValue(),
    k: await page.getByLabel("M1 배율 k").inputValue(),
    window2: await page.getByLabel("M2 평균 창 (µs)").inputValue(),
    view: await page.getByRole("button", { name: "스펙트럼 (FFT)" }).getAttribute("aria-pressed"),
    source: await page.getByLabel("스펙트럼 소스").inputValue(),
    win: await page.getByLabel("창 함수").inputValue(),
    n: await page.getByLabel("FFT 점 수").inputValue(),
    db: await page.getByLabel("크기 단위").inputValue(),
    axis: await page.getByLabel("주파수축").inputValue(),
    peaks: await page.getByLabel("피크 표시 개수").inputValue(),
    range: await page.getByLabel("스펙트럼 구간").inputValue(),
  });
  const want = await shown();
  expect(want).toMatchObject({ op1: "scale", k: "2", window2: "2500", view: "true", source: "M2", n: "16384", db: "lin", axis: "log", range: "cursors" });
  expect(want.math).toHaveLength(2);

  // Changed after saving…
  await page.getByRole("button", { name: "M2 제거" }).click();
  await page.getByLabel("M1 연산").selectOption("sub");
  await page.getByRole("button", { name: "시간", exact: true }).click();
  await expect(page.getByTestId("spectrum")).toHaveCount(0);
  // … the saved project brings them back.
  await page.getByTestId("project-input").setInputFiles(file!);
  await expect(page.locator("[data-math]")).toHaveCount(2);
  expect(await shown()).toEqual(want);
});
