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
  ["hal-button-exti", "hal-button-exti.elf", "HAL: B1 and a button on D2 raise EXTI interrupts; toggles LD2 and an LED on D7"],
  ["hal-pwm-led", "hal-pwm-led.elf", "HAL: TIM2/TIM3 PWM — LD2 breathes, RGB LED on D3/D5/D6 cycles colours"],
  ["hal-buzzer-melody", "hal-buzzer-melody.elf", "HAL: TIM1 PWM plays a melody on a passive buzzer on D8"],
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
  const entry = { name: file.replace(/\.elf$/, ""), file, description };
  // A project with the wiring the firmware expects (web/examples/<name>.simucleo.json).
  const projectFile = `${entry.name}.simucleo.json`;
  const projectSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "examples", projectFile);
  if (existsSync(projectSrc)) {
    copyFileSync(projectSrc, join(out, projectFile));
    entry.project = projectFile;
  }
  index.push(entry);
}
writeFileSync(join(out, "index.json"), JSON.stringify(index, null, 2) + "\n");
console.log(`${index.length} examples → public/examples`);
