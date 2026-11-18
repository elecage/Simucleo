//! STM32F401RE memory map and peripherals.
//!
//! Status: skeleton. Flash, SRAM and the boot alias are real; every other
//! address is recorded as an *unimplemented access* so the GUI can show
//! students (and developers) which peripheral the firmware is waiting on.

pub mod map;

use simucleo_core::bus::{AccessSize, Bus, BusError, Memory};

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

impl Bus for Stm32f401Bus {
    fn read(&mut self, addr: u32, size: AccessSize) -> Result<u32, BusError> {
        let a = map::resolve_alias(addr);
        if self.flash.contains(a, size) {
            return self.flash.read(a, size);
        }
        if self.sram.contains(a, size) {
            return self.sram.read(a, size);
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

    fn write(&mut self, addr: u32, size: AccessSize, value: u32) -> Result<(), BusError> {
        let a = map::resolve_alias(addr);
        if self.sram.contains(a, size) {
            return self.sram.write(a, size, value);
        }
        if self.flash.contains(a, size) {
            // Flash programming goes through the FLASH interface (later).
            return Err(BusError::ReadOnly(addr));
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
}
