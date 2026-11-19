/*
 * CubeMX-style HAL example: an MPU-6050 tilt sensor rolls a dot across an
 * 8×8 LED matrix driven by a MAX7219.
 *
 *   D15 (PB8), D14 (PB9)   I2C1 → MPU-6050 at 0x68 (AD0 low), VCC 3V3
 *   D13 (PA5)              SPI1 SCK  → MAX7219 CLK
 *   D11 (PA7)              SPI1 MOSI → MAX7219 DIN
 *   D10 (PB6)              GPIO      → MAX7219 CS (LOAD), VCC 5V
 *
 * The MPU-6050 wakes up (PWR_MGMT_1 = 0) with ±2 g and ±250 °/s, then 14
 * bytes are read from ACCEL_XOUT_H every 100 ms with HAL_I2C_Mem_Read.
 * Roll and pitch come from the direction of gravity; the dot sits where a
 * ball would roll on the tilted board (±45° spans the matrix).
 *
 * The MAX7219 takes 16-bit frames (address, data) MSB first while CS is
 * low and acts on them when CS goes high: here two 8-bit SPI bytes each.
 * Digit registers 1–8 are the rows, top first, bit 7 the left column.
 */
#include <math.h>
#include <stdio.h>
#include "main.h"

#define MPU_ADDR (0x68 << 1)
#define MAX_CS_PORT GPIOB
#define MAX_CS_PIN GPIO_PIN_6

UART_HandleTypeDef huart2;
I2C_HandleTypeDef hi2c1;
SPI_HandleTypeDef hspi1;

static void MX_GPIO_Init(void);
static void MX_I2C1_Init(void);
static void MX_SPI1_Init(void);
static void MX_USART2_UART_Init(void);

/* ------------------------------------------------------------ MAX7219 */

static void max7219_write(uint8_t reg, uint8_t value)
{
  uint8_t frame[2] = {reg, value};
  HAL_GPIO_WritePin(MAX_CS_PORT, MAX_CS_PIN, GPIO_PIN_RESET);
  HAL_SPI_Transmit(&hspi1, frame, 2, 10);
  HAL_GPIO_WritePin(MAX_CS_PORT, MAX_CS_PIN, GPIO_PIN_SET); /* latch */
}

static void max7219_init(void)
{
  max7219_write(0x0F, 0x00); /* display test off */
  max7219_write(0x09, 0x00); /* no Code-B decode: raw rows */
  max7219_write(0x0B, 0x07); /* scan all 8 digits (rows) */
  max7219_write(0x0A, 0x04); /* intensity 4 / 15 */
  for (uint8_t row = 1; row <= 8; row++)
  {
    max7219_write(row, 0x00);
  }
  max7219_write(0x0C, 0x01); /* leave shutdown */
}

static void max7219_show(const uint8_t rows[8])
{
  for (int r = 0; r < 8; r++)
  {
    max7219_write((uint8_t)(r + 1), rows[r]);
  }
}

/* ----------------------------------------------------------- MPU-6050 */

static uint8_t mpu_read_reg(uint8_t reg)
{
  uint8_t v = 0;
  HAL_I2C_Mem_Read(&hi2c1, MPU_ADDR, reg, I2C_MEMADD_SIZE_8BIT, &v, 1, 10);
  return v;
}

static void mpu_write_reg(uint8_t reg, uint8_t v)
{
  HAL_I2C_Mem_Write(&hi2c1, MPU_ADDR, reg, I2C_MEMADD_SIZE_8BIT, &v, 1, 10);
}

typedef struct
{
  int16_t ax, ay, az, temp, gx, gy, gz;
} MpuRaw;

static int mpu_read(MpuRaw *m)
{
  uint8_t b[14];
  if (HAL_I2C_Mem_Read(&hi2c1, MPU_ADDR, 0x3B, I2C_MEMADD_SIZE_8BIT, b, 14, 10) != HAL_OK)
  {
    return -1;
  }
  int16_t *w = &m->ax;
  for (int i = 0; i < 7; i++)
  {
    w[i] = (int16_t)(b[2 * i] << 8 | b[2 * i + 1]);
  }
  return 0;
}

/* Tenths, with the sign kept for -0.x. */
static void tenths(char *out, size_t n, float v)
{
  int t = (int)lroundf(v * 10.0f);
  snprintf(out, n, "%s%d.%d", t < 0 ? "-" : "", (t < 0 ? -t : t) / 10, (t < 0 ? -t : t) % 10);
}

