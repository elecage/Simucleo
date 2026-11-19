//! Firmware image loading from ELF files produced by arm-none-eabi-gcc
//! (STM32CubeIDE / CubeMX Makefile / CMake projects, or hand-written
//! bare-metal startup code).

pub mod debug;
pub mod disasm;
mod expr;

use std::collections::{BTreeMap, HashMap};

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
    /// Every function and object symbol by name: (address, size). Includes
    /// file-local (`static`) objects, which kernel-aware views need.
    pub by_name: HashMap<String, (u32, u32)>,
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

        let by_name = elf
            .symbols()
            .filter(|s| matches!(s.kind(), SymbolKind::Text | SymbolKind::Data) && s.address() != 0)
            .filter_map(|s| {
                let name = s.name().ok()?;
                (!name.is_empty() && !name.starts_with('$')).then(|| {
                    (
                        name.to_string(),
                        ((s.address() as u32) & !1, s.size() as u32),
                    )
                })
            })
            .collect();
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
            by_name,
        })
    }

    /// Look up the symbol by exact name.
    pub fn symbol(&self, name: &str) -> Option<u32> {
        self.by_name.get(name).map(|(a, _)| *a)
    }

    /// Address and size of a symbol.
    pub fn symbol_with_size(&self, name: &str) -> Option<(u32, u32)> {
        self.by_name.get(name).copied()
    }
}

/// Byte offsets of the members of a C `struct` (by its tag name, e.g.
/// `"tskTaskControlBlock"`) from the ELF's DWARF debug information. `None`
/// when the file has no debug information or no complete definition of it.
pub fn struct_layout(bytes: &[u8], tag: &str) -> Option<HashMap<String, u32>> {
    use object::{Object as _, ObjectSection as _};
    let file = object::File::parse(bytes).ok()?;
    let load = |id: gimli::SectionId| -> Result<std::borrow::Cow<'_, [u8]>, gimli::Error> {
        Ok(file
            .section_by_name(id.name())
            .and_then(|s| s.uncompressed_data().ok())
            .unwrap_or(std::borrow::Cow::Borrowed(&[])))
    };
    let owned = gimli::DwarfSections::load(load).ok()?;
    let dwarf = owned.borrow(|s| gimli::EndianSlice::new(s, gimli::LittleEndian));
    let mut units = dwarf.units();
    while let Ok(Some(header)) = units.next() {
        let Ok(unit) = dwarf.unit(header) else {
            continue;
        };
        let mut tree = unit.entries_tree(None).ok()?;
        let root = tree.root().ok()?;
        let mut found = None;
        find_struct(&dwarf, &unit, root, tag, &mut found);
        if found.is_some() {
            return found;
        }
    }
    None
}

type Reader<'a> = gimli::EndianSlice<'a, gimli::LittleEndian>;

fn find_struct(
    dwarf: &gimli::Dwarf<Reader<'_>>,
    unit: &gimli::Unit<Reader<'_>>,
    node: gimli::EntriesTreeNode<'_, '_, '_, Reader<'_>>,
    tag: &str,
    found: &mut Option<HashMap<String, u32>>,
) {
    let name_of = |e: &gimli::DebuggingInformationEntry<'_, '_, Reader<'_>>| -> Option<String> {
        let attr = e.attr_value(gimli::DW_AT_name).ok()??;
        let s = dwarf.attr_string(unit, attr).ok()?;
        Some(s.to_string_lossy().into_owned())
    };
    let entry = node.entry().clone();
    let is_def = entry.tag() == gimli::DW_TAG_structure_type
        && entry
            .attr(gimli::DW_AT_declaration)
            .ok()
            .flatten()
            .is_none()
        && name_of(&entry).as_deref() == Some(tag);
    let mut children = node.children();
    if is_def {
        let mut members = HashMap::new();
        while let Ok(Some(child)) = children.next() {
            let e = child.entry();
            if e.tag() != gimli::DW_TAG_member {
                continue;
            }
            let off = match e
                .attr_value(gimli::DW_AT_data_member_location)
                .ok()
                .flatten()
            {
                Some(gimli::AttributeValue::Udata(v)) => v as u32,
                Some(gimli::AttributeValue::Data1(v)) => v as u32,
                Some(gimli::AttributeValue::Data2(v)) => v as u32,
                Some(gimli::AttributeValue::Data4(v)) => v,
                Some(gimli::AttributeValue::Sdata(v)) => v as u32,
                _ => continue,
            };
            if let Some(n) = name_of(e) {
                members.insert(n, off);
            }
        }
        if !members.is_empty() {
            *found = Some(members);
        }
        return;
    }
    while let Ok(Some(child)) = children.next() {
        find_struct(dwarf, unit, child, tag, found);
        if found.is_some() {
            return;
        }
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
