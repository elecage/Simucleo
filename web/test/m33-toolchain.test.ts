// M33 integration: the toolchain the site ships (public/toolchain/, made by
// `npm run editor` from firmware/editor-sdk and the compiler package) builds
// hal-blinky's main.c in Node exactly as the compiler worker does in the
// browser, and the ELF runs on the simulator core (WebAssembly package).
//
//   make -C ../firmware/editor-sdk && npm run editor && npm run wasm
//   node --test test/m33-toolchain.test.ts
//
// Skipped when those are missing, except in CI (SIMUCLEO_TOOLCHAIN_TEST=1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildProject, installSdk, type SourceFile } from "../src/code/build.ts";
import { prepare, type ClangModule } from "../src/code/toolchain.ts";
import type { ToolchainManifest } from "../src/code/sdk.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, "..", "public");
const MANIFEST = join(pub, "toolchain", "manifest.json");
const WASM = join(here, "../src/wasm/pkg/simucleo_wasm_bg.wasm");
const FW = join(here, "..", "..", "firmware");
const required = process.env.SIMUCLEO_TOOLCHAIN_TEST === "1";
const skip = required ? false : (!existsSync(MANIFEST) && "run npm run editor (needs firmware/editor-sdk built)") || (!existsSync(WASM) && "run npm run wasm");

const BLINKY = existsSync(join(FW, "hal-blinky", "main.c")) ? readFileSync(join(FW, "hal-blinky", "main.c"), "utf8") : "";

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
async function build(files: SourceFile[]) {
  session ??= await setup();
  return buildProject(session.s, files, session.written);
}

/** Run an ELF for `ms` of simulated time; PA5 toggles and the console. */
async function run(elf: Uint8Array, ms: number) {
  const { initSync, Simulator } = await import("../src/wasm/pkg/simucleo_wasm.js");
  initSync({ module: readFileSync(WASM) });
  const sim = new Simulator();
  sim.loadElf(elf);
  let toggles = 0;
  let last = sim.pin("A", 5);
  for (let t = 0; t < ms; t += 1) {
    sim.runForMs(1);
    const now = sim.pin("A", 5);
    if (now !== last) toggles++;
    last = now;
  }
  const files = (JSON.parse(sim.debugFiles()) as { path: string }[]).map((f) => f.path);
  return { toggles, console: sim.takeConsole(), files, stopped: sim.stopped() };
}

test("hal-blinky's main.c builds in the shipped toolchain and blinks LD2 in the simulator", { skip, timeout: 240_000 }, async () => {
  const t0 = Date.now();
  const r = await build([{ path: "Core/Src/main.c", text: BLINKY }]);
  const cold = Date.now() - t0;
  assert.equal(r.ok, true, r.log);
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === "error"), []);
  assert.ok(r.elf && r.elf[0] === 0x7f && r.elf[1] === 0x45, "an ELF");
  const a = await run(r.elf!, 1200);
  assert.equal(a.stopped, false);
  // 500 ms per toggle: at 0, ~500, ~1000 ms.
  assert.ok(a.toggles >= 2 && a.toggles <= 4, `toggles ${a.toggles}`);
  // DWARF names the edited file (source view, breakpoints) and hal-common
  // as /firmware/… (the bundled example sources).
  assert.ok(a.files.includes("/project/Core/Src/main.c"), a.files.join("\n"));
  assert.ok(a.files.some((f) => f === "/firmware/hal-common/Src/clock_config.c"), a.files.join("\n"));

  // Warm: the toolchain is loaded; a faster blink.
  const t1 = Date.now();
  const fast = await build([{ path: "Core/Src/main.c", text: BLINKY.replace("HAL_Delay(500);", "HAL_Delay(100);") }]);
  const warm = Date.now() - t1;
  assert.equal(fast.ok, true, fast.log);
  const b = await run(fast.elf!, 1200);
  assert.ok(b.toggles >= 10 && b.toggles <= 13, `toggles ${b.toggles}`);
  console.log(`build: cold ${cold} ms (toolchain load + compile + link), warm ${warm} ms (compile ${fast.ms.compile.toFixed(0)} + link ${fast.ms.link.toFixed(0)})`);
});

