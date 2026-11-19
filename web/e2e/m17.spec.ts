import { expect, test, type Page } from "@playwright/test";

// M17: several DS18B20 on one 1-Wire line, the HC-05 Bluetooth module and
// its phone panel, a relay module, several servos. Uses the example
// firmware and projects bundled by `npm run examples`.

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

/** The last temperature the console printed for a ROM code. */
async function tempOf(page: Page, rom: string): Promise<number | null> {
  const text = (await consoleOut(page).textContent()) ?? "";
  const all = [...text.matchAll(new RegExp(`#\\d ${rom} (-?\\d+\\.\\d+) C`, "g"))];
  return all.length ? Number(all[all.length - 1][1]) : null;
}

test("three DS18B20 on one line: SEARCH ROM finds all, touching one warms only its reading", async ({ page }) => {
  test.setTimeout(60000);
  await loadExampleProject(page, "hal-onewire-multi");
  await expect(consoleOut(page)).toContainText("found 3 sensors", { timeout: 8000 });
  const roms: string[] = [];
  for (const id of ["t1", "t2", "t3"]) roms.push((await attr(page, `[data-id=${id}] [data-rom]`, "data-rom"))!);
  expect(new Set(roms).size).toBe(3);
  for (const rom of roms) {
    expect(rom).toMatch(/^28-[0-9A-F]{12}$/);
    await expect(consoleOut(page)).toContainText(`ROM ${rom}`);
  }
  await expect.poll(() => tempOf(page, roms[0]), { timeout: 8000 }).toBe(22.5);
  // The sensors are printed one after another: wait for each line.
  await expect.poll(() => tempOf(page, roms[1]), { timeout: 8000 }).toBe(24);
  await expect.poll(() => tempOf(page, roms[2]), { timeout: 8000 }).toBe(25.5);
  await page.locator(".canvas-wrap").screenshot({ path: "test-results/m17-onewire.png" });

  // Hold a finger on the middle sensor: only its line warms up.
  const body = page.locator("[data-id=t2] .to92");
  await body.dispatchEvent("pointerdown", { bubbles: true, clientX: 0, clientY: 0 });
  await expect.poll(() => tempOf(page, roms[1]), { timeout: 15000 }).toBeGreaterThan(28);
  expect(await tempOf(page, roms[0])).toBe(22.5);
  expect(await tempOf(page, roms[2])).toBe(25.5);
  await body.dispatchEvent("pointerup", { bubbles: true, clientX: 0, clientY: 0 });
  await expect(consoleOut(page)).not.toContainText("CRC error");
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);
});

