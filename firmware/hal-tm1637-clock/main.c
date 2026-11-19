/*
 * CubeMX-style HAL example: a minutes:seconds clock on a TM1637 4-digit
 * 7-segment display, bit-banged on two GPIO pins with DWT delays.
 *
 *   D2 (PA10)  TM1637 CLK  (open drain; the module has 10 kΩ pull-ups)
 *   D3 (PB3)   TM1637 DIO  (open drain, read back for the ACK)
 *   3V3, GND   module VCC and GND
 *   B1 (PC13)  next brightness (0–7)
 *
 * The TM1637 is not I2C: START is DIO falling while CLK is high, STOP DIO
 * rising while CLK is high, and bytes go LSB first, one bit per CLK
 * rising edge. After the eighth bit the chip pulls DIO low for one clock
 * (ACK). A frame here is: data command 0x40 (auto-increment), then
 * address 0xC0 and four segment bytes, then display control 0x88 |
 * brightness. Bit 7 of digit 1 is the colon.
 */
#include <stdio.h>
#include "main.h"

#define CLK_PORT GPIOA
#define CLK_PIN GPIO_PIN_10
#define DIO_PORT GPIOB
#define DIO_PIN GPIO_PIN_3

UART_HandleTypeDef huart2;

static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);

/* Segments a–g of 0–9. */
static const uint8_t DIGITS[10] = {0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07, 0x7F, 0x6F};

/* ------------------------------------------------------- DWT delay */

static void dwt_init(void)
{
  CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
  DWT->CYCCNT = 0;
  DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
}

static void delay_us(uint32_t us)
{
  uint32_t start = DWT->CYCCNT, ticks = us * (SystemCoreClock / 1000000);
  while (DWT->CYCCNT - start < ticks)
  {
  }
}

/* ---------------------------------------------------------- TM1637 */

/* Open drain: "high" releases the line to the pull-up. */
#define CLK(x) HAL_GPIO_WritePin(CLK_PORT, CLK_PIN, (x) ? GPIO_PIN_SET : GPIO_PIN_RESET)
#define DIO(x) HAL_GPIO_WritePin(DIO_PORT, DIO_PIN, (x) ? GPIO_PIN_SET : GPIO_PIN_RESET)
#define HALF 5 /* µs per half clock: 100 kHz */

static int nacks;

static void tm_start(void)
{
  CLK(1);
  DIO(1);
  delay_us(HALF);
  DIO(0); /* DIO falls while CLK is high */
  delay_us(HALF);
}

static void tm_stop(void)
{
  CLK(0);
  delay_us(HALF);
  DIO(0);
  delay_us(HALF);
  CLK(1);
  delay_us(HALF);
  DIO(1); /* DIO rises while CLK is high */
  delay_us(HALF);
}

/* One byte, LSB first; returns 1 if the chip acknowledged. */
static int tm_write(uint8_t b)
{
  for (int i = 0; i < 8; i++)
  {
    CLK(0);
    DIO((b >> i) & 1); /* change DIO only while CLK is low */
    delay_us(HALF);
    CLK(1); /* the chip samples on the rising edge */
    delay_us(HALF);
  }
  CLK(0);
  DIO(1); /* release DIO: the chip pulls it low */
  delay_us(HALF);
  CLK(1);
  int ack = HAL_GPIO_ReadPin(DIO_PORT, DIO_PIN) == GPIO_PIN_RESET;
  delay_us(HALF);
  CLK(0);
  if (!ack)
  {
    nacks++;
  }
  return ack;
}

static void tm_show(const uint8_t seg[4], int brightness)
{
  tm_start();
  tm_write(0x40); /* data command: write, auto-increment */
  tm_stop();
  tm_start();
  tm_write(0xC0); /* address 0 */
  for (int i = 0; i < 4; i++)
  {
    tm_write(seg[i]);
  }
  tm_stop();
  tm_start();
  tm_write((uint8_t)(0x88 | (brightness & 7))); /* display on */
  tm_stop();
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  dwt_init();
  printf("TM1637 on D2 (CLK) / D3 (DIO), bit-banged at 100 kHz\r\n");

  int brightness = 7;
  uint32_t last = (uint32_t)-1;
  int was_pressed = 0;
  while (1)
  {
    int pressed = HAL_GPIO_ReadPin(B1_GPIO_Port, B1_Pin) == GPIO_PIN_RESET;
    if (pressed && !was_pressed)
    {
      brightness = (brightness + 1) % 8;
      printf("brightness %d\r\n", brightness);
      last = (uint32_t)-1; /* redraw now */
    }
    was_pressed = pressed;

    uint32_t ms = HAL_GetTick();
    uint32_t half = ms / 500;
    if (half != last)
    {
      last = half;
      uint32_t s = ms / 1000;
      int mm = (int)(s / 60 % 100), ss = (int)(s % 60);
      uint8_t seg[4] = {DIGITS[mm / 10], DIGITS[mm % 10], DIGITS[ss / 10], DIGITS[ss % 10]};
      if (half % 2 == 0)
      {
        seg[1] |= 0x80; /* colon on for the first half of each second */
      }
      int before = nacks;
      tm_show(seg, brightness);
      if (nacks != before)
      {
        printf("TM1637: no ACK (%d) - check CLK/DIO and power\r\n", nacks - before);
      }
      else if (half % 2 == 0)
      {
        printf("%02d:%02d\r\n", mm, ss);
      }
    }
    HAL_Delay(10);
  }
}

/* ------------------------------------------------------- peripherals */

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef g = {0};
  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOC_CLK_ENABLE();
  HAL_GPIO_WritePin(CLK_PORT, CLK_PIN, GPIO_PIN_SET);
  HAL_GPIO_WritePin(DIO_PORT, DIO_PIN, GPIO_PIN_SET);
  g.Mode = GPIO_MODE_OUTPUT_OD;
  g.Pull = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_HIGH;
  g.Pin = CLK_PIN;
  HAL_GPIO_Init(CLK_PORT, &g);
  g.Pin = DIO_PIN;
  HAL_GPIO_Init(DIO_PORT, &g);
  g.Pin = B1_Pin;
  g.Mode = GPIO_MODE_INPUT;
  HAL_GPIO_Init(B1_GPIO_Port, &g);
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
