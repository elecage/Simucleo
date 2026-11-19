import { expect, test, type Page } from "@playwright/test";

// M19: 74HC595 shift register, TM1637 display, KY-023 joystick, HC-SR501
// PIR sensor, BMP280 barometer and a NeoPixel chain (DOUT → DIN). Uses the
// example firmware and projects bundled by `npm run examples`.

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

/** Centre of an element on screen. */
async function centre(page: Page, selector: string) {
  const b = (await page.locator(selector).first().boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

test("74HC595 on SPI: the latched byte walks across eight LEDs (Knight Rider)", async ({ page }) => {
  test.setTimeout(40000);
  await loadExampleProject(page, "hal-shift-register");
  await expect(consoleOut(page)).toContainText("74HC595 on SPI1", { timeout: 8000 });
  await expect(consoleOut(page)).toContainText(".......#  0x80", { timeout: 8000 });
  // The register drawing and the LEDs show one bit, and it moves.
  const latch = () => attr(page, "[data-id=sr] [data-latch]", "data-latch");
  const seen = new Set<string>();
  await expect
    .poll(
      async () => {
        const v = (await latch())!;
        if (["01", "02", "04", "08", "10", "20", "40", "80"].includes(v)) seen.add(v);
        return seen.size;
      },
      { timeout: 10000, intervals: [30] },
    )
    .toBeGreaterThanOrEqual(5);
  await expect(page.locator("[data-id=sr] [data-enabled]")).toHaveAttribute("data-enabled", "1");
  // The LED on the latched output is the lit one.
  const lit = async () => {
    const out: number[] = [];
    for (let i = 0; i < 8; i++) {
      if (Number(await attr(page, `[data-id=led${i}] [data-brightness]`, "data-brightness")) > 0.3) out.push(i);
    }
    return out;
  };
  await expect.poll(async () => (await lit()).length, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
  expect((await lit()).length).toBeLessThanOrEqual(3);
  await page.locator(".canvas-wrap").screenshot({ path: "test-results/m19-shift-register.png" });
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);

  // The schematic draws the chip as a box with Q7' among its outputs.
  await page.getByRole("button", { name: "회로도" }).click();
  await expect(page.locator(".schematic [data-part=sr]")).toContainText("74HC595");
  await expect(page.locator(".schematic [data-part=sr]")).toContainText("Q7'");
});

test("TM1637 clock: bit-banged frames with ACKs show mm:ss, B1 dims it", async ({ page }) => {
  test.setTimeout(40000);
  await loadExampleProject(page, "hal-tm1637-clock");
  await expect(consoleOut(page)).toContainText("TM1637 on D2", { timeout: 8000 });
  await expect(consoleOut(page)).toContainText("00:02", { timeout: 8000 });
  await expect(consoleOut(page)).not.toContainText("no ACK");
  // Digits 0, 0, 0 and the seconds; the colon blinks.
  const digits = () => attr(page, "[data-id=disp] [data-digits]", "data-digits");
  await expect.poll(digits, { timeout: 5000 }).toMatch(/^3f,(3f|bf),3f,[0-9a-f]{2}$/);
  const colons = new Set<string>();
  await expect
    .poll(
      async () => {
        colons.add((await attr(page, "[data-id=disp] [data-colon]", "data-colon"))!);
        return colons.size;
      },
      { timeout: 5000, intervals: [100] },
    )
    .toBe(2);
  await expect(page.locator("[data-id=disp] [data-brightness]")).toHaveAttribute("data-brightness", "7");
  await page.locator(".canvas-wrap").screenshot({ path: "test-results/m19-tm1637.png" });

  const b1 = await centre(page, "[data-action=b1]");
  await page.mouse.move(b1.x, b1.y);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.up();
  await expect(consoleOut(page)).toContainText("brightness 0", { timeout: 3000 });
  await expect(page.locator("[data-id=disp] [data-brightness]")).toHaveAttribute("data-brightness", "0", { timeout: 3000 });
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);
});

test("dragging the joystick moves the OLED dot, it springs back, a click presses SW", async ({ page }) => {
  test.setTimeout(40000);
  await loadExampleProject(page, "hal-joystick-oled");
  await expect(consoleOut(page)).toContainText(/X 20[45]\d {2}Y 20[45]\d {2}SW 0/, { timeout: 8000 });

  // Drag the knob to the right edge of its square and hold it there.
  const c = await centre(page, "[data-id=js] .js-cap");
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(c.x + 8 * i, c.y);
    await page.waitForTimeout(30);
  }
  await expect(page.locator("[data-id=js] [data-x]")).toHaveAttribute("data-x", "1.00");
  await expect(consoleOut(page)).toContainText(/X 4095 {2}Y 20[45]\d {2}SW 0/, { timeout: 5000 });
  expect(await attr(page, "[data-id=js] [data-sw]", "data-sw")).toBe("0");
  await page.mouse.up();
  // Released: back to the centre.
  await expect(page.locator("[data-id=js] [data-x]")).toHaveAttribute("data-x", "0.50", { timeout: 3000 });
  await expect(page.getByLabel("x")).toHaveValue("0.5");

  // A click on the knob presses the stick.
  const k = await centre(page, "[data-id=js] .js-cap");
  await page.mouse.move(k.x, k.y);
  await page.mouse.down();
  await expect(page.locator("[data-id=js] [data-sw]")).toHaveAttribute("data-sw", "1", { timeout: 3000 });
  await expect(consoleOut(page)).toContainText("SW 1", { timeout: 5000 });
  await page.mouse.up();
  await expect(page.locator("[data-id=js] [data-sw]")).toHaveAttribute("data-sw", "0", { timeout: 3000 });
  await expect.poll(() => attr(page, "[data-id=oled] image", "href"), { timeout: 3000 }).toBeTruthy();
  await page.locator(".canvas-wrap").screenshot({ path: "test-results/m19-joystick.png" });
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);
});

