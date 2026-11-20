// Unit tests of M36, the CubeMX-like configuration tool (`npm test`): the
// pin/AF table, pin assignment and conflict checks, the clock tree, code
// generation (snapshots per peripheral, test/data/m36/snapshots; rewrite
// with UPDATE_SNAPSHOTS=1), USER CODE kept on regeneration, .ioc read/write
// round trips with the fixtures, the project tree, zip export and import,
// and the build pipeline's "cube" template.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { adcChannel, afMacro, afNumber, boardNames, IO_PINS, PACKAGE_PINS, pinFromIoc, pinsFor, signalChoices } from "../src/cube/mcu.ts";
import { computeClock, defaultClock, latencyFor } from "../src/cube/clock.ts";
import { assignPin, clone, disablePeripheralWithPins, emptyConfig, enablePeripheralWithPins, hasErrors, labelMacro, nucleoDefaults, pwmInfo, validate, type CubeConfig } from "../src/cube/config.ts";
import { diffLines, diffStats, foldDiff } from "../src/cube/diff.ts";
import { wiringCheck } from "../src/cube/wiring.ts";
import { generate, halModules, mainC, mspC, itC } from "../src/cube/codegen.ts";
import { editsOutsideRegions, mergeUserCode, ORPHAN_REGION, regions, setRegion } from "../src/cube/usercode.ts";
import { exportIoc, parseIoc, parseProperties, writeProperties } from "../src/cube/ioc.ts";
import { applyRegeneration, exportEntries, exportZip, importCubeProject, newCubeProject, planRegeneration, projectConfig, projectTree, safeProjectName } from "../src/cube/tree.ts";
import { DEFAULT_PACK } from "../src/cube/packs.ts";
import { listZip, readZip } from "../src/upload/zip.ts";
import { forShare, sanitizeCode } from "../src/code/project.ts";
import { compileFlags, linkArgs } from "../src/code/sdk.ts";
import { packFiles } from "../scripts/cube-pack.mjs";
import { snapshotConfigs } from "./m36-configs.ts";

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, "data", "m36");
const FW = join(here, "..", "..", "firmware");
const fixture = (n: string) => readFileSync(join(DATA, n), "utf8");
const text = (b: Uint8Array) => new TextDecoder().decode(b);

// ------------------------------------------------------------------ the MCU

test("LQFP64 package: 64 pins, 50 I/O, no PB11 (VCAP1), power pins where the datasheet has them", () => {
  assert.equal(PACKAGE_PINS.length, 64);
  assert.equal(IO_PINS.length, 50);
  assert.ok(!IO_PINS.includes("PB11"));
  assert.equal(PACKAGE_PINS[29].name, "VCAP1");
  assert.equal(PACKAGE_PINS[20].name, "PA5");
  assert.equal(PACKAGE_PINS[20].number, 21);
  assert.equal(PACKAGE_PINS[59].name, "BOOT0");
  assert.equal(pinFromIoc("PC13-ANTI_TAMP"), "PC13");
  assert.equal(pinFromIoc("PH0 - OSC_IN"), "PH0");
  assert.equal(pinFromIoc("PA0-WKUP"), "PA0");
  assert.equal(pinFromIoc("VP_SYS_VS_Systick"), null);
  assert.equal(pinFromIoc("PB11"), null);
});

test("alternate functions: the AF number of a signal on a pin, the pins a signal can use, the HAL macro", () => {
  assert.equal(afNumber("PA2", "USART2_TX"), 7);
  assert.equal(afNumber("PB6", "I2C1_SCL"), 4);
  assert.equal(afNumber("PB3", "I2C2_SDA"), 9);
  assert.equal(afNumber("PB4", "SPI3_MISO"), 6);
  assert.equal(afNumber("PC7", "USART6_RX"), 8);
  assert.equal(afNumber("PB8", "TIM10_CH1"), 3);
  assert.equal(afNumber("PA8", "TIM1_CH1"), 1);
  assert.equal(afNumber("PA5", "USART2_TX"), null);
  assert.equal(afNumber("PC13", "TIM2_CH1"), null);
  assert.deepEqual(pinsFor("USART1_TX"), ["PA9", "PB6"]);
  assert.deepEqual(pinsFor("I2C1_SDA"), ["PB7", "PB9"]);
  assert.deepEqual(pinsFor("TIM2_CH1"), ["PA0", "PA5", "PA15"]);
  assert.deepEqual(pinsFor("ADC1_IN10"), ["PC0"]);
  assert.equal(afMacro(7, "USART2_TX"), "GPIO_AF7_USART2");
  assert.equal(afMacro(9, "I2C2_SDA"), "GPIO_AF9_I2C2");
  assert.equal(adcChannel("PB1"), 9);
  assert.equal(adcChannel("PB2"), null);
  // The pin menu: GPIO modes, EXTI of its line, ADC input, AFs (unsupported marked).
  const pa7 = signalChoices("PA7").map((s) => s.signal);
  assert.deepEqual(pa7, ["GPIO_Input", "GPIO_Output", "GPIO_Analog", "GPXTI7", "ADC1_IN7", "TIM1_CH1N", "TIM3_CH2", "SPI1_MOSI"]);
  assert.equal(signalChoices("PA7").find((s) => s.signal === "TIM1_CH1N")?.unsupported, true);
  assert.equal(signalChoices("PA7").find((s) => s.signal === "TIM3_CH2")?.unsupported, undefined);
});

test("Nucleo header names of an MCU pin (from the board part's pin map)", () => {
  assert.deepEqual(boardNames("PA5"), ["D13", "CN10-11"]);
  assert.deepEqual(boardNames("PA0"), ["A0", "CN7-28"]);
  assert.deepEqual(boardNames("PC13"), ["CN7-23"]);
  assert.deepEqual(boardNames("PB8"), ["D15", "CN10-3"]);
});

// ------------------------------------------------------------------ model and checks

