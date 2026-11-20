import { expect, test, type Page } from "@playwright/test";

// M14: operating input parts by hand on the breadboard — turn the pot,
// move a lamp over the LDR, touch a temperature sensor, move the obstacle
// in front of the sonar. The controls write the same props as the sliders,
// and dragging one never moves the part.

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

const transform = (page: Page, id: string) => page.locator(`[data-id=${id}]`).getAttribute("transform");
const num = (page: Page, selector: string, attr: string) =>
  page.locator(selector).first().evaluate((e, a) => Number(e.getAttribute(a)), attr);

/** The last number printed after `label` on the console. */
async function lastReading(page: Page, label: RegExp): Promise<number> {
  const text = (await consoleOut(page).textContent()) ?? "";
  const all = [...text.matchAll(new RegExp(label.source + "\\s*(-?\\d+(?:\\.\\d+)?)", "g"))];
  return all.length ? Number(all[all.length - 1][1]) : NaN;
}

/** Centre of an element on screen. */
async function centre(page: Page, selector: string) {
  const b = (await page.locator(selector).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Point at `selector` (without the mouse: wires may lie over it) and read the hint. */
async function hintOf(page: Page, selector: string) {
  const c = await centre(page, selector);
  await page.locator(selector).dispatchEvent("pointerover", { bubbles: true, clientX: c.x, clientY: c.y });
  return page.getByTestId("control-hint");
}

/**
 * Press on `selector` and drag by (dx, dy) screen pixels with synthetic
 * pointer events: wires drawn over a part cannot get in the way.
 */
async function dragBy(page: Page, selector: string, dx: number, dy: number, hold = false) {
  const c = await centre(page, selector);
  const opts = { bubbles: true, pointerId: 7, isPrimary: true, pointerType: "mouse", buttons: 1 };
  await page.locator(selector).dispatchEvent("pointerdown", { ...opts, clientX: c.x, clientY: c.y });
  for (let i = 1; i <= 10; i++) {
    await page.locator(".canvas").dispatchEvent("pointermove", { ...opts, clientX: c.x + (dx * i) / 10, clientY: c.y + (dy * i) / 10 });
    await page.waitForTimeout(30);
  }
  if (!hold) await page.locator(".canvas").dispatchEvent("pointerup", { ...opts, buttons: 0, clientX: c.x + dx, clientY: c.y + dy });
}

test("turning the pot knob by hand sets the ADC reading; the wheel turns it too", async ({ page }) => {
  await loadExampleProject(page, "hal-adc-servo");
  await expect(consoleOut(page)).toContainText("pot 2047", { timeout: 5000 });
  const placed = await transform(page, "pot");

  // The hint says what to do.
  await expect(await hintOf(page, "[data-id=pot] .pot-knob")).toContainText("노브를 잡고 돌리세요");

  // Grab the knob and sweep from 9 o'clock over the top to 3 o'clock: +180°.
  const c = await centre(page, "[data-id=pot] .pot-knob");
  const r = 40;
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  for (let a = -90; a <= 90; a += 10) {
    const rad = (a * Math.PI) / 180;
    await page.mouse.move(c.x + Math.sin(rad) * r, c.y - Math.cos(rad) * r);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  await expect(page.locator("[data-id=pot] [data-drag=knob]")).toHaveAttribute("data-angle", "135");
  await expect(consoleOut(page)).toContainText("pot 4095", { timeout: 5000 });
  expect(await transform(page, "pot"), "the pot did not move").toBe(placed);
  // The servo follows the knob.
  const angle = () => num(page, "[data-id=sv] [data-angle]", "data-angle");
  await expect.poll(angle, { timeout: 5000 }).toBeGreaterThan(175);

  // Back the other way, all the way down.
  await page.mouse.move(c.x, c.y);
  await page.mouse.down();
  for (let a = 90; a >= -180; a -= 10) {
    const rad = (a * Math.PI) / 180;
    await page.mouse.move(c.x + Math.sin(rad) * r, c.y - Math.cos(rad) * r);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();
  await expect(consoleOut(page)).toContainText("pot    0", { timeout: 5000 });

  // Five wheel notches up: 10 %. The slider shows it.
  await page.mouse.move(c.x, c.y);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -100);
  await expect(page.getByLabel("position")).toHaveValue("0.1");
  await expect(consoleOut(page)).toContainText(/pot  (409|410)/, { timeout: 5000 });
  expect(await transform(page, "pot")).toBe(placed);

  // Five more in one go, with no redraw between them (a fast wheel on a
  // busy machine): each counts — one right after a send read the props
  // from before it and the notch before it was lost.
  await page.waitForTimeout(300);
  await page.locator("[data-id=pot] [data-drag=knob]").evaluate((knob) => {
    const r = knob.getBoundingClientRect();
    for (let i = 0; i < 5; i++)
      knob.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }));
  });
  await expect(page.getByLabel("position")).toHaveValue("0.2");
});

