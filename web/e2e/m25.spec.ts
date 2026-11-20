import { readFileSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";

// M25: the 1-Wire, TM1637 and WS2812 decoders on the example firmware, the
// trigger on decoded content, and the waveform settings kept in the
// project file. Uses the example firmware and projects bundled by
// `npm run examples`.

const status = (page: Page) => page.getByTestId("run-status");
/** The console (its tab is opened: the waveform view stays as it is). */
const consoleOut = (page: Page) =>
  page
    .getByRole("button", { name: "가상 콘솔 (USART2)" })
    .click()
    .then(() => page.getByTestId("console-output"));
const plot = (page: Page) => page.getByTestId("scope-plot");
const runButton = (page: Page) => page.getByRole("button", { name: "▶ 실행" });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
});

/** Load an example (its project and firmware), not running yet. */
async function loadExample(page: Page, name: string) {
  await page.getByLabel("예제 펌웨어").selectOption(`${name}.elf`);
  await expect(status(page)).toContainText(name);
}

async function openScope(page: Page) {
  await page.getByRole("button", { name: "파형 (프로브)" }).click();
}

/** Trigger on what decoder 1 decodes: `value` (a byte, unless `kind` says otherwise). */
async function contentTrigger(page: Page, o: { value: string; kind?: string; div: string; pre: number; mode: string; pause?: boolean }) {
  await page.getByLabel("트리거 소스").selectOption("dec:1");
  if (o.kind) await page.getByLabel("해독 트리거 조건").selectOption(o.kind);
  await page.getByLabel("해독 트리거 값").fill(o.value);
  await page.getByLabel("시간/눈금").selectOption({ label: o.div });
  await page.getByLabel("트리거 위치").fill(String(o.pre));
  await page.getByLabel("트리거 모드").selectOption(o.mode);
  if (o.pause) await page.getByLabel("트리거 시 일시정지").check();
}

interface Row {
  kind: string;
  t: number;
  value?: number;
  note?: string;
  error: boolean;
  text: string;
}

/** The rows of a decoded table. */
async function rows(table: Locator): Promise<Row[]> {
  return table.locator("tbody tr").evaluateAll((trs) =>
    trs.map((tr) => {
      const d = (tr as HTMLElement).dataset;
      return {
        kind: d.kind!,
        t: Number(d.t),
        value: d.value === undefined ? undefined : Number(d.value),
        note: d.note,
        error: tr.classList.contains("err"),
        text: tr.textContent ?? "",
      };
    }),
  );
}

/** The data row starting at the trigger (t = 0). */
const atTrigger = (rs: Row[], tol: number) => rs.find((r) => (r.kind === "data" || r.kind === "pixel") && Math.abs(r.t) <= tol);

