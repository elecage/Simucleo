// M36 integration: projects the configuration tool generates build with
// arm-none-eabi-gcc (as STM32CubeIDE would, HAL drivers from the bundled
// STM32CubeF4 sources) and with the in-browser toolchain (clang + ld.lld,
// the "cube" template against the prebuilt HAL), and both ELFs do the same
// thing on the simulator core: LD2 toggles and printf reaches the console,
// a TIM PWM channel gives the configured frequency and duty, the clock tree
// sets the core clock, and every per-peripheral snapshot configuration
// starts without ending in Error_Handler.
//
//   make -C ../firmware/editor-sdk && npm run editor && npm run wasm
//   node --test test/m36-toolchain.test.ts
//
// Skipped when those (or arm-none-eabi-gcc) are missing, except in CI
// (SIMUCLEO_TOOLCHAIN_TEST=1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildProject, installSdk, type SourceFile } from "../src/code/build.ts";
import { prepare, type ClangModule } from "../src/code/toolchain.ts";
import type { ToolchainManifest } from "../src/code/sdk.ts";
import type { CodeProject } from "../src/code/project.ts";
import { assignPin, nucleoDefaults, type CubeConfig } from "../src/cube/config.ts";
import { applyRegeneration, newCubeProject, projectConfig } from "../src/cube/tree.ts";
import { setRegion } from "../src/cube/usercode.ts";
import { DEFAULT_PACK } from "../src/cube/packs.ts";
import { packFiles } from "../scripts/cube-pack.mjs";
import { snapshotConfigs } from "./m36-configs.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "..", "public");
const MANIFEST = join(pub, "toolchain", "manifest.json");
const WASM = join(here, "../src/wasm/pkg/simucleo_wasm_bg.wasm");
const FW = join(here, "..", "..", "firmware");
const required = process.env.SIMUCLEO_TOOLCHAIN_TEST === "1";
const hasGcc = spawnSync("arm-none-eabi-gcc", ["--version"]).status === 0;
const skip = required
  ? false
  : (!existsSync(MANIFEST) && "run npm run editor (needs firmware/editor-sdk built)") || (!existsSync(WASM) && "run npm run wasm") || (!hasGcc && "needs arm-none-eabi-gcc");

// ------------------------------------------------------------------ builds

let session: Awaited<ReturnType<typeof setup>> | null = null;
async function setup() {
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as ToolchainManifest;
  const mod = (await import(pathToFileURL(join(pub, "toolchain", "clang.js")).href)) as ClangModule;
  const loaded = await prepare(mod, manifest, async (url, onBytes) => {
    const b = new Uint8Array(readFileSync(join(pub, url)));
    onBytes(b.length);
    return b;
  });
  const s = loaded.module.createSession();
  await installSdk(s, loaded.sdk);
  return { s, written: new Set<string>() };
}

/** The in-browser build (as the compiler worker runs it). */
async function wasmBuild(files: SourceFile[]) {
  session ??= await setup();
  const r = await buildProject(session.s, files, session.written, "cube");
  assert.equal(r.ok, true, r.log);
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === "error"), [], r.log);
  return r;
}

/**
 * The project as STM32CubeIDE builds it (Debug: -O0 -g3): every C file of
 * Core/ and the bundle's HAL sources, the start-up file, the linker script.
 */
