/*
 * CubeMX-style HAL example: a brushless motor on a hobby ESC, throttle
 * from a potentiometer.
 *
 *   D5 (PB4, TIM3_CH1)  ESC signal: a servo pulse every 20 ms (50 Hz),
 *                       1000 µs = stop … 2000 µs = full throttle
 *   GND                 ESC signal ground (the battery's −)
 *   A0 (PA0, ADC1_IN0)  potentiometer wiper (3V3 — pot — GND)
 *   11.1 V supply       + to the ESC's BAT+, − to its BAT− (3S LiPo)
 *   B1 (PC13)           signal off / on
 *
 * An ESC does not run the motor just because it gets pulses: after
 * power-up it wants at least a second of minimum throttle (1000 µs) —
 * "arming", so a motor never starts because a stick happened to be up.
 * The firmware sends 1000 µs for 2 s, then the pot's position. With the
 * signal off (B1) the ESC stops the motor after 0.5 s (failsafe) and has
 * to be armed again.
 */
#include <stdio.h>
#include "main.h"

#define PULSE_MIN 1000
#define PULSE_MAX 2000
#define ARM_MS 2000

UART_HandleTypeDef huart2;
ADC_HandleTypeDef hadc1;
TIM_HandleTypeDef htim3;

static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);
static void MX_ADC1_Init(void);
static void MX_TIM3_Init(void);

static volatile int b1_pressed;

void HAL_GPIO_EXTI_Callback(uint16_t pin)
{
  if (pin == B1_Pin)
  {
    b1_pressed = 1;
  }
}

void EXTI15_10_IRQHandler(void)
{
  HAL_GPIO_EXTI_IRQHandler(B1_Pin);
}

static uint32_t read_pot(void)
{
  HAL_ADC_Start(&hadc1);
  if (HAL_ADC_PollForConversion(&hadc1, 10) != HAL_OK)
  {
    Error_Handler();
  }
  uint32_t v = HAL_ADC_GetValue(&hadc1);
  HAL_ADC_Stop(&hadc1);
  return v;
}

/* Minimum throttle for ARM_MS: the ESC arms. */
static void arm(void)
{
  __HAL_TIM_SET_COMPARE(&htim3, TIM_CHANNEL_1, PULSE_MIN);
  HAL_TIM_PWM_Start(&htim3, TIM_CHANNEL_1);
  printf("arming: %d us for %d ms\r\n", PULSE_MIN, ARM_MS);
  HAL_Delay(ARM_MS);
  printf("armed - throttle from the pot on A0\r\n");
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  MX_ADC1_Init();
  MX_TIM3_Init();
  printf("ESC on D5 (TIM3_CH1, 50 Hz servo pulses), pot on A0\r\n");
  arm();

  int on = 1;
  uint32_t last_print = 0, us = PULSE_MIN;
  while (1)
  {
    if (b1_pressed)
    {
      b1_pressed = 0;
      on = !on;
      if (on)
      {
        printf("signal on\r\n");
        arm();
      }
      else
      {
        HAL_TIM_PWM_Stop(&htim3, TIM_CHANNEL_1);
        printf("signal off - the ESC stops the motor (failsafe)\r\n");
      }
    }
    if (on)
    {
      uint32_t pot = read_pot();
      us = PULSE_MIN + pot * (PULSE_MAX - PULSE_MIN) / 4095;
      __HAL_TIM_SET_COMPARE(&htim3, TIM_CHANNEL_1, us);
    }
    uint32_t t = HAL_GetTick();
    if (t - last_print >= 500)
    {
      last_print = t;
      if (on)
      {
        printf("throttle %3lu %% (%4lu us)\r\n", (unsigned long)((us - PULSE_MIN) / 10), (unsigned long)us);
      }
    }
    HAL_Delay(20);
  }
}

