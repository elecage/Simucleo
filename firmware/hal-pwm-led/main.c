/*
 * CubeMX-style HAL example: PWM brightness.
 *
 *   LD2 (PA5, TIM2_CH1)   breathes (1 kHz PWM, duty ramps up and down)
 *   RGB LED, common cathode to GND, each colour through a resistor:
 *     R on D3 (PB3,  TIM2_CH2)
 *     G on D5 (PB4,  TIM3_CH1)
 *     B on D6 (PB10, TIM2_CH3)
 *   cycles through the colour wheel.
 *
 * TIM2 and TIM3 count at 1 MHz (84 MHz / 84), period 1000 → 1 kHz.
 */
#include <stdio.h>
#include "main.h"

#define PERIOD 1000

UART_HandleTypeDef huart2;
TIM_HandleTypeDef htim2, htim3;

static void MX_TIM_Init(TIM_HandleTypeDef *htim, TIM_TypeDef *instance, int channels);
static void MX_USART2_UART_Init(void);
void HAL_TIM_MspPostInit(TIM_HandleTypeDef *htim);

/* Duty (0..PERIOD) of one colour at position `pos` (0..1535) of the wheel. */
static uint32_t wheel(int pos)
{
  pos %= 1536;
  if (pos < 256) return pos * PERIOD / 255;
  if (pos < 768) return PERIOD;
  if (pos < 1024) return (1023 - pos) * PERIOD / 255;
  return 0;
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_USART2_UART_Init();
  MX_TIM_Init(&htim2, TIM2, 3);
  MX_TIM_Init(&htim3, TIM3, 1);

  HAL_TIM_PWM_Start(&htim2, TIM_CHANNEL_1);
  HAL_TIM_PWM_Start(&htim2, TIM_CHANNEL_2);
  HAL_TIM_PWM_Start(&htim2, TIM_CHANNEL_3);
  HAL_TIM_PWM_Start(&htim3, TIM_CHANNEL_1);
  printf("PWM: LD2 breathing, RGB LED on D3/D5/D6\r\n");

  int step = 0;
  while (1)
  {
    /* LD2: triangle 0 → 100 % → 0 over 2 s */
    int t = step % 200;
    uint32_t duty = (t < 100 ? t : 200 - t) * PERIOD / 100;
    __HAL_TIM_SET_COMPARE(&htim2, TIM_CHANNEL_1, duty);

    int pos = step * 8;
    __HAL_TIM_SET_COMPARE(&htim2, TIM_CHANNEL_2, wheel(pos + 512));  /* R */
    __HAL_TIM_SET_COMPARE(&htim3, TIM_CHANNEL_1, wheel(pos));        /* G */
    __HAL_TIM_SET_COMPARE(&htim2, TIM_CHANNEL_3, wheel(pos + 1024)); /* B */

    step++;
    HAL_Delay(10);
  }
}

static void MX_TIM_Init(TIM_HandleTypeDef *htim, TIM_TypeDef *instance, int channels)
{
  TIM_OC_InitTypeDef sConfigOC = {0};
  static const uint32_t ch[] = {TIM_CHANNEL_1, TIM_CHANNEL_2, TIM_CHANNEL_3};

  htim->Instance = instance;
  htim->Init.Prescaler = 84 - 1;
  htim->Init.CounterMode = TIM_COUNTERMODE_UP;
  htim->Init.Period = PERIOD - 1;
  htim->Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim->Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_ENABLE;
  if (HAL_TIM_PWM_Init(htim) != HAL_OK)
  {
    Error_Handler();
  }
  sConfigOC.OCMode = TIM_OCMODE_PWM1;
  sConfigOC.Pulse = 0;
  sConfigOC.OCPolarity = TIM_OCPOLARITY_HIGH;
  sConfigOC.OCFastMode = TIM_OCFAST_DISABLE;
  for (int i = 0; i < channels; i++)
  {
    if (HAL_TIM_PWM_ConfigChannel(htim, &sConfigOC, ch[i]) != HAL_OK)
    {
      Error_Handler();
    }
  }
  HAL_TIM_MspPostInit(htim);
}

/* stm32f4xx_hal_msp.c in a CubeMX project */
void HAL_TIM_PWM_MspInit(TIM_HandleTypeDef *htim)
{
  if (htim->Instance == TIM2)
  {
    __HAL_RCC_TIM2_CLK_ENABLE();
  }
  else if (htim->Instance == TIM3)
  {
    __HAL_RCC_TIM3_CLK_ENABLE();
  }
}

void HAL_TIM_MspPostInit(TIM_HandleTypeDef *htim)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};
  GPIO_InitStruct.Mode = GPIO_MODE_AF_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  if (htim->Instance == TIM2)
  {
    __HAL_RCC_GPIOA_CLK_ENABLE();
    __HAL_RCC_GPIOB_CLK_ENABLE();
    GPIO_InitStruct.Alternate = GPIO_AF1_TIM2;
    GPIO_InitStruct.Pin = LD2_Pin;                /* PA5 → TIM2_CH1 */
    HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);
    GPIO_InitStruct.Pin = GPIO_PIN_3 | GPIO_PIN_10; /* PB3 → CH2, PB10 → CH3 */
    HAL_GPIO_Init(GPIOB, &GPIO_InitStruct);
  }
  else if (htim->Instance == TIM3)
  {
    __HAL_RCC_GPIOB_CLK_ENABLE();
    GPIO_InitStruct.Alternate = GPIO_AF2_TIM3;
    GPIO_InitStruct.Pin = GPIO_PIN_4;             /* PB4 → TIM3_CH1 */
    HAL_GPIO_Init(GPIOB, &GPIO_InitStruct);
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
