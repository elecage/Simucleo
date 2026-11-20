/*
 * CubeMX-style HAL example: two MCP2515 + TJA1050 CAN modules on one CAN
 * bus, both driven by this board over SPI1 (the STM32F401 has no CAN
 * controller of its own, which is why these modules are used).
 *
 *   D13 (PA5), D12 (PA6), D11 (PA7)   SPI1 SCK, MISO (SO), MOSI (SI) → both
 *   D10 (PB6)                          GPIO → CS of node A
 *   D9  (PC7)                          GPIO → CS of node B
 *   D2  (PA10)                         INT of node A (input, low = interrupt)
 *   D8  (PA9)                          INT of node B
 *   5V, GND                            VCC (the TJA1050 needs 5 V), GND
 *   CANH ↔ CANH, CANL ↔ CANL           the bus, 120 Ω jumper J1 on both
 *
 * Both chips: RESET, 125 kbit/s from the 8 MHz crystal (CNF1 0x01, CNF2
 * 0xB1, CNF3 0x85: TQ = 2·2/8 MHz = 0.5 µs, 1 + 2 + 7 + 6 = 16 TQ = 8 µs),
 * receive buffers taking any message (RXM = 11, rollover on), RX0/RX1
 * interrupts on INT, then normal mode. Node A sends ID 0x123 with a
 * counter every 100 ms, node B the extended ID 0x18FF1234 every 500 ms.
 * Whatever a node's INT says it received is read with READ RX BUFFER and
 * printed on USART2:
 *
 *   B <- 0x123 [2] 00 05
 *
 * B1 switches node B between 125 and 250 kbit/s: with the bit rates
 * different no frame is acknowledged, the transmitters' TEC climbs (error
 * passive at 128, bus-off above 255) and the errors are printed.
 */
#include <stdio.h>
#include "main.h"

UART_HandleTypeDef huart2;
SPI_HandleTypeDef hspi1;

/* MCP2515 instructions and registers (DS20001801). */
#define MCP_RESET 0xC0
#define MCP_READ 0x03
#define MCP_WRITE 0x02
#define MCP_READ_RX 0x90
#define MCP_LOAD_TX 0x40
#define MCP_RTS 0x80
#define MCP_READ_STATUS 0xA0
#define MCP_RX_STATUS 0xB0
#define MCP_BIT_MODIFY 0x05

#define CANSTAT 0x0E
#define CANCTRL 0x0F
#define TEC 0x1C
#define REC 0x1D
#define CNF3 0x28
#define CANINTE 0x2B
#define CANINTF 0x2C
#define EFLG 0x2D
#define TXB0CTRL 0x30
#define RXB0CTRL 0x60
#define RXB1CTRL 0x70

#define MODE_NORMAL 0x00
#define MODE_CONFIG 0x80

typedef struct
{
  char name;
  GPIO_TypeDef *cs_port;
  uint16_t cs_pin;
  GPIO_TypeDef *int_port;
  uint16_t int_pin;
  uint8_t tec, eflg;
} Node;

static Node node_a = {'A', GPIOB, GPIO_PIN_6, GPIOA, GPIO_PIN_10, 0, 0};
static Node node_b = {'B', GPIOC, GPIO_PIN_7, GPIOA, GPIO_PIN_9, 0, 0};

static void MX_GPIO_Init(void);
static void MX_SPI1_Init(void);
static void MX_USART2_UART_Init(void);

/* ------------------------------------------------------------ MCP2515 */

/* One instruction: CS low, the bytes out (and in), CS high. */
static void mcp_xfer(Node *n, const uint8_t *tx, uint8_t *rx, uint16_t len)
{
  uint8_t dummy[16];
  HAL_GPIO_WritePin(n->cs_port, n->cs_pin, GPIO_PIN_RESET);
  HAL_SPI_TransmitReceive(&hspi1, (uint8_t *)tx, rx ? rx : dummy, len, 10);
  HAL_GPIO_WritePin(n->cs_port, n->cs_pin, GPIO_PIN_SET);
}

static uint8_t mcp_read(Node *n, uint8_t reg)
{
  uint8_t tx[3] = {MCP_READ, reg, 0}, rx[3];
  mcp_xfer(n, tx, rx, 3);
  return rx[2];
}

static void mcp_write(Node *n, uint8_t reg, uint8_t v)
{
  uint8_t tx[3] = {MCP_WRITE, reg, v};
  mcp_xfer(n, tx, NULL, 3);
}

static void mcp_modify(Node *n, uint8_t reg, uint8_t mask, uint8_t v)
{
  uint8_t tx[4] = {MCP_BIT_MODIFY, reg, mask, v};
  mcp_xfer(n, tx, NULL, 4);
}

