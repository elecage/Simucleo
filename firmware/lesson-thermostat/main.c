/*
 * Lesson "프로젝트: 스마트 온도조절기" (G. 프로젝트): a heater thermostat.
 *
 *   D15 (PB8, I2C1_SCL), D14 (PB9, I2C1_SDA) at 100 kHz, shared by
 *     AHT20         0x38   temperature (and humidity)
 *     SSD1306 OLED  0x3C   shows the temperature, set point and heater
 *   D7 (PA8)   relay module IN (active low: 0 energises the coil)
 *   5V, GND    relay VCC and GND; 5V also to COM
 *   NO → 330 Ω → LED → GND: the "heater" lamp, lit while the relay is on
 *   B1 (PC13)  next set point: 20 → 22 → 24 → 20 °C
 *   LD2 (PA5)  mirrors the heater
 *
 * Two-point control with hysteresis: the heater goes on below set − 1 °C
 * and off above set + 1 °C; in between it keeps its state, so the relay
 * does not chatter around the set point. Once a second the reading and
 * the decision go to the OLED and the virtual COM port (USART2, 115200).
 */
#include <stdio.h>
#include <string.h>
#include "main.h"

#define OLED_ADDR (0x3C << 1)
#define AHT_ADDR (0x38 << 1)
#define RELAY_Pin GPIO_PIN_8 /* D7 */
#define RELAY_GPIO_Port GPIOA
#define HYSTERESIS10 10 /* 1.0 °C */

UART_HandleTypeDef huart2;
I2C_HandleTypeDef hi2c1;

extern const uint8_t font5x7[95][5];
static uint8_t fb[8][128];

static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);
static void MX_I2C1_Init(void);

/* ---------------------------------------------------------- SSD1306 */

static int oled_ok = 1;

static void oled_cmds(const uint8_t *cmds, uint16_t n)
{
  uint8_t buf[32];
  buf[0] = 0x00; /* control byte: commands follow */
  memcpy(buf + 1, cmds, n);
  if (HAL_I2C_Master_Transmit(&hi2c1, OLED_ADDR, buf, n + 1, 100) != HAL_OK)
  {
    oled_ok = 0;
  }
}

static void oled_init(void)
{
  static const uint8_t init[] = {0xAE, 0xD5, 0x80, 0xA8, 0x3F, 0xD3, 0x00, 0x40, 0x8D, 0x14, 0x20, 0x00,
                                 0xA1, 0xC8, 0xDA, 0x12, 0x81, 0xCF, 0xD9, 0xF1, 0xDB, 0x40, 0xA4, 0xA6, 0xAF};
  oled_cmds(init, sizeof init);
}

