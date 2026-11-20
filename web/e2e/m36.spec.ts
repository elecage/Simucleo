import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { listZip, readZip } from "../src/upload/zip.ts";
import { writeZip } from "../test/zipwriter.ts";

// M36: the CubeMX-like configuration tool. One page keeps the compiler warm:
// a new project from pins and peripherals, user code in USER CODE, build and
// run, regenerate with another baud rate (the user code stays), the clock
// tree's errors, an .ioc fixture, the zip export and a CubeIDE project
// import. The toolbar and the canvas never move.

test.describe.configure({ mode: "serial", timeout: 240_000 });
test.skip(!existsSync("dist/toolchain/manifest.json"), "build with the toolchain first (make -C ../firmware/editor-sdk && npm run build)");

const status = (page: Page) => page.getByTestId("run-status");
const buildStatus = (page: Page) => page.getByTestId("build-status");
const editor = (page: Page) => page.getByTestId("code-editor");
const line = (page: Page, text: string) => editor(page).locator(".cm-line", { hasText: text });
const panel = (page: Page) => page.getByTestId("config-panel");
const consoleOut = (page: Page) => page.getByTestId("console-output");

/** Toolbar items and the canvas: none may move (M29/M30/M33/M39 guard). */
const layout = (page: Page) =>
  page.evaluate(() => {
    const m = document.querySelector("main")!.getBoundingClientRect();
    const items = [...document.querySelector(".toolbar")!.children].map((c) => {
      const r = c.getBoundingClientRect();
      return `${r.left},${r.top},${r.width},${r.height}`;
    });
    return `${m.top} ${m.height} ${document.querySelector(".toolbar")!.getBoundingClientRect().height} | ${items.join(" ")}`;
  });

/** LD2's brightness and the simulated time, read together. */
const sample = (page: Page) =>
  page.evaluate(() => {
    const o = Number(getComputedStyle(document.querySelector("[data-led=LD2]")!).opacity);
    const m = /· ([\d.]+) s ·/.exec(document.querySelector("[data-testid=run-status]")?.textContent ?? "");
    return { o, t: m ? Number(m[1]) : NaN };
  });