static uint8_t mcp_cmd_read(Node *n, uint8_t cmd)
{
  uint8_t tx[2] = {cmd, 0}, rx[2];
  mcp_xfer(n, tx, rx, 2);
  return rx[1];
}

/* Request a mode and wait for CANSTAT to show it. */
static int mcp_mode(Node *n, uint8_t mode)
{
  mcp_modify(n, CANCTRL, 0xE0, mode);
  for (int i = 0; i < 10; i++)
  {
    if ((mcp_read(n, CANSTAT) & 0xE0) == mode)
    {
      return 0;
    }
    HAL_Delay(1);
  }
  return -1;
}

/* Bit timing from the 8 MHz crystal, in configuration mode. */
static void mcp_bitrate(Node *n, int kbps)
{
  /* CNF3, CNF2, CNF1 in one sequential write. */
  uint8_t cnf1 = kbps == 250 ? 0x00 : 0x01;
  uint8_t tx[5] = {MCP_WRITE, CNF3, 0x85, 0xB1, cnf1};
  mcp_xfer(n, tx, NULL, 5);
}

static int mcp_init(Node *n, int kbps)
{
  uint8_t r = MCP_RESET;
  mcp_xfer(n, &r, NULL, 1);
  HAL_Delay(2);
  if ((mcp_read(n, CANSTAT) & 0xE0) != MODE_CONFIG)
  {
    return -1; /* no chip answering */
  }
  mcp_bitrate(n, kbps);
  mcp_write(n, RXB0CTRL, 0x64); /* any message, rollover into RXB1 */
  mcp_write(n, RXB1CTRL, 0x60);
  mcp_write(n, CANINTE, 0x03); /* RX0IE, RX1IE */
  return mcp_mode(n, MODE_NORMAL);
}

/* Load TX buffer 0 and request it. Standard IDs have 11 bits; `ext`
 * IDs 29. Returns -1 while the last message is still pending. */
static int mcp_send(Node *n, uint32_t id, int ext, const uint8_t *data, uint8_t len)
{
  if (mcp_cmd_read(n, MCP_READ_STATUS) & 0x04)
  {
    return -1; /* TXB0CTRL.TXREQ: not sent yet (no ACK?) */
  }
  uint8_t tx[14] = {MCP_LOAD_TX | 0x00};
  if (ext)
  {
    tx[1] = (uint8_t)(id >> 21);
    tx[2] = (uint8_t)(((id >> 13) & 0xE0) | 0x08 | ((id >> 16) & 0x03));
    tx[3] = (uint8_t)(id >> 8);
    tx[4] = (uint8_t)id;
  }
  else
  {
    tx[1] = (uint8_t)(id >> 3);
    tx[2] = (uint8_t)((id & 7) << 5);
  }
  tx[5] = len;
  for (int i = 0; i < len; i++)
  {
    tx[6 + i] = data[i];
  }
  mcp_xfer(n, tx, NULL, (uint16_t)(6 + len));
  uint8_t rts = MCP_RTS | 0x01;
  mcp_xfer(n, &rts, NULL, 1);
  return 0;
}

/* Read out what INT says came in and print it. */
static void mcp_service(Node *n)
{
  for (int guard = 0; guard < 4; guard++)
  {
    uint8_t st = mcp_cmd_read(n, MCP_RX_STATUS);
    if ((st & 0xC0) == 0)
    {
      break;
    }
    /* READ RX BUFFER (RXB0 or RXB1 from SIDH): clears its RXnIF. */
    uint8_t tx[14] = {(uint8_t)(MCP_READ_RX | ((st & 0x40) ? 0x00 : 0x04))}, rx[14];
    mcp_xfer(n, tx, rx, 14);
    uint32_t id = (uint32_t)rx[1] << 3 | rx[2] >> 5;
    int ext = (rx[2] & 0x08) != 0;
    if (ext)
    {
      id = id << 18 | (uint32_t)(rx[2] & 3) << 16 | (uint32_t)rx[3] << 8 | rx[4];
    }
    int rtr = ext ? (rx[5] & 0x40) != 0 : (rx[2] & 0x10) != 0;
    uint8_t len = rx[5] & 0x0F;
    if (len > 8)
    {
      len = 8;
    }
    printf("%c <- 0x%0*lX [%u]", n->name, ext ? 8 : 3, (unsigned long)id, len);
    if (rtr)
    {
      printf(" RTR");
    }
    else
    {
      for (int i = 0; i < len; i++)
      {
        printf(" %02X", rx[6 + i]);
      }
    }
    printf("\r\n");
  }
}

