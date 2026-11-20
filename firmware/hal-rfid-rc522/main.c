/*
 * CubeMX-style HAL example: an RC522 (MFRC522) RFID reader on SPI1 — a
 * door lock that knows one key fob.
 *
 *   RC522 module      Nucleo
 *   SDA (NSS)         D10 (PB6, GPIO)
 *   SCK / MOSI / MISO D13 / D11 / D12 (SPI1, mode 0, 5.25 MHz)
 *   RST (NRSTPD)      D9 (PC7, GPIO high)
 *   3.3V / GND        3V3 / GND  (not 5 V!)
 *   IRQ               not used (polled)
 *   green LED D7 (PA8): access granted, red LED D6 (PB10): denied
 *
 * Start-up prints VersionReg (0x92 = v2.0). Then every 50 ms a REQA asks
 * for a card; when one answers, anticollision + SELECT (both cascade
 * levels for a 7-byte UID) give its UID and SAK, printed over USART2.
 * MIFARE Classic: authenticate sector 1 with key A FF FF FF FF FF FF,
 * read block 4 (16 bytes + CRC); for the allowed fob also count the visits
 * in block 5 (read, add one, WRITE in two steps with 4-bit ACKs).
 * Ultralight: read pages 4–7. Then HALT and StopCrypto1, and WUPA every
 * 100 ms tells whether the card is still on the antenna.
 */
#include <stdio.h>
#include <string.h>
#include "main.h"
#include "mfrc522.h"

UART_HandleTypeDef huart2;
SPI_HandleTypeDef hspi1;

static void MX_GPIO_Init(void);
static void MX_SPI1_Init(void);
static void MX_USART2_UART_Init(void);

static const uint8_t ALLOWED[4] = {0xC1, 0x9A, 0x6E, 0x22};
static const uint8_t KEY_A[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

static void leds(int green, int red)
{
  HAL_GPIO_WritePin(GPIOA, GPIO_PIN_8, green ? GPIO_PIN_SET : GPIO_PIN_RESET);
  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_10, red ? GPIO_PIN_SET : GPIO_PIN_RESET);
}

static void print_text(const uint8_t *d, int n)
{
  putchar('\'');
  for (int i = 0; i < n; i++)
  {
    putchar(d[i] >= 0x20 && d[i] < 0x7F ? d[i] : '.');
  }
  putchar('\'');
}

static void classic(const Uid *uid, int allowed)
{
  uint8_t buf[18];
  StatusCode s = PCD_Authenticate(PICC_AUTH_KEYA, 4, KEY_A, uid);
  if (s != STATUS_OK)
  {
    printf("  auth sector 1: %s\r\n", GetStatusCodeName(s));
    return;
  }
  s = MIFARE_Read(4, buf);
  if (s != STATUS_OK)
  {
    printf("  read block 4: %s\r\n", GetStatusCodeName(s));
    return;
  }
  printf("  block 4: ");
  print_text(buf, 16);
  printf("\r\n");
  if (!allowed)
  {
    return;
  }
  s = MIFARE_Read(5, buf);
  if (s != STATUS_OK)
  {
    printf("  read block 5: %s\r\n", GetStatusCodeName(s));
    return;
  }
  uint32_t visits = (uint32_t)buf[0] | (uint32_t)buf[1] << 8 | (uint32_t)buf[2] << 16 | (uint32_t)buf[3] << 24;
  visits++;
  uint8_t block[16] = {0};
  for (int i = 0; i < 4; i++)
  {
    block[i] = (uint8_t)(visits >> (8 * i));
  }
  s = MIFARE_Write(5, block);
  printf("  visits: %lu (write block 5: %s)\r\n", (unsigned long)visits, GetStatusCodeName(s));
}

