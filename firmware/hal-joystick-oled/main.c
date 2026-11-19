/*
 * CubeMX-style HAL example: a KY-023 joystick read with ADC1 moves a dot
 * on an SSD1306 OLED; pressing the stick fills the dot.
 *
 *   A0 (PA0, ADC1_IN0)  joystick VRx
 *   A1 (PA1, ADC1_IN1)  joystick VRy
 *   D4 (PB5)            joystick SW (to GND when pressed; internal pull-up)
 *   3V3, GND            joystick +5V and GND — at 3.3 V the pots span the
 *                       ADC range (5 V would overdrive PA0/PA1)
 *   D15 (PB8), D14 (PB9) I2C1 → SSD1306 at 0x3C, VCC 3V3
 *
 * Every 40 ms both channels are converted one after the other (software
 * start, polling) and the dot is drawn where the stick points: VRx 0 V is
 * the left edge, VRy 3.3 V the top. X, Y and SW are printed when they
 * change noticeably.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "main.h"

#define OLED_ADDR (0x3C << 1)
#define SW_PORT GPIOB
#define SW_PIN GPIO_PIN_5

UART_HandleTypeDef huart2;
I2C_HandleTypeDef hi2c1;
ADC_HandleTypeDef hadc1;

extern const uint8_t font5x7[95][5];
static uint8_t fb[8][128];

static void MX_GPIO_Init(void);
static void MX_ADC1_Init(void);
static void MX_I2C1_Init(void);
static void MX_USART2_UART_Init(void);

/* ---------------------------------------------------------- SSD1306 */

static void oled_cmds(const uint8_t *cmds, uint16_t n)
{
  uint8_t buf[32];
  buf[0] = 0x00;
  memcpy(buf + 1, cmds, n);
  HAL_I2C_Master_Transmit(&hi2c1, OLED_ADDR, buf, n + 1, 100);
}

static void oled_init(void)
{
  static const uint8_t init[] = {
    0xAE, 0xD5, 0x80, 0xA8, 0x3F, 0xD3, 0x00, 0x40, 0x8D, 0x14, 0x20, 0x00,
    0xA1, 0xC8, 0xDA, 0x12, 0x81, 0xCF, 0xD9, 0xF1, 0xDB, 0x40, 0xA4, 0xA6, 0xAF,
  };
  oled_cmds(init, sizeof init);
}

static void oled_flush(void)
{
  static const uint8_t window[] = {0x21, 0, 127, 0x22, 0, 7};
  oled_cmds(window, sizeof window);
  uint8_t buf[17];
  buf[0] = 0x40;
  for (int i = 0; i < 1024; i += 16)
  {
    memcpy(buf + 1, &fb[0][0] + i, 16);
    HAL_I2C_Master_Transmit(&hi2c1, OLED_ADDR, buf, sizeof buf, 100);
  }
}

static void pixel(int x, int y)
{
  if (x >= 0 && x < 128 && y >= 0 && y < 64)
  {
    fb[y / 8][x] |= 1 << (y % 8);
  }
}

static void text(int x, int y, const char *s)
{
  for (; *s; s++, x += 6)
  {
    char c = (*s < 0x20 || *s > 0x7E) ? '?' : *s;
    for (int col = 0; col < 5; col++)
    {
      uint8_t bits = font5x7[c - 0x20][col];
      for (int row = 0; row < 7; row++)
      {
        if (bits & (1 << row))
        {
          pixel(x + col, y + row);
        }
      }
    }
  }
}

/* A ring of radius 3 (filled when `fill`). */
static void dot(int cx, int cy, int fill)
{
  for (int dy = -3; dy <= 3; dy++)
  {
    for (int dx = -3; dx <= 3; dx++)
    {
      int d = dx * dx + dy * dy;
      if (d <= 10 && (fill || d >= 5))
      {
        pixel(cx + dx, cy + dy);
      }
    }
  }
}

/* -------------------------------------------------------------- ADC */

