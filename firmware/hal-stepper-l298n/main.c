/*
 * CubeMX-style HAL example: a NEMA17 bipolar stepper on an L298N dual
 * H-bridge module, driven in half steps straight from four GPIO pins, one
 * revolution clockwise and one back.
 *
 *   D7 (PA8)   IN1 \ bridge A → OUT1/OUT2 → coil A (A+/A−)
 *   D8 (PA9)   IN2 /
 *   D2 (PA10)  IN3 \ bridge B → OUT3/OUT4 → coil B (B+/B−)
 *   D12 (PA6)  IN4 /
 *   D5 (PB4, TIM3_CH1)  ENA \ 2 kHz PWM, 80 %: the coil current (and the
 *   D9 (PC7, TIM3_CH2)  ENB / heat) at 80 % (ENA/ENB jumpers off)
 *   12 V supply         + to 12V, − to GND (common with the Nucleo)
 *
 * Each half step energises coil A, then A and B, then B, … with the
 * current direction set by which input of a bridge is high (IN1 high, IN2
 * low: A+; IN1 low, IN2 high: A−). Eight half steps make one electrical
 * cycle, four full steps of 1.8°: 400 half steps per revolution. All four
 * inputs are written at once through BSRR, so no in-between pattern
 * reaches the coils. TIM4 interrupts 400 times a second for the next half
 * step (200 full steps/s = 60 rpm).
 *
 * Try it wrong: with the order A+, A−, B+, B− (IN1, IN2, IN3, IN4 one
 * after the other) the field jumps by 180° and the rotor only jitters.
 */
#include <stdio.h>
#include "main.h"

#define IN1 GPIO_PIN_8
#define IN2 GPIO_PIN_9
#define IN3 GPIO_PIN_10
#define IN4 GPIO_PIN_6
#define IN_ALL (IN1 | IN2 | IN3 | IN4)

#define HALF_STEPS_PER_REV 400
#define HALF_STEP_HZ 400

UART_HandleTypeDef huart2;
TIM_HandleTypeDef htim3;
TIM_HandleTypeDef htim4;

static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);
static void MX_TIM3_Init(void);
static void MX_TIM4_Init(void);

/* Half-step sequence: A+, A+B+, B+, A−B+, A−, A−B−, B−, A+B−. */
static const uint16_t HALF[8] = {
    IN1, IN1 | IN3, IN3, IN2 | IN3, IN2, IN2 | IN4, IN4, IN1 | IN4,
};

static volatile int32_t position; /* half steps, clockwise positive */
static volatile int32_t remaining;
static volatile int dir = 1;
static int phase;

static void output(uint16_t pattern)
{
  /* Set the high inputs and reset the others in one write. */
  GPIOA->BSRR = pattern | (uint32_t)(IN_ALL & ~pattern) << 16;
}

void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)
{
  if (htim->Instance != TIM4 || remaining <= 0)
  {
    return;
  }
  phase = (phase + dir + 8) % 8;
  output(HALF[phase]);
  position += dir;
  remaining--;
}

void TIM4_IRQHandler(void)
{
  HAL_TIM_IRQHandler(&htim4);
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  MX_TIM3_Init();
  MX_TIM4_Init();
  /* ENA/ENB: 80 % duty. */
  HAL_TIM_PWM_Start(&htim3, TIM_CHANNEL_1);
  HAL_TIM_PWM_Start(&htim3, TIM_CHANNEL_2);
  output(HALF[phase]);
  printf("L298N half steps: IN1-IN4 on D7 D8 D2 D12, ENA/ENB 2 kHz PWM 80%% on D5/D9, %d half steps/rev\r\n",
         HALF_STEPS_PER_REV);
  HAL_Delay(200);
  HAL_TIM_Base_Start_IT(&htim4);

  int rev = 0;
  while (1)
  {
    dir = rev % 2 == 0 ? 1 : -1;
    remaining = HALF_STEPS_PER_REV;
    while (remaining > 0)
    {
      __WFI();
    }
    rev++;
    int32_t p = position;
    printf("rev %d %s: position %ld half steps = %ld deg\r\n", rev, dir > 0 ? "CW " : "CCW", (long)p,
           (long)(p * 360 / HALF_STEPS_PER_REV));
    HAL_Delay(300);
  }
}

/* ------------------------------------------------------- peripherals */

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef g = {0};
  __HAL_RCC_GPIOA_CLK_ENABLE();
  HAL_GPIO_WritePin(GPIOA, IN_ALL, GPIO_PIN_RESET);
  g.Pin = IN_ALL;
  g.Mode = GPIO_MODE_OUTPUT_PP;
  g.Pull = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOA, &g);
}

static void MX_TIM3_Init(void)
{
  TIM_OC_InitTypeDef oc = {0};
  htim3.Instance = TIM3;
  htim3.Init.Prescaler = 84 - 1; /* 1 MHz */
  htim3.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim3.Init.Period = 500 - 1; /* 2 kHz */
  htim3.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim3.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_ENABLE;
  if (HAL_TIM_PWM_Init(&htim3) != HAL_OK)
  {
    Error_Handler();
  }
  oc.OCMode = TIM_OCMODE_PWM1;
  oc.Pulse = 400; /* 80 % */
  oc.OCPolarity = TIM_OCPOLARITY_HIGH;
  oc.OCFastMode = TIM_OCFAST_DISABLE;
  if (HAL_TIM_PWM_ConfigChannel(&htim3, &oc, TIM_CHANNEL_1) != HAL_OK ||
      HAL_TIM_PWM_ConfigChannel(&htim3, &oc, TIM_CHANNEL_2) != HAL_OK)
  {
    Error_Handler();
  }
}

static void MX_TIM4_Init(void)
{
  htim4.Instance = TIM4;
  htim4.Init.Prescaler = 84 - 1; /* 1 MHz */
  htim4.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim4.Init.Period = 1000000 / HALF_STEP_HZ - 1;
  htim4.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim4.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_DISABLE;
  if (HAL_TIM_Base_Init(&htim4) != HAL_OK)
  {
    Error_Handler();
  }
  HAL_NVIC_SetPriority(TIM4_IRQn, 0, 0);
  HAL_NVIC_EnableIRQ(TIM4_IRQn);
}

void HAL_TIM_PWM_MspInit(TIM_HandleTypeDef *htim)
{
  if (htim->Instance == TIM3)
  {
    GPIO_InitTypeDef g = {0};
    __HAL_RCC_TIM3_CLK_ENABLE();
    __HAL_RCC_GPIOB_CLK_ENABLE();
    __HAL_RCC_GPIOC_CLK_ENABLE();
    g.Mode = GPIO_MODE_AF_PP;
    g.Pull = GPIO_NOPULL;
    g.Speed = GPIO_SPEED_FREQ_LOW;
    g.Alternate = GPIO_AF2_TIM3;
    g.Pin = GPIO_PIN_4; /* PB4 = D5 → TIM3_CH1 */
    HAL_GPIO_Init(GPIOB, &g);
    g.Pin = GPIO_PIN_7; /* PC7 = D9 → TIM3_CH2 */
    HAL_GPIO_Init(GPIOC, &g);
  }
}

void HAL_TIM_Base_MspInit(TIM_HandleTypeDef *htim)
{
  if (htim->Instance == TIM4)
  {
    __HAL_RCC_TIM4_CLK_ENABLE();
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