test("assigning a signal enables its peripheral with defaults; freeing the last pin turns it off", () => {
  let c = emptyConfig();
  c = assignPin(c, "PA9", "USART1_TX");
  assert.deepEqual(c.usart.USART1, { baud: 115200, wordLength: 8, parity: "none", stopBits: 1, direction: "tx_rx" });
  c = assignPin(c, "PA10", "USART1_RX");
  c = assignPin(c, "PA9", null);
  assert.ok(c.usart.USART1, "RX still uses it");
  c = assignPin(c, "PA10", null);
  assert.equal(c.usart.USART1, undefined);
  // A timer channel gets PWM; an ADC input a rank (scan from two).
  c = assignPin(c, "PA6", "TIM3_CH1");
  assert.equal(c.tim.TIM3?.channels[0]?.mode, "pwm");
  c = assignPin(c, "PA0", "ADC1_IN0");
  c = assignPin(c, "PA1", "ADC1_IN1");
  assert.deepEqual(c.adc.ADC1?.ranks.map((r) => r.channel), [0, 1]);
  assert.equal(c.adc.ADC1?.scan, true);
  c = assignPin(c, "PA0", "GPIO_Output", "LED");
  assert.deepEqual(c.adc.ADC1?.ranks.map((r) => r.channel), [1]);
  assert.deepEqual(c.pins.PA0, { signal: "GPIO_Output", label: "LED", pull: "none", speed: "low", high: false });
  assert.equal(labelMacro("LD2 [Green Led]"), "LD2");
  assert.equal(labelMacro("my led"), "my_led");
});

test("the Nucleo defaults: LD2 on PA5, B1 on PC13 (EXTI), USART2 on PA2/PA3, SWD; no problems", () => {
  const c = nucleoDefaults();
  assert.equal(c.pins.PA5.signal, "GPIO_Output");
  assert.equal(c.pins.PA5.label, "LD2");
  assert.equal(c.pins.PC13.signal, "GPXTI13");
  assert.equal(c.pins.PA2.signal, "USART2_TX");
  assert.equal(c.pins.PA13.signal, "SYS_JTMS-SWDIO");
  assert.deepEqual(validate(c), []);
});

test("conflicts: a signal on two pins, an AF the pin lacks, a shared EXTI line, a missing pin, a label twice", () => {
  const msgs = (c: CubeConfig) => validate(c).map((i) => `${i.severity}:${i.message}`);
  let c = nucleoDefaults();
  c.pins.PA9 = { signal: "USART2_TX" };
  assert.ok(msgs(c).some((m) => m.startsWith("error:") && m.includes("USART2_TX을(를) 두 핀(PA2, PA9)")), msgs(c).join("\n"));
  c = nucleoDefaults();
  c.pins.PB0 = { signal: "USART1_TX" };
  assert.ok(msgs(c).some((m) => m.includes("PB0: USART1_TX은(는) 이 핀의 대체 기능(AF)에 없습니다")), msgs(c).join("\n"));
  c = assignPin(nucleoDefaults(), "PA13", "GPXTI13");
  assert.ok(msgs(c).some((m) => m.includes("EXTI 줄 13")), msgs(c).join("\n"));
  assert.ok(msgs(c).some((m) => m.startsWith("warning:") && m.includes("SWD")), msgs(c).join("\n"));
  c = assignPin(nucleoDefaults(), "PB8", "I2C1_SCL");
  assert.ok(msgs(c).some((m) => m.includes("I2C1: I2C1_SDA 핀이 정해지지 않았습니다")), msgs(c).join("\n"));
  c = assignPin(nucleoDefaults(), "PB0", "GPIO_Output", "LD2");
  assert.ok(msgs(c).some((m) => m.includes("라벨 'LD2'")), msgs(c).join("\n"));
  c = nucleoDefaults();
  c.pins.PB2 = { signal: "ADC1_IN3" };
  assert.ok(msgs(c).some((m) => m.includes("아날로그 입력이 없는 핀")), msgs(c).join("\n"));
  c = assignPin(nucleoDefaults(), "PA7", "TIM1_CH1N");
  assert.ok(msgs(c).some((m) => m.startsWith("warning:") && m.includes("아직 만들지 않습니다")), msgs(c).join("\n"));
  // A UART baud rate the bus clock cannot make closely.
  c = nucleoDefaults();
  c.usart.USART2!.baud = 2_550_000;
  assert.ok(msgs(c).some((m) => m.includes("USART2: 실제 보레이트")), msgs(c).join("\n"));
  assert.equal(hasErrors(validate(nucleoDefaults())), false);
});

// ------------------------------------------------------------------ clock

test("clock tree: the default 84 MHz from HSI/16*336/4, APB1 42 MHz, timer clocks ×2, 2 wait states", () => {
  const t = computeClock(defaultClock());
  assert.equal(t.vcoIn, 1_000_000);
  assert.equal(t.vcoOut, 336_000_000);
  assert.equal(t.sysclk, 84_000_000);
  assert.equal(t.pclk1, 42_000_000);
  assert.equal(t.pclk2, 84_000_000);
  assert.equal(t.tim1, 84_000_000);
  assert.equal(t.tim2, 84_000_000);
  assert.equal(t.pllQ, 48_000_000);
  assert.equal(t.latency, 2);
  assert.deepEqual(t.issues, []);
  assert.equal(latencyFor(30_000_000), 0);
  assert.equal(latencyFor(30_000_001), 1);
  assert.equal(latencyFor(84_000_000), 2);
  // HSE bypass (the ST-LINK's 8 MHz) /4 = 2 MHz into the VCO.
  const hse = computeClock({ ...defaultClock(), pllSource: "HSE", pllM: 4, pllN: 168 });
  assert.equal(hse.vcoIn, 2_000_000);
  assert.equal(hse.sysclk, 84_000_000);
  // No PLL: HSI 16 MHz, no wait state.
  const hsi = computeClock({ ...defaultClock(), sysclk: "HSI", pllOn: false });
  assert.equal(hsi.sysclk, 16_000_000);
  assert.equal(hsi.latency, 0);
});

