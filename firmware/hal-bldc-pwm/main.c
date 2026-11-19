/*
 * CubeMX-style HAL example: a brushless (BLDC) motor with hall sensors,
 * commutated six-step through a 3-phase bridge by TIM1's complementary
 * PWM outputs with dead time; a pot sets the duty, so the speed.
 *
 *   D7 (PA8)   TIM1_CH1  -> INHA \
 *   D11 (PA7)  TIM1_CH1N -> INLA  \  high and low switch of each phase:
 *   D8 (PA9)   TIM1_CH2  -> INHB   } CHx and its complement CHxN, 500 ns
 *   A3 (PB0)   TIM1_CH2N -> INLB  /  of dead time between them
 *   D2 (PA10)  TIM1_CH3  -> INHC /   (OUTA -> U, OUTB -> V, OUTC -> W)
 *   PB1        TIM1_CH3N -> INLC     (Morpho CN10)
 *   D3 (PB3)   hall A \ open collector: the pins' pull-ups make the high
 *   D4 (PB5)   hall B  } level; EXTI on both edges
 *   D6 (PB10)  hall C /
 *   A0 (PA0)   pot wiper (ADC1): the PWM duty
 *   5V, GND    hall sensor supply;  12 V supply: + to PVDD, - to GND
 *   B1 (PC13)  break (EGR.BG): the outputs go idle, the motor coasts;
 *              press again to resume
 *
 * TIM1 runs at 84 MHz, 20 kHz edge-aligned PWM (ARR 4199). For each hall
 * sector one phase chops: CHx PWM high side and CHxN its complement (the
 * low side conducts while the high side is off), another phase has its
 * low side on (CHx forced inactive: CHxN on), the third is off (CCxE =
 * CCxNE = 0 with OSSR: both switches driven off). CR2.CCPC preloads the
 * modes and enables; the hall interrupt writes the next step and a COM
 * event (EGR.COMG) switches all three phases at once.
 *
 * Dead time (BDTR.DTG = 42: 42 x 11.9 ns = 500 ns): the switch that turns
 * on waits that long after the other turns off, so the two switches of a
 * phase are never on together (shoot-through). See it on the scope:
 * probe D7 and D11, trigger on D7 falling, 1 us/div.
 */
#include <stdio.h>
#include "main.h"

#define HA GPIO_PIN_3
#define HB GPIO_PIN_5
#define HC GPIO_PIN_10

#define PWM_PERIOD 4200 /* 84 MHz / 4200 = 20 kHz */
#define DEAD_TIME 42    /* DTG: 42 ticks of 1/84 MHz = 500 ns */
#define POLE_PAIRS 4

UART_HandleTypeDef huart2;
ADC_HandleTypeDef hadc1;
TIM_HandleTypeDef htim1;

static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);
static void MX_ADC1_Init(void);
static void MX_TIM1_Init(void);

/* For each hall code (C B A): the phase that chops (high side PWM) and
 * the phase whose low side is on; 0 and 7 cannot happen (all off). */
static const int8_t HIGH[8] = {-1, 1, 2, 1, 0, 0, 2, -1};
static const int8_t LOW[8] = {-1, 2, 0, 0, 1, 2, 1, -1};

static volatile uint32_t edges;
static volatile int b1_pressed;
static volatile int broken;

static unsigned hall_code(void)
{
  uint32_t idr = GPIOB->IDR;
  return ((idr & HA) != 0) | ((idr & HB) != 0) << 1 | ((idr & HC) != 0) << 2;
}

/* OCxM field and CCxE | CCxNE of phase p (channel p + 1). */
static void set_phase(uint32_t *ccmr1, uint32_t *ccmr2, uint32_t *ccer, int p, uint32_t mode, int on)
{
  if (p < 2)
  {
    *ccmr1 = (*ccmr1 & ~(TIM_CCMR1_OC1M << (8 * p))) | mode << (8 * p);
  }
  else
  {
    *ccmr2 = (*ccmr2 & ~TIM_CCMR2_OC3M) | mode;
  }
  uint32_t both = (TIM_CCER_CC1E | TIM_CCER_CC1NE) << (4 * p);
  *ccer = on ? *ccer | both : *ccer & ~both;
}

