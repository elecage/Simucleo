/*
 * Flash layout, image header and boot metadata shared by the bootloader
 * (firmware/hal-bootloader) and the application images (firmware/iap-app).
 *
 * Flash map of the STM32F401RE (512 KB, sectors of 16/16/16/16/64/128/128/128 KB):
 *
 *   sector 0-1  0x08000000  32 KB  bootloader (this project, linked there)
 *   sector 2    0x08008000  16 KB  boot metadata: append-only 16-byte records
 *   sector 3-4  0x0800C000  80 KB  unused
 *   sector 5    0x08020000 128 KB  slot A: the image that runs (images are linked here)
 *   sector 6    0x08040000 128 KB  slot B: download area (XMODEM writes here)
 *   sector 7    0x08060000 128 KB  slot C: backup of the previous image (rollback source)
 *
 * Image format: a plain binary linked for slot A. Its vector table comes
 * first (initial SP, reset vector, ...), and at offset 0x200 an
 * image_header_t. firmware/iap-app/mkimage.py fills in `size` (bytes of the
 * whole image, padded to a multiple of 4) and `crc32`: the CRC-32
 * (IEEE 802.3, the one of zip/zlib: reflected, polynomial 0xEDB88320,
 * initial 0xFFFFFFFF, final XOR 0xFFFFFFFF) of the whole image from its
 * first byte with the four bytes of the crc32 field taken as 0.
 *
 * Boot metadata: sector 2 holds 16-byte records written one after another
 * (1024 fit). The last valid record wins; a record still all 0xFF ends the
 * list. A record is only ever programmed into erased cells, so updating the
 * state costs no erase: the sector is erased only when it is full (an erase
 * takes 250 ms here and a sector stands about 10 000 of them). A record
 * whose check does not match (a write cut short by a reset or power loss)
 * is skipped.
 */
#ifndef BOOTMETA_H
#define BOOTMETA_H

#include <stdint.h>

#define BOOT_BASE        0x08000000u
#define META_BASE        0x08008000u
#define META_SIZE        0x4000u
#define META_SECTOR      2u           /* FLASH_SECTOR_2 */
#define SLOT_A           0x08020000u
#define SLOT_B           0x08040000u
#define SLOT_C           0x08060000u
#define SLOT_SIZE        0x20000u
#define SLOT_A_SECTOR    5u
#define SLOT_B_SECTOR    6u
#define SLOT_C_SECTOR    7u
#define SRAM_START       0x20000000u
#define SRAM_END         0x20018000u  /* 96 KB */

/* Image header at IMAGE_HEADER_OFFSET from the start of an image. */
#define IMAGE_HEADER_OFFSET 0x200u
#define IMAGE_MAGIC      0x21474D49u  /* "IMG!" in memory */

typedef struct
{
  uint32_t magic;    /* IMAGE_MAGIC */
  uint32_t version;  /* 1, 2, ... (the "bad" demo image is 3) */
  uint32_t size;     /* bytes of the whole image, a multiple of 4 */
  uint32_t crc32;    /* CRC-32 of the image with this field as 0 */
} image_header_t;

/* Boot metadata record (16 bytes, in sector 2). */
#define META_MAGIC       0xB0075EC7u
#define META_TRIAL       1u  /* a new image is in slot A, not confirmed yet */
#define META_CONFIRMED   2u  /* the image in slot A confirmed itself */
#define META_ROLLED_BACK 3u  /* the new image failed: slot C was copied back to A */
#define META_RECORDS     (META_SIZE / 16u)
#define TRIAL_MAX_TRIES  3u  /* boots of a trial image before it is rolled back */

typedef struct
{
  uint32_t magic;    /* META_MAGIC */
  uint16_t state;    /* META_TRIAL / META_CONFIRMED / META_ROLLED_BACK */
  uint16_t tries;    /* trial boots so far (META_TRIAL) */
  uint32_t version;  /* version of the image in slot A it is about */
  uint32_t check;    /* crc32() of the 12 bytes before */
} boot_meta_t;

uint32_t crc32_update(uint32_t crc, const uint8_t *p, uint32_t n);
uint32_t crc32(const uint8_t *p, uint32_t n);

/* The last valid record, or 0 (none). *count = records in use (valid or not). */
const boot_meta_t *meta_last(uint32_t *count);
/* Append a record (erases sector 2 first when it is full). 0 = ok. */
int meta_append(uint16_t state, uint16_t tries, uint32_t version);
const char *meta_state_name(uint32_t state);

/* Erase one sector, sleeping (WFI) until the end-of-operation interrupt.
 * Returns 0 on success. The flash must be unlocked. */
int flash_erase_sector(uint32_t sector);
/* Program `n` bytes (a multiple of 4) at `dst` word by word. Unlocked. */
int flash_program(uint32_t dst, const void *src, uint32_t n);

/* The IWDG, by its registers (KR/PR/RLR/SR). */
void iwdg_start(uint32_t prescaler_code, uint32_t reload);
static inline void iwdg_refresh(void)
{
  /* KR = 0xAAAA reloads the counter; while the IWDG is not started it does nothing. */
  *(volatile uint32_t *)0x40003000u = 0xAAAAu;
}

#endif
