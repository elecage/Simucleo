//! STM32F401RE memory map and peripherals.
//!
//! Implemented: flash, SRAM, boot alias, bit-banding, GPIO. Every other
//! peripheral address is recorded as an *unimplemented access* so the GUI can
//! show students (and developers) which peripheral the firmware is waiting on.

pub mod gpio;
pub mod map;

use gpio::{Gpio, PinEvent};
use simucleo_core::bus::{AccessSize, Bus, BusError, Memory};
use simucleo_core::Cycles;

/// One access to an address no model handles yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnimplementedAccess {
    pub addr: u32,
    pub size: AccessSize,
    /// `Some(value)` for writes, `None` for reads.
    pub write: Option<u32>,
}

/// The system bus of an STM32F401RE booting from main flash.
pub struct Stm32f401Bus {
    pub flash: Memory,
    pub sram: Memory,
    /// GPIOA..GPIOH (F and G do not exist on this part).
    pub gpio: [Gpio; 8],
    /// Pin level changes, oldest first. The owner drains it.
    pub pin_events: Vec<PinEvent>,
    now: Cycles,
    /// Accesses to unmodelled peripheral space (reads return 0).
    pub unimplemented: Vec<UnimplementedAccess>,
}

impl Default for Stm32f401Bus {
    fn default() -> Self {
        Self::new()
    }
}

impl Stm32f401Bus {
    pub fn new() -> Self {
        Self {
            flash: Memory::new(map::FLASH_BASE, map::FLASH_SIZE, false),
            sram: Memory::new(map::SRAM_BASE, map::SRAM_SIZE, true),
            gpio: std::array::from_fn(|i| Gpio::new(i as u8)),
            pin_events: Vec::new(),
            now: 0,
            unimplemented: Vec::new(),
        }
    }

    /// Program a firmware segment into flash or SRAM.
    pub fn load(&mut self, addr: u32, bytes: &[u8]) -> Result<(), BusError> {
        let addr = map::resolve_alias(addr);
        if self.flash.contains(addr, AccessSize::Byte) {
            self.flash.load(addr, bytes)
        } else {
            self.sram.load(addr, bytes)
        }
    }
}

/// GPIO port index for an address in the AHB1 GPIO block, if it exists.
fn gpio_port(addr: u32) -> Option<usize> {
    if !(map::GPIOA_BASE..map::GPIOA_BASE + 0x2000).contains(&addr) {
        return None;
    }
    let port = ((addr - map::GPIOA_BASE) / 0x400) as usize;
    // GPIOF/GPIOG are reserved on the STM32F401.
    (port != 5 && port != 6).then_some(port)
}

/// Translate a bit-band alias address → (word address, bit).
fn bit_band(addr: u32) -> Option<(u32, u32)> {
    let (alias, target) = match addr {
        0x2200_0000..=0x23FF_FFFF => (0x2200_0000, 0x2000_0000),
        0x4200_0000..=0x43FF_FFFF => (0x4200_0000, 0x4000_0000),
        _ => return None,
    };
    let off = addr - alias;
    Some((target + ((off >> 5) & !3), (off >> 2) & 31))
}

impl Stm32f401Bus {
    fn read_inner(&mut self, addr: u32, size: AccessSize) -> Result<u32, BusError> {
        let a = map::resolve_alias(addr);
        if self.flash.contains(a, size) {
            return self.flash.read(a, size);
        }
        if self.sram.contains(a, size) {
            return self.sram.read(a, size);
        }
        if let Some(port) = gpio_port(a) {
            let word = self.gpio[port].read(a & 0x3FC);
            return Ok((word >> ((a & 3) * 8)) & size_mask(size));
        }
        if map::is_peripheral_space(a) {
            self.unimplemented.push(UnimplementedAccess {
                addr: a,
                size,
                write: None,
            });
            return Ok(0);
        }
        Err(BusError::Unmapped(addr))
    }

