/*
 * Lesson "저전력: sleep 모드와 WFI" (F. 고급).
 *
 *   TIM2 update interrupt every 100 ms wakes the core; each wake-up
 *   toggles D7 (PA8) → 220 Ω → LED → GND (a 200 ms period).
 *   TIM5 (32 bits, 1 MHz) runs freely and times how long the core slept.
 *   B1 (PC13) switches between
 *     WFI mode:  HAL_PWR_EnterSLEEPMode(…, PWR_SLEEPENTRY_WFI) — the core
 *                stops until an interrupt (the HAL tick is suspended
 *                first, or SysTick would wake it every millisecond)
 *     busy mode: a loop polls a flag until the interrupt sets it — the
 *                core runs flat out the whole time doing nothing useful
 *
 * Once a second the share of time asleep is printed on the virtual COM
 * port (USART2, 115200 8N1).
 */
#include <stdio.h>
#include "main.h"

#define LED_Pin GPIO_PIN_8 /* D7 */
#define LED_GPIO_Port GPIOA

UART_HandleTypeDef huart2;
TIM_HandleTypeDef htim2, htim5;
static volatile int woke;

static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);
static void MX_TIM2_Init(void);
static void MX_TIM5_Init(void);

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  MX_TIM2_Init();
  MX_TIM5_Init();
  HAL_TIM_Base_Start(&htim5);
  HAL_TIM_Base_Start_IT(&htim2);
  printf("Sleep demo: TIM2 wakes the core every 100 ms; B1 switches WFI / busy-wait\r\n");

  int use_wfi = 1, b1_was = 0;
  uint32_t slept_us = 0, wakeups = 0, window_start = TIM5->CNT;
  while (1)
  {
    uint32_t t0 = TIM5->CNT;
    if (use_wfi)
    {
      HAL_SuspendTick();
      while (!woke)
      {
        HAL_PWR_EnterSLEEPMode(PWR_MAINREGULATOR_ON, PWR_SLEEPENTRY_WFI);
      }
      HAL_ResumeTick();
      slept_us += TIM5->CNT - t0;
    }
    else
    {
      while (!woke)
      {
        /* busy-wait: the core keeps running */
      }
    }
    woke = 0;
    wakeups++;

    int b1 = HAL_GPIO_ReadPin(B1_GPIO_Port, B1_Pin) == GPIO_PIN_RESET;
    if (b1 && !b1_was)
    {
      use_wfi = !use_wfi;
      printf("mode %s\r\n", use_wfi ? "WFI (sleep)" : "busy-wait");
    }
    b1_was = b1;

    uint32_t window = TIM5->CNT - window_start;
    if (window >= 1000000)
    {
      uint32_t permille = (uint32_t)((uint64_t)slept_us * 1000 / window);
      printf("%s: asleep %lu.%lu%% of %lu ms, %lu wakeups\r\n", use_wfi ? "WFI" : "busy",
             (unsigned long)(permille / 10), (unsigned long)(permille % 10), (unsigned long)(window / 1000),
             (unsigned long)wakeups);
      slept_us = 0;
      wakeups = 0;
      window_start = TIM5->CNT;
    }
  }
}

void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)
{
  if (htim->Instance == TIM2)
  {
    HAL_GPIO_TogglePin(LED_GPIO_Port, LED_Pin);
    woke = 1;
  }
}

void TIM2_IRQHandler(void)
{
  HAL_TIM_IRQHandler(&htim2);
}

static void MX_TIM2_Init(void)
{
  htim2.Instance = TIM2;
  htim2.Init.Prescaler = 8400 - 1; /* 10 kHz */
  htim2.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim2.Init.Period = 1000 - 1; /* 100 ms */
  htim2.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim2.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_DISABLE;
  if (HAL_TIM_Base_Init(&htim2) != HAL_OK)
  {
    Error_Handler();
  }
}

static void MX_TIM5_Init(void)
{
  htim5.Instance = TIM5;
  htim5.Init.Prescaler = 84 - 1; /* 1 MHz */
  htim5.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim5.Init.Period = 0xFFFFFFFF;
  htim5.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim5.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_DISABLE;
  if (HAL_TIM_Base_Init(&htim5) != HAL_OK)
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
  else if (htim->Instance == TIM5)
  {
    __HAL_RCC_TIM5_CLK_ENABLE();
  }
}

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};

  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOC_CLK_ENABLE();

  HAL_GPIO_WritePin(LED_GPIO_Port, LED_Pin, GPIO_PIN_RESET);
  GPIO_InitStruct.Pin = LED_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(LED_GPIO_Port, &GPIO_InitStruct);

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