static void ultralight(void)
{
  uint8_t buf[18];
  StatusCode s = MIFARE_Read(4, buf);
  if (s != STATUS_OK)
  {
    printf("  read page 4: %s\r\n", GetStatusCodeName(s));
    return;
  }
  printf("  pages 4-7: ");
  print_text(buf, 16);
  printf("\r\n");
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
  MX_SPI1_Init();
  MX_USART2_UART_Init();
  printf("RC522 RFID reader on SPI1 (SDA D10, RST D9)\r\n");
  for (;;)
  {
    PCD_Init();
    uint8_t v = PCD_ReadRegister(VersionReg);
    if (v == 0x00 || v == 0xFF)
    {
      printf("MFRC522 does not answer (VersionReg 0x%02X): check the wiring\r\n", v);
      HAL_Delay(1000);
      continue;
    }
    printf("MFRC522 version 0x%02X%s\r\n", v, v == 0x92 ? " (v2.0)" : v == 0x91 ? " (v1.0)" : " (clone?)");
    break;
  }
  printf("Place a card on the reader\r\n");

  while (1)
  {
    uint8_t atqa[2];
    if (PICC_RequestA(atqa) != STATUS_OK)
    {
      HAL_Delay(50);
      continue;
    }
    Uid uid;
    StatusCode s = PICC_Select(&uid);
    if (s != STATUS_OK)
    {
      printf("select: %s\r\n", GetStatusCodeName(s));
      continue;
    }
    printf("UID:");
    for (int i = 0; i < uid.size; i++)
    {
      printf(" %02X", uid.uid[i]);
    }
    const char *type = uid.sak == 0x08 ? "MIFARE Classic 1K" : uid.sak == 0x00 ? "MIFARE Ultralight" : "?";
    printf("  (ATQA %02X %02X, SAK %02X, %s)\r\n", atqa[0], atqa[1], uid.sak, type);
    int allowed = uid.size == 4 && memcmp(uid.uid, ALLOWED, 4) == 0;
    printf("  %s\r\n", allowed ? "access granted" : "access denied");
    leds(allowed, !allowed);
    if (uid.sak == 0x08)
    {
      classic(&uid, allowed);
    }
    else if (uid.sak == 0x00)
    {
      ultralight();
    }
    PICC_HaltA();
    PCD_StopCrypto1();
    /* A halted card ignores REQA; WUPA wakes it while it is still there.
     * WUPA wakes any card in the field, so check it is the same UID (a
     * card swapped for another one counts as removed). */
    int misses = 0;
    while (misses < 2)
    {
      HAL_Delay(100);
      Uid again;
      if (PICC_WakeupA(atqa) == STATUS_OK && PICC_Select(&again) == STATUS_OK && again.size == uid.size &&
          memcmp(again.uid, uid.uid, uid.size) == 0)
      {
        misses = 0;
        PICC_HaltA();
      }
      else
      {
        misses++;
      }
    }
    printf("card removed\r\n");
    leds(0, 0);
  }
}

/* ------------------------------------------------------- peripherals */

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef g = {0};
  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOC_CLK_ENABLE();
  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_6, GPIO_PIN_SET); /* SDA (NSS) idle high */
  HAL_GPIO_WritePin(GPIOC, GPIO_PIN_7, GPIO_PIN_RESET); /* RST low until PCD_Init */
  HAL_GPIO_WritePin(GPIOA, GPIO_PIN_8, GPIO_PIN_RESET);
  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_10, GPIO_PIN_RESET);
  g.Mode = GPIO_MODE_OUTPUT_PP;
  g.Pull = GPIO_NOPULL;
  g.Speed = GPIO_SPEED_FREQ_HIGH;
  g.Pin = GPIO_PIN_6 | GPIO_PIN_10;
  HAL_GPIO_Init(GPIOB, &g);
  g.Pin = GPIO_PIN_7;
  HAL_GPIO_Init(GPIOC, &g);
  g.Pin = GPIO_PIN_8;
  HAL_GPIO_Init(GPIOA, &g);
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
  hspi1.Init.BaudRatePrescaler = SPI_BAUDRATEPRESCALER_16; /* 84 MHz / 16 */
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
