//! Memory bus abstraction.

use thiserror::Error;

/// Width of a single bus access.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccessSize {
    Byte = 1,
    Half = 2,
    Word = 4,
}

impl AccessSize {
    pub fn bytes(self) -> u32 {
        self as u32
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum BusError {
    #[error("access to unmapped address {0:#010x}")]
    Unmapped(u32),
    #[error("write to read-only address {0:#010x}")]
    ReadOnly(u32),
}

/// Everything the CPU can read from or write to.
///
/// Implementations route accesses to flash, SRAM, the system control space
/// and peripherals. Values are little-endian and zero-extended to `u32`.
pub trait Bus {
    fn read(&mut self, addr: u32, size: AccessSize) -> Result<u32, BusError>;
    fn write(&mut self, addr: u32, size: AccessSize, value: u32) -> Result<(), BusError>;

    fn read_u32(&mut self, addr: u32) -> Result<u32, BusError> {
        self.read(addr, AccessSize::Word)
    }

    /// Tell the bus the current simulated time before an access, so that
    /// peripherals can timestamp pin changes. Default: ignored.
    fn set_time(&mut self, _now: crate::Cycles) {}
}

/// A flat, byte-addressed memory region (flash or SRAM).
#[derive(Debug, Clone)]
pub struct Memory {
    base: u32,
    data: Vec<u8>,
    writable: bool,
}

impl Memory {
    pub fn new(base: u32, size: usize, writable: bool) -> Self {
        Self {
            base,
            data: vec![0; size],
            writable,
        }
    }

    pub fn base(&self) -> u32 {
        self.base
    }

    pub fn len(&self) -> usize {
        self.data.len()
    }

    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }

    pub fn contains(&self, addr: u32, size: AccessSize) -> bool {
        addr >= self.base
            && (addr - self.base) as u64 + size.bytes() as u64 <= self.data.len() as u64
    }

    /// Copy an image into memory, bypassing the write-protection flag
    /// (used by the ELF loader to program flash).
    pub fn load(&mut self, addr: u32, bytes: &[u8]) -> Result<(), BusError> {
        let off = addr
            .checked_sub(self.base)
            .ok_or(BusError::Unmapped(addr))? as usize;
        let end = off
            .checked_add(bytes.len())
            .ok_or(BusError::Unmapped(addr))?;
        if end > self.data.len() {
            return Err(BusError::Unmapped(addr));
        }
        self.data[off..end].copy_from_slice(bytes);
        Ok(())
    }

    pub fn read(&self, addr: u32, size: AccessSize) -> Result<u32, BusError> {
        if !self.contains(addr, size) {
            return Err(BusError::Unmapped(addr));
        }
        let off = (addr - self.base) as usize;
        let mut v = 0u32;
        for i in (0..size.bytes() as usize).rev() {
            v = (v << 8) | self.data[off + i] as u32;
        }
        Ok(v)
    }

    pub fn write(&mut self, addr: u32, size: AccessSize, value: u32) -> Result<(), BusError> {
        if !self.contains(addr, size) {
            return Err(BusError::Unmapped(addr));
        }
        if !self.writable {
            return Err(BusError::ReadOnly(addr));
        }
        let off = (addr - self.base) as usize;
        for i in 0..size.bytes() as usize {
            self.data[off + i] = (value >> (8 * i)) as u8;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn little_endian_roundtrip() {
        let mut m = Memory::new(0x2000_0000, 16, true);
        m.write(0x2000_0004, AccessSize::Word, 0xDEAD_BEEF).unwrap();
        assert_eq!(m.read(0x2000_0004, AccessSize::Byte).unwrap(), 0xEF);
        assert_eq!(m.read(0x2000_0006, AccessSize::Half).unwrap(), 0xDEAD);
        assert_eq!(m.read(0x2000_0004, AccessSize::Word).unwrap(), 0xDEAD_BEEF);
    }

    #[test]
    fn bounds_and_protection() {
        let mut flash = Memory::new(0x0800_0000, 8, false);
        assert_eq!(
            flash.read(0x0800_0006, AccessSize::Word),
            Err(BusError::Unmapped(0x0800_0006))
        );
        assert_eq!(
            flash.write(0x0800_0000, AccessSize::Byte, 1),
            Err(BusError::ReadOnly(0x0800_0000))
        );
        flash.load(0x0800_0000, &[1, 2, 3, 4]).unwrap();
        assert_eq!(
            flash.read(0x0800_0000, AccessSize::Word).unwrap(),
            0x0403_0201
        );
    }
}
