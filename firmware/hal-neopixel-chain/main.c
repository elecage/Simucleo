/*
 * CubeMX-style HAL example: a NeoPixel ring with a strip chained on its
 * DOUT, driven by timer PWM and DMA as one chain of 20 LEDs.
 *
 *   D5 (PB4, TIM3_CH1)  DIN of a 12-LED ring (5V, GND)
 *   ring DOUT           DIN of an 8-LED strip (5V, GND)
 *
 * Every WS2812B keeps the first 24 bits it receives and passes the rest
 * on through DOUT, so the ring takes LEDs 0–11 and the strip LEDs 12–19
 * of the same frame: the firmware just sends 20 colours.
 *
 * TIM3 runs at 84 MHz with a period of 105 ticks (800 kHz, 1.25 µs per
 * bit). Every bit is one PWM period: 34 ticks high (0.4 µs) for a 0, 67
 * ticks (0.8 µs) for a 1. DMA1 stream 4 (channel 5, TIM3_CH1) copies the
 * next duty value into CCR1 at every compare event, so the CPU only
 * prepares the buffer: 24 bits per LED in G, R, B order, then 50 periods
 * low (≥ 50 µs) to latch.
 *
 * A rainbow turns around the ring while a comet runs along the strip;
 * B1 changes the brightness.
 */
#include <stdio.h>
#include "main.h"

#define RING 12
#define STRIP 8
#define LEDS (RING + STRIP)
#define T0H 34
#define T1H 67
#define RESET_SLOTS 50

UART_HandleTypeDef huart2;
TIM_HandleTypeDef htim3;
DMA_HandleTypeDef hdma_tim3_ch1;

static uint16_t pwm[LEDS * 24 + RESET_SLOTS];
static volatile int busy;

static void MX_GPIO_Init(void);
static void MX_DMA_Init(void);
static void MX_TIM3_Init(void);
static void MX_USART2_UART_Init(void);

/* Hue 0–255 → RGB at full saturation, scaled by `level` (0–255). */
static uint32_t wheel(uint8_t hue, uint8_t level)
{
  uint8_t r, g, b;
  if (hue < 85)
  {
    r = 255 - hue * 3, g = hue * 3, b = 0;
  }
  else if (hue < 170)
  {
    hue -= 85;
    r = 0, g = 255 - hue * 3, b = hue * 3;
  }
  else
  {
    hue -= 170;
    r = hue * 3, g = 0, b = 255 - hue * 3;
  }
  r = r * level / 255, g = g * level / 255, b = b * level / 255;
  return (uint32_t)r << 16 | (uint32_t)g << 8 | b;
}

static void show(const uint32_t *rgb)
{
  /* The previous frame must be out before the buffer is reused. */
  while (busy)
  {
  }
  uint16_t *p = pwm;
  for (int i = 0; i < LEDS; i++)
  {
    /* The wire order is green, red, blue, most significant bit first. */
    uint32_t grb = (rgb[i] >> 8 & 0xFF) << 16 | (rgb[i] >> 16 & 0xFF) << 8 | (rgb[i] & 0xFF);
    for (int bit = 23; bit >= 0; bit--)
    {
      *p++ = (grb >> bit) & 1 ? T1H : T0H;
    }
  }
  for (int i = 0; i < RESET_SLOTS; i++)
  {
    *p++ = 0;
  }
  busy = 1;
  if (HAL_TIM_PWM_Start_DMA(&htim3, TIM_CHANNEL_1, (uint32_t *)pwm, sizeof pwm / sizeof pwm[0]) != HAL_OK)
  {
    Error_Handler();
  }
}

void HAL_TIM_PWM_PulseFinishedCallback(TIM_HandleTypeDef *htim)
{
  if (htim->Instance == TIM3)
  {
    HAL_TIM_PWM_Stop_DMA(htim, TIM_CHANNEL_1);
    busy = 0;
  }
}

