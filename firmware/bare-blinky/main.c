/* Toggle LD2 (PA5) on the Nucleo-F401RE using direct register access. */
#include <stdint.h>

#define REG(addr)     (*(volatile uint32_t *)(addr))
#define RCC_AHB1ENR   REG(0x40023830)
#define GPIOA_MODER   REG(0x40020000)
#define GPIOA_ODR     REG(0x40020014)

static volatile uint32_t blink_count;

int main(void)
{
    RCC_AHB1ENR |= 1u << 0;                          /* GPIOAEN */
    GPIOA_MODER = (GPIOA_MODER & ~(3u << 10)) | (1u << 10); /* PA5 output */

    for (;;) {
        GPIOA_ODR ^= 1u << 5;
        blink_count++;
        for (volatile uint32_t i = 0; i < 200000; i++) {}
    }
}
