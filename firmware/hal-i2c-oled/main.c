/*
 * CubeMX-style HAL example: an I2C clock with a thermometer.
 *
 *   D15 (PB8, I2C1_SCL), D14 (PB9, I2C1_SDA) at 100 kHz, shared by
 *     SSD1306 128×64 OLED  0x3C   display
 *     DS3231 RTC           0x68   date and time (BCD registers)
 *     AHT20                0x38   temperature and humidity
 *   Each module has its own pull-ups on SCL/SDA and runs from 3V3.
 *
 *   B1 (PC13)  set the seconds to 00 (writes the RTC)
 *
 * Once a second the time and readings are drawn on the OLED and printed
 * on the virtual COM port.
 */
#include <stdio.h>
#include <string.h>
#include "main.h"

#define OLED_ADDR (0x3C << 1)
#define RTC_ADDR  (0x68 << 1)
#define AHT_ADDR  (0x38 << 1)

UART_HandleTypeDef huart2;
I2C_HandleTypeDef hi2c1;

extern const uint8_t font5x7[95][5];
static uint8_t fb[8][128]; /* the display, page by page */

static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);
static void MX_I2C1_Init(void);

/* ---------------------------------------------------------- SSD1306 */

static void oled_cmds(const uint8_t *cmds, uint16_t n)
{
  uint8_t buf[32];
  buf[0] = 0x00; /* control byte: commands follow */
  memcpy(buf + 1, cmds, n);
  if (HAL_I2C_Master_Transmit(&hi2c1, OLED_ADDR, buf, n + 1, 100) != HAL_OK)
  {
    Error_Handler();
  }
}

static void oled_init(void)
{
  static const uint8_t init[] = {
    0xAE,       /* display off */
    0xD5, 0x80, /* clock divide */
    0xA8, 0x3F, /* multiplex: 64 rows */
    0xD3, 0x00, /* display offset */
    0x40,       /* start line 0 */
    0x8D, 0x14, /* charge pump on */
    0x20, 0x00, /* horizontal addressing */
    0xA1,       /* segment remap: column 127 = SEG0 */
    0xC8,       /* COM scan from the bottom */
    0xDA, 0x12, /* COM pins */
    0x81, 0xCF, /* contrast */
    0xD9, 0xF1, /* pre-charge */
    0xDB, 0x40, /* VCOMH */
    0xA4,       /* show RAM */
    0xA6,       /* normal (not inverted) */
    0xAF,       /* display on */
  };
  oled_cmds(init, sizeof init);
}

/* Send the whole frame buffer. */
static void oled_flush(void)
{
  static const uint8_t window[] = {0x21, 0, 127, 0x22, 0, 7};
  oled_cmds(window, sizeof window);
  uint8_t buf[17];
  buf[0] = 0x40; /* control byte: data follows */
  for (int i = 0; i < 1024; i += 16)
  {
    memcpy(buf + 1, &fb[0][0] + i, 16);
    if (HAL_I2C_Master_Transmit(&hi2c1, OLED_ADDR, buf, sizeof buf, 100) != HAL_OK)
    {
      Error_Handler();
    }
  }
}

static void pixel(int x, int y)
{
  if (x >= 0 && x < 128 && y >= 0 && y < 64)
  {
    fb[y / 8][x] |= 1 << (y % 8);
  }
}

/* Text at (x, y), each font pixel drawn as scale × scale. */
static void text(int x, int y, const char *s, int scale)
{
  for (; *s; s++, x += 6 * scale)
  {
    char c = (*s < 0x20 || *s > 0x7E) ? '?' : *s;
    for (int col = 0; col < 5; col++)
    {
      uint8_t bits = font5x7[c - 0x20][col];
      for (int row = 0; row < 7; row++)
      {
        if (bits & (1 << row))
        {
          for (int dx = 0; dx < scale; dx++)
            for (int dy = 0; dy < scale; dy++)
              pixel(x + col * scale + dx, y + row * scale + dy);
        }
      }
    }
  }
}

/* ----------------------------------------------------------- DS3231 */

typedef struct
{
  int year, month, day, hour, min, sec;
} DateTime;

static int bcd(uint8_t b) { return (b >> 4) * 10 + (b & 0x0F); }

static HAL_StatusTypeDef rtc_read(DateTime *t)
{
  uint8_t r[7];
  HAL_StatusTypeDef st = HAL_I2C_Mem_Read(&hi2c1, RTC_ADDR, 0x00, I2C_MEMADD_SIZE_8BIT, r, 7, 100);
  if (st == HAL_OK)
  {
    t->sec = bcd(r[0] & 0x7F);
    t->min = bcd(r[1] & 0x7F);
    t->hour = bcd(r[2] & 0x3F);
    t->day = bcd(r[4] & 0x3F);
    t->month = bcd(r[5] & 0x1F);
    t->year = 2000 + bcd(r[6]) + ((r[5] & 0x80) ? 100 : 0);
  }
  return st;
}

/* ------------------------------------------------------------ AHT20 */

