import { expect, test, type Page } from "@playwright/test";

// M35: RC522 RFID reader on SPI1 with the example firmware hal-rfid-rc522
// (bundled by `npm run examples`). A card dragged onto the antenna is read:
// its UID shows on the console, the key fob lights the green LED.

const status = (page: Page) => page.getByTestId("run-status");
const consoleOut = (page: Page) => page.getByTestId("console-output");
const rfid = "[data-id=rfid]";

async function centre(page: Page, selector: string) {
  const b = (await page.locator(selector).first().boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function drag(page: Page, from: string, to: string) {
  const a = await centre(page, from);
  const b = await centre(page, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
}

const brightness = async (page: Page, id: string) =>
  Number(await page.locator(`[data-id=${id}] [data-brightness]`).first().getAttribute("data-brightness"));

test("RC522: a card placed on the antenna shows its UID on the console", async ({ page }) => {
  test.setTimeout(60000);
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
  await page.getByLabel("예제 펌웨어").selectOption("hal-rfid-rc522.elf");
  await expect(status(page)).toContainText("hal-rfid-rc522");
  await page.getByRole("button", { name: "▶ 실행" }).click();
  await expect(consoleOut(page)).toContainText("MFRC522 version 0x92 (v2.0)", { timeout: 10000 });
  await expect(consoleOut(page)).toContainText("Place a card");
  // The firmware switched the antenna on; no card yet.
  await expect(page.locator(`${rfid} [data-field]`)).toHaveAttribute("data-field", "1");
  await expect(page.locator(`${rfid} [data-card-state]`)).toHaveAttribute("data-card-state", "none");
  await expect(consoleOut(page)).not.toContainText("UID");

  // Drag the key fob from the tray onto the antenna.
  await drag(page, `${rfid} [data-tag="3"]`, `${rfid} [data-antenna]`);
  await expect(page.locator(`${rfid} [data-card]`)).toHaveAttribute("data-card", "3");
  await expect(consoleOut(page)).toContainText("UID: C1 9A 6E 22", { timeout: 10000 });
  await expect(consoleOut(page)).toContainText("access granted");
  await expect(consoleOut(page)).toContainText("block 4: 'Fob: staff #42..'");
  await expect(consoleOut(page)).toContainText("visits: 1 (write block 5: OK)");
  await expect.poll(() => brightness(page, "ledg"), { timeout: 5000 }).toBeGreaterThan(0.3);
  // The firmware halted it after reading (it checks with WUPA that it stays).
  await expect(page.locator(`${rfid} [data-card-state]`)).toHaveAttribute("data-card-state", /halt|ready|active/);
  await page.locator(".canvas-wrap").screenshot({ path: "test-results/m35-rfid.png" });

  // Click it to take it off: the firmware notices, the LED goes out.
  await page.locator(`${rfid} [data-tag="3"]`).click();
  await expect(page.locator(`${rfid} [data-card]`)).toHaveAttribute("data-card", "0");
  await expect(consoleOut(page)).toContainText("card removed", { timeout: 10000 });
  await expect.poll(() => brightness(page, "ledg"), { timeout: 5000 }).toBeLessThan(0.1);

  // Card A (a click puts it on): another UID, denied, the red LED.
  await page.locator(`${rfid} [data-tag="1"]`).click();
  await expect(consoleOut(page)).toContainText("UID: 7A 3B 1C 9D", { timeout: 10000 });
  await expect(consoleOut(page)).toContainText("access denied");
  await expect.poll(() => brightness(page, "ledr"), { timeout: 5000 }).toBeGreaterThan(0.3);
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);

  // The schematic draws the module as a box with its SPI pins.
  await page.getByRole("button", { name: "회로도" }).click();
  await expect(page.locator(".schematic [data-part=rfid]")).toContainText("MFRC522");
  await expect(page.locator(".schematic [data-part=rfid]")).toContainText("MISO");
});