test("printf over USART2 and a second user file with a header", { skip, timeout: 240_000 }, async () => {
  const main = readFileSync(join(FW, "hal-uart-printf", "main.c"), "utf8");
  const r = await build([
    { path: "Core/Src/main.c", text: main.replace('#include "main.h"', '#include "main.h"\n#include "greet.h"').replace(/int main\(void\)\s*\{/, "int main(void)\n{\n  greet_count = 41;") },
    { path: "Core/Inc/greet.h", text: "extern int greet_count;\nint greet_next(void);\n" },
    { path: "Core/Src/greet.c", text: '#include "greet.h"\nint greet_count;\nint greet_next(void) { return ++greet_count; }\n' },
  ]);
  assert.equal(r.ok, true, r.log);
  const a = await run(r.elf!, 400);
  assert.match(a.console, /Hello from Simucleo/);
  assert.match(a.console, /SystemCoreClock = 84000000/);
});

test("every example the code tab offers builds with the shipped SDK and runs", { skip: skip || (!existsSync(join(pub, "examples", "index.json")) && "run npm run examples"), timeout: 600_000 }, async () => {
  const index = JSON.parse(readFileSync(join(pub, "examples", "index.json"), "utf8")) as { file: string; code?: { main: string } }[];
  const editable = index.filter((e) => e.code);
  assert.ok(editable.length >= 30, `${editable.length} editable examples`);
  const failed: string[] = [];
  for (const ex of editable) {
    const text = readFileSync(join(pub, "examples", "src", ex.code!.main), "utf8");
    const r = await build([{ path: "Core/Src/main.c", text }]);
    if (!r.ok) {
      failed.push(`${ex.file}: ${r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.file}:${d.line} ${d.message}`).join("; ")}`);
      continue;
    }
    // Without its circuit an example may stop (hal-i2c-oled: no OLED answers):
    // as the gcc build of the same main.c does.
    const a = await run(r.elf!, 300);
    const gcc = await run(new Uint8Array(readFileSync(join(pub, "examples", ex.file))), 300);
    if (a.stopped !== gcc.stopped) failed.push(`${ex.file}: stopped ${a.stopped}, the gcc build ${gcc.stopped}`);
  }
  assert.deepEqual(failed, []);
});

test("a syntax error gives a parsed error at its line and no ELF; an undefined function a linker error", { skip, timeout: 240_000 }, async () => {
  const lines = BLINKY.split("\n");
  const at = lines.findIndex((l) => l.includes("HAL_Delay(500);"));
  lines[at] = lines[at].replace("HAL_Delay(500);", "HAL_Delay(500)"); // no ';'
  const r = await build([{ path: "Core/Src/main.c", text: lines.join("\n") }]);
  assert.equal(r.ok, false);
  assert.equal(r.elf, null);
  const err = r.diagnostics.find((d) => d.severity === "error");
  assert.ok(err, r.log);
  assert.equal(err.file, "Core/Src/main.c");
  // clang reports the missing ';' at the end of that line.
  assert.equal(err.line, at + 1, r.log);
  assert.match(err.message, /expected ';'/);

  // Declared but defined nowhere: the compile passes, the link does not.
  const undef = BLINKY.replace("static void MX_GPIO_Init(void);", "static void MX_GPIO_Init(void);\nvoid HAL_Delay_ms(uint32_t ms);").replace("HAL_Delay(500);", "HAL_Delay_ms(500);");
  const call = undef.split("\n").findIndex((l) => l.includes("HAL_Delay_ms(500);")) + 1;
  const u = await build([{ path: "Core/Src/main.c", text: undef }]);
  assert.equal(u.ok, false);
  const ld = u.diagnostics.find((d) => d.tool === "ld" && d.severity === "error");
  assert.ok(ld, u.log);
  assert.match(ld.message, /undefined symbol: HAL_Delay_ms/);
  assert.equal(ld.file, "Core/Src/main.c");
  assert.equal(ld.line, call);
});
