import { expect, test, type Page } from "@playwright/test";

// M37: the board firmware replacement lab — the FLASH tab, the console's
// XMODEM transfer, and the bootloader example (hal-bootloader with the
// iap-app images to send).

const status = (page: Page) => page.getByTestId("run-status");
const consoleOut = (page: Page) => page.getByTestId("console-output");
const xmodem = (page: Page) => page.getByTestId("xmodem");
const xmStatus = (page: Page) => page.getByTestId("xmodem-status");

async function loadExample(page: Page, file: string) {
  await page.getByLabel("예제 펌웨어").selectOption(file);
  await expect(status(page)).toContainText(file.replace(".elf", ""));
}

async function typeLine(page: Page, text: string) {
  const input = page.getByLabel("콘솔 입력");
  await input.fill(text);
  await input.press("Enter");
}

/** A .bin of `n` bytes for the file input. */
const bin = (name: string, n: number) => ({
  name,
  mimeType: "application/octet-stream",
  // ("U": the echo of the upper-casing firmware below is no protocol byte.)
  buffer: Buffer.alloc(n, 0x55),
});

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
});

test("the FLASH tab shows eight erased sectors and the watchdog off on a fresh board", async ({ page }) => {
  await loadExample(page, "hal-uart-printf.elf");
  await page.getByRole("button", { name: "FLASH" }).click();
  const view = page.getByTestId("flash-view");
  await expect(view).toBeVisible();
  const sectors = page.getByTestId("flash-sector");
  await expect(sectors).toHaveCount(8);
  for (let i = 0; i < 8; i++) {
    await expect(sectors.nth(i)).toHaveAttribute("data-erase-count", "0");
    await expect(sectors.nth(i)).toHaveAttribute("data-programmed", "0");
  }
  // The loaded image is in sector 0 (not programmed by the controller).
  expect(Number(await sectors.nth(0).getAttribute("data-used"))).toBeGreaterThan(1000);
  await expect(sectors.nth(7)).toHaveAttribute("data-used", "0");
  await expect(sectors.nth(0)).toContainText("16 KB");
  await expect(sectors.nth(4)).toContainText("64 KB");
  await expect(sectors.nth(7)).toContainText("128 KB");
  await expect(page.getByTestId("flash-activity")).toHaveAttribute("data-activity", "idle");
  const iwdg = page.getByTestId("iwdg-status");
  await expect(iwdg).toHaveAttribute("data-running", "false");
  await expect(iwdg).toContainText("워치독 리셋 0회");
  await expect(page.getByTestId("reset-cause")).toHaveAttribute("data-cause", "power");
  // Running does not change it (this firmware never erases).
  await page.getByRole("button", { name: "▶ 실행" }).click();
  await expect(status(page)).toContainText("84.0 MHz");
  await expect(sectors.nth(0)).toHaveAttribute("data-erase-count", "0");
  // The reset button is the last reset's cause.
  await page.getByRole("button", { name: "⟲ 리셋" }).click();
  await expect(page.getByTestId("reset-cause")).toHaveAttribute("data-cause", "pin");
});

