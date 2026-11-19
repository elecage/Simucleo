import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// M22: the oscilloscope's protocol decoders (on edges the simulator
// synthesizes for USART/I2C pins), analog channels with a level trigger,
// and capture export. Uses the example firmware and projects bundled by
// `npm run examples`.

const status = (page: Page) => page.getByTestId("run-status");
const consoleOut = (page: Page) => page.getByTestId("console-output");
const plot = (page: Page) => page.getByTestId("scope-plot");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
});

async function loadExampleProject(page: Page, name: string) {
  await page.getByLabel("예제 펌웨어").selectOption(`${name}.elf`);
  await expect(status(page)).toContainText(name);
  await page.getByRole("button", { name: "▶ 실행" }).click();
}

async function openScope(page: Page) {
  await page.getByRole("button", { name: "파형 (프로브)" }).click();
}

/** Trigger on `source`, `edge`, in Normal mode at `div` with 10 % before. */
async function trigger(page: Page, source: string, edge: string, div: string) {
  await page.getByLabel("트리거 소스").selectOption(source);
  await page.getByLabel("트리거 에지").selectOption(edge);
  await page.getByLabel("시간/눈금").selectOption({ label: div });
  await page.getByLabel("트리거 위치").fill("10");
  await page.getByLabel("트리거 모드").selectOption("normal");
}

/** Turn the pot's knob from 9 o'clock towards 3 o'clock (`to` in degrees, −90…90). */
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

const mean = (page: Page, spec: string) =>
  page
    .getByTestId(`analog-${spec}`)
    .getAttribute("data-mean")
    .then((v) => Number(v));

