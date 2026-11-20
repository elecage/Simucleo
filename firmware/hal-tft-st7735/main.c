/*
 * CubeMX-style HAL example: a 1.8" 128×160 colour TFT with an ST7735S
 * controller on SPI1 — colour bars, text, a counter and a bouncing box.
 *
 *   D13 (PA5)   SPI1 SCK  → SCK
 *   D11 (PA7)   SPI1 MOSI → SDA
 *   D10 (PB6)   GPIO      → CS   (low: selected)
 *   D9  (PC7)   GPIO      → RESET (low: held in reset)
 *   D8  (PA9)   GPIO      → A0 (D/CX: low = command, high = data)
 *   D7  (PA8)   GPIO      → LED (backlight, high = on)
 *   VCC 5V (the module has a 3.3 V regulator), GND
 *   B1  (PC13)  inverts the colours (INVON / INVOFF)
 *
 * The controller takes bytes MSB first on SCK rising edges (SPI mode 0)
 * while CS is low; A0 says whether a byte is a command or its parameters.
 * After a hardware reset it sleeps with the display off: SLPOUT (0x11),
 * then the pixel format (COLMOD 0x3A = 0x05: 16-bit RGB565), the memory
 * access order (MADCTL 0x36: MY | MX is the module's upright portrait) and
 * DISPON (0x29). Drawing is always the same three steps: CASET (0x2A) and
 * RASET (0x2B) set a window, RAMWR (0x2C) streams its pixels left to
 * right, top to bottom — 2 bytes each, big-endian.
 */
#include <stdio.h>
#include "main.h"

#define TFT_W 128
#define TFT_H 160

#define CS_PORT GPIOB
#define CS_PIN GPIO_PIN_6
#define RST_PORT GPIOC
#define RST_PIN GPIO_PIN_7
#define DC_PORT GPIOA
#define DC_PIN GPIO_PIN_9
#define LED_PORT GPIOA
#define LED_PIN GPIO_PIN_8

/* RGB565 */
#define BLACK 0x0000
#define NAVY 0x000F
#define BLUE 0x001F
#define RED 0xF800
#define GREEN 0x07E0
#define YELLOW 0xFFE0
#define CYAN 0x07FF
#define MAGENTA 0xF81F
#define WHITE 0xFFFF
#define GRAY 0x8410
#define ORANGE 0xFD20

UART_HandleTypeDef huart2;
SPI_HandleTypeDef hspi1;

extern const uint8_t font5x7[95][5];

static void MX_GPIO_Init(void);
static void MX_SPI1_Init(void);
static void MX_USART2_UART_Init(void);

/* ------------------------------------------------------------ ST7735S */

static void tft_send(int data, const uint8_t *b, uint16_t n)
{
  HAL_GPIO_WritePin(DC_PORT, DC_PIN, data ? GPIO_PIN_SET : GPIO_PIN_RESET);
  HAL_GPIO_WritePin(CS_PORT, CS_PIN, GPIO_PIN_RESET);
  HAL_SPI_Transmit(&hspi1, (uint8_t *)b, n, 100);
  HAL_GPIO_WritePin(CS_PORT, CS_PIN, GPIO_PIN_SET);
}

static void tft_cmd(uint8_t c)
{
  tft_send(0, &c, 1);
}

static void tft_cmd_args(uint8_t c, const uint8_t *args, uint16_t n)
{
  tft_cmd(c);
  if (n)
  {
    tft_send(1, args, n);
  }
}

static void tft_init(void)
{
  /* Hardware reset: RESET low for 10 ms, then 120 ms for the chip. */
  HAL_GPIO_WritePin(RST_PORT, RST_PIN, GPIO_PIN_RESET);
  HAL_Delay(10);
  HAL_GPIO_WritePin(RST_PORT, RST_PIN, GPIO_PIN_SET);
  HAL_Delay(120);
  tft_cmd(0x01); /* SWRESET */
  HAL_Delay(150);
  tft_cmd(0x11); /* SLPOUT: the booster and oscillator start */
  HAL_Delay(120);
  /* Frame rate, inversion control, power and VCOM: the panel's analog
   * settings (Adafruit's "black tab" values). */
  tft_cmd_args(0xB1, (const uint8_t[]){0x01, 0x2C, 0x2D}, 3);
  tft_cmd_args(0xB4, (const uint8_t[]){0x07}, 1);
  tft_cmd_args(0xC0, (const uint8_t[]){0xA2, 0x02, 0x84}, 3);
  tft_cmd_args(0xC1, (const uint8_t[]){0xC5}, 1);
  tft_cmd_args(0xC5, (const uint8_t[]){0x0E}, 1);
  tft_cmd(0x20);                                   /* INVOFF */
  tft_cmd_args(0x36, (const uint8_t[]){0xC0}, 1);  /* MADCTL: MY | MX, RGB */
  tft_cmd_args(0x3A, (const uint8_t[]){0x05}, 1);  /* COLMOD: 16-bit */
  tft_cmd(0x13);                                   /* NORON */
  HAL_Delay(10);
  tft_cmd(0x29); /* DISPON */
  HAL_Delay(10);
}

static void tft_window(uint8_t x0, uint8_t y0, uint8_t x1, uint8_t y1)
{
  tft_cmd_args(0x2A, (const uint8_t[]){0, x0, 0, x1}, 4); /* CASET */
  tft_cmd_args(0x2B, (const uint8_t[]){0, y0, 0, y1}, 4); /* RASET */
  tft_cmd(0x2C);                                          /* RAMWR */
}

static uint8_t line[2 * TFT_W];

