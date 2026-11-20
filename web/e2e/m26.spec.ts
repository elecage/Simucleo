import { expect, test, type Locator, type Page } from "@playwright/test";

// M26: the content trigger inside the simulator (exact, on time) and the
// NEC (IR) decoder, on the example firmware bundled by `npm run examples`.

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

async function loadExample(page: Page, name: string) {
  await page.getByLabel("예제 펌웨어").selectOption(`${name}.elf`);
  await expect(status(page)).toContainText(name);
}

const openScope = (page: Page) => page.getByRole("button", { name: "파형 (프로브)" }).click();

/** Press and release a button of the IR remote. */
async function press(page: Page, key: string) {
  const el = page.locator(`[data-id=ir] [data-key="${key}"] circle`);
  await el.dispatchEvent("pointerdown", { bubbles: true });
  await page.waitForTimeout(120);
  await el.dispatchEvent("pointerup", { bubbles: true });
}

interface Row {
  kind: string;
  t: number;
  value?: number;
  note?: string;
  error: boolean;
  text: string;
}

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

test("IR remote: the NEC decoder shows the key pressed, an NEC command trigger catches it", async ({ page }) => {
  test.setTimeout(60000);
  await loadExample(page, "hal-ir-remote");
  await openScope(page);
  await page.getByLabel("디코더 추가").selectOption("nec");
  await expect(page.locator("[data-probe=PB3]")).toBeVisible();
  // OK (0x1C) from address 0x00, 10 ms/div with 10 % before, pause.
  await page.getByLabel("트리거 소스").selectOption("dec:1");
  await expect(page.getByLabel("해독 트리거 조건")).toHaveValue("nec");
  await page.getByLabel("해독 트리거 값").fill("0x1C");
  await page.getByLabel("해독 트리거 IR 주소").fill("0x00");
  await page.getByLabel("시간/눈금").selectOption({ label: "10 ms/div" });
  await page.getByLabel("트리거 위치").fill("10");
  await page.getByLabel("트리거 모드").selectOption("single");
  await page.getByLabel("트리거 시 일시정지").check();
  await expect(page.getByTestId("content-mode")).toHaveText("정확(시뮬레이터)");
  await expect(page.getByTestId("content-mode")).toHaveAttribute("data-mode", "exact");
  await runButton(page).click();
  await expect(await consoleOut(page)).toContainText("NEC IR receiver on D3", { timeout: 5000 });
  await openScope(page);

  // Another key: printed, but no capture.
  await press(page, "RIGHT");
  await expect(await consoleOut(page)).toContainText("NEC addr 0x00 cmd 0x5A key RIGHT", { timeout: 5000 });
  await openScope(page);
  await page.waitForTimeout(300);
  await expect(page.getByTestId("scope-state")).toHaveAttribute("data-state", "armed");
  await expect(plot(page)).not.toHaveAttribute("data-view", "capture");

  // OK: captured from its leader, and the run pauses after the window.
  await press(page, "OK");
  await expect(plot(page)).toHaveAttribute("data-view", "capture", { timeout: 10000 });
  await expect(runButton(page)).toBeVisible({ timeout: 5000 });
  await expect(page.getByTestId("scope-state")).toHaveAttribute("data-state", "stopped");
  const rs = await rows(page.getByTestId("decode-table-0"));
  expect(rs.filter((r) => r.error)).toEqual([]);
  const lead = rs.find((r) => r.kind === "leader")!;
  // The leader's mark starts at t = 0, to the cycle.
  expect(Math.abs(lead.t)).toBeLessThan(1);
  expect(lead.value).toBe(0x1c);
  expect(lead.text).toContain("리더 · 주소 0x00 명령 0x1C");
  // Address, ~address, command, ~command after it.
  expect(rs.filter((r) => r.kind === "data").map((r) => [r.value, r.note])).toEqual([
    [0x00, "주소"],
    [0xff, "주소 반전"],
    [0x1c, "명령"],
    [0xe3, "명령 반전"],
  ]);
  const ir = page.getByTestId("decode-ir-0");
  await expect(ir).toHaveAttribute("data-cmd", String(0x1c));
  await expect(ir).toHaveAttribute("data-addr", "0");
  // What the firmware decoded with input capture is the same.
  const out = await (await consoleOut(page)).textContent();
  const m = /NEC addr 0x([0-9A-F]{2}) cmd 0x([0-9A-F]{2}) key OK/.exec(out ?? "")!;
  expect(m).not.toBeNull();
  expect([parseInt(m[1], 16), parseInt(m[2], 16)]).toEqual([0x00, 0x1c]);
});

test("exact content trigger: UART text with pause stops the run, the 't' at t = 0", async ({ page }) => {
  test.setTimeout(60000);
  await loadExample(page, "hal-uart-printf");
  await openScope(page);
  await page.getByLabel("디코더 추가").selectOption("uart");
  await page.getByLabel("트리거 소스").selectOption("dec:1");
  await page.getByLabel("해독 트리거 조건").selectOption("text");
  await page.getByLabel("해독 트리거 값").fill("tick 1");
  await page.getByLabel("시간/눈금").selectOption({ label: "500 µs/div" });
  await page.getByLabel("트리거 위치").fill("20");
  await page.getByLabel("트리거 모드").selectOption("normal");
  await page.getByLabel("트리거 시 일시정지").check();
  // The simulator looks for it.
  const mode = page.getByTestId("content-mode");
  await expect(mode).toHaveText("정확(시뮬레이터)");
  await expect(mode).toHaveAttribute("title", /시뮬레이터가 모든 에지를 해독/);
  await expect(page.getByTestId("scope-state")).toHaveAttribute("data-state", "armed");
  await runButton(page).click();
  await expect(plot(page)).toHaveAttribute("data-view", "capture", { timeout: 10000 });
  // Paused by the trigger, right after the window (tick 1 is printed at ~500 ms, tick 2 not yet).
  await expect(runButton(page)).toBeVisible({ timeout: 5000 });
  const out = await consoleOut(page);
  await expect(out).toContainText("tick 1 at");
  await expect(out).not.toContainText("tick 2");
  await page.getByRole("button", { name: "소스 (디버그)" }).click();
  await expect(page.locator(".source-view")).toContainText("멈춤: 오실로스코프 트리거");
  await openScope(page);
  expect(Number(await plot(page).getAttribute("data-view-start"))).toBe(-1e6);
  const rs = await rows(page.getByTestId("decode-table-0"));
  expect(rs.filter((r) => r.error)).toEqual([]);
  // The 't' starts exactly at t = 0 (the simulator's trigger time is the start bit's edge).
  const first = rs.find((r) => r.kind === "data" && r.t >= 0)!;
  expect(first.t).toBe(0);
  expect(first.value).toBe("t".charCodeAt(0));
  const text = rs.filter((r) => r.t >= 0).map((r) => String.fromCharCode(r.value!)).join("");
  expect(text.startsWith("tick 1 at ")).toBe(true);
});
