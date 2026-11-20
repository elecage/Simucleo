import { expect, test, type Locator, type Page } from "@playwright/test";

// M35: two MCP2515 CAN modules on one bus (example hal-can-mcp2515): the
// console shows the frames each node received, the modules their state,
// and the waveform view decodes a frame on can1's CANH.

const status = (page: Page) => page.getByTestId("run-status");
const consoleOut = (page: Page) =>
  page
    .getByRole("button", { name: "가상 콘솔 (USART2)" })
    .click()
    .then(() => page.getByTestId("console-output"));
const plot = (page: Page) => page.getByTestId("scope-plot");
const runButton = (page: Page) => page.getByRole("button", { name: "▶ 실행" });
const openScope = (page: Page) => page.getByRole("button", { name: "파형 (프로브)" }).click();

interface Row {
  kind: string;
  value?: number;
  error: boolean;
  text: string;
}

async function rows(table: Locator): Promise<Row[]> {
  return table.locator("tbody tr").evaluateAll((trs) =>
    trs.map((tr) => {
      const d = (tr as HTMLElement).dataset;
      return {
        kind: d.kind!,
        value: d.value === undefined ? undefined : Number(d.value),
        error: tr.classList.contains("err"),
        text: tr.textContent ?? "",
      };
    }),
  );
}

test("CAN: frames between two MCP2515 modules in the console, a frame decoded on CANH", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
  await page.getByLabel("예제 펌웨어").selectOption("hal-can-mcp2515.elf");
  await expect(status(page)).toContainText("hal-can-mcp2515");
  await expect(page.locator("[data-id=can1]")).toBeVisible();

  // The CAN decoder on can1.CANH (probed as the bus: high = recessive),
  // a content trigger on ID 0x123, one capture.
  await openScope(page);
  await page.getByLabel("디코더 추가").selectOption("can");
  await expect(page.locator("[data-probe='can1.CANH']")).toBeVisible();
  await expect(page.getByLabel("CAN 비트레이트")).toHaveValue("125000");
  await page.getByLabel("트리거 소스").selectOption("dec:1");
  await page.getByLabel("해독 트리거 조건").selectOption("address");
  await page.getByLabel("해독 트리거 값").fill("0x123");
  await page.getByLabel("시간/눈금").selectOption({ label: "100 µs/div" });
  await page.getByLabel("트리거 위치").fill("10");
  await page.getByLabel("트리거 모드").selectOption("single");
  await expect(page.getByTestId("content-mode")).toHaveAttribute("data-mode", "exact");

  await runButton(page).click();
  const out = await consoleOut(page);
  await expect(out).toContainText("node A normal mode, node B normal mode", { timeout: 10_000 });
  await expect(out).toContainText("B <- 0x123 [2] 00 03", { timeout: 10_000 });
  await expect(out).toContainText("A <- 0x18FF1234 [4] B0 0B 00");
  await expect(out).not.toContainText("TEC");

  // The modules: normal mode, 125 kbit/s, no errors, frames counted.
  const can2 = page.locator("[data-id=can2] [data-can-mode]");
  await expect(can2).toHaveAttribute("data-can-mode", "normal");
  await expect(can2).toHaveAttribute("data-can-state", "error-active");
  await expect(can2).toHaveAttribute("data-tec", "0");
  expect(Number(await can2.getAttribute("data-rx"))).toBeGreaterThan(2);
  await expect(page.locator("[data-id=can1] [data-testid=can-status]")).toContainText("정상 모드 · 125 kbit/s · TEC 0 REC 0");

  // The capture: SOF, ID 0x123, DLC 2, two data bytes, CRC, ACK, EOF.
  await openScope(page);
  await expect(plot(page)).toHaveAttribute("data-view", "capture", { timeout: 10_000 });
  await expect(page.getByTestId("scope-state")).toHaveAttribute("data-state", "stopped");
  const rs = await rows(page.getByTestId("decode-table-0"));
  const frame = rs.slice(rs.findIndex((r) => r.kind === "address" && r.value === 0x123) - 1);
  expect(frame.slice(0, 8).map((r) => r.kind)).toEqual(["sof", "address", "dlc", "data", "data", "crc", "ack", "eof"]);
  expect(frame.slice(0, 8).filter((r) => r.error)).toEqual([]);
  expect(frame[1].text).toContain("ID 0x123");
  expect(frame[2].value).toBe(2);
  expect(frame[3].value).toBe(0);
  await page.screenshot({ path: "test-results/can-scope.png" });
});
