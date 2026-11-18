/*
 * CubeMX-style HAL UART example: printf() over USART2 (ST-LINK virtual COM
 * port, 115200 8N1) and an interrupt-driven echo that upper-cases what you
 * type.
 */
#include <stdio.h>
#include "main.h"

UART_HandleTypeDef huart2;
static uint8_t rx_byte;

static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();

  printf("Hello from Simucleo! SystemCoreClock = %lu Hz\r\n", (unsigned long)SystemCoreClock);
  printf("HCLK %lu, PCLK1 %lu, PCLK2 %lu\r\n", (unsigned long)HAL_RCC_GetHCLKFreq(),
         (unsigned long)HAL_RCC_GetPCLK1Freq(), (unsigned long)HAL_RCC_GetPCLK2Freq());
  HAL_UART_Receive_IT(&huart2, &rx_byte, 1);

  uint32_t n = 0;
  while (1)
  {
    HAL_Delay(250);
    HAL_GPIO_TogglePin(LD2_GPIO_Port, LD2_Pin);
    if (n < 3)
    {
      printf("tick %lu at %lu ms\r\n", (unsigned long)n, (unsigned long)HAL_GetTick());
    }
    n++;
  }
}

/* Echo each received character in upper case. */
void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart)
{
  if (huart->Instance == USART2)
  {
    uint8_t c = rx_byte;
    if (c >= 'a' && c <= 'z')
    {
      c -= 'a' - 'A';
    }
    HAL_UART_Transmit(&huart2, &c, 1, 10);
    HAL_UART_Receive_IT(&huart2, &rx_byte, 1);
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
