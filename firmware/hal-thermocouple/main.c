/*
 * CubeMX-style HAL example: two K-type thermocouple amplifiers on one SPI
 * bus, read only — a MAX6675 (16-bit word) and a MAX31855K (32 bits).
 *
 *   D13 (PA5, SPI1_SCK)  → MAX6675 SCK, MAX31855 CLK
 *   D12 (PA6, SPI1_MISO) ← MAX6675 SO,  MAX31855 DO
 *   D10 (PB6)            → MAX6675 CS
 *   D9  (PC7)            → MAX31855 CS
 *   D7  (PA8)            → "heater" LED (through 220 Ω)
 *
 * SPI1 is a receive-only master (2 lines, RXONLY: no MOSI), 16-bit frames,
 * CPOL 0 / CPHA 0, 84 MHz / 32 = 2.625 MHz (the MAX6675 allows 4.3 MHz,
 * the MAX31855 5 MHz). Pulling CS low stops a conversion (MAX6675 220 ms,
 * MAX31855 100 ms), so they are read every 250 ms. B1 switches between
 * hardware SPI and bit-banging the same pins as GPIO.
 *
 * MAX6675:  D15 0, D14–D3 temperature (0.25 °C), D2 thermocouple open.
 * MAX31855: D31–D18 hot junction (signed, 0.25 °C), D16 fault,
 *           D15–D4 cold junction (signed, 0.0625 °C), D2 SCV, D1 SCG, D0 OC.
 *
 * The heater LED keeps the MAX31855's probe between 100 and 105 °C (on
 * below 100, off above 105): hysteresis, so it does not chatter. With a
 * faulty probe it is switched off.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "main.h"

UART_HandleTypeDef huart2;
SPI_HandleTypeDef hspi1;

#define CS6675_PORT GPIOB
#define CS6675_PIN GPIO_PIN_6
#define CS31855_PORT GPIOC
#define CS31855_PIN GPIO_PIN_7
#define HEATER_PORT GPIOA
#define HEATER_PIN GPIO_PIN_8

#define HEAT_ON_BELOW 400  /* 100.00 °C in quarter degrees */
#define HEAT_OFF_ABOVE 420 /* 105.00 °C */

static void MX_GPIO_Init(void);
static void MX_SPI1_Init(void);
static void MX_USART2_UART_Init(void);

/* ----------------------------------------------- SPI pins: AF or GPIO */

static int bitbang = 0;

static void spi_pins(int gpio)
{
  GPIO_InitTypeDef g = {0};
  g.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
  g.Pull = GPIO_NOPULL;
  if (gpio)
  {
    HAL_GPIO_WritePin(GPIOA, GPIO_PIN_5, GPIO_PIN_RESET);
    g.Pin = GPIO_PIN_5;
    g.Mode = GPIO_MODE_OUTPUT_PP;
    HAL_GPIO_Init(GPIOA, &g);
    g.Pin = GPIO_PIN_6;
    g.Mode = GPIO_MODE_INPUT;
    HAL_GPIO_Init(GPIOA, &g);
  }
  else
  {
    g.Pin = GPIO_PIN_5 | GPIO_PIN_6;
    g.Mode = GPIO_MODE_AF_PP;
    g.Alternate = GPIO_AF5_SPI1;
    HAL_GPIO_Init(GPIOA, &g);
  }
}

static void short_delay(void)
{
  for (volatile int i = 0; i < 8; i++)
  {
  }
}

/* `bits` bits MSB first: SO is valid after SCK falls, sampled while high. */
static uint32_t read_word(GPIO_TypeDef *cs_port, uint16_t cs_pin, int bits)
{
  uint32_t w = 0;
  HAL_GPIO_WritePin(cs_port, cs_pin, GPIO_PIN_RESET);
  if (bitbang)
  {
    short_delay();
    for (int i = 0; i < bits; i++)
    {
      GPIOA->BSRR = GPIO_PIN_5;
      short_delay();
      w = w << 1 | ((GPIOA->IDR & GPIO_PIN_6) ? 1u : 0u);
      GPIOA->BSRR = GPIO_PIN_5 << 16;
      short_delay();
    }
  }
  else
  {
    uint16_t frames[2] = {0, 0};
    if (HAL_SPI_Receive(&hspi1, (uint8_t *)frames, (uint16_t)(bits / 16), 10) != HAL_OK)
    {
      printf("SPI receive failed\r\n");
    }
    w = frames[0];
    if (bits == 32)
    {
      w = w << 16 | frames[1];
    }
  }
  HAL_GPIO_WritePin(cs_port, cs_pin, GPIO_PIN_SET);
  return w;
}

