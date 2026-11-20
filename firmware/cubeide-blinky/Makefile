# M39 test fixture: hal-blinky laid out like an STM32CubeIDE project folder
# (Core/Src, Core/Inc, Core/Startup, Drivers/..., Debug/blinky.elf) and built
# from Debug/ with relative paths, as CubeIDE does. The DWARF paths are
# rewritten to a student's Windows workspace with backslashes
# (C:\Users\student\STM32CubeIDE\workspace_1.16.0\blinky\...), so the web
# tests can check that an uploaded folder's sources are matched by suffix.
#   make  ->  build/blinky/ (the folder to upload), build/blinky.zip
FW      := ..
VENDOR  := $(FW)/vendor
COMMON  := $(FW)/hal-common
HAL     := $(VENDOR)/stm32f4xx_hal_driver
PROJ    := build/blinky
WINDIR  := C:\Users\student\STM32CubeIDE\workspace_1.16.0\blinky
CC      := arm-none-eabi-gcc

HAL_MODS := stm32f4xx_hal stm32f4xx_hal_cortex stm32f4xx_hal_rcc stm32f4xx_hal_rcc_ex stm32f4xx_hal_gpio \
            stm32f4xx_hal_pwr stm32f4xx_hal_pwr_ex stm32f4xx_hal_flash stm32f4xx_hal_flash_ex stm32f4xx_hal_uart \
            stm32f4xx_hal_dma stm32f4xx_hal_dma_ex stm32f4xx_hal_exti stm32f4xx_hal_tim stm32f4xx_hal_tim_ex
CORE_SRCS := main.c stm32f4xx_it.c stm32f4xx_hal_msp.c clock_config.c syscalls.c system_stm32f4xx.c
SRCS := $(addprefix ../Core/Src/,$(CORE_SRCS)) \
        $(addprefix ../Drivers/STM32F4xx_HAL_Driver/Src/,$(addsuffix .c,$(HAL_MODS))) \
        ../Core/Startup/startup_stm32f401retx.s

CFLAGS := -mcpu=cortex-m4 -mthumb -mfpu=fpv4-sp-d16 -mfloat-abi=hard \
          -DUSE_HAL_DRIVER -DSTM32F401xE -O0 -g3 -Wall -fdata-sections -ffunction-sections \
          -I../Core/Inc -I../Drivers/STM32F4xx_HAL_Driver/Inc \
          -I../Drivers/CMSIS/Device/ST/STM32F4xx/Include -I../Drivers/CMSIS/Include

all: $(PROJ)/Debug/blinky.elf build/blinky.zip

$(PROJ)/Debug/blinky.elf: ../hal-blinky/main.c $(wildcard $(COMMON)/Src/*.c $(COMMON)/Inc/*.h) Makefile
	rm -rf $(PROJ)
	mkdir -p $(PROJ)/Core/Src $(PROJ)/Core/Inc $(PROJ)/Core/Startup $(PROJ)/Debug \
	  $(PROJ)/Drivers/STM32F4xx_HAL_Driver/Src $(PROJ)/Drivers/STM32F4xx_HAL_Driver/Inc/Legacy \
	  $(PROJ)/Drivers/CMSIS/Device/ST/STM32F4xx/Include $(PROJ)/Drivers/CMSIS/Include $(PROJ)/Backup/Core/Src
	cp ../hal-blinky/main.c $(addprefix $(COMMON)/Src/,stm32f4xx_it.c stm32f4xx_hal_msp.c clock_config.c syscalls.c) \
	  $(VENDOR)/cmsis_device_f4/Source/system_stm32f4xx.c $(PROJ)/Core/Src/
	cp $(COMMON)/Inc/*.h $(PROJ)/Core/Inc/
	cp $(VENDOR)/cmsis_device_f4/Source/startup_stm32f401xe.s $(PROJ)/Core/Startup/startup_stm32f401retx.s
	cp $(COMMON)/STM32F401RETx_FLASH.ld $(PROJ)/STM32F401RETX_FLASH.ld
	cp $(addprefix $(HAL)/Src/,$(addsuffix .c,$(HAL_MODS))) $(PROJ)/Drivers/STM32F4xx_HAL_Driver/Src/
	cp $(HAL)/Inc/*.h $(PROJ)/Drivers/STM32F4xx_HAL_Driver/Inc/
	cp $(HAL)/Inc/Legacy/*.h $(PROJ)/Drivers/STM32F4xx_HAL_Driver/Inc/Legacy/ 2>/dev/null || true
	cp $(VENDOR)/cmsis_device_f4/Include/*.h $(PROJ)/Drivers/CMSIS/Device/ST/STM32F4xx/Include/
	cp $(VENDOR)/CMSIS/Include/*.h $(PROJ)/Drivers/CMSIS/Include/
	# Unrelated files a real project has: an older copy of main.c, project
	# settings, a README.
	cp ../hal-blinky/main.c $(PROJ)/Backup/Core/Src/main.c
	printf '<?xml version="1.0" encoding="UTF-8"?>\n<projectDescription><name>blinky</name></projectDescription>\n' > $(PROJ)/.project
	printf 'Mcu.Name=STM32F401R(D-E)Tx\nProjectManager.ProjectName=blinky\n' > $(PROJ)/blinky.ioc
	printf '# blinky\nLD2 blinks every 500 ms.\n' > $(PROJ)/README.md
	cd $(PROJ)/Debug && $(CC) $(CFLAGS) '-fdebug-prefix-map=$(abspath $(PROJ))=$(WINDIR)' $(SRCS) \
	  -T../STM32F401RETX_FLASH.ld --specs=nano.specs --specs=nosys.specs -Wl,--gc-sections \
	  -Wl,-Map=blinky.map -lc -lm -o blinky.elf

build/blinky.zip: $(PROJ)/Debug/blinky.elf
	rm -f $@
	cd build && python3 -c 'import os, sys, zipfile; z = zipfile.ZipFile("blinky.zip", "w", zipfile.ZIP_DEFLATED); [z.write(os.path.join(d, f)) for d, _, fs in sorted(os.walk("blinky")) for f in sorted(fs)]; z.close()'

clean:
	rm -rf build

.PHONY: all clean
