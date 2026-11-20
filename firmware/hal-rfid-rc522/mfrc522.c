/*
 * MFRC522 driver for SPI, after the Arduino MFRC522 library.
 *
 * SPI (datasheet §8.1.2): mode 0, MSB first, at most 10 Mbit/s. The first
 * byte after NSS (the module's SDA pin) goes low is the address: bit 7 = 1
 * reads, the register in bits 6..1, bit 0 = 0. Writes: the following bytes
 * are data for that register (a FIFO burst). Reads: every further byte is
 * the next address to read, each answer comes one byte later, a 0x00 ends.
 *
 * Talking to a card: put the frame in the FIFO, CommandReg = Transceive,
 * BitFramingReg.StartSend; then wait for RxIRq (or IdleIRq) in ComIrqReg —
 * or TimerIRq, which the timer (TAuto, 25 ms) raises when no card answers.
 */
#include "main.h"
#include "mfrc522.h"

extern SPI_HandleTypeDef hspi1;

#define CS_LOW()  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_6, GPIO_PIN_RESET)
#define CS_HIGH() HAL_GPIO_WritePin(GPIOB, GPIO_PIN_6, GPIO_PIN_SET)

static uint8_t xfer(uint8_t out)
{
  uint8_t in = 0;
  HAL_SPI_TransmitReceive(&hspi1, &out, &in, 1, 10);
  return in;
}

void PCD_WriteRegister(uint8_t reg, uint8_t value)
{
  CS_LOW();
  xfer((uint8_t)(reg << 1));
  xfer(value);
  CS_HIGH();
}

static void write_burst(uint8_t reg, const uint8_t *values, uint8_t n)
{
  CS_LOW();
  xfer((uint8_t)(reg << 1));
  for (uint8_t i = 0; i < n; i++)
  {
    xfer(values[i]);
  }
  CS_HIGH();
}

uint8_t PCD_ReadRegister(uint8_t reg)
{
  CS_LOW();
  xfer((uint8_t)(0x80 | (reg << 1)));
  uint8_t v = xfer(0);
  CS_HIGH();
  return v;
}

static void read_burst(uint8_t reg, uint8_t *values, uint8_t n)
{
  if (n == 0)
  {
    return;
  }
  uint8_t address = (uint8_t)(0x80 | (reg << 1));
  CS_LOW();
  xfer(address);
  for (uint8_t i = 0; i < n - 1; i++)
  {
    values[i] = xfer(address);
  }
  values[n - 1] = xfer(0);
  CS_HIGH();
}

static void set_bits(uint8_t reg, uint8_t mask)
{
  PCD_WriteRegister(reg, PCD_ReadRegister(reg) | mask);
}

static void clear_bits(uint8_t reg, uint8_t mask)
{
  PCD_WriteRegister(reg, PCD_ReadRegister(reg) & (uint8_t)~mask);
}

void PCD_Init(void)
{
  /* NRSTPD (D9) high: out of hard power-down; the oscillator starts. */
  HAL_GPIO_WritePin(GPIOC, GPIO_PIN_7, GPIO_PIN_SET);
  HAL_Delay(50);
  PCD_WriteRegister(CommandReg, PCD_SoftReset);
  HAL_Delay(50);
  while (PCD_ReadRegister(CommandReg) & (1 << 4)) /* PowerDown */
  {
  }
  /* Timer: TAuto, f = 13.56 MHz / (2 * 0x0A9 + 1) = 40 kHz, reload 1000
   * → 25 ms without an answer gives TimerIRq. */
  PCD_WriteRegister(TxModeReg, 0x00);
  PCD_WriteRegister(RxModeReg, 0x00);
  PCD_WriteRegister(ModWidthReg, 0x26);
  PCD_WriteRegister(TModeReg, 0x80);
  PCD_WriteRegister(TPrescalerReg, 0xA9);
  PCD_WriteRegister(TReloadRegH, 0x03);
  PCD_WriteRegister(TReloadRegL, 0xE8);
  PCD_WriteRegister(TxASKReg, 0x40); /* 100 % ASK (type A) */
  PCD_WriteRegister(ModeReg, 0x3D);  /* CRC preset 0x6363 (CRC_A) */
  /* Antenna on: both TX drivers. */
  if ((PCD_ReadRegister(TxControlReg) & 0x03) != 0x03)
  {
    set_bits(TxControlReg, 0x03);
  }
}

