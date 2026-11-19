/*
 * CubeMX-style HAL example: a BMP280 barometer on I2C1, read with the
 * Bosch compensation code from the datasheet.
 *
 *   D15 (PB8, I2C1_SCL), D14 (PB9, I2C1_SDA), 100 kHz
 *   BMP280 module at 0x76 (SDO to GND; 0x77 with SDO high), VCC 3V3
 *
 * Start-up: check the chip id (0xD0 = 0x58), soft reset (0xE0 = 0xB6),
 * read the 24 trimming bytes at 0x88 (dig_T1–T3, dig_P1–P9, little
 * endian). Every second a forced measurement is started (ctrl_meas 0xF4:
 * temperature ×2, pressure ×16, mode 01); status 0xF3 bit 3 is polled
 * until it is done, then the raw 20-bit values are read from 0xF7–0xFC
 * and compensated in integer arithmetic (BST-BMP280-DS001 §8.2). The
 * altitude comes from the barometric formula against 1013.25 hPa.
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include "main.h"

#define BMP_ADDR (0x76 << 1)

UART_HandleTypeDef huart2;
I2C_HandleTypeDef hi2c1;

static void MX_I2C1_Init(void);
static void MX_USART2_UART_Init(void);

/* ---------------------------------------------------------- BMP280 */

static uint16_t dig_T1, dig_P1;
static int16_t dig_T2, dig_T3, dig_P2, dig_P3, dig_P4, dig_P5, dig_P6, dig_P7, dig_P8, dig_P9;
static int32_t t_fine;

static HAL_StatusTypeDef bmp_read(uint8_t reg, uint8_t *buf, uint16_t n)
{
  return HAL_I2C_Mem_Read(&hi2c1, BMP_ADDR, reg, I2C_MEMADD_SIZE_8BIT, buf, n, 20);
}

static HAL_StatusTypeDef bmp_write(uint8_t reg, uint8_t v)
{
  return HAL_I2C_Mem_Write(&hi2c1, BMP_ADDR, reg, I2C_MEMADD_SIZE_8BIT, &v, 1, 20);
}

/* Temperature in 0.01 °C (datasheet: bmp280_compensate_T_int32). */
static int32_t compensate_T(int32_t adc_T)
{
  int32_t var1 = ((((adc_T >> 3) - ((int32_t)dig_T1 << 1))) * ((int32_t)dig_T2)) >> 11;
  int32_t var2 = (((((adc_T >> 4) - ((int32_t)dig_T1)) * ((adc_T >> 4) - ((int32_t)dig_T1))) >> 12) *
                  ((int32_t)dig_T3)) >> 14;
  t_fine = var1 + var2;
  return (t_fine * 5 + 128) >> 8;
}

/* Pressure in Pa as Q24.8 (datasheet: bmp280_compensate_P_int64). */
static uint32_t compensate_P(int32_t adc_P)
{
  int64_t var1 = ((int64_t)t_fine) - 128000;
  int64_t var2 = var1 * var1 * (int64_t)dig_P6;
  var2 = var2 + ((var1 * (int64_t)dig_P5) << 17);
  var2 = var2 + (((int64_t)dig_P4) << 35);
  var1 = ((var1 * var1 * (int64_t)dig_P3) >> 8) + ((var1 * (int64_t)dig_P2) << 12);
  var1 = (((((int64_t)1) << 47) + var1)) * ((int64_t)dig_P1) >> 33;
  if (var1 == 0)
  {
    return 0; /* avoid a division by zero */
  }
  int64_t p = 1048576 - adc_P;
  p = (((p << 31) - var2) * 3125) / var1;
  var1 = (((int64_t)dig_P9) * (p >> 13) * (p >> 13)) >> 25;
  var2 = (((int64_t)dig_P8) * p) >> 19;
  p = ((p + var1 + var2) >> 8) + (((int64_t)dig_P7) << 4);
  return (uint32_t)p;
}

static int bmp_init(void)
{
  uint8_t id = 0;
  if (bmp_read(0xD0, &id, 1) != HAL_OK)
  {
    printf("BMP280 does not answer at 0x76 (SDO to GND?)\r\n");
    return -1;
  }
  printf("chip id 0x%02X%s\r\n", id, id == 0x58 ? " (BMP280)" : " (not a BMP280?)");
  bmp_write(0xE0, 0xB6); /* soft reset */
  HAL_Delay(5);
  uint8_t c[24];
  bmp_read(0x88, c, sizeof c);
  dig_T1 = (uint16_t)(c[1] << 8 | c[0]);
  dig_T2 = (int16_t)(c[3] << 8 | c[2]);
  dig_T3 = (int16_t)(c[5] << 8 | c[4]);
  dig_P1 = (uint16_t)(c[7] << 8 | c[6]);
  int16_t *ps[8] = {&dig_P2, &dig_P3, &dig_P4, &dig_P5, &dig_P6, &dig_P7, &dig_P8, &dig_P9};
  for (int i = 0; i < 8; i++)
  {
    *ps[i] = (int16_t)(c[9 + 2 * i] << 8 | c[8 + 2 * i]);
  }
  printf("dig_T1 %u T2 %d T3 %d  dig_P1 %u P9 %d\r\n", dig_T1, dig_T2, dig_T3, dig_P1, dig_P9);
  bmp_write(0xF5, 0x00); /* no IIR filter */
  return 0;
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_I2C1_Init();
  MX_USART2_UART_Init();
  printf("BMP280 on I2C1 (D15/D14)\r\n");
  while (bmp_init() != 0)
  {
    HAL_Delay(1000);
  }

  while (1)
  {
    /* Forced mode: osrs_t = x2 (010), osrs_p = x16 (101), mode 01. */
    uint32_t start = HAL_GetTick();
    bmp_write(0xF4, 0x40 | 0x14 | 0x01);
    uint8_t status = 0;
    do
    {
      HAL_Delay(2);
      bmp_read(0xF3, &status, 1); /* bit 3: measuring */
    } while ((status & 0x08) && HAL_GetTick() - start < 200);
    uint32_t took = HAL_GetTick() - start;

    uint8_t d[6];
    bmp_read(0xF7, d, 6);
    int32_t adc_P = (int32_t)d[0] << 12 | (int32_t)d[1] << 4 | d[2] >> 4;
    int32_t adc_T = (int32_t)d[3] << 12 | (int32_t)d[4] << 4 | d[5] >> 4;
    int32_t t = compensate_T(adc_T);         /* 0.01 °C */
    uint32_t p = compensate_P(adc_P) / 256;  /* Pa */
    float alt = 44330.0f * (1.0f - powf((float)p / 101325.0f, 0.1903f));
    int a10 = (int)lroundf(alt * 10.0f);
    printf("T %s%ld.%02ld C  P %lu.%02lu hPa  alt %s%d.%d m  (raw T %ld P %ld, conversion %lu ms)\r\n", t < 0 ? "-" : "",
           (long)(labs(t) / 100), (long)(labs(t) % 100), (unsigned long)(p / 100), (unsigned long)(p % 100),
           a10 < 0 ? "-" : "", abs(a10) / 10, abs(a10) % 10, (long)adc_T, (long)adc_P, (unsigned long)took);
    HAL_Delay(1000);
  }
}

/* ------------------------------------------------------- peripherals */

static void MX_I2C1_Init(void)
{
  hi2c1.Instance = I2C1;
  hi2c1.Init.ClockSpeed = 100000;
  hi2c1.Init.DutyCycle = I2C_DUTYCYCLE_2;
  hi2c1.Init.AddressingMode = I2C_ADDRESSINGMODE_7BIT;
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