/* Write the step for the halls now (preloaded: CCPC) and commutate. */
static void commutate(void)
{
  unsigned code = hall_code();
  uint32_t ccmr1 = TIM1->CCMR1, ccmr2 = TIM1->CCMR2, ccer = TIM1->CCER;
  for (int p = 0; p < 3; p++)
  {
    if (p == HIGH[code])
    {
      set_phase(&ccmr1, &ccmr2, &ccer, p, TIM_OCMODE_PWM1, 1);
    }
    else if (p == LOW[code])
    {
      /* OCxREF low: CHx off, CHxN (low side) on. */
      set_phase(&ccmr1, &ccmr2, &ccer, p, TIM_OCMODE_FORCED_INACTIVE, 1);
    }
    else
    {
      set_phase(&ccmr1, &ccmr2, &ccer, p, TIM_OCMODE_PWM1, 0);
    }
  }
  TIM1->CCMR1 = ccmr1;
  TIM1->CCMR2 = ccmr2;
  TIM1->CCER = ccer;
  /* COM event: the preloaded modes and enables take effect together
   * (EGR.COMG written directly: HAL_TIM_GenerateEvent takes the handle's
   * lock, which the main loop may hold). */
  TIM1->EGR = TIM_EGR_COMG;
}

void HAL_GPIO_EXTI_Callback(uint16_t pin)
{
  if (pin == B1_Pin)
  {
    b1_pressed = 1;
    return;
  }
  commutate();
  edges++;
}

void HAL_TIMEx_BreakCallback(TIM_HandleTypeDef *htim)
{
  (void)htim;
  broken = 1;
}

void EXTI3_IRQHandler(void)
{
  HAL_GPIO_EXTI_IRQHandler(HA);
}

void EXTI9_5_IRQHandler(void)
{
  HAL_GPIO_EXTI_IRQHandler(HB);
}

void EXTI15_10_IRQHandler(void)
{
  HAL_GPIO_EXTI_IRQHandler(HC);
  HAL_GPIO_EXTI_IRQHandler(B1_Pin);
}

void TIM1_BRK_TIM9_IRQHandler(void)
{
  HAL_TIM_IRQHandler(&htim1);
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

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  MX_ADC1_Init();
  MX_TIM1_Init();
  printf("BLDC PWM: TIM1 CH1-3 D7 D8 D2, CH1N-3N D11 A3 PB1, 20 kHz, dead time %d ns; halls D3 D4 D6; pot A0\r\n",
         DEAD_TIME * 1000 / 84);
  /* All six outputs on (the step decides which drive), MOE set. */
  for (uint32_t ch = TIM_CHANNEL_1; ch <= TIM_CHANNEL_3; ch += 4)
  {
    HAL_TIM_PWM_Start(&htim1, ch);
    HAL_TIMEx_PWMN_Start(&htim1, ch);
  }
  commutate();

  uint32_t last = HAL_GetTick(), counted = 0, duty;
  int running = 1;
  while (1)
  {
    if (broken)
    {
      broken = 0;
      printf("break: BIF set, MOE off - outputs idle, the motor coasts\r\n");
    }
    if (b1_pressed)
    {
      b1_pressed = 0;
      running = !running;
      if (running)
      {
        __HAL_TIM_MOE_ENABLE(&htim1);
        printf("resumed: MOE on\r\n");
      }
      else
      {
        /* Software break: EGR.BG clears MOE and sets BIF. */
        HAL_TIM_GenerateEvent(&htim1, TIM_EVENTSOURCE_BREAK);
      }
    }
    /* Duty from the pot; preloaded, it takes effect at the next update. */
    uint32_t pot = read_pot();
    duty = pot * 100 / 4095;
    uint32_t ccr = pot * PWM_PERIOD / 4095;
    __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_1, ccr);
    __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_2, ccr);
    __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_3, ccr);
    uint32_t t = HAL_GetTick();
    if (t - last >= 500)
    {
      uint32_t e = edges;
      /* Six hall edges per electrical turn, POLE_PAIRS of those per turn. */
      uint32_t rpm = (e - counted) * 60 * 1000 / (t - last) / (6 * POLE_PAIRS);
      counted = e;
      last = t;
      printf("%s duty %3lu %%  rpm %lu\r\n", running ? "run  " : "break", (unsigned long)duty, (unsigned long)rpm);
    }
    HAL_Delay(20);
  }
}

/* ------------------------------------------------------- peripherals */

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef g = {0};
  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOC_CLK_ENABLE();
  /* Halls: open collector, so pull-ups; interrupts on both edges. */
  g.Pin = HA | HB | HC;
  g.Mode = GPIO_MODE_IT_RISING_FALLING;
  g.Pull = GPIO_PULLUP;
  HAL_GPIO_Init(GPIOB, &g);
  g.Pin = B1_Pin;
  g.Mode = GPIO_MODE_IT_FALLING;
  g.Pull = GPIO_NOPULL;
  HAL_GPIO_Init(B1_GPIO_Port, &g);
  HAL_NVIC_SetPriority(EXTI3_IRQn, 0, 0);
  HAL_NVIC_EnableIRQ(EXTI3_IRQn);
  HAL_NVIC_SetPriority(EXTI9_5_IRQn, 0, 0);
  HAL_NVIC_EnableIRQ(EXTI9_5_IRQn);
  HAL_NVIC_SetPriority(EXTI15_10_IRQn, 0, 0);
  HAL_NVIC_EnableIRQ(EXTI15_10_IRQn);
}

