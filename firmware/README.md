# Test firmware

Example firmware that the simulator must run, built with `arm-none-eabi-gcc`.
CI builds every project here and runs it through `simucleo` as a regression test.

| Project | Kind | Exercises | Milestone |
|---|---|---|---|
| `bare-blinky` | bare-metal (register access) | reset, vector table, GPIO, busy-wait loop | M0 ✅ |
| `exceptions` | bare-metal self test | SysTick, WFI, SVC, PendSV, BASEPRI, nesting, tail-chaining, PSP, FP frames, faults, FreeRTOS-style context switch | M0 ✅ |
| `difftest` | lock-step vs Unicorn (5 optimisation levels) | integer, 64-bit, division, bit ops, TBB/TBH, block copies, DSP, single/half precision FP, exclusives, IT blocks | M0 ✅ |
| `hal-blinky` | CubeMX HAL (`make variants`) | PLL to 84 MHz from HSI or HSE bypass, `HAL_Delay`, GPIO, B1 button; `hse-crystal` variant ends in `Error_Handler` (no crystal on the Nucleo) | M1 ✅ |
| `hal-uart-printf` | CubeMX HAL | `printf` over USART2 (virtual COM port), interrupt-driven echo | M1 ✅ |
| `hal-button-exti` | CubeMX HAL | B1 and a button on D2 → EXTI interrupts (WFI between presses), LD2 and an LED on D7 | M3 ✅ |
| `hal-pwm-led` | CubeMX HAL | TIM2/TIM3 PWM at 1 kHz: LD2 breathes, RGB LED on D3/D5/D6 | M3 ✅ |
| `hal-buzzer-melody` | CubeMX HAL | TIM1 (advanced, MOE) PWM melody on a passive buzzer on D8 | M3 ✅ |
| `hal-adc-servo` | CubeMX HAL | ADC1 (pot, LDR divider, TMP36, internal temperature, VREFINT) → servo on TIM3 50 Hz, DC motor PWM | M5 ✅ |
| `hal-i2c-oled` | CubeMX HAL | I2C1 at 100 kHz: bus scan (`IsDeviceReady`), SSD1306 OLED frame buffer, DS3231 RTC read/write (`Mem_Read/Write`), AHT20 measurement | M6 ✅ |
| `hal-spi-sd-logger` | CubeMX HAL + FatFs | SPI1 SD card driver (SPI-mode init, block read/write), `f_mkfs` on a blank card, CSV log with RTC time stamps, SPI OLED sharing the bus, I2C sensors | M6 ✅ |
| `hal-imu-matrix` | CubeMX HAL | I2C1 `Mem_Read` burst from an MPU-6050 (wake-up, ranges), roll/pitch from gravity, MAX7219 8×8 matrix on SPI1 with a GPIO CS; a second MAX7219 chained on DOUT shows \|a\| as a bar (two frames per CS) | M13 ✅, M15 ✅ |
| `hal-ir-remote` | CubeMX HAL | TIM2_CH2 input capture of falling edges at 1 µs: NEC leader, bits, check bytes and repeat codes; LD2 blinks the digit | M13 ✅ |
| `hal-onewire-multi` | CubeMX HAL | three DS18B20 on one open-drain line: SEARCH ROM enumeration (bit/complement/direction triplets), MATCH ROM per sensor, SKIP ROM + CONVERT T for all, CRC8 | M17 ✅ |
| `hal-bluetooth-led` | CubeMX HAL | HC-05 on USART1 (PA9/PA10, 9600 baud), interrupt-driven line reception, phone commands switch LD2, STATE pin on D7 | M17 ✅ |
| `hal-relay` | CubeMX HAL | EXTI buttons (D4, B1) toggle an active-low 5 V relay module on D7 whose COM–NO contact switches an LED on 5 V | M17 ✅ |
| `hal-servos-multi` | CubeMX HAL | three servos on TIM3 CH1/CH2 and TIM1 CH1 (MOE), 50 Hz, phase-shifted sweeps | M17 ✅ |
| `hal-shift-register` | CubeMX HAL | 74HC595 on SPI1 (SCK → SHCP, MOSI → DS) with a GPIO latch on STCP: a Knight Rider on eight LEDs | M19 ✅ |
| `hal-tm1637-clock` | CubeMX HAL | TM1637 4-digit display bit-banged on open-drain GPIO with DWT µs delays: START/STOP, LSB-first bytes, ACK read back, colon, brightness on B1 | M19 ✅ |
| `hal-joystick-oled` | CubeMX HAL | KY-023 joystick on ADC1 IN0/IN1 (polled) and a pulled-up switch; a dot on an SSD1306 I2C OLED | M19 ✅ |
| `hal-pir-alarm` | CubeMX HAL | HC-SR501 PIR on EXTI8 (both edges): LED and VCP log with the hold time | M19 ✅ |
| `hal-bmp280` | CubeMX HAL | BMP280 on I2C1: chip id, soft reset, trimming registers, forced mode with status polling, Bosch integer compensation, altitude | M19 ✅ |
| `hal-neopixel-chain` | CubeMX HAL | TIM3 PWM + DMA into a 12-LED ring whose DOUT feeds an 8-LED strip: one 20-LED frame | M19 ✅ |
| `hal-stepper-a4988` | CubeMX HAL | NEMA17 on an A4988: TIM2 PWM STEP pulses with an acceleration ramp in the CC interrupt, 1/8 steps via MS1–MS3, DIR turns back every revolution; B1 switches the driver off (EN) | M21 ✅ |
| `hal-stepper-l298n` | CubeMX HAL | NEMA17 on an L298N: half-step sequence on IN1–IN4 written at once through BSRR from a TIM4 interrupt, ENA/ENB 80 % PWM on TIM3 | M21 ✅ |
| `hal-esc-bldc` | CubeMX HAL | Hobby ESC + brushless motor: 50 Hz servo pulses on TIM3, the arming sequence, throttle from a pot on ADC1; B1 stops the signal (failsafe) | M21 ✅ |
| `hal-bldc-hall` | CubeMX HAL | BLDC with hall sensors: EXTI on both edges of the three halls, six-step commutation of a 3-phase bridge through six GPIO pins written at once via BSRR; B1 swaps two halls (it stalls) | M21 ✅ |
| `hal-bldc-pwm` | CubeMX HAL | The same BLDC on TIM1 complementary PWM: CH1–CH3 + CH1N–CH3N at 20 kHz with 500 ns dead time (`HAL_TIMEx_ConfigBreakDeadTime`, OSSR/OSSI), CCPC-preloaded steps switched by a software COM event from the hall EXTI, duty from a pot on ADC1; B1 breaks (EGR.BG → BIF, IRQ 24) and resumes (MOE) | M23 ✅ |
| `hal-bldc-sensorless` | CubeMX HAL | Sensorless BLDC (no halls): TIM1 center-aligned mode 1 at 20 kHz with complementary outputs and 500 ns dead time, RCR = 1 so the update interrupt comes once per period at the underflow (the middle of the on-time); there it reads the floating phase (10 k/2.2 k dividers on A1/A2/A4) and a virtual neutral (three 10 k on A5) on ADC1 in turn. Align 500 ms, open-loop ramp by TIM2 one-pulse, then closed loop: commutation 30° after each back-EMF zero crossing (TIM2 delay, TIM5 as a µs clock), the pot on A0 sets the duty; sleeps in WFI between interrupts; prints state (align/ramp/closed), duty, rpm and the crossings | M28 ✅ |
| `freertos-two-tasks` | CubeMX + FreeRTOS (CMSIS-RTOS v2) | Blink/Count/Button/Flags threads, mutex, B1 EXTI → semaphore → thread flags; SVC/PendSV/SysTick, PSP, BASEPRI, HAL tick on TIM11 | M4 ✅ |
| `freertos-queue-uart` | CubeMX + FreeRTOS (CMSIS-RTOS v2) | UART RX ISR → message queue → echo task; producer/consumer queue; heap and stack statistics | M4 ✅ |
| `lesson-blink-2hz` | CubeMX HAL | solution to the "upload your own firmware" lesson (PA5 at 2 Hz); used only by the tests, not bundled with the site | M16 ✅ |
| `lesson-led-on` | CubeMX HAL | lesson "LED 켜기": D7 driven high once, then WFI | M32 ✅ |
| `lesson-button-poll` | CubeMX HAL | lesson "버튼 폴링": D2 with the internal pull-up read every 10 ms, the LED on D7 follows | M32 ✅ |
| `lesson-knight-rider` | CubeMX HAL | lesson "나이트라이더": four LEDs on D2–D5 from a port/pin table, 100 ms steps | M32 ✅ |
| `lesson-timer-irq` | CubeMX HAL | lesson "타이머 인터럽트": TIM2 update IRQ every 1 ms toggles D7 (100 ms) and LD2 (1 s); D6 from a HAL_Delay loop drifts | M32 ✅ |
| `lesson-ldr-nightlight` | CubeMX HAL | lesson "조도센서 자동 조명": LDR divider on A1 → TIM2_CH3 PWM on D6 with a dead zone | M32 ✅ |
| `lesson-joystick-servos` | CubeMX HAL | lesson "조이스틱 서보 2축": ADC1 IN0/IN1 → two servos on TIM3 CH1/CH2 | M32 ✅ |
| `lesson-uart-cmd` | CubeMX HAL | lesson "UART 명령 파서": interrupt-collected lines, `help`, `led on/off`, `blink <ms>`, `status` | M32 ✅ |
| `lesson-sleep-wfi` | CubeMX HAL | lesson "저전력": `HAL_PWR_EnterSLEEPMode` (WFI, tick suspended) vs busy-wait between TIM2 interrupts, sleep share timed on TIM5 | M32 ✅ |
| `lesson-scope-mystery` | CubeMX HAL | lesson "오실로스코프": four PWM signals (1/2 kHz, 25–75 %) and a 9600-baud secret on USART1 TX | M32 ✅ |
| `lesson-debug-average` | CubeMX HAL | lesson "디버거": an 8-sample average summed in a `uint8_t` (the bug to find) | M32 ✅ |
| `lesson-debug-average-fixed` | CubeMX HAL | the solution of `lesson-debug-average`; used only by the tests, not bundled with the site | M32 ✅ |
| `lesson-thermostat` | CubeMX HAL | lesson project: AHT20 + SSD1306 on I2C1, active-low relay with hysteresis, fail-safe without a sensor, B1 set point | M32 ✅ |
| `lesson-parking` | CubeMX HAL | lesson project: HC-SR04 by TIM2 input capture, three zone LEDs, TIM1 buzzer beeping by distance (non-blocking) | M32 ✅ |
| `lesson-digital-clock` | CubeMX HAL | lesson project: DS3231 time (BCD) on a bit-banged TM1637, D4 hour+ and B1 minute+ written back to the RTC | M32 ✅ |
| `editor-sdk` | prebuilt libraries for the in-browser build | not an example: hal-common's start-up, handlers, MSP, clock and newlib stubs as objects, every HAL module the examples use as `libhal.a`, newlib-nano/libm/libnosys/libgcc (thumb/v7e-m+fp/hard, no debug sections), crt objects, newlib's headers and the linker script reordered for lld. `web/scripts/editor-sdk.mjs` packs them with the HAL/CMSIS headers for the code tab, whose clang (WebAssembly) compiles only the student's files and links against these | M33 ✅ |
| `cubeide-blinky` | test fixture (STM32CubeIDE layout) | hal-blinky copied into a CubeIDE-like folder (`Core/Src`, `Core/Inc`, `Core/Startup`, `Drivers/...`, `Debug/blinky.elf`, plus unrelated files) and built from `Debug/` with DWARF paths rewritten to `C:\Users\student\STM32CubeIDE\workspace_1.16.0\blinky`; also zipped (`build/blinky.zip`). Used by the folder/zip upload tests, not bundled with the site | M39 ✅ |

