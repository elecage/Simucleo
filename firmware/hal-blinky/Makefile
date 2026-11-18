# CubeMX-style HAL blinky. Variants:
#   make                                  PLL from HSI (default CubeMX setup)
#   make CLOCK=HSE_BYPASS TARGET=...      PLL from the ST-LINK 8 MHz clock
#   make CLOCK=HSE_CRYSTAL TARGET=...     wrong: no crystal on the Nucleo → Error_Handler
CLOCK  ?=
TARGET ?= hal-blinky
SRCS   := main.c
EXTRA_CFLAGS := $(if $(CLOCK),-DCLOCK_$(CLOCK))
include ../hal-common/hal.mk

variants:
	$(MAKE) TARGET=hal-blinky
	$(MAKE) TARGET=hal-blinky-hse-bypass CLOCK=HSE_BYPASS
	$(MAKE) TARGET=hal-blinky-hse-crystal CLOCK=HSE_CRYSTAL

.PHONY: variants
