import { expect, test, type Locator, type Page } from "@playwright/test";

// M18: wiring on the schematic. A wire drawn there is a real wire between
// the two pins, so the breadboard shows it too; "연결 끊기" removes the wires
// on a pin. Uses the example firmware bundled by `npm run examples`.

const status = (page: Page) => page.getByTestId("run-status");
const sch = (page: Page) => page.locator("svg.schematic");
const notice = (page: Page) => page.locator(".notice");
const wires = (page: Page) => page.locator("svg.canvas path.wire");

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
});

const view = (page: Page, name: "브레드보드" | "회로도") =>
  page.getByRole("group", { name: "보기" }).getByRole("button", { name }).click();

/** A pin end on the schematic: `pin` is part of the terminal's pin ids. */
const end = (page: Page, part: string, pin: string) =>
  sch(page).locator(`[data-part="${part}"] .sym-pin[data-pin*="${pin}"] .pin-hit`).first();

async function centre(loc: Locator) {
  await loc.scrollIntoViewIfNeeded();
  const b = (await loc.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Click a pin end (its stub tip; the label drawn over it is part of it too). */
async function clickEnd(page: Page, loc: Locator) {
  const c = await centre(loc);
  await page.mouse.click(c.x, c.y);
}

/** Drag with the mouse from one pin end to another (both must be on screen). */
async function connect(page: Page, from: Locator, to: Locator) {
  const a = await centre(from);
  const b = await centre(to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2 + 30, { steps: 6 });
  await expect(sch(page).locator(".sch-rubber")).toHaveCount(1);
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await expect(sch(page).locator(".sch-rubber")).toHaveCount(0);
}

/** Every segment of a breadboard wire is horizontal or vertical, with at least one bend. */
async function squareRoute(path: Locator) {
  const d = (await path.getAttribute("d"))!;
  const pts = [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  expect(d).not.toContain("Q"); // not the sagging straight jumper
  expect(pts.length).toBeGreaterThanOrEqual(3);
  for (let i = 1; i < pts.length; i++) {
    expect(pts[i][0] === pts[i - 1][0] || pts[i][1] === pts[i - 1][1], d).toBe(true);
  }
}

test("an LED and resistor wired to the board on the schematic only blink with the firmware", async ({ page }) => {
  const lib = page.locator(".library");
  await lib.getByRole("button", { name: "저항", exact: true }).click();
  await lib.getByRole("button", { name: "LED 5mm", exact: true }).click();
  await view(page, "회로도");
  const r = (await sch(page).locator("[data-part^=resistor]").getAttribute("data-part"))!;
  const led = (await sch(page).locator("[data-part^=led]").getAttribute("data-part"))!;
  const nets = page.locator(".nets li");
  // Nothing wired yet: the MCU lists no pins, every part pin is "not connected".
  await expect(sch(page).locator("[data-part=nucleo] .sym-pin")).toHaveCount(0);
  await expect(sch(page).locator(`[data-part=${r}] .sym-nc`)).toHaveCount(2);

  // Resistor to LED anode.
  await connect(page, end(page, r, "2"), end(page, led, "A"));
  await expect(wires(page)).toHaveCount(1);
  await expect(sch(page).locator(`[data-part=${r}] [data-pin="2"] .net-end`)).toHaveCount(1);
  const n1 = await sch(page).locator(`[data-part=${r}] [data-pin="2"] .net-end`).getAttribute("data-net");
  await expect(sch(page).locator(`[data-part=${led}] [data-pin=A] .net-end[data-net="${n1}"]`)).toHaveCount(1);
  await expect(nets).toHaveText([`${led}.A — ${r}.2`]);
  // The drag neither pinned that net nor selected anything.
  await page.mouse.move(5, 300);
  await expect(sch(page).locator(".net-end.lit")).toHaveCount(0);
  await expect(page.getByTestId("pin-selection")).toHaveCount(0);

  // Again between the same two pins: already one net, no second wire.
  await connect(page, end(page, led, "A"), end(page, r, "2"));
  await expect(notice(page)).toContainText("이미 같은 넷");
  await expect(wires(page)).toHaveCount(1);
  await notice(page).getByRole("button", { name: "닫기" }).click();

  // Dropped on empty space, or Esc while dragging: nothing.
  const a = await centre(end(page, r, "1"));
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 40, a.y + 120, { steps: 6 });
  await expect(sch(page).locator(".sch-rubber")).toHaveCount(1);
  await page.mouse.up();
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 40, a.y + 120, { steps: 6 });
  await page.keyboard.press("Escape");
  await expect(sch(page).locator(".sch-rubber")).toHaveCount(0);
  await page.mouse.up();
  await expect(wires(page)).toHaveCount(1);

  // The board's pins in use only, so PA5 is not there yet: show them all.
  const mcu = sch(page).locator("[data-part=nucleo]");
  await expect(mcu).not.toContainText("PA5");
  await page.getByLabel("모든 MCU 핀").check();
  await expect(mcu).toContainText("PA5 (D13)");
  await expect(mcu).toContainText("PA6 (D12)");
  await expect(mcu.locator(".sym-pin[data-pin*=GND_P1] .pin-name")).toHaveText("GND");
  await expect(mcu.locator(".sym-pin[data-pin*='3V3'] .pin-name")).toHaveText("3V3");
  // Zoomed out, the tall MCU and the parts fit on screen together.
  await page.getByRole("button", { name: "회로도 축소" }).click();
  await page.getByRole("button", { name: "회로도 축소" }).click();
  await connect(page, end(page, "nucleo", "D13"), end(page, r, "1"));
  await connect(page, end(page, led, "K"), end(page, "nucleo", "GND_P1"));
  await expect(wires(page)).toHaveCount(3);
  await expect(nets).toHaveText([`${led}.A — ${r}.2`, `${led}.K — nucleo.GND`, `nucleo.PA5 — ${r}.1`]);
  await expect(mcu.locator(".sym-pin[data-pin*=D13] .net-end[data-net=PA5]")).toHaveCount(1);

  // On the breadboard: the same three wires, from pin to pin, square bends.
  await view(page, "브레드보드");
  await expect(wires(page)).toHaveCount(3);
  for (const w of await wires(page).all()) {
    await expect(w).toBeVisible();
    await squareRoute(w);
  }
  // From pin to pin; the board ends on Arduino header pins (D13, a GND).
  const inspect = async (i: number) => {
    await wires(page).nth(i).dispatchEvent("pointerdown");
    return page.locator(".inspector p").first();
  };
  await expect(await inspect(0)).toHaveText(`와이어 ${r}.2 — ${led}.A`);
  await expect(await inspect(1)).toHaveText(`와이어 nucleo.D13 — ${r}.1`);
  await expect(await inspect(2)).toHaveText(new RegExp(`^와이어 ${led}\\.K — nucleo\\.GND_(P1|P2|D)$`));
  await page.locator(".canvas-wrap").screenshot({ path: "test-results/m18-breadboard.png" });

  // Blinky toggles PA5: the LED blinks with LD2, while still wiring.
  await page.getByLabel("예제 펌웨어").selectOption("hal-blinky.elf");
  await expect(status(page)).toContainText("hal-blinky");
  await page.getByRole("button", { name: "▶ 실행" }).click();
  const brightness = () => page.locator(`[data-id=${led}] [data-brightness]`).first().getAttribute("data-brightness").then(Number);
  // The run is paced to real time and blinky toggles every 500 ms of
  // simulated time: on a loaded runner the simulation can fall well behind
  // the clock, so the waits are generous and a failure says how far it got.
  const why = async () => `status: ${await status(page).textContent()}`;
  // Every 97 ms: expect.poll's default settles at 1 s, twice blinky's
  // 500 ms, and at real time every look then fell on the same phase — the
  // LED looked stuck on for the whole 15 s while it blinked.
  const look = { timeout: 15000, intervals: [97] };
  await expect.poll(brightness, { ...look, message: await why() }).toBeGreaterThan(0.5);
  await expect.poll(brightness, { ...look, message: await why() }).toBeLessThan(0.1); // off (a frame may average a little of the edge on a busy machine)
  await view(page, "회로도");
  await expect(sch(page).locator(`[data-part=${led}] .sym-glow`)).toHaveCount(1, { timeout: 5000 });
  await page.screenshot({ path: "test-results/m18-schematic-wiring.png" });

  // Disconnect the cathode: click its pin end (pins GND, selects the pin), Delete.
  await clickEnd(page, end(page, led, "K"));
  await expect(page.getByTestId("pin-selection")).toContainText(`${led}.K (GND)`);
  await expect(sch(page).locator(".net-end.lit[data-net=GND]")).not.toHaveCount(0);
  await page.keyboard.press("Delete");
  await expect(wires(page)).toHaveCount(2);
  await expect(notice(page)).toContainText(`${led}.K에서 와이어 1개를 지웠습니다`);
  // The pin, not the part.
  await expect(sch(page).locator(`[data-part=${led}]`)).toHaveCount(1);
  await expect(sch(page).locator(`[data-part=${led}] [data-pin=K] .sym-nc`)).toHaveCount(1);
  await expect(nets).toHaveText([`${led}.A — ${r}.2`, `nucleo.PA5 — ${r}.1`]);
  await view(page, "브레드보드");
  await expect(wires(page)).toHaveCount(2);
  await expect.poll(brightness, { timeout: 3000 }).toBe(0);
  await page.waitForTimeout(1200); // over two blinks: stays dark
  expect(await brightness()).toBe(0);
});

test("disconnecting a pin joined by the breadboard says to move it there; bused pins all go", async ({ page }) => {
  await page.getByLabel("예제 펌웨어").selectOption("hal-button-exti.elf");
  await expect(status(page)).toContainText("hal-button-exti");
  await view(page, "회로도");
  await expect(wires(page)).toHaveCount(5);

  // The LED's cathode sits in the breadboard row of the GND rail jumper.
  await clickEnd(page, end(page, "led1", "K"));
  await expect(page.getByTestId("pin-selection")).toContainText("led1.K (GND)");
  await page.getByRole("button", { name: "연결 끊기" }).click();
  await expect(notice(page)).toContainText("브레드보드");
  await expect(notice(page)).toContainText("부품을 옮겨");
  await expect(wires(page)).toHaveCount(5);
  await expect(sch(page).locator("[data-part=led1] [data-pin=K] .net-end[data-net=GND]")).toHaveCount(1);

  // The switch straddles the channel (M38): its 1a/1b terminal is joined by the breadboard as well.
  await clickEnd(page, end(page, "sw1", "1a"));
  await expect(page.getByTestId("pin-selection")).toContainText("sw1.1a/1b");
  await page.getByRole("button", { name: "연결 끊기" }).click();
  await expect(notice(page)).toContainText("부품을 옮겨");
  await expect(wires(page)).toHaveCount(5);

  // The board's PA10 terminal stands for the bused pins D2 and CN10_33: the
  // wire on D2 goes, and the switch with it.
  await expect(sch(page).locator("[data-part=nucleo]")).toContainText("PA10 (D2)");
  await clickEnd(page, end(page, "nucleo", "D2"));
  await expect(page.getByTestId("pin-selection")).toContainText("PA10");
  await page.getByRole("button", { name: "연결 끊기" }).click();
  await expect(wires(page)).toHaveCount(4);
  await expect(sch(page).locator("[data-part=sw1] [data-pin='1a/1b'] .sym-nc")).toHaveCount(1);
  await expect(sch(page).locator("[data-part=nucleo]")).not.toContainText("PA10");
  // The breadboard lost that wire too.
  await view(page, "브레드보드");
  await expect(page.locator(".nets li", { hasText: "sw1.1" })).toHaveCount(0);

  // Selecting a part here selects it on the breadboard.
  await view(page, "회로도");
  await sch(page).locator("[data-part=r1] .sym-title").click();
  await expect(page.locator(".inspector")).toContainText("r1 · 저항");
  await view(page, "브레드보드");
  await expect(page.locator("[data-id=r1].part.selected")).toHaveCount(1);
});

test("a new wire keeps the other symbols where they were", async ({ page }) => {
  await page.getByLabel("예제 펌웨어").selectOption("hal-button-exti.elf");
  await expect(status(page)).toContainText("hal-button-exti");
  await view(page, "회로도");
  const top = async (p: string) => (await sch(page).locator(`[data-part=${p}] .sym-title`).boundingBox())!.y;
  const before = { led1: await top("led1"), r1: await top("r1"), sw1: await top("sw1") };
  // Every MCU pin shown: the parts stay put.
  await page.getByLabel("모든 MCU 핀").check();
  const after0 = { led1: await top("led1"), r1: await top("r1"), sw1: await top("sw1") };
  expect(after0).toEqual(before);
  await page.getByRole("button", { name: "회로도 축소" }).click();
  await page.getByRole("button", { name: "회로도 축소" }).click();
  const zoomed = { led1: await top("led1"), r1: await top("r1"), sw1: await top("sw1") };
  // A wire from PA6 to the LED (PA6 ranks before the other MCU pins): no reshuffle.
  await connect(page, end(page, "nucleo", "D12"), end(page, "led1", "A"));
  await expect(wires(page)).toHaveCount(6);
  expect({ led1: await top("led1"), r1: await top("r1"), sw1: await top("sw1") }).toEqual(zoomed);
});

test("a touch drag (pointer events with capture) connects too", async ({ page }) => {
  const lib = page.locator(".library");
  await lib.getByRole("button", { name: "저항", exact: true }).click();
  await lib.getByRole("button", { name: "LED 5mm", exact: true }).click();
  await view(page, "회로도");
  const r = (await sch(page).locator("[data-part^=resistor]").getAttribute("data-part"))!;
  const led = (await sch(page).locator("[data-part^=led]").getAttribute("data-part"))!;
  const a = await centre(end(page, r, "1"));
  const b = await centre(end(page, led, "K"));
  const touch = { pointerType: "touch", pointerId: 7, isPrimary: true, bubbles: true, button: 0, buttons: 1 };
  await end(page, r, "1").dispatchEvent("pointerdown", { ...touch, clientX: a.x, clientY: a.y });
  for (let i = 1; i <= 5; i++) {
    const at = { clientX: a.x + ((b.x - a.x) * i) / 5, clientY: a.y + ((b.y - a.y) * i) / 5 };
    await sch(page).dispatchEvent("pointermove", { ...touch, ...at });
  }
  await expect(sch(page).locator(".sch-rubber")).toHaveCount(1);
  await expect(sch(page).locator(`[data-part=${led}] .pin-end.target`)).toHaveCount(1);
  await sch(page).dispatchEvent("pointerup", { ...touch, buttons: 0, clientX: b.x, clientY: b.y });
  await expect(wires(page)).toHaveCount(1);
  await expect(page.locator(".nets li")).toHaveText([`${led}.K — ${r}.1`]);
  // A finger tap (no movement) selects the pin instead.
  const c = await centre(end(page, r, "2"));
  await end(page, r, "2").dispatchEvent("pointerdown", { ...touch, clientX: c.x, clientY: c.y });
  await sch(page).dispatchEvent("pointerup", { ...touch, buttons: 0, clientX: c.x, clientY: c.y });
  await expect(page.getByTestId("pin-selection")).toContainText(`${r}.2 (연결 안 됨)`);
  await expect(wires(page)).toHaveCount(1);
});
