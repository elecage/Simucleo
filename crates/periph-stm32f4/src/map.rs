//! STM32F401xE memory map (RM0368 §2.3).

pub const FLASH_BASE: u32 = 0x0800_0000;
pub const FLASH_SIZE: usize = 512 * 1024;
pub const SRAM_BASE: u32 = 0x2000_0000;
pub const SRAM_SIZE: usize = 96 * 1024;

/// Size of the boot alias at 0x0000_0000 (mirrors main flash).
const BOOT_ALIAS_SIZE: u32 = FLASH_SIZE as u32;

pub const TIM2_BASE: u32 = 0x4000_0000;
pub const TIM3_BASE: u32 = 0x4000_0400;
pub const TIM4_BASE: u32 = 0x4000_0800;
pub const TIM5_BASE: u32 = 0x4000_0C00;
pub const USART2_BASE: u32 = 0x4000_4400;
pub const I2C1_BASE: u32 = 0x4000_5400;
pub const PWR_BASE: u32 = 0x4000_7000;
pub const TIM1_BASE: u32 = 0x4001_0000;
pub const USART1_BASE: u32 = 0x4001_1000;
pub const ADC1_BASE: u32 = 0x4001_2000;
pub const SPI1_BASE: u32 = 0x4001_3000;
pub const SYSCFG_BASE: u32 = 0x4001_3800;
pub const EXTI_BASE: u32 = 0x4001_3C00;
pub const TIM9_BASE: u32 = 0x4001_4000;
pub const TIM10_BASE: u32 = 0x4001_4400;
pub const TIM11_BASE: u32 = 0x4001_4800;
pub const GPIOA_BASE: u32 = 0x4002_0000;
pub const GPIOB_BASE: u32 = 0x4002_0400;
pub const GPIOC_BASE: u32 = 0x4002_0800;
pub const GPIOD_BASE: u32 = 0x4002_0C00;
pub const GPIOH_BASE: u32 = 0x4002_1C00;
pub const RCC_BASE: u32 = 0x4002_3800;
pub const FLASH_IF_BASE: u32 = 0x4002_3C00;
pub const DMA1_BASE: u32 = 0x4002_6000;
pub const DMA2_BASE: u32 = 0x4002_6400;

/// Private peripheral bus: SysTick, NVIC, SCB, FPU (CPACR/FPCCR).
pub const PPB_BASE: u32 = 0xE000_0000;

/// Translate the boot alias at 0x0000_0000 to main flash.
pub fn resolve_alias(addr: u32) -> u32 {
    if addr < BOOT_ALIAS_SIZE {
        FLASH_BASE + addr
    } else {
        addr
    }
}

pub fn is_peripheral_space(addr: u32) -> bool {
    (0x4000_0000..0x6000_0000).contains(&addr) || addr >= PPB_BASE
}

/// Name of the peripheral whose register block contains `addr`.
pub fn peripheral_name(addr: u32) -> Option<&'static str> {
    if (PPB_BASE..0xE010_0000).contains(&addr) {
        return Some("PPB");
    }
    crate::regmap::peripheral_at(addr).map(|p| p.name)
}