test("touching the TMP36 warms it over a few seconds; released it cools back", async ({ page }) => {
  test.setTimeout(60000);
  await loadExampleProject(page, "hal-adc-servo");
  await expect(consoleOut(page)).toContainText("TMP36 24.9 C", { timeout: 5000 });
  const placed = await transform(page, "tmp");
  const temp = () => num(page, "[data-id=tmp] [data-temp]", "data-temp");
  const body = page.locator("[data-id=tmp] .to92");

  // Zoom in around the analog parts (the wheel off a knob zooms).
  const t = await centre(page, "[data-id=tmp] .to92");
  const wrap = (await page.locator(".canvas-wrap").boundingBox())!;
  const [ex, ey] = [wrap.x + wrap.width - 15, wrap.y + wrap.height - 15]; // empty canvas: pans
  await page.mouse.move(ex, ey);
  await page.mouse.down();
  await page.mouse.move(ex - (t.x - 60 - wrap.x - wrap.width / 2), ey - (t.y - 40 - wrap.y - wrap.height / 2), { steps: 5 });
  await page.mouse.up();
  await page.mouse.move(wrap.x + wrap.width / 2, wrap.y + wrap.height / 2);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, -100);
  await page.mouse.move(0, 0);
  await expect(await hintOf(page, "[data-id=tmp] .to92")).toContainText("체온");
  await body.dispatchEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0 });
  await expect(page.locator("[data-id=tmp] [data-touched]")).toHaveCount(1);
  // Warming takes time: not there at once, ~30 °C after a few seconds.
  await page.waitForTimeout(800);
  const early = await temp();
  expect(early).toBeGreaterThan(25);
  expect(early).toBeLessThan(28);
  await expect.poll(temp, { timeout: 6000 }).toBeGreaterThan(30);
  await expect.poll(() => lastReading(page, /TMP36/), { timeout: 5000 }).toBeGreaterThan(29);
  expect(await temp()).toBeLessThan(33.01);
  await page.locator(".canvas-wrap").screenshot({ path: "test-results/m14-touch.png" });

  await body.dispatchEvent("pointerup", { bubbles: true, clientX: 0, clientY: 0 });
  await expect(page.locator("[data-id=tmp] [data-touched]")).toHaveCount(0);
  // Cooling back to the 25 °C it had, firmware still running.
  await expect.poll(temp, { timeout: 4000 }).toBeLessThan(29);
  await expect.poll(temp, { timeout: 25000 }).toBe(25);
  await expect.poll(() => lastReading(page, /TMP36/), { timeout: 5000 }).toBeLessThan(25.6);
  await expect(page.getByLabel("temp")).toHaveValue("25");
  expect(await transform(page, "tmp"), "touching did not move it").toBe(placed);

  // Pressed and dragged, the body moves the part (and does not warm it).
  await dragBy(page, "[data-id=tmp] .to92", 60, 0);
  expect(await transform(page, "tmp")).not.toBe(placed);
  expect(await temp()).toBe(25);
});

test("moving the lamp over the LDR changes the light; the hand covers it", async ({ page }) => {
  await loadExampleProject(page, "hal-adc-servo");
  await expect(consoleOut(page)).toContainText("light", { timeout: 5000 });
  const placed = await transform(page, "ldr");
  const lux = () => num(page, "[data-id=ldr] [data-lux]", "data-lux");
  expect(await lux()).toBe(300);
  await page.waitForTimeout(600);
  const light300 = await lastReading(page, /light/);

  await expect(await hintOf(page, "[data-id=ldr] .lamp-head")).toContainText("손전등");
  // Down onto the sensor: brightest. More light → lower reading.
  await dragBy(page, "[data-id=ldr] .lamp-head", 0, 200);
  await expect.poll(lux).toBe(10000);
  await expect.poll(() => lastReading(page, /light/), { timeout: 5000 }).toBeLessThan(light300 - 200);
  await expect(page.getByLabel("lux")).toHaveValue("4"); // log10 slider
  // Far away: dim.
  await dragBy(page, "[data-id=ldr] .lamp-head", 0, -400);
  await expect.poll(lux).toBe(100);
  await expect.poll(() => lastReading(page, /light/), { timeout: 5000 }).toBeGreaterThan(light300 + 100);
  expect(await transform(page, "ldr"), "the LDR did not move").toBe(placed);

  // Halfway: inverse square, between the ends.
  await dragBy(page, "[data-id=ldr] .lamp-head", 0, 60);
  await page.waitForTimeout(100);
  const mid = await lux();
  expect(mid).toBeGreaterThan(100);
  expect(mid).toBeLessThan(10000);

  // Cover with a hand while pressed.
  const cover = page.locator("[data-id=ldr] .cover-button circle");
  await cover.dispatchEvent("pointerdown", { bubbles: true });
  await expect.poll(lux).toBe(5);
  await expect(page.locator("[data-id=ldr] .hand-cover")).toHaveCount(1);
  await expect.poll(() => lastReading(page, /light/), { timeout: 5000 }).toBeGreaterThan(light300 + 200);
  await page.screenshot({ path: "test-results/m14-cover.png" });
  await cover.dispatchEvent("pointerup", { bubbles: true });
  await expect.poll(lux).toBe(mid);
  await expect(page.locator("[data-id=ldr] .hand-cover")).toHaveCount(0);
  expect(await transform(page, "ldr")).toBe(placed);
});

