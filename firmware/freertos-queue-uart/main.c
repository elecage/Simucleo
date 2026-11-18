/*
 * CubeMX-style FreeRTOS example (CMSIS-RTOS v2): message queues.
 *
 *   UART RX interrupt  → rxQueue (bytes)  → Echo task: upper-cases each
 *                                            line you type and prints it
 *   Sensor task (every 250 ms) → dataQueue (samples) → Logger task: prints
 *                                            every 4th sample and, every 2 s,
 *                                            heap and stack statistics
 *
 * printf() goes to USART2 (virtual COM port, 115200 8N1).
 */
#include <stdarg.h>
#include <stdio.h>
#include "main.h"
#include "cmsis_os.h"
#include "FreeRTOS.h"
#include "task.h"

UART_HandleTypeDef huart2;

typedef struct
{
  uint32_t seq;
  uint32_t tick;
} Sample;

static osMessageQueueId_t rxQueue, dataQueue;
static osMutexId_t printMutex;
static osThreadId_t echoHandle, sensorHandle, loggerHandle;
static uint8_t rx_byte;

static void MX_USART2_UART_Init(void);
static void EchoTask(void *argument);
static void SensorTask(void *argument);
static void LoggerTask(void *argument);

static const osThreadAttr_t echoAttr = {.name = "Echo", .stack_size = 256 * 4, .priority = osPriorityAboveNormal};
static const osThreadAttr_t sensorAttr = {.name = "Sensor", .stack_size = 128 * 4, .priority = osPriorityNormal};
static const osThreadAttr_t loggerAttr = {.name = "Logger", .stack_size = 384 * 4, .priority = osPriorityBelowNormal};

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
  MX_USART2_UART_Init();

  osKernelInitialize();
  printMutex = osMutexNew(NULL);
  rxQueue = osMessageQueueNew(32, sizeof(uint8_t), NULL);
  dataQueue = osMessageQueueNew(8, sizeof(Sample), NULL);
  echoHandle = osThreadNew(EchoTask, NULL, &echoAttr);
  sensorHandle = osThreadNew(SensorTask, NULL, &sensorAttr);
  loggerHandle = osThreadNew(LoggerTask, NULL, &loggerAttr);
  printf("Queues: type a line to echo it\r\n");
  HAL_UART_Receive_IT(&huart2, &rx_byte, 1);
  osKernelStart();

  while (1)
  {
  }
}

void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart)
{
  if (huart->Instance == USART2)
  {
    osMessageQueuePut(rxQueue, &rx_byte, 0, 0); /* from the ISR: no waiting */
    HAL_UART_Receive_IT(&huart2, &rx_byte, 1);
  }
}

static void EchoTask(void *argument)
{
  (void)argument;
  char line[64];
  unsigned len = 0;
  for (;;)
  {
    uint8_t c;
    osMessageQueueGet(rxQueue, &c, NULL, osWaitForever);
    if (c == '\r' || c == '\n')
    {
      if (len > 0)
      {
        line[len] = 0;
        log_line("echo: %s\r\n", line);
        len = 0;
      }
    }
    else if (len < sizeof line - 1)
    {
      line[len++] = (c >= 'a' && c <= 'z') ? (char)(c - 'a' + 'A') : (char)c;
    }
  }
}

static void SensorTask(void *argument)
{
  (void)argument;
  uint32_t seq = 0;
  uint32_t wake = osKernelGetTickCount();
  for (;;)
  {
    Sample s = {.seq = seq++, .tick = osKernelGetTickCount()};
    osMessageQueuePut(dataQueue, &s, 0, osWaitForever);
    wake += 250;
    osDelayUntil(wake);
  }
}

static void LoggerTask(void *argument)
{
  (void)argument;
  for (;;)
  {
    Sample s;
    osMessageQueueGet(dataQueue, &s, NULL, osWaitForever);
    if (s.seq % 4 == 0)
    {
      log_line("sample %lu at %lu ms\r\n", (unsigned long)s.seq, (unsigned long)s.tick);
    }
    if (s.seq % 8 == 7)
    {
      log_line("heap free %u B, stack left: Echo %lu Sensor %lu Logger %lu words\r\n",
               (unsigned)xPortGetFreeHeapSize(),
               (unsigned long)osThreadGetStackSpace(echoHandle) / 4,
               (unsigned long)osThreadGetStackSpace(sensorHandle) / 4,
               (unsigned long)osThreadGetStackSpace(loggerHandle) / 4);
    }
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
  /* The USART2 interrupt calls FreeRTOS (osMessageQueuePut from the ISR):
     its priority must be numerically >= configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY
     (5), or configASSERT stops the system. */
  HAL_NVIC_SetPriority(USART2_IRQn, 6, 0);
}
