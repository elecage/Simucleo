/*
 * CubeMX-style HAL example: a data logger on an SD card.
 *
 *   SPI1 (mode 0, 10.5 MHz)  D13 SCK (PA5, also LD2), D12 MISO (PA6), D11 MOSI (PA7)
 *     SD card module         CS D10 (PB6)          FAT file system (FatFs)
 *     SSD1306 OLED (SPI)     CS D9 (PC7), DC D8 (PA9), RES D7 (PA8)
 *   I2C1 (100 kHz)           D15 SCL (PB8), D14 SDA (PB9)
 *     DS3231 RTC 0x68        time stamps (also the files' dates)
 *     AHT20 0x38             temperature and humidity
 *
 *   B1 (PC13)  print the log file's size and its first lines
 *
 * A blank card is formatted (f_mkfs). Every second a CSV line is appended
 * to LOG.CSV and the readings are shown on the display.
 */
#include <stdio.h>
#include <string.h>
#include "main.h"
#include "ff.h"
#include "sd_spi.h"

#define RTC_ADDR (0x68 << 1)
#define AHT_ADDR (0x38 << 1)

UART_HandleTypeDef huart2;
I2C_HandleTypeDef hi2c1;
SPI_HandleTypeDef hspi1;

extern const uint8_t font5x7[95][5];
static uint8_t fb[8][128];

static FATFS fs;
static FIL log_file;
static int log_open;
static uint32_t lines;

static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);
static void MX_I2C1_Init(void);
static void MX_SPI1_Init(void);

/* ------------------------------------------------------- SSD1306 (SPI) */

#define OLED_CS(x)  HAL_GPIO_WritePin(GPIOC, GPIO_PIN_7, (x) ? GPIO_PIN_SET : GPIO_PIN_RESET)
#define OLED_DC(x)  HAL_GPIO_WritePin(GPIOA, GPIO_PIN_9, (x) ? GPIO_PIN_SET : GPIO_PIN_RESET)
#define OLED_RES(x) HAL_GPIO_WritePin(GPIOA, GPIO_PIN_8, (x) ? GPIO_PIN_SET : GPIO_PIN_RESET)

static void oled_send(int data, const uint8_t *buf, uint16_t n)
{
  OLED_DC(data);
  OLED_CS(0);
  HAL_SPI_Transmit(&hspi1, (uint8_t *)buf, n, 100);
  OLED_CS(1);
}

static void oled_init(void)
{
  static const uint8_t init[] = {0xAE, 0xD5, 0x80, 0xA8, 0x3F, 0xD3, 0x00, 0x40, 0x8D, 0x14,
                                 0x20, 0x00, 0xA1, 0xC8, 0xDA, 0x12, 0x81, 0xCF, 0xD9, 0xF1,
                                 0xDB, 0x40, 0xA4, 0xA6, 0xAF};
  OLED_RES(0);
  HAL_Delay(1);
  OLED_RES(1);
  HAL_Delay(1);
  oled_send(0, init, sizeof init);
}

static void oled_flush(void)
{
  static const uint8_t window[] = {0x21, 0, 127, 0x22, 0, 7};
  oled_send(0, window, sizeof window);
  oled_send(1, &fb[0][0], sizeof fb);
}

static void text(int x, int y, const char *s, int scale)
{
  for (; *s; s++, x += 6 * scale)
  {
    char c = (*s < 0x20 || *s > 0x7E) ? '?' : *s;
    for (int col = 0; col < 5; col++)
      for (int row = 0; row < 7; row++)
        if (font5x7[c - 0x20][col] & (1 << row))
          for (int d = 0; d < scale * scale; d++)
          {
            int px = x + col * scale + d % scale, py = y + row * scale + d / scale;
            if (px < 128 && py < 64)
              fb[py / 8][px] |= 1 << (py % 8);
          }
  }
}

/* --------------------------------------------------------- I2C sensors */

typedef struct
{
  int year, month, day, hour, min, sec;
} DateTime;

