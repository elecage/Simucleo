/*
 * CubeMX-style HAL bootloader with in-application programming (IAP) over
 * USART2 (ST-LINK virtual COM port, 115200 8N1): XMODEM-CRC download into a
 * second slot, image verification, dual image with backup and rollback.
 *
 * Flash map, image header and metadata records: see bootmeta.h. This
 * project is linked for sectors 0-1 only (bootloader.ld, 32 KB).
 *
 * Boot flow
 *   1. Print a banner with the reset cause (RCC_CSR flags, then RMVF) and
 *      the image in slot A.
 *   2. The last metadata record says "trial" (an update not confirmed yet):
 *      count one more try (a new record). After TRIAL_MAX_TRIES boots
 *      without a confirmation, roll back (copy slot C to A). Otherwise start
 *      the IWDG (2 s) and boot the image at once: if it hangs, the watchdog
 *      resets the board and we come back here.
 *   3. A valid image in slot A: boot it unless a key comes within 2 s.
 *      None: stay in the menu.
 *
 * Menu: u = update (XMODEM-CRC into slot B), b = boot, r = roll back to the
 * backup in slot C, i = info.
 *
 * Update: erase slot B, receive it with XMODEM-CRC (128-byte SOH or
 * 1024-byte STX blocks, CRC-16/CCITT, ACK/NAK, EOT, CAN aborts), program
 * every block as it arrives, then verify (header magic, size, CRC-32,
 * initial SP in SRAM, reset vector in slot A). A good image: copy slot A to
 * slot C (backup), slot B to slot A, write a "trial" record and reset.
 *
 * Waiting (for a key, an XMODEM byte, the end of an erase) sleeps in WFI:
 * USART2 receives by interrupt into a ring buffer.
 */
#include <stddef.h>
#include <stdio.h>
#include "main.h"
#include "bootmeta.h"

UART_HandleTypeDef huart2;

static void MX_USART2_UART_Init(void);

/* ------------------------------------------------------- UART ring buffer */

#define RX_SIZE 2048u
static uint8_t rx_buf[RX_SIZE];
static volatile uint32_t rx_head, rx_tail;
static uint8_t rx_byte;

void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart)
{
  if (huart->Instance == USART2)
  {
    uint32_t next = (rx_head + 1u) % RX_SIZE;
    if (next != rx_tail)
    {
      rx_buf[rx_head] = rx_byte;
      rx_head = next;
    }
    HAL_UART_Receive_IT(&huart2, &rx_byte, 1);
  }
}

void HAL_UART_ErrorCallback(UART_HandleTypeDef *huart)
{
  /* An overrun or framing error aborts the reception: start it again. */
  if (huart->Instance == USART2)
  {
    HAL_UART_Receive_IT(&huart2, &rx_byte, 1);
  }
}

/* The next received byte, or -1 after `ms` milliseconds (sleeping meanwhile). */
static int getc_timeout(uint32_t ms)
{
  uint32_t t0 = HAL_GetTick();
  while (rx_tail == rx_head)
  {
    if (HAL_GetTick() - t0 >= ms)
    {
      return -1;
    }
    __WFI(); /* the SysTick or the UART wakes us */
  }
  uint8_t c = rx_buf[rx_tail];
  rx_tail = (rx_tail + 1u) % RX_SIZE;
  return c;
}

/* Drop input until the line has been quiet for `ms`. */
static void flush_input(uint32_t ms)
{
  while (getc_timeout(ms) >= 0)
  {
  }
}

static void putbyte(uint8_t c)
{
  HAL_UART_Transmit(&huart2, &c, 1, 100);
}

/* ------------------------------------------------------------ images */

static const image_header_t *header_of(uint32_t base)
{
  return (const image_header_t *)(base + IMAGE_HEADER_OFFSET);
}

