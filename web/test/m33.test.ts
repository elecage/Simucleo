// M33: writing and building C in the browser — the pure parts: compiler
// message parsing, the symbol index from headers, completion contexts, the
// rule-based suggestions, and the project/share formats with sources.
// The real build is test/m33-toolchain.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { countText, parseDiagnostics } from "../src/code/diagnostics.ts";
import { buildIndex, indexHeader, packIndex, splitParams, unpackIndex } from "../src/code/symbols.ts";
import { callContext, candidates, completionContext, localSymbols, makeTable, resolveType, signatureAt } from "../src/code/complete.ts";
import { lint, type LintRule } from "../src/code/lint.ts";
import { readTar, writeTar } from "../src/code/tar.ts";
import { safeSourcePath } from "../src/code/build.ts";
import { functionDefs, maskC } from "../src/code/cscan.ts";
import { forShare, isStale, lessonStarter, MAX_FILE_BYTES, newFilePath, sanitizeCode, type CodeProject } from "../src/code/project.ts";
import { parseWith, serialize, type CatalogEntry } from "../src/editor/projectFormat.ts";
import { decodeShare, encodeShare } from "../src/share/link.ts";
import { validateLesson } from "../src/lessons/validate.ts";
import { normalizeLesson } from "../src/lessons/mine.ts";
import type { Lesson } from "../src/lessons/types.ts";
import { cacheVersion, collectOptional, collectPrecache, optionalProblems, renderServiceWorker } from "../scripts/precache.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FW = join(here, "..", "..", "firmware");

// ------------------------------------------------------------ diagnostics

test("diagnostics: clang file:line:col: severity: message, flags, notes, fatal errors", () => {
  const out = [
    "In file included from /project/Core/Src/main.c:6:",
    "/project/Core/Inc/app.h:3:1: warning: declaration does not declare anything [-Wmissing-declarations]",
    "/project/Core/Src/main.c:19:20: error: expected ';' after expression",
    "/project/Core/Src/main.c:22:7: warning: unused variable 'x' [-Wunused-variable]",
    "/project/Core/Src/main.c:30:3: error: call to undeclared function 'HAL_Delayy'; ISO C99 and later do not support implicit function declarations [-Wimplicit-function-declaration]",
    "/sdk/include/hal/stm32f4xx_hal.h:212:6: note: 'HAL_Delay' declared here",
    "/project/Core/Src/main.c:40:10: fatal error: 'nothere.h' file not found",
    "3 errors and 2 warnings generated.",
  ].join("\n");
  const d = parseDiagnostics(out);
  assert.equal(d.length, 5);
  assert.deepEqual(
    d.map((x) => [x.file, x.line, x.column, x.severity]),
    [
      ["Core/Inc/app.h", 3, 1, "warning"],
      ["Core/Src/main.c", 19, 20, "error"],
      ["Core/Src/main.c", 22, 7, "warning"],
      ["Core/Src/main.c", 30, 3, "error"],
      ["Core/Src/main.c", 40, 10, "error"],
    ],
  );
  assert.equal(d[1].message, "expected ';' after expression");
  assert.equal(d[2].flag, "-Wunused-variable");
  assert.equal(d[2].message, "unused variable 'x'");
  assert.equal(d[3].notes.length, 1);
  assert.equal(d[3].notes[0].file, "/sdk/include/hal/stm32f4xx_hal.h");
  assert.equal(d[3].notes[0].line, 212);
  assert.equal(countText(d), "오류 3개 · 경고 2개");
  assert.equal(countText([]), "문제 없음");
});

test("diagnostics: ld.lld errors take the file and line of the first reference", () => {
  const out = [
    "ld.lld: error: undefined symbol: HAL_Delay_ms",
    ">>> referenced by main.c:23 (/project/Core/Src/main.c:23)",
    ">>>               /build/Core_Src_main.o:(main)",
    ">>> referenced by main.c:40 (/project/Core/Src/main.c:40)",
    ">>>               /build/Core_Src_main.o:(main)",
    "ld.lld: error: section '.bss' will not fit in region 'RAM': overflowed by 4096 bytes",
  ].join("\n");
  const d = parseDiagnostics(out);
  assert.equal(d.length, 2);
  assert.equal(d[0].tool, "ld");
  assert.equal(d[0].message, "undefined symbol: HAL_Delay_ms");
  assert.equal(d[0].file, "Core/Src/main.c");
  assert.equal(d[0].line, 23);
  assert.equal(d[0].notes.length, 1);
  assert.equal(d[0].notes[0].line, 40);
  assert.equal(d[1].file, null);
  assert.match(d[1].message, /will not fit in region 'RAM'/);
});

