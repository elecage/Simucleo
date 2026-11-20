# Prebuilt part of the in-browser build (M33). The browser compiles only the
# student's own .c files with clang (WebAssembly) and links them with ld.lld
# against what this builds with arm-none-eabi-gcc:
#
#   build/lib/obj/*.o     start-up code, SystemInit, the interrupt handlers,
#                         HAL MSP, SystemClock_Config and the newlib stubs of
#                         hal-common (always linked, as objects: an archive
#                         member is never pulled in to override a weak symbol)
#   build/lib/libhal.a    every HAL module the examples use, and font5x7
#   build/lib/lib*.a      newlib-nano (libc_nano, libm, libnosys) and libgcc
#                         for thumb/v7e-m+fp/hard, without debug sections
#   build/lib/crt*.o      crti/crtbegin/crtend/crtn (_init, _fini)
#   build/lib/*.ld        the examples' linker script, MEMORY first for lld
#   build/include/libc    newlib's headers (newlib-nano's newlib.h first)
#
# web/scripts/editor-sdk.mjs packs these with the HAL/CMSIS headers into
# web/public/toolchain/sdk-hal.tar.gz.

FW      := ..
VENDOR  := $(FW)/vendor
COMMON  := $(FW)/hal-common
BUILD   := build
CC      := arm-none-eabi-gcc
OBJCOPY := arm-none-eabi-objcopy
AR      := arm-none-eabi-ar
ARCH    := -mcpu=cortex-m4 -mthumb -mfpu=fpv4-sp-d16 -mfloat-abi=hard
MULTI   := $(shell $(CC) $(ARCH) -print-multi-directory)
LIBGCC  := $(shell $(CC) $(ARCH) -print-libgcc-file-name)
GCCDIR  := $(dir $(LIBGCC))
LIBC    := $(dir $(shell $(CC) $(ARCH) -print-file-name=libc_nano.a))
INC     := $(abspath $(dir $(shell $(CC) -print-file-name=libc.a))/../include)

# DWARF paths as /firmware/hal-common/... so the source view finds the
# bundled copies of hal-common (as for the examples).
PREFIX_MAP := -fdebug-prefix-map=$(abspath $(FW))=/firmware
CFLAGS  := $(ARCH) -DUSE_HAL_DRIVER -DSTM32F401xE -Og -Wall -fdata-sections -ffunction-sections \
           -I$(COMMON)/Inc -I$(VENDOR)/stm32f4xx_hal_driver/Inc \
           -I$(VENDOR)/cmsis_device_f4/Include -I$(VENDOR)/CMSIS/Include $(PREFIX_MAP)

HAL_MODULES := stm32f4xx_hal $(addprefix stm32f4xx_hal_,cortex rcc rcc_ex gpio pwr pwr_ex flash flash_ex \
               uart dma dma_ex exti tim tim_ex adc adc_ex i2c i2c_ex spi)
HAL_OBJS := $(addprefix $(BUILD)/hal/,$(addsuffix .o,$(HAL_MODULES))) $(BUILD)/hal/font5x7.o
COMMON_OBJS := $(addprefix $(BUILD)/lib/obj/,startup_stm32f401xe.o system_stm32f4xx.o stm32f4xx_it.o \
               stm32f4xx_hal_msp.o clock_config.o syscalls.o)
SYSLIBS := $(addprefix $(BUILD)/lib/,libc_nano.a libm.a libnosys.a libgcc.a)
CRT     := $(addprefix $(BUILD)/lib/,crti.o crtbegin.o crtend.o crtn.o)

all: $(BUILD)/lib/libhal.a $(COMMON_OBJS) $(SYSLIBS) $(CRT) $(BUILD)/lib/STM32F401RETx_FLASH.ld $(BUILD)/include/libc/stdio.h

# The HAL drivers without debug information (their sources are not shipped).
$(BUILD)/hal/stm32f4xx_%.o: $(VENDOR)/stm32f4xx_hal_driver/Src/stm32f4xx_%.c | $(BUILD)/hal
	$(CC) $(CFLAGS) -g0 -c $< -o $@
$(BUILD)/hal/font5x7.o: $(COMMON)/Src/font5x7.c | $(BUILD)/hal
	$(CC) $(CFLAGS) -g -c $< -o $@
$(BUILD)/lib/libhal.a: $(HAL_OBJS) | $(BUILD)/lib
	rm -f $@
	$(AR) rcs $@ $^

$(BUILD)/lib/obj/%.o: $(COMMON)/Src/%.c | $(BUILD)/lib/obj
	$(CC) $(CFLAGS) -g -c $< -o $@
$(BUILD)/lib/obj/system_stm32f4xx.o: $(VENDOR)/cmsis_device_f4/Source/system_stm32f4xx.c | $(BUILD)/lib/obj
	$(CC) $(CFLAGS) -g -c $< -o $@
$(BUILD)/lib/obj/startup_stm32f401xe.o: $(VENDOR)/cmsis_device_f4/Source/startup_stm32f401xe.s | $(BUILD)/lib/obj
	$(CC) $(CFLAGS) -g -c $< -o $@

$(BUILD)/lib/libgcc.a: $(LIBGCC) | $(BUILD)/lib
	$(OBJCOPY) --strip-debug $< $@
$(BUILD)/lib/lib%.a: $(LIBC)lib%.a | $(BUILD)/lib
	$(OBJCOPY) --strip-debug $< $@
$(BUILD)/lib/crt%.o: $(GCCDIR)crt%.o | $(BUILD)/lib
	$(OBJCOPY) --strip-debug $< $@

# lld wants MEMORY defined before ORIGIN(RAM) is used.
$(BUILD)/lib/STM32F401RETx_FLASH.ld: $(COMMON)/STM32F401RETx_FLASH.ld | $(BUILD)/lib
	grep -v '^_estack = ' $< | sed 's/^SECTIONS$$/_estack = ORIGIN(RAM) + LENGTH(RAM);\n\nSECTIONS/' > $@
	grep -q '^_estack = ORIGIN(RAM)' $@

# newlib's headers (not libstdc++'s), newlib-nano's newlib.h on top as nano.specs does.
$(BUILD)/include/libc/stdio.h: | $(BUILD)/lib
	rm -rf $(BUILD)/include/libc
	mkdir -p $(BUILD)/include/libc
	cd $(INC) && find . -path ./c++ -prune -o -type f -name '*.h' -print | xargs cp --parents -t $(abspath $(BUILD)/include/libc)
	rm -rf $(BUILD)/include/libc/nano
	cp $(INC)/nano/newlib.h $(BUILD)/include/libc/newlib.h

$(BUILD)/hal $(BUILD)/lib $(BUILD)/lib/obj:
	mkdir -p $@

clean:
	rm -rf $(BUILD)

.PHONY: all clean