/* CRC-32 of the image at `base` with its crc32 field taken as 0. */
static uint32_t image_crc(uint32_t base, uint32_t size)
{
  const uint32_t field = IMAGE_HEADER_OFFSET + offsetof(image_header_t, crc32);
  static const uint8_t zero[4];
  uint32_t c = crc32_update(0xFFFFFFFFu, (const uint8_t *)base, field);
  c = crc32_update(c, zero, 4);
  c = crc32_update(c, (const uint8_t *)(base + field + 4), size - field - 4);
  return c ^ 0xFFFFFFFFu;
}

/* Why the image at `base` cannot run from slot A, or 0 if it can. */
static const char *image_problem(uint32_t base)
{
  static char why[64];
  const image_header_t *h = header_of(base);
  if (h->magic != IMAGE_MAGIC)
  {
    return "no image header (bad magic)";
  }
  if (h->size < IMAGE_HEADER_OFFSET + sizeof *h || h->size > SLOT_SIZE || h->size % 4u)
  {
    return "bad size";
  }
  uint32_t c = image_crc(base, h->size);
  if (c != h->crc32)
  {
    snprintf(why, sizeof why, "CRC mismatch (computed 0x%08lX, header 0x%08lX)", (unsigned long)c,
             (unsigned long)h->crc32);
    return why;
  }
  uint32_t sp = ((const uint32_t *)base)[0], pc = ((const uint32_t *)base)[1];
  if (sp <= SRAM_START || sp > SRAM_END || sp % 4u)
  {
    return "initial stack pointer outside SRAM";
  }
  if (!(pc & 1u) || (pc & ~1u) < SLOT_A || (pc & ~1u) >= SLOT_A + h->size)
  {
    return "reset vector outside slot A";
  }
  return 0;
}

static int image_valid(uint32_t base)
{
  return image_problem(base) == 0;
}

static void print_slot(const char *name, uint32_t base)
{
  const image_header_t *h = header_of(base);
  printf("slot %s 0x%08lX: ", name, (unsigned long)base);
  if (h->magic == 0xFFFFFFFFu)
  {
    printf("empty\r\n");
    return;
  }
  const char *why = image_problem(base);
  if (why)
  {
    printf("invalid (%s)\r\n", why);
  }
  else
  {
    printf("app v%lu, %lu bytes, CRC32 0x%08lX\r\n", (unsigned long)h->version,
           (unsigned long)h->size, (unsigned long)h->crc32);
  }
}

/* Erase the slot at dst (its sector) and copy the image at src there. */
static int copy_image(uint32_t dst, uint32_t dst_sector, uint32_t src)
{
  uint32_t size = header_of(src)->size;
  HAL_FLASH_Unlock();
  int err = flash_erase_sector(dst_sector);
  if (!err)
  {
    err = flash_program(dst, (const void *)src, size);
  }
  HAL_FLASH_Lock();
  return err;
}

/* ------------------------------------------------------------ boot */

static void boot_image(void)
{
  uint32_t sp = ((const uint32_t *)SLOT_A)[0];
  uint32_t pc = ((const uint32_t *)SLOT_A)[1];
  printf("booting app v%lu\r\n\r\n", (unsigned long)header_of(SLOT_A)->version);
  /* Leave the chip as after reset: UART off, clocks back to HSI 16 MHz
   * (HAL_RCC_DeInit needs the tick, so before SysTick stops), peripherals
   * reset, no interrupt enabled or pending. */
  HAL_UART_DeInit(&huart2);
  HAL_NVIC_DisableIRQ(FLASH_IRQn);
  HAL_RCC_DeInit();
  __disable_irq();
  SysTick->CTRL = 0;
  SysTick->VAL = 0;
  HAL_DeInit();
  for (uint32_t i = 0; i < 8; i++)
  {
    NVIC->ICER[i] = 0xFFFFFFFFu;
    NVIC->ICPR[i] = 0xFFFFFFFFu;
  }
  SCB->ICSR = SCB_ICSR_PENDSTCLR_Msk;
  /* The image's vector table, then its stack and reset handler. */
  SCB->VTOR = SLOT_A;
  __DSB();
  __ISB();
  __enable_irq();
  __asm volatile("msr msp, %0\n\tbx %1" : : "r"(sp), "r"(pc) : "memory");
  while (1)
  {
  }
}