```sh
for d in bare-blinky exceptions difftest hal-uart-printf hal-button-exti hal-pwm-led hal-buzzer-melody hal-adc-servo hal-i2c-oled hal-spi-sd-logger hal-neopixel-dma hal-dht-capture hal-7seg-keypad hal-encoder-stepper-lcd hal-sonar-onewire hal-imu-matrix hal-ir-remote hal-onewire-multi hal-bluetooth-led hal-relay hal-servos-multi hal-shift-register hal-tm1637-clock hal-joystick-oled hal-pir-alarm hal-bmp280 hal-neopixel-chain hal-stepper-a4988 hal-stepper-l298n hal-esc-bldc hal-bldc-hall hal-bldc-pwm hal-bldc-sensorless freertos-two-tasks freertos-queue-uart lesson-blink-2hz lesson-led-on lesson-button-poll lesson-knight-rider lesson-timer-irq lesson-ldr-nightlight lesson-joystick-servos lesson-uart-cmd lesson-sleep-wfi lesson-scope-mystery lesson-debug-average lesson-debug-average-fixed lesson-thermostat lesson-parking lesson-digital-clock cubeide-blinky editor-sdk; do make -C firmware/$d; done
make -C firmware/hal-blinky variants
cargo run --release -p simucleo-cli -- run firmware/bare-blinky/build/bare-blinky.elf --ms 2000
cargo test --release -p simucleo-nucleo --test firmware -- --include-ignored
cargo test --release -p simucleo-nucleo --test lessons -- --include-ignored    # the M32 lesson firmware
cargo test --release -p simucleo-difftest --features unicorn   # needs cmake to build Unicorn
cargo run --release -p simucleo-cli -- run firmware/hal-uart-printf/build/hal-uart-printf.elf --input "hi" --input-at 300
```

The HAL examples are laid out like STM32CubeMX output (`hal-common/` holds
`stm32f4xx_it.c`, `stm32f4xx_hal_msp.c`, `SystemClock_Config()`, the HAL
configuration and the linker script). The FreeRTOS examples share
`freertos-common/` (CubeMX's `FreeRTOSConfig.h`, interrupt handlers with
SVC/PendSV/SysTick owned by FreeRTOS, and the HAL time base on TIM11).
HAL, CMSIS, FreeRTOS and the device files are vendored under `vendor/` (see `vendor/README.md` for sources and licenses).
Building them needs `libnewlib-arm-none-eabi` for `printf`.