static int bcd(uint8_t b) { return (b >> 4) * 10 + (b & 0x0F); }

static int rtc_read(DateTime *t)
{
  uint8_t r[7];
  if (HAL_I2C_Mem_Read(&hi2c1, RTC_ADDR, 0x00, I2C_MEMADD_SIZE_8BIT, r, 7, 100) != HAL_OK)
  {
    return -1;
  }
  t->sec = bcd(r[0] & 0x7F);
  t->min = bcd(r[1] & 0x7F);
  t->hour = bcd(r[2] & 0x3F);
  t->day = bcd(r[4] & 0x3F);
  t->month = bcd(r[5] & 0x1F);
  t->year = 2000 + bcd(r[6]) + ((r[5] & 0x80) ? 100 : 0);
  return 0;
}

static int aht_read(int *t10, int *h10)
{
  uint8_t trigger[3] = {0xAC, 0x33, 0x00}, d[7];
  if (HAL_I2C_Master_Transmit(&hi2c1, AHT_ADDR, trigger, 3, 100) != HAL_OK)
  {
    return -1;
  }
  HAL_Delay(80);
  if (HAL_I2C_Master_Receive(&hi2c1, AHT_ADDR, d, 7, 100) != HAL_OK || (d[0] & 0x80))
  {
    return -1;
  }
  uint32_t h = ((uint32_t)d[1] << 12) | ((uint32_t)d[2] << 4) | (d[3] >> 4);
  uint32_t t = ((uint32_t)(d[3] & 0x0F) << 16) | ((uint32_t)d[4] << 8) | d[5];
  *h10 = (int)((h * 1000ULL + (1 << 19)) >> 20);
  *t10 = (int)((t * 2000ULL + (1 << 19)) >> 20) - 500;
  return 0;
}

/* FatFs asks for the time to stamp files with. */
DWORD get_fattime(void)
{
  DateTime t;
  if (rtc_read(&t) != 0)
  {
    return (DWORD)(2026 - 1980) << 25 | 1 << 21 | 1 << 16;
  }
  return (DWORD)(t.year - 1980) << 25 | (DWORD)t.month << 21 | (DWORD)t.day << 16 |
         (DWORD)t.hour << 11 | (DWORD)t.min << 5 | (DWORD)(t.sec / 2);
}

/* ------------------------------------------------------------ the log */

static void open_log(void)
{
  static BYTE work[FF_MAX_SS];
  FRESULT r = f_mount(&fs, "", 1);
  if (r == FR_NO_FILESYSTEM)
  {
    printf("blank card: formatting... ");
    MKFS_PARM opt = {FM_FAT, 0, 0, 0, 0};
    r = f_mkfs("", &opt, work, sizeof work);
    printf("%s\r\n", r == FR_OK ? "done" : "failed");
    if (r == FR_OK)
    {
      r = f_mount(&fs, "", 1);
    }
  }
  if (r != FR_OK)
  {
    printf("SD card: mount failed (FRESULT %d)\r\n", r);
    return;
  }
  DWORD free_clusters;
  FATFS *pfs;
  if (f_getfree("", &free_clusters, &pfs) == FR_OK)
  {
    printf("SD card: FAT%s, %lu KiB, %lu KiB free\r\n", fs.fs_type == FS_FAT32 ? "32" : fs.fs_type == FS_FAT16 ? "16" : "12",
           (unsigned long)((pfs->n_fatent - 2) * pfs->csize / 2), (unsigned long)(free_clusters * pfs->csize / 2));
  }
  if (f_open(&log_file, "LOG.CSV", FA_OPEN_APPEND | FA_WRITE) != FR_OK)
  {
    printf("cannot open LOG.CSV\r\n");
    return;
  }
  if (f_size(&log_file) == 0)
  {
    f_puts("time,temp_c,humidity_pct\n", &log_file);
  }
  log_open = 1;
  printf("logging to LOG.CSV (%lu bytes)\r\n", (unsigned long)f_size(&log_file));
}