/* Copy the backup (slot C) to slot A and record it. 0 = done. */
static int roll_back(void)
{
  const char *why = image_problem(SLOT_C);
  if (why)
  {
    printf("rollback impossible: no valid backup in slot C (%s)\r\n", why);
    return -1;
  }
  printf("restoring the backup app v%lu from slot C...\r\n", (unsigned long)header_of(SLOT_C)->version);
  if (copy_image(SLOT_A, SLOT_A_SECTOR, SLOT_C) || !image_valid(SLOT_A))
  {
    printf("rollback failed: flash error\r\n");
    return -1;
  }
  meta_append(META_ROLLED_BACK, 0, header_of(SLOT_A)->version);
  printf("rolled back to app v%lu\r\n", (unsigned long)header_of(SLOT_A)->version);
  return 0;
}

/* ------------------------------------------------------------ XMODEM */

#define SOH 0x01
#define STX 0x02
#define EOT 0x04
#define ACK 0x06
#define NAK 0x15
#define CAN 0x18

static uint16_t crc16_ccitt(const uint8_t *p, uint32_t n)
{
  uint16_t crc = 0;
  while (n--)
  {
    crc ^= (uint16_t)(*p++) << 8;
    for (int k = 0; k < 8; k++)
    {
      crc = (crc & 0x8000u) ? (uint16_t)(crc << 1) ^ 0x1021u : (uint16_t)(crc << 1);
    }
  }
  return crc;
}

static uint8_t block[1024];

static void cancel(void)
{
  for (int i = 0; i < 3; i++)
  {
    putbyte(CAN);
  }
  flush_input(500);
}

/* Receive a file into slot B. Returns its length (bytes received) or -1. */
static int32_t xmodem_receive(void)
{
  uint32_t offset = 0;
  uint8_t expected = 1;
  int started = 0, errors = 0;
  printf("waiting for XMODEM-CRC upload (send the .bin file; CAN aborts)...\r\n");
  while (1)
  {
    int c;
    if (!started)
    {
      /* Ask for CRC mode until the sender starts: 'C' every second, 60 s. */
      putbyte('C');
      c = getc_timeout(1000);
      if (c < 0)
      {
        if (++errors >= 60)
        {
          cancel();
          printf("\r\nupdate aborted: no sender\r\n");
          return -1;
        }
        continue;
      }
    }
    else
    {
      c = getc_timeout(5000);
      if (c < 0)
      {
        if (++errors > 10)
        {
          cancel();
          printf("\r\nupdate aborted: the sender stopped\r\n");
          return -1;
        }
        putbyte(NAK);
        continue;
      }
    }
    if (c == EOT)
    {
      putbyte(ACK);
      flush_input(100);
      return (int32_t)offset;
    }
    if (c == CAN)
    {
      if (getc_timeout(1000) == CAN)
      {
        flush_input(200);
        printf("\r\nupdate aborted: cancelled by the sender\r\n");
        return -1;
      }
      continue;
    }
    if (c != SOH && c != STX)
    {
      continue; /* noise, or a key typed before the sender started */
    }
    if (!started)
    {
      started = 1; /* from now on a bad block is answered with NAK */
      errors = 0;
    }
    uint32_t len = c == STX ? 1024u : 128u;
    int blk = getc_timeout(1000), nblk = getc_timeout(1000);
    uint32_t i = 0;
    for (; i < len; i++)
    {
      int d = getc_timeout(1000);
      if (d < 0)
      {
        break;
      }
      block[i] = (uint8_t)d;
    }
    int hi = getc_timeout(1000), lo = getc_timeout(1000);
    if (blk < 0 || nblk < 0 || i < len || lo < 0 || (blk ^ nblk) != 0xFF ||
        crc16_ccitt(block, len) != (uint16_t)(hi << 8 | lo))
    {
      flush_input(100);
      if (++errors > 10)
      {
        cancel();
        printf("\r\nupdate aborted: too many errors\r\n");
        return -1;
      }
      putbyte(NAK);
      continue;
    }
    if (blk == (uint8_t)(expected - 1u) && offset > 0)
    {
      putbyte(ACK); /* our ACK was lost: the same block again */
      continue;
    }
    if (blk != expected)
    {
      cancel();
      printf("\r\nupdate aborted: block %d out of sequence (expected %u)\r\n", blk, expected);
      return -1;
    }
    if (offset + len > SLOT_SIZE)
    {
      cancel();
      printf("\r\nupdate aborted: image too big for the 128 KB slot\r\n");
      return -1;
    }
    HAL_FLASH_Unlock();
    int err = flash_program(SLOT_B + offset, block, len);
    HAL_FLASH_Lock();
    if (err)
    {
      cancel();
      printf("\r\nupdate aborted: flash programming error\r\n");
      return -1;
    }
    offset += len;
    expected++;
    errors = 0;
    putbyte(ACK);
  }
}