static void oled_flush(void)
{
  static const uint8_t window[] = {0x21, 0, 127, 0x22, 0, 7};
  oled_cmds(window, sizeof window);
  uint8_t buf[17];
  buf[0] = 0x40; /* control byte: data follows */
  for (int i = 0; i < 1024 && oled_ok; i += 16)
  {
    memcpy(buf + 1, &fb[0][0] + i, 16);
    if (HAL_I2C_Master_Transmit(&hi2c1, OLED_ADDR, buf, sizeof buf, 100) != HAL_OK)
    {
      oled_ok = 0;
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

/* ------------------------------------------------------------ AHT20 */

static HAL_StatusTypeDef aht_read(int *t10)
{
  uint8_t trigger[3] = {0xAC, 0x33, 0x00};
  uint8_t d[7];
  HAL_StatusTypeDef st = HAL_I2C_Master_Transmit(&hi2c1, AHT_ADDR, trigger, 3, 100);
  if (st != HAL_OK)
  {
    return st;
  }
  HAL_Delay(80);
  do
  {
    st = HAL_I2C_Master_Receive(&hi2c1, AHT_ADDR, d, 7, 100);
  } while (st == HAL_OK && (d[0] & 0x80));
  if (st == HAL_OK)
  {
    uint32_t t = ((uint32_t)(d[3] & 0x0F) << 16) | ((uint32_t)d[4] << 8) | d[5];
    *t10 = (int)((t * 2000ULL + (1 << 19)) >> 20) - 500;
  }
  return st;
}

/* ------------------------------------------------------------- main */

static void heater(int on)
{
  /* Active-low module: 0 energises the coil and closes COM–NO. */
  HAL_GPIO_WritePin(RELAY_GPIO_Port, RELAY_Pin, on ? GPIO_PIN_RESET : GPIO_PIN_SET);
  HAL_GPIO_WritePin(LD2_GPIO_Port, LD2_Pin, on ? GPIO_PIN_SET : GPIO_PIN_RESET);
}

static void fmt10(char *out, size_t n, int v10)
{
  snprintf(out, n, "%s%d.%d", v10 < 0 ? "-" : "", (v10 < 0 ? -v10 : v10) / 10, (v10 < 0 ? -v10 : v10) % 10);
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  MX_I2C1_Init();
  printf("Thermostat: AHT20 + OLED on I2C1, relay on D7, B1 = set point\r\n");

  oled_init();
  uint8_t aht_init[3] = {0xBE, 0x08, 0x00};
  HAL_Delay(40);
  HAL_I2C_Master_Transmit(&hi2c1, AHT_ADDR, aht_init, 3, 100);

  static const int SETPOINTS[] = {20, 22, 24};
  int sp = 1, heating = 0, b1_was = 0;
  heater(0);
  uint32_t last = HAL_GetTick() - 1000;
  while (1)
  {
    int b1 = HAL_GPIO_ReadPin(B1_GPIO_Port, B1_Pin) == GPIO_PIN_RESET;
    if (b1 && !b1_was)
    {
      sp = (sp + 1) % 3;
      printf("set point %d C\r\n", SETPOINTS[sp]);
      last = HAL_GetTick() - 1000; /* decide again now */
    }
    b1_was = b1;

    if (HAL_GetTick() - last >= 1000)
    {
      last = HAL_GetTick();
      int t10;
      char t[12], line[24];
      memset(fb, 0, sizeof fb);
      if (aht_read(&t10) != HAL_OK)
      {
        heater(0); /* fail safe: no reading, no heat */
        heating = 0;
        printf("sensor not answering - heater OFF\r\n");
        text(4, 20, "NO SENSOR", 2);
      }
      else
      {
        int set10 = SETPOINTS[sp] * 10;
        if (t10 < set10 - HYSTERESIS10)
        {
          heating = 1;
        }
        else if (t10 > set10 + HYSTERESIS10)
        {
          heating = 0;
        }
        heater(heating);
        fmt10(t, sizeof t, t10);
        printf("T %s C  set %d C  heater %s\r\n", t, SETPOINTS[sp], heating ? "ON" : "OFF");
        snprintf(line, sizeof line, "%s C", t);
        text(4, 4, line, 3);
        snprintf(line, sizeof line, "SET %d C", SETPOINTS[sp]);
        text(4, 36, line, 1);
        text(4, 50, heating ? "HEAT ON" : "HEAT OFF", 2);
      }
      oled_flush();
    }
    HAL_Delay(20);
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
    GPIO_InitStruct.Pin = GPIO_PIN_8 | GPIO_PIN_9; /* SCL D15, SDA D14 */
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
  __HAL_RCC_GPIOC_CLK_ENABLE();
  /* Relay off (IN high) before the pin becomes an output. */
  HAL_GPIO_WritePin(RELAY_GPIO_Port, RELAY_Pin, GPIO_PIN_SET);
  HAL_GPIO_WritePin(LD2_GPIO_Port, LD2_Pin, GPIO_PIN_RESET);
  GPIO_InitStruct.Pin = RELAY_Pin | LD2_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
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
