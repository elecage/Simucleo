/* Interrupt handlers, as in a CubeMX FreeRTOS project's stm32f4xx_it.c.
   SVC and PendSV belong to the FreeRTOS port (FreeRTOSConfig.h maps them),
   SysTick_Handler (the RTOS tick) is in cmsis_os2.c, and the HAL tick runs
   on TIM11. */
#include "main.h"
#include "FreeRTOS.h"
#include "task.h"

extern TIM_HandleTypeDef htim11;

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

void DebugMon_Handler(void) {}

void TIM1_TRG_COM_TIM11_IRQHandler(void)
{
  HAL_TIM_IRQHandler(&htim11);
}

/* Only linked in by projects that define huart2. */
__attribute__((weak)) UART_HandleTypeDef huart2;

void USART2_IRQHandler(void)
{
  HAL_UART_IRQHandler(&huart2);
}