test("DS18B20: reset and presence, SKIP ROM, CONVERT T, then READ SCRATCHPAD by content trigger", async ({ page }) => {
  test.setTimeout(60000);
  await loadExample(page, "hal-sonar-onewire");
  await openScope(page);
  await page.getByLabel("디코더 추가").selectOption("onewire");
  await expect(page.locator("[data-probe=PA10]")).toBeVisible();
  // CONVERT T (0x44), with 3 ms before it for the reset and SKIP ROM.
  await contentTrigger(page, { value: "0x44", div: "1 ms/div", pre: 30, mode: "single" });
  await runButton(page).click();
  await expect(plot(page)).toHaveAttribute("data-view", "capture", { timeout: 10000 });
  await expect(page.getByTestId("scope-state")).toHaveAttribute("data-state", "stopped");
  const table = page.getByTestId("decode-table-0");
  let rs = await rows(table);
  expect(rs.filter((r) => r.error)).toEqual([]);
  const conv = atTrigger(rs, 1)!;
  expect(conv).toMatchObject({ value: 0x44, note: "CONVERT T" });
  const before = rs.filter((r) => r.t < conv.t);
  expect(before.map((r) => [r.kind, r.value, r.note])).toEqual([
    ["reset", undefined, undefined],
    ["data", 0xcc, "SKIP ROM"],
  ]);
  expect(before[0].text).toContain("리셋·프레즌스");
  // A reset is 480 µs low and the device answers; a byte is eight 70 µs slots.
  expect(before[1].t - before[0].t).toBeGreaterThan(480e3 + 60e3);
  expect(conv.t - before[1].t).toBeGreaterThan(8 * 60e3);
  expect(conv.t - before[1].t).toBeLessThan(8 * 80e3);
  // Boxes over the trace.
  expect(await page.getByTestId("lane-0").locator("rect").count()).toBe(3);

  // READ SCRATCHPAD (0xBE): the nine bytes read back hold the temperature the firmware prints.
  await page.getByLabel("해독 트리거 값").fill("0xBE");
  await expect(plot(page)).toHaveAttribute("data-view", "capture", { timeout: 10000 });
  rs = await rows(table);
  expect(rs.filter((r) => r.error)).toEqual([]);
  const read = atTrigger(rs, 1)!;
  expect(read).toMatchObject({ value: 0xbe, note: "READ SCRATCHPAD" });
  expect(rs.filter((r) => r.t < read.t).map((r) => [r.kind, r.note])).toEqual([
    ["reset", undefined],
    ["data", "SKIP ROM"],
  ]);
  const pad = rs.filter((r) => r.note?.startsWith("스크래치패드"));
  expect(pad.map((r) => r.note)).toEqual(Array.from({ length: 9 }, (_, i) => `스크래치패드 ${i}`));
  const raw = (pad[1].value! << 8) | pad[0].value!;
  const t16 = raw >= 0x8000 ? raw - 0x10000 : raw;
  const t100 = Math.trunc((t16 * 100) / 16);
  const text = `${t100 < 0 ? "-" : ""}${Math.trunc(Math.abs(t100) / 100)}.${String(Math.abs(t100) % 100).padStart(2, "0")} C`;
  await expect(await consoleOut(page)).toContainText(`temperature ${text}`, { timeout: 5000 });
});

test("TM1637: the data command, address 0xC0 and the digits the display shows", async ({ page }) => {
  test.setTimeout(60000);
  await loadExample(page, "hal-tm1637-clock");
  await openScope(page);
  await page.getByLabel("디코더 추가").selectOption("tm1637");
  await expect(page.locator("[data-probe=PB3]")).toBeVisible();
  // The address command; the data command comes before it. Pause there:
  // the next write is 500 ms later, so the display keeps these digits.
  await contentTrigger(page, { value: "0xC0", div: "200 µs/div", pre: 30, mode: "single", pause: true });
  await runButton(page).click();
  await expect(plot(page)).toHaveAttribute("data-view", "capture", { timeout: 10000 });
  await expect(runButton(page)).toBeVisible({ timeout: 5000 });
  const rs = await rows(page.getByTestId("decode-table-0"));
  expect(rs.filter((r) => r.error)).toEqual([]);
  const addr = atTrigger(rs, 1)!;
  expect(addr).toMatchObject({ value: 0xc0, note: "주소 0" });
  const data = rs.filter((r) => r.kind === "data");
  const i = data.indexOf(addr);
  expect(data[i - 1]).toMatchObject({ value: 0x40, note: "데이터 명령: 쓰기, 주소 자동 증가" });
  expect(data[i - 1].t).toBeLessThan(0);
  // Four segment bytes and the display control.
  const digits = data.slice(i + 1, i + 5);
  expect(digits.map((r) => r.note!.slice(0, 4))).toEqual(["자리 0", "자리 1", "자리 2", "자리 3"]);
  expect(data[i + 5]).toMatchObject({ value: 0x8f, note: "표시 켜기, 밝기 7" });
  // Every byte acknowledged (" A"), STARTs and STOPs around them.
  expect(data.every((r) => / A( |$)/.test(r.text))).toBe(true);
  expect(rs.filter((r) => r.kind === "start").length).toBe(rs.filter((r) => r.kind === "stop").length);
  // What the display shows: the same segments.
  const hex = digits.map((r) => r.value!.toString(16).padStart(2, "0")).join(",");
  await expect(page.locator("[data-id=disp] [data-digits]")).toHaveAttribute("data-digits", hex);
  const shown = page.getByTestId("decode-display-0");
  const text = (await shown.getAttribute("data-text"))!;
  expect(text).toMatch(/^\d\d[: ]\d\d$/);
  expect(await page.locator("[data-id=disp] [data-colon]").first().getAttribute("data-colon")).toBe(text[2] === ":" ? "1" : "0");
  // With the colon on, the firmware prints the same mm:ss.
  if (text[2] === ":") await expect(await consoleOut(page)).toContainText(text);
  await openScope(page);
  // Paused by the trigger.
  await page.getByRole("button", { name: "소스 (디버그)" }).click();
  await expect(page.locator(".source-view")).toContainText("오실로스코프 트리거");
});