/** The median time between LD2 toggles over `simMs` of simulated time (ms). */
async function ld2Period(page: Page, simMs: number): Promise<number> {
  const start = await sample(page);
  let last: boolean | null = null;
  const edges: number[] = [];
  for (;;) {
    const { o, t } = await sample(page);
    const on = o > 0.8 ? true : o < 0.2 ? false : null;
    if (on !== null) {
      if (last !== null && on !== last) edges.push(t);
      last = on;
    }
    if ((t - start.t) * 1000 >= simMs) break;
    await page.waitForTimeout(10);
  }
  expect(edges.length).toBeGreaterThanOrEqual(3);
  const gaps = edges.slice(1).map((t, i) => (t - edges[i]) * 1000).sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/** Scroll the open file to the first `text` (the editor's search) and put the cursor at the end of that line. */
async function reveal(page: Page, text: string) {
  await editor(page).locator(".cm-content").click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+f");
  const field = editor(page).locator(".cm-search input[name=search]");
  await field.fill(text);
  // The search panel takes the query on keyup (fill alone types no key).
  await field.press("End");
  await field.press("Enter");
  await page.keyboard.press("Escape");
  await page.keyboard.press("End");
  await expect(line(page, text).first()).toBeVisible();
}

async function openCodeTab(page: Page) {
  await page.getByRole("button", { name: "코드", exact: true }).click();
  await expect(page.getByTestId("code-panel")).toBeVisible();
}

async function build(page: Page) {
  await page.getByRole("button", { name: "▶ 빌드" }).click();
  await expect(buildStatus(page)).toContainText("빌드 성공", { timeout: 180_000 });
}

async function closePanel(page: Page) {
  await page.getByLabel("설정 도구 닫기").click();
  await expect(panel(page)).toHaveCount(0);
}

let shared: { context: BrowserContext; page: Page; shape: string } | null = null;
async function warmPage(browser: Browser) {
  if (shared) return shared.page;
  const context = await browser.newContext({ viewport: { width: 1400, height: 820 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on("dialog", (d) => void d.accept());
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
  shared = { context, page, shape: await layout(page) };
  return page;
}
test.afterAll(async () => {
  await shared?.context.close();
});

test("PA5 → GPIO_Output 'LD2' and USART2, generate, user code in USER CODE, build: LD2 toggles and the console prints", async ({ browser }) => {
  const page = await warmPage(browser);
  await openCodeTab(page);
  await page.getByTestId("new-cube-empty").click();
  await expect(panel(page)).toBeVisible();
  expect(await layout(page)).toBe(shared!.shape);

  // Pinout: click PA5 on the package, choose GPIO_Output, label it LD2.
  await panel(page).locator('[data-pin="PA5"]').click();
  await page.getByTestId("pin-menu").locator('[data-signal="GPIO_Output"]').click();
  await expect(panel(page).locator('[data-pin="PA5"]')).toHaveClass(/set/);
  await page.getByLabel("PA5 라벨").fill("LD2");
  await expect(page.getByTestId("pin-editor")).toContainText("LD2_Pin");
  // The list view shows it with its Nucleo header names.
  await panel(page).getByRole("button", { name: "목록" }).click();
  await expect(panel(page).locator('[data-row="PA5"]')).toContainText("D13");
  await expect(page.getByLabel("PA5 신호", { exact: true })).toHaveValue("GPIO_Output");

  // USART2 from its form: its pins go to PA2/PA3 (the ST-LINK virtual COM port).
  await panel(page).getByRole("tab", { name: "주변장치" }).click();
  await panel(page).locator('button[data-peripheral="USART2"]').click();
  await page.getByLabel("USART2 사용").check();
  await expect(page.getByTestId("peripheral-form")).toContainText("USART2_TX → PA2");
  await expect(page.getByLabel("USART2 보레이트")).toHaveValue("115200");
  await expect(page.getByTestId("config-status")).toHaveText("오류 없음");

  // Generate: a new project in the code tab.
  await panel(page).getByRole("tab", { name: "코드 생성" }).click();
  await expect(panel(page).locator('[data-file="Core/Src/main.c"]')).toContainText("새 파일");
  await page.getByTestId("generate").click();
  await expect(page.getByTestId("generated")).toBeVisible();
  await closePanel(page);
  await reveal(page, "MX_USART2_UART_Init();");
  await expect(page.locator(".code-file", { hasText: "stm32f4xx_it.c" })).toBeVisible();

  // User code: toggle and printf in USER CODE 3 (the printf retarget is the starter code in USER CODE 0).
  await reveal(page, "/* USER CODE BEGIN 3 */");
  await page.keyboard.insertText('\n    HAL_GPIO_TogglePin(LD2_GPIO_Port, LD2_Pin);\n    printf("tick %lu\\r\\n", (unsigned long)HAL_GetTick());\n    HAL_Delay(200);');
  await expect(line(page, "HAL_Delay(200);")).toBeVisible();
  await build(page);
  await expect(status(page)).toContainText("code.elf");
  const period = await ld2Period(page, 1500);
  expect(period).toBeGreaterThan(180);
  expect(period).toBeLessThan(240);
  await page.getByRole("button", { name: "가상 콘솔 (USART2)" }).click();
  await expect(consoleOut(page)).toContainText(/tick \d+/, { timeout: 5000 });
  await openCodeTab(page);
  expect(await layout(page)).toBe(shared!.shape);
});

test("change USART2's baud rate and regenerate: the diff keeps USER CODE, the user code is still there and builds", async ({ browser }) => {
  const page = await warmPage(browser);
  await page.getByTestId("open-config").click();
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole("tab", { name: "주변장치" }).click();
  await panel(page).locator('button[data-peripheral="USART2"]').click();
  await page.getByLabel("USART2 보레이트").fill("9600");
  await panel(page).getByRole("tab", { name: "코드 생성" }).click();
  const main = panel(page).locator('[data-file="Core/Src/main.c"]');
  await expect(main).toContainText("USER CODE");
  await expect(main).toContainText("유지");
  await main.click();
  await expect(page.getByTestId("diff").locator(".d-add", { hasText: "huart2.Init.BaudRate = 9600;" })).toBeVisible();
  await expect(page.getByTestId("diff").locator(".d-del", { hasText: "huart2.Init.BaudRate = 115200;" })).toBeVisible();
  await page.getByTestId("generate").click();
  await expect(page.getByTestId("generated")).toBeVisible();
  await closePanel(page);
  await page.locator(".code-file button", { hasText: /^main\.c$/ }).click();
  await reveal(page, "huart2.Init.BaudRate = 9600;");
  await reveal(page, "HAL_GPIO_TogglePin(LD2_GPIO_Port, LD2_Pin);");
  await reveal(page, "HAL_Delay(200);");
  await build(page);
  const period = await ld2Period(page, 1200);
  expect(period).toBeGreaterThan(180);
  expect(period).toBeLessThan(240);
  expect(await layout(page)).toBe(shared!.shape);
});

test("the clock tree shows an over-limit SYSCLK in red and code generation is blocked until it is fixed", async ({ browser }) => {
  const page = await warmPage(browser);
  await page.getByTestId("open-config").click();
  await panel(page).getByRole("tab", { name: "클럭" }).click();
  await expect(panel(page).locator('[data-node="sysclk"]')).toContainText("84 MHz");
  await page.getByLabel("PLLP").selectOption("2");
  await expect(panel(page).locator('[data-node="sysclk"]')).toHaveClass(/bad/);
  await expect(panel(page).locator('[data-node="sysclk"]')).toContainText("168 MHz");
  await expect(panel(page).locator('[data-node="apb1"]')).toHaveClass(/bad/);
  await expect(page.getByTestId("config-problems")).toContainText("SYSCLK 168 MHz: STM32F401은 최대 84 MHz입니다.");
  await expect(page.getByTestId("config-status")).toContainText("오류");
  await panel(page).getByRole("tab", { name: "코드 생성" }).click();
  await expect(page.getByTestId("generate")).toBeDisabled();
  await panel(page).getByRole("tab", { name: "클럭" }).click();
  await page.getByLabel("PLLP").selectOption("4");
  await expect(panel(page).locator('[data-node="sysclk"]')).not.toHaveClass(/bad/);
  await expect(page.getByTestId("config-status")).toHaveText("오류 없음");
  await closePanel(page);
});

test("import an .ioc fixture: pins, timers and ADC come in, unsupported parts are warnings", async ({ browser }) => {
  const page = await warmPage(browser);
  await page.getByTestId("open-config").click();
  await page.getByTestId("ioc-input").setInputFiles("test/data/m36/pwm-adc.ioc");
  await expect(page.getByTestId("config-problems")).toContainText("pwm-adc.ioc을(를) 불러왔습니다");
  await expect(page.getByTestId("config-problems")).toContainText("DMA: 이 주변장치는 아직 지원하지 않아");
  await expect(page.getByLabel("CubeIDE 프로젝트 이름")).toHaveValue("pwm_adc");
  await expect(panel(page).locator('[data-pin="PA5"]')).toHaveClass(/set/);
  await expect(panel(page).locator('[data-pin="PA0"]')).toHaveClass(/set/);
  await panel(page).getByRole("tab", { name: "주변장치" }).click();
  await panel(page).locator('button[data-peripheral="TIM2"]').click();
  await expect(page.getByLabel("TIM2_CH1 핀")).toHaveValue("PA5");
  await expect(page.getByLabel("TIM2_CH1 펄스")).toHaveValue("250");
  await expect(page.locator('[data-channel="1"]')).toContainText("1000 Hz · 25.0%");
  await panel(page).getByRole("tab", { name: "클럭" }).click();
  await expect(page.getByLabel("PLL 소스")).toHaveValue("HSE");
  await expect(panel(page).locator('[data-node="vcoIn"]')).toContainText("2 MHz");
  // Closing without generating keeps the project as it was (the dialog is accepted).
  await closePanel(page);
  await reveal(page, "huart2.Init.BaudRate = 9600;");
});

test("export the project as a zip for STM32CubeIDE: .project, .cproject, .ioc, Core/, Drivers/", async ({ browser }) => {
  const page = await warmPage(browser);
  await page.locator(".code-menu summary").click();
  const download = page.waitForEvent("download");
  await page.getByTestId("export-zip").click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("simucleo.zip");
  const zip = new Uint8Array(readFileSync((await file.path())!));
  const names = listZip(zip).map((e) => e.path);
  for (const f of [".project", ".cproject", "simucleo.ioc", "Core/Src/main.c", "Core/Src/stm32f4xx_it.c", "Core/Src/stm32f4xx_hal_msp.c", "Core/Inc/main.h", "Core/Inc/stm32f4xx_hal_conf.h", "Core/Startup/startup_stm32f401retx.s", "Core/Src/system_stm32f4xx.c", "STM32F401RETX_FLASH.ld", "Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_uart.c", "Drivers/STM32F4xx_HAL_Driver/Inc/stm32f4xx_hal.h", "Drivers/CMSIS/Include/core_cm4.h", "Drivers/CMSIS/Device/ST/STM32F4xx/Include/stm32f401xe.h"])
    expect(names).toContain(`simucleo/${f}`);
  const main = new TextDecoder().decode((await readZip(zip, (e) => e.path === "simucleo/Core/Src/main.c"))[0].data);
  expect(main).toContain("HAL_GPIO_TogglePin(LD2_GPIO_Port, LD2_Pin);");
  expect(main).toContain("huart2.Init.BaudRate = 9600;");
  // The project tree lists the bundle's files read-only.
  await page.keyboard.press("Escape");
  await page.getByLabel("프로젝트 트리").selectOption("Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_gpio.c");
  await expect(line(page, "@file    stm32f4xx_hal_gpio.c").first()).toBeVisible();
  await expect(page.locator(".header-file")).toContainText("🔒 stm32f4xx_hal_gpio.c");
  expect(await layout(page)).toBe(shared!.shape);
});

test("import a CubeIDE project zip: the .ioc becomes the configuration, Core/ the files, Debug/ is left out", async ({ browser }) => {
  const page = await warmPage(browser);
  const ioc = readFileSync("test/data/m36/sensors-bus.ioc", "utf8");
  const zip = writeZip([
    { name: "sensors_bus/sensors_bus.ioc", data: ioc },
    { name: "sensors_bus/Core/Src/app.c", data: "int app_ready = 1;\n" },
    { name: "sensors_bus/Core/Inc/app.h", data: "extern int app_ready;\n" },
    { name: "sensors_bus/Debug/sensors_bus.elf", data: "not really" },
    { name: "sensors_bus/.project", data: "<projectDescription/>" },
  ]);
  await page.getByTestId("cubeide-import").setInputFiles({ name: "sensors_bus.zip", mimeType: "application/zip", buffer: Buffer.from(zip) });
  await expect(panel(page)).toBeVisible();
  await expect(page.getByTestId("config-problems")).toContainText("CubeIDE 프로젝트 'sensors_bus'을(를) 가져왔습니다");
  await expect(page.getByTestId("config-problems")).toContainText("FREERTOS");
  await panel(page).getByRole("tab", { name: "주변장치" }).click();
  await panel(page).locator('button[data-peripheral="I2C1"]').click();
  await expect(page.getByLabel("I2C1 속도")).toHaveValue("400000");
  await closePanel(page);
  await expect(page.locator(".code-file", { hasText: "app.c" })).toBeVisible();
  await expect(page.locator(".code-file", { hasText: /^main\.c/ })).toBeVisible();
  await page.locator(".code-file button", { hasText: /^main\.c$/ }).click();
  await reveal(page, "static void MX_I2C1_Init(void);");
  await reveal(page, "static void MX_SPI1_Init(void);");
  await build(page);
  expect(await layout(page)).toBe(shared!.shape);
});
