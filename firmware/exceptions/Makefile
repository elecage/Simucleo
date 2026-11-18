TARGET  := exceptions
BUILD   := build
CC      := arm-none-eabi-gcc
CFLAGS  := -mcpu=cortex-m4 -mthumb -mfloat-abi=hard -mfpu=fpv4-sp-d16 \
           -O2 -g -Wall -Wextra -ffreestanding -ffunction-sections -fdata-sections
LDFLAGS := -T stm32f401re.ld -nostartfiles -nostdlib -Wl,--gc-sections -lgcc

$(BUILD)/$(TARGET).elf: main.c switch.S stm32f401re.ld | $(BUILD)
	$(CC) $(CFLAGS) main.c switch.S $(LDFLAGS) -o $@

$(BUILD):
	mkdir -p $@

clean:
	rm -rf $(BUILD)

.PHONY: clean
