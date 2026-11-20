/*
 * Lesson "버튼 폴링" (A. 기초): read a button in the main loop.
 *
 *   D2 (PA10)  button to GND, input with the internal pull-up:
 *              released = 1 (pulled up), pressed = 0 (shorted to GND)
 *   D7 (PA8)   → 220 Ω → LED → GND: lit while the button is held
 *
 * Every 10 ms the loop reads the pin (polling). A change is reported on
 * the virtual COM port (USART2, 115200 8N1) with the number of presses.
 */
#include <stdio.h>
#include "main.h"

#define BTN_Pin GPIO_PIN_10 /* D2 */
#define BTN_GPIO_Port GPIOA
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

  printf("Polling the button on D2 every 10 ms, LED on D7\r\n");
  int was_pressed = 0;
  unsigned presses = 0;
  while (1)
  {
    /* Pull-up: the pin reads 0 while the button connects it to GND. */
    int pressed = HAL_GPIO_ReadPin(BTN_GPIO_Port, BTN_Pin) == GPIO_PIN_RESET;
    HAL_GPIO_WritePin(LED_GPIO_Port, LED_Pin, pressed ? GPIO_PIN_SET : GPIO_PIN_RESET);
    if (pressed != was_pressed)
    {
      was_pressed = pressed;
      if (pressed)
      {
        presses++;
        printf("pressed (%u)\r\n", presses);
      }
      else
      {
        printf("released\r\n");
      }
    }
    HAL_Delay(10);
  }
}

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};

  __HAL_RCC_GPIOA_CLK_ENABLE();

  HAL_GPIO_WritePin(LED_GPIO_Port, LED_Pin, GPIO_PIN_RESET);

  GPIO_InitStruct.Pin = BTN_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_INPUT;
  GPIO_InitStruct.Pull = GPIO_PULLUP;
  HAL_GPIO_Init(BTN_GPIO_Port, &GPIO_InitStruct);

  GPIO_InitStruct.Pin = LED_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(LED_GPIO_Port, &GPIO_InitStruct);
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
