/*
 * Application images for the IAP bootloader (firmware/hal-bootloader).
 * Linked for slot A (0x08020000, iap-app.ld) with an image header right
 * after the vector table; mkimage.py fills in its size and CRC-32.
 * SystemInit keeps the vector table here: built with USER_VECT_TAB_ADDRESS
 * and VECT_TAB_OFFSET = 0x20000 (VTOR = 0x08020000).
 *
 * Variants (make VARIANT=...):
 *   v1   prints "app v1", blinks LD2 at 1 Hz
 *   v2   prints "app v2", blinks LD2 at 4 Hz
 *   bad  prints "app bad", then hangs waiting for something that never
 *        comes: it neither refreshes the watchdog nor confirms itself, so
 *        the IWDG resets the board and after 3 tries the bootloader rolls
 *        back to the backup.
 * A good image confirms itself on its first run after an update (a
 * "confirmed" record in the metadata sector) and refreshes the IWDG
 * whenever it runs (the bootloader starts it for a trial boot; refreshing
 * a watchdog that is not running does nothing). Typing 'b' resets into
 * the bootloader.
 */
#include <stdio.h>
#include "main.h"
#include "bootmeta.h"

#if defined(APP_V1)
#define APP_VERSION 1u
#define APP_NAME "v1"
#define HALF_PERIOD_MS 500u
#elif defined(APP_V2)
#define APP_VERSION 2u
#define APP_NAME "v2"
#define HALF_PERIOD_MS 125u
#elif defined(APP_BAD)
#define APP_VERSION 3u
#define APP_NAME "bad"
#define HALF_PERIOD_MS 1000u /* never reached */
#else
#error "build with VARIANT=v1, v2 or bad"
#endif

/* size and crc32 are filled in by mkimage.py after the link. */
__attribute__((section(".image_header"), used))
const image_header_t image_header = {IMAGE_MAGIC, APP_VERSION, 0, 0};

UART_HandleTypeDef huart2;
static uint8_t rx_byte;
static volatile int to_bootloader;

static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);

void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart)
{
  if (huart->Instance == USART2)
  {
    if (rx_byte == 'b' || rx_byte == 'B')
    {
      to_bootloader = 1;
    }
    HAL_UART_Receive_IT(&huart2, &rx_byte, 1);
  }
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  iwdg_refresh();

  printf("app " APP_NAME " (version %lu) running from 0x%08lX, VTOR 0x%08lX\r\n",
         (unsigned long)APP_VERSION, (unsigned long)SLOT_A, (unsigned long)SCB->VTOR);

#if defined(APP_BAD)
  /* Waits for a sensor that never answers: no watchdog refresh, no
   * confirmation. */
  static volatile int sensor_ready;
  while (!sensor_ready)
  {
    __WFI();
  }
#endif

  const boot_meta_t *m = meta_last(0);
  if (m && m->state == META_TRIAL && m->version == APP_VERSION)
  {
    /* Our first run after an update got this far: tell the bootloader to
     * keep us. */
    if (meta_append(META_CONFIRMED, m->tries, APP_VERSION) == 0)
    {
      printf("confirmed\r\n");
    }
    else
    {
      printf("could not confirm (flash error)\r\n");
    }
  }
  printf("type 'b' for the bootloader\r\n");
  HAL_UART_Receive_IT(&huart2, &rx_byte, 1);

  while (1)
  {
    iwdg_refresh();
    HAL_GPIO_TogglePin(LD2_GPIO_Port, LD2_Pin);
    uint32_t t0 = HAL_GetTick();
    while (HAL_GetTick() - t0 < HALF_PERIOD_MS)
    {
      if (to_bootloader)
      {
        printf("resetting into the bootloader\r\n");
        NVIC_SystemReset();
      }
      __WFI();
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
