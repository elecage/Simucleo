/*
 * Lesson "프로젝트: 주차 보조" (G. 프로젝트), also "초음파 거리 경보" (E):
 * a parking sensor.
 *
 *   D7 (PA8)             HC-SR04 TRIG: a 12 µs pulse starts a measurement
 *   D3 (PB3, TIM2_CH2)   HC-SR04 ECHO: input capture on both edges, 1 µs;
 *                        the echo pulse lasts 58 µs per cm of distance
 *   5V, GND              HC-SR04 VCC and GND
 *   D4 (PB5)  → 220 Ω → green LED → GND    far:   > 50 cm
 *   D5 (PB4)  → 220 Ω → yellow LED → GND   near:  20–50 cm
 *   D6 (PB10) → 220 Ω → red LED → GND      close: < 20 cm
 *   D8 (PA9, TIM1_CH2)   passive buzzer to GND: 2 kHz tone, beeping
 *                        faster the closer it gets, steady below 10 cm
 *
 * A measurement every 60 ms (the sensor needs ~60 ms between pings so an
 * old echo is not taken for a new one). Every 500 ms the distance and the
 * zone are printed on the virtual COM port (USART2, 115200 8N1).
 */
#include <stdio.h>
#include "main.h"

UART_HandleTypeDef huart2;
TIM_HandleTypeDef htim1, htim2;
static volatile uint32_t rise, width;
static volatile int edges;

static void MX_GPIO_Init(void);
static void MX_TIM1_Init(void);
static void MX_TIM2_Init(void);
static void MX_USART2_UART_Init(void);

/* ---------------------------------------------- microsecond delays */

static void dwt_init(void)
{
  CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
  DWT->CYCCNT = 0;
  DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
}

static void delay_us(uint32_t us)
{
  uint32_t start = DWT->CYCCNT, ticks = us * (SystemCoreClock / 1000000);
  while (DWT->CYCCNT - start < ticks)
  {
  }
}

/* --------------------------------------------------------- HC-SR04 */

void HAL_TIM_IC_CaptureCallback(TIM_HandleTypeDef *htim)
{
  if (htim->Instance == TIM2 && htim->Channel == HAL_TIM_ACTIVE_CHANNEL_2)
  {
    uint32_t t = HAL_TIM_ReadCapturedValue(htim, TIM_CHANNEL_2);
    if (GPIOB->IDR & GPIO_PIN_3)
    {
      rise = t; /* echo starts */
    }
    else
    {
      width = t - rise; /* echo ends */
    }
    edges++;
  }
}

void TIM2_IRQHandler(void)
{
  HAL_TIM_IRQHandler(&htim2);
}

/* Distance in mm, or −1 without an echo. */
static int sonar_mm(void)
{
  edges = 0;
  HAL_GPIO_WritePin(GPIOA, GPIO_PIN_8, GPIO_PIN_SET);
  delay_us(12);
  HAL_GPIO_WritePin(GPIOA, GPIO_PIN_8, GPIO_PIN_RESET);
  uint32_t start = HAL_GetTick();
  while (edges < 2 && HAL_GetTick() - start < 40)
  {
  }
  if (edges < 2)
  {
    return -1;
  }
  return (int)((width * 10 + 29) / 58);
}

/* ---------------------------------------------------- LEDs, buzzer */

enum Zone { FAR, NEAR, CLOSE, STOP };
static const char *const ZONE_NAME[] = {"GREEN", "YELLOW", "RED", "RED STOP"};

static void leds(enum Zone z)
{
  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_5, z == FAR ? GPIO_PIN_SET : GPIO_PIN_RESET);   /* green */
  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_4, z == NEAR ? GPIO_PIN_SET : GPIO_PIN_RESET);  /* yellow */
  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_10, z >= CLOSE ? GPIO_PIN_SET : GPIO_PIN_RESET); /* red */
}

static void tone(int on)
{
  __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_2, on ? 250 : 0); /* 50 % of 500 µs */
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  MX_TIM1_Init();
  MX_TIM2_Init();
  dwt_init();
  HAL_TIM_IC_Start_IT(&htim2, TIM_CHANNEL_2);
  HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_2);
  tone(0);
  printf("Parking sensor: HC-SR04 D7/D3, LEDs D4 D5 D6, buzzer D8\r\n");

  enum Zone zone = FAR;
  int mm = -1;
  uint32_t last_ping = 0, last_print = 0;
  while (1)
  {
    uint32_t now = HAL_GetTick();
    if (now - last_ping >= 60)
    {
      last_ping = now;
      mm = sonar_mm();
      zone = (mm < 0 || mm > 500) ? FAR : mm > 200 ? NEAR : mm > 100 ? CLOSE : STOP;
      leds(zone);
    }
    /* Beeps: none far away, 100 ms every 600 ms near, every 200 ms close, steady at STOP. */
    uint32_t period = zone == NEAR ? 600 : 200;
    tone(zone == STOP || (zone != FAR && now % period < 100));

    if (now - last_print >= 500)
    {
      last_print = now;
      if (mm < 0)
      {
        printf("dist: no echo  zone %s\r\n", ZONE_NAME[zone]);
      }
      else
      {
        printf("dist %d.%d cm  zone %s\r\n", mm / 10, mm % 10, ZONE_NAME[zone]);
      }
    }
  }
}

