/*
 * Lesson "여러 LED 패턴 (나이트라이더)" (A. 기초): a light running back and
 * forth over four LEDs, from a table of pins.
 *
 *   D2 (PA10), D3 (PB3), D4 (PB5), D5 (PB4)  each → 220 Ω → LED → GND
 *
 * One LED is lit at a time for STEP_MS: 0 1 2 3 2 1 0 1 …, so a whole
 * sweep is 6 steps and the two end LEDs light once per sweep (period
 * 6 × STEP_MS = 600 ms), the middle ones twice.
 */
#include <stdio.h>
#include "main.h"

#define STEP_MS 100
#define N_LEDS 4

UART_HandleTypeDef huart2;

static GPIO_TypeDef *const LED_PORT[N_LEDS] = {GPIOA, GPIOB, GPIOB, GPIOB};
static const uint16_t LED_PIN[N_LEDS] = {GPIO_PIN_10, GPIO_PIN_3, GPIO_PIN_5, GPIO_PIN_4};

static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);

static void show(int lit)
{
  for (int i = 0; i < N_LEDS; i++)
  {
    HAL_GPIO_WritePin(LED_PORT[i], LED_PIN[i], i == lit ? GPIO_PIN_SET : GPIO_PIN_RESET);
  }
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();

  printf("Knight Rider on D2 D3 D4 D5, %d ms per step\r\n", STEP_MS);
  int pos = 0, dir = 1;
  unsigned sweeps = 0;
  while (1)
  {
    show(pos);
    HAL_Delay(STEP_MS);
    if (pos + dir < 0 || pos + dir >= N_LEDS)
    {
      dir = -dir; /* bounce at the ends */
    }
    pos += dir;
    if (pos == 0)
    {
      printf("sweep %u\r\n", ++sweeps);
    }
  }
}

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};

  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();

  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  for (int i = 0; i < N_LEDS; i++)
  {
    HAL_GPIO_WritePin(LED_PORT[i], LED_PIN[i], GPIO_PIN_RESET);
    GPIO_InitStruct.Pin = LED_PIN[i];
    HAL_GPIO_Init(LED_PORT[i], &GPIO_InitStruct);
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