function gccBuild(p: CodeProject): { elf: Uint8Array; warnings: string } {
  const dir = mkdtempSync(join(tmpdir(), "m36-gcc-"));
  try {
    const files = [...p.files.map((f) => ({ path: f.path, data: new TextEncoder().encode(f.text) })), ...packFiles(FW, p.drivers ?? DEFAULT_PACK.id)];
    for (const f of files) {
      mkdirSync(dirname(join(dir, f.path)), { recursive: true });
      writeFileSync(join(dir, f.path), f.data);
    }
    const sources = files.map((f) => f.path).filter((x) => /^(Core|Drivers)\/.*\.(c|s)$/.test(x));
    const args = [
      "-mcpu=cortex-m4", "-mthumb", "-mfpu=fpv4-sp-d16", "-mfloat-abi=hard", "-std=gnu11", "-g3", "-O0", "-Wall",
      "-DDEBUG", "-DUSE_HAL_DRIVER", "-DSTM32F401xE", "-ffunction-sections", "-fdata-sections",
      "-ICore/Inc", "-IDrivers/STM32F4xx_HAL_Driver/Inc", "-IDrivers/STM32F4xx_HAL_Driver/Inc/Legacy", "-IDrivers/CMSIS/Device/ST/STM32F4xx/Include", "-IDrivers/CMSIS/Include",
      ...sources, "-TSTM32F401RETX_FLASH.ld", "--specs=nano.specs", "-Wl,--gc-sections", "-Wl,--start-group", "-lc", "-lm", "-Wl,--end-group", "-o", "app.elf",
    ];
    const r = spawnSync("arm-none-eabi-gcc", args, { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    // Warnings only from the generated/student files (not ST's drivers).
    const warnings = r.stderr.split("\n").filter((l) => /^Core\/.*warning:/.test(l)).join("\n");
    return { elf: new Uint8Array(readFileSync(join(dir, "app.elf"))), warnings };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ the simulator

async function simulator() {
  const { initSync, Simulator } = await import("../src/wasm/pkg/simucleo_wasm.js");
  initSync({ module: readFileSync(WASM) });
  return new Simulator();
}

/** Run for `ms`; toggles of a pin sampled every `stepMs`, its high share, the console. */
async function run(elf: Uint8Array, ms: number, pin: [string, number] = ["A", 5], stepMs = 1) {
  const sim = await simulator();
  sim.loadElf(elf);
  let toggles = 0;
  let rising = 0;
  let high = 0;
  let n = 0;
  let last = sim.pin(pin[0], pin[1]);
  for (let t = 0; t < ms; t += stepMs) {
    sim.runForMs(stepMs);
    const now = sim.pin(pin[0], pin[1]);
    if (now !== last) {
      toggles++;
      if (now) rising++;
    }
    if (now) high++;
    n++;
    last = now;
  }
  const where = sim.symbolAt(sim.pc()) ?? "";
  return { toggles, rising, high: high / n, console: sim.takeConsole(), stopped: sim.stopped(), where, clock: sim.clockHz() };
}

const withUserCode = (p: CodeProject, regions: Record<string, string>): CodeProject => ({
  ...p,
  files: p.files.map((f) => {
    if (f.path !== "Core/Src/main.c") return f;
    let t = f.text;
    for (const [k, v] of Object.entries(regions)) t = setRegion(t, k, v);
    return { ...f, text: t };
  }),
});

// ------------------------------------------------------------------ tests

test("PA5 output + USART2 115200 + user code: LD2 toggles every 100 ms and printf reaches the console (gcc and in-browser build)", { skip, timeout: 300_000 }, async () => {
  const p = withUserCode(newCubeProject(nucleoDefaults("blink")), {
    "2": '\n  printf("start %lu Hz\\r\\n", (unsigned long)HAL_RCC_GetHCLKFreq());\n  ',
    "3": '\n    HAL_GPIO_TogglePin(LD2_GPIO_Port, LD2_Pin);\n    printf("tick %lu\\r\\n", (unsigned long)HAL_GetTick());\n    HAL_Delay(100);\n  }\n  ',
  });
  const gcc = gccBuild(p);
  assert.equal(gcc.warnings, "", "generated code compiles without warnings (-Wall)");
  const wasm = await wasmBuild(p.files);
  for (const [name, elf] of [["gcc", gcc.elf], ["wasm", wasm.elf!]] as const) {
    const r = await run(elf, 1050);
    assert.equal(r.stopped, false, name);
    assert.ok(r.toggles >= 9 && r.toggles <= 12, `${name}: toggles ${r.toggles}`);
    assert.match(r.console, /start 84000000 Hz/, name);
    assert.match(r.console, /tick \d+\r\n/, name);
    assert.ok((r.console.match(/tick/g) ?? []).length >= 9, `${name}: ${r.console}`);
    assert.equal(r.clock, 84_000_000, name);
  }

  // Change the baud rate and regenerate: the user code is kept and the project still builds and blinks.
  const cfg = projectConfig(p).config;
  cfg.usart.USART2!.baud = 9600;
  const q = applyRegeneration(p, cfg);
  const main = q.files.find((f) => f.path === "Core/Src/main.c")!.text;
  assert.match(main, /huart2\.Init\.BaudRate = 9600;/);
  assert.match(main, /HAL_GPIO_TogglePin\(LD2_GPIO_Port, LD2_Pin\);\n    printf\("tick/);
  const again = await run((await wasmBuild(q.files)).elf!, 550);
  assert.ok(again.toggles >= 4 && again.toggles <= 7, `toggles ${again.toggles}`);
});

test("TIM2 PWM on PA5 (1 kHz, 25 %) after HAL_TIM_PWM_Start in USER CODE 2: the pin shows that PWM", { skip, timeout: 300_000 }, async () => {
  let c = nucleoDefaults("pwm");
  c = assignPin(c, "PA5", "TIM2_CH1", "LD2");
  c.tim.TIM2 = { ...c.tim.TIM2!, prescaler: 83, period: 999 };
  c.tim.TIM2.channels[0]!.pulse = 250;
  const p = withUserCode(newCubeProject(c), { "2": "\n  HAL_TIM_PWM_Start(&htim2, TIM_CHANNEL_1);\n  " });
  for (const [name, elf] of [["gcc", gccBuild(p).elf], ["wasm", (await wasmBuild(p.files)).elf!]] as const) {
    // 20 ms sampled every 10 µs: 20 periods.
    const r = await run(elf, 20, ["A", 5], 0.01);
    assert.equal(r.stopped, false, name);
    assert.ok(r.rising >= 19 && r.rising <= 21, `${name}: ${r.rising} rising edges in 20 ms`);
    assert.ok(Math.abs(r.high - 0.25) < 0.03, `${name}: high ${r.high}`);
  }
});

test("every snapshot configuration builds with gcc (no warnings in Core/) and the in-browser toolchain, and starts without Error_Handler", { skip, timeout: 600_000 }, async () => {
  const failed: string[] = [];
  const configs: Record<string, CubeConfig> = snapshotConfigs();
  for (const [name, c] of Object.entries(configs)) {
    const p = newCubeProject(c);
    const gcc = gccBuild(p);
    if (gcc.warnings) failed.push(`${name}: gcc warnings\n${gcc.warnings}`);
    const wasm = await wasmBuild(p.files);
    for (const [kind, elf] of [["gcc", gcc.elf], ["wasm", wasm.elf!]] as const) {
      const r = await run(elf, 200);
      if (r.stopped || /Error_Handler/.test(r.where)) failed.push(`${name} (${kind}): stopped at ${r.where}`);
      const hclk = name === "clock" ? 42_000_000 : 84_000_000;
      if (r.clock !== hclk) failed.push(`${name} (${kind}): core clock ${r.clock}, expected ${hclk}`);
    }
  }
  assert.deepEqual(failed, []);
});

test("HSE as a crystal (none on the Nucleo): the generated SystemClock_Config ends in Error_Handler, as on the board", { skip, timeout: 300_000 }, async () => {
  const c = nucleoDefaults("xtal");
  c.clock = { ...c.clock, hse: "crystal", pllSource: "HSE", pllM: 8 };
  const p = newCubeProject(c);
  const r = await run((await wasmBuild(p.files)).elf!, 400);
  assert.match(r.where, /Error_Handler/);
});
