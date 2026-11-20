/*
 * SWV (Serial Wire Viewer) example: what STM32CubeIDE shows through the SWO
 * pin while the program runs, without stopping it.
 *
 *   ITM port 0  printf-style text (ITM_SendChar, as CubeIDE's "SWV ITM Data
 *               Console" expects); nothing is sent until the debugger
 *               enables the trace (DEMCR.TRCENA, ITM TCR/TER)
 *   ITM port 1  the loop count as a 32-bit word every 100 ms
 *   wave        a triangle wave updated every 5 ms: watch it in the data
 *               trace graph (DWT comparator on its address)
 *   TIM2        an update interrupt every 1 ms (exception trace: TIM2_IRQn
 *               enters and exits 1000 times a second)
 *   filter()    deliberately slow work in the main loop: the statistical
 *               profile (PC sampling) shows where the time goes
 *
 * LD2 toggles every 500 ms; USART2 says once that the output is on ITM.
 */
#include <stdarg.h>
#include <stdio.h>
#include "main.h"

UART_HandleTypeDef huart2;
TIM_HandleTypeDef htim2;

volatile int32_t wave;          /* traced variable: triangle −100…100 */
volatile uint32_t ms_ticks;     /* TIM2 interrupts so far */
volatile uint32_t filtered;     /* result of filter(), so it is not optimized away */

static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);
static void MX_TIM2_Init(void);

/* printf to ITM stimulus port 0. */
static void itm_printf(const char *fmt, ...)
{
  char buf[96];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(buf, sizeof buf, fmt, ap);
  va_end(ap);
  for (int i = 0; i < n && i < (int)sizeof buf - 1; i++)
  {
    ITM_SendChar((uint32_t)buf[i]);
  }
}

/* A 32-bit word to ITM stimulus port 1 (as ITM_SendChar does for port 0). */
static void itm_send_word(uint32_t port, uint32_t value)
{
  if ((ITM->TCR & ITM_TCR_ITMENA_Msk) && (ITM->TER & (1UL << port)))
  {
    while (ITM->PORT[port].u32 == 0UL)
    {
      __NOP();
    }
    ITM->PORT[port].u32 = value;
  }
}

/* Deliberately slow: a moving-average over a table, recomputed each time. */
static uint32_t __attribute__((noinline)) filter(uint32_t seed)
{
  uint32_t acc = 0;
  for (uint32_t i = 0; i < 2000; i++)
  {
    acc += (seed ^ i) * 2654435761u >> 7;
  }
  return acc / 2000;
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  MX_TIM2_Init();
  if (HAL_TIM_Base_Start_IT(&htim2) != HAL_OK)
  {
    Error_Handler();
  }
  printf("hal-swv-trace: output on ITM port 0 (open the SWV tab)\r\n");

  uint32_t loops = 0;
  int32_t step = 4;
  uint32_t last_print = 0, last_wave = 0, last_led = 0;
  while (1)
  {
    uint32_t now = HAL_GetTick();
    if (now - last_wave >= 5)
    {
      last_wave = now;
      wave += step;
      if (wave >= 100 || wave <= -100)
      {
        step = -step;
      }
    }
    if (now - last_print >= 100)
    {
      last_print = now;
      itm_printf("loop %lu: wave %ld, %lu ms\n", (unsigned long)loops, (long)wave, (unsigned long)ms_ticks);
      itm_send_word(1, loops);
    }
    if (now - last_led >= 500)
    {
      last_led = now;
      HAL_GPIO_TogglePin(LD2_GPIO_Port, LD2_Pin);
    }
    filtered = filter(loops);
    loops++;
    __WFI(); /* sleep until the next TIM2 or SysTick interrupt */
  }
}

/* Every 1 ms. */
void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)
{
  if (htim->Instance == TIM2)
  {
    ms_ticks++;
  }
}

void TIM2_IRQHandler(void)
{
  HAL_TIM_IRQHandler(&htim2);
}

static void MX_TIM2_Init(void)
{
  __HAL_RCC_TIM2_CLK_ENABLE();
  htim2.Instance = TIM2;
  htim2.Init.Prescaler = 84 - 1; /* 1 MHz */
  htim2.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim2.Init.Period = 1000 - 1; /* 1 ms */
  htim2.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim2.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_DISABLE;
  if (HAL_TIM_Base_Init(&htim2) != HAL_OK)
  {
    Error_Handler();
  }
  HAL_NVIC_SetPriority(TIM2_IRQn, 1, 0);
  HAL_NVIC_EnableIRQ(TIM2_IRQn);
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

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};

  __HAL_RCC_GPIOA_CLK_ENABLE();
  HAL_GPIO_WritePin(LD2_GPIO_Port, LD2_Pin, GPIO_PIN_RESET);
  GPIO_InitStruct.Pin = LD2_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(LD2_GPIO_Port, &GPIO_InitStruct);
}
