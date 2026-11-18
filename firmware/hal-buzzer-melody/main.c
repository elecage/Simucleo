/*
 * CubeMX-style HAL example: a melody on a passive buzzer.
 *
 *   Passive buzzer between D8 (PA9, TIM1_CH2) and GND.
 *
 * TIM1 counts at 1 MHz (84 MHz / 84). Each note sets the period to the
 * note's frequency at 50 % duty; rests disable the output. TIM1 is an
 * advanced timer, so HAL_TIM_PWM_Start also sets BDTR.MOE.
 * The current note is printed on the virtual COM port.
 */
#include <stdio.h>
#include "main.h"

UART_HandleTypeDef huart2;
TIM_HandleTypeDef htim1;

static void MX_TIM1_Init(void);
static void MX_USART2_UART_Init(void);

struct note
{
  const char *name;
  uint16_t hz; /* 0 = rest */
  uint16_t ms;
};

/* A short scale up and down, then a little tune. */
static const struct note melody[] = {
    {"C4", 262, 200}, {"D4", 294, 200}, {"E4", 330, 200}, {"F4", 349, 200},
    {"G4", 392, 200}, {"A4", 440, 200}, {"B4", 494, 200}, {"C5", 523, 400},
    {"-", 0, 200},    {"G4", 392, 200}, {"E4", 330, 200}, {"C4", 262, 400},
    {"-", 0, 600},
};

static void tone(uint16_t hz)
{
  if (hz == 0)
  {
    HAL_TIM_PWM_Stop(&htim1, TIM_CHANNEL_2);
    return;
  }
  uint32_t period = 1000000u / hz;
  __HAL_TIM_SET_AUTORELOAD(&htim1, period - 1);
  __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_2, period / 2);
  HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_2);
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_USART2_UART_Init();
  MX_TIM1_Init();

  printf("Buzzer on D8\r\n");
  while (1)
  {
    for (unsigned i = 0; i < sizeof melody / sizeof melody[0]; i++)
    {
      printf("%s ", melody[i].name);
      fflush(stdout); /* stdout is line-buffered: show each note as it plays */
      tone(melody[i].hz);
      HAL_Delay(melody[i].ms);
    }
    printf("\r\n");
  }
}

static void MX_TIM1_Init(void)
{
  TIM_OC_InitTypeDef sConfigOC = {0};
  TIM_BreakDeadTimeConfigTypeDef sBreakDeadTimeConfig = {0};

  htim1.Instance = TIM1;
  htim1.Init.Prescaler = 84 - 1;
  htim1.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim1.Init.Period = 1000 - 1;
  htim1.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim1.Init.RepetitionCounter = 0;
  htim1.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_ENABLE;
  if (HAL_TIM_PWM_Init(&htim1) != HAL_OK)
  {
    Error_Handler();
  }
  sConfigOC.OCMode = TIM_OCMODE_PWM1;
  sConfigOC.Pulse = 500;
  sConfigOC.OCPolarity = TIM_OCPOLARITY_HIGH;
  sConfigOC.OCNPolarity = TIM_OCNPOLARITY_HIGH;
  sConfigOC.OCFastMode = TIM_OCFAST_DISABLE;
  sConfigOC.OCIdleState = TIM_OCIDLESTATE_RESET;
  sConfigOC.OCNIdleState = TIM_OCNIDLESTATE_RESET;
  if (HAL_TIM_PWM_ConfigChannel(&htim1, &sConfigOC, TIM_CHANNEL_2) != HAL_OK)
  {
    Error_Handler();
  }
  sBreakDeadTimeConfig.OffStateRunMode = TIM_OSSR_DISABLE;
  sBreakDeadTimeConfig.OffStateIDLEMode = TIM_OSSI_DISABLE;
  sBreakDeadTimeConfig.LockLevel = TIM_LOCKLEVEL_OFF;
  sBreakDeadTimeConfig.DeadTime = 0;
  sBreakDeadTimeConfig.BreakState = TIM_BREAK_DISABLE;
  sBreakDeadTimeConfig.BreakPolarity = TIM_BREAKPOLARITY_HIGH;
  sBreakDeadTimeConfig.AutomaticOutput = TIM_AUTOMATICOUTPUT_DISABLE;
  if (HAL_TIMEx_ConfigBreakDeadTime(&htim1, &sBreakDeadTimeConfig) != HAL_OK)
  {
    Error_Handler();
  }

  /* HAL_TIM_MspPostInit: PA9 → TIM1_CH2 */
  GPIO_InitTypeDef GPIO_InitStruct = {0};
  __HAL_RCC_GPIOA_CLK_ENABLE();
  GPIO_InitStruct.Pin = GPIO_PIN_9;
  GPIO_InitStruct.Mode = GPIO_MODE_AF_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  GPIO_InitStruct.Alternate = GPIO_AF1_TIM1;
  HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);
}

void HAL_TIM_PWM_MspInit(TIM_HandleTypeDef *htim)
{
  if (htim->Instance == TIM1)
  {
    __HAL_RCC_TIM1_CLK_ENABLE();
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