test("clock checks: SYSCLK over 84 MHz, APB1 over 42 MHz, VCO ranges, HSE off, too few wait states, USB 48 MHz", () => {
  const issues = (over: Partial<ReturnType<typeof defaultClock>>) => computeClock({ ...defaultClock(), ...over }).issues.map((i) => `${i.node}:${i.message}`);
  assert.ok(issues({ pllP: 2 }).some((m) => m.startsWith("sysclk:") && m.includes("최대 84 MHz")), issues({ pllP: 2 }).join("\n"));
  assert.ok(issues({ apb1Div: 1 }).some((m) => m.startsWith("apb1:") && m.includes("42 MHz")));
  assert.ok(issues({ pllM: 4 }).some((m) => m.startsWith("vcoIn:")));
  assert.ok(issues({ pllN: 100 }).some((m) => m.startsWith("vcoOut:")));
  assert.ok(issues({ pllSource: "HSE", hse: "off" }).some((m) => m.startsWith("hse:")));
  assert.ok(issues({ hse: "crystal", pllSource: "HSE", pllM: 8 }).some((m) => m.startsWith("hse:") && m.includes("크리스털")));
  assert.ok(issues({ latency: 1 }).some((m) => m.startsWith("latency:")));
  assert.ok(issues({ usb48: true, pllQ: 6 }).some((m) => m.startsWith("usb:")));
  assert.deepEqual(issues({ usb48: true }), []);
  assert.ok(issues({ vos: 3 }).some((m) => m.startsWith("hclk:") && m.includes("스케일 3")));
  // validate() carries them as RCC errors.
  const c = nucleoDefaults();
  c.clock.pllN = 400;
  assert.ok(validate(c).some((i) => i.where === "RCC" && i.severity === "error"));
});

test("PWM frequency and duty of a timer channel", () => {
  let c = assignPin(nucleoDefaults(), "PA0", "TIM2_CH1");
  c.tim.TIM2!.prescaler = 83;
  c.tim.TIM2!.period = 999;
  c.tim.TIM2!.channels[0]!.pulse = 250;
  const p = pwmInfo(c, "TIM2", 0)!;
  assert.equal(Math.round(p.hz), 1000);
  assert.equal(p.duty, 0.25);
  c = clone(c);
  c.tim.TIM2!.counterMode = "center1";
  assert.equal(Math.round(pwmInfo(c, "TIM2", 0)!.hz), 500);
});

// ------------------------------------------------------------------ code generation

const SNAP = join(DATA, "snapshots");
const UPDATE = process.env.UPDATE_SNAPSHOTS === "1";

test("code generation snapshots per peripheral (main.c, main.h, it, msp, hal_conf)", () => {
  const failed: string[] = [];
  for (const [name, c] of Object.entries(snapshotConfigs())) {
    assert.deepEqual(validate(c).filter((i) => i.severity === "error"), [], `${name} is a valid configuration`);
    for (const f of generate(c)) {
      const file = join(SNAP, name, f.path.replace(/\//g, "__"));
      if (UPDATE || !existsSync(file)) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, f.text);
        continue;
      }
      if (readFileSync(file, "utf8") !== f.text) failed.push(`${name}/${f.path}`);
    }
  }
  assert.deepEqual(failed, [], "regenerate with UPDATE_SNAPSHOTS=1 if the change is intended");
});

