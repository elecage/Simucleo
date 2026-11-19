/*
 * CubeMX-style HAL example: an HC-SR501 PIR motion sensor switches on an
 * LED and reports on the virtual COM port.
 *
 *   D7 (PA8)   PIR OUT (3.3 V while motion is detected), EXTI8 on both edges
 *   D6 (PB10)  → 330 Ω → LED → GND (and LD2): lit while OUT is high
 *   5V, GND    PIR VCC and GND (the module needs 4.5–20 V)
 *
 * The module does the timing itself: after power-up it needs a while to
 * settle (warm-up) and ignores motion meanwhile; on motion OUT stays high
 * for its hold time (the "Tx" potentiometer) — in mode H counted from the
 * last motion, in mode L from the first — and then it stays deaf for
 * about 2.5 s.
 */
#include <stdio.h>
#include "main.h"

#define PIR_PORT GPIOA
#define PIR_PIN GPIO_PIN_8
#define LED_PORT GPIOB
#define LED_PIN GPIO_PIN_10

UART_HandleTypeDef huart2;

static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);

static volatile int changed;

void HAL_GPIO_EXTI_Callback(uint16_t pin)
{
  if (pin == PIR_PIN)
  {
    changed = 1;
  }
}

void EXTI9_5_IRQHandler(void)
{
  HAL_GPIO_EXTI_IRQHandler(PIR_PIN);
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  printf("HC-SR501 PIR on D7, LED on D6 - waiting for motion\r\n");

  int motion = 0, count = 0;
  uint32_t since = 0;
  changed = 1;
  while (1)
  {
    if (changed)
    {
      changed = 0;
      int now = HAL_GPIO_ReadPin(PIR_PORT, PIR_PIN) == GPIO_PIN_SET;
      if (now != motion)
      {
        motion = now;
        HAL_GPIO_WritePin(LED_PORT, LED_PIN, motion ? GPIO_PIN_SET : GPIO_PIN_RESET);
        HAL_GPIO_WritePin(LD2_GPIO_Port, LD2_Pin, motion ? GPIO_PIN_SET : GPIO_PIN_RESET);
        uint32_t t = HAL_GetTick();
        if (motion)
        {
          count++;
          printf("[%lu.%03lu s] motion detected (#%d) - LED on\r\n", (unsigned long)(t / 1000),
                 (unsigned long)(t % 1000), count);
        }
        else
        {
          uint32_t held = t - since;
          printf("[%lu.%03lu s] quiet again after %lu.%01lu s - LED off\r\n", (unsigned long)(t / 1000),
                 (unsigned long)(t % 1000), (unsigned long)(held / 1000), (unsigned long)(held % 1000 / 100));
        }
        since = t;
      }
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
  g.Pin = LED_PIN;
  g.Mode = GPIO_MODE_OUTPUT_PP;
  g.Pull = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(LED_PORT, &g);
  g.Pin = LD2_Pin;
  HAL_GPIO_Init(LD2_GPIO_Port, &g);
  g.Pin = PIR_PIN;
  g.Mode = GPIO_MODE_IT_RISING_FALLING;
  g.Pull = GPIO_PULLDOWN; /* low while the sensor is unpowered */
  HAL_GPIO_Init(PIR_PORT, &g);
  HAL_NVIC_SetPriority(EXTI9_5_IRQn, 0, 0);
  HAL_NVIC_EnableIRQ(EXTI9_5_IRQn);
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
