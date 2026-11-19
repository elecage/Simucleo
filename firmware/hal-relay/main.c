/*
 * CubeMX-style HAL example: a button toggles a relay module that switches
 * an LED on its own 5 V supply.
 *
 *   D7 (PA8)   relay module IN (active low: 0 energises the coil)
 *   D4 (PB5)   push button to GND (internal pull-up, EXTI5 falling edge)
 *   B1 (PC13)  the blue button does the same (EXTI13)
 *   5V, GND    relay VCC and GND; 5V also to COM
 *   NO → 330 Ω → LED → GND: the LED lights while the relay is on
 *
 * The contacts are galvanically separate from the MCU: the pin only
 * drives the module's input, the LED current flows from 5 V through
 * COM–NO. LD2 mirrors the relay. Each press is debounced (200 ms) and
 * logged on the virtual COM port.
 */
#include <stdio.h>
#include "main.h"

UART_HandleTypeDef huart2;

#define RELAY_Port GPIOA
#define RELAY_Pin GPIO_PIN_8
#define BTN_Port GPIOB
#define BTN_Pin GPIO_PIN_5

static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);

static volatile int presses;
static uint32_t last_press;

void HAL_GPIO_EXTI_Callback(uint16_t pin)
{
  if (pin == BTN_Pin || pin == B1_Pin)
  {
    uint32_t now = HAL_GetTick();
    if (presses == 0 || now - last_press >= 200)
    {
      last_press = now;
      presses++;
    }
  }
}

void EXTI9_5_IRQHandler(void)
{
  HAL_GPIO_EXTI_IRQHandler(BTN_Pin);
}

void EXTI15_10_IRQHandler(void)
{
  HAL_GPIO_EXTI_IRQHandler(B1_Pin);
}

static void relay(int on)
{
  /* Active low: the module's input transistor turns on with IN at 0 V. */
  HAL_GPIO_WritePin(RELAY_Port, RELAY_Pin, on ? GPIO_PIN_RESET : GPIO_PIN_SET);
  HAL_GPIO_WritePin(LD2_GPIO_Port, LD2_Pin, on ? GPIO_PIN_SET : GPIO_PIN_RESET);
  printf("relay %s\r\n", on ? "ON  (COM-NO closed, LED lit)" : "OFF (COM-NC closed)");
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  printf("relay on D7 (active low), button on D4 or B1\r\n");
  int on = 0, handled = 0;
  relay(on);
  while (1)
  {
    if (presses != handled)
    {
      handled = presses;
      on = !on;
      relay(on);
    }
    __WFI();
  }
}

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef g = {0};
  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOC_CLK_ENABLE();
  /* Relay off before the pin becomes an output. */
  HAL_GPIO_WritePin(RELAY_Port, RELAY_Pin, GPIO_PIN_SET);
  g.Pin = RELAY_Pin;
  g.Mode = GPIO_MODE_OUTPUT_PP;
  g.Pull = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(RELAY_Port, &g);
  g.Pin = LD2_Pin;
  HAL_GPIO_Init(LD2_GPIO_Port, &g);
  g.Pin = BTN_Pin;
  g.Mode = GPIO_MODE_IT_FALLING;
  g.Pull = GPIO_PULLUP;
  HAL_GPIO_Init(BTN_Port, &g);
  g.Pin = B1_Pin;
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
