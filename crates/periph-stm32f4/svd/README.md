`STM32F401.svd` is STMicroelectronics' CMSIS-SVD description of the
STM32F401 (Copyright STMicroelectronics, Apache-2.0, see the file header),
taken from [modm-io/cmsis-svd-stm32](https://github.com/modm-io/cmsis-svd-stm32).

`src/svd.rs` is generated from it:

```bash
python3 tools/svdgen.py crates/periph-stm32f4/svd/STM32F401.svd > crates/periph-stm32f4/src/svd.rs
```
