/*
 * SD card driver for SPI mode, and the FatFs disk interface on top of it.
 *
 * Initialisation (SD Physical Layer Simplified Specification §7.2.1):
 * at least 74 clocks with CS high, CMD0 (go idle, CRC 0x95), CMD8 (voltage
 * check, CRC 0x87), ACMD41 with HCS until the card leaves the idle state,
 * CMD58 to read the OCR (CCS = block addressing). Then the clock goes up.
 */
#include "main.h"
#include "sd_spi.h"
#include "ff.h"
#include "diskio.h"

extern SPI_HandleTypeDef hspi1;

#define CS_LOW()  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_6, GPIO_PIN_RESET)
#define CS_HIGH() HAL_GPIO_WritePin(GPIOB, GPIO_PIN_6, GPIO_PIN_SET)

static uint32_t sectors;
static int block_addressing;
static DSTATUS status = STA_NOINIT;

static uint8_t xfer(uint8_t out)
{
  uint8_t in = 0xFF;
  HAL_SPI_TransmitReceive(&hspi1, &out, &in, 1, 10);
  return in;
}

static void set_prescaler(uint32_t prescaler)
{
  __HAL_SPI_DISABLE(&hspi1);
  MODIFY_REG(hspi1.Instance->CR1, SPI_CR1_BR, prescaler);
  __HAL_SPI_ENABLE(&hspi1);
}

/* Wait until the card stops holding MISO low (busy). */
static int wait_ready(uint32_t ms)
{
  uint32_t start = HAL_GetTick();
  while (xfer(0xFF) != 0xFF)
  {
    if (HAL_GetTick() - start > ms)
    {
      return -1;
    }
  }
  return 0;
}

static void deselect(void)
{
  CS_HIGH();
  xfer(0xFF); /* the card releases MISO on the next clock */
}

static int select(void)
{
  CS_LOW();
  xfer(0xFF);
  if (wait_ready(500) == 0)
  {
    return 0;
  }
  deselect();
  return -1;
}

/* Send a command and return its R1 response (bit 7 set: no response). */
static uint8_t command(uint8_t cmd, uint32_t arg)
{
  if (cmd & 0x80)
  {
    /* ACMD: CMD55 first */
    uint8_t r = command(55, 0);
    if (r > 1)
    {
      return r;
    }
    cmd &= 0x7F;
  }
  if (cmd != 12)
  {
    deselect();
    if (select() != 0)
    {
      return 0xFF;
    }
  }
  xfer(0x40 | cmd);
  xfer(arg >> 24);
  xfer(arg >> 16);
  xfer(arg >> 8);
  xfer(arg);
  xfer(cmd == 0 ? 0x95 : cmd == 8 ? 0x87 : 0x01);
  if (cmd == 12)
  {
    xfer(0xFF); /* skip the stuff byte */
  }
  uint8_t r;
  int n = 10;
  do
  {
    r = xfer(0xFF);
  } while ((r & 0x80) && --n);
  return r;
}

static int receive_block(uint8_t *buf, uint32_t len)
{
  uint32_t start = HAL_GetTick();
  uint8_t token;
  do
  {
    token = xfer(0xFF);
  } while (token == 0xFF && HAL_GetTick() - start < 200);
  if (token != 0xFE)
  {
    return -1;
  }
  for (uint32_t i = 0; i < len; i++)
  {
    buf[i] = xfer(0xFF);
  }
  xfer(0xFF); /* CRC, ignored */
  xfer(0xFF);
  return 0;
}

