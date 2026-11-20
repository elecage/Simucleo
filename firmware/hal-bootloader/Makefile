# CubeMX-style HAL bootloader: IAP over USART2 with XMODEM-CRC, dual image
# with backup and rollback (see main.c and bootmeta.h). Linked for flash
# sectors 0-1 only (bootloader.ld); the images it loads are firmware/iap-app.
TARGET   := hal-bootloader
SRCS     := main.c bootmeta.c
LDSCRIPT := bootloader.ld
include ../hal-common/hal.mk
