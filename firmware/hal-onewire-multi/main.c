/*
 * CubeMX-style HAL example: three DS18B20 thermometers sharing one 1-Wire
 * line, found with SEARCH ROM and read one by one with MATCH ROM.
 *
 *   D2 (PA10)   DQ of all three sensors, open-drain (each module has a
 *               4.7 kΩ pull-up to 3V3)
 *
 * The slots are bit-banged with the DWT cycle counter for delays, as in
 * hal-sonar-onewire. At start-up the search (Maxim application note 187)
 * walks the ROM-code tree: in each bit position every sensor still taking
 * part sends its bit and then the complement; both 0 means the sensors
 * disagree there, and the host picks a branch, writing the direction so
 * that the others drop out until the next reset. Then, every second:
 * SKIP ROM + CONVERT T (all convert at once), wait, and for each sensor
 * MATCH ROM + READ SCRATCHPAD.
 */
#include <stdio.h>
#include "main.h"

UART_HandleTypeDef huart2;

static void MX_GPIO_Init(void);
static void MX_USART2_UART_Init(void);

/* ---------------------------------------------- microsecond delays */

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

/* ---------------------------------------------------------- 1-Wire */

#define DQ_LOW() (GPIOA->BSRR = GPIO_PIN_10 << 16)
#define DQ_RELEASE() (GPIOA->BSRR = GPIO_PIN_10)
#define DQ_READ() ((GPIOA->IDR & GPIO_PIN_10) != 0)

static int ow_reset(void)
{
  DQ_LOW();
  delay_us(480);
  DQ_RELEASE();
  delay_us(70);
  int present = !DQ_READ();
  delay_us(410);
  return present;
}

static void ow_write_bit(int one)
{
  __disable_irq();
  DQ_LOW();
  if (one)
  {
    delay_us(6);
    DQ_RELEASE();
    delay_us(64);
  }
  else
  {
    delay_us(60);
    DQ_RELEASE();
    delay_us(10);
  }
  __enable_irq();
}

static int ow_read_bit(void)
{
  __disable_irq();
  DQ_LOW();
  delay_us(6);
  DQ_RELEASE();
  delay_us(9);
  int bit = DQ_READ();
  __enable_irq();
  delay_us(55);
  return bit;
}

static void ow_write(uint8_t b)
{
  for (int i = 0; i < 8; i++, b >>= 1)
  {
    ow_write_bit(b & 1);
  }
}

static uint8_t ow_read(void)
{
  uint8_t b = 0;
  for (int i = 0; i < 8; i++)
  {
    if (ow_read_bit())
    {
      b |= 1 << i;
    }
  }
  return b;
}

static uint8_t crc8(const uint8_t *p, int n)
{
  uint8_t crc = 0;
  while (n--)
  {
    uint8_t x = *p++;
    for (int i = 0; i < 8; i++, x >>= 1)
    {
      uint8_t mix = (crc ^ x) & 1;
      crc >>= 1;
      if (mix)
      {
        crc ^= 0x8C;
      }
    }
  }
  return crc;
}

/* ------------------------------------------------------- SEARCH ROM */

#define MAX_SENSORS 8

static uint8_t roms[MAX_SENSORS][8];
static int sensors;

/* Find every ROM code on the line. Returns how many. */
static int ow_search_all(void)
{
  uint8_t rom[8] = {0};
  int last_discrepancy = -1, n = 0;
  do
  {
    if (!ow_reset())
    {
      return n;
    }
    ow_write(0xF0); /* SEARCH ROM */
    int last_zero = -1;
    for (int i = 0; i < 64; i++)
    {
      int bit = ow_read_bit();  /* the bit of every sensor, ANDed */
      int comp = ow_read_bit(); /* and its complement */
      int dir;
      if (bit && comp)
      {
        return n; /* nobody answered */
      }
      else if (bit != comp)
      {
        dir = bit; /* all remaining sensors agree */
      }
      else
      {
        /* Discrepancy: before the last one take the same branch as last
         * time, at it take 1 now, beyond it start with 0. */
        if (i < last_discrepancy)
        {
          dir = (rom[i / 8] >> (i % 8)) & 1;
        }
        else
        {
          dir = i == last_discrepancy;
        }
        if (!dir)
        {
          last_zero = i;
        }
      }
      if (dir)
      {
        rom[i / 8] |= 1 << (i % 8);
      }
      else
      {
        rom[i / 8] &= ~(1 << (i % 8));
      }
      ow_write_bit(dir); /* sensors with the other bit drop out */
    }
    if (crc8(rom, 8) == 0 && n < MAX_SENSORS)
    {
      for (int k = 0; k < 8; k++)
      {
        roms[n][k] = rom[k];
      }
      n++;
    }
    last_discrepancy = last_zero;
  } while (last_discrepancy >= 0);
  return n;
}

static void print_rom(const uint8_t *r)
{
  printf("%02X-%02X%02X%02X%02X%02X%02X", r[0], r[6], r[5], r[4], r[3], r[2], r[1]);
}

/* Temperature of one sensor in 1/16 °C; 0 if its scratchpad fails the CRC. */
static int read_temp(const uint8_t *rom, int16_t *t16)
{
  if (!ow_reset())
  {
    return 0;
  }
  ow_write(0x55); /* MATCH ROM: only this sensor answers */
  for (int k = 0; k < 8; k++)
  {
    ow_write(rom[k]);
  }
  ow_write(0xBE); /* READ SCRATCHPAD */
  uint8_t pad[9];
  for (int i = 0; i < 9; i++)
  {
    pad[i] = ow_read();
  }
  *t16 = (int16_t)(pad[1] << 8 | pad[0]);
  return crc8(pad, 9) == 0;
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  dwt_init();
  printf("1-Wire bus on D2: SEARCH ROM\r\n");

  sensors = ow_search_all();
  printf("found %d sensor%s\r\n", sensors, sensors == 1 ? "" : "s");
  for (int i = 0; i < sensors; i++)
  {
    printf("#%d ROM ", i + 1);
    print_rom(roms[i]);
    printf("\r\n");
  }

  while (1)
  {
    if (ow_reset())
    {
      ow_write(0xCC); /* SKIP ROM: every sensor */
      ow_write(0x44); /* CONVERT T, 750 ms at 12 bits */
    }
    HAL_Delay(800);
    for (int i = 0; i < sensors; i++)
    {
      int16_t t16;
      printf("#%d ", i + 1);
      print_rom(roms[i]);
      if (read_temp(roms[i], &t16))
      {
        int t100 = t16 * 100 / 16;
        int a = t100 < 0 ? -t100 : t100;
        printf(" %s%d.%02d C\r\n", t100 < 0 ? "-" : "", a / 100, a % 100);
      }
      else
      {
        printf(" CRC error\r\n");
      }
    }
    printf("--\r\n");
    HAL_Delay(200);
  }
}

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef g = {0};
  __HAL_RCC_GPIOA_CLK_ENABLE();
  DQ_RELEASE();
  g.Pin = GPIO_PIN_10;
  g.Mode = GPIO_MODE_OUTPUT_OD;
  g.Pull = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_HIGH;
  HAL_GPIO_Init(GPIOA, &g);
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