static void update(void)
{
  printf("erasing slot B...\r\n");
  uint32_t t0 = HAL_GetTick();
  HAL_FLASH_Unlock();
  int err = flash_erase_sector(SLOT_B_SECTOR);
  HAL_FLASH_Lock();
  if (err)
  {
    printf("update aborted: erase failed\r\n");
    return;
  }
  printf("slot B erased in %lu ms\r\n", (unsigned long)(HAL_GetTick() - t0));
  flush_input(10);
  int32_t n = xmodem_receive();
  if (n < 0)
  {
    return;
  }
  printf("\r\nreceived %ld bytes\r\n", (long)n);
  const char *why = image_problem(SLOT_B);
  if (why)
  {
    printf("image rejected: %s\r\n", why);
    return;
  }
  const image_header_t *h = header_of(SLOT_B);
  if (h->size > (uint32_t)n)
  {
    printf("image rejected: truncated\r\n");
    return;
  }
  printf("image OK: app v%lu, %lu bytes, CRC32 0x%08lX\r\n", (unsigned long)h->version,
         (unsigned long)h->size, (unsigned long)h->crc32);
  if (image_valid(SLOT_A))
  {
    printf("backing up slot A (app v%lu) to slot C...\r\n", (unsigned long)header_of(SLOT_A)->version);
    if (copy_image(SLOT_C, SLOT_C_SECTOR, SLOT_A) || !image_valid(SLOT_C))
    {
      printf("update aborted: backup failed\r\n");
      return;
    }
  }
  printf("installing app v%lu into slot A...\r\n", (unsigned long)h->version);
  if (copy_image(SLOT_A, SLOT_A_SECTOR, SLOT_B) || !image_valid(SLOT_A))
  {
    printf("update failed: slot A does not verify\r\n");
    return;
  }
  meta_append(META_TRIAL, 0, h->version);
  printf("rebooting into app v%lu (trial)\r\n", (unsigned long)h->version);
  HAL_Delay(5);
  NVIC_SystemReset();
}

static void info(void)
{
  print_slot("A", SLOT_A);
  print_slot("B", SLOT_B);
  print_slot("C", SLOT_C);
  uint32_t used;
  const boot_meta_t *m = meta_last(&used);
  if (m)
  {
    printf("metadata: %s, app v%lu, tries %u (%lu of %lu records used in sector 2)\r\n",
           meta_state_name(m->state), (unsigned long)m->version, m->tries, (unsigned long)used,
           (unsigned long)META_RECORDS);
  }
  else
  {
    printf("metadata: none (%lu of %lu records used in sector 2)\r\n", (unsigned long)used,
           (unsigned long)META_RECORDS);
  }
}

