/*
 * CubeMX-style HAL example: a NEMA17 bipolar stepper on an A4988 driver,
 * one revolution at a time with an acceleration ramp, turning back after
 * every revolution.
 *
 *   D3 (PB3, TIM2_CH2)  STEP: one 5 µs pulse per microstep (TIM2 PWM)
 *   D4 (PB5)            DIR: high = clockwise
 *   D7 (PA8)            EN (active low): low = outputs on
 *   D8 (PA9)            MS1 \
 *   D9 (PC7)            MS2  } 1/8 steps: MS1 = MS2 = high, MS3 = low
 *   D10 (PB6)           MS3 /
 *   RST — SLP           tied together (SLP is pulled up on the board)
 *   3V3, GND            VDD and GND of the driver's logic
 *   12 V supply         + to VMOT, − to GND (common with the Nucleo)
 *   1A/1B, 2A/2B        coil A (A+/A−) and coil B (B+/B−) of the motor
 *   B1 (PC13)           driver off / on (EN): turn the shaft by hand
 *
 * TIM2 counts at 1 MHz; one PWM period is the time between two microsteps
 * and the compare value (5) the STEP pulse width (the A4988 needs at least
 * 1 µs). At the end of every pulse the CC2 interrupt counts the step and
 * sets the next period from the ramp: a stepper cannot start at full
 * speed — above its pull-in rate the rotor falls behind and loses steps —
 * so the speed rises at a constant acceleration, v = sqrt(v0² + 2·a·n),
 * and falls the same way before the end of the move.
 */
#include <math.h>
#include <stdio.h>
#include "main.h"

#define DIR_PORT GPIOB
#define DIR_PIN GPIO_PIN_5
#define EN_PORT GPIOA
#define EN_PIN GPIO_PIN_8

#define MICROSTEPS 8                    /* MS1, MS2 high, MS3 low */
#define STEPS_PER_REV (200 * MICROSTEPS) /* 1.8° motor */
#define PULSE_US 5
/* Ramp in microsteps per second (and per second²). */
#define V_START (100.0f * MICROSTEPS)  /* 100 full steps/s */
#define V_MAX (1000.0f * MICROSTEPS)   /* 1000 full steps/s = 300 rpm */
#define ACCEL (5000.0f * MICROSTEPS)   /* full steps/s² */

UART_HandleTypeDef huart2;
TIM_HandleTypeDef htim2;

static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);
static void MX_TIM2_Init(void);

/* The move in progress (written by the timer interrupt). */
static volatile uint32_t done, total;
static volatile int moving;
static volatile int32_t position; /* microsteps, clockwise positive */
static int dir = 1;
static volatile int b1_pressed;

static uint32_t period_us(uint32_t n)
{
  /* Speed after n steps up, or with n steps left to go down. */
  uint32_t left = total - n;
  uint32_t k = n < left ? n : left;
  float v = sqrtf(V_START * V_START + 2.0f * ACCEL * (float)k);
  if (v > V_MAX)
  {
    v = V_MAX;
  }
  return (uint32_t)(1e6f / v);
}

void HAL_TIM_PWM_PulseFinishedCallback(TIM_HandleTypeDef *htim)
{
  if (htim->Instance != TIM2 || !moving)
  {
    return;
  }
  done++;
  position += dir;
  if (done >= total)
  {
    /* The next period has not begun yet: stop before its pulse. */
    HAL_TIM_PWM_Stop_IT(&htim2, TIM_CHANNEL_2);
    moving = 0;
    return;
  }
  /* Takes effect at the next update (auto-reload preload). */
  __HAL_TIM_SET_AUTORELOAD(&htim2, period_us(done + 1) - 1);
}

void TIM2_IRQHandler(void)
{
  HAL_TIM_IRQHandler(&htim2);
}

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

/* Start a move of `steps` microsteps in direction `d` (+1 / −1). */
static void move(uint32_t steps, int d)
{
  dir = d;
  HAL_GPIO_WritePin(DIR_PORT, DIR_PIN, d > 0 ? GPIO_PIN_SET : GPIO_PIN_RESET);
  /* DIR must settle before the first STEP edge (200 ns). */
  for (volatile int i = 0; i < 10; i++)
  {
  }
  done = 0;
  total = steps;
  moving = 1;
  __HAL_TIM_SET_AUTORELOAD(&htim2, period_us(0) - 1);
  __HAL_TIM_SET_COUNTER(&htim2, 0);
  htim2.Instance->EGR = TIM_EGR_UG; /* load the period now */
  __HAL_TIM_CLEAR_FLAG(&htim2, TIM_FLAG_UPDATE | TIM_FLAG_CC2);
  HAL_TIM_PWM_Start_IT(&htim2, TIM_CHANNEL_2);
}