test("dragging the obstacle in front of the HC-SR04 sets the distance", async ({ page }) => {
  await loadExampleProject(page, "hal-sonar-onewire");
  await expect(consoleOut(page)).toContainText("distance 50.0 cm", { timeout: 8000 });
  const placed = await transform(page, "us");
  const cm = () => num(page, "[data-id=us] [data-cm]", "data-cm");

  await expect(await hintOf(page, "[data-id=us] .obstacle-wall")).toContainText("장애물");
  // Further away.
  await dragBy(page, "[data-id=us] .obstacle-wall", 0, -60);
  await page.waitForTimeout(100);
  const far = await cm();
  expect(far).toBeGreaterThan(100);
  await expect.poll(async () => Math.abs((await lastReading(page, /distance/)) - far), { timeout: 8000 }).toBeLessThan(1);
  await expect(page.getByLabel("distance")).toHaveValue(String(far));
  // Right up to the sensor: the 2 cm minimum.
  await dragBy(page, "[data-id=us] .obstacle-wall", 0, 400);
  await expect.poll(cm).toBe(2);
  await expect(consoleOut(page)).toContainText(/distance 2\.\d cm/, { timeout: 8000 });
  expect(await transform(page, "us"), "the sonar did not move").toBe(placed);

  // The DS18B20 next to it warms under a finger too.
  const ds = page.locator("[data-id=ds] .to92");
  await ds.dispatchEvent("pointerdown", { bubbles: true });
  await expect.poll(() => num(page, "[data-id=ds] [data-temp]", "data-temp"), { timeout: 6000 }).toBeGreaterThan(28);
  await expect(consoleOut(page)).toContainText(/temperature (2[89]|3\d)\.\d\d C/, { timeout: 8000 });
  await page.screenshot({ path: "test-results/m14-sonar.png" });
  await ds.dispatchEvent("pointerup", { bubbles: true });

  // Moving the module itself still works.
  await dragBy(page, "[data-id=us] .module-pcb", 40, 0);
  expect(await transform(page, "us")).not.toBe(placed);
});

test("breathing on the DHT22 raises humidity and temperature", async ({ page }) => {
  test.setTimeout(60000);
  await loadExampleProject(page, "hal-dht-capture");
  await expect(consoleOut(page)).toContainText("humidity 48.3 %  temperature 22.5 C", { timeout: 8000 });
  const body = page.locator("[data-id=dht] .dht22-body");
  await body.dispatchEvent("pointerdown", { bubbles: true });
  const hum = () => num(page, "[data-id=dht] [data-humidity]", "data-humidity");
  await expect.poll(hum, { timeout: 6000 }).toBeGreaterThan(70);
  await expect(consoleOut(page)).toContainText(/humidity [7-8]\d\.\d %  temperature (2[6-9]|3\d)\.\d C/, { timeout: 8000 });
  await body.dispatchEvent("pointerup", { bubbles: true });
  await expect.poll(hum, { timeout: 30000 }).toBe(48.3);
  expect(await num(page, "[data-id=dht] [data-temp]", "data-temp")).toBe(22.5);
});

test("a second finger cannot take over a held touch", async ({ page }) => {
  test.setTimeout(60000);
  await loadExampleProject(page, "hal-adc-servo");
  await expect(consoleOut(page)).toContainText("TMP36 24.9 C", { timeout: 5000 });
  const temp = () => num(page, "[data-id=tmp] [data-temp]", "data-temp");
  const body = page.locator("[data-id=tmp] .to92");
  const knob = page.locator("[data-id=pot] [data-drag=knob]");
  // Finger 1 holds the TMP36 until it is clearly warmer…
  await body.dispatchEvent("pointerdown", { bubbles: true, pointerId: 1, buttons: 1 });
  await expect.poll(temp, { timeout: 10000 }).toBeGreaterThan(27);
  // …finger 2 lands on the pot knob meanwhile, then both lift.
  await knob.dispatchEvent("pointerdown", { bubbles: true, pointerId: 2, buttons: 1 });
  await page.locator(".canvas").dispatchEvent("pointerup", { bubbles: true, pointerId: 1, buttons: 0 });
  await page.locator(".canvas").dispatchEvent("pointerup", { bubbles: true, pointerId: 2, buttons: 0 });
  // The sensor was let go: it cools instead of warming on forever.
  const lifted = await temp();
  await page.waitForTimeout(2500);
  expect(await temp()).toBeLessThan(lifted - 0.5);
});
