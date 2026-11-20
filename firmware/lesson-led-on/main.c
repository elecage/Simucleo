/*
 * Lesson "LED 켜기" (A. 기초): the first GPIO output.
 *
 *   D7 (PA8)   → 220 Ω → LED → GND: driven high once, so the LED stays lit
 *   LD2 (PA5)  the board's green LED, on as well
 *
 * Nothing changes after start-up: the pin keeps its output level until
 * the next reset. The level is reported on the virtual COM port (USART2,
 * 115200 8N1), then the core sleeps.
 */
#include <stdio.h>
#include "main.h"

#define LED_Pin GPIO_PIN_8 /* D7 */
#define LED_GPIO_Port GPIOA

UART_HandleTypeDef huart2;

static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();

  HAL_GPIO_WritePin(LED_GPIO_Port, LED_Pin, GPIO_PIN_SET);
  HAL_GPIO_WritePin(LD2_GPIO_Port, LD2_Pin, GPIO_PIN_SET);
  printf("D7 (PA8) = %d, LD2 (PA5) = %d: LEDs on\r\n",
         HAL_GPIO_ReadPin(LED_GPIO_Port, LED_Pin) == GPIO_PIN_SET,
         HAL_GPIO_ReadPin(LD2_GPIO_Port, LD2_Pin) == GPIO_PIN_SET);

  while (1)
  {
    __WFI(); /* nothing else to do: the outputs hold their level */
  }
}

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};

  __HAL_RCC_GPIOA_CLK_ENABLE();

  HAL_GPIO_WritePin(GPIOA, LED_Pin | LD2_Pin, GPIO_PIN_RESET);

  GPIO_InitStruct.Pin = LED_Pin | LD2_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);
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