static uint32_t read_adc(uint32_t channel)
{
  ADC_ChannelConfTypeDef c = {0};
  c.Channel = channel;
  c.Rank = 1;
  c.SamplingTime = ADC_SAMPLETIME_84CYCLES;
  HAL_ADC_ConfigChannel(&hadc1, &c);
  HAL_ADC_Start(&hadc1);
  HAL_ADC_PollForConversion(&hadc1, 10);
  uint32_t v = HAL_ADC_GetValue(&hadc1);
  HAL_ADC_Stop(&hadc1);
  return v;
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_ADC1_Init();
  MX_I2C1_Init();
  MX_USART2_UART_Init();
  printf("KY-023 joystick: VRx A0, VRy A1, SW D4; SSD1306 on I2C1\r\n");
  oled_init();

  int px = -1000, py = -1000, psw = -1;
  while (1)
  {
    int x = (int)read_adc(ADC_CHANNEL_0);
    int y = (int)read_adc(ADC_CHANNEL_1);
    int sw = HAL_GPIO_ReadPin(SW_PORT, SW_PIN) == GPIO_PIN_RESET;

    /* 0–4095 → screen: X left to right, Y bottom to top. */
    int sx = 4 + x * 119 / 4095;
    int sy = 59 - y * 51 / 4095;
    memset(fb, 0, sizeof fb);
    char line[24];
    snprintf(line, sizeof line, "X%4d Y%4d%s", x, y, sw ? " SW" : "");
    text(0, 0, line);
    for (int i = 8; i < 64; i += 4)
    {
      pixel(64, i); /* centre cross */
    }
    for (int i = 0; i < 128; i += 4)
    {
      pixel(i, 34);
    }
    dot(sx, sy, sw);
    oled_flush();

    if (abs(x - px) > 40 || abs(y - py) > 40 || sw != psw)
    {
      printf("X %4d  Y %4d  SW %d\r\n", x, y, sw);
      px = x, py = y, psw = sw;
    }
    HAL_Delay(40);
  }
}

/* ------------------------------------------------------- peripherals */

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef g = {0};
  __HAL_RCC_GPIOB_CLK_ENABLE();
  g.Pin = SW_PIN;
  g.Mode = GPIO_MODE_INPUT;
  g.Pull = GPIO_PULLUP; /* the module has no pull-up on SW */
  HAL_GPIO_Init(SW_PORT, &g);
}

static void MX_ADC1_Init(void)
{
  hadc1.Instance = ADC1;
  hadc1.Init.ClockPrescaler = ADC_CLOCK_SYNC_PCLK_DIV4;
  hadc1.Init.Resolution = ADC_RESOLUTION_12B;
  hadc1.Init.ScanConvMode = DISABLE;
  hadc1.Init.ContinuousConvMode = DISABLE;
  hadc1.Init.DiscontinuousConvMode = DISABLE;
  hadc1.Init.ExternalTrigConvEdge = ADC_EXTERNALTRIGCONVEDGE_NONE;
  hadc1.Init.ExternalTrigConv = ADC_SOFTWARE_START;
  hadc1.Init.DataAlign = ADC_DATAALIGN_RIGHT;
  hadc1.Init.NbrOfConversion = 1;
  hadc1.Init.DMAContinuousRequests = DISABLE;
  hadc1.Init.EOCSelection = ADC_EOC_SINGLE_CONV;
  if (HAL_ADC_Init(&hadc1) != HAL_OK)
  {
    Error_Handler();
  }
}

void HAL_ADC_MspInit(ADC_HandleTypeDef *hadc)
{
  GPIO_InitTypeDef g = {0};
  if (hadc->Instance == ADC1)
  {
    __HAL_RCC_ADC1_CLK_ENABLE();
    __HAL_RCC_GPIOA_CLK_ENABLE();
    g.Pin = GPIO_PIN_0 | GPIO_PIN_1;
    g.Mode = GPIO_MODE_ANALOG;
    g.Pull = GPIO_NOPULL;
    HAL_GPIO_Init(GPIOA, &g);
  }
}

static void MX_I2C1_Init(void)
{
  hi2c1.Instance = I2C1;
  hi2c1.Init.ClockSpeed = 400000;
  hi2c1.Init.DutyCycle = I2C_DUTYCYCLE_2;
  hi2c1.Init.AddressingMode = I2C_ADDRESSINGMODE_7BIT;
  if (HAL_I2C_Init(&hi2c1) != HAL_OK)
  {
    Error_Handler();
  }
}

void HAL_I2C_MspInit(I2C_HandleTypeDef *hi2c)
{
  GPIO_InitTypeDef g = {0};
  if (hi2c->Instance == I2C1)
  {
    __HAL_RCC_GPIOB_CLK_ENABLE();
    g.Pin = GPIO_PIN_8 | GPIO_PIN_9;
    g.Mode = GPIO_MODE_AF_OD;
    g.Pull = GPIO_NOPULL;
    g.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
    g.Alternate = GPIO_AF4_I2C1;
    HAL_GPIO_Init(GPIOB, &g);
    __HAL_RCC_I2C1_CLK_ENABLE();
  }
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
