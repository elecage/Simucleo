# Test programs for lock-step comparison with Unicorn (crates/difftest).
# The same sources are built at several optimisation levels to exercise
# different instruction selections.
CC      := arm-none-eabi-gcc
BUILD   := build
COMMON  := -mcpu=cortex-m4 -mthumb -mfloat-abi=hard -mfpu=fpv4-sp-d16 -mfp16-format=ieee \
           -g -Wall -Wextra -ffreestanding -fno-builtin -ffp-contract=fast -fno-math-errno \
           -ffunction-sections -fdata-sections
LDFLAGS := -T difftest.ld -nostartfiles -nostdlib -Wl,--gc-sections -lgcc
VARIANTS := O0 O1 O2 Os O3

all: $(VARIANTS:%=$(BUILD)/difftest-%.elf)

$(BUILD)/difftest-%.elf: tests.c asm.S start.S difftest.ld | $(BUILD)
	$(CC) $(COMMON) -$* $(if $(filter O3,$*),-funroll-loops) tests.c asm.S start.S $(LDFLAGS) -o $@

$(BUILD):
	mkdir -p $@

clean:
	rm -rf $(BUILD)

.PHONY: all clean
