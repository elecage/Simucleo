//! Firmware image loading from ELF files produced by arm-none-eabi-gcc
//! (STM32CubeIDE / CubeMX Makefile / CMake projects, or hand-written
//! bare-metal startup code).

use std::collections::BTreeMap;

use object::elf::{EM_ARM, PT_LOAD};
use object::read::elf::{ElfFile32, FileHeader, ProgramHeader};
use object::{Endianness, Object, ObjectSymbol, SymbolKind};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ElfError {
    #[error("not a valid 32-bit little-endian ELF file: {0}")]
    Parse(#[from] object::Error),
    #[error("ELF machine is not ARM (e_machine = {0})")]
    NotArm(u16),
    #[error("program header at index {0} points outside the file")]
    BadSegment(usize),
}

/// A block of bytes to place at a physical (load) address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    /// Load address (LMA). `.data` initialisers live in flash here and are
    /// copied to SRAM by the startup code, exactly like on hardware.
    pub addr: u32,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, Default)]
pub struct FirmwareImage {
    pub entry: u32,
    pub segments: Vec<Segment>,
    /// Function and object symbols by address (Thumb bit cleared), used for
    /// disassembly labels, call stacks and detecting `Error_Handler` entry.
    pub symbols: BTreeMap<u32, String>,
}

impl FirmwareImage {
    pub fn parse(bytes: &[u8]) -> Result<Self, ElfError> {
        let elf = ElfFile32::<Endianness>::parse(bytes)?;
        let endian = elf.endian();
        let machine = elf.elf_header().e_machine(endian);
        if machine != EM_ARM {
            return Err(ElfError::NotArm(machine));
        }

        let mut segments = Vec::new();
        for (i, ph) in elf.elf_program_headers().iter().enumerate() {
            if ph.p_type(endian) != PT_LOAD {
                continue;
            }
            let data = ph
                .data(endian, bytes)
                .map_err(|_| ElfError::BadSegment(i))?;
            if data.is_empty() {
                continue; // .bss-only segment: zeroed by startup code
            }
            segments.push(Segment {
                addr: ph.p_paddr(endian),
                data: data.to_vec(),
            });
        }

        let symbols = elf
            .symbols()
            .filter(|s| matches!(s.kind(), SymbolKind::Text | SymbolKind::Data) && s.address() != 0)
            .filter_map(|s| Some(((s.address() as u32) & !1, s.name().ok()?.to_string())))
            .filter(|(_, name)| !name.is_empty() && !name.starts_with('$'))
            .collect();

        Ok(Self {
            entry: elf.entry() as u32,
            segments,
            symbols,
        })
    }

    /// Look up the symbol by exact name.
    pub fn symbol(&self, name: &str) -> Option<u32> {
        self.symbols
            .iter()
            .find(|(_, n)| n.as_str() == name)
            .map(|(a, _)| *a)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_elf() {
        assert!(matches!(
            FirmwareImage::parse(b"not an elf"),
            Err(ElfError::Parse(_))
        ));
    }
}