test("the phone chats with the firmware through the HC-05 and switches LD2", async ({ page }) => {
  await loadExampleProject(page, "hal-bluetooth-led");
  await expect(consoleOut(page)).toContainText("HC-05 on USART1", { timeout: 5000 });
  await page.getByRole("button", { name: "블루투스 (HC-05)" }).click();
  const phone = page.getByTestId("bt-phone");
  await expect(phone).toContainText("USART1 TX → RXD, TXD → USART1 RX");
  await expect(page.getByTestId("bt-status")).toHaveText("연결 안 됨");
  await expect(page.locator("[data-id=bt] [data-bt-led]")).toHaveAttribute("data-bt-led", "waiting");

  await page.getByRole("button", { name: "블루투스 연결" }).click();
  await expect(page.getByTestId("bt-status")).toHaveText("연결됨");
  await expect(page.getByTestId("bt-chat")).toContainText("Nucleo LED ready", { timeout: 5000 });
  await expect(page.locator("[data-id=bt] [data-bt-led]")).toHaveAttribute("data-bt-led", "connected");

  const ld2On = () => page.locator("[data-led=LD2]").evaluate((e) => Number(getComputedStyle(e).opacity) > 0.5);
  expect(await ld2On()).toBe(false);
  const input = page.getByLabel("블루투스 메시지");
  await input.fill("on");
  await input.press("Enter");
  await expect(page.locator(".bubble.phone").last()).toHaveText("on");
  await expect(page.locator(".bubble.mcu").last()).toHaveText("LED ON", { timeout: 5000 });
  await expect.poll(ld2On, { timeout: 3000 }).toBe(true);
  await page.screenshot({ path: "test-results/m17-bluetooth.png" });

  await input.fill("off");
  await input.press("Enter");
  await expect(page.locator(".bubble.mcu").last()).toHaveText("LED OFF", { timeout: 5000 });
  await expect.poll(ld2On, { timeout: 3000 }).toBe(false);
  await expect(page.getByTestId("bt-baud-warning")).toHaveCount(0);
  // The firmware logs the commands on the virtual COM port.
  await page.getByRole("button", { name: "가상 콘솔 (USART2)" }).click();
  await expect(consoleOut(page)).toContainText("[BT] rx: on");
  await expect(consoleOut(page)).toContainText("[BT] rx: off");
  await page.getByRole("button", { name: "블루투스 (HC-05)" }).click();
  await expect(page.locator(".bubble.mcu").last()).toHaveText("LED OFF");

  // The wrong baud rate on the module: replies come out garbled.
  await page.getByRole("button", { name: "블루투스 연결 끊기" }).click();
  await page.locator("[data-id=bt] .module-pcb").click({ force: true });
  await page.getByLabel("baud").selectOption("115200");
  await page.getByRole("button", { name: "블루투스 연결" }).click();
  await expect(page.getByTestId("bt-baud-warning")).toBeVisible({ timeout: 5000 });
  await expect(page.locator(".bubble.mcu.garbled").first()).toBeVisible();
});

test("a button toggles the relay, whose contacts light an LED on its own 5 V supply", async ({ page }) => {
  await loadExampleProject(page, "hal-relay");
  await expect(consoleOut(page)).toContainText("relay OFF", { timeout: 5000 });
  const brightness = () => num(page, "[data-id=lamp] [data-brightness]", "data-brightness");
  const closed = () => attr(page, "[data-id=k1] [data-closed]", "data-closed");
  expect(await closed()).toBe("0");
  expect(await brightness()).toBe(0);

  const press = async () => {
    const cap = (await page.locator("[data-id=sw1] [data-action=press] circle").boundingBox())!;
    await page.mouse.move(cap.x + cap.width / 2, cap.y + cap.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(150);
    await page.mouse.up();
  };
  await press();
  await expect(consoleOut(page)).toContainText("relay ON", { timeout: 3000 });
  await expect.poll(closed).toBe("1");
  await expect.poll(brightness).toBeGreaterThan(0.8);
  await expect(page.locator("[data-id=k1] [data-relay-led]")).toHaveAttribute("data-relay-led", "1");
  await page.locator(".canvas-wrap").screenshot({ path: "test-results/m17-relay.png" });

  await page.waitForTimeout(300);
  await press();
  await expect.poll(closed, { timeout: 3000 }).toBe("0");
  await expect.poll(brightness).toBe(0);
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);

  // The schematic draws the coil and the change-over contact.
  await page.getByRole("button", { name: "회로도" }).click();
  await expect(page.locator(".schematic [data-part=k1] [data-closed]")).toHaveAttribute("data-closed", "0");
});

test("three servos on two timers sweep with different phases", async ({ page }) => {
  await loadExampleProject(page, "hal-servos-multi");
  await expect(consoleOut(page)).toContainText("S1 ", { timeout: 5000 });
  const angles = async () => Promise.all(["s1", "s2", "s3"].map((id) => num(page, `[data-id=${id}] [data-angle]`, "data-angle")));
  await page.waitForTimeout(1000);
  const a = await angles();
  await page.waitForTimeout(700);
  const b = await angles();
  // Every horn moved, and they are not all at the same angle.
  for (let i = 0; i < 3; i++) expect(Math.abs(b[i] - a[i])).toBeGreaterThan(5);
  expect(Math.max(...b) - Math.min(...b)).toBeGreaterThan(20);
  await expect(page.getByTestId("circuit-warning")).toHaveCount(0);
});
