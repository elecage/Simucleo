# Shared build rules for the CubeMX-style FreeRTOS (CMSIS-RTOS v2) examples.
# A project Makefile sets TARGET and SRCS, then includes this file.

FW      := $(dir $(lastword $(MAKEFILE_LIST)))..
VENDOR  := $(FW)/vendor
HALC    := $(FW)/hal-common
RTOSC   := $(FW)/freertos-common
RTOS    := $(VENDOR)/freertos
BUILD   ?= build
CC      := arm-none-eabi-gcc

HAL_SRCS := $(addprefix $(VENDOR)/stm32f4xx_hal_driver/Src/stm32f4xx_hal, \
            .c _cortex.c _rcc.c _rcc_ex.c _gpio.c _pwr.c _pwr_ex.c _flash.c _flash_ex.c \
            _uart.c _dma.c _dma_ex.c _exti.c _tim.c _tim_ex.c _adc.c _adc_ex.c _i2c.c _i2c_ex.c _spi.c)
RTOS_SRCS := $(addprefix $(RTOS)/, tasks.c queue.c list.c timers.c event_groups.c stream_buffer.c \
             portable/GCC/ARM_CM4F/port.c portable/MemMang/heap_4.c CMSIS_RTOS_V2/cmsis_os2.c)
COMMON_SRCS := $(RTOSC)/Src/stm32f4xx_it.c $(RTOSC)/Src/stm32f4xx_hal_timebase_tim.c \
               $(RTOSC)/Src/freertos_hooks.c \
               $(HALC)/Src/stm32f4xx_hal_msp.c $(HALC)/Src/clock_config.c $(HALC)/Src/syscalls.c \
               $(VENDOR)/cmsis_device_f4/Source/system_stm32f4xx.c
STARTUP := $(VENDOR)/cmsis_device_f4/Source/startup_stm32f401xe.s

CFLAGS  := -mcpu=cortex-m4 -mthumb -mfpu=fpv4-sp-d16 -mfloat-abi=hard \
           -DUSE_HAL_DRIVER -DSTM32F401xE -Og -g3 -Wall -fdata-sections -ffunction-sections \
           -I$(RTOSC)/Inc -I$(HALC)/Inc -I$(VENDOR)/stm32f4xx_hal_driver/Inc \
           -I$(VENDOR)/cmsis_device_f4/Include -I$(VENDOR)/CMSIS/Include -I$(VENDOR)/CMSIS/RTOS2/Include \
           -I$(RTOS)/include -I$(RTOS)/portable/GCC/ARM_CM4F -I$(RTOS)/CMSIS_RTOS_V2 $(EXTRA_CFLAGS)
LDFLAGS := -T$(HALC)/STM32F401RETx_FLASH.ld --specs=nano.specs --specs=nosys.specs \
           -Wl,--gc-sections -Wl,-Map=$(BUILD)/$(TARGET).map -lc -lm

$(BUILD)/$(TARGET).elf: $(SRCS) $(COMMON_SRCS) $(HAL_SRCS) $(RTOS_SRCS) $(STARTUP) $(RTOSC)/Inc/FreeRTOSConfig.h | $(BUILD)
	$(CC) $(CFLAGS) $(SRCS) $(COMMON_SRCS) $(HAL_SRCS) $(RTOS_SRCS) $(STARTUP) $(LDFLAGS) -o $@

$(BUILD):
	mkdir -p $@

clean:
	rm -rf $(BUILD)

.PHONY: clean
