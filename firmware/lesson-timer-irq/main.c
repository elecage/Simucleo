/*
 * Lesson "타이머 인터럽트로 정확한 주기" (B. 타이머·PWM).
 *
 *   TIM2 counts at 1 MHz (84 MHz / 84) and overflows every 1000 counts:
 *   an update interrupt every 1 ms, whatever the main loop is doing.
 *
 *   D7 (PA8)   → 220 Ω → LED → GND: toggled every 50 interrupts → 100 ms period
 *   LD2 (PA5)  toggled every 500 interrupts → 1 s period
 *   D6 (PB10)  → 220 Ω → LED → GND: toggled by the main loop after
 *              HAL_Delay(50) and a printf — slower than 100 ms, because
 *              the loop's own work adds to every delay
 *
 * The main loop reports both on the virtual COM port (USART2, 115200 8N1).
 */
#include <stdio.h>
#include "main.h"

#define TIMED_Pin GPIO_PIN_8 /* D7 */
#define TIMED_GPIO_Port GPIOA
#define LOOP_Pin GPIO_PIN_10 /* D6 */
#define LOOP_GPIO_Port GPIOB

UART_HandleTypeDef huart2;
TIM_HandleTypeDef htim2;
static volatile uint32_t ticks; /* timer interrupts so far */

static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);
static void MX_TIM2_Init(void);

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  MX_TIM2_Init();
  if (HAL_TIM_Base_Start_IT(&htim2) != HAL_OK)
  {
    Error_Handler();
  }
  printf("TIM2 update interrupt every 1 ms: D7 100 ms, LD2 1 s; D6 from the main loop\r\n");

  uint32_t loops = 0;
  while (1)
  {
    HAL_GPIO_TogglePin(LOOP_GPIO_Port, LOOP_Pin);
    HAL_Delay(50);
    /* The loop's own work: the D6 period becomes 2 × (51 ms + this). */
    printf("loop %lu: tick %lu ms\r\n", (unsigned long)++loops, (unsigned long)ticks);
  }
}

/* Called from HAL_TIM_IRQHandler on every update event (1 kHz). */
void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)
{
  if (htim->Instance == TIM2)
  {
    ticks++;
    if (ticks % 50 == 0)
    {
      HAL_GPIO_TogglePin(TIMED_GPIO_Port, TIMED_Pin);
    }
    if (ticks % 500 == 0)
    {
      HAL_GPIO_TogglePin(LD2_GPIO_Port, LD2_Pin);
    }
  }
}

/* stm32f4xx_it.c in a CubeMX project */
void TIM2_IRQHandler(void)
{
  HAL_TIM_IRQHandler(&htim2);
}

static void MX_TIM2_Init(void)
{
  htim2.Instance = TIM2;
  htim2.Init.Prescaler = 84 - 1; /* 84 MHz / 84 = 1 MHz */
  htim2.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim2.Init.Period = 1000 - 1; /* 1000 counts = 1 ms */
  htim2.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim2.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_DISABLE;
  if (HAL_TIM_Base_Init(&htim2) != HAL_OK)
  {
    Error_Handler();
  }
}

void HAL_TIM_Base_MspInit(TIM_HandleTypeDef *htim)
{
  if (htim->Instance == TIM2)
  {
    __HAL_RCC_TIM2_CLK_ENABLE();
    HAL_NVIC_SetPriority(TIM2_IRQn, 1, 0);
    HAL_NVIC_EnableIRQ(TIM2_IRQn);
  }
}

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};

  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();

  HAL_GPIO_WritePin(GPIOA, TIMED_Pin | LD2_Pin, GPIO_PIN_RESET);
  HAL_GPIO_WritePin(LOOP_GPIO_Port, LOOP_Pin, GPIO_PIN_RESET);

  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  GPIO_InitStruct.Pin = TIMED_Pin | LD2_Pin;
  HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);
  GPIO_InitStruct.Pin = LOOP_Pin;
  HAL_GPIO_Init(LOOP_GPIO_Port, &GPIO_InitStruct);
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
