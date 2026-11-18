# Vendored third-party sources

Only the files the example firmware needs, unmodified.

| Directory | Source | License |
|---|---|---|
| `CMSIS/Include` | [ARM-software/CMSIS_5](https://github.com/ARM-software/CMSIS_5) `CMSIS/Core/Include` | Apache-2.0 (`CMSIS/LICENSE.txt`) |
| `cmsis_device_f4` | [STMicroelectronics/cmsis_device_f4](https://github.com/STMicroelectronics/cmsis_device_f4) | Apache-2.0 (`cmsis_device_f4/LICENSE.md`) |
| `stm32f4xx_hal_driver` | [STMicroelectronics/stm32f4xx_hal_driver](https://github.com/STMicroelectronics/stm32f4xx_hal_driver) | BSD-3-Clause (`stm32f4xx_hal_driver/LICENSE.md`) |

The register table of the simulator is generated from ST's SVD
(`crates/periph-stm32f4/svd/STM32F401.svd`, Apache-2.0, from
[modm-io/cmsis-svd-stm32](https://github.com/modm-io/cmsis-svd-stm32)).
