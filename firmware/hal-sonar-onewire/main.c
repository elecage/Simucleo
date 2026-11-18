/*
 * CubeMX-style HAL example: an ultrasonic distance sensor and a 1-Wire
 * thermometer, both timed in microseconds.
 *
 *   D7 (PA8)             HC-SR04 TRIG: a 12 µs pulse starts a measurement
 *   D3 (PB3, TIM2_CH2)   HC-SR04 ECHO: input capture on both edges, 1 µs
 *   D2 (PA10)            DS18B20 DQ, open-drain (4.7 kΩ pull-up on the module)
 *
 * The 1-Wire slots are bit-banged with the DWT cycle counter for delays:
 * reset 480 µs low, presence sampled 70 µs after the release, write slots
 * 6 µs (1) or 60 µs (0) low, read slots 6 µs low then sampled 9 µs later.
 * Every second: SKIP ROM + CONVERT T, distance, then READ SCRATCHPAD.
 */
#include <stdio.h>
#include "main.h"

UART_HandleTypeDef huart2;
TIM_HandleTypeDef htim2;

static volatile uint32_t rise, width;
static volatile int edges;

static void MX_GPIO_Init(void);
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

/* ---------------------------------------------------------- 1-Wire */

#define DQ_LOW() (GPIOA->BSRR = GPIO_PIN_10 << 16)
#define DQ_RELEASE() (GPIOA->BSRR = GPIO_PIN_10)
#define DQ_READ() ((GPIOA->IDR & GPIO_PIN_10) != 0)

static int ow_reset(void)
{
  DQ_LOW();
  delay_us(480);
  DQ_RELEASE();
  delay_us(70);
  int present = !DQ_READ();
  delay_us(410);
  return present;
}

static void ow_write(uint8_t b)
{
  for (int i = 0; i < 8; i++, b >>= 1)
  {
    __disable_irq();
    DQ_LOW();
    if (b & 1)
    {
      delay_us(6);
      DQ_RELEASE();
      delay_us(64);
    }
    else
    {
      delay_us(60);
      DQ_RELEASE();
      delay_us(10);
    }
    __enable_irq();
  }
}

static uint8_t ow_read(void)
{
  uint8_t b = 0;
  for (int i = 0; i < 8; i++)
  {
    __disable_irq();
    DQ_LOW();
    delay_us(6);
    DQ_RELEASE();
    delay_us(9);
    if (DQ_READ())
    {
      b |= 1 << i;
    }
    __enable_irq();
    delay_us(55);
  }
  return b;
}

static uint8_t crc8(const uint8_t *p, int n)
{
  uint8_t crc = 0;
  while (n--)
  {
    uint8_t x = *p++;
    for (int i = 0; i < 8; i++, x >>= 1)
    {
      uint8_t mix = (crc ^ x) & 1;
      crc >>= 1;
      if (mix)
      {
        crc ^= 0x8C;
      }
    }
  }
  return crc;
}

/* --------------------------------------------------------- HC-SR04 */

void HAL_TIM_IC_CaptureCallback(TIM_HandleTypeDef *htim)
{
  if (htim->Instance == TIM2 && htim->Channel == HAL_TIM_ACTIVE_CHANNEL_2)
  {
    uint32_t t = HAL_TIM_ReadCapturedValue(htim, TIM_CHANNEL_2);
    if (GPIOB->IDR & GPIO_PIN_3)
    {
      rise = t;
    }
    else
    {
      width = t - rise;
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
  while (edges < 2 && HAL_GetTick() - start < 50)
  {
  }
  if (edges < 2)
  {
    return -1;
  }
  return (int)((width * 10 + 29) / 58); /* rounded */
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  MX_TIM2_Init();
  dwt_init();
  HAL_TIM_IC_Start_IT(&htim2, TIM_CHANNEL_2);
  printf("HC-SR04 on D7/D3, DS18B20 on D2\r\n");

  if (ow_reset())
  {
    ow_write(0x33); /* READ ROM */
    uint8_t rom[8];
    for (int i = 0; i < 8; i++)
    {
      rom[i] = ow_read();
    }
    printf("DS18B20 ROM %02X-%02X%02X%02X%02X%02X%02X CRC %s\r\n", rom[0], rom[6], rom[5], rom[4], rom[3], rom[2],
           rom[1], crc8(rom, 8) == 0 ? "ok" : "bad");
  }
  else
  {
    printf("no 1-Wire device\r\n");
  }

  while (1)
  {
    int have_temp = ow_reset();
    if (have_temp)
    {
      ow_write(0xCC);
      ow_write(0x44); /* convert: 750 ms at 12 bits */
    }
    int mm = sonar_mm();
    HAL_Delay(800);
    int t16 = 0, ok = 0;
    if (have_temp && ow_reset())
    {
      ow_write(0xCC);
      ow_write(0xBE);
      uint8_t pad[9];
      for (int i = 0; i < 9; i++)
      {
        pad[i] = ow_read();
      }
      ok = crc8(pad, 9) == 0;
      t16 = (int16_t)(pad[1] << 8 | pad[0]);
    }
    if (mm < 0)
    {
      printf("distance: no echo");
    }
    else
    {
      printf("distance %d.%d cm", mm / 10, mm % 10);
    }
    if (ok)
    {
      int t100 = t16 * 100 / 16;
      printf(" | temperature %s%d.%02d C\r\n", t100 < 0 ? "-" : "", (t100 < 0 ? -t100 : t100) / 100,
             (t100 < 0 ? -t100 : t100) % 100);
    }
    else
    {
      printf(" | temperature: %s\r\n", have_temp ? "CRC error" : "no sensor");
    }
    HAL_Delay(200);
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
    g.Pin = GPIO_PIN_3;
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
  HAL_GPIO_WritePin(GPIOA, GPIO_PIN_8, GPIO_PIN_RESET);
  DQ_RELEASE();
  g.Pin = GPIO_PIN_8;
  g.Mode = GPIO_MODE_OUTPUT_PP;
  g.Pull = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_HIGH;
  HAL_GPIO_Init(GPIOA, &g);
  g.Pin = GPIO_PIN_10;
  g.Mode = GPIO_MODE_OUTPUT_OD;
  HAL_GPIO_Init(GPIOA, &g);
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
