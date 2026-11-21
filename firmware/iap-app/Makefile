# Application images for the IAP bootloader (firmware/hal-bootloader),
# linked for slot A (0x08020000, iap-app.ld) with an image header that
# mkimage.py completes (size, CRC-32).
#   make                 all three variants: build/iap-app-{v1,v2,bad}.bin (+ .elf)
#   make VARIANT=v2      one of them
ifeq ($(VARIANT),)

all:
	$(MAKE) VARIANT=v1
	$(MAKE) VARIANT=v2
	$(MAKE) VARIANT=bad

clean:
	rm -rf build

.PHONY: all clean

else

TARGET   := iap-app-$(VARIANT)
SRCS     := main.c ../hal-bootloader/bootmeta.c
LDSCRIPT := iap-app.ld
DEFINE_v1  := APP_V1
DEFINE_v2  := APP_V2
DEFINE_bad := APP_BAD
# The vector table stays in slot A (SystemInit sets VTOR = 0x08000000 otherwise).
EXTRA_CFLAGS := -D$(DEFINE_$(VARIANT)) -I../hal-bootloader \
                -DUSER_VECT_TAB_ADDRESS -DVECT_TAB_OFFSET=0x00020000U
include ../hal-common/hal.mk
.DEFAULT_GOAL := $(BUILD)/$(TARGET).bin

# The linked ELF, then the image with size and CRC filled in; the ELF gets
# the same header so that loading it gives the same flash contents.
$(BUILD)/$(TARGET).bin: $(BUILD)/$(TARGET).elf mkimage.py ../hal-bootloader/bootmeta.h
	arm-none-eabi-objcopy -O binary --gap-fill 0xFF $< $(BUILD)/$(TARGET).raw
	python3 mkimage.py $(BUILD)/$(TARGET).raw $@ $(BUILD)/$(TARGET).hdr
	arm-none-eabi-objcopy --update-section .image_header=$(BUILD)/$(TARGET).hdr $<
	rm -f $(BUILD)/$(TARGET).raw $(BUILD)/$(TARGET).hdr
	touch $@

endif