/* ------------------------------------------------------- peripherals */

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef g = {0};
  __HAL_RCC_GPIOC_CLK_ENABLE();
  g.Pin = B1_Pin;
  g.Mode = GPIO_MODE_IT_FALLING;
  g.Pull = GPIO_NOPULL;
  HAL_GPIO_Init(B1_GPIO_Port, &g);
  HAL_NVIC_SetPriority(EXTI15_10_IRQn, 2, 0);
  HAL_NVIC_EnableIRQ(EXTI15_10_IRQn);
}

static void MX_ADC1_Init(void)
{
  ADC_ChannelConfTypeDef ch = {0};
  hadc1.Instance = ADC1;
  hadc1.Init.ClockPrescaler = ADC_CLOCK_SYNC_PCLK_DIV4;
  hadc1.Init.Resolution = ADC_RESOLUTION_12B;
  hadc1.Init.ScanConvMode = DISABLE;
  hadc1.Init.ContinuousConvMode = DISABLE;
  hadc1.Init.DiscontinuousConvMode = DISABLE;
  hadc1.Init.ExternalTrigConvEdge = ADC_EXTERNALTRIGCONVEDGE_NONE;
  hadc1.Init.ExternalTrigConv = ADC_SOFTWARE_START;
  hadc1.Init.DataAlign = ADC_DATAALIGN_RIGHT;
  hadc1.Init.NbrOfConversion = 1;
  hadc1.Init.DMAContinuousRequests = DISABLE;
  hadc1.Init.EOCSelection = ADC_EOC_SINGLE_CONV;
  if (HAL_ADC_Init(&hadc1) != HAL_OK)
  {
    Error_Handler();
  }
  ch.Channel = ADC_CHANNEL_0;
  ch.Rank = 1;
  ch.SamplingTime = ADC_SAMPLETIME_84CYCLES;
  if (HAL_ADC_ConfigChannel(&hadc1, &ch) != HAL_OK)
  {
    Error_Handler();
  }
}

void HAL_ADC_MspInit(ADC_HandleTypeDef *hadc)
{
  if (hadc->Instance == ADC1)
  {
    GPIO_InitTypeDef g = {0};
    __HAL_RCC_ADC1_CLK_ENABLE();
    __HAL_RCC_GPIOA_CLK_ENABLE();
    g.Pin = GPIO_PIN_0; /* PA0 = A0 */
    g.Mode = GPIO_MODE_ANALOG;
    g.Pull = GPIO_NOPULL;
    HAL_GPIO_Init(GPIOA, &g);
  }
}

static void MX_TIM3_Init(void)
{
  TIM_OC_InitTypeDef oc = {0};
  htim3.Instance = TIM3;
  htim3.Init.Prescaler = 84 - 1; /* 1 MHz: compare value = µs */
  htim3.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim3.Init.Period = 20000 - 1; /* 50 Hz */
  htim3.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim3.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_ENABLE;
  if (HAL_TIM_PWM_Init(&htim3) != HAL_OK)
  {
    Error_Handler();
  }
  oc.OCMode = TIM_OCMODE_PWM1;
  oc.Pulse = PULSE_MIN;
  oc.OCPolarity = TIM_OCPOLARITY_HIGH;
  oc.OCFastMode = TIM_OCFAST_DISABLE;
  if (HAL_TIM_PWM_ConfigChannel(&htim3, &oc, TIM_CHANNEL_1) != HAL_OK)
  {
    Error_Handler();
  }
}

void HAL_TIM_PWM_MspInit(TIM_HandleTypeDef *htim)
{
  if (htim->Instance == TIM3)
  {
    GPIO_InitTypeDef g = {0};
    __HAL_RCC_TIM3_CLK_ENABLE();
    __HAL_RCC_GPIOB_CLK_ENABLE();
    g.Pin = GPIO_PIN_4; /* PB4 = D5 → TIM3_CH1 */
    g.Mode = GPIO_MODE_AF_PP;
    g.Pull = GPIO_NOPULL;
    g.Speed = GPIO_SPEED_FREQ_LOW;
    g.Alternate = GPIO_AF2_TIM3;
    HAL_GPIO_Init(GPIOB, &g);
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
