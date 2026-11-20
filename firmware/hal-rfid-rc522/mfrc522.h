/* MFRC522 RFID reader on SPI: a small driver in the style of the Arduino
 * MFRC522 library (PCD_* reader functions, PICC_* card functions). */
#ifndef MFRC522_H
#define MFRC522_H

#include <stdint.h>

/* Registers (MFRC522 datasheet §9.2). */
enum {
  CommandReg = 0x01, ComIEnReg = 0x02, DivIEnReg = 0x03, ComIrqReg = 0x04, DivIrqReg = 0x05,
  ErrorReg = 0x06, Status1Reg = 0x07, Status2Reg = 0x08, FIFODataReg = 0x09, FIFOLevelReg = 0x0A,
  ControlReg = 0x0C, BitFramingReg = 0x0D, CollReg = 0x0E, ModeReg = 0x11, TxModeReg = 0x12,
  RxModeReg = 0x13, TxControlReg = 0x14, TxASKReg = 0x15, CRCResultRegH = 0x21, CRCResultRegL = 0x22,
  ModWidthReg = 0x24, TModeReg = 0x2A, TPrescalerReg = 0x2B, TReloadRegH = 0x2C, TReloadRegL = 0x2D,
  VersionReg = 0x37,
};

/* Commands (CommandReg). */
enum {
  PCD_Idle = 0x00, PCD_CalcCRC = 0x03, PCD_Transceive = 0x0C, PCD_MFAuthent = 0x0E, PCD_SoftReset = 0x0F,
};

/* Card commands (ISO 14443-3, MIFARE). */
enum {
  PICC_REQA = 0x26, PICC_WUPA = 0x52, PICC_SEL_CL1 = 0x93, PICC_SEL_CL2 = 0x95, PICC_HLTA = 0x50,
  PICC_AUTH_KEYA = 0x60, PICC_AUTH_KEYB = 0x61, PICC_READ = 0x30, PICC_WRITE = 0xA0, PICC_UL_WRITE = 0xA2,
  MF_ACK = 0x0A,
};

typedef enum {
  STATUS_OK, STATUS_ERROR, STATUS_COLLISION, STATUS_TIMEOUT, STATUS_NO_ROOM, STATUS_CRC_WRONG,
  STATUS_MIFARE_NACK,
} StatusCode;

typedef struct {
  uint8_t size; /* 4 or 7 */
  uint8_t uid[10];
  uint8_t sak;
} Uid;

uint8_t PCD_ReadRegister(uint8_t reg);
void PCD_WriteRegister(uint8_t reg, uint8_t value);
void PCD_Init(void);
StatusCode PICC_RequestA(uint8_t atqa[2]);
StatusCode PICC_WakeupA(uint8_t atqa[2]);
StatusCode PICC_Select(Uid *uid);
StatusCode PICC_HaltA(void);
StatusCode PCD_Authenticate(uint8_t cmd, uint8_t block, const uint8_t key[6], const Uid *uid);
void PCD_StopCrypto1(void);
StatusCode MIFARE_Read(uint8_t block, uint8_t out[18]);
StatusCode MIFARE_Write(uint8_t block, const uint8_t data[16]);
StatusCode MIFARE_Ultralight_Write(uint8_t page, const uint8_t data[4]);
const char *GetStatusCodeName(StatusCode s);

#endif
