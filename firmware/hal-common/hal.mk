# Shared build rules for the CubeMX-style HAL examples.
# A project Makefile sets TARGET, SRCS (its own .c files) and optionally
# EXTRA_CFLAGS and LDSCRIPT (a linker script of its own), then includes
# this file.

FW      := $(dir $(lastword $(MAKEFILE_LIST)))..
VENDOR  := $(FW)/vendor
COMMON  := $(FW)/hal-common
BUILD   ?= build
CC      := arm-none-eabi-gcc
LDSCRIPT ?= $(COMMON)/STM32F401RETx_FLASH.ld

HAL_SRCS := $(addprefix $(VENDOR)/stm32f4xx_hal_driver/Src/stm32f4xx_hal, \
            .c _cortex.c _rcc.c _rcc_ex.c _gpio.c _pwr.c _pwr_ex.c _flash.c _flash_ex.c \
            _uart.c _dma.c _dma_ex.c _exti.c _tim.c _tim_ex.c _adc.c _adc_ex.c _i2c.c _i2c_ex.c _spi.c)
COMMON_SRCS := $(COMMON)/Src/stm32f4xx_it.c $(COMMON)/Src/stm32f4xx_hal_msp.c \
               $(COMMON)/Src/clock_config.c $(COMMON)/Src/syscalls.c \
               $(VENDOR)/cmsis_device_f4/Source/system_stm32f4xx.c
STARTUP := $(VENDOR)/cmsis_device_f4/Source/startup_stm32f401xe.s

CFLAGS  := -mcpu=cortex-m4 -mthumb -mfpu=fpv4-sp-d16 -mfloat-abi=hard \
           -DUSE_HAL_DRIVER -DSTM32F401xE -Og -g3 -Wall -fdata-sections -ffunction-sections \
           -I$(COMMON)/Inc -I$(VENDOR)/stm32f4xx_hal_driver/Inc \
           -I$(VENDOR)/cmsis_device_f4/Include -I$(VENDOR)/CMSIS/Include $(EXTRA_CFLAGS)
LDFLAGS := -T$(LDSCRIPT) --specs=nano.specs --specs=nosys.specs \
           -Wl,--gc-sections -Wl,-Map=$(BUILD)/$(TARGET).map -lc -lm

$(BUILD)/$(TARGET).elf: $(SRCS) $(COMMON_SRCS) $(HAL_SRCS) $(STARTUP) $(LDSCRIPT) | $(BUILD)
	$(CC) $(CFLAGS) $(SRCS) $(COMMON_SRCS) $(HAL_SRCS) $(STARTUP) $(LDFLAGS) -o $@

$(BUILD):
	mkdir -p $@

clean:
	rm -rf $(BUILD)

.PHONY: clean