static void dump_log(void)
{
  FIL f;
  char line[64];
  if (f_open(&f, "LOG.CSV", FA_READ) != FR_OK)
  {
    printf("no LOG.CSV\r\n");
    return;
  }
  printf("LOG.CSV, %lu bytes:\r\n", (unsigned long)f_size(&f));
  for (int n = 0; n < 4 && f_gets(line, sizeof line, &f); n++)
  {
    line[strcspn(line, "\n")] = 0;
    printf("  %s\r\n", line);
  }
  f_close(&f);
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  MX_I2C1_Init();
  MX_SPI1_Init();
  printf("SD logger: SD card on SPI1 (CS D10), OLED on SPI1 (CS D9), RTC + AHT20 on I2C1\r\n");

  oled_init();
  uint8_t aht_init[3] = {0xBE, 0x08, 0x00};
  HAL_I2C_Master_Transmit(&hi2c1, AHT_ADDR, aht_init, 3, 100);
  open_log();

  int last_sec = -1;
  while (1)
  {
    if (HAL_GPIO_ReadPin(B1_GPIO_Port, B1_Pin) == GPIO_PIN_RESET)
    {
      dump_log();
      while (HAL_GPIO_ReadPin(B1_GPIO_Port, B1_Pin) == GPIO_PIN_RESET)
      {
        HAL_Delay(10);
      }
    }
    DateTime now;
    if (rtc_read(&now) != 0 || now.sec == last_sec)
    {
      HAL_Delay(50);
      continue;
    }
    last_sec = now.sec;
    int t10 = 0, h10 = 0, ok = aht_read(&t10, &h10) == 0;
    char stamp[24], line[96];
    snprintf(stamp, sizeof stamp, "%04d-%02d-%02d %02d:%02d:%02d", now.year, now.month, now.day, now.hour, now.min,
             now.sec);
    snprintf(line, sizeof line, "%s,%d.%d,%d.%d", stamp, t10 / 10, (t10 < 0 ? -t10 : t10) % 10, h10 / 10, h10 % 10);
    if (log_open && ok)
    {
      if (f_puts(line, &log_file) < 0 || f_putc('\n', &log_file) < 0 || f_sync(&log_file) != FR_OK)
      {
        printf("write failed: card removed?\r\n");
        log_open = 0;
      }
      else
      {
        lines++;
      }
    }
    printf("%s\r\n", line);

    memset(fb, 0, sizeof fb);
    text(10, 0, stamp, 1);
    snprintf(line, sizeof line, "%d.%d C", t10 / 10, (t10 < 0 ? -t10 : t10) % 10);
    text(0, 14, line, 2);
    snprintf(line, sizeof line, "%d.%d %%RH", h10 / 10, h10 % 10);
    text(0, 32, line, 2);
    snprintf(line, sizeof line, log_open ? "SD: %lu lines" : "SD: not logging", (unsigned long)lines);
    text(0, 56, line, 1);
    oled_flush();
  }
}

/* ------------------------------------------------------- peripherals */

static void MX_SPI1_Init(void)
{
  hspi1.Instance = SPI1;
  hspi1.Init.Mode = SPI_MODE_MASTER;
  hspi1.Init.Direction = SPI_DIRECTION_2LINES;
  hspi1.Init.DataSize = SPI_DATASIZE_8BIT;
  hspi1.Init.CLKPolarity = SPI_POLARITY_LOW;
  hspi1.Init.CLKPhase = SPI_PHASE_1EDGE;
  hspi1.Init.NSS = SPI_NSS_SOFT;
  hspi1.Init.BaudRatePrescaler = SPI_BAUDRATEPRESCALER_8;
  hspi1.Init.FirstBit = SPI_FIRSTBIT_MSB;
  hspi1.Init.TIMode = SPI_TIMODE_DISABLE;
  hspi1.Init.CRCCalculation = SPI_CRCCALCULATION_DISABLE;
  hspi1.Init.CRCPolynomial = 10;
  if (HAL_SPI_Init(&hspi1) != HAL_OK)
  {
    Error_Handler();
  }
}

