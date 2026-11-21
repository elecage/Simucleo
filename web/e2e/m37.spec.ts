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

// The bootloader example's whole story (firmware/hal-bootloader, the
// images from firmware/iap-app; docs/bootloader.md): send v1, then v2 (v1
// goes to the backup slot), then the bad image, which never confirms — the
// watchdog resets it three times and the bootloader rolls back to v2.
test("the bootloader takes v1 and v2 over XMODEM and rolls back the bad image", async ({ page, request }) => {
  test.setTimeout(300_000);
  const index = await (await request.get("/examples/index.json")).json();
  const ex = (index as { file: string; files?: { file: string }[] }[]).find((e) => e.file === "hal-bootloader.elf");
  const files = new Set((ex?.files ?? []).map((f) => f.file));
  test.skip(
    !ex || !["iap-app-v1.bin", "iap-app-v2.bin", "iap-app-bad.bin"].every((f) => files.has(f)),
    "hal-bootloader.elf or its iap-app images are not bundled (build firmware/hal-bootloader and firmware/iap-app, then npm run examples)",
  );
  const out = consoleOut(page);
  const clear = () => page.locator(".console").getByRole("button", { name: "지우기" }).click();
  const tab = (name: string) => page.locator(".bottom .tab", { hasText: name }).click();
  const sector = (n: number) => page.getByTestId("flash-sector").nth(n);

  await loadExample(page, "hal-bootloader.elf");
  // The example's images are offered in the console.
  const select = page.getByLabel("보낼 파일");
  await expect(select.locator("optgroup[label='예제의 파일'] option")).toHaveCount(3);
  await page.getByRole("button", { name: "▶ 실행" }).click();
  await expect(out).toContainText("=== Simucleo bootloader v1.0 ===", { timeout: 15_000 });
  await expect(out).toContainText("reset cause: power-on");
  await expect(out).toContainText("no valid image in slot A");
  await expect(out).toContainText("menu: u = update (XMODEM)", { timeout: 15_000 });

  /** From the menu: 'u', the image over XMODEM, the bootloader checks it. */
  const update = async (file: string, version: string) => {
    await clear();
    await typeLine(page, "u");
    await expect(out).toContainText("erasing slot B...", { timeout: 15_000 });
    await expect(out).toContainText("waiting for XMODEM-CRC upload", { timeout: 15_000 });
    await select.selectOption(`ex:${file}`);
    await xmodem(page).getByRole("button", { name: "보내기" }).click();
    await expect(xmStatus(page)).toHaveAttribute("data-state", "ok", { timeout: 120_000 });
    await expect(xmStatus(page)).toContainText(file);
    await expect(out).toContainText(/received \d+ bytes/, { timeout: 15_000 });
    await expect(out).toContainText(`image OK: app ${version}`, { timeout: 15_000 });
  };
  /** From a running app: 'b' resets into the bootloader, a key stops the boot. */
  const toMenu = async () => {
    await clear();
    await typeLine(page, "b");
    await expect(out).toContainText(/press any key for the menu|menu: u/, { timeout: 15_000 });
    // (The line end after 'b' may already have been the key.)
    if (!(await out.textContent())?.includes("menu: u")) await typeLine(page, "");
    await expect(out).toContainText("menu: u = update (XMODEM)", { timeout: 15_000 });
  };

  // v1 into an empty board.
  await update("iap-app-v1.bin", "v1");
  await expect(out).toContainText("installing app v1 into slot A...", { timeout: 30_000 });
  await expect(out).toContainText("rebooting into app v1 (trial)", { timeout: 30_000 });
  await expect(out).toContainText("app v1 (version 1) running from 0x08020000", { timeout: 30_000 });
  await expect(out).toContainText("confirmed", { timeout: 30_000 });
  await tab("FLASH");
  // Slot B (sector 6) was erased and received the image; slot A (5) holds it now.
  expect(Number(await sector(6).getAttribute("data-erase-count"))).toBeGreaterThanOrEqual(1);
  expect(Number(await sector(5).getAttribute("data-used"))).toBeGreaterThan(10_000);
  await expect(page.getByTestId("iwdg-status")).toHaveAttribute("data-resets", "0");
  await tab("가상 콘솔");

  // v2: v1 goes to the backup slot C.
  await toMenu();
  await update("iap-app-v2.bin", "v2");
  await expect(out).toContainText("backing up slot A (app v1) to slot C...", { timeout: 30_000 });
  await expect(out).toContainText("app v2 (version 2) running from 0x08020000", { timeout: 30_000 });
  await expect(out).toContainText("confirmed", { timeout: 30_000 });

  // The bad image never confirms: three watchdog resets, then the rollback.
  await toMenu();
  await update("iap-app-bad.bin", "v3");
  await expect(out).toContainText("trial boot 1/3 of app v3", { timeout: 30_000 });
  await expect(out).toContainText("app bad (version 3)", { timeout: 30_000 });
  await expect(out).toContainText("app v3 not confirmed after 3 tries: rolling back", { timeout: 60_000 });
  await expect(out).toContainText("rolled back to app v2", { timeout: 60_000 });
  await expect(out).toContainText("app v2 (version 2) running", { timeout: 30_000 });
  await tab("FLASH");
  expect(Number(await page.getByTestId("iwdg-status").getAttribute("data-resets"))).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId("reset-cause")).toHaveAttribute("data-cause", "watchdog");
});