/* CRC_A by the chip's coprocessor, low byte first. */
static StatusCode calc_crc(const uint8_t *data, uint8_t n, uint8_t out[2])
{
  PCD_WriteRegister(CommandReg, PCD_Idle);
  PCD_WriteRegister(DivIrqReg, 0x04);
  PCD_WriteRegister(FIFOLevelReg, 0x80);
  write_burst(FIFODataReg, data, n);
  PCD_WriteRegister(CommandReg, PCD_CalcCRC);
  uint32_t start = HAL_GetTick();
  while (!(PCD_ReadRegister(DivIrqReg) & 0x04))
  {
    if (HAL_GetTick() - start > 89)
    {
      return STATUS_TIMEOUT;
    }
  }
  PCD_WriteRegister(CommandReg, PCD_Idle);
  out[0] = PCD_ReadRegister(CRCResultRegL);
  out[1] = PCD_ReadRegister(CRCResultRegH);
  return STATUS_OK;
}

static StatusCode communicate(uint8_t command, uint8_t wait_irq, const uint8_t *send, uint8_t send_len,
                              uint8_t *back, uint8_t *back_len, uint8_t *valid_bits, int check_crc)
{
  uint8_t tx_last_bits = valid_bits ? *valid_bits : 0;
  PCD_WriteRegister(CommandReg, PCD_Idle);
  PCD_WriteRegister(ComIrqReg, 0x7F);     /* clear all IRQ bits */
  PCD_WriteRegister(FIFOLevelReg, 0x80);  /* flush the FIFO */
  write_burst(FIFODataReg, send, send_len);
  PCD_WriteRegister(BitFramingReg, tx_last_bits);
  PCD_WriteRegister(CommandReg, command);
  if (command == PCD_Transceive)
  {
    set_bits(BitFramingReg, 0x80); /* StartSend */
  }
  uint32_t start = HAL_GetTick();
  for (;;)
  {
    uint8_t n = PCD_ReadRegister(ComIrqReg);
    if (n & wait_irq)
    {
      break;
    }
    if (n & 0x01)
    {
      return STATUS_TIMEOUT; /* TimerIRq: nobody answered */
    }
    if (HAL_GetTick() - start > 36)
    {
      return STATUS_TIMEOUT;
    }
  }
  uint8_t err = PCD_ReadRegister(ErrorReg);
  if (err & 0x13) /* BufferOvfl, ParityErr, ProtocolErr */
  {
    return STATUS_ERROR;
  }
  uint8_t bits = 0;
  if (back && back_len)
  {
    uint8_t n = PCD_ReadRegister(FIFOLevelReg);
    if (n > *back_len)
    {
      return STATUS_NO_ROOM;
    }
    *back_len = n;
    read_burst(FIFODataReg, back, n);
    bits = PCD_ReadRegister(ControlReg) & 0x07;
    if (valid_bits)
    {
      *valid_bits = bits;
    }
  }
  if (err & 0x08)
  {
    return STATUS_COLLISION;
  }
  if (back && back_len && check_crc)
  {
    if (*back_len == 1 && bits == 4)
    {
      return STATUS_MIFARE_NACK;
    }
    if (*back_len < 2 || bits != 0)
    {
      return STATUS_CRC_WRONG;
    }
    uint8_t crc[2];
    if (calc_crc(back, (uint8_t)(*back_len - 2), crc) != STATUS_OK)
    {
      return STATUS_TIMEOUT;
    }
    if (back[*back_len - 2] != crc[0] || back[*back_len - 1] != crc[1])
    {
      return STATUS_CRC_WRONG;
    }
  }
  return STATUS_OK;
}

static StatusCode transceive(const uint8_t *send, uint8_t send_len, uint8_t *back, uint8_t *back_len,
                             uint8_t *valid_bits, int check_crc)
{
  return communicate(PCD_Transceive, 0x30, send, send_len, back, back_len, valid_bits, check_crc);
}

static StatusCode request(uint8_t cmd, uint8_t atqa[2])
{
  uint8_t len = 2, bits = 7; /* short frame */
  clear_bits(CollReg, 0x80);
  StatusCode s = transceive(&cmd, 1, atqa, &len, &bits, 0);
  if (s != STATUS_OK)
  {
    return s;
  }
  return (len == 2 && bits == 0) ? STATUS_OK : STATUS_ERROR;
}

StatusCode PICC_RequestA(uint8_t atqa[2])
{
  return request(PICC_REQA, atqa);
}

StatusCode PICC_WakeupA(uint8_t atqa[2])
{
  return request(PICC_WUPA, atqa);
}

/* Anticollision and SELECT, cascade level by cascade level (one card on
 * the antenna: no collision handling). */
