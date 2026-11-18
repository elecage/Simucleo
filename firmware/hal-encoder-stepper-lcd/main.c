/*
 * CubeMX-style HAL example: a rotary encoder sets where a stepper motor
 * turns; a 16×2 character LCD shows it with a thermistor's temperature.
 *
 *   D12 (PA6, TIM3_CH1), D11 (PA7, TIM3_CH2)  encoder CLK, DT
 *   D10 (PB6)                                  encoder push button (SW)
 *   D2, D3, D4, D5 (PA10, PB3, PB5, PB4)       ULN2003 IN1–IN4 (28BYJ-48)
 *   D15 (PB8), D14 (PB9)                       I2C1 → PCF8574 LCD backpack 0x27
 *   A0 (PA0)                                   3V3 — 10 kΩ — A0 — NTC 10 kΩ — GND
 *
 * TIM3 in encoder mode 3 counts every edge of both channels: 4 counts per
 * detent, up when turning clockwise. One detent asks for 1/20 of a turn
 * (4096 half steps per turn of the output shaft); the stepper follows in
 * half steps every 2 ms. The button sets the current position as zero.
 */
#include <math.h>
#include <stdio.h>
#include "main.h"

#define LCD_ADDR (0x27 << 1)
#define HALF_STEPS_PER_TURN 4096

UART_HandleTypeDef huart2;
TIM_HandleTypeDef htim3;
I2C_HandleTypeDef hi2c1;
ADC_HandleTypeDef hadc1;

static void MX_GPIO_Init(void);
static void MX_TIM3_Init(void);
static void MX_I2C1_Init(void);
static void MX_ADC1_Init(void);
static void MX_USART2_UART_Init(void);

/* ------------------------------------------------ LCD via PCF8574 */

#define LCD_RS 0x01
#define LCD_EN 0x04
#define LCD_BL 0x08

static void lcd_nibble(uint8_t nibble, uint8_t rs)
{
  uint8_t v[2] = {(uint8_t)(nibble << 4 | LCD_BL | rs | LCD_EN), (uint8_t)(nibble << 4 | LCD_BL | rs)};
  HAL_I2C_Master_Transmit(&hi2c1, LCD_ADDR, v, 2, 10);
}

static void lcd_byte(uint8_t b, uint8_t rs)
{
  lcd_nibble(b >> 4, rs);
  lcd_nibble(b & 0x0F, rs);
}

static void lcd_init(void)
{
  HAL_Delay(50);
  lcd_nibble(0x3, 0);
  HAL_Delay(5);
  lcd_nibble(0x3, 0);
  HAL_Delay(1);
  lcd_nibble(0x3, 0);
  lcd_nibble(0x2, 0); /* 4-bit mode */
  lcd_byte(0x28, 0);  /* 2 lines, 5×8 */
  lcd_byte(0x0C, 0);  /* display on, no cursor */
  lcd_byte(0x06, 0);  /* increment */
  lcd_byte(0x01, 0);  /* clear */
  HAL_Delay(2);
  /* Custom character 0: a degree sign. */
  static const uint8_t degree[8] = {0x06, 0x09, 0x09, 0x06, 0, 0, 0, 0};
  lcd_byte(0x40, 0);
  for (int i = 0; i < 8; i++)
  {
    lcd_byte(degree[i], LCD_RS);
  }
}

static void lcd_print(int row, const char *s)
{
  lcd_byte(0x80 | (row ? 0x40 : 0x00), 0);
  for (int i = 0; i < 16; i++)
  {
    lcd_byte(*s ? (uint8_t)*s++ : ' ', LCD_RS);
  }
}

/* ------------------------------------------------------- stepper */

static const uint8_t HALF[8] = {0x1, 0x3, 0x2, 0x6, 0x4, 0xC, 0x8, 0x9};
static GPIO_TypeDef *const COIL_PORT[4] = {GPIOA, GPIOB, GPIOB, GPIOB};
static const uint16_t COIL_PIN[4] = {GPIO_PIN_10, GPIO_PIN_3, GPIO_PIN_5, GPIO_PIN_4};

static void coils(uint8_t pattern)
{
  for (int i = 0; i < 4; i++)
  {
    HAL_GPIO_WritePin(COIL_PORT[i], COIL_PIN[i], (pattern >> i) & 1 ? GPIO_PIN_SET : GPIO_PIN_RESET);
  }
}

/* --------------------------------------------------- thermistor */

