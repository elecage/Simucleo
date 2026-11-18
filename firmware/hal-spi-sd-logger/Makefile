TARGET := hal-spi-sd-logger
FATFS  := ../vendor/fatfs
SRCS   := main.c sd_spi.c ../hal-common/Src/font5x7.c $(FATFS)/ff.c
EXTRA_CFLAGS := -I. -I$(FATFS)
include ../hal-common/hal.mk
