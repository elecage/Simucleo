/*
 * CubeMX-style HAL example: a 4-digit 7-segment display and a 4×4 keypad.
 *
 *   PC0–PC7   segments a–g, dp (each through 470 Ω), common cathode
 *   PB12–PB15 digit commons 1–4 (low = digit on)
 *   PC8–PC11  keypad rows 1–4 (open-drain outputs)
 *   PC12, PD2, PB1, PB2  keypad columns 1–4 (inputs with pull-ups)
 *
 * TIM10 interrupts at 1 kHz and lights one digit at a time (multiplexing):
 * each digit is on a quarter of the time, fast enough to look steady.
 * The keypad is scanned every 10 ms: one row is pulled low and a pressed
 * key pulls its column low. Digits shift in from the right, * clears,
 * # prints the number, A–D show a letter.
 */
#include <stdio.h>
#include "main.h"

UART_HandleTypeDef huart2;
TIM_HandleTypeDef htim10;

/* Segment patterns, bit 0 = a … bit 6 = g. */
static const uint8_t FONT[16] = {0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07,
                                 0x7F, 0x6F, 0x77, 0x7C, 0x39, 0x5E, 0x79, 0x71};
static const char KEYS[4][4] = {{'1', '2', '3', 'A'}, {'4', '5', '6', 'B'}, {'7', '8', '9', 'C'}, {'*', '0', '#', 'D'}};

static volatile uint8_t digits[4]; /* segment patterns, left to right */
static volatile int current;

static void MX_GPIO_Init(void);
static void MX_TIM10_Init(void);
static void MX_USART2_UART_Init(void);

void TIM1_UP_TIM10_IRQHandler(void)
{
  HAL_TIM_IRQHandler(&htim10);
}

void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)
{
  if (htim->Instance != TIM10)
  {
    return;
  }
  /* All digits off, new segments, then the next digit on. */
  GPIOB->BSRR = 0xF << 12;
  current = (current + 1) & 3;
  GPIOC->ODR = (GPIOC->ODR & ~0xFFu) | digits[current];
  GPIOB->BSRR = 1u << (12 + current + 16);
}

/* The key held down now, or 0. */
static char scan(void)
{
  static const struct
  {
    GPIO_TypeDef *port;
    uint16_t pin;
  } cols[4] = {{GPIOC, GPIO_PIN_12}, {GPIOD, GPIO_PIN_2}, {GPIOB, GPIO_PIN_1}, {GPIOB, GPIO_PIN_2}};
  for (int r = 0; r < 4; r++)
  {
    GPIOC->BSRR = (0xF << 8) & ~(1u << (8 + r)); /* release the others */
    GPIOC->BSRR = 1u << (8 + r + 16);            /* this row low */
    for (volatile int d = 0; d < 20; d++)
    {
    }
    for (int c = 0; c < 4; c++)
    {
      if (HAL_GPIO_ReadPin(cols[c].port, cols[c].pin) == GPIO_PIN_RESET)
      {
        GPIOC->BSRR = 0xF << 8;
        return KEYS[r][c];
      }
    }
  }
  GPIOC->BSRR = 0xF << 8;
  return 0;
}

static void show_number(uint32_t n, int len)
{
  for (int i = 0; i < 4; i++)
  {
    int pos = 3 - i;
    digits[pos] = (i < len || (i == 0)) ? FONT[n % 10] : 0;
    n /= 10;
  }
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  MX_TIM10_Init();
  HAL_TIM_Base_Start_IT(&htim10);
  printf("7-segment + keypad: type digits, * clears, # prints\r\n");

  uint32_t value = 0;
  int len = 0;
  char last = 0;
  show_number(0, 1);
  while (1)
  {
    char k = scan();
    if (k && k != last)
    {
      if (k >= '0' && k <= '9')
      {
        value = (value * 10 + (k - '0')) % 10000;
        len = len < 4 ? len + 1 : 4;
        show_number(value, len);
      }
      else if (k == '*')
      {
        value = 0;
        len = 0;
        show_number(0, 1);
      }
      else if (k == '#')
      {
        printf("value %lu\r\n", (unsigned long)value);
      }
      else
      {
        /* A–D: the letter on the last digit. */
        digits[0] = digits[1] = digits[2] = 0;
        digits[3] = FONT[10 + (k - 'A')];
        value = 0;
        len = 0;
      }
      printf("key %c\r\n", k);
    }
    last = k;
    HAL_Delay(10);
  }
}

static void MX_TIM10_Init(void)
{
  htim10.Instance = TIM10;
  htim10.Init.Prescaler = 84 - 1; /* 1 MHz */
  htim10.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim10.Init.Period = 1000 - 1; /* 1 kHz */
  htim10.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim10.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_DISABLE;
  if (HAL_TIM_Base_Init(&htim10) != HAL_OK)
  {
    Error_Handler();
  }
}

void HAL_TIM_Base_MspInit(TIM_HandleTypeDef *htim)
{
  if (htim->Instance == TIM10)
  {
    __HAL_RCC_TIM10_CLK_ENABLE();
    HAL_NVIC_SetPriority(TIM1_UP_TIM10_IRQn, 1, 0);
    HAL_NVIC_EnableIRQ(TIM1_UP_TIM10_IRQn);
  }
}

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef g = {0};
  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOC_CLK_ENABLE();
  __HAL_RCC_GPIOD_CLK_ENABLE();
  /* Segments off, digits off (high), rows released. */
  GPIOC->BSRR = (0xFFu << 16) | (0xF << 8);
  GPIOB->BSRR = 0xF << 12;
  g.Mode = GPIO_MODE_OUTPUT_PP;
  g.Pull = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_LOW;
  g.Pin = 0xFF; /* PC0–PC7 */
  HAL_GPIO_Init(GPIOC, &g);
  g.Pin = GPIO_PIN_12 | GPIO_PIN_13 | GPIO_PIN_14 | GPIO_PIN_15;
  HAL_GPIO_Init(GPIOB, &g);
  g.Mode = GPIO_MODE_OUTPUT_OD;
  g.Pin = GPIO_PIN_8 | GPIO_PIN_9 | GPIO_PIN_10 | GPIO_PIN_11;
  HAL_GPIO_Init(GPIOC, &g);
  g.Mode = GPIO_MODE_INPUT;
  g.Pull = GPIO_PULLUP;
  g.Pin = GPIO_PIN_12;
  HAL_GPIO_Init(GPIOC, &g);
  g.Pin = GPIO_PIN_2;
  HAL_GPIO_Init(GPIOD, &g);
  g.Pin = GPIO_PIN_1 | GPIO_PIN_2;
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