void DMA1_Stream4_IRQHandler(void)
{
  HAL_DMA_IRQHandler(&hdma_tim3_ch1);
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_DMA_Init();
  MX_TIM3_Init();
  MX_USART2_UART_Init();
  printf("NeoPixel chain on D5: ring (12) -> DOUT -> strip (8), TIM3 PWM 800 kHz + DMA\r\n");

  static const uint8_t levels[] = {32, 96, 255, 8};
  int level = 0;
  uint32_t rgb[LEDS];
  uint32_t frames = 0, last = 0;
  uint8_t offset = 0;
  while (1)
  {
    if (HAL_GPIO_ReadPin(B1_GPIO_Port, B1_Pin) == GPIO_PIN_RESET)
    {
      level = (level + 1) % 4;
      printf("brightness %d\r\n", levels[level]);
      while (HAL_GPIO_ReadPin(B1_GPIO_Port, B1_Pin) == GPIO_PIN_RESET)
      {
        HAL_Delay(10);
      }
    }
    for (int i = 0; i < RING; i++)
    {
      rgb[i] = wheel((uint8_t)(offset + i * 256 / RING), levels[level]);
    }
    /* The strip: an amber comet with a fading tail, bouncing. */
    int head = (int)(frames / 3 % (2 * STRIP - 2));
    if (head >= STRIP)
    {
      head = 2 * STRIP - 2 - head;
    }
    for (int i = 0; i < STRIP; i++)
    {
      int d = i > head ? i - head : head - i;
      uint32_t v = d == 0 ? levels[level] : d == 1 ? levels[level] / 4 : 0;
      rgb[RING + i] = v << 16 | (v / 2) << 8;
    }
    show(rgb);
    offset += 4;
    frames++;
    if (HAL_GetTick() - last >= 1000)
    {
      last = HAL_GetTick();
      printf("frames %lu, ring LED0 #%06lX, strip head %d\r\n", (unsigned long)frames, (unsigned long)rgb[0], head);
    }
    HAL_Delay(20);
  }
}

static void MX_DMA_Init(void)
{
  __HAL_RCC_DMA1_CLK_ENABLE();
  HAL_NVIC_SetPriority(DMA1_Stream4_IRQn, 0, 0);
  HAL_NVIC_EnableIRQ(DMA1_Stream4_IRQn);
}

static void MX_TIM3_Init(void)
{
  TIM_OC_InitTypeDef sConfigOC = {0};
  htim3.Instance = TIM3;
  htim3.Init.Prescaler = 0;
  htim3.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim3.Init.Period = 105 - 1;
  htim3.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim3.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_ENABLE;
  if (HAL_TIM_PWM_Init(&htim3) != HAL_OK)
  {
    Error_Handler();
  }
  sConfigOC.OCMode = TIM_OCMODE_PWM1;
  sConfigOC.Pulse = 0;
  sConfigOC.OCPolarity = TIM_OCPOLARITY_HIGH;
  sConfigOC.OCFastMode = TIM_OCFAST_DISABLE;
  if (HAL_TIM_PWM_ConfigChannel(&htim3, &sConfigOC, TIM_CHANNEL_1) != HAL_OK)
  {
    Error_Handler();
  }
  GPIO_InitTypeDef GPIO_InitStruct = {0};
  __HAL_RCC_GPIOB_CLK_ENABLE();
  GPIO_InitStruct.Pin = GPIO_PIN_4; /* PB4 = D5 → TIM3_CH1 */
  GPIO_InitStruct.Mode = GPIO_MODE_AF_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_HIGH;
  GPIO_InitStruct.Alternate = GPIO_AF2_TIM3;
  HAL_GPIO_Init(GPIOB, &GPIO_InitStruct);
}

void HAL_TIM_PWM_MspInit(TIM_HandleTypeDef *htim)
{
  if (htim->Instance == TIM3)
  {
    __HAL_RCC_TIM3_CLK_ENABLE();
    /* DMA1 stream 4, channel 5 = TIM3_CH1: memory → CCR1, half-words */
    hdma_tim3_ch1.Instance = DMA1_Stream4;
    hdma_tim3_ch1.Init.Channel = DMA_CHANNEL_5;
    hdma_tim3_ch1.Init.Direction = DMA_MEMORY_TO_PERIPH;
    hdma_tim3_ch1.Init.PeriphInc = DMA_PINC_DISABLE;
    hdma_tim3_ch1.Init.MemInc = DMA_MINC_ENABLE;
    hdma_tim3_ch1.Init.PeriphDataAlignment = DMA_PDATAALIGN_HALFWORD;
    hdma_tim3_ch1.Init.MemDataAlignment = DMA_MDATAALIGN_HALFWORD;
    hdma_tim3_ch1.Init.Mode = DMA_NORMAL;
    hdma_tim3_ch1.Init.Priority = DMA_PRIORITY_HIGH;
    hdma_tim3_ch1.Init.FIFOMode = DMA_FIFOMODE_DISABLE;
    if (HAL_DMA_Init(&hdma_tim3_ch1) != HAL_OK)
    {
      Error_Handler();
    }
    __HAL_LINKDMA(htim, hdma[TIM_DMA_ID_CC1], hdma_tim3_ch1);
  }
}

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};
  __HAL_RCC_GPIOC_CLK_ENABLE();
  GPIO_InitStruct.Pin = B1_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_INPUT;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  HAL_GPIO_Init(B1_GPIO_Port, &GPIO_InitStruct);
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