void HAL_SPI_MspInit(SPI_HandleTypeDef *hspi)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};
  if (hspi->Instance == SPI1)
  {
    __HAL_RCC_SPI1_CLK_ENABLE();
    __HAL_RCC_GPIOA_CLK_ENABLE();
    /* PA5 = SCK, PA6 = MISO, PA7 = MOSI */
    GPIO_InitStruct.Pin = GPIO_PIN_5 | GPIO_PIN_6 | GPIO_PIN_7;
    GPIO_InitStruct.Mode = GPIO_MODE_AF_PP;
    GPIO_InitStruct.Pull = GPIO_NOPULL;
    GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
    GPIO_InitStruct.Alternate = GPIO_AF5_SPI1;
    HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);
  }
}

static void MX_I2C1_Init(void)
{
  hi2c1.Instance = I2C1;
  hi2c1.Init.ClockSpeed = 100000;
  hi2c1.Init.DutyCycle = I2C_DUTYCYCLE_2;
  hi2c1.Init.AddressingMode = I2C_ADDRESSINGMODE_7BIT;
  if (HAL_I2C_Init(&hi2c1) != HAL_OK)
  {
    Error_Handler();
  }
}

void HAL_I2C_MspInit(I2C_HandleTypeDef *hi2c)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};
  if (hi2c->Instance == I2C1)
  {
    __HAL_RCC_GPIOB_CLK_ENABLE();
    GPIO_InitStruct.Pin = GPIO_PIN_8 | GPIO_PIN_9; /* SCL, SDA */
    GPIO_InitStruct.Mode = GPIO_MODE_AF_OD;
    GPIO_InitStruct.Pull = GPIO_NOPULL;
    GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
    GPIO_InitStruct.Alternate = GPIO_AF4_I2C1;
    HAL_GPIO_Init(GPIOB, &GPIO_InitStruct);
    __HAL_RCC_I2C1_CLK_ENABLE();
  }
}

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};
  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOC_CLK_ENABLE();
  /* Chip selects idle high; display reset released. */
  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_6, GPIO_PIN_SET);
  HAL_GPIO_WritePin(GPIOC, GPIO_PIN_7, GPIO_PIN_SET);
  HAL_GPIO_WritePin(GPIOA, GPIO_PIN_8 | GPIO_PIN_9, GPIO_PIN_SET);
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_HIGH;
  GPIO_InitStruct.Pin = GPIO_PIN_6; /* D10: SD CS */
  HAL_GPIO_Init(GPIOB, &GPIO_InitStruct);
  GPIO_InitStruct.Pin = GPIO_PIN_7; /* D9: OLED CS */
  HAL_GPIO_Init(GPIOC, &GPIO_InitStruct);
  GPIO_InitStruct.Pin = GPIO_PIN_8 | GPIO_PIN_9; /* D7: OLED RES, D8: OLED DC */
  HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);
  GPIO_InitStruct.Pin = B1_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_INPUT;
  HAL_GPIO_Init(B1_GPIO_Port, &GPIO_InitStruct);
}

static void MX_USART2_UART_Init(void)
{
  huart2.Instance = USART2;
  huart2.Init.BaudRate = 115200;
  huart2.Init.WordLength = UART_WORDLENGTH_8B;
  huart2.Init.StopBits = UART_STOPBITS_1;
  huart2.Init.Parity = UART_PARITY_NONE;
  huart2.Init.Mode = UART_MODE_TX_RX;
  huart2.Init.HwFlowCtl = UART_HWCONTROL_NONE;
  huart2.Init.OverSampling = UART_OVERSAMPLING_16;
  if (HAL_UART_Init(&huart2) != HAL_OK)
  {
    Error_Handler();
  }
}
