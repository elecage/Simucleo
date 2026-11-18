// Copy the built example firmware into public/examples/ with an index, so
// the site can offer them without a toolchain. Build them first, e.g.
//   make -C ../firmware/hal-blinky variants && make -C ../firmware/hal-uart-printf
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "firmware");
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "examples");

const EXAMPLES = [
  ["hal-uart-printf", "hal-uart-printf.elf", "HAL: printf over the virtual COM port, upper-case echo of what you type"],
  ["hal-blinky", "hal-blinky.elf", "HAL: LD2 blinks every 500 ms; hold B1 for 100 ms"],
  ["hal-blinky", "hal-blinky-hse-bypass.elf", "HAL: same, clocked from the ST-LINK 8 MHz HSE (bypass)"],
  ["hal-blinky", "hal-blinky-hse-crystal.elf", "HAL: wrong HSE setting (no crystal on the Nucleo) → Error_Handler"],
  ["bare-blinky", "bare-blinky.elf", "Bare metal: toggle PA5 with register writes"],
];

mkdirSync(out, { recursive: true });
const index = [];
for (const [project, file, description] of EXAMPLES) {
  const src = join(root, project, "build", file);
  if (!existsSync(src)) {
    console.warn(`skip ${file}: not built (${src})`);
    continue;
  }
  copyFileSync(src, join(out, file));
  index.push({ name: file.replace(/\.elf$/, ""), file, description });
}
writeFileSync(join(out, "index.json"), JSON.stringify(index, null, 2) + "\n");
console.log(`${index.length} examples → public/examples`);
