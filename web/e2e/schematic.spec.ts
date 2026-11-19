import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

// M12: the schematic generated from the wiring.

const status = (page: Page) => page.getByTestId("run-status");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
});

async function openSchematic(page: Page, example: string) {
  await page.getByLabel("예제 펌웨어").selectOption(`${example}.elf`);
  await expect(status(page)).toContainText(example);
  await page.getByRole("group", { name: "보기" }).getByRole("button", { name: "회로도" }).click();
  await expect(page.locator("svg.schematic")).toBeVisible();
}

test("the schematic shows parts by symbol and nets by MCU signal", async ({ page }) => {
  await openSchematic(page, "hal-pwm-led");
  const sch = page.locator("svg.schematic");
  // The board shows only the signals in use, with their Arduino names.
  const mcu = sch.locator("[data-part=nucleo]");
  await expect(mcu).toContainText("STM32F401RE");
  await expect(mcu).toContainText("PB3 (D3)");
  await expect(mcu).toContainText("PB10 (D6)");
  await expect(mcu).not.toContainText("PA0");
  // Three resistors as resistor symbols with their values, the RGB LED as a box.
  await expect(sch.locator(".sym-resistor")).toHaveCount(3);
  await expect(sch.locator("[data-part=rR]")).toContainText("220 Ω");
  await expect(sch.locator("[data-part=rgb1].sym-box")).toBeVisible();
  // PB3 joins the board and rR: one label at each end; GND as ground symbols.
  await expect(sch.locator(".net-end[data-net=PB3]")).toHaveCount(2);
  expect(await sch.locator(".net-end[data-net=GND]").count()).toBeGreaterThanOrEqual(2);
  // No breadboard in a schematic.
  await expect(sch.locator("[data-part=bb1]")).toHaveCount(0);

  // Hovering a label lights the whole net and lists its pins.
  await sch.locator("[data-part=rR] .net-end[data-net=N1]").hover();
  await expect(sch.locator(".net-end.lit")).toHaveCount(2);
  await expect(page.getByTestId("net-info")).toContainText("N1: rR.1, rgb1.R");

  // Clicking a symbol selects the part for the inspector.
  await sch.locator("[data-part=rG] .sym-title").click();
  await expect(page.locator(".inspector")).toContainText("rG · 저항");

  // Running: nets on MCU pins show their level (PWM here).
  await page.getByRole("button", { name: "▶ 실행" }).click();
  // (Stubs are horizontal lines: zero-height boxes, so count them.)
  await expect(sch.locator(".sym-stub.pwm")).not.toHaveCount(0, { timeout: 5000 });
  await page.screenshot({ path: "test-results/m12-schematic.png" });

  // The picture saved is the view on screen: the schematic.
  await page.getByRole("button", { name: "⏸ 일시정지" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "SVG", exact: true }).click();
  const svg = readFileSync((await (await download).path())!, "utf8");
  expect(svg).toContain("sym-resistor");
  expect(svg).toContain('class="schematic"');
  expect(svg).not.toContain('data-part="bb1"');

  // Back to the breadboard: the editor is as it was.
  await page.getByRole("group", { name: "보기" }).getByRole("button", { name: "브레드보드" }).click();
  await expect(page.locator("svg.canvas")).toBeVisible();
  await expect(page.locator("svg.schematic")).toHaveCount(0);
});

test("power nets as supply and ground symbols", async ({ page }) => {
  await openSchematic(page, "hal-adc-servo");
  const sch = page.locator("svg.schematic");
  // 3V3 and 5V as supply flags, GND as ground symbols.
  expect(await sch.locator(".net-end.supply[data-net='3V3']").count()).toBeGreaterThanOrEqual(3);
  await expect(sch.locator(".net-end.supply[data-net='5V']").first()).toBeVisible();
  await expect(sch.locator("[data-part=pot]")).toContainText("W");
});

test("LED and switch symbols; the LED glows while lit", async ({ page }) => {
  await openSchematic(page, "hal-button-exti");
  const sch = page.locator("svg.schematic");
  await expect(sch.locator(".sym-led")).toHaveCount(1);
  await expect(sch.locator(".sym-switch")).toHaveCount(1);
  // The switch toggles the LED: press it on the schematic.
  await page.getByRole("button", { name: "▶ 실행" }).click();
  await expect(sch.locator(".sym-glow")).toHaveCount(0);
  const lever = (await sch.locator("[data-part=sw1] [data-action=press] .sym-hit").boundingBox())!;
  await page.mouse.move(lever.x + lever.width / 2, lever.y + lever.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.up();
  await expect(sch.locator("[data-part=led1] .sym-glow")).toHaveCount(1, { timeout: 5000 });
  await expect(page.getByTestId("console-output")).toContainText("D2");
});