static void MX_TIM1_Init(void)
{
  TIM_OC_InitTypeDef oc = {0};
  TIM_BreakDeadTimeConfigTypeDef bdt = {0};
  htim1.Instance = TIM1;
  htim1.Init.Prescaler = 0;
  htim1.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim1.Init.Period = PWM_PERIOD - 1;
  htim1.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1; /* tDTS = 1/84 MHz */
  htim1.Init.RepetitionCounter = 0;
  htim1.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_ENABLE;
  if (HAL_TIM_PWM_Init(&htim1) != HAL_OK)
  {
    Error_Handler();
  }
  oc.OCMode = TIM_OCMODE_PWM1;
  oc.Pulse = PWM_PERIOD / 2;
  oc.OCPolarity = TIM_OCPOLARITY_HIGH;
  oc.OCNPolarity = TIM_OCNPOLARITY_HIGH;
  oc.OCFastMode = TIM_OCFAST_DISABLE;
  oc.OCIdleState = TIM_OCIDLESTATE_RESET;   /* OISx = 0: off at a break */
  oc.OCNIdleState = TIM_OCNIDLESTATE_RESET; /* OISxN = 0 */
  for (uint32_t ch = TIM_CHANNEL_1; ch <= TIM_CHANNEL_3; ch += 4)
  {
    if (HAL_TIM_PWM_ConfigChannel(&htim1, &oc, ch) != HAL_OK)
    {
      Error_Handler();
    }
  }
  /* Off-state outputs driven inactive (OSSR, OSSI), dead time, no BKIN
   * pin (B1 breaks in software), MOE only set again by the firmware. */
  bdt.OffStateRunMode = TIM_OSSR_ENABLE;
  bdt.OffStateIDLEMode = TIM_OSSI_ENABLE;
  bdt.LockLevel = TIM_LOCKLEVEL_OFF;
  bdt.DeadTime = DEAD_TIME;
  bdt.BreakState = TIM_BREAK_DISABLE;
  bdt.BreakPolarity = TIM_BREAKPOLARITY_HIGH;
  bdt.AutomaticOutput = TIM_AUTOMATICOUTPUT_DISABLE;
  if (HAL_TIMEx_ConfigBreakDeadTime(&htim1, &bdt) != HAL_OK)
  {
    Error_Handler();
  }
  /* CCPC: modes and enables preloaded, taken over at a software COM. */
  if (HAL_TIMEx_ConfigCommutEvent(&htim1, TIM_TS_NONE, TIM_COMMUTATION_SOFTWARE) != HAL_OK)
  {
    Error_Handler();
  }
  /* The break interrupt (TIM1_BRK_TIM9, IRQ 24). */
  __HAL_TIM_ENABLE_IT(&htim1, TIM_IT_BREAK);
  HAL_NVIC_SetPriority(TIM1_BRK_TIM9_IRQn, 1, 0);
  HAL_NVIC_EnableIRQ(TIM1_BRK_TIM9_IRQn);
}

void HAL_TIM_PWM_MspInit(TIM_HandleTypeDef *htim)
{
  if (htim->Instance == TIM1)
  {
    GPIO_InitTypeDef g = {0};
    __HAL_RCC_TIM1_CLK_ENABLE();
    __HAL_RCC_GPIOA_CLK_ENABLE();
    __HAL_RCC_GPIOB_CLK_ENABLE();
    g.Mode = GPIO_MODE_AF_PP;
    g.Pull = GPIO_NOPULL;
    g.Speed = GPIO_SPEED_FREQ_HIGH;
    g.Alternate = GPIO_AF1_TIM1;
    /* PA8, PA9, PA10 = CH1-CH3; PA7 = CH1N */
    g.Pin = GPIO_PIN_7 | GPIO_PIN_8 | GPIO_PIN_9 | GPIO_PIN_10;
    HAL_GPIO_Init(GPIOA, &g);
    /* PB0 = CH2N, PB1 = CH3N */
    g.Pin = GPIO_PIN_0 | GPIO_PIN_1;
    HAL_GPIO_Init(GPIOB, &g);
  }
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
