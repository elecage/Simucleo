/*
 * CubeMX-style HAL example: buttons on external interrupts.
 *
 *   B1 (PC13, blue button)   EXTI13, falling edge → toggles LD2 (PA5)
 *   D2 (PA10) button to GND   EXTI10, falling edge, internal pull-up
 *                             → toggles an LED on D7 (PA8, via a resistor)
 *
 * The core sleeps in WFI between presses. Each press is reported on the
 * virtual COM port (USART2, 115200 8N1).
 */
#include <stdio.h>
#include "main.h"

#define BTN_Pin GPIO_PIN_10 /* D2 */
#define BTN_GPIO_Port GPIOA
#define LED_Pin GPIO_PIN_8 /* D7 */
#define LED_GPIO_Port GPIOA

UART_HandleTypeDef huart2;
static volatile uint32_t b1_presses, btn_presses;

static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();

  printf("Press B1 or the button on D2\r\n");
  uint32_t seen_b1 = 0, seen_btn = 0;
  while (1)
  {
    __WFI();
    if (b1_presses != seen_b1)
    {
      seen_b1 = b1_presses;
      printf("B1 pressed (%lu)\r\n", (unsigned long)seen_b1);
    }
    if (btn_presses != seen_btn)
    {
      seen_btn = btn_presses;
      printf("D2 pressed (%lu)\r\n", (unsigned long)seen_btn);
    }
  }
}

void HAL_GPIO_EXTI_Callback(uint16_t GPIO_Pin)
{
  if (GPIO_Pin == B1_Pin)
  {
    HAL_GPIO_TogglePin(LD2_GPIO_Port, LD2_Pin);
    b1_presses++;
  }
  else if (GPIO_Pin == BTN_Pin)
  {
    HAL_GPIO_TogglePin(LED_GPIO_Port, LED_Pin);
    btn_presses++;
  }
}

/* stm32f4xx_it.c in a CubeMX project */
void EXTI15_10_IRQHandler(void)
{
  HAL_GPIO_EXTI_IRQHandler(BTN_Pin);
  HAL_GPIO_EXTI_IRQHandler(B1_Pin);
}

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};

  __HAL_RCC_GPIOC_CLK_ENABLE();
  __HAL_RCC_GPIOA_CLK_ENABLE();

  HAL_GPIO_WritePin(GPIOA, LD2_Pin | LED_Pin, GPIO_PIN_RESET);

  GPIO_InitStruct.Pin = B1_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_IT_FALLING;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  HAL_GPIO_Init(B1_GPIO_Port, &GPIO_InitStruct);

  GPIO_InitStruct.Pin = BTN_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_IT_FALLING;
  GPIO_InitStruct.Pull = GPIO_PULLUP;
  HAL_GPIO_Init(BTN_GPIO_Port, &GPIO_InitStruct);

  GPIO_InitStruct.Pin = LD2_Pin | LED_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);

  HAL_NVIC_SetPriority(EXTI15_10_IRQn, 0, 0);
  HAL_NVIC_EnableIRQ(EXTI15_10_IRQn);
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
