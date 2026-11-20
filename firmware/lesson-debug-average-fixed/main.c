/*
 * Solution to the lesson "디버거로 버그 찾기" (F. 고급): lesson-debug-average
 * with its bug fixed — average() added eight 12-bit samples (up to
 * 8 × 4095 = 32760) in a uint8_t, which wraps around at 256, so the mean
 * never got above 31. The sum needs at least 16 bits; uint32_t it is.
 * Only the tests use this file.
 *
 *   A0 (PA0, ADC1_IN0)  potentiometer wiper (3V3 — pot — GND)
 *   D7 (PA8)            → 220 Ω → LED → GND: on while the average is
 *                       above half scale (2048)
 *
 * Every 25 ms one sample goes into a ring of N_SAMPLES; average() returns
 * their mean. The average is printed every 250 ms on the virtual COM port
 * (USART2, 115200 8N1).
 */
#include <stdio.h>
#include "main.h"

#define N_SAMPLES 8
#define THRESHOLD 2048

UART_HandleTypeDef huart2;
ADC_HandleTypeDef hadc1;

static uint16_t samples[N_SAMPLES];
static unsigned next_sample;

static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);
static void MX_ADC1_Init(void);

static uint16_t read_pot(void)
{
  HAL_ADC_Start(&hadc1);
  if (HAL_ADC_PollForConversion(&hadc1, 10) != HAL_OK)
  {
    Error_Handler();
  }
  uint16_t v = (uint16_t)HAL_ADC_GetValue(&hadc1);
  HAL_ADC_Stop(&hadc1);
  return v;
}

/* The mean of the last N_SAMPLES readings. */
static uint16_t average(void)
{
  uint32_t sum = 0; /* was uint8_t: wrapped at 256 */
  for (int i = 0; i < N_SAMPLES; i++)
  {
    sum += samples[i];
  }
  return sum / N_SAMPLES;
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  MX_ADC1_Init();
  printf("Smoothed pot on A0, LED on D7 above %d\r\n", THRESHOLD);

  uint32_t last_print = 0;
  while (1)
  {
    samples[next_sample] = read_pot();
    next_sample = (next_sample + 1) % N_SAMPLES;
    uint16_t avg = average();
    HAL_GPIO_WritePin(GPIOA, GPIO_PIN_8, avg > THRESHOLD ? GPIO_PIN_SET : GPIO_PIN_RESET);
    if (HAL_GetTick() - last_print >= 250)
    {
      last_print = HAL_GetTick();
      printf("pot %4u avg %4u LED %s\r\n", samples[(next_sample + N_SAMPLES - 1) % N_SAMPLES], avg,
             avg > THRESHOLD ? "on" : "off");
    }
    HAL_Delay(25);
  }
}

static void MX_ADC1_Init(void)
{
  ADC_ChannelConfTypeDef sConfig = {0};
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
  sConfig.Channel = ADC_CHANNEL_0;
  sConfig.Rank = 1;
  sConfig.SamplingTime = ADC_SAMPLETIME_84CYCLES;
  if (HAL_ADC_ConfigChannel(&hadc1, &sConfig) != HAL_OK)
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
    GPIO_InitStruct.Pin = GPIO_PIN_0; /* PA0 = A0 */
    GPIO_InitStruct.Mode = GPIO_MODE_ANALOG;
    GPIO_InitStruct.Pull = GPIO_NOPULL;
    HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);
  }
}

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};
  __HAL_RCC_GPIOA_CLK_ENABLE();
  HAL_GPIO_WritePin(GPIOA, GPIO_PIN_8, GPIO_PIN_RESET);
  GPIO_InitStruct.Pin = GPIO_PIN_8; /* D7 */
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);
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
