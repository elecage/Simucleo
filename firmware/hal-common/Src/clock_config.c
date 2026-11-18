/*
 * SystemClock_Config() as STM32CubeMX generates it for the Nucleo-F401RE:
 * 84 MHz from the PLL, APB1 at 42 MHz.
 *
 * Build variants (EXTRA_CFLAGS):
 *   (default)            PLL fed by the internal 16 MHz HSI
 *   -DCLOCK_HSE_BYPASS   PLL fed by the 8 MHz ST-LINK MCO clock (correct HSE setup)
 *   -DCLOCK_HSE_CRYSTAL  HSE as if a crystal were fitted. On a stock Nucleo
 *                        there is none, so HSE never becomes ready,
 *                        HAL_RCC_OscConfig() times out and Error_Handler()
 *                        is called — a common CubeMX configuration mistake.
 */
#include "main.h"

void SystemClock_Config(void)
{
  RCC_OscInitTypeDef RCC_OscInitStruct = {0};
  RCC_ClkInitTypeDef RCC_ClkInitStruct = {0};

  __HAL_RCC_PWR_CLK_ENABLE();
  __HAL_PWR_VOLTAGESCALING_CONFIG(PWR_REGULATOR_VOLTAGE_SCALE2);

#if defined(CLOCK_HSE_BYPASS) || defined(CLOCK_HSE_CRYSTAL)
  RCC_OscInitStruct.OscillatorType = RCC_OSCILLATORTYPE_HSE;
#if defined(CLOCK_HSE_BYPASS)
  RCC_OscInitStruct.HSEState = RCC_HSE_BYPASS;
#else
  RCC_OscInitStruct.HSEState = RCC_HSE_ON;
#endif
  RCC_OscInitStruct.PLL.PLLState = RCC_PLL_ON;
  RCC_OscInitStruct.PLL.PLLSource = RCC_PLLSOURCE_HSE;
  RCC_OscInitStruct.PLL.PLLM = 8;
#else
  RCC_OscInitStruct.OscillatorType = RCC_OSCILLATORTYPE_HSI;
  RCC_OscInitStruct.HSIState = RCC_HSI_ON;
  RCC_OscInitStruct.HSICalibrationValue = RCC_HSICALIBRATION_DEFAULT;
  RCC_OscInitStruct.PLL.PLLState = RCC_PLL_ON;
  RCC_OscInitStruct.PLL.PLLSource = RCC_PLLSOURCE_HSI;
  RCC_OscInitStruct.PLL.PLLM = 16;
#endif
  RCC_OscInitStruct.PLL.PLLN = 336;
  RCC_OscInitStruct.PLL.PLLP = RCC_PLLP_DIV4;
  RCC_OscInitStruct.PLL.PLLQ = 7;
  if (HAL_RCC_OscConfig(&RCC_OscInitStruct) != HAL_OK)
  {
    Error_Handler();
  }

  RCC_ClkInitStruct.ClockType = RCC_CLOCKTYPE_HCLK | RCC_CLOCKTYPE_SYSCLK
                              | RCC_CLOCKTYPE_PCLK1 | RCC_CLOCKTYPE_PCLK2;
  RCC_ClkInitStruct.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;
  RCC_ClkInitStruct.AHBCLKDivider = RCC_SYSCLK_DIV1;
  RCC_ClkInitStruct.APB1CLKDivider = RCC_HCLK_DIV2;
  RCC_ClkInitStruct.APB2CLKDivider = RCC_HCLK_DIV1;

  if (HAL_RCC_ClockConfig(&RCC_ClkInitStruct, FLASH_LATENCY_2) != HAL_OK)
  {
    Error_Handler();
  }
}

void Error_Handler(void)
{
  __disable_irq();
  while (1)
  {
  }
}