test("NeoPixel chain: the decoded GRB frame is what the ring and the strip show", async ({ page }) => {
  test.setTimeout(60000);
  await loadExample(page, "hal-neopixel-chain");
  await openScope(page);
  await page.getByLabel("디코더 추가").selectOption("ws2812");
  await expect(page.locator("[data-probe=PB4]")).toBeVisible();
  // The end of a frame: the falling edge before a low wider than 40 µs.
  // That is known only when the low ends (the next frame, 20 ms later),
  // so the window runs 45 ms past it, over two more frames, and the
  // simulation pauses at its end, 20 ms before the frame after them.
  await page.getByLabel("트리거 소스").selectOption("PB4");
  await page.getByLabel("트리거 에지").selectOption("falling");
  await page.getByLabel("펄스 폭 조건").selectOption("gt");
  await page.getByLabel("펄스 폭 (µs)").fill("40");
  await page.getByLabel("시간/눈금").selectOption({ label: "5 ms/div" });
  await page.getByLabel("트리거 위치").fill("10");
  await page.getByLabel("트리거 모드").selectOption("single");
  // Running (the first such edge is PB4 becoming an output), then arm with
  // the pause.
  await runButton(page).click();
  await expect(await consoleOut(page)).toContainText("ring (12) -> DOUT -> strip (8)", { timeout: 8000 });
  await openScope(page);
  await page.getByLabel("트리거 시 일시정지").check();
  await expect(plot(page)).toHaveAttribute("data-view", "capture", { timeout: 10000 });
  await expect(runButton(page)).toBeVisible({ timeout: 5000 });
  const rs = await rows(page.getByTestId("decode-table-0"));
  expect(rs.filter((r) => r.error)).toEqual([]);
  // Three frames of 20 pixels (12 on the ring, 8 on the strip), numbered from each reset.
  const pixels = rs.filter((r) => r.kind === "pixel");
  // (On a mismatch: where each row of the table is, in µs from the trigger.)
  const where = rs.map((r) => `${r.kind === "pixel" ? r.text.match(/#(\d+) #/)?.[1] : r.kind}@${Math.round(r.t / 1000)}`).join(" ");
  expect(pixels.map((r) => r.text.match(/#(\d+) #/)?.[1]), where).toEqual(
    Array.from({ length: 60 }, (_, i) => String(i % 20)),
  );
  expect(rs.filter((r) => r.kind === "reset").length).toBe(3);
  const frame = (await page.getByTestId("decode-frame-0").getAttribute("data-colors"))!.toLowerCase().split(" ");
  expect(frame.length).toBe(20);
  // The table has the same colours, as G, R, B went out.
  expect(pixels.slice(40).map((r) => "#" + r.value!.toString(16).padStart(6, "0"))).toEqual(frame);
  const colours = (id: string) =>
    page.locator(`[data-id=${id}] [data-led]`).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.color!.toLowerCase()));
  const ring = await colours("ring");
  const strip = await colours("strip");
  expect([ring.length, strip.length]).toEqual([12, 8]);
  expect([...ring, ...strip]).toEqual(frame);
  // Lit: the rainbow on the ring, the comet's head on the strip.
  expect(ring.every((c) => c !== "#000000")).toBe(true);
  expect(strip.some((c) => c !== "#000000")).toBe(true);
});

