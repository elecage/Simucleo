/*
 * Lesson "프로젝트: 디지털 시계" (G. 프로젝트): hours and minutes from a
 * DS3231 real-time clock on a TM1637 display, set with two buttons.
 *
 *   D15 (PB8, I2C1_SCL), D14 (PB9, I2C1_SDA)  DS3231 at 0x68 (3V3, GND)
 *   D2 (PA10)  TM1637 CLK  \ open drain, bit-banged with DWT delays
 *   D3 (PB3)   TM1637 DIO  /  (the module has the pull-ups; 3V3, GND)
 *   D4 (PB5)   button to GND (internal pull-up): hour + 1
 *   B1 (PC13)  minute + 1 (and the seconds back to 00)
 *
 * The RTC keeps the time (BCD registers 0x00 seconds, 0x01 minutes,
 * 0x02 hours, 24-hour mode); the MCU only reads it every 50 ms, shows
 * HH:MM with the colon blinking once a second, and writes a register when
 * a button is pressed. Each new second is printed on the virtual COM port
 * (USART2, 115200 8N1).
 */
#include <stdio.h>
#include "main.h"

#define RTC_ADDR (0x68 << 1)
#define CLK_PORT GPIOA
#define CLK_PIN GPIO_PIN_10
#define DIO_PORT GPIOB
#define DIO_PIN GPIO_PIN_3
#define BTN_PORT GPIOB
#define BTN_PIN GPIO_PIN_5

UART_HandleTypeDef huart2;
I2C_HandleTypeDef hi2c1;

static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);
static void MX_I2C1_Init(void);

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

#define CLK(x) HAL_GPIO_WritePin(CLK_PORT, CLK_PIN, (x) ? GPIO_PIN_SET : GPIO_PIN_RESET)
#define DIO(x) HAL_GPIO_WritePin(DIO_PORT, DIO_PIN, (x) ? GPIO_PIN_SET : GPIO_PIN_RESET)
#define HALF 5

static void tm_start(void)
{
  CLK(1);
  DIO(1);
  delay_us(HALF);
  DIO(0);
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
  DIO(1);
  delay_us(HALF);
}

static int tm_write(uint8_t b)
{
  for (int i = 0; i < 8; i++)
  {
    CLK(0);
    DIO((b >> i) & 1);
    delay_us(HALF);
    CLK(1);
    delay_us(HALF);
  }
  CLK(0);
  DIO(1);
  delay_us(HALF);
  CLK(1);
  int ack = HAL_GPIO_ReadPin(DIO_PORT, DIO_PIN) == GPIO_PIN_RESET;
  delay_us(HALF);
  CLK(0);
  return ack;
}

static int tm_show(const uint8_t seg[4])
{
  int acks = 0;
  tm_start();
  acks += tm_write(0x40);
  tm_stop();
  tm_start();
  acks += tm_write(0xC0);
  for (int i = 0; i < 4; i++)
  {
    acks += tm_write(seg[i]);
  }
  tm_stop();
  tm_start();
  acks += tm_write(0x8F); /* display on, brightness 7 */
  tm_stop();
  return acks == 7;
}

/* ----------------------------------------------------------- DS3231 */

static int bcd2bin(uint8_t b) { return (b >> 4) * 10 + (b & 0x0F); }
static uint8_t bin2bcd(int v) { return (uint8_t)(((v / 10) << 4) | (v % 10)); }

static HAL_StatusTypeDef rtc_read(int *h, int *m, int *s)
{
  uint8_t r[3];
  HAL_StatusTypeDef st = HAL_I2C_Mem_Read(&hi2c1, RTC_ADDR, 0x00, I2C_MEMADD_SIZE_8BIT, r, 3, 100);
  if (st == HAL_OK)
  {
    *s = bcd2bin(r[0] & 0x7F);
    *m = bcd2bin(r[1] & 0x7F);
    *h = bcd2bin(r[2] & 0x3F); /* 24-hour mode */
  }
  return st;
}

