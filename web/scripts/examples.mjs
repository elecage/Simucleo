// Copy the built example firmware into public/examples/ with an index, so
// the site can offer them without a toolchain. Build them first, e.g.
//   make -C ../firmware/hal-blinky variants && make -C ../firmware/hal-uart-printf
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
  ["hal-adc-servo", "hal-adc-servo.elf", "HAL: ADC reads a potentiometer, LDR and TMP36; the pot steers a servo (TIM3 50 Hz), light sets a DC motor's speed"],
  ["hal-i2c-oled", "hal-i2c-oled.elf", "HAL: I2C bus with an SSD1306 OLED, DS3231 RTC and AHT20 — a clock and thermometer; B1 zeroes the seconds"],
  ["hal-spi-sd-logger", "hal-spi-sd-logger.elf", "HAL: SD card (SPI, FatFs) logs time-stamped temperature/humidity to LOG.CSV; SPI OLED; B1 prints the file"],
  ["hal-neopixel-dma", "hal-neopixel-dma.elf", "HAL: a rainbow on a 12-LED NeoPixel ring — TIM3 PWM at 800 kHz with DMA feeding the duty values; B1 changes brightness"],
  ["hal-dht-capture", "hal-dht-capture.elf", "HAL: DHT22 read with TIM2 input capture on both edges; B1 prints the pulse widths"],
  ["hal-7seg-keypad", "hal-7seg-keypad.elf", "HAL: 4-digit 7-segment display multiplexed by a timer interrupt; digits typed on a 4×4 keypad"],
  ["hal-encoder-stepper-lcd", "hal-encoder-stepper-lcd.elf", "HAL: rotary encoder (TIM3 encoder mode) turns a stepper; 16×2 I2C LCD shows the angle and a thermistor's temperature"],
  ["hal-sonar-onewire", "hal-sonar-onewire.elf", "HAL: HC-SR04 distance by input capture and a DS18B20 over bit-banged 1-Wire with DWT delays"],
  ["freertos-two-tasks", "freertos-two-tasks.elf", "FreeRTOS (CMSIS-RTOS v2): Blink, Count and Button threads; B1 releases a semaphore — see the RTOS tab"],
  ["freertos-queue-uart", "freertos-queue-uart.elf", "FreeRTOS: UART RX ISR → queue → echo task; sensor → queue → logger with heap/stack stats"],
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

// The examples' own sources (not the vendored libraries), for the source
// view: public/examples/src/<path under firmware/> and a list of them.
const sources = [];
const srcOut = join(out, "src");
function copySources(rel) {
  const dir = join(root, rel);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const r = `${rel}/${name}`;
    const full = join(root, r);
    if (statSync(full).isDirectory()) {
      if (name !== "build") copySources(r);
    } else if (/\.(c|h|s)$/i.test(name)) {
      mkdirSync(dirname(join(srcOut, r)), { recursive: true });
      copyFileSync(full, join(srcOut, r));
      sources.push(r);
    }
  }
}
for (const project of new Set([...EXAMPLES.map(([p]) => p), "hal-common", "freertos-common"])) copySources(project);
writeFileSync(join(out, "sources.json"), JSON.stringify(sources.sort()) + "\n");
console.log(`${sources.length} source files → public/examples/src`);
console.log(`${index.length} examples → public/examples`);