test("a content trigger on UART text captures around that text", async ({ page }) => {
  test.setTimeout(60000);
  await loadExample(page, "hal-uart-printf");
  await openScope(page);
  await page.getByLabel("디코더 추가").selectOption("uart");
  await contentTrigger(page, { kind: "text", value: "tick 1", div: "1 ms/div", pre: 50, mode: "normal" });
  await expect(page.getByTestId("scope-state")).toHaveAttribute("data-state", "armed");
  await runButton(page).click();
  await expect(await consoleOut(page)).toContainText("tick 1 at", { timeout: 8000 });
  await openScope(page);
  await expect(plot(page)).toHaveAttribute("data-view", "capture", { timeout: 10000 });
  expect(Number(await plot(page).getAttribute("data-view-start"))).toBe(-5e6);
  const rs = await rows(page.getByTestId("decode-table-0"));
  // The frame at t = 0 (within a bit time) is the 't' of "tick 1".
  const bit = 1e9 / 115200;
  const first = atTrigger(rs, bit / 2)!;
  expect(first.value).toBe("t".charCodeAt(0));
  const after = rs.filter((r) => r.t >= first.t).map((r) => String.fromCharCode(r.value!));
  expect(after.join("")).toMatch(/^tick 1 at \d+ ms\r\n$/);
  // Before it: the end of nothing else (tick 0 was 250 ms earlier).
  expect(rs.filter((r) => r.t < first.t)).toEqual([]);
  expect(rs.filter((r) => r.error)).toEqual([]);
  await expect(page.getByTestId("decode-text-0")).toContainText("tick 1 at");
  // Another text that is never printed: nothing new is captured.
  const seq = await plot(page).getAttribute("data-seq");
  await page.getByLabel("해독 트리거 값").fill("tock");
  await expect(plot(page)).toHaveAttribute("data-view", "waiting");
  await page.waitForTimeout(500);
  await expect(plot(page)).toHaveAttribute("data-view", "waiting");
  expect(seq).not.toBeNull();
  // A condition that does not parse is shown.
  await page.getByLabel("해독 트리거 조건").selectOption("byte");
  await page.getByLabel("해독 트리거 값").fill("zz");
  await expect(page.getByTestId("content-invalid")).toBeVisible();
});