static float read_temp(void)
{
  HAL_ADC_Start(&hadc1);
  HAL_ADC_PollForConversion(&hadc1, 10);
  uint32_t code = HAL_ADC_GetValue(&hadc1);
  HAL_ADC_Stop(&hadc1);
  if (code == 0 || code >= 4095)
  {
    return NAN;
  }
  /* Divider: R_ntc = 10k · code / (4095 − code); B = 3950. */
  float r = 10000.0f * code / (4095.0f - code);
  return 1.0f / (logf(r / 10000.0f) / 3950.0f + 1.0f / 298.15f) - 273.15f;
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_USART2_UART_Init();
  MX_TIM3_Init();
  MX_I2C1_Init();
  MX_ADC1_Init();
  HAL_TIM_Encoder_Start(&htim3, TIM_CHANNEL_ALL);
  lcd_init();
  printf("Encoder (TIM3) -> stepper, LCD 0x27, NTC on A0\r\n");

  int32_t position = 0, zero = 0, phase = 0;
  uint32_t last_lcd = 0;
  int16_t last_count = 0;
  while (1)
  {
    if (HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_6) == GPIO_PIN_RESET)
    {
      zero = (int16_t)__HAL_TIM_GET_COUNTER(&htim3);
      position = 0;
      printf("zero set\r\n");
      while (HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_6) == GPIO_PIN_RESET)
      {
        HAL_Delay(10);
      }
    }
    int16_t count = (int16_t)__HAL_TIM_GET_COUNTER(&htim3);
    int32_t detents = (count - zero) / 4;
    int32_t target = detents * HALF_STEPS_PER_TURN / 20;
    if (count != last_count)
    {
      printf("detents %ld target %ld\r\n", (long)detents, (long)target);
      last_count = count;
    }
    if (position != target)
    {
      int dir = target > position ? 1 : -1;
      position += dir;
      phase = (phase + dir) & 7;
      coils(HALF[phase]);
    }
    else
    {
      coils(0); /* hold off: save power */
    }
    if (HAL_GetTick() - last_lcd >= 250)
    {
      last_lcd = HAL_GetTick();
      char line[20];
      int deg10 = (int)(position * 3600L / HALF_STEPS_PER_TURN);
      snprintf(line, sizeof line, "Pos %4d.%d%c", deg10 / 10, (deg10 < 0 ? -deg10 : deg10) % 10, 0xDF);
      lcd_print(0, line);
      float t = read_temp();
      int t10 = isnan(t) ? 0 : (int)lroundf(t * 10);
      snprintf(line, sizeof line, "NTC %d.%d", t10 / 10, (t10 < 0 ? -t10 : t10) % 10);
      lcd_print(1, line);
      lcd_byte(0x80 | 0x40 | 9, 0);
      lcd_byte(0x00, LCD_RS); /* degree sign */
      lcd_byte('C', LCD_RS);
    }
    HAL_Delay(2);
  }
}

static void MX_TIM3_Init(void)
{
  TIM_Encoder_InitTypeDef sConfig = {0};
  htim3.Instance = TIM3;
  htim3.Init.Prescaler = 0;
  htim3.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim3.Init.Period = 0xFFFF;
  htim3.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim3.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_DISABLE;
  sConfig.EncoderMode = TIM_ENCODERMODE_TI12;
  sConfig.IC1Polarity = TIM_ICPOLARITY_RISING;
  sConfig.IC1Selection = TIM_ICSELECTION_DIRECTTI;
  sConfig.IC1Prescaler = TIM_ICPSC_DIV1;
  sConfig.IC1Filter = 0;
  sConfig.IC2Polarity = TIM_ICPOLARITY_RISING;
  sConfig.IC2Selection = TIM_ICSELECTION_DIRECTTI;
  sConfig.IC2Prescaler = TIM_ICPSC_DIV1;
  sConfig.IC2Filter = 0;
  if (HAL_TIM_Encoder_Init(&htim3, &sConfig) != HAL_OK)
  {
    Error_Handler();
  }
}

void HAL_TIM_Encoder_MspInit(TIM_HandleTypeDef *htim)
{
  GPIO_InitTypeDef g = {0};
  if (htim->Instance == TIM3)
  {
    __HAL_RCC_TIM3_CLK_ENABLE();
    __HAL_RCC_GPIOA_CLK_ENABLE();
    g.Pin = GPIO_PIN_6 | GPIO_PIN_7; /* the module has pull-ups */
    g.Mode = GPIO_MODE_AF_PP;
    g.Pull = GPIO_NOPULL;
    g.Speed = GPIO_SPEED_FREQ_LOW;
    g.Alternate = GPIO_AF2_TIM3;
    HAL_GPIO_Init(GPIOA, &g);
  }
}

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

static void MX_ADC1_Init(void)
{
  ADC_ChannelConfTypeDef c = {0};
  hadc1.Instance = ADC1;
  hadc1.Init.ClockPrescaler = ADC_CLOCK_SYNC_PCLK_DIV4;
  hadc1.Init.Resolution = ADC_RESOLUTION_12B;
  hadc1.Init.ScanConvMode = DISABLE;
  hadc1.Init.ContinuousConvMode = DISABLE;
  hadc1.Init.ExternalTrigConvEdge = ADC_EXTERNALTRIGCONVEDGE_NONE;
  hadc1.Init.ExternalTrigConv = ADC_SOFTWARE_START;
  hadc1.Init.DataAlign = ADC_DATAALIGN_RIGHT;
  hadc1.Init.NbrOfConversion = 1;
  hadc1.Init.EOCSelection = ADC_EOC_SINGLE_CONV;
  if (HAL_ADC_Init(&hadc1) != HAL_OK)
  {
    Error_Handler();
  }
  c.Channel = ADC_CHANNEL_0;
  c.Rank = 1;
  c.SamplingTime = ADC_SAMPLETIME_84CYCLES;
  HAL_ADC_ConfigChannel(&hadc1, &c);
}

void HAL_ADC_MspInit(ADC_HandleTypeDef *hadc)
{
  GPIO_InitTypeDef g = {0};
  if (hadc->Instance == ADC1)
  {
    __HAL_RCC_ADC1_CLK_ENABLE();
    __HAL_RCC_GPIOA_CLK_ENABLE();
    g.Pin = GPIO_PIN_0;
    g.Mode = GPIO_MODE_ANALOG;
    HAL_GPIO_Init(GPIOA, &g);
  }
}

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef g = {0};
  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();
  coils(0);
  g.Mode = GPIO_MODE_OUTPUT_PP;
  g.Pull = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_LOW;
  g.Pin = GPIO_PIN_10;
  HAL_GPIO_Init(GPIOA, &g);
  g.Pin = GPIO_PIN_3 | GPIO_PIN_4 | GPIO_PIN_5;
  HAL_GPIO_Init(GPIOB, &g);
  g.Mode = GPIO_MODE_INPUT;
  g.Pin = GPIO_PIN_6; /* encoder button, pull-up on the module */
  HAL_GPIO_Init(GPIOB, &g);
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