static void print_position(int rev)
{
  int32_t p = position;
  int32_t tenths = p * 3600 / STEPS_PER_REV; /* degrees × 10 */
  printf("rev %d %s: position %ld microsteps = %ld.%01ld deg\r\n", rev, dir > 0 ? "CW " : "CCW",
         (long)p, (long)(tenths / 10), (long)((tenths < 0 ? -tenths : tenths) % 10));
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  MX_TIM2_Init();
  printf("A4988: STEP D3 (TIM2_CH2), DIR D4, EN D7, 1/%d steps (MS1 MS2 high), %d microsteps/rev\r\n",
         MICROSTEPS, STEPS_PER_REV);
  HAL_Delay(100); /* the A4988 wakes up in 1 ms; the rotor settles */

  int rev = 0, enabled = 1;
  while (1)
  {
    if (b1_pressed)
    {
      b1_pressed = 0;
      enabled = !enabled;
      /* Finish the move in progress first. */
      while (moving)
      {
      }
      HAL_GPIO_WritePin(EN_PORT, EN_PIN, enabled ? GPIO_PIN_RESET : GPIO_PIN_SET);
      printf(enabled ? "driver on (EN low)\r\n" : "driver off (EN high) - the shaft turns freely\r\n");
      if (enabled)
      {
        HAL_Delay(50);
      }
    }
    if (!enabled)
    {
      __WFI();
      continue;
    }
    move(STEPS_PER_REV, rev % 2 == 0 ? 1 : -1);
    while (moving)
    {
      __WFI();
    }
    rev++;
    print_position(rev);
    HAL_Delay(400);
  }
}

/* ------------------------------------------------------- peripherals */

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef g = {0};
  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOC_CLK_ENABLE();
  /* EN low (on), DIR low; MS1 = MS2 = high, MS3 = low: 1/8 steps. */
  HAL_GPIO_WritePin(EN_PORT, EN_PIN, GPIO_PIN_RESET);
  HAL_GPIO_WritePin(DIR_PORT, DIR_PIN, GPIO_PIN_RESET);
  HAL_GPIO_WritePin(GPIOA, GPIO_PIN_9, GPIO_PIN_SET);
  HAL_GPIO_WritePin(GPIOC, GPIO_PIN_7, GPIO_PIN_SET);
  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_6, GPIO_PIN_RESET);
  g.Mode = GPIO_MODE_OUTPUT_PP;
  g.Pull = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_LOW;
  g.Pin = EN_PIN | GPIO_PIN_9;
  HAL_GPIO_Init(GPIOA, &g);
  g.Pin = DIR_PIN | GPIO_PIN_6;
  HAL_GPIO_Init(GPIOB, &g);
  g.Pin = GPIO_PIN_7;
  HAL_GPIO_Init(GPIOC, &g);
  g.Pin = B1_Pin;
  g.Mode = GPIO_MODE_IT_FALLING;
  HAL_GPIO_Init(B1_GPIO_Port, &g);
  HAL_NVIC_SetPriority(EXTI15_10_IRQn, 2, 0);
  HAL_NVIC_EnableIRQ(EXTI15_10_IRQn);
}

static void MX_TIM2_Init(void)
{
  TIM_OC_InitTypeDef oc = {0};
  htim2.Instance = TIM2;
  htim2.Init.Prescaler = 84 - 1; /* 84 MHz timer clock → 1 MHz */
  htim2.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim2.Init.Period = 10000 - 1;
  htim2.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim2.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_ENABLE;
  if (HAL_TIM_PWM_Init(&htim2) != HAL_OK)
  {
    Error_Handler();
  }
  oc.OCMode = TIM_OCMODE_PWM1;
  oc.Pulse = PULSE_US;
  oc.OCPolarity = TIM_OCPOLARITY_HIGH;
  oc.OCFastMode = TIM_OCFAST_DISABLE;
  if (HAL_TIM_PWM_ConfigChannel(&htim2, &oc, TIM_CHANNEL_2) != HAL_OK)
  {
    Error_Handler();
  }
  HAL_NVIC_SetPriority(TIM2_IRQn, 0, 0);
  HAL_NVIC_EnableIRQ(TIM2_IRQn);
}

void HAL_TIM_PWM_MspInit(TIM_HandleTypeDef *htim)
{
  if (htim->Instance == TIM2)
  {
    GPIO_InitTypeDef g = {0};
    __HAL_RCC_TIM2_CLK_ENABLE();
    __HAL_RCC_GPIOB_CLK_ENABLE();
    g.Pin = GPIO_PIN_3; /* PB3 = D3 → TIM2_CH2 */
    g.Mode = GPIO_MODE_AF_PP;
    g.Pull = GPIO_NOPULL;
    g.Speed = GPIO_SPEED_FREQ_LOW;
    g.Alternate = GPIO_AF1_TIM2;
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