test("the waveform settings are saved in the project, opened again and autosaved", async ({ page }) => {
  test.setTimeout(60000);
  await loadExample(page, "hal-uart-printf");
  await openScope(page);
  await page.getByLabel("프로브 핀 추가").selectOption("PA10");
  await page.getByLabel("아날로그 채널 추가").selectOption("PA0");
  await page.getByLabel("V(PA0) V/눈금").selectOption({ label: "500 mV/div" });
  await page.getByLabel("디코더 추가").selectOption("tm1637");
  await page.getByLabel("디코더 추가").selectOption("uart");
  await page.getByLabel("UART 보드레이트").fill("9600");
  await page.getByLabel("시간/눈금").selectOption({ label: "5 ms/div" });
  await page.getByLabel("트리거 소스").selectOption("dec:2");
  await page.getByLabel("해독 트리거 조건").selectOption("text");
  await page.getByLabel("해독 트리거 값").fill("tick");
  await page.getByLabel("트리거 모드").selectOption("single");
  await page.getByLabel("트리거 위치").fill("30");
  await page.getByLabel("트리거 시 일시정지").check();
  await page.getByLabel("표시 형식").selectOption("ascii");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  const file = await (await download).path();
  const saved = JSON.parse(readFileSync(file!, "utf8"));
  expect(saved.scope.pins).toEqual(["PA5", "PA10", "PB3", "PA2"]);
  expect(saved.scope.analog).toEqual([{ spec: "PA0", vdiv: 0.5, offset: 1.65 }]);
  expect(saved.scope.decoders.map((d: { id: number; type: string; pins: string[]; baud: number }) => [d.id, d.type, d.pins, d.baud])).toEqual([
    [1, "tm1637", ["PA10", "PB3"], 115200],
    [2, "uart", ["PA2"], 9600],
  ]);
  expect(saved.scope.divNs).toBe(5e6);
  expect(saved.scope.fmt).toBe("ascii");
  expect(saved.scope.trigger).toMatchObject({ source: "dec:2", mode: "single", pre: 0.3, pause: true, content: { kind: "text", text: "tick" } });

  /** The settings as the view shows them. */
  const shown = async () => ({
    probes: await page.locator("[data-probe]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.probe)),
    analog: await page.locator("[data-analog]").evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.analog)),
    vdiv: await page.getByLabel("V(PA0) V/눈금").inputValue(),
    decoders: await page.locator(".decoder-cfg > b").allTextContents(),
    baud: await page.getByLabel("UART 보드레이트").inputValue(),
    div: await page.getByLabel("시간/눈금").locator("option:checked").textContent(),
    source: await page.getByLabel("트리거 소스").inputValue(),
    kind: await page.getByLabel("해독 트리거 조건").inputValue(),
    value: await page.getByLabel("해독 트리거 값").inputValue(),
    mode: await page.getByLabel("트리거 모드").inputValue(),
    pre: await page.getByLabel("트리거 위치").inputValue(),
    pause: await page.getByLabel("트리거 시 일시정지").isChecked(),
    fmt: await page.getByLabel("표시 형식").inputValue(),
  });
  const want = {
    probes: ["PA5", "PA10", "PB3", "PA2"],
    analog: ["PA0"],
    vdiv: "0.5",
    decoders: ["TM1637", "UART"],
    baud: "9600",
    div: "5 ms/div",
    source: "dec:2",
    kind: "text",
    value: "tick",
    mode: "single",
    pre: "30",
    pause: true,
    fmt: "ascii",
  };
  expect(await shown()).toEqual(want);

  // Changed after saving…
  await page.getByRole("button", { name: "디코더 1 제거" }).click();
  await page.getByRole("button", { name: "디코더 1 제거" }).click();
  await page.getByLabel("시간/눈금").selectOption({ label: "1 µs/div" });
  await page.locator("[data-probe=PA10] button").click();
  await expect(page.locator(".decoder-cfg")).toHaveCount(0);
  // … the saved project brings them back …
  await page.getByTestId("project-input").setInputFiles(file!);
  await expect(page.locator(".decoder-cfg")).toHaveCount(2);
  expect(await shown()).toEqual(want);
  // … and so does the autosave after a reload.
  await page.waitForTimeout(800);
  await page.reload();
  await expect(status(page)).toContainText("hal-uart-printf");
  await openScope(page);
  await expect(page.locator(".decoder-cfg")).toHaveCount(2);
  expect(await shown()).toEqual(want);
  // A project without them (older, or an example) keeps the view as it is
  // and saves it along.
  const old = { ...saved, name: "옛 프로젝트" };
  delete old.scope;
  await page.getByTestId("project-input").setInputFiles({
    name: "old.simucleo.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(old)),
  });
  await expect(page.getByLabel("프로젝트 이름")).toHaveValue("옛 프로젝트");
  expect(await shown()).toEqual(want);
  const again = page.waitForEvent("download");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  expect(JSON.parse(readFileSync((await (await again).path())!, "utf8")).scope).toEqual(saved.scope);
});
