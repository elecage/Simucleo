/*
 * CubeMX-style HAL example: a sensorless BLDC (no hall sensors),
 * commutated six-step from the back-EMF zero crossings of the floating
 * phase. TIM1 makes 20 kHz center-aligned complementary PWM with dead
 * time; a pot sets the duty, so the speed.
 *
 *   D7 (PA8)   TIM1_CH1  -> INHA \
 *   D11 (PA7)  TIM1_CH1N -> INLA  \  high and low switch of each phase
 *   D8 (PA9)   TIM1_CH2  -> INHB   } (OUTA -> U, OUTB -> V, OUTC -> W)
 *   A3 (PB0)   TIM1_CH2N -> INLB  /  500 ns of dead time
 *   D2 (PA10)  TIM1_CH3  -> INHC /
 *   PB1        TIM1_CH3N -> INLC     (Morpho CN10)
 *   A1 (PA1)   U sense \  each phase through 10k / 2.2k to GND (12 V
 *   A2 (PA4)   V sense  } becomes 2.2 V); the three sense points joined
 *   A4 (PC1)   W sense /  by 10k each make a virtual neutral:
 *   A5 (PC0)   neutral    the motor's star point, as seen by the ADC
 *   A0 (PA0)   pot wiper: the duty
 *   12 V supply: + to PVDD, - to GND
 *
 * TIM1 counts up and down (center-aligned mode 1, ARR 2100: 84 MHz /
 * 4200 = 20 kHz), so each high-side pulse is centred on the underflow.
 * The repetition counter (RCR = 1) makes one update event per PWM period,
 * at the underflow: the middle of the on-time, when the floating phase's
 * voltage is clean. The update interrupt starts an ADC conversion there:
 * the floating phase and the neutral in turn (and the pot now and then).
 *
 * The floating phase sits at the star point plus its back-EMF, so
 * (phase - neutral) changes sign in the middle of each 60 degree sector:
 * the zero crossing. 30 degrees later is the time to commutate - as long
 * as from the last commutation to the crossing - so TIM2 (one-pulse,
 * 1 us ticks) is set to that delay and its interrupt commutates.
 *
 * At rest there is no back-EMF: the firmware first aligns the rotor (one
 * step for 300 ms), then ramps it open-loop (steps ever closer together)
 * and switches to the zero crossings once fast enough. States: align,
 * ramp, closed. Probe OUTA/OUTB/OUTC and mot.U on the scope's analog
 * channels to see the back-EMF slopes between the PWM.
 */
#include <stdio.h>
#include "main.h"

#define PWM_ARR 2100      /* center-aligned: 84 MHz / (2 x 2100) = 20 kHz */
#define DEAD_TIME 42      /* 500 ns */
#define POLE_PAIRS 4
#define ALIGN_MS 500
#define RAMP_START_US 20000
#define RAMP_END_US 4000
#define OPEN_DUTY 30      /* % while aligning and ramping */

/* ADC channels: U, V, W sense, neutral, pot. */
#define CH_U 1
#define CH_V 4
#define CH_W 11
#define CH_N 10
#define CH_POT 0

UART_HandleTypeDef huart2;
ADC_HandleTypeDef hadc1;
TIM_HandleTypeDef htim1;

static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);
static void MX_ADC1_Init(void);
static void MX_TIM1_Init(void);
static void MX_TIM2_TIM5_Init(void);

/* The six steps: phase to the supply (PWM), phase to ground, the floating
 * phase and whether its back-EMF rises through the neutral. */
static const int8_t HIGH[6] = {0, 1, 1, 2, 2, 0};
static const int8_t LOW[6] = {2, 2, 0, 0, 1, 1};
static const int8_t FLOAT[6] = {1, 0, 2, 1, 0, 2};
static const uint8_t RISING[6] = {1, 0, 1, 0, 1, 0};
static const uint8_t SENSE_CH[3] = {CH_U, CH_V, CH_W};