static void menu(void)
{
  printf("menu: u = update (XMODEM), b = boot, r = roll back, i = info\r\n> ");
  while (1)
  {
    int c = getc_timeout(1000);
    if (c < 0 || c == '\r' || c == '\n' || c == ' ')
    {
      continue;
    }
    printf("%c\r\n", c);
    switch (c)
    {
    case 'u':
    case 'U':
      update();
      break;
    case 'b':
    case 'B':
      if (image_valid(SLOT_A))
      {
        boot_image();
      }
      printf("no valid image in slot A\r\n");
      break;
    case 'r':
    case 'R':
      if (roll_back() == 0)
      {
        boot_image();
      }
      break;
    case 'i':
    case 'I':
      info();
      break;
    default:
      printf("unknown command '%c'\r\n", c);
      break;
    }
    printf("menu: u = update (XMODEM), b = boot, r = roll back, i = info\r\n> ");
  }
}

static const char *reset_cause(void)
{
  uint32_t csr = RCC->CSR;
  __HAL_RCC_CLEAR_RESET_FLAGS(); /* RMVF: the flags accumulate until cleared */
  if (csr & RCC_CSR_IWDGRSTF)
  {
    return "watchdog";
  }
  if (csr & RCC_CSR_WWDGRSTF)
  {
    return "window watchdog";
  }
  if (csr & RCC_CSR_SFTRSTF)
  {
    return "software";
  }
  if (csr & (RCC_CSR_PORRSTF | RCC_CSR_BORRSTF))
  {
    return "power-on";
  }
  if (csr & RCC_CSR_PINRSTF)
  {
    return "pin (reset button)";
  }
  return "unknown";
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_USART2_UART_Init();
  HAL_UART_Receive_IT(&huart2, &rx_byte, 1);
  setvbuf(stdout, NULL, _IONBF, 0); /* the "> " prompt has no newline */

  printf("\r\n=== Simucleo bootloader v1.0 ===\r\n");
  printf("reset cause: %s\r\n", reset_cause());
  if (image_valid(SLOT_A))
  {
    printf("slot A: app v%lu, %lu bytes\r\n", (unsigned long)header_of(SLOT_A)->version,
           (unsigned long)header_of(SLOT_A)->size);
  }
  else
  {
    printf("slot A: none\r\n");
  }

  const boot_meta_t *m = meta_last(0);
  if (m && m->state == META_TRIAL)
  {
    uint16_t tries = (uint16_t)(m->tries + 1u);
    if (tries > TRIAL_MAX_TRIES || !image_valid(SLOT_A))
    {
      printf("app v%lu not confirmed after %u tries: rolling back\r\n", (unsigned long)m->version,
             TRIAL_MAX_TRIES);
      if (roll_back() == 0)
      {
        boot_image();
      }
      menu();
    }
    meta_append(META_TRIAL, tries, m->version);
    printf("trial boot %u/%u of app v%lu (watchdog on, 2 s)\r\n", tries, TRIAL_MAX_TRIES,
           (unsigned long)m->version);
    /* LSI 32 kHz / 64 = 500 Hz, 1000 ticks: 2 s. It cannot be stopped:
     * the image must refresh it (and confirm itself) or be reset. */
    iwdg_start(4, 999);
    boot_image();
  }
  if (m && m->state == META_ROLLED_BACK)
  {
    printf("note: the last update (rolled back) did not confirm itself\r\n");
  }

  if (!image_valid(SLOT_A))
  {
    printf("no valid image in slot A\r\n");
    menu();
  }
  printf("booting app v%lu in 2 s, press any key for the menu\r\n",
         (unsigned long)header_of(SLOT_A)->version);
  if (getc_timeout(2000) < 0)
  {
    boot_image();
  }
  menu();
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
