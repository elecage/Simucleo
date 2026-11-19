/*
 * CubeMX-style HAL example: a brushless (BLDC) motor with hall sensors,
 * commutated six-step from the hall interrupts through a 3-phase bridge.
 *
 *   D2 (PA10)  hall A \ open collector: the pins' pull-ups make the high
 *   D7 (PA8)   hall B  } level; EXTI on both edges
 *   D8 (PA9)   hall C /
 *   D3 (PB3)   INHA  \
 *   D5 (PB4)   INLA   \  high- and low-side switch of each phase
 *   D6 (PB10)  INHB    } of the bridge (OUTA → U, OUTB → V, OUTC → W)
 *   D10 (PB6)  INLB   /
 *   D15 (PB8)  INHC  /
 *   D14 (PB9)  INLC /
 *   5V, GND    hall sensor supply;  12 V supply: + to PVDD, − to GND
 *   B1 (PC13)  swap halls A and B in the firmware (a wiring mistake)
 *
 * The three halls tell in which of six 60° sectors the rotor is (code
 * C B A, never 000 or 111). For each sector one phase goes to the supply
 * and one to ground — the pair that pulls the rotor on into the next
 * sector, whose hall edge switches to the next pair. All six switch
 * inputs are written at once through BSRR: a high and a low switch of
 * the same phase are never on together (shoot-through).
 */
#include <stdio.h>
#include "main.h"

#define HA GPIO_PIN_10
#define HB GPIO_PIN_8
#define HC GPIO_PIN_9

#define INHA GPIO_PIN_3
#define INLA GPIO_PIN_4
#define INHB GPIO_PIN_10
#define INLB GPIO_PIN_6
#define INHC GPIO_PIN_8
#define INLC GPIO_PIN_9
#define BRIDGE_ALL (INHA | INLA | INHB | INLB | INHC | INLC)

#define POLE_PAIRS 4

UART_HandleTypeDef huart2;

static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);

/* Bridge inputs for each hall code (C B A): high side of one phase, low
 * side of another. 0 and 7 cannot happen (a broken sensor): all off. */
static const uint16_t TABLE[8] = {
    0,
    INHB | INLC, /* 001: V+ W- */
    INHC | INLA, /* 010: W+ U- */
    INHB | INLA, /* 011: V+ U- */
    INHA | INLB, /* 100: U+ V- */
    INHA | INLC, /* 101: U+ W- */
    INHC | INLB, /* 110: W+ V- */
    0,
};
static const char *const PAIR[8] = {"off  ", "V+ W-", "W+ U-", "V+ U-", "U+ V-", "U+ W-", "W+ V-", "off  "};

static volatile uint32_t edges;
static volatile int swapped;
static volatile int b1_pressed;

static unsigned hall_code(void)
{
  uint32_t idr = GPIOA->IDR;
  unsigned a = (idr & HA) != 0, b = (idr & HB) != 0, c = (idr & HC) != 0;
  if (swapped)
  {
    unsigned t = a;
    a = b;
    b = t;
  }
  return a | b << 1 | c << 2;
}

static void commutate(void)
{
  uint16_t on = TABLE[hall_code()];
  /* Set the switches that go on, reset the rest, in one write. */
  GPIOB->BSRR = on | (uint32_t)(BRIDGE_ALL & ~on) << 16;
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

void EXTI9_5_IRQHandler(void)
{
  HAL_GPIO_EXTI_IRQHandler(HB);
  HAL_GPIO_EXTI_IRQHandler(HC);
}

void EXTI15_10_IRQHandler(void)
{
  HAL_GPIO_EXTI_IRQHandler(HA);
  HAL_GPIO_EXTI_IRQHandler(B1_Pin);
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  printf("BLDC: halls on D2 D7 D8 (EXTI), bridge INH/INL on D3 D5 D6 D10 D15 D14\r\n");
  commutate();

  uint32_t last = HAL_GetTick(), counted = 0;
  while (1)
  {
    if (b1_pressed)
    {
      b1_pressed = 0;
      swapped = !swapped;
      printf(swapped ? "halls A and B swapped - wrong commutation\r\n" : "halls in order again\r\n");
      commutate();
    }
    uint32_t t = HAL_GetTick();
    if (t - last >= 500)
    {
      uint32_t e = edges;
      /* Six hall edges per electrical turn, POLE_PAIRS of those per turn. */
      uint32_t rpm = (e - counted) * 60 * 1000 / (t - last) / (6 * POLE_PAIRS);
      counted = e;
      last = t;
      unsigned code = hall_code();
      printf("halls ABC %u%u%u  %s  rpm %lu\r\n", code & 1, code >> 1 & 1, code >> 2 & 1, PAIR[code],
             (unsigned long)rpm);
    }
    __WFI();
  }
}

/* ------------------------------------------------------- peripherals */

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef g = {0};
  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOC_CLK_ENABLE();
  /* Bridge inputs: all switches off. */
  HAL_GPIO_WritePin(GPIOB, BRIDGE_ALL, GPIO_PIN_RESET);
  g.Pin = BRIDGE_ALL;
  g.Mode = GPIO_MODE_OUTPUT_PP;
  g.Pull = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOB, &g);
  /* Halls: open collector, so pull-ups; interrupts on both edges. */
  g.Pin = HA | HB | HC;
  g.Mode = GPIO_MODE_IT_RISING_FALLING;
  g.Pull = GPIO_PULLUP;
  HAL_GPIO_Init(GPIOA, &g);
  g.Pin = B1_Pin;
  g.Mode = GPIO_MODE_IT_FALLING;
  g.Pull = GPIO_NOPULL;
  HAL_GPIO_Init(B1_GPIO_Port, &g);
  HAL_NVIC_SetPriority(EXTI9_5_IRQn, 0, 0);
  HAL_NVIC_EnableIRQ(EXTI9_5_IRQn);
  HAL_NVIC_SetPriority(EXTI15_10_IRQn, 0, 0);
  HAL_NVIC_EnableIRQ(EXTI15_10_IRQn);
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