/* Print a node's error state when it changes. */
static void mcp_errors(Node *n)
{
  uint8_t tec = mcp_read(n, TEC), eflg = mcp_read(n, EFLG);
  if (tec == n->tec && eflg == n->eflg)
  {
    return;
  }
  n->tec = tec;
  n->eflg = eflg;
  uint8_t txb0 = mcp_read(n, TXB0CTRL);
  printf("%c: TEC %u REC %u EFLG 0x%02X%s%s%s\r\n", n->name, tec, mcp_read(n, REC), eflg,
         (txb0 & 0x10) ? " TXERR (no ACK)" : "", (eflg & 0x10) ? " error-passive" : "",
         (eflg & 0x20) ? " BUS-OFF" : "");
  mcp_modify(n, CANINTF, 0xA0, 0x00); /* MERRF, ERRIF */
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_SPI1_Init();
  MX_USART2_UART_Init();
  printf("Two MCP2515 CAN nodes on SPI1 (CS D10, D9; INT D2, D8), 125 kbit/s\r\n");
  int ok_a = mcp_init(&node_a, 125), ok_b = mcp_init(&node_b, 125);
  printf("node A %s, node B %s\r\n", ok_a == 0 ? "normal mode" : "not found", ok_b == 0 ? "normal mode" : "not found");

  uint16_t count_a = 0, count_b = 0;
  int kbps_b = 125;
  GPIO_PinState b1_last = GPIO_PIN_SET;
  uint32_t next_a = HAL_GetTick(), next_b = next_a + 50;
  while (1)
  {
    uint32_t now = HAL_GetTick();
    if ((int32_t)(now - next_a) >= 0)
    {
      next_a += 100;
      uint8_t d[2] = {(uint8_t)(count_a >> 8), (uint8_t)count_a};
      if (mcp_send(&node_a, 0x123, 0, d, 2) == 0)
      {
        count_a++;
      }
      mcp_errors(&node_a);
    }
    if ((int32_t)(now - next_b) >= 0)
    {
      next_b += 500;
      uint8_t d[4] = {0xB0, 0x0B, (uint8_t)(count_b >> 8), (uint8_t)count_b};
      if (mcp_send(&node_b, 0x18FF1234, 1, d, 4) == 0)
      {
        count_b++;
      }
      mcp_errors(&node_b);
    }
    if (HAL_GPIO_ReadPin(node_a.int_port, node_a.int_pin) == GPIO_PIN_RESET)
    {
      mcp_service(&node_a);
    }
    if (HAL_GPIO_ReadPin(node_b.int_port, node_b.int_pin) == GPIO_PIN_RESET)
    {
      mcp_service(&node_b);
    }
    GPIO_PinState b1 = HAL_GPIO_ReadPin(B1_GPIO_Port, B1_Pin);
    if (b1 == GPIO_PIN_RESET && b1_last == GPIO_PIN_SET)
    {
      kbps_b = kbps_b == 125 ? 250 : 125;
      mcp_mode(&node_b, MODE_CONFIG);
      mcp_bitrate(&node_b, kbps_b);
      mcp_mode(&node_b, MODE_NORMAL);
      printf("B1: node B now at %d kbit/s\r\n", kbps_b);
    }
    b1_last = b1;
    /* Sleep until the next interrupt (SysTick, every millisecond): the INT
     * pins and the button are looked at once a millisecond instead of in
     * a loop that keeps the CPU busy all the time. */
    __WFI();
  }
}

/* ------------------------------------------------------- peripherals */

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef g = {0};
  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOC_CLK_ENABLE();
  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_6, GPIO_PIN_SET);
  HAL_GPIO_WritePin(GPIOC, GPIO_PIN_7, GPIO_PIN_SET);
  g.Mode = GPIO_MODE_OUTPUT_PP;
  g.Pull = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_HIGH;
  g.Pin = GPIO_PIN_6;
  HAL_GPIO_Init(GPIOB, &g);
  g.Pin = GPIO_PIN_7;
  HAL_GPIO_Init(GPIOC, &g);
  /* INT pins: inputs with pull-ups (INT is push-pull, low when pending). */
  g.Mode = GPIO_MODE_INPUT;
  g.Pull = GPIO_PULLUP;
  g.Pin = GPIO_PIN_9 | GPIO_PIN_10;
  HAL_GPIO_Init(GPIOA, &g);
  g.Pull = GPIO_NOPULL;
  g.Pin = B1_Pin;
  HAL_GPIO_Init(B1_GPIO_Port, &g);
}

static void MX_SPI1_Init(void)
{
  hspi1.Instance = SPI1;
  hspi1.Init.Mode = SPI_MODE_MASTER;
  hspi1.Init.Direction = SPI_DIRECTION_2LINES;
  hspi1.Init.DataSize = SPI_DATASIZE_8BIT;
  hspi1.Init.CLKPolarity = SPI_POLARITY_LOW; /* mode 0,0 (the MCP2515 also takes 1,1) */
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
    /* PA5 = SCK, PA6 = MISO, PA7 = MOSI */
    g.Pin = GPIO_PIN_5 | GPIO_PIN_6 | GPIO_PIN_7;
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