/* "-12.25" from quarter degrees. */
static void quarters(char *buf, size_t n, int32_t q)
{
  int32_t a = labs(q);
  snprintf(buf, n, "%s%ld.%02ld", q < 0 ? "-" : "", (long)(a / 4), (long)(a % 4 * 25));
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_SPI1_Init();
  MX_USART2_UART_Init();
  printf("Thermocouples: MAX6675 (CS D10) and MAX31855K (CS D9) on SPI1 RX-only, 2.625 MHz\r\n");
  /* The first conversion after power-up takes up to 220 ms. */
  HAL_Delay(250);

  int heater = 0;
  int b1_was = 1;
  while (1)
  {
    uint32_t start = HAL_GetTick();
    int b1 = HAL_GPIO_ReadPin(GPIOC, GPIO_PIN_13) == GPIO_PIN_SET;
    if (b1_was && !b1)
    {
      bitbang = !bitbang;
      spi_pins(bitbang);
      printf("-- %s --\r\n", bitbang ? "bit-banged" : "hardware SPI");
    }
    b1_was = b1;

    char a[16], h[16], c[16];
    uint16_t k = (uint16_t)read_word(CS6675_PORT, CS6675_PIN, 16);
    if (k & 0x4)
    {
      snprintf(a, sizeof a, "OPEN");
    }
    else
    {
      quarters(a, sizeof a, k >> 3);
      snprintf(a + strlen(a), sizeof a - strlen(a), " C");
    }

    uint32_t j = read_word(CS31855_PORT, CS31855_PIN, 32);
    int32_t hot = (int32_t)j >> 18;                         /* quarter degrees */
    int32_t cold16 = (int32_t)(j << 16) >> 20;              /* sixteenths */
    int32_t cold = (int32_t)labs(cold16) * 100 / 16;        /* hundredths */
    snprintf(c, sizeof c, "%s%ld.%02ld", cold16 < 0 ? "-" : "", (long)(cold / 100), (long)(cold % 100));
    if (j & 0x10000)
    {
      const char *why = (j & 1) ? "OC (open)" : (j & 2) ? "SCG (short to GND)" : (j & 4) ? "SCV (short to VCC)" : "?";
      snprintf(h, sizeof h, "FAULT");
      heater = 0;
      printf("MAX6675 %s | MAX31855 FAULT %s (cold %s C) | heater off\r\n", a, why, c);
    }
    else
    {
      quarters(h, sizeof h, hot);
      if (hot < HEAT_ON_BELOW)
      {
        heater = 1;
      }
      else if (hot > HEAT_OFF_ABOVE)
      {
        heater = 0;
      }
      printf("MAX6675 %s | MAX31855 %s C (cold %s C) | heater %s\r\n", a, h, c, heater ? "on" : "off");
    }
    HAL_GPIO_WritePin(HEATER_PORT, HEATER_PIN, heater ? GPIO_PIN_SET : GPIO_PIN_RESET);

    while (HAL_GetTick() - start < 250)
    {
    }
  }
}

/* ------------------------------------------------------- peripherals */

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef g = {0};
  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOC_CLK_ENABLE();
  /* Chip selects idle high (deselected), the heater off. */
  HAL_GPIO_WritePin(CS6675_PORT, CS6675_PIN, GPIO_PIN_SET);
  HAL_GPIO_WritePin(CS31855_PORT, CS31855_PIN, GPIO_PIN_SET);
  HAL_GPIO_WritePin(HEATER_PORT, HEATER_PIN, GPIO_PIN_RESET);
  g.Mode = GPIO_MODE_OUTPUT_PP;
  g.Pull = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_LOW;
  g.Pin = CS6675_PIN;
  HAL_GPIO_Init(CS6675_PORT, &g);
  g.Pin = CS31855_PIN;
  HAL_GPIO_Init(CS31855_PORT, &g);
  g.Pin = HEATER_PIN;
  HAL_GPIO_Init(HEATER_PORT, &g);
  /* B1, active low (pull-up on the board). */
  g.Pin = GPIO_PIN_13;
  g.Mode = GPIO_MODE_INPUT;
  HAL_GPIO_Init(GPIOC, &g);
}

static void MX_SPI1_Init(void)
{
  hspi1.Instance = SPI1;
  hspi1.Init.Mode = SPI_MODE_MASTER;
  hspi1.Init.Direction = SPI_DIRECTION_2LINES_RXONLY; /* no MOSI */
  hspi1.Init.DataSize = SPI_DATASIZE_16BIT;
  hspi1.Init.CLKPolarity = SPI_POLARITY_LOW; /* SO changes on SCK falling edges: mode 0 */
  hspi1.Init.CLKPhase = SPI_PHASE_1EDGE;
  hspi1.Init.NSS = SPI_NSS_SOFT;
  hspi1.Init.BaudRatePrescaler = SPI_BAUDRATEPRESCALER_32; /* 2.625 MHz */
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
  if (hspi->Instance == SPI1)
  {
    __HAL_RCC_SPI1_CLK_ENABLE();
    __HAL_RCC_GPIOA_CLK_ENABLE();
    /* PA5 = SCK, PA6 = MISO; receive only, so no MOSI. */
    spi_pins(0);
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
