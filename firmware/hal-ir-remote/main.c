/*
 * CubeMX-style HAL example: an NEC infrared remote decoded with timer
 * input capture.
 *
 *   D3 (PB3, TIM2_CH2)  OUT of a VS1838B-type IR receiver (VCC 3V3, GND);
 *                       the output is low while a 38 kHz burst arrives
 *
 * TIM2 counts microseconds and captures every falling edge (the start of
 * each mark). The time from one falling edge to the next tells the parts
 * of an NEC frame apart:
 *   13.5 ms   leader (9 ms mark + 4.5 ms space): a new frame starts
 *   11.25 ms  repeat code (9 ms mark + 2.25 ms space): the key is held
 *   1.125 ms  a 0 bit (562.5 µs mark + 562.5 µs space)
 *   2.25 ms   a 1 bit (562.5 µs mark + 1687.5 µs space)
 * 32 bits arrive LSB first: address, ~address, command, ~command. The
 * interrupt queues what it decodes; the main loop prints it, and LD2
 * blinks the digit pressed.
 */
#include <stdio.h>
#include "main.h"

UART_HandleTypeDef huart2;
TIM_HandleTypeDef htim2;

static void MX_GPIO_Init(void);
static void MX_TIM2_Init(void);
static void MX_USART2_UART_Init(void);

/* What the interrupt decoded: a frame's 32 bits, a repeat code, or a
   frame whose check bytes do not match. */
enum
{
  EV_FRAME,
  EV_REPEAT,
  EV_ERROR
};
static volatile uint32_t ev_bits[16];
static volatile uint8_t ev_kind[16];
static volatile uint8_t ev_head, ev_tail;

static uint32_t last_fall;
static int bit_count = -1; /* -1: waiting for a leader */
static uint32_t bits;
static int have_frame;     /* a repeat code refers to a frame */

static void push(uint8_t kind, uint32_t frame)
{
  uint8_t next = (uint8_t)((ev_head + 1) % 16);
  if (next != ev_tail)
  {
    ev_kind[ev_head] = kind;
    ev_bits[ev_head] = frame;
    ev_head = next;
  }
}

static int between(uint32_t us, uint32_t lo, uint32_t hi)
{
  return us >= lo && us <= hi;
}

void HAL_TIM_IC_CaptureCallback(TIM_HandleTypeDef *htim)
{
  if (htim->Instance != TIM2 || htim->Channel != HAL_TIM_ACTIVE_CHANNEL_2)
  {
    return;
  }
  uint32_t now = HAL_TIM_ReadCapturedValue(htim, TIM_CHANNEL_2);
  uint32_t dt = now - last_fall;
  last_fall = now;

  if (between(dt, 12500, 14500))
  {
    bit_count = 0; /* leader */
    bits = 0;
  }
  else if (between(dt, 10250, 12250))
  {
    if (have_frame)
    {
      push(EV_REPEAT, 0);
    }
    bit_count = -1;
  }
  else if (bit_count >= 0 && between(dt, 900, 1400))
  {
    bit_count++; /* a 0 */
  }
  else if (bit_count >= 0 && between(dt, 1950, 2600))
  {
    bits |= 1u << bit_count++; /* a 1 */
  }
  else
  {
    bit_count = -1; /* a gap between frames, or noise */
    return;
  }
  if (bit_count == 32)
  {
    uint8_t addr = bits & 0xFF, naddr = bits >> 8 & 0xFF, cmd = bits >> 16 & 0xFF, ncmd = bits >> 24;
    if ((uint8_t)~cmd == ncmd && (uint8_t)~addr == naddr)
    {
      push(EV_FRAME, bits);
      have_frame = 1;
    }
    else
    {
      push(EV_ERROR, bits);
      have_frame = 0;
    }
    bit_count = -1;
  }
}

void TIM2_IRQHandler(void)
{
  HAL_TIM_IRQHandler(&htim2);
}

