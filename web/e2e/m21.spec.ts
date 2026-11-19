import { expect, test, type Page } from "@playwright/test";

// M21: motors — a NEMA17 stepper on an A4988 and on an L298N, a hobby ESC
// with a brushless motor, and a hall-sensor BLDC on a 3-phase bridge. Uses
// the example firmware and projects bundled by `npm run examples`.

const status = (page: Page) => page.getByTestId("run-status");
const consoleOut = (page: Page) => page.getByTestId("console-output");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
});

async function loadExampleProject(page: Page, name: string) {
  await page.getByLabel("예제 펌웨어").selectOption(`${name}.elf`);
  await expect(status(page)).toContainText(name);
  await page.getByRole("button", { name: "▶ 실행" }).click();
}

const attr = (page: Page, selector: string, name: string) => page.locator(selector).first().getAttribute(name);
const num = async (page: Page, selector: string, name: string) => Number(await attr(page, selector, name));

/** Centre of an element on screen. */
async function centre(page: Page, selector: string) {
  const b = (await page.locator(selector).first().boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function pressB1(page: Page) {
  const b1 = await centre(page, "[data-action=b1]");
  await page.mouse.move(b1.x, b1.y);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.up();
}

const MOT = "[data-id=mot] [data-steps]";

test("A4988: ramped revolutions there and back, the driver off by B1, the shaft turned by hand", async ({ page }) => {
  test.setTimeout(60000);
  await loadExampleProject(page, "hal-stepper-a4988");
  await expect(consoleOut(page)).toContainText("1/8 steps", { timeout: 8000 });
  await expect(consoleOut(page)).toContainText("rev 1 CW : position 1600 microsteps = 360.0 deg", { timeout: 10000 });
  await expect(consoleOut(page)).toContainText("rev 2 CCW: position 0 microsteps = 0.0 deg", { timeout: 10000 });
  // The driver shows 1/8 steps and its outputs on; the rotor turns at speed.
  await expect(page.locator("[data-id=drv] [data-state]")).toHaveAttribute("data-state", "on");
  await expect(page.locator("[data-id=drv] [data-micro]")).toHaveAttribute("data-micro", "8");
  await expect.poll(async () => Math.abs(await num(page, MOT, "data-rpm")), { timeout: 10000, intervals: [50] }).toBeGreaterThan(100);
  await expect(page.locator(MOT)).toHaveAttribute("data-lost", "0");
  // Both coils carry current.
  await expect.poll(async () => Math.abs(await num(page, "[data-id=mot] [data-coil=A]", "data-current")), { timeout: 5000 }).toBeGreaterThan(0.1);
  await page.locator(".canvas-wrap").screenshot({ path: "test-results/m21-a4988.png" });
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);

  // B1: EN high — no current, the rotor is free.
  await pressB1(page);
  await expect(consoleOut(page)).toContainText("driver off (EN high)", { timeout: 8000 });
  await expect(page.locator("[data-id=drv] [data-state]")).toHaveAttribute("data-state", "disabled");
  await expect.poll(async () => Math.abs(await num(page, "[data-id=mot] [data-coil=A]", "data-current")), { timeout: 5000 }).toBeLessThan(0.01);
  const before = await num(page, MOT, "data-steps");
  // Grab the flag on the shaft and turn it a quarter turn clockwise.
  const flag = page.locator("[data-id=mot] .nema-flag");
  const f = (await flag.boundingBox())!;
  const c = await centre(page, "[data-id=mot] .nema-boss");
  const r = Math.hypot(f.x + f.width / 2 - c.x, f.y + f.height / 2 - c.y);
  const a0 = Math.atan2(f.x + f.width / 2 - c.x, -(f.y + f.height / 2 - c.y));
  await page.mouse.move(c.x + r * Math.sin(a0), c.y - r * Math.cos(a0));
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    const a = a0 + (i / 12) * (Math.PI / 2);
    await page.mouse.move(c.x + r * Math.sin(a), c.y - r * Math.cos(a));
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  // About 50 full steps on, and it stays there (only the detents hold it).
  await expect.poll(async () => (await num(page, MOT, "data-steps")) - before, { timeout: 5000 }).toBeGreaterThan(35);
  await page.waitForTimeout(500);
  expect((await num(page, MOT, "data-steps")) - before).toBeGreaterThan(35);

  // The schematic draws the driver with its outputs.
  await page.getByRole("button", { name: "회로도" }).click();
  await expect(page.locator(".schematic [data-part=drv]")).toContainText("A4988");
  await expect(page.locator(".schematic [data-part=drv]")).toContainText("1A");
  await expect(page.locator(".schematic [data-part=mot]")).toContainText("NEMA17");
});

test("A4988: a brake on the shaft makes the stepper lose steps, with a warning", async ({ page }) => {
  test.setTimeout(60000);
  await loadExampleProject(page, "hal-stepper-a4988");
  await expect(consoleOut(page)).toContainText("rev 1 CW", { timeout: 10000 });
  await page.locator("[data-id=mot] .nema-body").click({ force: true });
  await page.getByLabel("load").fill("38");
  await expect.poll(async () => num(page, MOT, "data-lost"), { timeout: 15000 }).toBeGreaterThan(0);
  await expect(page.getByTestId("circuit-warning").filter({ hasText: "mot: lost steps" })).toHaveCount(1, { timeout: 5000 });
  await expect(page.locator("[data-id=mot] [data-stall]")).toBeVisible();
});

test("L298N: half steps from four GPIO pins turn the stepper one revolution each way", async ({ page }) => {
  test.setTimeout(60000);
  await loadExampleProject(page, "hal-stepper-l298n");
  await expect(consoleOut(page)).toContainText("L298N half steps", { timeout: 8000 });
  await expect(consoleOut(page)).toContainText("rev 1 CW : position 400 half steps = 360 deg", { timeout: 15000 });
  await expect(consoleOut(page)).toContainText("rev 2 CCW: position 0 half steps = 0 deg", { timeout: 15000 });
  await expect.poll(async () => Math.abs(await num(page, MOT, "data-rpm")), { timeout: 8000, intervals: [50] }).toBeGreaterThan(30);
  // The bridge outputs alternate in sign as the sequence runs.
  const signs = new Set<string>();
  await expect
    .poll(
      async () => {
        const a = await num(page, "[data-id=br] [data-out-a]", "data-out-a");
        if (Math.abs(a) > 0.05) signs.add(a > 0 ? "+" : "-");
        return signs.size;
      },
      { timeout: 8000, intervals: [40] },
    )
    .toBe(2);
  await expect(page.locator("[data-id=br] [data-jumpers]")).toHaveAttribute("data-jumpers", "off");
  await expect(page.locator(MOT)).toHaveAttribute("data-lost", "0");
  await page.locator(".canvas-wrap").screenshot({ path: "test-results/m21-l298n.png" });
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);
});

