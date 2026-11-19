/*
 * CubeMX-style HAL example: an HC-05 Bluetooth module on USART1 lets a
 * phone switch LD2.
 *
 *   D8 (PA9,  USART1_TX)  → HC-05 RXD
 *   D2 (PA10, USART1_RX)  ← HC-05 TXD
 *   D7 (PA8)              ← HC-05 STATE (high while a phone is connected)
 *   5V, GND               → HC-05 VCC, GND
 *
 * The module's data mode runs at 9600 baud 8N1 (its default). Bytes from
 * the phone arrive one by one in the receive interrupt and are collected
 * into lines; each line is a command:
 *   on / off / blink   LD2 on, off, or blinking at 2 Hz
 *   status             what LD2 does and for how long the board has run
 * Every command gets a reply on the phone, and a log line goes to the
 * virtual COM port (USART2, 115200 baud).
 */
#include <ctype.h>
#include <stdio.h>
#include <string.h>
#include "main.h"

UART_HandleTypeDef huart1;
UART_HandleTypeDef huart2;

static void MX_GPIO_Init(void);
static void MX_USART1_UART_Init(void);
static void MX_USART2_UART_Init(void);

/* --------------------------------------------- receive from the phone */

static uint8_t rx_byte;
static volatile char line[32];
static volatile int line_len;
static volatile int line_ready;

void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart)
{
  if (huart->Instance == USART1)
  {
    char c = (char)rx_byte;
    if (c == '\r' || c == '\n')
    {
      if (line_len > 0)
      {
        line[line_len] = 0;
        line_ready = 1;
      }
    }
    else if (!line_ready && line_len < (int)sizeof line - 1)
    {
      line[line_len++] = c;
    }
    HAL_UART_Receive_IT(&huart1, &rx_byte, 1);
  }
}

void HAL_UART_ErrorCallback(UART_HandleTypeDef *huart)
{
  /* Overrun or framing error (a wrong baud rate): listen again. */
  if (huart->Instance == USART1)
  {
    HAL_UART_Receive_IT(&huart1, &rx_byte, 1);
  }
}

/* Send a string to the phone. */
static void bt_print(const char *s)
{
  HAL_UART_Transmit(&huart1, (uint8_t *)s, (uint16_t)strlen(s), 1000);
}

/* ---------------------------------------------------------------- LED */

enum Mode
{
  LED_OFF,
  LED_ON,
  LED_BLINK
};

static enum Mode mode = LED_OFF;
static uint32_t mode_since;

static const char *mode_name(enum Mode m)
{
  return m == LED_ON ? "ON" : m == LED_BLINK ? "BLINKING" : "OFF";
}

static void set_mode(enum Mode m)
{
  mode = m;
  mode_since = HAL_GetTick();
  HAL_GPIO_WritePin(LD2_GPIO_Port, LD2_Pin, m == LED_ON ? GPIO_PIN_SET : GPIO_PIN_RESET);
}

static void command(char *cmd)
{
  char reply[96];
  for (char *p = cmd; *p; p++)
  {
    *p = (char)tolower((unsigned char)*p);
  }
  printf("[BT] rx: %s\r\n", cmd);
  if (strcmp(cmd, "on") == 0)
  {
    set_mode(LED_ON);
    snprintf(reply, sizeof reply, "LED ON\r\n");
  }
  else if (strcmp(cmd, "off") == 0)
  {
    set_mode(LED_OFF);
    snprintf(reply, sizeof reply, "LED OFF\r\n");
  }
  else if (strcmp(cmd, "blink") == 0)
  {
    set_mode(LED_BLINK);
    snprintf(reply, sizeof reply, "LED BLINK (2 Hz)\r\n");
  }
  else if (strcmp(cmd, "status") == 0)
  {
    snprintf(reply, sizeof reply, "LED %s for %lu s, up %lu s\r\n", mode_name(mode),
             (unsigned long)((HAL_GetTick() - mode_since) / 1000), (unsigned long)(HAL_GetTick() / 1000));
  }
  else
  {
    snprintf(reply, sizeof reply, "? '%s' - try on, off, blink, status\r\n", cmd);
  }
  bt_print(reply);
  printf("[BT] tx: %s", reply);
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  MX_USART1_UART_Init();
  printf("HC-05 on USART1 (D8 TX, D2 RX) at 9600 baud, STATE on D7\r\n");
  HAL_UART_Receive_IT(&huart1, &rx_byte, 1);
  set_mode(LED_OFF);

  int connected = 0;
  uint32_t last_blink = 0;
  while (1)
  {
    /* STATE goes high when a phone connects. */
    int state = HAL_GPIO_ReadPin(GPIOA, GPIO_PIN_8) == GPIO_PIN_SET;
    if (state != connected)
    {
      connected = state;
      printf("[BT] phone %s\r\n", connected ? "connected" : "disconnected");
      if (connected)
      {
        HAL_Delay(50);
        bt_print("Nucleo LED ready: on, off, blink, status\r\n");
      }
    }
    if (line_ready)
    {
      char cmd[sizeof line];
      memcpy(cmd, (const char *)line, sizeof cmd);
      line_len = 0;
      line_ready = 0;
      command(cmd);
    }
    if (mode == LED_BLINK && HAL_GetTick() - last_blink >= 250)
    {
      last_blink = HAL_GetTick();
      HAL_GPIO_TogglePin(LD2_GPIO_Port, LD2_Pin);
    }
    __WFI(); /* the SysTick or a received byte wakes us */
  }
}

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef g = {0};
  __HAL_RCC_GPIOA_CLK_ENABLE();
  HAL_GPIO_WritePin(LD2_GPIO_Port, LD2_Pin, GPIO_PIN_RESET);
  g.Pin = LD2_Pin;
  g.Mode = GPIO_MODE_OUTPUT_PP;
  g.Pull = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(LD2_GPIO_Port, &g);
  /* STATE: input, pulled down while nothing drives it. */
  g.Pin = GPIO_PIN_8;
  g.Mode = GPIO_MODE_INPUT;
  g.Pull = GPIO_PULLDOWN;
  HAL_GPIO_Init(GPIOA, &g);
}

static void MX_USART1_UART_Init(void)
{
  huart1.Instance = USART1;
  huart1.Init.BaudRate = 9600; /* HC-05 data mode default */
  huart1.Init.WordLength = UART_WORDLENGTH_8B;
  huart1.Init.StopBits = UART_STOPBITS_1;
  huart1.Init.Parity = UART_PARITY_NONE;
  huart1.Init.Mode = UART_MODE_TX_RX;
  huart1.Init.HwFlowCtl = UART_HWCONTROL_NONE;
  huart1.Init.OverSampling = UART_OVERSAMPLING_16;
  if (HAL_UART_Init(&huart1) != HAL_OK)
  {
    Error_Handler();
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
