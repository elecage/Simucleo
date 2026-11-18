/* HAL time base on TIM11 (1 kHz update interrupt), as CubeMX generates it
   when SysTick is left to FreeRTOS. */
#include "main.h"

TIM_HandleTypeDef htim11;

HAL_StatusTypeDef HAL_InitTick(uint32_t TickPriority)
{
  RCC_ClkInitTypeDef clkconfig;
  uint32_t uwTimclock, uwAPB2Prescaler, uwPrescalerValue, pFLatency;

  HAL_NVIC_SetPriority(TIM1_TRG_COM_TIM11_IRQn, TickPriority, 0);
  HAL_NVIC_EnableIRQ(TIM1_TRG_COM_TIM11_IRQn);
  __HAL_RCC_TIM11_CLK_ENABLE();

  HAL_RCC_GetClockConfig(&clkconfig, &pFLatency);
  uwAPB2Prescaler = clkconfig.APB2CLKDivider;
  uwTimclock = (uwAPB2Prescaler == RCC_HCLK_DIV1) ? HAL_RCC_GetPCLK2Freq() : 2U * HAL_RCC_GetPCLK2Freq();
  /* Counter clock 1 MHz, update every 1 ms. */
  uwPrescalerValue = (uint32_t)((uwTimclock / 1000000U) - 1U);

  htim11.Instance = TIM11;
  htim11.Init.Period = (1000000U / 1000U) - 1U;
  htim11.Init.Prescaler = uwPrescalerValue;
  htim11.Init.ClockDivision = 0;
  htim11.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim11.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_DISABLE;
  if (HAL_TIM_Base_Init(&htim11) == HAL_OK)
  {
    uwTickPrio = TickPriority;
    return HAL_TIM_Base_Start_IT(&htim11);
  }
  return HAL_ERROR;
}

void HAL_SuspendTick(void)
{
  __HAL_TIM_DISABLE_IT(&htim11, TIM_IT_UPDATE);
}

void HAL_ResumeTick(void)
{
  __HAL_TIM_ENABLE_IT(&htim11, TIM_IT_UPDATE);
}

/* In a CubeMX project this callback lives in main.c. */
void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)
{
  if (htim->Instance == TIM11)
  {
    HAL_IncTick();
  }
}