test("UART decoder reads the text the firmware prints on PA2 (synthesized frames)", async ({ page }) => {
  await loadExampleProject(page, "hal-shift-register");
  // "Q0-Q7 ...#....  0x08" every 80 ms.
  await expect(consoleOut(page)).toContainText("Q0-Q7", { timeout: 5000 });
  await openScope(page);
  await page.getByLabel("디코더 추가").selectOption("uart");
  // PA2 (USART2 TX, the virtual COM port) is probed with it.
  await expect(page.locator("[data-probe=PA2]")).toBeVisible();
  await expect(page.locator("[data-probe=PA2] .synth")).toHaveText("합성", { timeout: 5000 });
  await trigger(page, "PA2", "falling", "10 ms/div");
  await expect(plot(page)).toHaveAttribute("data-view", "capture", { timeout: 5000 });
  const text = page.getByTestId("decode-text-0");
  await expect(text).toContainText("Q0-Q7", { timeout: 5000 });
  // A whole line as printed: the bar of Q0…Q7 and its value agree.
  const decoded = (await text.textContent())!;
  const [, bar, hex] = decoded.match(/Q0-Q7 ([.#]{8}) {2}0x([0-9A-F]{2})/)!;
  expect([...bar].reduce((v, c, i) => v | (c === "#" ? 1 << i : 0), 0)).toBe(parseInt(hex, 16));
  // No framing errors; ASCII shows the characters in the table.
  const table = page.getByTestId("decode-table-0");
  await expect(table.locator("tr.err")).toHaveCount(0);
  await page.getByLabel("표시 형식").selectOption("ascii");
  await expect(table.locator("td", { hasText: /^Q$/ }).first()).toBeVisible();
  // Boxes over the trace.
  expect(await page.getByTestId("lane-0").locator("rect").count()).toBeGreaterThan(10);
  // At the wrong baud rate it is garbage with errors.
  await page.getByLabel("UART 보드레이트").fill("9600");
  await expect(text).not.toContainText("Q0-Q7");
});

test("I2C decoder shows the BMP280's address 0x76 with W and ACK", async ({ page }) => {
  await loadExampleProject(page, "hal-bmp280");
  await expect(consoleOut(page)).toContainText("BMP280", { timeout: 5000 });
  await openScope(page);
  await page.getByLabel("디코더 추가").selectOption("i2c");
  // SDA falling: a START (the sensor is read once a second).
  await trigger(page, "PB9", "falling", "1 ms/div");
  await expect(plot(page)).toHaveAttribute("data-view", "capture", { timeout: 5000 });
  const table = page.getByTestId("decode-table-0");
  await expect(table).toContainText("0x76 W ACK", { timeout: 5000 });
  await expect(table).toContainText("START");
  await expect(table).toContainText("STOP");
  // Mem_Read: a repeated START, then the address with R.
  await expect(table).toContainText("0x76 R ACK");
  await expect(table).toContainText("재START");
});

test("analog channel on the pot wiper: the mean voltage follows the knob", async ({ page }) => {
  await loadExampleProject(page, "hal-adc-servo");
  await expect(consoleOut(page)).toContainText("pot 2047", { timeout: 5000 }); // knob at 50 %
  await openScope(page);
  await page.getByLabel("아날로그 채널 추가").selectOption("pot.W");
  await expect(page.locator("[data-analog='pot.W']")).toBeVisible();
  // Half of 3.3 V.
  await expect.poll(() => mean(page, "pot.W"), { timeout: 5000 }).toBeGreaterThan(1.6);
  expect(await mean(page, "pot.W")).toBeLessThan(1.7);
  await expect(page.locator("[data-atrace='pot.W'] polyline")).toHaveAttribute("points", /\d/);
  // Turn it to the end: 3.3 V.
  await turnPot(page, -90, 90);
  await expect.poll(() => mean(page, "pot.W"), { timeout: 5000 }).toBeGreaterThan(3.2);
  const row = page.getByTestId("analog-pot.W");
  await expect.poll(async () => Number(await row.getAttribute("data-vpp")), { timeout: 5000 }).toBeLessThan(0.01);
});

test("a level trigger on the analog channel catches the knob going through 2.5 V", async ({ page }) => {
  await loadExampleProject(page, "hal-adc-servo");
  await expect(consoleOut(page)).toContainText("pot 2047", { timeout: 5000 });
  await openScope(page);
  await page.getByLabel("아날로그 채널 추가").selectOption("pot.W");
  // Rising through 2.5 V (0.1 V hysteresis), Single, 20 ms/div.
  await page.getByLabel("트리거 소스").selectOption("V(pot.W)");
  await page.getByLabel("트리거 레벨 (V)").fill("2.5");
  await page.getByLabel("트리거 에지").selectOption("rising");
  await page.getByLabel("시간/눈금").selectOption({ label: "20 ms/div" });
  await page.getByLabel("트리거 모드").selectOption("single");
  await expect(page.getByTestId("scope-state")).toHaveAttribute("data-state", "armed");
  // Nothing happens while the voltage stays at 1.65 V.
  await page.waitForTimeout(500);
  await expect(plot(page)).not.toHaveAttribute("data-view", "capture");
  await turnPot(page, -90, 90);
  await expect(plot(page)).toHaveAttribute("data-view", "capture", { timeout: 5000 });
  await expect(page.getByTestId("scope-state")).toHaveAttribute("data-state", "stopped");
  const row = page.getByTestId("analog-pot.W");
  // Below the level before the trigger, above after.
  expect(Number(await row.getAttribute("data-min"))).toBeLessThan(2.5);
  expect(Number(await row.getAttribute("data-max"))).toBeGreaterThanOrEqual(2.5);
  // The trigger level is drawn on the row.
  await expect(page.locator("[data-atrace='pot.W'] line.alevel")).toHaveCount(1);
  // Turning it back down does not trigger a rising edge (Single anyway).
  const seq = await plot(page).getAttribute("data-seq");
  await turnPot(page, 90, -90);
  await page.waitForTimeout(300);
  await expect(plot(page)).toHaveAttribute("data-seq", seq!);
});

test("a capture exports as VCD and CSV with every channel", async ({ page }) => {
  await loadExampleProject(page, "hal-adc-servo");
  await expect(consoleOut(page)).toContainText("pot 2047", { timeout: 5000 });
  await openScope(page);
  await page.getByLabel("아날로그 채널 추가").selectOption("pot.W");
  await page.getByLabel("프로브 핀 추가").selectOption("PC7");
  // The servo pulse on PC7, 500 µs/div.
  await trigger(page, "PC7", "rising", "500 µs/div");
  await expect(plot(page)).toHaveAttribute("data-view", "capture", { timeout: 5000 });
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "VCD 내보내기" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^simucleo-capture-\d+\.vcd$/);
  const vcd = readFileSync((await file.path())!, "utf8");
  expect(vcd.startsWith("$timescale 1 ns $end")).toBe(true);
  expect(vcd).toContain("$var wire 1 ! PA5 $end");
  expect(vcd).toContain('$var wire 1 " PC7 $end');
  expect(vcd).toContain("$var real 64 # V_pot.W $end");
  expect(vcd).toContain("$enddefinitions $end");
  // The pulse rises at the trigger (10 % into the 5 ms window) and falls
  // about 1.5 ms later (the pot at mid-travel); the wiper sits at 1.65 V.
  expect(vcd).toMatch(/\n#500000\n1"\n/);
  expect(vcd).toMatch(/\n#(1[89]\d{5}|2[01]\d{5})\n0"\n/);
  expect(vcd).toMatch(/\$dumpvars\n[01]!\n0"\nr1\.6\d* #\n\$end/);
  // And as CSV.
  const csvDl = page.waitForEvent("download");
  await page.getByRole("button", { name: "CSV 내보내기" }).click();
  const csv = readFileSync((await (await csvDl).path())!, "utf8").split("\n");
  expect(csv[0]).toBe("time_ns,PA5,PC7,V(pot.W)");
  expect(csv[1]).toMatch(/^-500000,[01],0,1\.6\d*$/);
  expect(csv).toContainEqual(expect.stringMatching(/^0,[01],1,1\.6\d*$/));
});
