TARGET  := bare-blinky
BUILD   := build
CC      := arm-none-eabi-gcc
CFLAGS  := -mcpu=cortex-m4 -mthumb -mfloat-abi=hard -mfpu=fpv4-sp-d16 \
           -O1 -g -Wall -Wextra -ffreestanding -ffunction-sections -fdata-sections
LDFLAGS := -T stm32f401re.ld -nostartfiles -nostdlib -Wl,--gc-sections -Wl,-Map=$(BUILD)/$(TARGET).map

$(BUILD)/$(TARGET).elf: main.c startup.c stm32f401re.ld | $(BUILD)
	$(CC) $(CFLAGS) main.c startup.c $(LDFLAGS) -o $@

$(BUILD):
	mkdir -p $@

clean:
	rm -rf $(BUILD)

.PHONY: clean