test("the console's XMODEM control lists uploaded files, starts on 'C' and can be cancelled", async ({ page }) => {
  await loadExample(page, "hal-uart-printf.elf");
  await expect(xmodem(page)).toContainText("파일 보내기 (XMODEM)");
  const select = page.getByLabel("보낼 파일");
  // No example files for this firmware: only the placeholder.
  await expect(select.locator("option")).toHaveCount(1);
  await page.getByTestId("xmodem-file").setInputFiles(bin("app.bin", 1000));
  await expect(select.locator("option", { hasText: "app.bin" })).toHaveCount(1);
  await page.getByTestId("xmodem-file").setInputFiles(bin("other.bin", 300));
  await expect(select.locator("optgroup[label='올린 파일'] option")).toHaveCount(2);
  await expect(select).toHaveValue("up:other.bin");
  await select.selectOption({ label: "app.bin (1000 B)" });

  await page.getByRole("button", { name: "▶ 실행" }).click();
  await expect(consoleOut(page)).toContainText("Hello from Simucleo!", { timeout: 5000 });
  await xmodem(page).getByRole("button", { name: "보내기" }).click();
  await expect(xmStatus(page)).toHaveAttribute("data-state", "waiting");
  // This firmware echoes in upper case: typing "c" sends back the 'C'
  // that starts a CRC transfer (nothing acknowledges the blocks, though).
  await typeLine(page, "c");
  await expect(xmStatus(page)).toHaveAttribute("data-state", "sending", { timeout: 5000 });
  await expect(xmStatus(page)).toContainText(/블록 \d\/8/);
  // The 'C' went to the transfer, not to the console.
  expect(await consoleOut(page).textContent()).not.toMatch(/(^|\n)C\r?\n/);
  await xmodem(page).getByRole("button", { name: "취소" }).click();
  await expect(xmStatus(page)).toHaveAttribute("data-state", "cancelled");
  await expect(xmStatus(page)).toContainText("전송을 취소했습니다");
  await expect(select).toBeEnabled();
});

// The bootloader example's whole story: send v1, then v2, then the bad
// image that the watchdog rolls back. Needs the example's firmware and
// images (firmware/hal-bootloader, firmware/iap-app) built and bundled.
test("the bootloader takes v1 and v2 over XMODEM and rolls back the bad image", async ({ page, request }) => {
  test.setTimeout(240_000);
  const index = await (await request.get("/examples/index.json")).json();
  const ex = (index as { file: string; files?: { file: string }[] }[]).find((e) => e.file === "hal-bootloader.elf");
  const files = new Set((ex?.files ?? []).map((f) => f.file));
  test.skip(
    !ex || !["iap-app-v1.bin", "iap-app-v2.bin", "iap-app-bad.bin"].every((f) => files.has(f)),
    "hal-bootloader.elf or its iap-app images are not bundled (build firmware/hal-bootloader and firmware/iap-app, then npm run examples)",
  );

  await loadExample(page, "hal-bootloader.elf");
  await page.getByRole("button", { name: "▶ 실행" }).click();
  // The menu offers 'u' (update).
  await expect(consoleOut(page)).toContainText(/u/, { timeout: 15_000 });

  const send = async (file: string) => {
    await typeLine(page, "u");
    await expect(consoleOut(page)).toContainText(/XMODEM/i, { timeout: 15_000 });
    await page.getByLabel("보낼 파일").selectOption(`ex:${file}`);
    await xmodem(page).getByRole("button", { name: "보내기" }).click();
    await expect(xmStatus(page)).toHaveAttribute("data-state", "ok", { timeout: 120_000 });
  };

  await send("iap-app-v1.bin");
  await expect(consoleOut(page)).toContainText("app v1", { timeout: 30_000 });
  await page.getByRole("button", { name: "FLASH" }).click();
  await expect(page.getByTestId("flash-sector").nth(4)).not.toHaveAttribute("data-erase-count", "0");
  await page.getByRole("button", { name: "가상 콘솔 (USART2)" }).click();

  // Back in the bootloader (the reset button), v2 replaces v1.
  await page.getByRole("button", { name: "⟲ 리셋" }).click();
  await send("iap-app-v2.bin");
  await expect(consoleOut(page)).toContainText("app v2", { timeout: 30_000 });

  // The bad image never checks in: the watchdog resets, the bootloader rolls back.
  await page.getByRole("button", { name: "⟲ 리셋" }).click();
  await send("iap-app-bad.bin");
  await expect(consoleOut(page)).toContainText("rolled back", { timeout: 60_000 });
  await page.getByRole("button", { name: "FLASH" }).click();
  await expect(page.getByTestId("iwdg-status")).not.toHaveAttribute("data-resets", "0");
});
