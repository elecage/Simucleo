/* Interrupt handlers, as in a CubeMX-generated stm32f4xx_it.c. */
#include "main.h"

void NMI_Handler(void)
{
  while (1)
  {
  }
}

void HardFault_Handler(void)
{
  while (1)
  {
  }
}

void MemManage_Handler(void)
{
  while (1)
  {
  }
}

void BusFault_Handler(void)
{
  while (1)
  {
  }
}

void UsageFault_Handler(void)
{
  while (1)
  {
  }
}

void SVC_Handler(void) {}
void DebugMon_Handler(void) {}
void PendSV_Handler(void) {}

void SysTick_Handler(void)
{
  HAL_IncTick();
}

/* Only linked in by projects that define huart2. */
__attribute__((weak)) UART_HandleTypeDef huart2;

void USART2_IRQHandler(void)
{
  HAL_UART_IRQHandler(&huart2);
}

/* USART1 and USART6, for projects that define huart1 / huart6. */
__attribute__((weak)) UART_HandleTypeDef huart1;
__attribute__((weak)) UART_HandleTypeDef huart6;

void USART1_IRQHandler(void)
{
  HAL_UART_IRQHandler(&huart1);
}

void USART6_IRQHandler(void)
{
  HAL_UART_IRQHandler(&huart6);
}