/* Buttons of the usual 17-key remote. */
static const struct
{
  uint8_t cmd;
  const char *name;
} KEYS[] = {
    {0x45, "1"},  {0x46, "2"},  {0x47, "3"},    {0x44, "4"},  {0x40, "5"},    {0x43, "6"},
    {0x07, "7"},  {0x15, "8"},  {0x09, "9"},    {0x16, "*"},  {0x19, "0"},    {0x0D, "#"},
    {0x18, "UP"}, {0x08, "LEFT"}, {0x1C, "OK"}, {0x5A, "RIGHT"}, {0x52, "DOWN"},
};

static const char *key_name(uint8_t cmd, int *digit)
{
  for (unsigned i = 0; i < sizeof KEYS / sizeof KEYS[0]; i++)
  {
    if (KEYS[i].cmd == cmd)
    {
      char c = KEYS[i].name[0];
      *digit = KEYS[i].name[1] == 0 && c >= '0' && c <= '9' ? c - '0' : -1;
      return KEYS[i].name;
    }
  }
  *digit = -1;
  return "?";
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_TIM2_Init();
  MX_USART2_UART_Init();
  HAL_TIM_IC_Start_IT(&htim2, TIM_CHANNEL_2);
  printf("NEC IR receiver on D3: TIM2_CH2 input capture, falling edges, 1 us\r\n");

  uint32_t blink_until = 0;
  int blinks = 0;
  while (1)
  {
    while (ev_tail != ev_head)
    {
      uint8_t kind = ev_kind[ev_tail];
      uint32_t ev = ev_bits[ev_tail];
      ev_tail = (uint8_t)((ev_tail + 1) % 16);
      if (kind == EV_REPEAT)
      {
        printf("repeat\r\n");
      }
      else if (kind == EV_ERROR)
      {
        printf("NEC check failed: %08lX\r\n", (unsigned long)ev);
      }
      else
      {
        uint8_t addr = ev & 0xFF, cmd = ev >> 16 & 0xFF;
        int digit;
        const char *name = key_name(cmd, &digit);
        printf("NEC addr 0x%02X cmd 0x%02X key %s\r\n", addr, cmd, name);
        /* LD2 blinks the digit (0: one long blink). */
        blinks = digit < 0 ? 0 : digit == 0 ? 1 : digit;
        blink_until = HAL_GetTick();
      }
    }
    /* Blink LD2: 150 ms on, 150 ms off, `blinks` times. */
    if (blinks > 0 && HAL_GetTick() >= blink_until)
    {
      HAL_GPIO_TogglePin(LD2_GPIO_Port, LD2_Pin);
      if (HAL_GPIO_ReadPin(LD2_GPIO_Port, LD2_Pin) == GPIO_PIN_RESET)
      {
        blinks--;
      }
      blink_until = HAL_GetTick() + 150;
    }
    HAL_Delay(1);
  }
}

/* ------------------------------------------------------- peripherals */

static void MX_TIM2_Init(void)
{
  TIM_IC_InitTypeDef sConfigIC = {0};
  htim2.Instance = TIM2;
  htim2.Init.Prescaler = 84 - 1; /* 1 MHz */
  htim2.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim2.Init.Period = 0xFFFFFFFF;
  htim2.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim2.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_DISABLE;
  if (HAL_TIM_IC_Init(&htim2) != HAL_OK)
  {
    Error_Handler();
  }
  sConfigIC.ICPolarity = TIM_INPUTCHANNELPOLARITY_FALLING;
  sConfigIC.ICSelection = TIM_ICSELECTION_DIRECTTI;
  sConfigIC.ICPrescaler = TIM_ICPSC_DIV1;
  sConfigIC.ICFilter = 0;
  if (HAL_TIM_IC_ConfigChannel(&htim2, &sConfigIC, TIM_CHANNEL_2) != HAL_OK)
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
    g.Pull = GPIO_NOPULL; /* the receiver module has its own pull-up */
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
  HAL_GPIO_WritePin(LD2_GPIO_Port, LD2_Pin, GPIO_PIN_RESET);
  g.Pin = LD2_Pin;
  g.Mode = GPIO_MODE_OUTPUT_PP;
  g.Pull = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(LD2_GPIO_Port, &g);
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
