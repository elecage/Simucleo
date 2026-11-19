/*
 * CubeMX-style HAL example: a "Knight Rider" light on eight LEDs driven by
 * a 74HC595 shift register over SPI1.
 *
 *   D13 (PA5, SPI1_SCK)   74HC595 SHCP (SRCLK, shift clock)
 *   D11 (PA7, SPI1_MOSI)  74HC595 DS (SER, serial data)
 *   D10 (PB6, GPIO)       74HC595 STCP (RCLK, latch)
 *   GND → OE (outputs always on), 3V3 → MR (no reset), VCC 3V3
 *   Q0–Q7 → 330 Ω → LED → GND
 *
 * The 595 has no chip select: every SPI byte shifts in (MSB first, so bit
 * n lands on Qn), and nothing on the outputs changes until STCP rises.
 * Then all eight outputs change at once. Q7' (serial out) could feed a
 * second 595 for 16 LEDs.
 */
#include <stdio.h>
#include "main.h"

#define LATCH_PORT GPIOB
#define LATCH_PIN GPIO_PIN_6

UART_HandleTypeDef huart2;
SPI_HandleTypeDef hspi1;

static void MX_GPIO_Init(void);
static void MX_SPI1_Init(void);
static void MX_USART2_UART_Init(void);

/* Shift one byte in and latch it onto Q0–Q7. */
static void hc595_write(uint8_t q)
{
  if (HAL_SPI_Transmit(&hspi1, &q, 1, 10) != HAL_OK)
  {
    Error_Handler();
  }
  HAL_GPIO_WritePin(LATCH_PORT, LATCH_PIN, GPIO_PIN_SET); /* rising edge: latch */
  HAL_GPIO_WritePin(LATCH_PORT, LATCH_PIN, GPIO_PIN_RESET);
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_SPI1_Init();
  MX_USART2_UART_Init();
  printf("74HC595 on SPI1 (D13 SHCP, D11 DS, D10 STCP): Knight Rider\r\n");

  hc595_write(0x00);
  int pos = 0, dir = 1;
  while (1)
  {
    uint8_t q = (uint8_t)(1u << pos);
    hc595_write(q);
    char bar[9];
    for (int i = 0; i < 8; i++)
    {
      bar[i] = (q >> i) & 1 ? '#' : '.';
    }
    bar[8] = 0;
    printf("Q0-Q7 %s  0x%02X\r\n", bar, q);
    if (pos + dir < 0 || pos + dir > 7)
    {
      dir = -dir;
    }
    pos += dir;
    HAL_Delay(80);
  }
}

/* ------------------------------------------------------- peripherals */

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef g = {0};
  __HAL_RCC_GPIOB_CLK_ENABLE();
  HAL_GPIO_WritePin(LATCH_PORT, LATCH_PIN, GPIO_PIN_RESET);
  g.Pin = LATCH_PIN;
  g.Mode = GPIO_MODE_OUTPUT_PP;
  g.Pull = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_HIGH;
  HAL_GPIO_Init(LATCH_PORT, &g);
}

static void MX_SPI1_Init(void)
{
  hspi1.Instance = SPI1;
  hspi1.Init.Mode = SPI_MODE_MASTER;
  hspi1.Init.Direction = SPI_DIRECTION_2LINES;
  hspi1.Init.DataSize = SPI_DATASIZE_8BIT;
  hspi1.Init.CLKPolarity = SPI_POLARITY_LOW; /* 595 shifts on the rising edge */
  hspi1.Init.CLKPhase = SPI_PHASE_1EDGE;
  hspi1.Init.NSS = SPI_NSS_SOFT;
  hspi1.Init.BaudRatePrescaler = SPI_BAUDRATEPRESCALER_16; /* 5.25 MHz */
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
  GPIO_InitTypeDef g = {0};
  if (hspi->Instance == SPI1)
  {
    __HAL_RCC_SPI1_CLK_ENABLE();
    __HAL_RCC_GPIOA_CLK_ENABLE();
    /* PA5 = SCK, PA7 = MOSI (the 595 has no MISO) */
    g.Pin = GPIO_PIN_5 | GPIO_PIN_7;
    g.Mode = GPIO_MODE_AF_PP;
    g.Pull = GPIO_NOPULL;
    g.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
    g.Alternate = GPIO_AF5_SPI1;
    HAL_GPIO_Init(GPIOA, &g);
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
