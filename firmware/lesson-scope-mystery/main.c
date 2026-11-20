/*
 * Lesson "오실로스코프로 PWM 측정·UART 해독" (F. 고급): signals to measure.
 *
 *   D3 (PB3,  TIM2_CH2)  1 kHz, 50 % duty
 *   D6 (PB10, TIM2_CH3)  1 kHz, 75 % duty
 *   D5 (PB4,  TIM3_CH1)  2 kHz, 25 % duty
 *   D9 (PC7,  TIM3_CH2)  2 kHz, 60 % duty
 *   D8 (PA9,  USART1_TX) a secret line at 9600 baud 8N1, every 250 ms
 *   D12 (PA6), D11 (PA7) GPIO outputs: D12 blinks at 1 Hz, D11 stays low
 *
 * The student finds the 2 kHz / 25 % signal and decodes the secret with
 * the scope, then wires an LED to each answer. The virtual COM port
 * (USART2, 115200 8N1) only gives the task, not the answers.
 */
#include <stdio.h>
#include <string.h>
#include "main.h"

UART_HandleTypeDef huart1, huart2;
TIM_HandleTypeDef htim2, htim3;

static void MX_GPIO_Init(void);
static void MX_USART1_UART_Init(void);
static void MX_USART2_UART_Init(void);
static void pwm_init(TIM_HandleTypeDef *htim, TIM_TypeDef *tim, uint32_t period_us);
static void pwm_channel(TIM_HandleTypeDef *htim, uint32_t channel, uint32_t pulse_us);

static const char SECRET[] = "LED2 -> D12\r\n";

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART1_UART_Init();
  MX_USART2_UART_Init();

  pwm_init(&htim2, TIM2, 1000);      /* 1 kHz */
  pwm_channel(&htim2, TIM_CHANNEL_2, 500); /* D3 50 % */
  pwm_channel(&htim2, TIM_CHANNEL_3, 750); /* D6 75 % */
  pwm_init(&htim3, TIM3, 500);       /* 2 kHz */
  pwm_channel(&htim3, TIM_CHANNEL_1, 125); /* D5 25 % */
  pwm_channel(&htim3, TIM_CHANNEL_2, 300); /* D9 60 % */

  printf("Mystery signals on D3 D5 D6 D9 and a secret on D8 (UART).\r\n");
  printf("1) LED1 goes on the 2 kHz signal with 25%% duty.\r\n");
  printf("2) Decode D8 with the scope: it says where LED2 goes.\r\n");

  uint32_t last_secret = 0, last_blink = 0;
  while (1)
  {
    uint32_t now = HAL_GetTick();
    if (now - last_secret >= 250)
    {
      last_secret = now;
      HAL_UART_Transmit(&huart1, (const uint8_t *)SECRET, sizeof SECRET - 1, 100);
    }
    if (now - last_blink >= 500)
    {
      last_blink = now;
      HAL_GPIO_TogglePin(GPIOA, GPIO_PIN_6); /* D12 */
    }
  }
}

/* A timer counting at 1 MHz, overflowing every `period_us`. */
static void pwm_init(TIM_HandleTypeDef *htim, TIM_TypeDef *tim, uint32_t period_us)
{
  htim->Instance = tim;
  htim->Init.Prescaler = 84 - 1;
  htim->Init.CounterMode = TIM_COUNTERMODE_UP;
  htim->Init.Period = period_us - 1;
  htim->Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim->Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_ENABLE;
  if (HAL_TIM_PWM_Init(htim) != HAL_OK)
  {
    Error_Handler();
  }
}

static void pwm_channel(TIM_HandleTypeDef *htim, uint32_t channel, uint32_t pulse_us)
{
  TIM_OC_InitTypeDef oc = {0};
  oc.OCMode = TIM_OCMODE_PWM1;
  oc.Pulse = pulse_us;
  oc.OCPolarity = TIM_OCPOLARITY_HIGH;
  oc.OCFastMode = TIM_OCFAST_DISABLE;
  if (HAL_TIM_PWM_ConfigChannel(htim, &oc, channel) != HAL_OK || HAL_TIM_PWM_Start(htim, channel) != HAL_OK)
  {
    Error_Handler();
  }
}

void HAL_TIM_PWM_MspInit(TIM_HandleTypeDef *htim)
{
  GPIO_InitTypeDef g = {0};
  g.Mode = GPIO_MODE_AF_PP;
  g.Pull = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_LOW;
  if (htim->Instance == TIM2)
  {
    __HAL_RCC_TIM2_CLK_ENABLE();
    __HAL_RCC_GPIOB_CLK_ENABLE();
    g.Pin = GPIO_PIN_3 | GPIO_PIN_10; /* D3 = CH2, D6 = CH3 */
    g.Alternate = GPIO_AF1_TIM2;
    HAL_GPIO_Init(GPIOB, &g);
  }
  else if (htim->Instance == TIM3)
  {
    __HAL_RCC_TIM3_CLK_ENABLE();
    __HAL_RCC_GPIOB_CLK_ENABLE();
    __HAL_RCC_GPIOC_CLK_ENABLE();
    g.Alternate = GPIO_AF2_TIM3;
    g.Pin = GPIO_PIN_4; /* D5 = CH1 */
    HAL_GPIO_Init(GPIOB, &g);
    g.Pin = GPIO_PIN_7; /* D9 = CH2 */
    HAL_GPIO_Init(GPIOC, &g);
  }
}

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef g = {0};
  __HAL_RCC_GPIOA_CLK_ENABLE();
  HAL_GPIO_WritePin(GPIOA, GPIO_PIN_6 | GPIO_PIN_7, GPIO_PIN_RESET);
  g.Pin = GPIO_PIN_6 | GPIO_PIN_7; /* D12, D11 */
  g.Mode = GPIO_MODE_OUTPUT_PP;
  g.Pull = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOA, &g);
}

static void MX_USART1_UART_Init(void)
{
  huart1.Instance = USART1;
  huart1.Init.BaudRate = 9600;
  huart1.Init.WordLength = UART_WORDLENGTH_8B;
  huart1.Init.StopBits = UART_STOPBITS_1;
  huart1.Init.Parity = UART_PARITY_NONE;
  huart1.Init.Mode = UART_MODE_TX;
  huart1.Init.HwFlowCtl = UART_HWCONTROL_NONE;
  huart1.Init.OverSampling = UART_OVERSAMPLING_16;
  if (HAL_UART_Init(&huart1) != HAL_OK)
  {
    Error_Handler();
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
