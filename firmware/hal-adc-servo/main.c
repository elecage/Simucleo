/*
 * CubeMX-style HAL example: analog inputs and motion.
 *
 *   A0 (PA0, ADC1_IN0)  potentiometer wiper (3V3 — pot — GND)
 *   A1 (PA1, ADC1_IN1)  light: 10 kΩ from 3V3 to A1, LDR from A1 to GND
 *   A2 (PA4, ADC1_IN4)  TMP36 output (powered from 3V3)
 *   internal            temperature sensor (IN16) and VREFINT (IN17)
 *
 *   D9 (PC7, TIM3_CH2)  servo signal, 50 Hz, 0.5–2.5 ms from the pot
 *   D5 (PB4, TIM3_CH1)  motor driver IA: PWM duty from the light level
 *   D4 (PB5)            motor driver IB: low (one direction)
 *
 * Readings are printed every 500 ms on the virtual COM port.
 */
#include <stdio.h>
#include "main.h"

UART_HandleTypeDef huart2;
ADC_HandleTypeDef hadc1;
TIM_HandleTypeDef htim3;

static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);
static void MX_ADC1_Init(void);
static void MX_TIM3_Init(void);

/* One conversion of `channel`, polling for the end of conversion. */
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

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  MX_ADC1_Init();
  MX_TIM3_Init();
  HAL_TIM_PWM_Start(&htim3, TIM_CHANNEL_1);
  HAL_TIM_PWM_Start(&htim3, TIM_CHANNEL_2);
  printf("Analog: pot A0 -> servo D9, light A1 -> motor D5, TMP36 A2\r\n");

  uint32_t last_print = 0;
  while (1)
  {
    uint32_t pot = read_adc(ADC_CHANNEL_0);
    uint32_t light = read_adc(ADC_CHANNEL_1);
    uint32_t tmp36 = read_adc(ADC_CHANNEL_4);
    uint32_t vref = read_adc(ADC_CHANNEL_VREFINT);
    uint32_t chip = read_adc(ADC_CHANNEL_TEMPSENSOR);

    /* Servo: 500 + pot·2000/4095 µs. Motor: brighter = faster (LDR pulls
       A1 low in light). */
    uint32_t pulse_us = 500 + pot * 2000 / 4095;
    __HAL_TIM_SET_COMPARE(&htim3, TIM_CHANNEL_2, pulse_us);
    __HAL_TIM_SET_COMPARE(&htim3, TIM_CHANNEL_1, (4095 - light) * 20000 / 4095);

    if (HAL_GetTick() - last_print >= 500)
    {
      last_print = HAL_GetTick();
      /* VDDA from VREFINT (1.21 V typ.), then volts in millivolts. */
      uint32_t vdda_mv = 1210 * 4095 / (vref ? vref : 1);
      uint32_t tmp_mv = tmp36 * vdda_mv / 4095;
      /* V25 = 760 mV, 2.5 mV/°C: tenths of a degree = ΔmV × 100 / 25. */
      int32_t chip_c10 = ((int32_t)(chip * vdda_mv / 4095) - 760) * 100 / 25 + 250;
      printf("pot %4lu servo %4lu us | light %4lu | TMP36 %ld.%ld C | chip %ld.%ld C | VDDA %lu mV\r\n",
             (unsigned long)pot, (unsigned long)pulse_us, (unsigned long)light,
             (long)((int32_t)tmp_mv - 500) / 10, (long)(((int32_t)tmp_mv - 500) % 10 + 10) % 10,
             (long)chip_c10 / 10, (long)(chip_c10 % 10 + 10) % 10, (unsigned long)vdda_mv);
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
    /* PA0 = A0, PA1 = A1, PA4 = A2 */
    GPIO_InitStruct.Pin = GPIO_PIN_0 | GPIO_PIN_1 | GPIO_PIN_4;
    GPIO_InitStruct.Mode = GPIO_MODE_ANALOG;
    GPIO_InitStruct.Pull = GPIO_NOPULL;
    HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);
  }
}

static void MX_TIM3_Init(void)
{
  TIM_OC_InitTypeDef sConfigOC = {0};
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

  GPIO_InitTypeDef GPIO_InitStruct = {0};
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

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};
  __HAL_RCC_GPIOB_CLK_ENABLE();
  /* PB5 = D4: motor IB, held low */
  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_5, GPIO_PIN_RESET);
  GPIO_InitStruct.Pin = GPIO_PIN_5;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOB, &GPIO_InitStruct);
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
