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
| `hal-imu-matrix` | CubeMX HAL | I2C1 `Mem_Read` burst from an MPU-6050 (wake-up, ranges), roll/pitch from gravity, MAX7219 8×8 matrix on SPI1 with a GPIO CS | M13 ✅ |
| `hal-ir-remote` | CubeMX HAL | TIM2_CH2 input capture of falling edges at 1 µs: NEC leader, bits, check bytes and repeat codes; LD2 blinks the digit | M13 ✅ |
| `freertos-two-tasks` | CubeMX + FreeRTOS (CMSIS-RTOS v2) | Blink/Count/Button/Flags threads, mutex, B1 EXTI → semaphore → thread flags; SVC/PendSV/SysTick, PSP, BASEPRI, HAL tick on TIM11 | M4 ✅ |
| `freertos-queue-uart` | CubeMX + FreeRTOS (CMSIS-RTOS v2) | UART RX ISR → message queue → echo task; producer/consumer queue; heap and stack statistics | M4 ✅ |

```sh
for d in bare-blinky exceptions difftest hal-uart-printf hal-button-exti hal-pwm-led hal-buzzer-melody hal-adc-servo hal-i2c-oled hal-spi-sd-logger hal-neopixel-dma hal-dht-capture hal-7seg-keypad hal-encoder-stepper-lcd hal-sonar-onewire hal-imu-matrix hal-ir-remote freertos-two-tasks freertos-queue-uart; do make -C firmware/$d; done
make -C firmware/hal-blinky variants
cargo run --release -p simucleo-cli -- run firmware/bare-blinky/build/bare-blinky.elf --ms 2000
cargo test --release -p simucleo-nucleo --test firmware -- --include-ignored
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