StatusCode PICC_Select(Uid *uid)
{
  uid->size = 0;
  for (uint8_t level = 1; level <= 3; level++)
  {
    uint8_t sel = level == 1 ? PICC_SEL_CL1 : level == 2 ? PICC_SEL_CL2 : 0x97;
    uint8_t frame[9] = {sel, 0x20};
    uint8_t back[5], len = 5, bits = 0;
    StatusCode s = transceive(frame, 2, back, &len, &bits, 0);
    if (s != STATUS_OK)
    {
      return s;
    }
    if (len != 5 || (back[0] ^ back[1] ^ back[2] ^ back[3]) != back[4])
    {
      return STATUS_ERROR; /* BCC wrong */
    }
    frame[1] = 0x70; /* NVB: all 40 bits */
    for (int i = 0; i < 5; i++)
    {
      frame[2 + i] = back[i];
    }
    if (calc_crc(frame, 7, &frame[7]) != STATUS_OK)
    {
      return STATUS_TIMEOUT;
    }
    uint8_t sak[3];
    len = 3;
    bits = 0;
    s = transceive(frame, 9, sak, &len, &bits, 1);
    if (s != STATUS_OK)
    {
      return s;
    }
    /* Cascade tag 0x88: three UID bytes here, more on the next level. */
    int first = back[0] == 0x88 ? 1 : 0;
    for (int i = first; i < 4; i++)
    {
      uid->uid[uid->size++] = back[i];
    }
    if (!(sak[0] & 0x04))
    {
      uid->sak = sak[0];
      return STATUS_OK;
    }
  }
  return STATUS_ERROR;
}

StatusCode PICC_HaltA(void)
{
  uint8_t frame[4] = {PICC_HLTA, 0};
  if (calc_crc(frame, 2, &frame[2]) != STATUS_OK)
  {
    return STATUS_TIMEOUT;
  }
  /* A halted card says nothing: a timeout is success. */
  StatusCode s = transceive(frame, 4, 0, 0, 0, 0);
  return s == STATUS_TIMEOUT ? STATUS_OK : STATUS_ERROR;
}

StatusCode PCD_Authenticate(uint8_t cmd, uint8_t block, const uint8_t key[6], const Uid *uid)
{
  uint8_t frame[12] = {cmd, block};
  for (int i = 0; i < 6; i++)
  {
    frame[2 + i] = key[i];
  }
  /* The last four UID bytes (cascade level 1 for a 4-byte UID). */
  for (int i = 0; i < 4; i++)
  {
    frame[8 + i] = uid->uid[uid->size - 4 + i];
  }
  return communicate(PCD_MFAuthent, 0x10, frame, 12, 0, 0, 0, 0);
}

void PCD_StopCrypto1(void)
{
  clear_bits(Status2Reg, 0x08);
}

StatusCode MIFARE_Read(uint8_t block, uint8_t out[18])
{
  uint8_t frame[4] = {PICC_READ, block};
  if (calc_crc(frame, 2, &frame[2]) != STATUS_OK)
  {
    return STATUS_TIMEOUT;
  }
  uint8_t len = 18;
  return transceive(frame, 4, out, &len, 0, 1);
}

/* A 4-bit ACK (0xA) or NAK from the card. */
static StatusCode mifare_transceive(const uint8_t *data, uint8_t n)
{
  uint8_t frame[18];
  for (uint8_t i = 0; i < n; i++)
  {
    frame[i] = data[i];
  }
  if (calc_crc(frame, n, &frame[n]) != STATUS_OK)
  {
    return STATUS_TIMEOUT;
  }
  uint8_t back[2], len = 2, bits = 0;
  StatusCode s = transceive(frame, (uint8_t)(n + 2), back, &len, &bits, 0);
  if (s != STATUS_OK)
  {
    return s;
  }
  if (len != 1 || bits != 4)
  {
    return STATUS_ERROR;
  }
  return back[0] == MF_ACK ? STATUS_OK : STATUS_MIFARE_NACK;
}

StatusCode MIFARE_Write(uint8_t block, const uint8_t data[16])
{
  uint8_t cmd[2] = {PICC_WRITE, block};
  StatusCode s = mifare_transceive(cmd, 2);
  if (s != STATUS_OK)
  {
    return s;
  }
  return mifare_transceive(data, 16);
}

StatusCode MIFARE_Ultralight_Write(uint8_t page, const uint8_t data[4])
{
  uint8_t cmd[6] = {PICC_UL_WRITE, page, data[0], data[1], data[2], data[3]};
  return mifare_transceive(cmd, 6);
}

const char *GetStatusCodeName(StatusCode s)
{
  switch (s)
  {
  case STATUS_OK: return "OK";
  case STATUS_ERROR: return "error in communication";
  case STATUS_COLLISION: return "collision";
  case STATUS_TIMEOUT: return "timeout";
  case STATUS_NO_ROOM: return "buffer too small";
  case STATUS_CRC_WRONG: return "CRC wrong";
  case STATUS_MIFARE_NACK: return "MIFARE NACK";
  }
  return "?";
}
