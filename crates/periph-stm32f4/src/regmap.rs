//! Register map lookups and a generic register file for peripherals that
//! have no behavioural model yet.

use std::collections::{BTreeMap, HashMap};

use crate::svd::PERIPHERALS;
use crate::svd_types::{Access, Peripheral, Register};

/// Size of every peripheral block on this part.
const BLOCK: u32 = 0x400;

/// The SVD peripheral whose 1 KiB block contains `addr`.
pub fn peripheral_at(addr: u32) -> Option<&'static Peripheral> {
    PERIPHERALS
        .iter()
        .find(|p| (p.base..p.base + BLOCK).contains(&addr))
}

pub fn peripheral_by_name(name: &str) -> Option<&'static Peripheral> {
    PERIPHERALS.iter().find(|p| p.name == name)
}

/// The register at `addr` (word granularity).
pub fn register_at(addr: u32) -> Option<(&'static Peripheral, &'static Register)> {
    let p = peripheral_at(addr)?;
    let off = (addr - p.base) & !3;
    p.registers
        .iter()
        .find(|r| r.offset as u32 == off)
        .map(|r| (p, r))
}

/// Human-readable name such as `RCC.PLLCFGR`, or the address in hex.
pub fn describe(addr: u32) -> String {
    match register_at(addr) {
        Some((p, r)) => format!("{}.{}", p.name, r.name),
        None => match peripheral_at(addr) {
            Some(p) => format!("{}+{:#05x}", p.name, addr - p.base),
            None => format!("{addr:#010x}"),
        },
    }
}

/// Name of interrupt `irq` from the SVD (e.g. 38 → "USART2").
pub fn interrupt_name(irq: u16) -> Option<&'static str> {
    PERIPHERALS
        .iter()
        .flat_map(|p| p.interrupts.iter())
        .find(|(_, n)| *n == irq)
        .map(|(name, _)| *name)
}

/// One kind of access to a register that has no model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct UnmodelledKey {
    /// Word address.
    pub addr: u32,
    pub write: bool,
}

/// Registers of unmodelled peripherals: values written are kept and read
/// back, unwritten registers read their SVD reset value. Every access is
/// counted so diagnostics can say which peripheral the firmware relies on.
#[derive(Debug, Default, Clone)]
pub struct RegisterFile {
    values: HashMap<u32, u32>,
    pub accesses: BTreeMap<UnmodelledKey, u64>,
}

impl RegisterFile {
    pub fn read(&mut self, addr: u32) -> u32 {
        let word = addr & !3;
        *self
            .accesses
            .entry(UnmodelledKey {
                addr: word,
                write: false,
            })
            .or_default() += 1;
        if let Some(v) = self.values.get(&word) {
            return *v;
        }
        register_at(word)
            .map(|(_, r)| {
                if r.access == Access::WriteOnly {
                    0
                } else {
                    r.reset
                }
            })
            .unwrap_or(0)
    }

    pub fn write(&mut self, addr: u32, value: u32, lanes: u32) {
        let word = addr & !3;
        *self
            .accesses
            .entry(UnmodelledKey {
                addr: word,
                write: true,
            })
            .or_default() += 1;
        let reg = register_at(word);
        if matches!(reg, Some((_, r)) if r.access == Access::ReadOnly) {
            return;
        }
        let old = self
            .values
            .get(&word)
            .copied()
            .or(reg.map(|(_, r)| r.reset))
            .unwrap_or(0);
        self.values.insert(word, (old & !lanes) | (value & lanes));
    }

    pub fn clear(&mut self) {
        self.values.clear();
    }

    /// Return every register of one peripheral block to its reset value.
    pub fn reset_block(&mut self, base: u32) {
        self.values.retain(|a, _| !(base..base + BLOCK).contains(a));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookups() {
        assert_eq!(describe(0x4002_3804), "RCC.PLLCFGR");
        assert_eq!(describe(0x4000_4408), "USART2.BRR");
        assert_eq!(peripheral_at(0x4000_4400).unwrap().name, "USART2");
        assert_eq!(interrupt_name(38), Some("USART2"));
        assert_eq!(register_at(0x4002_3800).unwrap().1.reset, 0x83);
    }

    #[test]
    fn register_file_keeps_values_and_resets() {
        let mut rf = RegisterFile::default();
        let tim3_psc = 0x4000_0428;
        assert_eq!(rf.read(tim3_psc), 0);
        rf.write(tim3_psc, 0x1234, 0xFFFF);
        assert_eq!(rf.read(tim3_psc), 0x1234);
        rf.write(tim3_psc + 1, 0xAB << 8, 0xFF << 8);
        assert_eq!(rf.read(tim3_psc), 0xAB34);
        assert_eq!(rf.accesses.len(), 2);
    }
}
