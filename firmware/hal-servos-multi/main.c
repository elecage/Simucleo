/*
 * CubeMX-style HAL example: three servos on three PWM channels of two
 * timers, sweeping back and forth a third of a period apart.
 *
 *   D5 (PB4, TIM3_CH1)  servo 1 signal
 *   D9 (PC7, TIM3_CH2)  servo 2 signal
 *   D7 (PA8, TIM1_CH1)  servo 3 signal (advanced timer: needs MOE, which
 *                       HAL_TIM_PWM_Start sets)
 *   5V, GND             servo V+ and GND
 *
 * Both timers count at 1 MHz with a 20 ms period (50 Hz); a channel's
 * compare value is its pulse width in microseconds: 500 µs = 0°,
 * 1500 µs = 90°, 2500 µs = 180°. Every 20 ms the angles move along a
 * 4-second triangle wave; every 500 ms they are printed.
 */
#include <stdio.h>
#include "main.h"

UART_HandleTypeDef huart2;
TIM_HandleTypeDef htim1;
TIM_HandleTypeDef htim3;

static void MX_USART2_UART_Init(void);
static void MX_TIM_Init(TIM_HandleTypeDef *htim, TIM_TypeDef *tim, uint32_t prescaler);

#define PERIOD_MS 4000

/* Angle (degrees) at time t (ms) of a triangle wave 0 → 180 → 0. */
static uint32_t sweep(uint32_t t)
{
  uint32_t p = t % PERIOD_MS;
  uint32_t half = PERIOD_MS / 2;
  return (p < half ? p : PERIOD_MS - p) * 180 / half;
}

static uint32_t pulse_us(uint32_t angle)
{
  return 500 + angle * 2000 / 180;
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_USART2_UART_Init();
  /* TIM3 on APB1 (84 MHz timer clock), TIM1 on APB2 (84 MHz). */
  MX_TIM_Init(&htim3, TIM3, 84 - 1);
  MX_TIM_Init(&htim1, TIM1, 84 - 1);
  HAL_TIM_PWM_Start(&htim3, TIM_CHANNEL_1);
  HAL_TIM_PWM_Start(&htim3, TIM_CHANNEL_2);
  HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_1);
  printf("3 servos: D5 TIM3_CH1, D9 TIM3_CH2, D7 TIM1_CH1\r\n");

  uint32_t last_print = 0;
  while (1)
  {
    uint32_t t = HAL_GetTick();
    uint32_t a[3];
    for (int i = 0; i < 3; i++)
    {
      a[i] = sweep(t + i * PERIOD_MS / 3);
    }
    __HAL_TIM_SET_COMPARE(&htim3, TIM_CHANNEL_1, pulse_us(a[0]));
    __HAL_TIM_SET_COMPARE(&htim3, TIM_CHANNEL_2, pulse_us(a[1]));
    __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_1, pulse_us(a[2]));
    if (t - last_print >= 500)
    {
      last_print = t;
      printf("S1 %3lu deg %4lu us | S2 %3lu deg %4lu us | S3 %3lu deg %4lu us\r\n", (unsigned long)a[0],
             (unsigned long)pulse_us(a[0]), (unsigned long)a[1], (unsigned long)pulse_us(a[1]),
             (unsigned long)a[2], (unsigned long)pulse_us(a[2]));
    }
    HAL_Delay(20);
  }
}

static void MX_TIM_Init(TIM_HandleTypeDef *htim, TIM_TypeDef *tim, uint32_t prescaler)
{
  TIM_OC_InitTypeDef oc = {0};
  htim->Instance = tim;
  htim->Init.Prescaler = prescaler; /* 1 MHz */
  htim->Init.CounterMode = TIM_COUNTERMODE_UP;
  htim->Init.Period = 20000 - 1; /* 50 Hz */
  htim->Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim->Init.RepetitionCounter = 0;
  htim->Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_ENABLE;
  if (HAL_TIM_PWM_Init(htim) != HAL_OK)
  {
    Error_Handler();
  }
  oc.OCMode = TIM_OCMODE_PWM1;
  oc.Pulse = 1500;
  oc.OCPolarity = TIM_OCPOLARITY_HIGH;
  oc.OCNPolarity = TIM_OCNPOLARITY_HIGH;
  oc.OCFastMode = TIM_OCFAST_DISABLE;
  oc.OCIdleState = TIM_OCIDLESTATE_RESET;
  oc.OCNIdleState = TIM_OCNIDLESTATE_RESET;
  if (HAL_TIM_PWM_ConfigChannel(htim, &oc, TIM_CHANNEL_1) != HAL_OK)
  {
    Error_Handler();
  }
  if (tim == TIM3 && HAL_TIM_PWM_ConfigChannel(htim, &oc, TIM_CHANNEL_2) != HAL_OK)
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
  if (htim->Instance == TIM3)
  {
    __HAL_RCC_TIM3_CLK_ENABLE();
    __HAL_RCC_GPIOB_CLK_ENABLE();
    __HAL_RCC_GPIOC_CLK_ENABLE();
    g.Alternate = GPIO_AF2_TIM3;
    g.Pin = GPIO_PIN_4; /* PB4 = D5 → TIM3_CH1 */
    HAL_GPIO_Init(GPIOB, &g);
    g.Pin = GPIO_PIN_7; /* PC7 = D9 → TIM3_CH2 */
    HAL_GPIO_Init(GPIOC, &g);
  }
  else if (htim->Instance == TIM1)
  {
    __HAL_RCC_TIM1_CLK_ENABLE();
    __HAL_RCC_GPIOA_CLK_ENABLE();
    g.Alternate = GPIO_AF1_TIM1;
    g.Pin = GPIO_PIN_8; /* PA8 = D7 → TIM1_CH1 */
    HAL_GPIO_Init(GPIOA, &g);
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
