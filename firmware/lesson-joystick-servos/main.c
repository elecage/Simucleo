/*
 * Lesson "조이스틱으로 서보 2축" (C. 아날로그): a pan-tilt head.
 *
 *   A0 (PA0, ADC1_IN0)  joystick VRx → pan servo
 *   A1 (PA1, ADC1_IN1)  joystick VRy → tilt servo
 *   3V3, GND            joystick +5V and GND (3.3 V so VRx/VRy stay in the ADC range)
 *   D5 (PB4, TIM3_CH1)  pan servo signal
 *   D9 (PC7, TIM3_CH2)  tilt servo signal
 *   5V, GND             both servos' V+ and GND
 *
 * TIM3 counts at 1 MHz with a 20 ms period (50 Hz), so a compare value is
 * the pulse width in µs: 500 µs = 0°, 1500 µs = 90°, 2500 µs = 180°.
 * Both channels are converted one after the other every 20 ms; the
 * readings and angles are printed every 250 ms on the virtual COM port.
 */
#include <stdio.h>
#include "main.h"

UART_HandleTypeDef huart2;
ADC_HandleTypeDef hadc1;
TIM_HandleTypeDef htim3;

static void MX_USART2_UART_Init(void);
static void MX_ADC1_Init(void);
static void MX_TIM3_Init(void);

static uint32_t read_adc(uint32_t channel)
{
  ADC_ChannelConfTypeDef sConfig = {0};
  sConfig.Channel = channel;
  sConfig.Rank = 1;
  sConfig.SamplingTime = ADC_SAMPLETIME_84CYCLES;
  if (HAL_ADC_ConfigChannel(&hadc1, &sConfig) != HAL_OK)
  {
    Error_Handler();
  }
  HAL_ADC_Start(&hadc1);
  if (HAL_ADC_PollForConversion(&hadc1, 10) != HAL_OK)
  {
    Error_Handler();
  }
  uint32_t v = HAL_ADC_GetValue(&hadc1);
  HAL_ADC_Stop(&hadc1);
  return v;
}

/* 0–4095 → 500–2500 µs. */
static uint32_t pulse_for(uint32_t adc) { return 500 + adc * 2000 / 4095; }

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_USART2_UART_Init();
  MX_ADC1_Init();
  MX_TIM3_Init();
  HAL_TIM_PWM_Start(&htim3, TIM_CHANNEL_1);
  HAL_TIM_PWM_Start(&htim3, TIM_CHANNEL_2);
  printf("Pan-tilt: VRx A0 -> servo D5, VRy A1 -> servo D9\r\n");

  uint32_t last_print = 0;
  while (1)
  {
    uint32_t x = read_adc(ADC_CHANNEL_0);
    uint32_t y = read_adc(ADC_CHANNEL_1);
    uint32_t pan = pulse_for(x), tilt = pulse_for(y);
    __HAL_TIM_SET_COMPARE(&htim3, TIM_CHANNEL_1, pan);
    __HAL_TIM_SET_COMPARE(&htim3, TIM_CHANNEL_2, tilt);
    if (HAL_GetTick() - last_print >= 250)
    {
      last_print = HAL_GetTick();
      printf("X %4lu Y %4lu -> pan %3lu deg tilt %3lu deg\r\n", (unsigned long)x, (unsigned long)y,
             (unsigned long)((pan - 500) * 180 / 2000), (unsigned long)((tilt - 500) * 180 / 2000));
    }
    HAL_Delay(20);
  }
}

static void MX_ADC1_Init(void)
{
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
}

void HAL_ADC_MspInit(ADC_HandleTypeDef *hadc)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};
  if (hadc->Instance == ADC1)
  {
    __HAL_RCC_ADC1_CLK_ENABLE();
    __HAL_RCC_GPIOA_CLK_ENABLE();
    GPIO_InitStruct.Pin = GPIO_PIN_0 | GPIO_PIN_1; /* A0, A1 */
    GPIO_InitStruct.Mode = GPIO_MODE_ANALOG;
    GPIO_InitStruct.Pull = GPIO_NOPULL;
    HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);
  }
}

static void MX_TIM3_Init(void)
{
  TIM_OC_InitTypeDef sConfigOC = {0};
  GPIO_InitTypeDef GPIO_InitStruct = {0};
  htim3.Instance = TIM3;
  htim3.Init.Prescaler = 84 - 1; /* 1 MHz */
  htim3.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim3.Init.Period = 20000 - 1; /* 50 Hz */
  htim3.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim3.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_ENABLE;
  if (HAL_TIM_PWM_Init(&htim3) != HAL_OK)
  {
    Error_Handler();
  }
  sConfigOC.OCMode = TIM_OCMODE_PWM1;
  sConfigOC.Pulse = 1500;
  sConfigOC.OCPolarity = TIM_OCPOLARITY_HIGH;
  sConfigOC.OCFastMode = TIM_OCFAST_DISABLE;
  if (HAL_TIM_PWM_ConfigChannel(&htim3, &sConfigOC, TIM_CHANNEL_1) != HAL_OK ||
      HAL_TIM_PWM_ConfigChannel(&htim3, &sConfigOC, TIM_CHANNEL_2) != HAL_OK)
  {
    Error_Handler();
  }
  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOC_CLK_ENABLE();
  GPIO_InitStruct.Mode = GPIO_MODE_AF_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  GPIO_InitStruct.Alternate = GPIO_AF2_TIM3;
  GPIO_InitStruct.Pin = GPIO_PIN_4; /* PB4 = D5 → TIM3_CH1 */
  HAL_GPIO_Init(GPIOB, &GPIO_InitStruct);
  GPIO_InitStruct.Pin = GPIO_PIN_7; /* PC7 = D9 → TIM3_CH2 */
  HAL_GPIO_Init(GPIOC, &GPIO_InitStruct);
}

void HAL_TIM_PWM_MspInit(TIM_HandleTypeDef *htim)
{
  if (htim->Instance == TIM3)
  {
    __HAL_RCC_TIM3_CLK_ENABLE();
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