enum { ALIGN, RAMP, CLOSED };
static const char *const STATE[] = {"align", "ramp", "closed"};
static volatile int state = ALIGN;
static volatile int step;
static volatile uint32_t ramp_us = RAMP_START_US;
/* Commutations: when the last was (TIM5, us), the step time (averaged),
 * a zero crossing seen in this step, counts. */
static volatile uint32_t comm_at, step_us = RAMP_START_US;
static volatile int zc_seen;
static volatile uint32_t commutations, crossings, misses;
/* ADC: the latest of each channel, the conversion going on. */
static volatile uint16_t sense[16];
static int conv_ch = -1, conv_step;
static uint32_t isr_n;

/* Wait, sleeping between interrupts (WFI): the 20 kHz update interrupt
 * would otherwise keep the core busy polling the tick. */
static void sleep_ms(uint32_t ms)
{
  uint32_t t0 = HAL_GetTick();
  while (HAL_GetTick() - t0 < ms)
  {
    __WFI();
  }
}

static uint32_t micros(void)
{
  return TIM5->CNT;
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

/* Drive step s (preloaded: CCPC) and take it over at once (COM). */
static void apply_step(int s)
{
  uint32_t ccmr1 = TIM1->CCMR1, ccmr2 = TIM1->CCMR2, ccer = TIM1->CCER;
  for (int p = 0; p < 3; p++)
  {
    if (p == HIGH[s])
    {
      set_phase(&ccmr1, &ccmr2, &ccer, p, TIM_OCMODE_PWM1, 1);
    }
    else if (p == LOW[s])
    {
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
  TIM1->EGR = TIM_EGR_COMG;
}

/* Next step, and note the time. */
static void commutate(void)
{
  uint32_t now = micros();
  uint32_t took = now - comm_at;
  comm_at = now;
  /* Average the step time over a few steps. */
  step_us = (3 * step_us + took) / 4;
  step = (step + 1) % 6;
  apply_step(step);
  zc_seen = 0;
  commutations++;
}

/* TIM2 (one-pulse) fires after `us`. */
static void after_us(uint32_t us)
{
  TIM2->CR1 &= ~TIM_CR1_CEN;
  TIM2->CNT = 0;
  TIM2->ARR = us > 1 ? us : 1;
  TIM2->SR = 0;
  TIM2->CR1 |= TIM_CR1_CEN;
}

static void set_duty(uint32_t percent)
{
  uint32_t ccr = percent * PWM_ARR / 100;
  TIM1->CCR1 = ccr;
  TIM1->CCR2 = ccr;
  TIM1->CCR3 = ccr;
}

/* The 30 degree delay is over (or a ramp step is due): commutate. */
void TIM2_IRQHandler(void)
{
  if (!(TIM2->SR & TIM_SR_UIF))
  {
    return;
  }
  TIM2->SR = ~TIM_SR_UIF;
  commutate();
  if (state == RAMP)
  {
    ramp_us = ramp_us * 31 / 32;
    if (ramp_us <= RAMP_END_US)
    {
      /* Fast enough: the zero crossings take over. */
      state = CLOSED;
      step_us = ramp_us;
    }
    else
    {
      after_us(ramp_us);
    }
  }
}

/* The floating phase against the neutral, sampled in step s. */
static void zero_crossing(int s, int diff)
{
  if (state != CLOSED || s != step || zc_seen)
  {
    return;
  }
  uint32_t since = micros() - comm_at;
  /* Blank the start of the step (the current dying in the phase that
   * just stopped). */
  if (since < step_us / 4 || since < 100)
  {
    return;
  }
  if ((diff > 0) == RISING[s])
  {
    zc_seen = 1;
    crossings++;
    /* The crossing is 30 degrees into the step: as long again to go
     * (less half a sample period of detection lag). */
    after_us(since > 50 ? since - 50 : 1);
  }
}

/* Once per PWM period (RCR = 1), at the underflow: the middle of the
 * on-time. Collect the last conversion, start the next. */
void TIM1_UP_TIM10_IRQHandler(void)
{
  if (!(TIM1->SR & TIM_SR_UIF))
  {
    return;
  }
  TIM1->SR = ~TIM_SR_UIF;
  isr_n++;
  if (conv_ch >= 0 && (ADC1->SR & ADC_SR_EOC))
  {
    uint16_t v = ADC1->DR;
    sense[conv_ch] = v;
    if (conv_ch == SENSE_CH[FLOAT[conv_step]])
    {
      zero_crossing(conv_step, (int)v - (int)sense[CH_N]);
    }
  }
  int next;
  if ((isr_n & 63) == 0)
  {
    next = CH_POT;
  }
  else if (isr_n & 1)
  {
    next = SENSE_CH[FLOAT[step]];
  }
  else
  {
    next = CH_N;
  }
  conv_ch = next;
  conv_step = step;
  ADC1->SQR3 = next;
  ADC1->CR2 |= ADC_CR2_SWSTART;
  /* No crossing for two steps: commutate anyway (and count it). */
  if (state == CLOSED && !zc_seen && micros() - comm_at > 2 * step_us)
  {
    misses++;
    commutate();
  }
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  MX_ADC1_Init();
  MX_TIM2_TIM5_Init();
  MX_TIM1_Init();
  printf("BLDC sensorless: TIM1 center-aligned 20 kHz, RCR 1, dead time %d ns; sense A1 A2 A4, neutral A5; pot A0\r\n",
         DEAD_TIME * 1000 / 84);
  for (uint32_t ch = TIM_CHANNEL_1; ch <= TIM_CHANNEL_3; ch += 4)
  {
    HAL_TIM_PWM_Start(&htim1, ch);
    HAL_TIMEx_PWMN_Start(&htim1, ch);
  }
  /* The update interrupt: one per PWM period. */
  TIM1->SR = 0;
  __HAL_TIM_ENABLE_IT(&htim1, TIM_IT_UPDATE);

  /* Align: hold step 0 so the rotor settles where it is known. */
  set_duty(OPEN_DUTY);
  step = 0;
  apply_step(step);
  comm_at = micros();
  sleep_ms(ALIGN_MS);
  /* Ramp open-loop: TIM2 steps it ever faster. */
  state = RAMP;
  after_us(ramp_us);

  uint32_t last = HAL_GetTick(), counted = 0;
  while (1)
  {
    if (state == CLOSED)
    {
      /* The pot sets the duty: 15-95 %. */
      set_duty(15 + sense[CH_POT] * 80 / 4095);
      /* Lost the rotor (many steps without a crossing): start again. */
      if (misses > 12)
      {
        printf("lost the rotor - align again\r\n");
        TIM2->CR1 &= ~TIM_CR1_CEN;
        state = ALIGN;
        misses = 0;
        set_duty(OPEN_DUTY);
        sleep_ms(ALIGN_MS);
        ramp_us = RAMP_START_US;
        step_us = RAMP_START_US;
        comm_at = micros();
        state = RAMP;
        after_us(ramp_us);
      }
    }
    uint32_t t = HAL_GetTick();
    if (t - last >= 500)
    {
      uint32_t c = commutations;
      /* Six commutations per electrical turn, POLE_PAIRS of those per turn. */
      uint32_t rpm = (c - counted) * 60 * 1000 / (t - last) / (6 * POLE_PAIRS);
      counted = c;
      last = t;
      uint32_t duty = TIM1->CCR1 * 100 / PWM_ARR;
      printf("%-6s duty %3lu %%  rpm %lu  zc %lu\r\n", STATE[state], (unsigned long)duty,
             (unsigned long)rpm, (unsigned long)crossings);
    }
    sleep_ms(20);
  }
}

/* ------------------------------------------------------- peripherals */

static void MX_GPIO_Init(void)
{
  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOC_CLK_ENABLE();
}

static void MX_TIM1_Init(void)
{
  TIM_OC_InitTypeDef oc = {0};
  TIM_BreakDeadTimeConfigTypeDef bdt = {0};
  htim1.Instance = TIM1;
  htim1.Init.Prescaler = 0;
  /* Up and down: pulses centred on the underflow. */
  htim1.Init.CounterMode = TIM_COUNTERMODE_CENTERALIGNED1;
  htim1.Init.Period = PWM_ARR;
  htim1.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  /* One update event per period (two half periods): at the underflow. */
  htim1.Init.RepetitionCounter = 1;
  htim1.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_ENABLE;
  if (HAL_TIM_PWM_Init(&htim1) != HAL_OK)
  {
    Error_Handler();
  }
  oc.OCMode = TIM_OCMODE_PWM1;
  oc.Pulse = 0;
  oc.OCPolarity = TIM_OCPOLARITY_HIGH;
  oc.OCNPolarity = TIM_OCNPOLARITY_HIGH;
  oc.OCFastMode = TIM_OCFAST_DISABLE;
  oc.OCIdleState = TIM_OCIDLESTATE_RESET;
  oc.OCNIdleState = TIM_OCNIDLESTATE_RESET;
  for (uint32_t ch = TIM_CHANNEL_1; ch <= TIM_CHANNEL_3; ch += 4)
  {
    if (HAL_TIM_PWM_ConfigChannel(&htim1, &oc, ch) != HAL_OK)
    {
      Error_Handler();
    }
  }
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
  if (HAL_TIMEx_ConfigCommutEvent(&htim1, TIM_TS_NONE, TIM_COMMUTATION_SOFTWARE) != HAL_OK)
  {
    Error_Handler();
  }
  HAL_NVIC_SetPriority(TIM1_UP_TIM10_IRQn, 1, 0);
  HAL_NVIC_EnableIRQ(TIM1_UP_TIM10_IRQn);
}

/* TIM2: the 30 degree delay (one-pulse, 1 us ticks, update interrupt).
 * TIM5: a free-running microsecond clock. */
static void MX_TIM2_TIM5_Init(void)
{
  __HAL_RCC_TIM2_CLK_ENABLE();
  __HAL_RCC_TIM5_CLK_ENABLE();
  TIM5->PSC = 83;
  TIM5->ARR = 0xFFFFFFFF;
  TIM5->EGR = TIM_EGR_UG;
  TIM5->CR1 = TIM_CR1_CEN;
  TIM2->PSC = 83;
  TIM2->CR1 = TIM_CR1_OPM | TIM_CR1_URS; /* UG sets no flag */
  TIM2->EGR = TIM_EGR_UG;
  TIM2->SR = 0;
  TIM2->DIER = TIM_DIER_UIE;
  HAL_NVIC_SetPriority(TIM2_IRQn, 1, 0);
  HAL_NVIC_EnableIRQ(TIM2_IRQn);
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
  /* Short sampling (15 cycles): the conversion is over within a
   * microsecond, inside the on-time. */
  const uint32_t chans[] = {ADC_CHANNEL_0, ADC_CHANNEL_1, ADC_CHANNEL_4, ADC_CHANNEL_10, ADC_CHANNEL_11};
  for (unsigned i = 0; i < sizeof chans / sizeof chans[0]; i++)
  {
    ch.Channel = chans[i];
    ch.Rank = 1;
    ch.SamplingTime = ADC_SAMPLETIME_15CYCLES;
    if (HAL_ADC_ConfigChannel(&hadc1, &ch) != HAL_OK)
    {
      Error_Handler();
    }
  }
  __HAL_ADC_ENABLE(&hadc1);
}

void HAL_ADC_MspInit(ADC_HandleTypeDef *hadc)
{
  if (hadc->Instance == ADC1)
  {
    GPIO_InitTypeDef g = {0};
    __HAL_RCC_ADC1_CLK_ENABLE();
    __HAL_RCC_GPIOA_CLK_ENABLE();
    __HAL_RCC_GPIOC_CLK_ENABLE();
    g.Mode = GPIO_MODE_ANALOG;
    g.Pull = GPIO_NOPULL;
    g.Pin = GPIO_PIN_0 | GPIO_PIN_1 | GPIO_PIN_4; /* A0, A1, A2 */
    HAL_GPIO_Init(GPIOA, &g);
    g.Pin = GPIO_PIN_0 | GPIO_PIN_1; /* A5 = PC0, A4 = PC1 */
    HAL_GPIO_Init(GPIOC, &g);
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
