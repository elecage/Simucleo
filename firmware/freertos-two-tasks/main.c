/*
 * CubeMX-style FreeRTOS example (CMSIS-RTOS v2): three threads.
 *
 *   Blink   (Normal)       toggles LD2 every 500 ms with osDelay()
 *   Count   (BelowNormal)  prints a counter every second
 *   Button  (AboveNormal)  waits on a semaphore that the B1 interrupt
 *                          (EXTI15_10) releases, then prints
 *
 * printf() goes to USART2 (virtual COM port); a mutex keeps lines whole.
 * The HAL tick runs on TIM11, SysTick belongs to FreeRTOS.
 */
#include <stdarg.h>
#include <stdio.h>
#include "main.h"
#include "cmsis_os.h"
#include "FreeRTOS.h"
#include "task.h"

UART_HandleTypeDef huart2;

static osMutexId_t printMutex;
static osSemaphoreId_t buttonSem;

static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);
static void BlinkTask(void *argument);
static void CountTask(void *argument);
static void ButtonTask(void *argument);

static const osThreadAttr_t blinkAttr = {.name = "Blink", .stack_size = 128 * 4, .priority = osPriorityNormal};
static const osThreadAttr_t countAttr = {.name = "Count", .stack_size = 256 * 4, .priority = osPriorityBelowNormal};
static const osThreadAttr_t buttonAttr = {.name = "Button", .stack_size = 256 * 4, .priority = osPriorityAboveNormal};

static void log_line(const char *fmt, ...)
{
  va_list ap;
  osMutexAcquire(printMutex, osWaitForever);
  va_start(ap, fmt);
  vprintf(fmt, ap);
  va_end(ap);
  fflush(stdout);
  osMutexRelease(printMutex);
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();

  osKernelInitialize();
  printMutex = osMutexNew(NULL);
  buttonSem = osSemaphoreNew(1, 0, NULL);
  osThreadNew(BlinkTask, NULL, &blinkAttr);
  osThreadNew(CountTask, NULL, &countAttr);
  osThreadNew(ButtonTask, NULL, &buttonAttr);
  printf("FreeRTOS %s: Blink, Count, Button\r\n", tskKERNEL_VERSION_NUMBER);
  osKernelStart();

  /* Not reached: the scheduler owns the CPU now. */
  while (1)
  {
  }
}

static void BlinkTask(void *argument)
{
  (void)argument;
  for (;;)
  {
    HAL_GPIO_TogglePin(LD2_GPIO_Port, LD2_Pin);
    osDelay(500);
  }
}

static void CountTask(void *argument)
{
  (void)argument;
  uint32_t n = 0;
  for (;;)
  {
    log_line("count %lu at %lu ms\r\n", (unsigned long)n++, (unsigned long)osKernelGetTickCount());
    osDelay(1000);
  }
}

static void ButtonTask(void *argument)
{
  (void)argument;
  uint32_t n = 0;
  for (;;)
  {
    osSemaphoreAcquire(buttonSem, osWaitForever);
    log_line("B1 pressed (%lu)\r\n", (unsigned long)++n);
  }
}

void HAL_GPIO_EXTI_Callback(uint16_t GPIO_Pin)
{
  if (GPIO_Pin == B1_Pin)
  {
    osSemaphoreRelease(buttonSem); /* ISR-safe in CMSIS-RTOS v2 */
  }
}

void EXTI15_10_IRQHandler(void)
{
  HAL_GPIO_EXTI_IRQHandler(B1_Pin);
}

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef GPIO_InitStruct = {0};

  __HAL_RCC_GPIOC_CLK_ENABLE();
  __HAL_RCC_GPIOA_CLK_ENABLE();
  HAL_GPIO_WritePin(LD2_GPIO_Port, LD2_Pin, GPIO_PIN_RESET);

  GPIO_InitStruct.Pin = B1_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_IT_FALLING;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  HAL_GPIO_Init(B1_GPIO_Port, &GPIO_InitStruct);

  GPIO_InitStruct.Pin = LD2_Pin;
  GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
  GPIO_InitStruct.Pull = GPIO_NOPULL;
  GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(LD2_GPIO_Port, &GPIO_InitStruct);

  /* At or below configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY (5): may call
     FreeRTOS "FromISR" functions. */
  HAL_NVIC_SetPriority(EXTI15_10_IRQn, 6, 0);
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