static void rtc_write(uint8_t reg, uint8_t value)
{
  HAL_I2C_Mem_Write(&hi2c1, RTC_ADDR, reg, I2C_MEMADD_SIZE_8BIT, &value, 1, 100);
}

/* ------------------------------------------------------------- main */

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  MX_I2C1_Init();
  dwt_init();
  printf("Clock: DS3231 on I2C1, TM1637 on D2/D3, D4 = hour+, B1 = minute+\r\n");

  int last_sec = -1, btn_was = 0, b1_was = 0, warned = 0;
  while (1)
  {
    int h, m, s;
    if (rtc_read(&h, &m, &s) != HAL_OK)
    {
      if (!warned)
      {
        printf("RTC not answering - check SDA/SCL and power\r\n");
        warned = 1;
      }
      HAL_Delay(200);
      continue;
    }
    warned = 0;

    int btn = HAL_GPIO_ReadPin(BTN_PORT, BTN_PIN) == GPIO_PIN_RESET;
    int b1 = HAL_GPIO_ReadPin(B1_GPIO_Port, B1_Pin) == GPIO_PIN_RESET;
    if (btn && !btn_was)
    {
      h = (h + 1) % 24;
      rtc_write(0x02, bin2bcd(h));
      printf("hour -> %02d\r\n", h);
      last_sec = -1;
    }
    if (b1 && !b1_was)
    {
      m = (m + 1) % 60;
      s = 0;
      rtc_write(0x01, bin2bcd(m));
      rtc_write(0x00, 0x00);
      printf("minute -> %02d\r\n", m);
      last_sec = -1;
    }
    btn_was = btn;
    b1_was = b1;

    if (s != last_sec)
    {
      last_sec = s;
      uint8_t seg[4] = {DIGITS[h / 10], DIGITS[h % 10], DIGITS[m / 10], DIGITS[m % 10]};
      if (s % 2 == 0)
      {
        seg[1] |= 0x80; /* colon on every other second */
      }
      if (!tm_show(seg))
      {
        printf("TM1637: no ACK - check CLK/DIO and power\r\n");
      }
      printf("%02d:%02d:%02d\r\n", h, m, s);
    }
    HAL_Delay(50);
  }
}

/* ------------------------------------------------------- peripherals */

static void MX_I2C1_Init(void)
{
  hi2c1.Instance = I2C1;
  hi2c1.Init.ClockSpeed = 100000;
  hi2c1.Init.DutyCycle = I2C_DUTYCYCLE_2;
  hi2c1.Init.OwnAddress1 = 0;
  hi2c1.Init.AddressingMode = I2C_ADDRESSINGMODE_7BIT;
  hi2c1.Init.DualAddressMode = I2C_DUALADDRESS_DISABLE;
  hi2c1.Init.OwnAddress2 = 0;
  hi2c1.Init.GeneralCallMode = I2C_GENERALCALL_DISABLE;
  hi2c1.Init.NoStretchMode = I2C_NOSTRETCH_DISABLE;
  if (HAL_I2C_Init(&hi2c1) != HAL_OK)
  {
    Error_Handler();
  }
}

void HAL_I2C_MspInit(I2C_HandleTypeDef *hi2c)
{
  GPIO_InitTypeDef g = {0};
  if (hi2c->Instance == I2C1)
  {
    __HAL_RCC_GPIOB_CLK_ENABLE();
    g.Pin = GPIO_PIN_8 | GPIO_PIN_9;
    g.Mode = GPIO_MODE_AF_OD;
    g.Pull = GPIO_NOPULL;
    g.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
    g.Alternate = GPIO_AF4_I2C1;
    HAL_GPIO_Init(GPIOB, &g);
    __HAL_RCC_I2C1_CLK_ENABLE();
  }
}

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
  g.Mode = GPIO_MODE_INPUT;
  g.Pull = GPIO_PULLUP;
  g.Pin = BTN_PIN;
  HAL_GPIO_Init(BTN_PORT, &g);
  g.Pull = GPIO_NOPULL;
  g.Pin = B1_Pin;
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