test("generated code: CubeMX's functions and values per peripheral", () => {
  const s = snapshotConfigs();
  const has = (t: string, ...needles: string[]) => {
    for (const n of needles) assert.ok(t.includes(n), `missing: ${n}`);
  };
  const nucleo = mainC(s.nucleo);
  has(nucleo, "void SystemClock_Config(void)", "RCC_OscInitStruct.PLL.PLLN = 336;", "RCC_OscInitStruct.PLL.PLLP = RCC_PLLP_DIV4;", "FLASH_LATENCY_2", "static void MX_GPIO_Init(void);", "static void MX_USART2_UART_Init(void);");
  has(nucleo, "HAL_GPIO_WritePin(LD2_GPIO_Port, LD2_Pin, GPIO_PIN_RESET);", "GPIO_InitStruct.Mode = GPIO_MODE_IT_FALLING;", "HAL_NVIC_EnableIRQ(EXTI15_10_IRQn);", "__HAL_RCC_GPIOC_CLK_ENABLE();");
  has(nucleo, "/* USER CODE BEGIN WHILE */\n  while (1)\n  {\n    /* USER CODE END WHILE */\n\n    /* USER CODE BEGIN 3 */\n  }\n  /* USER CODE END 3 */");
  has(itC(s.nucleo), "void EXTI15_10_IRQHandler(void)", "HAL_GPIO_EXTI_IRQHandler(B1_Pin);", "HAL_IncTick();");
  assert.ok(!itC(s.nucleo).includes("USART2_IRQHandler"), "no USART2 handler without its NVIC entry");
  has(mspC(s.nucleo), "void HAL_UART_MspInit(UART_HandleTypeDef* huart)", "GPIO_InitStruct.Pin = USART_TX_Pin|USART_RX_Pin;", "GPIO_InitStruct.Alternate = GPIO_AF7_USART2;");
  has(mainC(s.uart), "huart1.Init.BaudRate = 9600;", "UART_WORDLENGTH_9B", "UART_PARITY_EVEN", "UART_STOPBITS_2", "huart6.Init.Mode = UART_MODE_TX;");
  has(itC(s.uart), "void USART1_IRQHandler(void)", "HAL_UART_IRQHandler(&huart1);", "extern UART_HandleTypeDef huart1;");
  has(mspC(s.uart), "GPIO_AF8_USART6", "HAL_NVIC_SetPriority(USART1_IRQn, 2, 0);");
  has(mainC(s.i2c), "hi2c1.Init.ClockSpeed = 400000;", "I2C_DUTYCYCLE_16_9", "static void MX_I2C3_Init(void)");
  has(mspC(s.i2c), "GPIO_MODE_AF_OD", "GPIO_AF4_I2C1", "GPIO_AF4_I2C3", "__HAL_RCC_I2C3_CLK_ENABLE();");
  has(itC(s.i2c), "HAL_I2C_EV_IRQHandler(&hi2c1);", "HAL_I2C_ER_IRQHandler(&hi2c1);");
  has(mainC(s.spi), "SPI_BAUDRATEPRESCALER_32", "SPI_POLARITY_HIGH", "SPI_PHASE_2EDGE", "hspi2.Init.DataSize = SPI_DATASIZE_16BIT;", "HAL_GPIO_WritePin(CS_GPIO_Port, CS_Pin, GPIO_PIN_SET);");
  has(mspC(s.spi), "GPIO_AF5_SPI1", "GPIO_AF5_SPI2", "SPI2 GPIO Configuration");
  assert.ok(!mspC(s.spi).includes("SPI2_MISO"), "transmit-only: no MISO");
  const tim = mainC(s.tim);
  has(tim, "htim2.Init.Prescaler = 83;", "htim2.Init.Period = 999;", "sConfigOC.Pulse = 250;", "TIM_CHANNEL_2", "TIM_OCMODE_PWM2", "TIM_OCPOLARITY_LOW", "HAL_TIM_MspPostInit(&htim2);");
  has(tim, "HAL_TIMEx_ConfigBreakDeadTime(&htim1, &sBreakDeadTimeConfig)", "htim1.Init.RepetitionCounter = 0;", "TIM_COUNTERMODE_CENTERALIGNED1", "TIM_AUTORELOAD_PRELOAD_ENABLE");
  assert.ok(!/HAL_TIM_ConfigClockSource\(&htim10/.test(tim), "TIM10 has no clock source selection");
  assert.ok(!/MasterConfigSynchronization\(&htim10/.test(tim), "TIM10 has no master mode");
  has(mspC(s.tim), "void HAL_TIM_MspPostInit(TIM_HandleTypeDef* htim)", "GPIO_AF1_TIM2", "GPIO_AF1_TIM1", "GPIO_AF3_TIM10", "void HAL_TIM_Base_MspInit(TIM_HandleTypeDef* htim_base)");
  // TIM1 and TIM10 share TIM1_UP_TIM10_IRQn: both handlers in one.
  has(itC(s.tim), "void TIM1_UP_TIM10_IRQHandler(void)\n{\n  /* USER CODE BEGIN TIM1_UP_TIM10_IRQn 0 */\n\n  /* USER CODE END TIM1_UP_TIM10_IRQn 0 */\n  HAL_TIM_IRQHandler(&htim1);\n  HAL_TIM_IRQHandler(&htim10);", "void TIM5_IRQHandler(void)");
  has(mainC(s.adc), "hadc1.Init.Resolution = ADC_RESOLUTION_10B;", "hadc1.Init.NbrOfConversion = 3;", "sConfig.Channel = ADC_CHANNEL_10;\n  sConfig.Rank = 1;\n  sConfig.SamplingTime = ADC_SAMPLETIME_480CYCLES;", "ADC_EOC_SEQ_CONV", "hadc1.Init.ContinuousConvMode = ENABLE;");
  has(mspC(s.adc), "GPIO_InitStruct.Mode = GPIO_MODE_ANALOG;", "GPIO_InitStruct.Pin = GPIO_PIN_0|POT_Pin;", "HAL_NVIC_EnableIRQ(ADC_IRQn);");
  const gpio = mainC(s.gpio);
  has(gpio, "GPIO_MODE_OUTPUT_OD", "HAL_GPIO_WritePin(GPIOB, GPIO_PIN_1|GPIO_PIN_2, GPIO_PIN_RESET);", "GPIO_MODE_IT_RISING_FALLING", "GPIO_PULLDOWN", "GPIO_PULLUP", "GPIO_MODE_ANALOG", "HAL_NVIC_SetPriority(EXTI4_IRQn, 4, 0);", "GPIO_SPEED_FREQ_HIGH");
  const clock = mainC(s.clock);
  has(clock, "RCC_OscInitStruct.OscillatorType = RCC_OSCILLATORTYPE_HSE;", "RCC_OscInitStruct.HSEState = RCC_HSE_BYPASS;", "RCC_PLLSOURCE_HSE", "RCC_SYSCLK_DIV2", "FLASH_LATENCY_3");
  // hal_conf enables the modules in use (and the base ones).
  assert.deepEqual(halModules(s.adc), ["ADC", "UART", "GPIO", "EXTI", "DMA", "RCC", "FLASH", "PWR", "CORTEX"]);
  has(generate(s.spi).find((f) => f.path.endsWith("hal_conf.h"))!.text, "#define HAL_SPI_MODULE_ENABLED", "/* #define HAL_I2C_MODULE_ENABLED */", "#define HSE_VALUE    8000000U");
});

// ------------------------------------------------------------------ USER CODE

test("USER CODE regions: found by name, kept on regeneration, lost ones moved into an #if 0 orphan block", () => {
  const c = nucleoDefaults("keep");
  let main = mainC(c);
  const names = regions(main).map((r) => r.name);
  for (const n of ["Header", "Includes", "PV", "0", "1", "2", "WHILE", "3", "USART2_Init 0", "USART2_Init 2", "MX_GPIO_Init_1", "4", "Error_Handler_Debug"]) assert.ok(names.includes(n), n);
  main = setRegion(main, "2", "\n  HAL_GPIO_WritePin(LD2_GPIO_Port, LD2_Pin, GPIO_PIN_SET);\n  ");
  main = setRegion(main, "3", "\n    HAL_GPIO_TogglePin(LD2_GPIO_Port, LD2_Pin);\n    HAL_Delay(250);\n  }\n  ");
  main = setRegion(main, "USART2_Init 2", "\n  /* after the UART is up */\n  uart_ready = 1;\n  ");
  main = setRegion(main, "PV", "\nvolatile int uart_ready;\n");
  // Change the baud rate: everything kept, the new value in place.
  const c2 = clone(c);
  c2.usart.USART2!.baud = 9600;
  const m = mergeUserCode(mainC(c2), main);
  assert.ok(m.text.includes("huart2.Init.BaudRate = 9600;"));
  assert.ok(!m.text.includes("BaudRate = 115200"));
  for (const s of ["HAL_GPIO_TogglePin(LD2_GPIO_Port, LD2_Pin);\n    HAL_Delay(250);\n  }", "uart_ready = 1;", "volatile int uart_ready;", "GPIO_PIN_SET);\n  /* USER CODE END 2 */"]) assert.ok(m.text.includes(s), s);
  assert.deepEqual(m.orphaned, []);
  assert.ok(m.kept.includes("USART2_Init 2") && m.kept.includes("3"));
  // Same config again: identical text (regenerating is idempotent).
  assert.equal(mergeUserCode(mainC(c2), m.text).text, m.text);
  // USART2 off: its region is gone; the code goes into the orphan block, #if 0.
  const c3 = assignPin(assignPin(c2, "PA2", null), "PA3", null);
  assert.equal(c3.usart.USART2, undefined);
  const o = mergeUserCode(mainC(c3), m.text);
  assert.deepEqual(o.orphaned, ["USART2_Init 2"]);
  const orphan = regions(o.text).find((r) => r.name === ORPHAN_REGION)!;
  assert.ok(orphan, "orphan region");
  assert.match(orphan.body, /'USART2_Init 2'[\s\S]*#if 0\n  \/\* after the UART is up \*\/\n  uart_ready = 1;\n#endif/);
  assert.ok(!o.text.includes("MX_USART2_UART_Init"));
  // Regenerated once more, the orphan block stays (once).
  const again = mergeUserCode(mainC(c3), o.text);
  assert.equal(regions(again.text).filter((r) => r.name === ORPHAN_REGION).length, 1);
  assert.equal(again.text.split("uart_ready = 1;").length, 2);
  // USART2 back on: the region is new and empty, the orphan block still holds the old code.
  const back = mergeUserCode(mainC(c2), again.text);
  assert.ok(back.text.includes("MX_USART2_UART_Init"));
  assert.equal(regions(back.text).find((r) => r.name === "USART2_Init 2")!.body, "\n\n  ");
  // Edits outside regions are counted (they are overwritten).
  const outside = m.text.replace("  HAL_Init();", "  HAL_Init(); /* mine */");
  assert.equal(editsOutsideRegions(mainC(c2), outside), 1);
  assert.equal(editsOutsideRegions(mainC(c2), m.text), 0);
});

test("regenerating a project: plan per file (kept, orphaned, lost edits), syscalls.c only when missing", () => {
  const p = newCubeProject(nucleoDefaults("plan"));
  const main = p.files.find((f) => f.path === "Core/Src/main.c")!;
  assert.match(main.text, /int __io_putchar\(int ch\)/, "starter printf retarget for USART2");
  assert.match(main.text, /#include <stdio.h>/);
  const edited = { ...p, files: p.files.map((f) => (f.path === "Core/Src/main.c" ? { ...f, text: setRegion(f.text, "3", "\n    printf(\"hi\\r\\n\");\n  }\n  ") } : f)) };
  const cfg = projectConfig(edited).config;
  cfg.usart.USART2!.baud = 57600;
  const plan = planRegeneration(edited, cfg);
  const m = plan.find((x) => x.path === "Core/Src/main.c")!;
  assert.ok(m.after.includes("57600") && m.after.includes('printf("hi\\r\\n");') && m.after.includes("__io_putchar"));
  assert.ok(m.kept.includes("3") && m.kept.includes("0"));
  // The changed baud rate line is the generator's, not an edit to lose.
  assert.equal(m.lostEdits, 0);
  const outside = { ...edited, files: edited.files.map((f) => (f.path === "Core/Src/main.c" ? { ...f, text: f.text.replace("  HAL_Init();", "  HAL_Init(); /* mine */") } : f)) };
  assert.equal(planRegeneration(outside, cfg).find((x) => x.path === "Core/Src/main.c")!.lostEdits, 1);
  assert.ok(!plan.some((x) => x.path === "Core/Src/syscalls.c"), "syscalls.c exists: not regenerated");
  const next = applyRegeneration(edited, cfg, plan);
  assert.equal(projectConfig(next).config.usart.USART2!.baud, 57600);
  assert.match(next.ioc!, /USART2\.BaudRate=57600/);
  const dropped = { ...next, files: next.files.filter((f) => f.path !== "Core/Src/sysmem.c") };
  assert.ok(planRegeneration(dropped, cfg).some((x) => x.path === "Core/Src/sysmem.c" && x.before === null));
});

// ------------------------------------------------------------------ .ioc

test(".ioc properties: escaped keys and values (spaces, colons, #) read and written back", () => {
  const p = parseProperties("#c\nPH0\\ -\\ OSC_IN.Mode=HSE-External-Clock-Source\nNVIC.X_IRQn=true\\:0\\:0\nADC1.Rank-0\\#ChannelRegularConversion=1\n  spaced = v \n");
  assert.equal(p.get("PH0 - OSC_IN.Mode"), "HSE-External-Clock-Source");
  assert.equal(p.get("NVIC.X_IRQn"), "true:0:0");
  assert.equal(p.get("ADC1.Rank-0#ChannelRegularConversion"), "1");
  assert.equal(p.get("spaced"), "v ");
  const back = parseProperties(writeProperties(p));
  assert.deepEqual([...back].sort(), [...p].sort());
  assert.match(writeProperties(p), /^PH0\\ -\\ OSC_IN\.Mode=HSE-External-Clock-Source$/m);
  assert.match(writeProperties(p), /^NVIC\.X_IRQn=true\\:0\\:0$/m);
});

test(".ioc fixtures parse into the model with Korean warnings for what is left out", () => {
  const blinky = parseIoc(fixture("nucleo-blinky.ioc"));
  assert.deepEqual(blinky.warnings, []);
  const c = blinky.config;
  assert.equal(c.projectName, "blinky");
  assert.equal(c.pins.PA5.signal, "GPIO_Output");
  assert.equal(labelMacro(c.pins.PA5.label!), "LD2");
  assert.equal(c.pins.PC13.edge, "falling");
  assert.equal(c.clock.hse, "bypass");
  assert.equal(computeClock(c.clock).sysclk, 84_000_000);
  assert.deepEqual(c.nvic.USART2, { enabled: true, preempt: 0, sub: 0 });
  assert.deepEqual(validate(c), []);

  const pwm = parseIoc(fixture("pwm-adc.ioc"));
  assert.equal(pwm.config.tim.TIM2?.channels[0]?.pulse, 250);
  assert.equal(pwm.config.tim.TIM3?.period, 19999);
  assert.equal(pwm.config.pins.PA5.signal, "TIM2_CH1");
  assert.deepEqual(pwm.config.adc.ADC1?.ranks, [{ channel: 0, sampling: 84 }, { channel: 1, sampling: 84 }]);
  assert.equal(pwm.config.clock.pllSource, "HSE");
  assert.equal(computeClock(pwm.config.clock).vcoIn, 2_000_000);
  assert.equal(pwm.config.usart.USART2?.baud, 9600);
  assert.ok(pwm.warnings.some((w) => w.startsWith("DMA:")), pwm.warnings.join("\n"));
  assert.ok(pwm.warnings.some((w) => w.includes("DMA2_Stream0")), pwm.warnings.join("\n"));
  assert.deepEqual(validate(pwm.config).filter((i) => i.severity === "error"), []);

  const bus = parseIoc(fixture("sensors-bus.ioc"));
  assert.deepEqual(bus.config.i2c.I2C1, { speed: 400000, duty: "16_9", ownAddress: 0 });
  assert.deepEqual(bus.config.spi.SPI1, { mode: "master", direction: "2lines", dataSize: 8, prescaler: 8, cpol: 1, cpha: 1, firstBit: "msb" });
  assert.deepEqual(bus.config.usart.USART1, { baud: 9600, wordLength: 9, parity: "even", stopBits: 1, direction: "tx_rx" });
  assert.equal(bus.config.pins.PB0.high, true);
  assert.equal(bus.config.pins.PB6.pull, "down");
  assert.equal(bus.config.pins.PC13.edge, "both");
  assert.equal(bus.config.clock.hse, "off");
  assert.ok(bus.warnings.some((w) => w.includes("FREERTOS")), bus.warnings.join("\n"));
  assert.ok(bus.warnings.some((w) => w.includes("V1.27.1")), bus.warnings.join("\n"));
  // Not this MCU: a warning, not an error.
  const other = parseIoc(fixture("nucleo-blinky.ioc").replace("Mcu.UserName=STM32F401RETx", "Mcu.UserName=STM32F411RETx"));
  assert.ok(other.warnings.some((w) => w.includes("STM32F411RETx")));
  // Garbage: still a configuration.
  assert.ok(parseIoc("not an ioc\n=\n").config.pins);
});

test(".ioc round trips: fixtures → model → .ioc → the same model; every snapshot config too", () => {
  for (const f of ["nucleo-blinky.ioc", "pwm-adc.ioc", "sensors-bus.ioc"]) {
    const a = parseIoc(fixture(f)).config;
    const exported = exportIoc(a);
    const b = parseIoc(exported);
    assert.deepEqual(b.config, a, f);
    assert.deepEqual(b.warnings, [], `${f}: what we write we read without warnings`);
    assert.match(exported, /^#MicroXplorer Configuration settings - do not modify\n/);
    assert.match(exported, /^Mcu\.UserName=STM32F401RETx$/m);
  }
  for (const [name, c0] of Object.entries(snapshotConfigs())) {
    const c = { ...c0, drivers: DEFAULT_PACK.id };
    const r = parseIoc(exportIoc(c));
    assert.deepEqual(r.config, c, name);
    assert.deepEqual(r.warnings, [], name);
  }
  // CubeMX's forms in the output.
  const t = exportIoc(snapshotConfigs().tim);
  assert.match(t, /^PA5\.Signal=S_TIM2_CH1_ETR$/m);
  assert.match(t, /^SH\.S_TIM2_CH1_ETR\.0=TIM2_CH1,PWM Generation1 CH1$/m);
  assert.match(t, /^TIM2\.Pulse-PWM\\ Generation1\\ CH1=250$/m);
  assert.match(t, /^NVIC\.TIM5_IRQn=true\\:3\\:0/m);
  assert.match(t, /^PH0\\ -\\ OSC_IN\.Mode=HSE-External-Clock-Source$/m);
  assert.match(exportIoc(snapshotConfigs().adc), /^PA0-WKUP\.Signal=ADCx_IN0$/m);
});

// ------------------------------------------------------------------ project tree and zip

const PACK = packFiles(FW, DEFAULT_PACK.id);

test("the driver bundle: HAL Inc/Src, CMSIS core and device headers, licences, start-up, SystemInit, linker script", () => {
  const paths = PACK.map((f) => f.path);
  for (const p of [
    "Drivers/STM32F4xx_HAL_Driver/Inc/stm32f4xx_hal.h",
    "Drivers/STM32F4xx_HAL_Driver/Inc/Legacy/stm32_hal_legacy.h",
    "Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_uart.c",
    "Drivers/STM32F4xx_HAL_Driver/LICENSE.md",
    "Drivers/CMSIS/Include/core_cm4.h",
    "Drivers/CMSIS/Device/ST/STM32F4xx/Include/stm32f401xe.h",
    "Core/Startup/startup_stm32f401retx.s",
    "Core/Src/system_stm32f4xx.c",
    "STM32F401RETX_FLASH.ld",
  ])
    assert.ok(paths.includes(p), p);
  assert.match(text(PACK.find((f) => f.path === "Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal.c")!.data), /__STM32F4xx_HAL_VERSION_SUB2\s+\(0x06U\)/);
});

test("a new project: a CubeIDE-like tree (Core/Inc, Core/Src, Core/Startup, Drivers/, .ioc, linker script, .project)", () => {
  const p = newCubeProject(nucleoDefaults("my blinky!"));
  assert.equal(p.template, "cube");
  assert.equal(p.drivers, DEFAULT_PACK.id);
  assert.deepEqual(p.files.map((f) => f.path), [
    "Core/Src/main.c",
    "Core/Src/stm32f4xx_hal_msp.c",
    "Core/Src/stm32f4xx_it.c",
    "Core/Src/syscalls.c",
    "Core/Src/sysmem.c",
    "Core/Inc/main.h",
    "Core/Inc/stm32f4xx_hal_conf.h",
    "Core/Inc/stm32f4xx_it.h",
  ]);
  assert.equal(safeProjectName("my blinky!"), "my_blinky");
  const tree = projectTree(p, PACK.map((f) => ({ path: f.path, bytes: f.data.length })));
  const at = (path: string) => tree.find((n) => n.path === path);
  assert.equal(at("Core/Src/main.c")?.kind, "generated");
  assert.equal(at("Core/Startup/startup_stm32f401retx.s")?.kind, "pack");
  assert.equal(at("Core/Startup/startup_stm32f401retx.s")?.readOnly, true);
  assert.equal(at("Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_gpio.c")?.readOnly, true);
  assert.equal(at("my_blinky.ioc")?.kind, "ioc");
  assert.ok(at(".project") && at(".cproject"));
  // Core first, then Drivers, then the root files.
  const first = (pre: string) => tree.findIndex((n) => n.path.startsWith(pre));
  assert.ok(first("Core/") < first("Drivers/") && first("Drivers/") < first("my_blinky.ioc"));
  // The project file keeps it (sanitize), a share link carries the .ioc.
  const notes: string[] = [];
  const back = sanitizeCode(JSON.parse(JSON.stringify(p)), notes);
  assert.deepEqual(notes, []);
  assert.equal(back?.template, "cube");
  assert.equal(back?.ioc, p.ioc);
  assert.equal(forShare(p).ioc, p.ioc);
  assert.equal(sanitizeCode({ ...p, ioc: "x".repeat(70_000) }, [])?.ioc, undefined);
});

test("zip export opens as a CubeIDE project folder: .project, .cproject, .ioc, Core/, Drivers/, startup, linker script", async () => {
  let p = newCubeProject(nucleoDefaults("exported"));
  p = { ...p, files: p.files.map((f) => (f.path === "Core/Src/main.c" ? { ...f, text: setRegion(f.text, "3", "\n    HAL_GPIO_TogglePin(LD2_GPIO_Port, LD2_Pin);\n  }\n  ") } : f)) };
  const zip = await exportZip(p, PACK);
  const list = listZip(zip).map((e) => e.path);
  for (const f of [".project", ".cproject", "exported.ioc", "Core/Src/main.c", "Core/Inc/main.h", "Core/Src/syscalls.c", "Core/Startup/startup_stm32f401retx.s", "Core/Src/system_stm32f4xx.c", "STM32F401RETX_FLASH.ld", "Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_uart.c", "Drivers/CMSIS/Include/core_cm4.h"])
    assert.ok(list.includes(`exported/${f}`), f);
  assert.ok(list.every((x) => x.startsWith("exported/")));
  assert.equal(new Set(list).size, list.length, "no duplicates");
  const files = new Map((await readZip(zip)).map((e) => [e.path, text(e.data)]));
  assert.match(files.get("exported/.project")!, /<name>exported<\/name>[\s\S]*com\.st\.stm32cube\.ide\.mcu\.MCUProjectNature/);
  const cp = files.get("exported/.cproject")!;
  assert.match(cp, /value="STM32F401RETx"/);
  assert.match(cp, /STM32F401RETX_FLASH\.ld/);
  assert.match(cp, /value="\.\.\/Drivers\/STM32F4xx_HAL_Driver\/Inc"/);
  assert.match(cp, /<listOptionValue builtIn="false" value="STM32F401xE"\/>/);
  // Balanced tags (a crude well-formedness check).
  for (const t of ["cproject", "storageModule", "cconfiguration", "configuration", "toolChain", "tool", "option"]) {
    const open = (cp.match(new RegExp(`<${t}[\\s>]`, "g")) ?? []).length;
    const selfClosed = (cp.match(new RegExp(`<${t}\\b[^>]*/>`, "g")) ?? []).length;
    const close = (cp.match(new RegExp(`</${t}>`, "g")) ?? []).length;
    assert.equal(open - selfClosed, close, t);
  }
  assert.match(files.get("exported/Core/Src/main.c")!, /HAL_GPIO_TogglePin\(LD2_GPIO_Port, LD2_Pin\);/);
  assert.equal(files.get("exported/exported.ioc"), p.ioc);
  assert.equal(exportEntries(p, PACK).length, list.length);

  // Import it back (as CubeIDE would hand it over): the same files and configuration.
  const imported = importCubeProject(
    [...(await readZip(zip)), { path: "exported/Debug/exported.elf", data: new Uint8Array([0x7f, 0x45]), mtime: 0 }, { path: "exported/Debug/Core/Src/main.d", data: new TextEncoder().encode("x"), mtime: 0 }],
    (b) => new TextDecoder().decode(b),
  );
  assert.equal(imported.root, "exported");
  assert.deepEqual(imported.project.files, p.files);
  assert.deepEqual(projectConfig(imported.project).config, projectConfig(p).config);
  assert.ok(imported.warnings.some((w) => w.includes("Core/Startup")), imported.warnings.join("\n"));
});

test("importing a CubeIDE project with only an .ioc and a main.c fills in the generated files", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const main = setRegion(mainC(parseIoc(fixture("nucleo-blinky.ioc")).config), "3", "\n    HAL_Delay(100);\n  }\n  ");
  const r = importCubeProject(
    [
      { path: "blinky/blinky.ioc", data: enc(fixture("nucleo-blinky.ioc")) },
      { path: "blinky/Core/Src/main.c", data: enc(main) },
      { path: "blinky/Core/Src/extra.c", data: enc("int extra;\n") },
      { path: "blinky/Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal.c", data: enc("/* bundled */") },
      { path: "blinky/Release/blinky.elf", data: enc("") },
    ],
    (b) => new TextDecoder().decode(b),
  );
  const paths = r.project.files.map((f) => f.path);
  assert.ok(paths.includes("Core/Src/extra.c"));
  assert.ok(paths.includes("Core/Src/stm32f4xx_it.c") && paths.includes("Core/Inc/main.h") && paths.includes("Core/Src/syscalls.c"));
  assert.ok(!paths.some((x) => x.startsWith("Drivers/")));
  assert.match(r.project.files.find((f) => f.path === "Core/Src/main.c")!.text, /HAL_Delay\(100\);/);
  assert.throws(() => importCubeProject([{ path: "x/main.c", data: enc("") }], () => ""), /\.ioc 파일이 없습니다/);
});

// ------------------------------------------------------------------ build pipeline

test("the cube template compiles against the project's headers (no hal-common) and links its own handlers, MSP and clock", () => {
  const hal = compileFlags(["Core/Inc"]);
  const cube = compileFlags(["Core/Inc"], "cube");
  assert.ok(hal.includes("-I/sdk/include/hal-common"));
  assert.ok(!cube.includes("-I/sdk/include/hal-common"));
  assert.ok(cube.includes("-I/project/Core/Inc") && cube.includes("-I/sdk/include/hal"));
  const lh = linkArgs(["/build/main.o"]);
  const lc = linkArgs(["/build/main.o"], "cube");
  assert.ok(lh.includes("/sdk/lib/obj/stm32f4xx_it.o") && lh.includes("/sdk/lib/obj/clock_config.o"));
  for (const o of ["stm32f4xx_it.o", "stm32f4xx_hal_msp.o", "clock_config.o", "syscalls.o"]) assert.ok(!lc.includes(`/sdk/lib/obj/${o}`), o);
  assert.ok(lc.includes("/sdk/lib/obj/startup_stm32f401xe.o") && lc.includes("/sdk/lib/obj/system_stm32f4xx.o"));
});

// ------------------------------------------------------------------ UI helpers (pure)

test("switching a peripheral on from its form gives it pins (the usual ones, else free ones); off frees them", () => {
  let c = enablePeripheralWithPins(emptyConfig(), "USART2");
  assert.equal(c.pins.PA2?.signal, "USART2_TX");
  assert.equal(c.pins.PA3?.signal, "USART2_RX");
  // PA5 is LD2: SPI1's SCK goes to PB3 instead.
  c = enablePeripheralWithPins(nucleoDefaults(), "SPI1");
  assert.equal(c.pins.PA5.signal, "GPIO_Output");
  assert.equal(c.pins.PB3?.signal, "SPI1_SCK");
  assert.equal(c.pins.PA6?.signal, "SPI1_MISO");
  assert.deepEqual(validate(c).filter((i) => i.severity === "error"), []);
  c = disablePeripheralWithPins(c, "SPI1");
  assert.equal(c.spi.SPI1, undefined);
  assert.ok(!Object.values(c.pins).some((v) => v.signal.startsWith("SPI1_")));
  c = enablePeripheralWithPins(c, "TIM3");
  assert.deepEqual(c.tim.TIM3?.channels, [null, null, null, null]);
});

test("the generation preview's line diff: changes with folded context", () => {
  const a = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
  const b = a.replace("line 10", "line ten").replace("line 20\n", "");
  const d = diffLines(a, b);
  assert.deepEqual(diffStats(d), { added: 1, removed: 2 });
  assert.deepEqual(
    d.filter((l) => l.kind !== "same"),
    [
      { kind: "del", text: "line 10", a: 11 },
      { kind: "add", text: "line ten", b: 11 },
      { kind: "del", text: "line 20", a: 21 },
    ],
  );
  const f = foldDiff(d, 2);
  assert.ok(f.some((l) => l.kind === "skip"));
  assert.deepEqual(diffLines("x", "x"), [{ kind: "same", text: "x", a: 1, b: 1 }]);
  // Changing the baud rate: one line out, one in.
  const c = nucleoDefaults();
  c.usart.USART2!.baud = 9600;
  assert.deepEqual(diffStats(diffLines(mainC(nucleoDefaults()), mainC(c))), { added: 1, removed: 1 });
});

test("배선 대조: parts on pins that are not configured, or configured the wrong way", () => {
  const led = { part: "led1", kind: "led-5mm", pin: "A", name: "LED" };
  const btn = { part: "sw1", kind: "tact-switch", pin: "1", name: "버튼" };
  const pot = { part: "pot1", kind: "potentiometer", pin: "W", name: "가변저항" };
  const c = nucleoDefaults();
  const msg = wiringCheck(c, {
    PB3: [{ part: "r1", kind: "resistor", pin: "1", name: "저항" }, led],
    PA5: [led],
    PC13: [btn],
    PA13: [led],
  }).map((i) => `${i.pin}:${i.message}`);
  assert.ok(msg.some((m) => m.startsWith("PB3:") && m.includes("설정되지 않았습니다") && m.includes("LED(led1.A)")), msg.join("\n"));
  assert.ok(!msg.some((m) => m.startsWith("PA5:")), "LD2's pin is an output");
  assert.ok(!msg.some((m) => m.startsWith("PC13:")), "B1 is an EXTI input");
  assert.ok(!msg.some((m) => m.startsWith("PA13:")), "SWD pins are the board's");
  const c2 = assignPin(assignPin(assignPin(c, "PA10", "GPIO_Output"), "PB0", "GPIO_Input"), "PB2", "GPIO_Input");
  const m2 = wiringCheck(c2, { PA10: [btn], PB0: [pot], PB2: [pot], PA5: [btn] }).map((i) => `${i.pin}:${i.message}`);
  assert.ok(m2.some((m) => m.startsWith("PA10:") && m.includes("GPIO_Input 또는 GPXTI10")), m2.join("\n"));
  assert.ok(m2.some((m) => m.startsWith("PB0:") && m.includes("ADC1_IN8")), m2.join("\n"));
  assert.ok(m2.some((m) => m.startsWith("PB2:") && m.includes("ADC 입력이 없습니다")), m2.join("\n"));
  assert.ok(m2.some((m) => m.startsWith("PA5:") && m.includes("버튼")), m2.join("\n"));
  assert.deepEqual(wiringCheck(assignPin(c, "PB3", "GPIO_Output"), { PB3: [led] }), []);
});
