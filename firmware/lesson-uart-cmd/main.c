/*
 * Lesson "UART printf와 명령 파서" (D. 통신): a small command line on the
 * virtual COM port (USART2, 115200 8N1).
 *
 *   help           list the commands
 *   led on|off     LD2 (PA5) on or off
 *   blink <ms>     LD2 toggles every <ms> milliseconds (20–2000)
 *   status         what LD2 does and the uptime
 *
 * The receive interrupt collects bytes into a line; Enter (CR or LF)
 * hands the line to the main loop, which parses it with sscanf/strcmp and
 * answers "OK …" or "ERR …". Every line is echoed after "> ".
 */
#include <stdio.h>
#include <string.h>
#include "main.h"

UART_HandleTypeDef huart2;

static uint8_t rx_byte;
static char rx_line[48];
static volatile unsigned rx_len;
static char command[48];
static volatile int command_ready;

enum Mode { MODE_OFF, MODE_ON, MODE_BLINK };
static enum Mode mode = MODE_OFF;
static uint32_t blink_ms = 500;

static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);

static const char *mode_name(void)
{
  return mode == MODE_ON ? "on" : mode == MODE_OFF ? "off" : "blink";
}

static void execute(const char *cmd)
{
  unsigned long ms;
  printf("> %s\r\n", cmd);
  if (strcmp(cmd, "help") == 0)
  {
    printf("OK commands: help, led on, led off, blink <ms>, status\r\n");
  }
  else if (strcmp(cmd, "led on") == 0)
  {
    mode = MODE_ON;
    HAL_GPIO_WritePin(LD2_GPIO_Port, LD2_Pin, GPIO_PIN_SET);
    printf("OK led on\r\n");
  }
  else if (strcmp(cmd, "led off") == 0)
  {
    mode = MODE_OFF;
    HAL_GPIO_WritePin(LD2_GPIO_Port, LD2_Pin, GPIO_PIN_RESET);
    printf("OK led off\r\n");
  }
  else if (sscanf(cmd, "blink %lu", &ms) == 1)
  {
    if (ms < 20 || ms > 2000)
    {
      printf("ERR blink: 20-2000 ms\r\n");
    }
    else
    {
      mode = MODE_BLINK;
      blink_ms = ms;
      printf("OK blink %lu ms\r\n", ms);
    }
  }
  else if (strcmp(cmd, "status") == 0)
  {
    printf("OK led %s, blink %lu ms, up %lu ms\r\n", mode_name(), (unsigned long)blink_ms,
           (unsigned long)HAL_GetTick());
  }
  else
  {
    printf("ERR unknown command '%s' - type help\r\n", cmd);
  }
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  HAL_UART_Receive_IT(&huart2, &rx_byte, 1);
  printf("Command line ready - type help\r\n");

  uint32_t last_toggle = 0;
  while (1)
  {
    if (command_ready)
    {
      execute(command);
      command_ready = 0;
    }
    if (mode == MODE_BLINK && HAL_GetTick() - last_toggle >= blink_ms)
    {
      last_toggle = HAL_GetTick();
      HAL_GPIO_TogglePin(LD2_GPIO_Port, LD2_Pin);
    }
  }
}

/* One byte received: collect it; a line end hands the line over. */
void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart)
{
  if (huart->Instance == USART2)
  {
    char c = (char)rx_byte;
    if (c == '\r' || c == '\n')
    {
      if (rx_len > 0 && !command_ready)
      {
        rx_line[rx_len] = 0;
        memcpy(command, rx_line, rx_len + 1);
        command_ready = 1;
      }
      rx_len = 0;
    }
    else if (rx_len < sizeof rx_line - 1)
    {
      rx_line[rx_len++] = (c >= 'A' && c <= 'Z') ? (char)(c - 'A' + 'a') : c;
    }
    HAL_UART_Receive_IT(&huart2, &rx_byte, 1);
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
