/*
 * Boot metadata records, CRC-32, flash erase/program helpers and the IWDG,
 * shared by the bootloader and the application images (see bootmeta.h).
 */
#include "main.h"
#include "bootmeta.h"

uint32_t crc32_update(uint32_t crc, const uint8_t *p, uint32_t n)
{
  while (n--)
  {
    crc ^= *p++;
    for (int k = 0; k < 8; k++)
    {
      crc = (crc >> 1) ^ (0xEDB88320u & (0u - (crc & 1u)));
    }
  }
  return crc;
}

uint32_t crc32(const uint8_t *p, uint32_t n)
{
  return crc32_update(0xFFFFFFFFu, p, n) ^ 0xFFFFFFFFu;
}

static int meta_valid(const boot_meta_t *m)
{
  return m->magic == META_MAGIC && m->check == crc32((const uint8_t *)m, 12);
}

static int meta_erased(const boot_meta_t *m)
{
  const uint32_t *w = (const uint32_t *)m;
  return w[0] == 0xFFFFFFFFu && w[1] == 0xFFFFFFFFu && w[2] == 0xFFFFFFFFu && w[3] == 0xFFFFFFFFu;
}

const boot_meta_t *meta_last(uint32_t *count)
{
  const boot_meta_t *rec = (const boot_meta_t *)META_BASE;
  const boot_meta_t *last = 0;
  uint32_t i = 0;
  for (; i < META_RECORDS && !meta_erased(&rec[i]); i++)
  {
    if (meta_valid(&rec[i]))
    {
      last = &rec[i];
    }
  }
  if (count)
  {
    *count = i;
  }
  return last;
}

const char *meta_state_name(uint32_t state)
{
  switch (state)
  {
  case META_TRIAL:
    return "trial";
  case META_CONFIRMED:
    return "confirmed";
  case META_ROLLED_BACK:
    return "rolled back";
  default:
    return "?";
  }
}

int meta_append(uint16_t state, uint16_t tries, uint32_t version)
{
  boot_meta_t m = {META_MAGIC, state, tries, version, 0};
  m.check = crc32((const uint8_t *)&m, 12);
  uint32_t used;
  meta_last(&used);
  int err = 0;
  HAL_FLASH_Unlock();
  if (used >= META_RECORDS)
  {
    /* Full: the only time this sector is erased. */
    err = flash_erase_sector(META_SECTOR);
    used = 0;
  }
  if (!err)
  {
    err = flash_program(META_BASE + used * sizeof m, &m, sizeof m);
  }
  HAL_FLASH_Lock();
  return err;
}

/* ---------------------------------------------------------------- flash */

static volatile int erase_state; /* 1 busy, 0 done, -1 error */

void HAL_FLASH_EndOfOperationCallback(uint32_t ReturnValue)
{
  (void)ReturnValue;
  erase_state = 0;
}

void HAL_FLASH_OperationErrorCallback(uint32_t ReturnValue)
{
  (void)ReturnValue;
  erase_state = -1;
}

void FLASH_IRQHandler(void)
{
  HAL_FLASH_IRQHandler();
}

int flash_erase_sector(uint32_t sector)
{
  FLASH_EraseInitTypeDef e = {0};
  e.TypeErase = FLASH_TYPEERASE_SECTORS;
  e.Sector = sector;
  e.NbSectors = 1;
  e.VoltageRange = FLASH_VOLTAGE_RANGE_3; /* 2.7-3.6 V: x32 parallelism */
  __HAL_FLASH_CLEAR_FLAG(FLASH_FLAG_EOP | FLASH_FLAG_OPERR | FLASH_FLAG_WRPERR | FLASH_FLAG_PGAERR |
                         FLASH_FLAG_PGPERR | FLASH_FLAG_PGSERR);
  HAL_NVIC_SetPriority(FLASH_IRQn, 1, 0);
  HAL_NVIC_EnableIRQ(FLASH_IRQn);
  erase_state = 1;
  if (HAL_FLASHEx_Erase_IT(&e) != HAL_OK)
  {
    return -1;
  }
  /* An erase takes 250 ms (16 KB) to 1.1 s (128 KB): sleep until the
   * end-of-operation interrupt instead of polling BSY. */
  while (erase_state == 1)
  {
    __WFI();
  }
  return erase_state;
}

int flash_program(uint32_t dst, const void *src, uint32_t n)
{
  const uint8_t *s = src;
  for (uint32_t i = 0; i < n; i += 4)
  {
    uint32_t w = (uint32_t)s[i] | (uint32_t)s[i + 1] << 8 | (uint32_t)s[i + 2] << 16 |
                 (uint32_t)s[i + 3] << 24;
    if (HAL_FLASH_Program(FLASH_TYPEPROGRAM_WORD, dst + i, w) != HAL_OK)
    {
      return -1;
    }
    if (*(volatile uint32_t *)(dst + i) != w)
    {
      return -1; /* the cells were not erased */
    }
  }
  return 0;
}

/* ---------------------------------------------------------------- IWDG */

void iwdg_start(uint32_t prescaler_code, uint32_t reload)
{
  IWDG->KR = 0xCCCCu;        /* start (also switches the LSI on) */
  IWDG->KR = 0x5555u;        /* unlock PR and RLR */
  IWDG->PR = prescaler_code; /* 0 = /4 ... 6 = /256 */
  IWDG->RLR = reload;
  uint32_t t0 = HAL_GetTick();
  while (IWDG->SR != 0u && HAL_GetTick() - t0 < 50u)
  {
    /* PVU/RVU: the values travel into the LSI domain (5 LSI periods) */
  }
  IWDG->KR = 0xAAAAu;        /* reload with the new value */
}
