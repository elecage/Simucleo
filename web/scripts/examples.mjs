// Copy the built example firmware into public/examples/ with an index, so
// the site can offer them without a toolchain. Build them first, e.g.
//   make -C ../firmware/hal-blinky variants && make -C ../firmware/hal-uart-printf
//
//   --projects  print the firmware directories the examples come from (one
//               list for the workflows to build) and stop
//   --strict    fail when an example is not built (the deployed site would
//               be without it; without the flag it is only skipped)
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  ["hal-imu-matrix", "hal-imu-matrix.elf", "HAL: MPU-6050 tilt over I2C rolls a dot on a MAX7219 8×8 LED matrix driven by SPI1, a second matrix on its DOUT shows |a| — drag the sensor to tilt it, press Shake to shake it"],
  ["hal-ir-remote", "hal-ir-remote.elf", "HAL: NEC IR remote decoded with TIM2 input capture; prints each code and the repeat codes"],
  ["hal-onewire-multi", "hal-onewire-multi.elf", "HAL: three DS18B20 on one 1-Wire line — SEARCH ROM finds every ROM code, MATCH ROM reads each temperature; touch one to warm it"],
  ["hal-bluetooth-led", "hal-bluetooth-led.elf", "HAL: HC-05 Bluetooth module on USART1 (9600 baud) — commands from the phone (on, off, blink, status) switch LD2; see the Bluetooth tab"],
  ["hal-relay", "hal-relay.elf", "HAL: a button toggles a 5 V relay module that switches an LED on its own supply through COM–NO"],
  ["hal-servos-multi", "hal-servos-multi.elf", "HAL: three servos on TIM3 CH1/CH2 and TIM1 CH1, sweeping a third of a period apart"],
  ["hal-shift-register", "hal-shift-register.elf", "HAL: a 74HC595 shift register on SPI1 (SCK → SHCP, MOSI → DS, D10 → STCP latch) runs a Knight Rider on eight LEDs"],
  ["hal-tm1637-clock", "hal-tm1637-clock.elf", "HAL: TM1637 4-digit display bit-banged on D2/D3 with DWT delays — a minutes:seconds clock with a blinking colon, ACK checked; B1 changes the brightness"],
  ["hal-joystick-oled", "hal-joystick-oled.elf", "HAL: KY-023 joystick on ADC1 (A0, A1) and D4 moves a dot on an SSD1306 OLED — drag the stick, click it to press"],
  ["hal-pir-alarm", "hal-pir-alarm.elf", "HAL: HC-SR501 PIR on D7 (EXTI) lights an LED on D6 and logs motion — drag the person through the sensor's view"],
  ["hal-bmp280", "hal-bmp280.elf", "HAL: BMP280 on I2C1 — trimming registers, forced measurements and the Bosch compensation code print temperature, pressure and altitude"],
  ["hal-neopixel-chain", "hal-neopixel-chain.elf", "HAL: a 12-LED NeoPixel ring with an 8-LED strip on its DOUT, one 20-LED frame by TIM3 PWM + DMA"],
  ["hal-stepper-a4988", "hal-stepper-a4988.elf", "HAL: NEMA17 stepper on an A4988 — TIM2 PWM STEP pulses with an acceleration ramp, 1/8 steps, back and forth one revolution; B1 switches the driver off so the shaft turns by hand"],
  ["hal-stepper-l298n", "hal-stepper-l298n.elf", "HAL: NEMA17 stepper on an L298N H-bridge — the half-step sequence on IN1–IN4 from a TIM4 interrupt, ENA/ENB 80 % PWM"],
  ["hal-esc-bldc", "hal-esc-bldc.elf", "HAL: brushless motor on a hobby ESC — 50 Hz servo pulses, arming at minimum throttle, then a pot on A0 sets the throttle; B1 cuts the signal (failsafe)"],
  ["hal-bldc-hall", "hal-bldc-hall.elf", "HAL: BLDC with hall sensors — EXTI on the halls commutates a 3-phase bridge six-step; B1 swaps two halls (wrong commutation: it stalls)"],
  ["hal-bldc-pwm", "hal-bldc-pwm.elf", "HAL: BLDC on TIM1 complementary PWM — CH1–CH3 and CH1N–CH3N with 500 ns dead time, six-step by COM events from the hall interrupts, a pot on A0 sets the duty; B1 breaks (EGR.BG) and resumes"],
  ["hal-bldc-sensorless", "hal-bldc-sensorless.elf", "HAL: sensorless BLDC — TIM1 center-aligned complementary PWM (RCR 1: one update per period at its centre) samples the floating phase against a virtual neutral on the ADC; align, open-loop ramp, then commutation 30° after each back-EMF zero crossing (TIM2); a pot on A0 sets the duty"],
  ["freertos-two-tasks", "freertos-two-tasks.elf", "FreeRTOS (CMSIS-RTOS v2): Blink, Count and Button threads; B1 releases a semaphore — see the RTOS tab"],
  ["freertos-queue-uart", "freertos-queue-uart.elf", "FreeRTOS: UART RX ISR → queue → echo task; sensor → queue → logger with heap/stack stats"],
  ["lesson-led-on", "lesson-led-on.elf", "Lesson: D7 driven high once — the first GPIO output lights an LED"],
  ["lesson-button-poll", "lesson-button-poll.elf", "Lesson: a button on D2 (internal pull-up) read every 10 ms; the LED on D7 follows it"],
  ["lesson-knight-rider", "lesson-knight-rider.elf", "Lesson: a Knight Rider light over four LEDs on D2–D5 from a table of pins"],
  ["lesson-timer-irq", "lesson-timer-irq.elf", "Lesson: a 1 ms TIM2 interrupt toggles D7 every 100 ms and LD2 every second; D6 from HAL_Delay drifts"],
  ["lesson-ldr-nightlight", "lesson-ldr-nightlight.elf", "Lesson: an LDR on A1 sets the PWM brightness of an LED on D6 — a night light"],
  ["lesson-joystick-servos", "lesson-joystick-servos.elf", "Lesson: a joystick on A0/A1 steers a pan servo on D5 and a tilt servo on D9"],
  ["lesson-uart-cmd", "lesson-uart-cmd.elf", "Lesson: a command line on the virtual COM port — help, led on/off, blink <ms>, status"],
  ["lesson-sleep-wfi", "lesson-sleep-wfi.elf", "Lesson: sleep with WFI between TIM2 interrupts vs busy-waiting (B1), with the share of time asleep"],
  ["lesson-scope-mystery", "lesson-scope-mystery.elf", "Lesson: mystery PWM signals on D3/D5/D6/D9 and a secret UART line on D8 to find with the scope"],
  ["lesson-debug-average", "lesson-debug-average.elf", "Lesson: a smoothed pot reading should switch an LED on D7 — find the bug with the debugger"],
  ["lesson-thermostat", "lesson-thermostat.elf", "Lesson project: AHT20 thermostat with hysteresis switching a heater relay on D7, OLED display, B1 set point"],
  ["lesson-parking", "lesson-parking.elf", "Lesson project: HC-SR04 parking sensor — green/yellow/red LEDs on D4–D6 and a beeping buzzer on D8"],
  ["lesson-digital-clock", "lesson-digital-clock.elf", "Lesson project: DS3231 time on a TM1637 display, D4 sets the hour and B1 the minute"],
  ["bare-blinky", "bare-blinky.elf", "Bare metal: toggle PA5 with register writes"],
];