test("PIR: after the warm-up, a person walking through the field of view lights the LED", async ({ page }) => {
  test.setTimeout(60000);
  await loadExampleProject(page, "hal-pir-alarm");
  await expect(consoleOut(page)).toContainText("waiting for motion", { timeout: 8000 });
  const state = () => attr(page, "[data-id=pir] [data-pir-state]", "data-pir-state");
  await expect.poll(state, { timeout: 15000 }).toBe("ready");

  // Walk the person from the left edge into the fan, then keep moving
  // about in front of the dome.
  const p = await centre(page, "[data-id=pir] .person circle");
  const dome = await centre(page, "[data-id=pir] .pir-dome");
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(p.x + ((dome.x - p.x) * i) / 12, p.y);
    await page.waitForTimeout(40);
  }
  let high = false;
  for (let i = 0; i < 60 && !high; i++) {
    await page.mouse.move(dome.x + (i % 2 ? 8 : -8), p.y);
    await page.waitForTimeout(50);
    expect(await attr(page, "[data-id=pir] [data-motion]", "data-motion")).toBe("1");
    high = (await state()) === "high";
  }
  expect(high).toBe(true);
  await expect(consoleOut(page)).toContainText("motion detected (#1) - LED on", { timeout: 5000 });
  await expect.poll(async () => Number(await attr(page, "[data-id=led] [data-brightness]", "data-brightness")), { timeout: 3000 }).toBeGreaterThan(0.8);
  await page.locator(".canvas-wrap").screenshot({ path: "test-results/m19-pir.png" });
  // Standing still is no motion: the output drops after the hold time.
  await page.mouse.up();
  await expect(page.locator("[data-id=pir] [data-motion]")).toHaveAttribute("data-motion", "0", { timeout: 3000 });
  await expect(consoleOut(page)).toContainText("quiet again after", { timeout: 10000 });
  await expect.poll(state, { timeout: 3000 }).toBe("block");
  await expect.poll(state, { timeout: 8000 }).toBe("ready");

  // The button is motion too.
  const w = await centre(page, "[data-id=pir] [data-drag=wave] rect");
  await page.mouse.move(w.x, w.y);
  await page.mouse.down();
  await page.waitForTimeout(200);
  await page.mouse.up();
  await expect(consoleOut(page)).toContainText("motion detected (#2)", { timeout: 5000 });
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);
});

test("BMP280: the firmware's compensation gives back the pressure and temperature set", async ({ page }) => {
  test.setTimeout(40000);
  await loadExampleProject(page, "hal-bmp280");
  await expect(consoleOut(page)).toContainText("chip id 0x58 (BMP280)", { timeout: 8000 });
  await expect(consoleOut(page)).toContainText("T 25.00 C  P 1013.25 hPa  alt 0.0 m", { timeout: 8000 });
  await page.locator("[data-id=baro] .bmp-pcb").click({ force: true });
  await page.getByLabel("pressure").fill("900");
  await expect(consoleOut(page)).toContainText(/P 900\.00 hPa {2}alt 98\d\.\d m/, { timeout: 8000 });
  await page.getByLabel("temp").fill("-12.5");
  await expect(consoleOut(page)).toContainText("T -12.50 C", { timeout: 8000 });
  await expect(page.locator("[data-id=baro] [data-mode]")).toHaveAttribute("data-mode", "sleep");
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);
});

test("NeoPixel chain: the strip on the ring's DOUT shows LEDs 12–19 of the frame", async ({ page }) => {
  test.setTimeout(40000);
  await loadExampleProject(page, "hal-neopixel-chain");
  await expect(consoleOut(page)).toContainText("ring (12) -> DOUT -> strip (8)", { timeout: 8000 });
  const colours = (id: string) =>
    page.locator(`[data-id=${id}] [data-led]`).evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.color));
  await expect.poll(async () => (await colours("ring")).filter((c) => c !== "#000000").length, { timeout: 5000 }).toBe(12);
  // The comet: an amber head on the strip, and it moves.
  const head = async () => (await colours("strip")).findIndex((c) => c === "#201000");
  const heads = new Set<number>();
  await expect
    .poll(
      async () => {
        const h = await head();
        if (h >= 0) heads.add(h);
        return heads.size;
      },
      { timeout: 8000, intervals: [50] },
    )
    .toBeGreaterThanOrEqual(3);
  await page.locator(".canvas-wrap").screenshot({ path: "test-results/m19-neopixel-chain.png" });
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);
});
