import { expect, test, type Page } from "@playwright/test";

/** Screen centre of a pin, e.g. pin(page, "nucleo", "D13"). */
async function pin(page: Page, part: string, id: string) {
  const box = await page.locator(`[data-pins="${part}"] [data-pin="${id}"]`).boundingBox();
  if (!box) throw new Error(`pin ${part}.${id} not found`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function partId(page: Page, prefix: string) {
  const ids = await page.locator("[data-id]").evaluateAll((l) => l.map((g) => (g as HTMLElement).dataset.id!));
  return ids.find((i) => i.startsWith(prefix))!;
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText(/core v/)).toBeVisible();
});

test("LED and resistor on the breadboard form the expected nets", async ({ page }) => {
  await page.getByRole("button", { name: "LED 5mm" }).click();
  await page.getByRole("button", { name: "저항", exact: true }).click();
  const led = await partId(page, "led");
  const res = await partId(page, "resistor");

  const drag = async (part: string, pinId: string, target: { x: number; y: number }) => {
    // Grab the part's body (not its label).
    const body = await page.locator(`[data-id="${part}"] :is(.resistor-body, .led-body)`).first().boundingBox();
    const from = await pin(page, part, pinId);
    const bx = body!.x + body!.width / 2;
    const by = body!.y + body!.height / 2;
    await page.mouse.move(bx, by);
    await page.mouse.down();
    await page.mouse.move(bx + target.x - from.x, by + target.y - from.y, { steps: 8 });
    await page.mouse.up();
  };
  const wire = async (a: [string, string], b: [string, string]) => {
    const p = await pin(page, ...a);
    const q = await pin(page, ...b);
    await page.mouse.click(p.x, p.y);
    await page.mouse.click(q.x, q.y);
  };

  await drag(led, "K", await pin(page, "bb1", "e12"));
  await drag(res, "1", await pin(page, "bb1", "c9"));
  await wire(["nucleo", "CN10_11"], ["bb1", "a9"]); // PA5 via Morpho
  await wire(["nucleo", "GND_P1"], ["bb1", "tn1"]);
  await wire(["bb1", "tn11"], ["bb1", "a12"]);

  await expect(page.locator(".nets li")).toHaveText([
    `${led}.A — ${res}.2`,
    `${led}.K — nucleo.GND`,
    `nucleo.PA5 — ${res}.1`,
  ]);
});

// https://github.com/elecage/Simucleo/issues/2
test("deleting the part a wire starts from cancels the wire", async ({ page }) => {
  await page.getByRole("button", { name: "LED 5mm" }).click();
  const led = await partId(page, "led");
  const a = await pin(page, led, "A");
  await page.mouse.click(a.x, a.y);
  await expect(page.locator(".wire-preview")).toHaveCount(1);
  await page.keyboard.press("Delete");
  await expect(page.locator(`[data-id="${led}"]`)).toHaveCount(0);
  await expect(page.locator(".wire-preview")).toHaveCount(0);

  // The next pin click starts a new wire instead of finishing a phantom one.
  const d13 = await pin(page, "nucleo", "D13");
  await page.mouse.click(d13.x, d13.y);
  await expect(page.locator(".wire-preview")).toHaveCount(1);
  await expect(page.locator("path.wire")).toHaveCount(0);
  await expect(page.locator(".nets li")).toHaveCount(0);
});

test("a pin clicked right after its wire's part is deleted starts a new wire", async ({ page }) => {
  await page.getByRole("button", { name: "LED 5mm" }).click();
  const led = await partId(page, "led");
  const a = await pin(page, led, "A");
  await page.mouse.click(a.x, a.y);
  await expect(page.locator(".wire-preview")).toHaveCount(1);
  // Delete the LED and click D13 the moment the deletion is on screen,
  // before React's effects run (a MutationObserver fires first): the
  // click must not try to finish the deleted part's wire.
  await page.evaluate((id) => {
    const d13 = document.querySelector('[data-pins="nucleo"] [data-pin="D13"]')!;
    const r = d13.getBoundingClientRect();
    const at = { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, pointerId: 1, isPrimary: true };
    const obs = new MutationObserver(() => {
      if (document.querySelector(`[data-id="${id}"]`)) return;
      obs.disconnect();
      d13.dispatchEvent(new PointerEvent("pointerdown", { ...at, buttons: 1 }));
      d13.dispatchEvent(new PointerEvent("pointerup", { ...at, buttons: 0 }));
    });
    obs.observe(document.body, { childList: true, subtree: true });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
  }, led);
  await expect(page.locator(`[data-id="${led}"]`)).toHaveCount(0);
  await expect(page.locator(".wire-preview")).toHaveCount(1);
  await expect(page.locator("path.wire")).toHaveCount(0);
});