static void tft_fill_rect(int x, int y, int w, int h, uint16_t color)
{
  if (w <= 0 || h <= 0)
  {
    return;
  }
  tft_window((uint8_t)x, (uint8_t)y, (uint8_t)(x + w - 1), (uint8_t)(y + h - 1));
  for (int i = 0; i < w; i++)
  {
    line[2 * i] = (uint8_t)(color >> 8);
    line[2 * i + 1] = (uint8_t)color;
  }
  for (int r = 0; r < h; r++)
  {
    tft_send(1, line, (uint16_t)(2 * w));
  }
}

/* One character of the 5×7 font in a (6·scale)×(8·scale) cell. */
static void tft_char(int x, int y, char ch, uint16_t fg, uint16_t bg, int scale)
{
  static uint8_t cell[2 * 12 * 16];
  if (ch < 0x20 || ch > 0x7E)
  {
    ch = '?';
  }
  const uint8_t *glyph = font5x7[ch - 0x20];
  int w = 6 * scale, h = 8 * scale, n = 0;
  for (int py = 0; py < h; py++)
  {
    for (int px = 0; px < w; px++)
    {
      int col = px / scale, row = py / scale;
      int on = col < 5 && (glyph[col] >> row & 1);
      uint16_t c = on ? fg : bg;
      cell[n++] = (uint8_t)(c >> 8);
      cell[n++] = (uint8_t)c;
    }
  }
  tft_window((uint8_t)x, (uint8_t)y, (uint8_t)(x + w - 1), (uint8_t)(y + h - 1));
  tft_send(1, cell, (uint16_t)n);
}

static void tft_text(int x, int y, const char *s, uint16_t fg, uint16_t bg, int scale)
{
  for (; *s; s++, x += 6 * scale)
  {
    tft_char(x, y, *s, fg, bg, scale);
  }
}

/* ----------------------------------------------------------------- app */

#define BOX 14
#define BOX_TOP 84

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_SPI1_Init();
  MX_USART2_UART_Init();
  printf("ST7735S 128x160 TFT on SPI1 (CS D10, RESET D9, A0 D8, LED D7)\r\n");

  HAL_GPIO_WritePin(LED_PORT, LED_PIN, GPIO_PIN_SET); /* backlight on */
  tft_init();
  tft_fill_rect(0, 0, TFT_W, TFT_H, BLACK);
  tft_fill_rect(0, 0, TFT_W, 14, NAVY);
  tft_text(4, 3, "Simucleo TFT", WHITE, NAVY, 1);
  static const uint16_t bars[8] = {RED, GREEN, BLUE, YELLOW, CYAN, MAGENTA, WHITE, GRAY};
  for (int i = 0; i < 8; i++)
  {
    tft_fill_rect(16 * i, 18, 16, 30, bars[i]);
  }
  tft_fill_rect(0, BOX_TOP - 2, TFT_W, 1, GRAY);
  printf("init done, drawing\r\n");

  int bx = 10, by = BOX_TOP + 6, dx = 3, dy = 2;
  uint32_t count = 0, next_count = 0;
  int inverted = 0;
  GPIO_PinState b1_last = GPIO_PIN_SET;
  while (1)
  {
    uint32_t now = HAL_GetTick();
    if ((int32_t)(now - next_count) >= 0)
    {
      next_count = now + 500;
      char buf[16];
      snprintf(buf, sizeof buf, "%5lu", (unsigned long)count);
      tft_text(4, 54, "count", YELLOW, BLACK, 1);
      tft_text(40, 52, buf, WHITE, BLACK, 2);
      printf("count %lu box %d,%d\r\n", (unsigned long)count, bx, by);
      count++;
    }

    /* The box: erase where it was, draw where it is now. */
    tft_fill_rect(bx, by, BOX, BOX, BLACK);
    bx += dx;
    by += dy;
    if (bx < 0 || bx + BOX > TFT_W)
    {
      dx = -dx;
      bx += 2 * dx;
    }
    if (by < BOX_TOP || by + BOX > TFT_H)
    {
      dy = -dy;
      by += 2 * dy;
    }
    tft_fill_rect(bx, by, BOX, BOX, ORANGE);

    GPIO_PinState b1 = HAL_GPIO_ReadPin(B1_GPIO_Port, B1_Pin);
    if (b1 == GPIO_PIN_RESET && b1_last == GPIO_PIN_SET)
    {
      inverted = !inverted;
      tft_cmd(inverted ? 0x21 : 0x20); /* INVON / INVOFF */
      printf("B1: colours %s\r\n", inverted ? "inverted" : "normal");
    }
    b1_last = b1;
    HAL_Delay(30);
  }
}

/* ------------------------------------------------------- peripherals */

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef g = {0};
  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOC_CLK_ENABLE();
  HAL_GPIO_WritePin(CS_PORT, CS_PIN, GPIO_PIN_SET);
  HAL_GPIO_WritePin(RST_PORT, RST_PIN, GPIO_PIN_SET);
  HAL_GPIO_WritePin(DC_PORT, DC_PIN | LED_PIN, GPIO_PIN_RESET);
  g.Mode = GPIO_MODE_OUTPUT_PP;
  g.Pull = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_HIGH;
  g.Pin = CS_PIN;
  HAL_GPIO_Init(CS_PORT, &g);
  g.Pin = RST_PIN;
  HAL_GPIO_Init(RST_PORT, &g);
  g.Pin = DC_PIN | LED_PIN;
  HAL_GPIO_Init(DC_PORT, &g);
  g.Pin = B1_Pin;
  g.Mode = GPIO_MODE_INPUT;
  HAL_GPIO_Init(B1_GPIO_Port, &g);
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
  hspi1.Init.BaudRatePrescaler = SPI_BAUDRATEPRESCALER_8; /* 10.5 MHz (max 15 MHz) */
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
    /* PA5 = SCK, PA7 = MOSI (the module has no MISO) */
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
