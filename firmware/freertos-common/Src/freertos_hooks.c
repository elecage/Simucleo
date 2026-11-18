/* Application hooks (CubeMX puts these in freertos.c). */
#include "FreeRTOS.h"
#include "task.h"

void vApplicationStackOverflowHook(TaskHandle_t xTask, char *pcTaskName)
{
  (void)xTask;
  (void)pcTaskName;
  /* The simulator reports the task name from here. */
  taskDISABLE_INTERRUPTS();
  for (;;)
  {
  }
}