test("project paths: relative, no .., .c/.h only", () => {
  for (const ok of ["Core/Src/main.c", "Core/Inc/main.h", "app.c", "Core/Src/my_led-2.c"]) assert.equal(safeSourcePath(ok), true, ok);
  for (const bad of ["../x.c", "/abs.c", "Core/../x.c", "a.s", "Core//x.c", "a b.c", "Core/Src/", ".c"]) assert.equal(safeSourcePath(bad), false, bad);
});

test("tar: what writeTar writes, readTar reads back (long names, binary)", () => {
  const long = `sdk/include/${"a".repeat(80)}/${"b".repeat(60)}.h`;
  const bin = new Uint8Array(1500).map((_, i) => i & 0xff);
  const t = writeTar([
    { name: "sdk/lib/x.a", data: bin },
    { name: long, data: new TextEncoder().encode("#define X 1\n") },
  ]);
  assert.equal(t.length % 512, 0);
  const back = readTar(t);
  assert.deepEqual(back.map((e) => e.name).sort(), [long, "sdk/lib/x.a"].sort());
  assert.deepEqual([...back.find((e) => e.name === "sdk/lib/x.a")!.data], [...bin]);
  const broken = t.slice();
  broken[3] ^= 0xff;
  assert.throws(() => readTar(broken), /checksum/);
});

// ------------------------------------------------------------ symbol index

const SAMPLE = `
#ifndef __SAMPLE_H
#define __SAMPLE_H
#ifdef __cplusplus
extern "C" {
#endif
/** @brief  GPIO Init structure definition */
typedef struct
{
  uint32_t Pin;       /*!< Specifies the GPIO pins to be configured. */
  uint32_t Mode;      /*!< Specifies the operating mode. */
  __IO uint32_t AFR[2];
  void (* Callback)(struct __H *h, uint16_t n); /*!< Called back */
} GPIO_InitTypeDef;

typedef enum
{
  GPIO_PIN_RESET = 0,   /*!< Pin low */
  GPIO_PIN_SET          /*!< Pin high */
} GPIO_PinState;

#define GPIO_PIN_5                 ((uint16_t)0x0020)  /* Pin 5 selected    */
#define GPIOA               ((GPIO_TypeDef *) GPIOA_BASE)
/** @brief  Enable the clock of GPIOA. */
#define __HAL_RCC_GPIOA_CLK_ENABLE()   do { \\
                                        SET_BIT(RCC->AHB1ENR, RCC_AHB1ENR_GPIOAEN);\\
                                      } while(0U)
#define MAX(a, b) ((a) > (b) ? (a) : (b))

/**
  * @brief  Toggles the specified GPIO pins.
  * @param  GPIOx Where x can be (A..I)
  */
void              HAL_GPIO_TogglePin(GPIO_TypeDef* GPIOx, uint16_t GPIO_Pin);
uint32_t HAL_GetTick(void);
extern UART_HandleTypeDef huart2;
typedef uint32_t tick_t;
__STATIC_INLINE void __NOP_TWICE(void)
{
  __NOP(); __NOP();
}
#ifdef __cplusplus
}
#endif
#endif
`;