static int clamp7(int v)
{
  return v < 0 ? 0 : v > 7 ? 7 : v;
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_I2C1_Init();
  MX_SPI1_Init();
  MX_USART2_UART_Init();
  printf("MPU-6050 on I2C1 (D15/D14), MAX7219 8x8 matrix on SPI1 (CS D10)\r\n");

  max7219_init();
  uint8_t who = mpu_read_reg(0x75);
  printf("WHO_AM_I 0x%02X%s\r\n", who, who == 0x68 ? "" : " (no MPU-6050?)");
  mpu_write_reg(0x6B, 0x00); /* wake up, internal 8 MHz clock */
  mpu_write_reg(0x19, 0x07); /* 1 kHz / (1 + 7) = 125 Hz sample rate */
  mpu_write_reg(0x1A, 0x00);
  mpu_write_reg(0x1B, 0x00); /* ±250 °/s: 131 LSB per °/s */
  mpu_write_reg(0x1C, 0x00); /* ±2 g: 16384 LSB per g */

  while (1)
  {
    MpuRaw m;
    if (mpu_read(&m) != 0)
    {
      printf("MPU-6050 does not answer\r\n");
      HAL_Delay(500);
      continue;
    }
    float ax = m.ax / 16384.0f, ay = m.ay / 16384.0f, az = m.az / 16384.0f;
    float roll = atan2f(ay, az) * 57.29578f;
    float pitch = atan2f(-ax, sqrtf(ay * ay + az * az)) * 57.29578f;
    float temp = m.temp / 340.0f + 36.53f;

    /* Where a ball would roll: ±45° from level spans the matrix. */
    int col = clamp7((int)lroundf(3.5f + ay / 0.7071f * 4.0f - 0.01f));
    int row = clamp7((int)lroundf(3.5f - ax / 0.7071f * 4.0f - 0.01f));
    uint8_t rows[8] = {0};
    rows[row] = (uint8_t)(0x80 >> col);
    max7219_show(rows);

    char r[12], p[12], t[12], g[3][12];
    tenths(r, sizeof r, roll);
    tenths(p, sizeof p, pitch);
    tenths(t, sizeof t, temp);
    tenths(g[0], sizeof g[0], m.gx / 131.0f);
    tenths(g[1], sizeof g[1], m.gy / 131.0f);
    tenths(g[2], sizeof g[2], m.gz / 131.0f);
    printf("roll %s pitch %s | gyro %s %s %s dps | %s C | dot row %d col %d\r\n", r, p, g[0], g[1], g[2], t, row,
           col);
    HAL_Delay(100);
  }
}

/* ------------------------------------------------------- peripherals */

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef g = {0};
  __HAL_RCC_GPIOB_CLK_ENABLE();
  HAL_GPIO_WritePin(MAX_CS_PORT, MAX_CS_PIN, GPIO_PIN_SET);
  g.Pin = MAX_CS_PIN;
  g.Mode = GPIO_MODE_OUTPUT_PP;
  g.Pull = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_HIGH;
  HAL_GPIO_Init(MAX_CS_PORT, &g);
}

static void MX_I2C1_Init(void)
{
  hi2c1.Instance = I2C1;
  hi2c1.Init.ClockSpeed = 400000;
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

static void MX_SPI1_Init(void)
{
  hspi1.Instance = SPI1;
  hspi1.Init.Mode = SPI_MODE_MASTER;
  hspi1.Init.Direction = SPI_DIRECTION_2LINES;
  hspi1.Init.DataSize = SPI_DATASIZE_8BIT;
  hspi1.Init.CLKPolarity = SPI_POLARITY_LOW;
  hspi1.Init.CLKPhase = SPI_PHASE_1EDGE;
  hspi1.Init.NSS = SPI_NSS_SOFT;
  hspi1.Init.BaudRatePrescaler = SPI_BAUDRATEPRESCALER_16; /* 5.25 MHz (max 10 MHz) */
  hspi1.Init.FirstBit = SPI_FIRSTBIT_MSB;
  hspi1.Init.TIMode = SPI_TIMODE_DISABLE;
  hspi1.Init.CRCCalculation = SPI_CRCCALCULATION_DISABLE;
  hspi1.Init.CRCPolynomial = 10;
  if (HAL_SPI_Init(&hspi1) != HAL_OK)
  {
    Error_Handler();
  }
}

void HAL_SPI_MspInit(SPI_HandleTypeDef *hspi)
{
  GPIO_InitTypeDef g = {0};
  if (hspi->Instance == SPI1)
  {
    __HAL_RCC_SPI1_CLK_ENABLE();
    __HAL_RCC_GPIOA_CLK_ENABLE();
    /* PA5 = SCK, PA7 = MOSI (the MAX7219 has no MISO) */
    g.Pin = GPIO_PIN_5 | GPIO_PIN_7;
    g.Mode = GPIO_MODE_AF_PP;
    g.Pull = GPIO_NOPULL;
    g.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
    g.Alternate = GPIO_AF5_SPI1;
    HAL_GPIO_Init(GPIOA, &g);
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