/* ------------------------------------------------------- peripherals */

static void MX_TIM1_Init(void)
{
  TIM_OC_InitTypeDef oc = {0};
  htim1.Instance = TIM1;
  htim1.Init.Prescaler = 84 - 1; /* 1 MHz */
  htim1.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim1.Init.Period = 500 - 1; /* 2 kHz */
  htim1.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim1.Init.RepetitionCounter = 0;
  htim1.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_ENABLE;
  if (HAL_TIM_PWM_Init(&htim1) != HAL_OK)
  {
    Error_Handler();
  }
  oc.OCMode = TIM_OCMODE_PWM1;
  oc.Pulse = 0;
  oc.OCPolarity = TIM_OCPOLARITY_HIGH;
  oc.OCFastMode = TIM_OCFAST_DISABLE;
  if (HAL_TIM_PWM_ConfigChannel(&htim1, &oc, TIM_CHANNEL_2) != HAL_OK)
  {
    Error_Handler();
  }
}

void HAL_TIM_PWM_MspInit(TIM_HandleTypeDef *htim)
{
  GPIO_InitTypeDef g = {0};
  if (htim->Instance == TIM1)
  {
    __HAL_RCC_TIM1_CLK_ENABLE();
    __HAL_RCC_GPIOA_CLK_ENABLE();
    g.Pin = GPIO_PIN_9; /* PA9 = D8 → TIM1_CH2 */
    g.Mode = GPIO_MODE_AF_PP;
    g.Pull = GPIO_NOPULL;
    g.Speed = GPIO_SPEED_FREQ_LOW;
    g.Alternate = GPIO_AF1_TIM1;
    HAL_GPIO_Init(GPIOA, &g);
  }
}

static void MX_TIM2_Init(void)
{
  TIM_IC_InitTypeDef ic = {0};
  htim2.Instance = TIM2;
  htim2.Init.Prescaler = 84 - 1;
  htim2.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim2.Init.Period = 0xFFFFFFFF;
  htim2.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim2.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_DISABLE;
  if (HAL_TIM_IC_Init(&htim2) != HAL_OK)
  {
    Error_Handler();
  }
  ic.ICPolarity = TIM_INPUTCHANNELPOLARITY_BOTHEDGE;
  ic.ICSelection = TIM_ICSELECTION_DIRECTTI;
  ic.ICPrescaler = TIM_ICPSC_DIV1;
  if (HAL_TIM_IC_ConfigChannel(&htim2, &ic, TIM_CHANNEL_2) != HAL_OK)
  {
    Error_Handler();
  }
}

void HAL_TIM_IC_MspInit(TIM_HandleTypeDef *htim)
{
  GPIO_InitTypeDef g = {0};
  if (htim->Instance == TIM2)
  {
    __HAL_RCC_TIM2_CLK_ENABLE();
    __HAL_RCC_GPIOB_CLK_ENABLE();
    g.Pin = GPIO_PIN_3; /* PB3 = D3 → TIM2_CH2 */
    g.Mode = GPIO_MODE_AF_PP;
    g.Pull = GPIO_PULLDOWN;
    g.Speed = GPIO_SPEED_FREQ_LOW;
    g.Alternate = GPIO_AF1_TIM2;
    HAL_GPIO_Init(GPIOB, &g);
    HAL_NVIC_SetPriority(TIM2_IRQn, 0, 0);
    HAL_NVIC_EnableIRQ(TIM2_IRQn);
  }
}

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef g = {0};
  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();
  HAL_GPIO_WritePin(GPIOA, GPIO_PIN_8, GPIO_PIN_RESET);
  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_4 | GPIO_PIN_5 | GPIO_PIN_10, GPIO_PIN_RESET);
  g.Mode = GPIO_MODE_OUTPUT_PP;
  g.Pull = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_HIGH;
  g.Pin = GPIO_PIN_8; /* TRIG */
  HAL_GPIO_Init(GPIOA, &g);
  g.Speed = GPIO_SPEED_FREQ_LOW;
  g.Pin = GPIO_PIN_4 | GPIO_PIN_5 | GPIO_PIN_10; /* LEDs */
  HAL_GPIO_Init(GPIOB, &g);
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