const args = process.argv.slice(2);
if (args.includes("--projects")) {
  console.log([...new Set(EXAMPLES.map(([p]) => p))].join(" "));
  process.exit(0);
}
const strict = args.includes("--strict");

/**
 * M33: an example the code editor can start from — a HAL project of the
 * shared template (hal-common, no sources of its own but main.c and the
 * font, which the prebuilt library has) built with its default settings.
 * Its main.c becomes the editable copy.
 */
function editable(project, file) {
  const mk = join(root, project, "Makefile");
  if (file !== `${project}.elf` || !existsSync(mk)) return null;
  const text = readFileSync(mk, "utf8");
  if (!/^include \.\.\/hal-common\/hal\.mk$/m.test(text)) return null;
  const srcs = /^SRCS\s*:=\s*(.*)$/m.exec(text)?.[1].trim().split(/\s+/) ?? [];
  if (!srcs.every((s) => s === "main.c" || s === "../hal-common/Src/font5x7.c")) return null;
  return { template: "hal", main: `${project}/main.c` };
}

mkdirSync(out, { recursive: true });
const index = [];
const missing = [];
for (const [project, file, description] of EXAMPLES) {
  const src = join(root, project, "build", file);
  if (!existsSync(src)) {
    console.warn(`skip ${file}: not built (${src})`);
    missing.push(file);
    continue;
  }
  copyFileSync(src, join(out, file));
  const entry = { name: file.replace(/\.elf$/, ""), file, description };
  const code = editable(project, file);
  if (code) entry.code = code;
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
// With the libraries the examples are built from (HAL drivers, FreeRTOS,
// FatFs, CMSIS core): a stop inside HAL_Delay or a FreeRTOS call shows
// that code, as CubeIDE does, instead of "no source".
const LIBRARIES = ["vendor/stm32f4xx_hal_driver/Src", "vendor/freertos", "vendor/fatfs", "vendor/CMSIS/Include"];
for (const project of new Set([...EXAMPLES.map(([p]) => p), "hal-common", "freertos-common", ...LIBRARIES])) copySources(project);
// (Their licences go with them, next to the sources.)
for (const l of ["vendor/stm32f4xx_hal_driver/LICENSE.md", "vendor/freertos/LICENSE.md", "vendor/fatfs/LICENSE.md", "vendor/CMSIS/LICENSE.txt"]) {
  if (!existsSync(join(root, l))) continue;
  mkdirSync(dirname(join(srcOut, l)), { recursive: true });
  copyFileSync(join(root, l), join(srcOut, l));
}
writeFileSync(join(out, "sources.json"), JSON.stringify(sources.sort()) + "\n");
console.log(`${sources.length} source files → public/examples/src`);
console.log(`${index.length} examples → public/examples (${index.filter((e) => e.code).length} editable in the code tab)`);
if (strict && missing.length) {
  console.error(`--strict: ${missing.length} example(s) not built: ${missing.join(" ")}`);
  process.exit(1);
}
