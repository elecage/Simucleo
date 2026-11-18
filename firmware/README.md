# Test firmware

Example firmware that the simulator must run, built with `arm-none-eabi-gcc`.
CI builds every project here and runs it through `simucleo` as a regression test.

| Project | Kind | Exercises | Milestone |
|---|---|---|---|
| `bare-blinky` | bare-metal (register access) | reset, vector table, RCC/GPIO, busy-wait loop | M0–M1 |
| `hal-blinky` | CubeMX HAL | clock tree, SysTick `HAL_Delay`, GPIO | M1 (planned) |
| `hal-uart-printf` | CubeMX HAL | USART2 → virtual console | M1 (planned) |
| `freertos-two-tasks` | CubeMX + FreeRTOS (CMSIS-RTOS v2) | SVC/PendSV/SysTick, PSP, BASEPRI, FP context | M4 (planned) |

```sh
make -C firmware/bare-blinky
cargo run -p simucleo-cli -- info firmware/bare-blinky/build/bare-blinky.elf
```
