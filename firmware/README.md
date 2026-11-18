# Test firmware

Example firmware that the simulator must run, built with `arm-none-eabi-gcc`.
CI builds every project here and runs it through `simucleo` as a regression test.

| Project | Kind | Exercises | Milestone |
|---|---|---|---|
| `bare-blinky` | bare-metal (register access) | reset, vector table, GPIO, busy-wait loop | M0 ✅ |
| `exceptions` | bare-metal self test | SysTick, WFI, SVC, PendSV, BASEPRI, nesting, tail-chaining, PSP, FP frames, faults, FreeRTOS-style context switch | M0 ✅ |
| `difftest` | lock-step vs Unicorn (5 optimisation levels) | integer, 64-bit, division, bit ops, TBB/TBH, block copies, DSP, single/half precision FP, exclusives, IT blocks | M0 ✅ |
| `hal-blinky` | CubeMX HAL | clock tree, SysTick `HAL_Delay`, GPIO | M1 (planned) |
| `hal-uart-printf` | CubeMX HAL | USART2 → virtual console | M1 (planned) |
| `freertos-two-tasks` | CubeMX + FreeRTOS (CMSIS-RTOS v2) | SVC/PendSV/SysTick, PSP, BASEPRI, FP context | M4 (planned) |

```sh
for d in bare-blinky exceptions difftest; do make -C firmware/$d; done
cargo run --release -p simucleo-cli -- run firmware/bare-blinky/build/bare-blinky.elf --ms 2000
cargo test --release -p simucleo-nucleo --test firmware -- --include-ignored
cargo test --release -p simucleo-difftest --features unicorn   # needs cmake to build Unicorn
```
