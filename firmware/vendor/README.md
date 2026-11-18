# Vendored third-party sources

Only the files the example firmware needs, unmodified.

| Directory | Source | License |
|---|---|---|
| `CMSIS/Include` | [ARM-software/CMSIS_5](https://github.com/ARM-software/CMSIS_5) `CMSIS/Core/Include` | Apache-2.0 (`CMSIS/LICENSE.txt`) |
| `cmsis_device_f4` | [STMicroelectronics/cmsis_device_f4](https://github.com/STMicroelectronics/cmsis_device_f4) | Apache-2.0 (`cmsis_device_f4/LICENSE.md`) |
| `freertos` | [STMicroelectronics/stm32_mw_freertos](https://github.com/STMicroelectronics/stm32_mw_freertos) `Source/` (FreeRTOS Kernel V11.3.1 as packaged for STM32CubeMX, with the CMSIS-RTOS v2 wrapper `CMSIS_RTOS_V2/`; only the GCC ARM_CM4F port and heap_4) | MIT (`freertos/LICENSE`) |
| `CMSIS/RTOS2/Include` | [ARM-software/CMSIS_6](https://github.com/ARM-software/CMSIS_6) v6.1.0 `CMSIS/RTOS2/Include` (`cmsis_os2.h` API 2.3.0, `os_tick.h`) | Apache-2.0 (`CMSIS/LICENSE.txt`) |
| `fatfs` | [STMicroelectronics/stm32_mw_fatfs](https://github.com/STMicroelectronics/stm32_mw_fatfs) tag `r0.16_stm32cube_20260904` `source/` (ChaN FatFs R0.16; only `ff.c`, `ff.h`, `diskio.h`; the configuration `ffconf.h` and the disk driver live in the example) | BSD-style FatFs license (`fatfs/LICENSE.md`) |
| `stm32f4xx_hal_driver` (v1.8.6) | [STMicroelectronics/stm32f4xx_hal_driver](https://github.com/STMicroelectronics/stm32f4xx_hal_driver) | BSD-3-Clause (`stm32f4xx_hal_driver/LICENSE.md`) |

The register table of the simulator is generated from ST's SVD
(`crates/periph-stm32f4/svd/STM32F401.svd`, Apache-2.0, from
[modm-io/cmsis-svd-stm32](https://github.com/modm-io/cmsis-svd-stm32)).