    fn write_inner(&mut self, addr: u32, size: AccessSize, value: u32) -> Result<(), BusError> {
        let a = map::resolve_alias(addr);
        if self.sram.contains(a, size) {
            return self.sram.write(a, size, value);
        }
        if self.flash.contains(a, size) {
            // Flash programming goes through the FLASH interface (later).
            return Err(BusError::ReadOnly(addr));
        }
        if let Some(port) = gpio_port(a) {
            let shift = (a & 3) * 8;
            let lanes = size_mask(size) << shift;
            self.gpio[port].write(
                a & 0x3FC,
                value << shift,
                lanes,
                self.now,
                &mut self.pin_events,
            );
            return Ok(());
        }
        if map::is_peripheral_space(a) {
            self.unimplemented.push(UnimplementedAccess {
                addr: a,
                size,
                write: Some(value),
            });
            return Ok(());
        }
        Err(BusError::Unmapped(addr))
    }
}

fn size_mask(size: AccessSize) -> u32 {
    match size {
        AccessSize::Byte => 0xFF,
        AccessSize::Half => 0xFFFF,
        AccessSize::Word => u32::MAX,
    }
}

impl Bus for Stm32f401Bus {
    fn read(&mut self, addr: u32, size: AccessSize) -> Result<u32, BusError> {
        if let Some((word, bit)) = bit_band(addr) {
            return Ok((self.read_inner(word, AccessSize::Word)? >> bit) & 1);
        }
        self.read_inner(addr, size)
    }

    fn write(&mut self, addr: u32, size: AccessSize, value: u32) -> Result<(), BusError> {
        if let Some((word, bit)) = bit_band(addr) {
            let old = self.read_inner(word, AccessSize::Word)?;
            let new = if value & 1 != 0 {
                old | (1 << bit)
            } else {
                old & !(1 << bit)
            };
            return self.write_inner(word, AccessSize::Word, new);
        }
        self.write_inner(addr, size, value)
    }

    fn set_time(&mut self, now: Cycles) {
        self.now = now;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boot_alias_maps_to_flash() {
        let mut bus = Stm32f401Bus::new();
        bus.load(map::FLASH_BASE, &0x2001_8000u32.to_le_bytes())
            .unwrap();
        assert_eq!(bus.read_u32(0x0000_0000).unwrap(), 0x2001_8000);
        assert_eq!(bus.read_u32(map::FLASH_BASE).unwrap(), 0x2001_8000);
    }

    #[test]
    fn unimplemented_peripheral_access_is_recorded() {
        let mut bus = Stm32f401Bus::new();
        let rcc_cr = map::RCC_BASE;
        assert_eq!(bus.read_u32(rcc_cr).unwrap(), 0);
        bus.write(rcc_cr, AccessSize::Word, 1).unwrap();
        assert_eq!(bus.unimplemented.len(), 2);
        assert_eq!(bus.unimplemented[1].write, Some(1));
        assert_eq!(map::peripheral_name(rcc_cr), Some("RCC"));
    }

    #[test]
    fn bit_banding_sram_and_gpio() {
        let mut bus = Stm32f401Bus::new();
        // SRAM word 0x2000_0010, bit 3
        bus.write(0x2200_0000 + 0x10 * 32 + 3 * 4, AccessSize::Word, 1)
            .unwrap();
        assert_eq!(bus.read_u32(0x2000_0010).unwrap(), 1 << 3);
        assert_eq!(bus.read_u32(0x2200_0000 + 0x10 * 32 + 3 * 4).unwrap(), 1);
        // GPIOA ODR bit 5 via the peripheral alias
        bus.write(map::GPIOA_BASE, AccessSize::Word, 1 << 10)
            .unwrap();
        let odr5 = 0x4200_0000 + (map::GPIOA_BASE + 0x14 - 0x4000_0000) * 32 + 5 * 4;
        bus.write(odr5, AccessSize::Word, 1).unwrap();
        assert!(bus.gpio[0].level(5));
        assert_eq!(bus.pin_events.last().unwrap().level, Some(true));
    }
}