// https://github.com/elecage/Simucleo/issues/3
test("releasing the mouse outside the canvas ends a drag", async ({ page }) => {
  const board = page.locator('[data-id="nucleo"]');
  await page.mouse.move(700, 450);
  await page.mouse.down();
  await page.mouse.move(400, 450, { steps: 5 });
  await page.mouse.move(60, 450, { steps: 5 }); // over the part library
  await page.mouse.up();
  const released = await board.getAttribute("transform");
  await page.mouse.move(600, 500, { steps: 5 });
  await expect(board).toHaveAttribute("transform", released!);
});

// ---------------------------------------------------------------- review fixes

test("zoom with buttons, keys and the wheel", async ({ page }) => {
  const level = page.getByTestId("zoom-level");
  await expect(level).toHaveText("100%");
  await page.getByRole("button", { name: "확대", exact: true }).click();
  await expect(level).toHaveText("125%");
  await page.getByRole("button", { name: "축소", exact: true }).click();
  await page.getByRole("button", { name: "축소", exact: true }).click();
  await expect(level).toHaveText("80%");
  await level.click();
  await expect(level).toHaveText("100%");
  const box = (await page.locator("svg.canvas").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -300);
  await expect.poll(async () => parseInt((await level.textContent())!)).toBeGreaterThan(100);
  await page.getByRole("button", { name: "⤢ 맞춤" }).click();
  await expect.poll(async () => parseInt((await level.textContent())!)).toBeLessThan(100);
});

test("drag from pin to pin makes a wire; clicks on the way add bends", async ({ page }) => {
  // Drag: press on D13, release near (not exactly on) bb1.a5.
  const from = await pin(page, "nucleo", "D13");
  const to = await pin(page, "bb1", "a5");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x + 3, to.y + 2, { steps: 10 });
  await page.mouse.up();
  await expect(page.locator(".nets li")).toHaveCount(0); // a wire alone joins one part pin to a breadboard row
  await expect(page.locator("path.wire")).toHaveCount(1);

  // Click-click with a bend point in empty space.
  const g = await pin(page, "nucleo", "GND_D");
  const rail = await pin(page, "bb1", "tn3");
  await page.mouse.click(g.x, g.y);
  await expect(page.locator(".wiring-hint")).toBeVisible();
  // Bend in the empty gap between the board and the breadboard.
  const boardBox = (await page.locator('[data-id="nucleo"]').boundingBox())!;
  const bbBox = (await page.locator('[data-id="bb1"]').boundingBox())!;
  await page.mouse.click((boardBox.x + boardBox.width + bbBox.x) / 2, bbBox.y + bbBox.height + 20);
  await page.mouse.click(rail.x, rail.y);
  await expect(page.locator("path.wire")).toHaveCount(2);
  const d = await page.locator("path.wire").nth(1).getAttribute("d");
  expect(d).toMatch(/^M [\d.-]+ [\d.-]+ L [\d.-]+ [\d.-]+ L/); // one bend, straight segments
  await expect(page.locator(".wiring-hint")).toHaveCount(0);
});

test("LED legs are marked + and −", async ({ page }) => {
  await page.getByRole("button", { name: "LED 5mm" }).click();
  const led = await partId(page, "led");
  await expect(page.locator(`[data-id="${led}"] .polarity.plus`)).toHaveText("+");
  await expect(page.locator(`[data-id="${led}"] .polarity.minus`)).toHaveText("−");
  await expect(page.locator(`[data-id="${led}"] .led-flat`)).toHaveCount(1);
});

