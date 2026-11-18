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
  await page.getByRole("button", { name: "저항" }).click();
  const led = await partId(page, "led");
  const res = await partId(page, "resistor");

  const drag = async (part: string, pinId: string, target: { x: number; y: number }) => {
    const body = await page.locator(`[data-id="${part}"] > g`).boundingBox();
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
  await expect(page.locator("line.wire-preview")).toHaveCount(1);
  await page.keyboard.press("Delete");
  await expect(page.locator(`[data-id="${led}"]`)).toHaveCount(0);
  await expect(page.locator("line.wire-preview")).toHaveCount(0);

  // The next pin click starts a new wire instead of finishing a phantom one.
  const d13 = await pin(page, "nucleo", "D13");
  await page.mouse.click(d13.x, d13.y);
  await expect(page.locator("line.wire-preview")).toHaveCount(1);
  await expect(page.locator("path.wire")).toHaveCount(0);
  await expect(page.locator(".nets li")).toHaveCount(0);
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
