// The STM32CubeF4 driver bundles of the configuration tool (M36): for each
// version in PACK_SOURCES, the files a CubeIDE project keeps under Drivers/
// (HAL driver Inc/Src, CMSIS core and device headers, their licences) plus
// the start-up code, SystemInit and the linker script, at their project
// paths. scripts/editor-sdk.mjs packs them into public/cube/; the tests read
// them straight from here.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Where each bundle's files come from (relative to firmware/). Only one
 * version is vendored; another one goes in its own vendor folder with its
 * own entry here and in src/cube/packs.ts (and a libhal.a built from it).
 */
export const PACK_SOURCES = {
  "cubef4-hal-1.8.6": {
    hal: "vendor/stm32f4xx_hal_driver",
    device: "vendor/cmsis_device_f4",
    core: "vendor/CMSIS",
    linker: "hal-common/STM32F401RETx_FLASH.ld",
  },
};

function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full).split(sep).join("/"));
  }
  return out;
}

/** The bundle `id` as [{ path, data }] with CubeIDE project paths. */
export function packFiles(fw, id) {
  const src = PACK_SOURCES[id];
  if (!src) throw new Error(`unknown driver bundle ${id}`);
  const out = [];
  const add = (path, file) => out.push({ path, data: new Uint8Array(readFileSync(join(fw, file))) });
  const tree = (dir, to, keep) => {
    for (const rel of walk(join(fw, dir))) if (keep(rel)) add(`${to}/${rel}`, `${dir}/${rel}`);
  };
  tree(`${src.hal}/Inc`, "Drivers/STM32F4xx_HAL_Driver/Inc", (r) => r.endsWith(".h"));
  tree(`${src.hal}/Src`, "Drivers/STM32F4xx_HAL_Driver/Src", (r) => r.endsWith(".c"));
  add("Drivers/STM32F4xx_HAL_Driver/LICENSE.md", `${src.hal}/LICENSE.md`);
  tree(`${src.core}/Include`, "Drivers/CMSIS/Include", (r) => r.endsWith(".h"));
  add("Drivers/CMSIS/LICENSE.txt", `${src.core}/LICENSE.txt`);
  tree(`${src.device}/Include`, "Drivers/CMSIS/Device/ST/STM32F4xx/Include", (r) => r.endsWith(".h"));
  add("Drivers/CMSIS/Device/ST/STM32F4xx/LICENSE.md", `${src.device}/LICENSE.md`);
  add("Core/Startup/startup_stm32f401retx.s", `${src.device}/Source/startup_stm32f401xe.s`);
  add("Core/Src/system_stm32f4xx.c", `${src.device}/Source/system_stm32f4xx.c`);
  add("STM32F401RETX_FLASH.ld", src.linker);
  return out;
}

export const packAvailable = (fw, id) => !!PACK_SOURCES[id] && existsSync(join(fw, PACK_SOURCES[id].hal, "Inc"));
