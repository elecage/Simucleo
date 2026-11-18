/* Shared declarations, as in a CubeMX-generated main.h. */
#ifndef MAIN_H
#define MAIN_H

#include "stm32f4xx_hal.h"

/* Nucleo-F401RE user LED and button */
#define LD2_Pin GPIO_PIN_5
#define LD2_GPIO_Port GPIOA
#define B1_Pin GPIO_PIN_13
#define B1_GPIO_Port GPIOC
#define USART_TX_Pin GPIO_PIN_2
#define USART_RX_Pin GPIO_PIN_3

void SystemClock_Config(void);
void Error_Handler(void);

/* Set by projects that use USART2 (stm32f4xx_it.c forwards its IRQ). */
extern UART_HandleTypeDef huart2;

#endif