test("resistor colour bands follow the value", async ({ page }) => {
  await page.getByRole("button", { name: "저항", exact: true }).click();
  const res = await partId(page, "resistor");
  const bands = page.locator(`[data-id="${res}"] [data-bands]`);
  await expect(bands).toHaveAttribute("data-bands", "red,red,brown,gold");
  const input = page.getByLabel("ohms");
  for (const [v, b] of [
    ["4k7", "yellow,violet,red,gold"],
    ["1k", "brown,black,red,gold"],
    ["470", "yellow,violet,brown,gold"],
    ["100k", "brown,black,yellow,gold"],
    ["10 kΩ", "brown,black,orange,gold"],
  ]) {
    await input.fill(v);
    await expect(bands).toHaveAttribute("data-bands", b);
  }
  await input.fill("abc");
  await expect(bands).toHaveAttribute("data-bands", "invalid");
  await expect(page.getByTestId("ohms-parsed")).toContainText("알 수 없는 값");
  await expect(page.getByTestId("circuit-warning")).toContainText("unknown resistance");
});

test("a wire end can be dragged to another pin", async ({ page }) => {
  await page.getByRole("button", { name: "LED 5mm" }).click();
  const led = await partId(page, "led");
  const d13 = await pin(page, "nucleo", "D13");
  const a = await pin(page, led, "A");
  await page.mouse.click(d13.x, d13.y);
  await page.mouse.click(a.x, a.y);
  await expect(page.locator(".nets li")).toHaveText([`${led}.A — nucleo.PA5`]);

  // Select the wire, then drag its LED end from A to K.
  const mid = await page.locator("path.wire").evaluate((el) => {
    const path = el as SVGPathElement;
    const p = path.getPointAtLength(path.getTotalLength() / 2).matrixTransform(path.getScreenCTM()!);
    return { x: p.x, y: p.y };
  });
  await page.mouse.click(mid.x, mid.y);
  const end = page.locator(`[data-wire-end="b"]`);
  await expect(end).toBeVisible();
  const box = (await end.boundingBox())!;
  const k = await pin(page, led, "K");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(k.x + 2, k.y - 2, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".nets li")).toHaveText([`${led}.K — nucleo.PA5`]);
  await expect(page.locator("path.wire")).toHaveCount(1);
});

test("3-, 4-, 5- and 6-band colour codes with tolerance and tempco (IEC 60062)", async ({ page }) => {
  await page.getByRole("button", { name: "저항", exact: true }).click();
  const res = await partId(page, "resistor");
  const bands = page.locator(`[data-id="${res}"] [data-bands]`);
  const info = page.getByTestId("ohms-parsed");
  const ohms = page.getByLabel("ohms");
  const count = page.getByLabel("bands");

  await ohms.fill("470");
  await count.selectOption("3");
  await expect(bands).toHaveAttribute("data-bands", "yellow,violet,brown");
  await expect(page.getByLabel("tolerance")).toHaveCount(0); // no tolerance band
  await expect(info).toContainText("±20%");

  await count.selectOption("4");
  await ohms.fill("0.47");
  await expect(bands).toHaveAttribute("data-bands", "yellow,violet,silver,gold");
  await page.getByLabel("tolerance").selectOption("10%");
  await expect(bands).toHaveAttribute("data-bands", "yellow,violet,silver,silver");

  // 4.75 kΩ needs three digits: rounded on 4 bands, exact on 5.
  await ohms.fill("4.75k");
  await expect(info).toContainText("4.8 kΩ로 표시됩니다");
  await count.selectOption("5");
  await page.getByLabel("tolerance").selectOption("1%");
  await expect(bands).toHaveAttribute("data-bands", "yellow,violet,green,brown,brown");
  await expect(info).toContainText("표준값 E96");
  await expect(info).not.toContainText("표시됩니다");

  await count.selectOption("6");
  await ohms.fill("10k");
  await page.getByLabel("tempco").selectOption("50");
  await expect(bands).toHaveAttribute("data-bands", "brown,black,black,red,brown,red");
  await expect(info).toContainText("표준값 E6");
  await ohms.fill("123");
  await expect(info).toContainText("E 계열 표준값이 아닙니다");
});
