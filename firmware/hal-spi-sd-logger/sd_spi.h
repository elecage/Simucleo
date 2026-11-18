/* SD card in SPI mode on SPI1 (D13 SCK, D12 MISO, D11 MOSI), CS on D10. */
#ifndef SD_SPI_H
#define SD_SPI_H

#include <stdint.h>

/* 0 when the card is initialised; sets the sector count. */
int sd_init(void);
int sd_read(uint8_t *buf, uint32_t sector);
int sd_write(const uint8_t *buf, uint32_t sector);
uint32_t sd_sectors(void);

#endif