int sd_init(void)
{
  uint8_t ocr[4], csd[16];
  set_prescaler(SPI_BAUDRATEPRESCALER_256); /* ≤ 400 kHz while identifying */
  CS_HIGH();
  for (int i = 0; i < 10; i++)
  {
    xfer(0xFF); /* 80 clocks */
  }
  if (command(0, 0) != 0x01)
  {
    deselect();
    return -1; /* no card */
  }
  if (command(8, 0x1AA) != 0x01)
  {
    deselect();
    return -2; /* SD v1 / MMC: not supported here */
  }
  for (int i = 0; i < 4; i++)
  {
    ocr[i] = xfer(0xFF);
  }
  if (ocr[2] != 0x01 || ocr[3] != 0xAA)
  {
    deselect();
    return -3; /* voltage range not accepted */
  }
  uint32_t start = HAL_GetTick();
  while (command(0x80 | 41, 1UL << 30) != 0)
  {
    if (HAL_GetTick() - start > 1000)
    {
      deselect();
      return -4;
    }
  }
  if (command(58, 0) != 0)
  {
    deselect();
    return -5;
  }
  for (int i = 0; i < 4; i++)
  {
    ocr[i] = xfer(0xFF);
  }
  block_addressing = (ocr[0] & 0x40) != 0;
  if (command(9, 0) != 0 || receive_block(csd, 16) != 0)
  {
    deselect();
    return -6;
  }
  deselect();
  if ((csd[0] >> 6) == 1)
  {
    /* CSD v2: capacity = (C_SIZE + 1) × 512 KiB */
    uint32_t c_size = ((uint32_t)(csd[7] & 0x3F) << 16) | ((uint32_t)csd[8] << 8) | csd[9];
    sectors = (c_size + 1) * 1024;
  }
  set_prescaler(SPI_BAUDRATEPRESCALER_8); /* 10.5 MHz, shared with the display */
  return 0;
}

uint32_t sd_sectors(void) { return sectors; }

int sd_read(uint8_t *buf, uint32_t sector)
{
  int ok = command(17, block_addressing ? sector : sector * 512) == 0 && receive_block(buf, 512) == 0;
  deselect();
  return ok ? 0 : -1;
}

int sd_write(const uint8_t *buf, uint32_t sector)
{
  int ok = 0;
  if (command(24, block_addressing ? sector : sector * 512) == 0)
  {
    xfer(0xFF);
    xfer(0xFE); /* start token */
    for (int i = 0; i < 512; i++)
    {
      xfer(buf[i]);
    }
    xfer(0xFF); /* CRC, not checked */
    xfer(0xFF);
    ok = (xfer(0xFF) & 0x1F) == 0x05 && wait_ready(500) == 0;
  }
  deselect();
  return ok ? 0 : -1;
}

/* ------------------------------------------------- FatFs disk interface */

DSTATUS disk_initialize(BYTE pdrv)
{
  if (pdrv != 0)
  {
    return STA_NOINIT;
  }
  status = sd_init() == 0 ? 0 : STA_NOINIT;
  return status;
}

DSTATUS disk_status(BYTE pdrv)
{
  return pdrv == 0 ? status : STA_NOINIT;
}

DRESULT disk_read(BYTE pdrv, BYTE *buff, LBA_t sector, UINT count)
{
  if (pdrv != 0 || (status & STA_NOINIT))
  {
    return RES_NOTRDY;
  }
  for (; count; count--, sector++, buff += 512)
  {
    if (sd_read(buff, sector) != 0)
    {
      return RES_ERROR;
    }
  }
  return RES_OK;
}

DRESULT disk_write(BYTE pdrv, const BYTE *buff, LBA_t sector, UINT count)
{
  if (pdrv != 0 || (status & STA_NOINIT))
  {
    return RES_NOTRDY;
  }
  for (; count; count--, sector++, buff += 512)
  {
    if (sd_write(buff, sector) != 0)
    {
      return RES_ERROR;
    }
  }
  return RES_OK;
}

DRESULT disk_ioctl(BYTE pdrv, BYTE cmd, void *buff)
{
  if (pdrv != 0 || (status & STA_NOINIT))
  {
    return RES_NOTRDY;
  }
  switch (cmd)
  {
  case CTRL_SYNC:
    return select() == 0 ? (deselect(), RES_OK) : RES_ERROR;
  case GET_SECTOR_COUNT:
    *(LBA_t *)buff = sectors;
    return RES_OK;
  case GET_BLOCK_SIZE:
    *(DWORD *)buff = 1; /* erase block size unknown */
    return RES_OK;
  default:
    return RES_PARERR;
  }
}