test("symbol index: functions with signatures and docs, macros, members, enum values, types, externs", () => {
  const syms = indexHeader(SAMPLE, "hal/sample.h");
  const get = (name: string, parent?: string) => syms.find((s) => s.name === name && (parent === undefined || s.parent === parent));
  const toggle = get("HAL_GPIO_TogglePin")!;
  assert.equal(toggle.kind, "function");
  assert.equal(toggle.detail, "void HAL_GPIO_TogglePin(GPIO_TypeDef *GPIOx, uint16_t GPIO_Pin)");
  assert.deepEqual(toggle.params, ["GPIO_TypeDef *GPIOx", "uint16_t GPIO_Pin"]);
  assert.equal(toggle.doc, "Toggles the specified GPIO pins.");
  assert.equal(toggle.file, "hal/sample.h");
  assert.equal(toggle.line, SAMPLE.split("\n").findIndex((l) => l.includes("HAL_GPIO_TogglePin")) + 1);
  assert.deepEqual(get("HAL_GetTick")!.params, []);
  assert.equal(get("GPIO_PIN_5")!.kind, "macro");
  assert.equal(get("GPIO_PIN_5")!.detail, "((uint16_t)0x0020)");
  assert.equal(get("GPIO_PIN_5")!.doc, "Pin 5 selected");
  assert.equal(get("GPIOA")!.castTo, "GPIO_TypeDef");
  const clk = get("__HAL_RCC_GPIOA_CLK_ENABLE")!;
  assert.deepEqual(clk.params, []);
  assert.equal(clk.doc, "Enable the clock of GPIOA.");
  assert.match(clk.detail!, /^do \{ SET_BIT/);
  assert.deepEqual(get("MAX")!.params, ["a", "b"]);
  assert.equal(get("__SAMPLE_H"), undefined, "include guard left out");
  const init = get("GPIO_InitTypeDef")!;
  assert.equal(init.kind, "type");
  assert.equal(init.doc, "GPIO Init structure definition");
  assert.deepEqual(
    syms.filter((s) => s.parent === "GPIO_InitTypeDef").map((s) => [s.name, s.detail]),
    [
      ["Pin", "uint32_t"],
      ["Mode", "uint32_t"],
      ["AFR", "uint32_t[2]"],
      ["Callback", "void (* )(struct __H *h, uint16_t n)"],
    ],
  );
  assert.equal(get("Pin", "GPIO_InitTypeDef")!.doc, "Specifies the GPIO pins to be configured.");
  assert.deepEqual(
    syms.filter((s) => s.kind === "enum").map((s) => [s.name, s.parent, s.detail ?? null, s.doc]),
    [
      ["GPIO_PIN_RESET", "GPIO_PinState", "0", "Pin low"],
      ["GPIO_PIN_SET", "GPIO_PinState", null, "Pin high"],
    ],
  );
  assert.equal(get("huart2")!.kind, "variable");
  assert.equal(get("huart2")!.detail, "UART_HandleTypeDef");
  assert.equal(get("tick_t")!.kind, "type");
  assert.equal(get("__NOP_TWICE")!.kind, "function");
  // Pack/unpack keeps everything.
  assert.deepEqual(unpackIndex(packIndex(syms)), syms);
});

test("symbol index: docs of HAL functions come from the driver sources", () => {
  const header = "HAL_StatusTypeDef HAL_UART_Transmit(UART_HandleTypeDef *huart, const uint8_t *pData, uint16_t Size, uint32_t Timeout);\n";
  const source = "/**\n  * @brief  Sends an amount of data in blocking mode.\n  * @param  huart Pointer\n  */\nHAL_StatusTypeDef HAL_UART_Transmit(UART_HandleTypeDef *huart, const uint8_t *pData, uint16_t Size, uint32_t Timeout)\n{\n  return HAL_OK;\n}\n";
  const [s] = buildIndex([{ file: "hal/u.h", text: header }], [{ text: source }]);
  assert.equal(s.doc, "Sends an amount of data in blocking mode.");
  assert.deepEqual(splitParams("void"), []);
  assert.deepEqual(splitParams("int (*f)(int, int), char *s"), ["int (*f)(int, int)", "char *s"]);
});

test("symbol index: the real HAL headers (as packed for the site)", { skip: !existsSync(join(FW, "vendor/stm32f4xx_hal_driver/Inc/stm32f4xx_hal_gpio.h")) }, () => {
  const read = (p: string) => ({ file: p, text: readFileSync(join(FW, "vendor", p), "latin1") });
  const syms = buildIndex(
    [read("stm32f4xx_hal_driver/Inc/stm32f4xx_hal_gpio.h"), read("cmsis_device_f4/Include/stm32f401xe.h"), read("stm32f4xx_hal_driver/Inc/stm32f4xx_hal_uart.h")],
    [{ text: readFileSync(join(FW, "vendor/stm32f4xx_hal_driver/Src/stm32f4xx_hal_gpio.c"), "latin1") }],
  );
  const t = makeTable(syms);
  assert.equal(t.byName.get("HAL_GPIO_TogglePin")!.doc, "Toggles the specified GPIO pins.");
  assert.equal(t.byName.get("HAL_GPIO_WritePin")!.params!.length, 3);
  assert.deepEqual(t.members.get("GPIO_InitTypeDef")!.map((m) => m.name), ["Pin", "Mode", "Pull", "Speed", "Alternate"]);
  assert.ok(t.members.get("GPIO_TypeDef")!.some((m) => m.name === "ODR"));
  assert.equal(t.byName.get("GPIOA")!.castTo, "GPIO_TypeDef");
  assert.ok(t.members.get("UART_HandleTypeDef")!.some((m) => m.name === "Init" && m.detail === "UART_InitTypeDef"));
});

// ------------------------------------------------------------ completion

const HEADERS = indexHeader(SAMPLE, "hal/sample.h").concat(
  indexHeader(
    `typedef struct { uint32_t MODER; uint32_t ODR; } GPIO_TypeDef;
     typedef struct { uint32_t BaudRate; uint32_t WordLength; } UART_InitTypeDef;
     typedef struct __UART_HandleTypeDef { USART_TypeDef *Instance; UART_InitTypeDef Init; } UART_HandleTypeDef;
     void HAL_GPIO_WritePin(GPIO_TypeDef *GPIOx, uint16_t GPIO_Pin, GPIO_PinState PinState);
     void HAL_GPIO_Init(GPIO_TypeDef *GPIOx, GPIO_InitTypeDef *GPIO_Init);
     void HAL_Delay(uint32_t Delay);`,
    "hal/more.h",
  ),
);

const at = (s: string) => ({ text: s.replace("|", ""), pos: s.indexOf("|") });

test("completion context: members after . and ->, names, none in comments, strings and numbers", () => {
  let c = at("  GPIO_InitStruct.Mo|");
  assert.deepEqual(completionContext(c.text, c.pos), { kind: "member", object: "GPIO_InitStruct", from: c.pos - 2, prefix: "Mo" });
  c = at("x = huart2.Init.|");
  assert.deepEqual(completionContext(c.text, c.pos), { kind: "member", object: "huart2.Init", from: c.pos, prefix: "" });
  c = at("GPIOA -> OD|");
  assert.deepEqual(completionContext(c.text, c.pos), { kind: "member", object: "GPIOA", from: c.pos - 2, prefix: "OD" });
  c = at("  HAL_GPIO_T|");
  assert.deepEqual(completionContext(c.text, c.pos), { kind: "ident", from: c.pos - 10, prefix: "HAL_GPIO_T" });
  for (const s of ["// HAL_GPIO_T|", "/* GPIO_InitStruct.| */", 'printf("HAL_|', "#incl|", "x = 1.|"]) {
    c = at(s);
    assert.deepEqual(completionContext(c.text, c.pos), { kind: "none" }, s);
  }
});

test("completion: HAL_GPIO_T offers HAL_GPIO_TogglePin; struct members; locals and the user's own functions", () => {
  const user = "static int blink_ms = 500;\nvoid led_on(void) { }\nint main(void)\n{\n  GPIO_InitTypeDef GPIO_InitStruct = {0};\n  int counter = 0;\n  |\n}\n";
  const table = makeTable([...HEADERS, ...localSymbols([{ path: "Core/Src/main.c", text: user.replace("|", "") }])]);
  const typed = (s: string) => {
    const c = at(user.replace("|", s));
    return candidates(c.text, c.pos, table)!;
  };
  const r = typed("HAL_GPIO_T|");
  assert.ok(r.options.some((o) => o.label === "HAL_GPIO_TogglePin" && o.detail === "void HAL_GPIO_TogglePin(GPIO_TypeDef *GPIOx, uint16_t GPIO_Pin)"));
  assert.ok(!r.options.some((o) => o.label === "HAL_GPIO_WritePin"), "prefix filtered");
  assert.deepEqual(typed("GPIO_InitStruct.|").options.map((o) => o.label), ["Pin", "Mode", "AFR", "Callback"]);
  assert.deepEqual(typed("GPIOA->|").options.map((o) => o.label), ["MODER", "ODR"]);
  assert.ok(typed("cou|").options.some((o) => o.label === "counter"));
  assert.ok(typed("led|").options.some((o) => o.label === "led_on" && o.kind === "function"));
  assert.ok(typed("blink|").options.some((o) => o.label === "blink_ms"));
  assert.ok(typed("Toggle|").options.some((o) => o.label === "HAL_GPIO_TogglePin"), "contains");
  assert.equal(typed("|"), null, "nothing typed: no popup unless asked");
  // An unknown variable: no member list.
  assert.equal(typed("nothing.|"), null);
});

test("completion: types through members, typedef'd struct tags and callback parameters", () => {
  const table = makeTable([...HEADERS, ...localSymbols([{ path: "m.c", text: "UART_HandleTypeDef huart2;\n" }])]);
  let c = at("void f(void) { huart2.Init.| }");
  assert.equal(resolveType("huart2.Init", c.text, c.pos, table), "UART_InitTypeDef");
  assert.deepEqual(candidates(c.text, c.pos, table)!.options.map((o) => o.label), ["BaudRate", "WordLength"]);
  c = at("void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart) { huart->| }");
  assert.deepEqual(candidates(c.text, c.pos, table)!.options.map((o) => o.label), ["Instance", "Init"]);
  c = at("void g(void) { struct __UART_HandleTypeDef *h; h->| }");
  assert.deepEqual(candidates(c.text, c.pos, table)!.options.map((o) => o.label), ["Instance", "Init"]);
});

test("signature help: the function and argument the cursor is in", () => {
  const table = makeTable(HEADERS);
  let c = at("HAL_GPIO_WritePin(GPIOA, GPIO_PIN_5, |");
  assert.deepEqual(callContext(c.text, c.pos), { fn: "HAL_GPIO_WritePin", arg: 2, open: 17 });
  let s = signatureAt(c.text, c.pos, table)!;
  assert.equal(s.fn.name, "HAL_GPIO_WritePin");
  assert.equal(s.arg, 2);
  c = at("HAL_GPIO_WritePin(f(1, 2), |");
  assert.equal(callContext(c.text, c.pos)!.arg, 1, "commas inside a nested call do not count");
  c = at("HAL_Delay(MAX(1, |");
  s = signatureAt(c.text, c.pos, table)!;
  assert.equal(s.fn.name, "MAX");
  assert.equal(s.arg, 1);
  c = at("HAL_Delay(1); |");
  assert.equal(callContext(c.text, c.pos), null);
  c = at("if (|");
  assert.equal(callContext(c.text, c.pos), null, "not a call");
});

// ------------------------------------------------------------ lint

const MAIN_H = { path: "Core/Inc/main.h", text: "#define LD2_Pin GPIO_PIN_5\n#define LD2_GPIO_Port GPIOA\n#define B1_Pin GPIO_PIN_13\n#define B1_GPIO_Port GPIOC\n" };
const rules = (text: string, extra: { path: string; text: string }[] = []) =>
  lint([{ path: "Core/Src/main.c", text }, MAIN_H, ...extra]).map((i) => i.rule);
const has = (text: string, rule: LintRule) => rules(text).includes(rule);
const where = (text: string, rule: LintRule) => lint([{ path: "Core/Src/main.c", text }, MAIN_H]).find((i) => i.rule === rule);

test("lint: HAL_Delay inside an interrupt callback", () => {
  const bad = "void HAL_GPIO_EXTI_Callback(uint16_t pin)\n{\n  HAL_Delay(50);\n}\n";
  assert.ok(has(bad, "delay-in-isr"));
  assert.equal(where(bad, "delay-in-isr")!.line, 3);
  assert.match(where(bad, "delay-in-isr")!.why, /SysTick/);
  assert.ok(has("void EXTI15_10_IRQHandler(void) { HAL_Delay(1); }", "delay-in-isr"));
  assert.ok(!has("int main(void) { while (1) { HAL_Delay(500); } }", "delay-in-isr"));
  assert.ok(!has("void HAL_GPIO_EXTI_Callback(uint16_t pin) { /* HAL_Delay(50); */ flag = 1; }", "delay-in-isr"));
});

test("lint: an endless loop in an interrupt handler", () => {
  assert.ok(has("void TIM2_IRQHandler(void)\n{\n  while (1) { }\n}\n", "loop-in-isr"));
  assert.ok(has("void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *h) { for (;;) {} }", "loop-in-isr"));
  assert.ok(!has("int main(void) { while (1) { } }", "loop-in-isr"));
  assert.ok(!has("void HardFault_Handler(void) { while (1) { } }", "loop-in-isr"), "fault traps are meant to stop");
  assert.ok(!has("void HAL_UART_RxCpltCallback(UART_HandleTypeDef *h) { while (n < 3) n++; }", "loop-in-isr"));
});

test("lint: a GPIO port configured without its clock", () => {
  const init = (clk: string) =>
    `static void MX_GPIO_Init(void)\n{\n  GPIO_InitTypeDef g = {0};\n  ${clk}\n  g.Pin = LD2_Pin;\n  g.Mode = GPIO_MODE_OUTPUT_PP;\n  HAL_GPIO_Init(LD2_GPIO_Port, &g);\n}\n`;
  const bad = init("");
  assert.ok(has(bad, "clock-missing"));
  assert.match(where(bad, "clock-missing")!.message, /__HAL_RCC_GPIOA_CLK_ENABLE/);
  assert.equal(where(bad, "clock-missing")!.line, 7);
  assert.ok(!has(init("__HAL_RCC_GPIOA_CLK_ENABLE();"), "clock-missing"));
  assert.ok(has(init("__HAL_RCC_GPIOC_CLK_ENABLE();"), "clock-missing"), "another port's clock does not count");
  // In another file of the project.
  assert.ok(!rules(init(""), [{ path: "Core/Src/clocks.c", text: "void clocks(void) { __HAL_RCC_GPIOA_CLK_ENABLE(); }" }]).includes("clock-missing"));
});

test("lint: writing a pin configured as input", () => {
  const cfg = (mode: string, extra = "") =>
    `void MX_GPIO_Init(void)\n{\n  GPIO_InitTypeDef g = {0};\n  __HAL_RCC_GPIOA_CLK_ENABLE();\n  g.Pin = LD2_Pin;\n  g.Mode = ${mode};\n  HAL_GPIO_Init(GPIOA, &g);\n${extra}}\nint main(void) { while (1) { HAL_GPIO_TogglePin(LD2_GPIO_Port, LD2_Pin); } }\n`;
  assert.ok(has(cfg("GPIO_MODE_INPUT"), "write-input"));
  assert.match(where(cfg("GPIO_MODE_INPUT"), "write-input")!.message, /PA5/);
  assert.ok(has(cfg("GPIO_MODE_IT_FALLING"), "write-input"));
  assert.ok(!has(cfg("GPIO_MODE_OUTPUT_PP"), "write-input"));
  // Reconfigured as an output later: fine.
  assert.ok(!has(cfg("GPIO_MODE_INPUT", "  g.Mode = GPIO_MODE_OUTPUT_PP;\n  HAL_GPIO_Init(GPIOA, &g);\n"), "write-input"));
  // A pin never configured is not judged.
  assert.ok(!has("int main(void) { HAL_GPIO_WritePin(GPIOB, GPIO_PIN_3, GPIO_PIN_SET); }", "write-input"));
});

test("lint: = in an if or while condition", () => {
  assert.ok(has("void f(int x) { if (x = 5) { } }", "assign-in-if"));
  assert.equal(where("void f(int x)\n{\n  if (x = 5) { }\n}", "assign-in-if")!.line, 3);
  assert.ok(has("void f(void) { while (state = 0) {} }", "assign-in-if"));
  for (const ok of ["if (x == 5)", "if (x <= 5)", "if (x != 5)", "if (a[i = 0])", "if ((x = f()))", "if (f(x = 1))", "if (x >= 5 && y == 2)"]) {
    assert.ok(!has(`void f(int x) { ${ok} { } }`, "assign-in-if"), ok);
  }
});

test("lint: printf without USART2 initialised, and without a newline", () => {
  assert.ok(has('int main(void) { printf("hi\\n"); }', "printf-uart"));
  assert.ok(!has('UART_HandleTypeDef huart2;\nint main(void) { HAL_UART_Init(&huart2); printf("hi\\n"); }', "printf-uart"));
  assert.ok(has('int main(void) { HAL_UART_Init(&huart2); printf("tick %d", n); }', "printf-newline"));
  assert.equal(where('int main(void) { HAL_UART_Init(&huart2); printf("tick %d", n); }', "printf-newline")!.severity, "info");
  assert.ok(!has('int main(void) { HAL_UART_Init(&huart2); printf("tick %d\\r\\n", n); }', "printf-newline"));
  assert.ok(!has("int main(void) { HAL_UART_Init(&huart2); printf(fmt, n); }", "printf-newline"), "not a literal: unknown");
});

test("lint: a variable written in an interrupt and read elsewhere is not volatile", () => {
  const code = (decl: string) =>
    `${decl}\nvoid HAL_GPIO_EXTI_Callback(uint16_t pin)\n{\n  pressed = 1;\n}\nint main(void)\n{\n  while (1) { if (pressed) { pressed = 0; } }\n}\n`;
  assert.ok(has(code("int pressed = 0;"), "volatile-shared"));
  assert.equal(where(code("static uint8_t pressed;"), "volatile-shared")!.line, 1);
  assert.ok(!has(code("volatile int pressed = 0;"), "volatile-shared"));
  assert.ok(!has(code("static volatile uint8_t pressed;"), "volatile-shared"));
  // Only in the interrupt, or only in main: no issue.
  assert.ok(!has("int n;\nvoid TIM2_IRQHandler(void) { n++; }\n", "volatile-shared"));
  assert.ok(!has("int n;\nint main(void) { n++; return n; }\n", "volatile-shared"));
  assert.ok(has("int n;\nvoid TIM2_IRQHandler(void) { n++; }\nint main(void) { return n; }\n", "volatile-shared"));
});

test("lint: the bundled examples are clean of the warnings", { skip: !existsSync(join(FW, "hal-blinky", "main.c")) }, () => {
  const mainH = readFileSync(join(FW, "hal-common", "Inc", "main.h"), "utf8");
  for (const ex of ["hal-blinky", "hal-uart-printf", "hal-button-exti", "hal-pwm-led", "lesson-timer-irq"]) {
    const text = readFileSync(join(FW, ex, "main.c"), "utf8");
    const issues = lint([{ path: "Core/Src/main.c", text }, { path: "Core/Inc/main.h", text: mainH }]).filter((i) => i.severity === "warning");
    assert.deepEqual(issues.map((i) => `${ex}:${i.line} ${i.rule}`), [], ex);
  }
});

test("scanner: function definitions, not prototypes, initialisers or macros", () => {
  const src = "#define F(x) { x }\nstatic void a(void);\nint b(int x)\n{\n  int y[] = { 1, 2 };\n  return x;\n}\nstruct s { int q; };\nvoid c(void) { if (1) { } }\n";
  assert.deepEqual(functionDefs(maskC(src, { preprocessor: true })).map((f) => f.name), ["b", "c"]);
  assert.equal(maskC('x = "a{b"; // {').indexOf("{"), -1);
});

// ------------------------------------------------------------ project, link, lesson

const CAT: Record<string, CatalogEntry> = { "nucleo-f401re": { pins: [{ id: "PA5" }, { id: "GND" }] } };
const MAIN_TEXT = '#include "main.h"\n// 한글 주석: LED를 깜빡인다\nint main(void)\n{\n  HAL_Init();\n  while (1) { HAL_GPIO_TogglePin(LD2_GPIO_Port, LD2_Pin); HAL_Delay(120); }\n}\n';
const CODE: CodeProject = {
  template: "hal",
  base: "hal-blinky.elf",
  files: [
    { path: "Core/Src/main.c", text: MAIN_TEXT },
    { path: "Core/Inc/led.h", text: "void led(void);\n" },
  ],
  active: "Core/Src/main.c",
  built: { key: "1234:0badf00d", files: [{ path: "Core/Src/main.c", text: MAIN_TEXT.replace("120", "500") }] },
};
const BOARD = { parts: [{ id: "nucleo", kind: "nucleo-f401re", x: 0, y: 0, props: {} }], wires: [] };

test("project file: the code (files, base, active, built snapshot) round-trips; older files still load", () => {
  const text = serialize({ ...BOARD, code: CODE }, "내 코드", { name: "code.elf", data: "AAAA" });
  const back = parseWith(text, CAT);
  assert.deepEqual(back.project.code, CODE);
  assert.deepEqual(back.firmware, { name: "code.elf", data: "AAAA" });
  assert.deepEqual(back.notes, []);
  // A file of M32 (no code): fine, and no code.
  const old = parseWith(JSON.stringify({ format: "simucleo-project", version: 1, ...BOARD }), CAT);
  assert.equal(old.project.code, undefined);
  assert.equal(serialize(old.project).includes('"code"'), false);
});

test("project file: code from a file is checked (paths, sizes, template)", () => {
  const notes: string[] = [];
  const c = sanitizeCode(
    {
      template: "hal",
      base: "../evil.elf",
      files: [
        { path: "../../etc/passwd.c", text: "x" },
        { path: "Core/Src/main.c", text: "int main(void){}" },
        { path: "Core/Src/main.c", text: "dup" },
        { path: "Core/Src/big.c", text: "x".repeat(MAX_FILE_BYTES + 1) },
        { path: "Core/Src/n.c", text: 42 },
      ],
      active: "nothere.c",
      built: { key: "nope", files: [] },
    },
    notes,
  )!;
  assert.deepEqual(c, { template: "hal", files: [{ path: "Core/Src/main.c", text: "int main(void){}" }] });
  assert.equal(notes.length, 2);
  assert.equal(sanitizeCode({ template: "freertos", files: [{ path: "a.c", text: "" }] }), undefined);
  assert.equal(sanitizeCode({ template: "hal", files: [] }), undefined);
  assert.equal(sanitizeCode("x"), undefined);
  assert.equal(newFilePath("led.c"), "Core/Src/led.c");
  assert.equal(newFilePath("led"), "Core/Src/led.c");
  assert.equal(newFilePath("led.h"), "Core/Inc/led.h");
  assert.equal(newFilePath("App/x.c"), "App/x.c");
  assert.equal(newFilePath("../x.c"), null);
  assert.equal(isStale(CODE), true);
  assert.equal(isStale({ ...CODE, files: CODE.built!.files }), false);
});

test("share link: the sources go in (not the snapshot), compressed: a short link; the receiver gets them", async () => {
  const enc = await encodeShare({ project: { ...BOARD, code: CODE }, name: "학생 코드" });
  // A few hundred bytes of C: the link stays QR- and chat-sized.
  assert.ok(enc.fragment.length < 1500, `${enc.fragment.length} chars`);
  assert.equal(enc.elfBytes, 0);
  const got = await decodeShare(`https://x/#${enc.fragment}`, CAT);
  assert.deepEqual(got.loaded.project.code, forShare(CODE));
  assert.equal(got.loaded.project.code!.built, undefined);
  assert.equal(got.loaded.firmware, undefined, "no ELF: the receiver builds");
  assert.equal(got.loaded.project.code!.files[0].text, MAIN_TEXT, "Korean comments survive");
  // A link with a broken code entry still opens, without the code.
  const bad = await encodeShare({ project: { ...BOARD, code: { ...CODE, files: [{ path: "../x.c", text: "" }] } } });
  const b = await decodeShare(bad.fragment, CAT);
  assert.equal(b.loaded.project.code, undefined);
  assert.ok(b.loaded.notes.some((n) => n.includes("../x.c")));
});

test("lessons: a starter from the example's main.c or the lesson's own text; the format is checked", async () => {
  const examples = [{ file: "hal-blinky.elf", code: { main: "hal-blinky/main.c" } }, { file: "freertos-two-tasks.elf" }];
  const asked: string[] = [];
  const get = async (u: string) => (asked.push(u), u.endsWith("hal-blinky/main.c") ? "int main(void){}" : null);
  assert.deepEqual(await lessonStarter({ example: "hal-blinky.elf" }, examples, get), [{ path: "Core/Src/main.c", text: "int main(void){}" }]);
  assert.deepEqual(asked, ["./examples/src/hal-blinky/main.c"]);
  assert.deepEqual(await lessonStarter({ example: "x.elf", main: ["int main(void)", "{", "}"] }, examples, get), [
    { path: "Core/Src/main.c", text: "int main(void)\n{\n}\n" },
  ]);
  assert.equal(await lessonStarter({ example: "freertos-two-tasks.elf" }, examples, get), null, "not editable");
  const l = JSON.parse(readFileSync(join(here, "..", "lessons", "06-blink-2hz.json"), "utf8")) as Lesson;
  assert.deepEqual(l.code, { example: "hal-blinky.elf" });
  assert.deepEqual(validateLesson(l), []);
  assert.ok(validateLesson({ ...l, code: { main: 3 } }).some((e) => e.includes("'code'")));
  assert.equal(normalizeLesson({ ...l, code: "x" })!.code, undefined);
  assert.deepEqual(normalizeLesson(l)!.code, { example: "hal-blinky.elf" });
});

// ------------------------------------------------------------ offline (M29 + M33)

test("service worker lists: the compiler is apart from the default precache and checked against its manifest", () => {
  const dir = mkdtempSync(join(tmpdir(), "simucleo-m33-"));
  const put = (p: string, data: string) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), data);
  };
  try {
    put("index.html", "<html>");
    put("assets/index-a.js", "x");
    put("editor/hal-symbols.json", "{}");
    const manifest = {
      version: "abc",
      files: { "llvm.core.wasm": { url: "toolchain/llvm.core.wasm.gz.bin", bytes: 3, gzip: true } },
      sdk: { url: "toolchain/sdk-hal.tar.gz.bin", bytes: 3 },
    };
    put("toolchain/manifest.json", JSON.stringify(manifest));
    put("toolchain/clang.js", "export {}");
    put("toolchain/llvm.core.wasm.gz.bin", "abc");
    put("toolchain/sdk-hal.tar.gz.bin", "def");
    const pre = collectPrecache(dir).map((e) => e.url);
    const opt = collectOptional(dir);
    assert.ok(pre.includes("editor/hal-symbols.json"), "the symbol index is in the default precache");
    assert.equal(pre.filter((u) => u.startsWith("toolchain/")).length, 0);
    assert.deepEqual(opt.map((e) => e.url).sort(), ["toolchain/clang.js", "toolchain/llvm.core.wasm.gz.bin", "toolchain/manifest.json", "toolchain/sdk-hal.tar.gz.bin"]);
    assert.deepEqual(optionalProblems(collectPrecache(dir), opt, dir), []);
    // A file the manifest names but the build lacks, or the compiler in the default list: reported.
    assert.deepEqual(optionalProblems([], opt.filter((e) => !e.url.endsWith("sdk-hal.tar.gz.bin")), dir), ["optional toolchain/sdk-hal.tar.gz.bin"]);
    assert.deepEqual(optionalProblems(opt.slice(0, 1), opt, dir), [`${opt[0].url} in the default precache`]);
    // Both lists and both versions go into sw.js.
    const sw = renderServiceWorker(readFileSync(join(here, "..", "sw", "service-worker.js"), "utf8"), collectPrecache(dir), "v1", opt, cacheVersion(opt));
    const optional = JSON.parse(/const OPTIONAL = (\[.*?\]);/.exec(sw)![1]) as { url: string; integrity: string; size: number }[];
    assert.equal(optional.length, 4);
    assert.ok(optional.every((e) => e.integrity.startsWith("sha256-") && e.size > 0));
    assert.match(sw, new RegExp(`const OPTIONAL_VERSION = "${cacheVersion(opt)}"`));
    assert.ok(!JSON.parse(/const PRECACHE = (\[.*?\]);/.exec(sw)![1]).some((e: { url: string }) => e.url.startsWith("toolchain/")));
  } finally {
    rmSync(dir, { recursive: true });
  }
});