/* Temperature in 0.1 °C and humidity in 0.1 %RH. */
static HAL_StatusTypeDef aht_read(int *t10, int *h10)
{
  uint8_t trigger[3] = {0xAC, 0x33, 0x00};
  uint8_t d[7];
  HAL_StatusTypeDef st = HAL_I2C_Master_Transmit(&hi2c1, AHT_ADDR, trigger, 3, 100);
  if (st != HAL_OK)
  {
    return st;
  }
  HAL_Delay(80); /* measurement time */
  do
  {
    st = HAL_I2C_Master_Receive(&hi2c1, AHT_ADDR, d, 7, 100);
  } while (st == HAL_OK && (d[0] & 0x80)); /* busy */
  if (st == HAL_OK)
  {
    uint32_t h = ((uint32_t)d[1] << 12) | ((uint32_t)d[2] << 4) | (d[3] >> 4);
    uint32_t t = ((uint32_t)(d[3] & 0x0F) << 16) | ((uint32_t)d[4] << 8) | d[5];
    *h10 = (int)((h * 1000ULL + (1 << 19)) >> 20); /* rounded */
    *t10 = (int)((t * 2000ULL + (1 << 19)) >> 20) - 500;
  }
  return st;
}

/* ------------------------------------------------------------- main */

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  MX_I2C1_Init();
  printf("I2C clock: SSD1306 0x3C, DS3231 0x68, AHT20 0x38 on D15/D14\r\n");

  /* Who answers on the bus? */
  printf("scan:");
  for (uint16_t a = 1; a < 128; a++)
  {
    if (HAL_I2C_IsDeviceReady(&hi2c1, a << 1, 1, 10) == HAL_OK)
    {
      printf(" 0x%02X", a);
    }
  }
  printf("\r\n");

  oled_init();
  uint8_t aht_init[3] = {0xBE, 0x08, 0x00}; /* calibrate */
  HAL_Delay(40);
  HAL_I2C_Master_Transmit(&hi2c1, AHT_ADDR, aht_init, 3, 100);

  int last_sec = -1;
  while (1)
  {
    if (HAL_GPIO_ReadPin(B1_GPIO_Port, B1_Pin) == GPIO_PIN_RESET)
    {
      uint8_t zero = 0x00;
      HAL_I2C_Mem_Write(&hi2c1, RTC_ADDR, 0x00, I2C_MEMADD_SIZE_8BIT, &zero, 1, 100);
      printf("seconds set to 00\r\n");
      while (HAL_GPIO_ReadPin(B1_GPIO_Port, B1_Pin) == GPIO_PIN_RESET)
      {
        HAL_Delay(10);
      }
    }

    DateTime now;
    if (rtc_read(&now) != HAL_OK)
    {
      printf("RTC not answering\r\n");
      HAL_Delay(1000);
      continue;
    }
    if (now.sec == last_sec)
    {
      HAL_Delay(50);
      continue;
    }
    last_sec = now.sec;

    int t10 = 0, h10 = 0;
    int ok = aht_read(&t10, &h10) == HAL_OK;

    char line[32];
    memset(fb, 0, sizeof fb);
    snprintf(line, sizeof line, "%04d-%02d-%02d", now.year, now.month, now.day);
    text(34, 0, line, 1);
    snprintf(line, sizeof line, "%02d:%02d:%02d", now.hour, now.min, now.sec);
    text(16, 14, line, 2);
    if (ok)
    {
      snprintf(line, sizeof line, "%d.%d C", t10 / 10, (t10 < 0 ? -t10 : t10) % 10);
      text(4, 40, line, 1);
      snprintf(line, sizeof line, "%d.%d %%RH", h10 / 10, h10 % 10);
      text(70, 40, line, 1);
    }
    else
    {
      text(4, 40, "AHT20 missing", 1);
    }
    text(4, 54, "Simucleo I2C", 1);
    oled_flush();

    printf("%04d-%02d-%02d %02d:%02d:%02d", now.year, now.month, now.day, now.hour, now.min, now.sec);
    if (ok)
    {
      printf(" | %d.%d C %d.%d %%RH", t10 / 10, (t10 < 0 ? -t10 : t10) % 10, h10 / 10, h10 % 10);
    }
    printf("\r\n");
  }
}

static void MX_I2C1_Init(void)
{
  hi2c1.Instance = I2C1;
  hi2c1.Init.ClockSpeed = 100000;
  hi2c1.Init.DutyCycle = I2C_DUTYCYCLE_2;
  hi2c1.Init.OwnAddress1 = 0;
  hi2c1.Init.AddressingMode = I2C_ADDRESSINGMODE_7BIT;
  hi2c1.Init.DualAddressMode = I2C_DUALADDRESS_DISABLE;
  hi2c1.Init.OwnAddress2 = 0;
  hi2c1.Init.GeneralCallMode = I2C_GENERALCALL_DISABLE;
  hi2c1.Init.NoStretchMode = I2C_NOSTRETCH_DISABLE;
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
    /* PB8 = D15 = I2C1_SCL, PB9 = D14 = I2C1_SDA (open drain; the
       modules provide the pull-ups) */
    GPIO_InitStruct.Pin = GPIO_PIN_8 | GPIO_PIN_9;
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
  __HAL_RCC_GPIOC_CLK_ENABLE();
  GPIO_InitStruct.Pin = B1_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_INPUT;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
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