test("ESC: arming at minimum throttle, the pot sets the speed, B1 cuts the signal (failsafe)", async ({ page }) => {
  test.setTimeout(60000);
  await loadExampleProject(page, "hal-esc-bldc");
  const esc = "[data-id=esc] [data-esc-state]";
  await expect(page.locator(esc)).toHaveAttribute("data-esc-state", "arming", { timeout: 8000 });
  await expect(consoleOut(page)).toContainText("armed - throttle from the pot on A0", { timeout: 10000 });
  await expect(page.locator(esc)).toHaveAttribute("data-esc-state", "armed");
  // Pot in the middle: half of 1000 KV × 11.1 V.
  await expect.poll(async () => num(page, esc, "data-rpm"), { timeout: 10000 }).toBeGreaterThan(5000);
  expect(await num(page, esc, "data-rpm")).toBeLessThan(6000);
  expect(await num(page, esc, "data-beeps")).toBe(2);
  await page.locator(".canvas-wrap").screenshot({ path: "test-results/m21-esc.png" });
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);
  // Turn the pot towards 3V3: faster.
  await page.locator("[data-id=pot]").first().click({ force: true });
  await page.getByLabel("position").fill("0.1");
  await expect.poll(async () => num(page, esc, "data-rpm"), { timeout: 10000 }).toBeGreaterThan(9000);
  // B1: no more pulses.
  await pressB1(page);
  await expect(consoleOut(page)).toContainText("signal off", { timeout: 5000 });
  await expect(page.locator(esc)).toHaveAttribute("data-esc-state", "failsafe", { timeout: 5000 });
  await expect.poll(async () => num(page, esc, "data-rpm"), { timeout: 10000 }).toBeLessThan(500);
  await expect(page.getByTestId("circuit-warning").filter({ hasText: "failsafe" })).toHaveCount(1);
});

test("BLDC: hall interrupts commutate the 3-phase bridge; halls swapped, it stalls", async ({ page }) => {
  test.setTimeout(60000);
  await loadExampleProject(page, "hal-bldc-hall");
  const mot = "[data-id=mot] [data-halls]";
  await expect.poll(async () => num(page, mot, "data-rpm"), { timeout: 10000 }).toBeGreaterThan(2500);
  await expect(consoleOut(page)).toContainText(/halls ABC [01]{3} {2}[UVW]\+ [UVW]- {2}rpm 3\d{3}/, { timeout: 8000 });
  // The halls step through their codes; two switches of the bridge are on.
  const codes = new Set<string>();
  await expect
    .poll(
      async () => {
        codes.add((await attr(page, mot, "data-halls"))!);
        return codes.size;
      },
      { timeout: 8000, intervals: [20] },
    )
    .toBeGreaterThanOrEqual(3);
  await expect(page.locator("[data-id=br] [data-outputs]")).toHaveAttribute("data-outputs", /^(?=.*H)(?=.*L)[HLZ]{3}$/);
  await page.locator(".canvas-wrap").screenshot({ path: "test-results/m21-bldc.png" });
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);
  // B1: the firmware reads hall A as B — the motor rocks and stops.
  await pressB1(page);
  await expect(consoleOut(page)).toContainText("wrong commutation", { timeout: 5000 });
  await expect(page.locator(mot)).toHaveAttribute("data-stalled", "1", { timeout: 10000 });
  await expect(page.getByTestId("circuit-warning").filter({ hasText: "does not turn" })).toHaveCount(1, { timeout: 5000 });
});
