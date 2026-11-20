//! Source-level debug information from DWARF (GCC `-g`, DWARF 4/5):
//! the line table (address ↔ file:line), functions, call-stack unwinding
//! with `.debug_frame` (including Cortex-M exception frames), and the
//! values of global and local variables formatted by their C types.
//!
//! Memory is read through a callback so the same code serves the live
//! simulator and tests.

use std::collections::HashMap;

use gimli::{
    AttributeValue, BaseAddresses, CfaRule, DebugFrame, EndianSlice, Evaluation, EvaluationResult,
    LittleEndian, Location, Piece, RegisterRule, UnitOffset, UnwindContext, UnwindSection,
};
use object::{Object as _, ObjectSection as _};
use serde::Serialize;

type R<'a> = EndianSlice<'a, LittleEndian>;
type Dwarf<'a> = gimli::Dwarf<R<'a>>;
type Unit<'a> = gimli::Unit<R<'a>>;

/// Reads `len` bytes of target memory at an address.
pub type ReadMem<'a> = &'a dyn Fn(u32, usize) -> Option<Vec<u8>>;

/// One row of the line table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LineRow {
    pub addr: u32,
    /// Index into [`DebugInfo::files`].
    pub file: u32,
    pub line: u32,
    pub is_stmt: bool,
    /// The address after the last instruction of a sequence.
    pub end: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Function {
    pub name: String,
    pub low: u32,
    pub high: u32,
    #[serde(skip)]
    unit: gimli::DebugInfoOffset<usize>,
    #[serde(skip)]
    die: UnitOffset<usize>,
}

#[derive(Debug, Clone)]
struct Global {
    name: String,
    addr: u32,
    file: Option<u32>,
    unit: gimli::DebugInfoOffset<usize>,
    ty: Option<UnitOffset<usize>>,
}

/// A frame of the call stack.
#[derive(Debug, Clone, Serialize)]
pub struct Frame {
    pub pc: u32,
    /// Function name, if known.
    pub function: Option<String>,
    pub file: Option<u32>,
    pub line: Option<u32>,
    /// Canonical frame address (the caller's SP).
    pub cfa: Option<u32>,
    /// r0–r15 as far as they can be recovered in this frame.
    #[serde(skip)]
    pub regs: [Option<u32>; 16],
    /// The frame was entered through an exception (an interrupt handler).
    pub exception: bool,
}

/// A variable's value, formatted for display.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Value {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: String,
    pub value: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub addr: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<u32>,
}

/// Where a value's bytes are.
#[derive(Clone)]
pub(crate) enum Src {
    Addr(u32),
    Bytes(Vec<u8>),
    /// All of one register: its DWARF number (so it can be written) and
    /// value.
    Reg(u16, u32),
}

/// What setting a variable changes in the target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Write {
    /// Bytes at an address (little-endian).
    Memory { addr: u32, bytes: Vec<u8> },
    /// A register by DWARF number (r0–r15 are 0–15, s0–s31 are 64–95) in
    /// the frame the value lives in.
    Register { reg: u16, value: u32 },
}

/// A struct member: its byte offset, its type, and for a bit field its
/// first bit (from the start of the struct) and width.
pub(crate) type Member = (u32, Option<UnitOffset<usize>>, Option<(u32, u32)>);

pub struct DebugInfo {
    sections: gimli::DwarfSections<Vec<u8>>,
    debug_frame: Vec<u8>,
    /// Source files as the compiler recorded them (directory joined).
    pub files: Vec<String>,
    /// Sorted by address.
    pub rows: Vec<LineRow>,
    /// Sorted by low address.
    pub functions: Vec<Function>,
    globals: Vec<Global>,
}

fn attr_u64(v: AttributeValue<R<'_>>) -> Option<u64> {
    match v {
        AttributeValue::Addr(a) => Some(a),
        AttributeValue::Udata(v) => Some(v),
        AttributeValue::Data1(v) => Some(v as u64),
        AttributeValue::Data2(v) => Some(v as u64),
        AttributeValue::Data4(v) => Some(v as u64),
        AttributeValue::Data8(v) => Some(v),
        AttributeValue::Sdata(v) => Some(v as u64),
        AttributeValue::FileIndex(v) => Some(v),
        _ => None,
    }
}

fn name_of(
    dwarf: &Dwarf<'_>,
    unit: &Unit<'_>,
    e: &gimli::DebuggingInformationEntry<'_, '_, R<'_>>,
) -> Option<String> {
    let v = e.attr_value(gimli::DW_AT_name).ok()??;
    Some(
        dwarf
            .attr_string(unit, v)
            .ok()?
            .to_string_lossy()
            .into_owned(),
    )
}

fn type_of(e: &gimli::DebuggingInformationEntry<'_, '_, R<'_>>) -> Option<UnitOffset<usize>> {
    match e.attr_value(gimli::DW_AT_type).ok()?? {
        AttributeValue::UnitRef(o) => Some(o),
        _ => None,
    }
}

/// Does the DIE's code range (low/high pc or ranges) contain `pc`?
fn die_contains(
    dwarf: &Dwarf<'_>,
    unit: &Unit<'_>,
    e: &gimli::DebuggingInformationEntry<'_, '_, R<'_>>,
    pc: u64,
) -> Option<bool> {
    let mut ranges = dwarf.die_ranges(unit, e).ok()?;
    let mut any = false;
    while let Ok(Some(r)) = ranges.next() {
        any = true;
        if (r.begin..r.end).contains(&pc) {
            return Some(true);
        }
    }
    any.then_some(false)
}

impl DebugInfo {
    /// Read the debug information of an ELF file; `None` without DWARF.
    pub fn load(bytes: &[u8]) -> Option<Self> {
        let file = object::File::parse(bytes).ok()?;
        let section = |name: &str| -> Vec<u8> {
            file.section_by_name(name)
                .and_then(|s| s.uncompressed_data().ok())
                .map(|d| d.into_owned())
                .unwrap_or_default()
        };
        let sections = gimli::DwarfSections::load(|id| -> Result<Vec<u8>, gimli::Error> {
            Ok(section(id.name()))
        })
        .ok()?;
        let debug_frame = section(".debug_frame");
        let mut info = DebugInfo {
            sections,
            debug_frame,
            files: Vec::new(),
            rows: Vec::new(),
            functions: Vec::new(),
            globals: Vec::new(),
        };
        info.index();
        (!info.rows.is_empty() || !info.functions.is_empty()).then_some(info)
    }

    fn dwarf(&self) -> Dwarf<'_> {
        self.sections.borrow(|s| EndianSlice::new(s, LittleEndian))
    }

    fn index(&mut self) {
        let dwarf = self.sections.borrow(|s| EndianSlice::new(s, LittleEndian));
        let mut file_ids: HashMap<String, u32> = HashMap::new();
        let mut rows = Vec::new();
        let mut functions = Vec::new();
        let mut globals = Vec::new();
        let mut units = dwarf.units();
        while let Ok(Some(header)) = units.next() {
            let Some(unit_off) = header.offset().as_debug_info_offset() else {
                continue;
            };
            let Ok(unit) = dwarf.unit(header) else {
                continue;
            };
            // Line table, with this unit's file numbers mapped to ours.
            // This unit's file numbers mapped to ours (DWARF 5 counts from
            // 0, earlier versions from 1).
            let mut unit_files: HashMap<u64, u32> = HashMap::new();
            if let Some(program) = unit.line_program.clone() {
                let header = program.header().clone();
                let count = header.file_names().len() as u64;
                for index in 0..=count {
                    let Some(fe) = header.file(index) else {
                        continue;
                    };
                    let Ok(name) = dwarf.attr_string(&unit, fe.path_name()) else {
                        continue;
                    };
                    let name = name.to_string_lossy().into_owned();
                    let dir = fe
                        .directory(&header)
                        .and_then(|d| dwarf.attr_string(&unit, d).ok())
                        .map(|d| d.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    let comp_dir = unit.comp_dir.map(|d| d.to_string_lossy().into_owned());
                    let path = source_path(comp_dir.as_deref(), &dir, &name);
                    let n = file_ids.len() as u32;
                    let id = *file_ids.entry(path).or_insert(n);
                    unit_files.insert(index, id);
                }
                let mut lines = program.rows();
                while let Ok(Some((_, row))) = lines.next_row() {
                    let Some(&file) = unit_files.get(&row.file_index()) else {
                        continue;
                    };
                    rows.push(LineRow {
                        addr: row.address() as u32,
                        file,
                        line: row.line().map_or(0, |l| l.get() as u32),
                        is_stmt: row.is_stmt(),
                        end: row.end_sequence(),
                    });
                }
            }
            // Functions and global variables.
            let mut entries = unit.entries();
            let mut depth = 0isize;
            while let Ok(Some((delta, e))) = entries.next_dfs() {
                depth += delta;
                match e.tag() {
                    gimli::DW_TAG_subprogram => {
                        let Some(name) = name_of(&dwarf, &unit, e).or_else(|| {
                            // Concrete out-of-line instance: name from the origin.
                            match e.attr_value(gimli::DW_AT_abstract_origin).ok()?? {
                                AttributeValue::UnitRef(o) => {
                                    let origin = unit.entry(o).ok()?;
                                    name_of(&dwarf, &unit, &origin)
                                }
                                _ => None,
                            }
                        }) else {
                            continue;
                        };
                        let low = e.attr_value(gimli::DW_AT_low_pc).ok().flatten();
                        let low = match low {
                            Some(AttributeValue::Addr(a)) => a,
                            Some(AttributeValue::DebugAddrIndex(i)) => {
                                dwarf.address(&unit, i).unwrap_or(0)
                            }
                            _ => continue,
                        };
                        let high = match e.attr_value(gimli::DW_AT_high_pc).ok().flatten() {
                            Some(AttributeValue::Addr(a)) => a,
                            Some(v) => attr_u64(v).map_or(low, |n| low + n),
                            None => low,
                        };
                        functions.push(Function {
                            name,
                            low: low as u32 & !1,
                            high: high as u32 & !1,
                            unit: unit_off,
                            die: e.offset(),
                        });
                    }
                    gimli::DW_TAG_variable if depth == 1 => {
                        // A file-scope variable with a fixed address.
                        let Some(name) = name_of(&dwarf, &unit, e) else {
                            continue;
                        };
                        let Some(AttributeValue::Exprloc(expr)) =
                            e.attr_value(gimli::DW_AT_location).ok().flatten()
                        else {
                            continue;
                        };
                        let mut ops = expr.operations(unit.encoding());
                        let Ok(Some(gimli::Operation::Address { address })) = ops.next() else {
                            continue;
                        };
                        let ty = type_of(e).or_else(|| {
                            // A definition of an earlier declaration.
                            match e.attr_value(gimli::DW_AT_specification).ok()?? {
                                AttributeValue::UnitRef(o) => type_of(&unit.entry(o).ok()?),
                                _ => None,
                            }
                        });
                        let file = match e
                            .attr_value(gimli::DW_AT_decl_file)
                            .ok()
                            .flatten()
                            .and_then(attr_u64)
                        {
                            Some(i) => unit_files.get(&i).copied(),
                            None => None,
                        };
                        globals.push(Global {
                            name,
                            addr: address as u32,
                            file,
                            unit: unit_off,
                            ty,
                        });
                    }
                    _ => {}
                }
            }
        }
        rows.sort_by_key(|r| (r.addr, !r.end));
        functions.sort_by_key(|f| f.low);
        functions.dedup_by_key(|f| f.low);
        let mut files = vec![String::new(); file_ids.len()];
        for (p, i) in file_ids {
            files[i as usize] = p;
        }
        self.files = files;
        self.rows = rows;
        self.functions = functions;
        self.globals = globals;
    }

    /// Source file and line of an address.
    pub fn location(&self, pc: u32) -> Option<(u32, u32)> {
        let i = self.rows.partition_point(|r| r.addr <= pc);
        let r = self.rows.get(i.checked_sub(1)?)?;
        (!r.end && r.line > 0).then_some((r.file, r.line))
    }

    /// Does a statement (the start of a source line's code) begin at `pc`?
    pub fn is_statement(&self, pc: u32) -> bool {
        let i = self.rows.partition_point(|r| r.addr < pc);
        self.rows[i..]
            .iter()
            .take_while(|r| r.addr == pc)
            .any(|r| r.is_stmt && !r.end && r.line > 0)
    }

    /// Function containing an address.
    pub fn function_at(&self, pc: u32) -> Option<&Function> {
        let i = self.functions.partition_point(|f| f.low <= pc);
        let f = self.functions.get(i.checked_sub(1)?)?;
        (pc < f.high).then_some(f)
    }

    /// Where to stop for a breakpoint on `file:line`: the first statement
    /// address of the line in each function. When the line has no code,
    /// the next line that has some (within 20 lines) is used; the line
    /// actually chosen is returned too.
    pub fn breakpoint_addresses(&self, file: u32, line: u32) -> Option<(u32, Vec<u32>)> {
        for l in line..line + 20 {
            let mut by_function: HashMap<u32, u32> = HashMap::new();
            for r in self
                .rows
                .iter()
                .filter(|r| r.file == file && r.line == l && r.is_stmt && !r.end)
            {
                let key = self.function_at(r.addr).map_or(r.addr, |f| f.low);
                let e = by_function.entry(key).or_insert(r.addr);
                *e = (*e).min(r.addr);
            }
            if !by_function.is_empty() {
                let mut v: Vec<u32> = by_function.into_values().collect();
                v.sort_unstable();
                return Some((l, v));
            }
        }
        None
    }

    /// Lines of a file that have code (for the editor's gutter).
    pub fn lines_with_code(&self, file: u32) -> Vec<u32> {
        let mut v: Vec<u32> = self
            .rows
            .iter()
            .filter(|r| r.file == file && r.is_stmt && !r.end && r.line > 0)
            .map(|r| r.line)
            .collect();
        v.sort_unstable();
        v.dedup();
        v
    }

    /// The call stack, innermost first. `regs` are r0–r15 of the current
    /// context; `msp`/`psp` let exception frames be found on either stack.
    pub fn unwind(&self, regs: [u32; 16], msp: u32, psp: u32, read: ReadMem<'_>) -> Vec<Frame> {
        let word = |a: u32| read(a, 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
        let mut frames = Vec::new();
        let mut cur: [Option<u32>; 16] = regs.map(Some);
        let mut exception = false;
        let mut ctx = UnwindContext::new();
        let mut df = DebugFrame::new(&self.debug_frame, LittleEndian);
        df.set_address_size(4);
        let bases = BaseAddresses::default();
        for _ in 0..32 {
            let Some(pc) = cur[15] else {
                break;
            };
            let pc = pc & !1;
            if pc == 0 {
                break;
            }
            // Return addresses point after the call: look up pc − 2.
            let lookup = if frames.is_empty() || exception {
                pc
            } else {
                pc.wrapping_sub(2)
            };
            let loc = self.location(lookup);
            let mut frame = Frame {
                pc,
                function: self.function_at(lookup).map(|f| f.name.clone()),
                file: loc.map(|l| l.0),
                line: loc.map(|l| l.1),
                cfa: None,
                regs: cur,
                exception,
            };
            exception = false;
            let Ok(row) = df.unwind_info_for_address(
                &bases,
                &mut ctx,
                lookup as u64,
                DebugFrame::cie_from_offset,
            ) else {
                frames.push(frame);
                break;
            };
            let cfa = match *row.cfa() {
                CfaRule::RegisterAndOffset { register, offset } => {
                    cur[register.0 as usize].map(|r| (r as i64 + offset) as u32)
                }
                _ => None,
            };
            let Some(cfa) = cfa else {
                frames.push(frame);
                break;
            };
            frame.cfa = Some(cfa);
            let mut next: [Option<u32>; 16] = cur;
            for r in 0..16u16 {
                match row.register(gimli::Register(r)) {
                    RegisterRule::Offset(o) => next[r as usize] = word((cfa as i64 + o) as u32),
                    RegisterRule::Undefined if r < 4 || r == 12 => next[r as usize] = None,
                    _ => {}
                }
            }
            next[13] = Some(cfa);
            let lr = next[14];
            frames.push(frame);
            let Some(lr) = lr else {
                break;
            };
            if lr >= 0xFFFF_FFE0 {
                // Exception return: the interrupted context is stacked on
                // the main or process stack.
                let sp = if lr & 4 != 0 {
                    psp
                } else {
                    cfa.max(msp.min(cfa))
                };
                let stacked: Vec<Option<u32>> = (0..8).map(|i| word(sp + 4 * i)).collect();
                let mut ctx_regs: [Option<u32>; 16] = [None; 16];
                for (i, r) in [0usize, 1, 2, 3, 12, 14, 15].iter().enumerate() {
                    ctx_regs[*r] = stacked[if i < 6 { i } else { 6 }];
                }
                let xpsr = stacked[7].unwrap_or(0);
                let size = if lr & 0x10 == 0 { 0x68 } else { 0x20 }
                    + if xpsr & (1 << 9) != 0 { 4 } else { 0 };
                ctx_regs[13] = Some(sp + size);
                ctx_regs[4..12].copy_from_slice(&next[4..12]);
                cur = ctx_regs;
                exception = true;
                continue;
            }
            if Some(lr & !1) == cur[15].map(|p| p & !1) && Some(cfa) == cur[13] {
                break; // no progress
            }
            next[15] = Some(lr);
            cur = next;
        }
        frames
    }

    /// Global (file-scope) variables with their current values. `files`
    /// limits them to the given source files (none: all).
    pub fn globals(&self, files: &[u32], read: ReadMem<'_>) -> Vec<Value> {
        let dwarf = self.dwarf();
        let mut out = Vec::new();
        let mut units: HashMap<gimli::DebugInfoOffset<usize>, Unit<'_>> = HashMap::new();
        for g in &self.globals {
            if !files.is_empty() && !g.file.is_some_and(|f| files.contains(&f)) {
                continue;
            }
            if let std::collections::hash_map::Entry::Vacant(slot) = units.entry(g.unit) {
                let Ok(header) = dwarf.debug_info.header_from_offset(g.unit) else {
                    continue;
                };
                let Ok(unit) = dwarf.unit(header) else {
                    continue;
                };
                slot.insert(unit);
            }
            let unit = &units[&g.unit];
            let mut v = self.render(&dwarf, unit, g.ty, Src::Addr(g.addr), read, 0);
            v.name = g.name.clone();
            v.addr = Some(g.addr);
            v.file = g.file;
            out.push(v);
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out.dedup_by(|a, b| a.name == b.name && a.addr == b.addr);
        out
    }

    /// Evaluate a C expression over the frame's variables (watch).
    pub fn evaluate(&self, expr: &str, frame: &Frame, read: ReadMem<'_>) -> Result<Value, String> {
        crate::expr::Evaluator::new(self, self.dwarf(), frame, read).value(expr)
    }

    /// Where `target` (an expression naming an object) is in memory: its
    /// address and size in bytes.
    pub fn address_of(
        &self,
        target: &str,
        frame: &Frame,
        read: ReadMem<'_>,
    ) -> Result<(u32, u32), String> {
        crate::expr::Evaluator::new(self, self.dwarf(), frame, read).address(target)
    }

    /// What setting `target` (an expression naming a number, enum or
    /// pointer: a variable, member, element or dereference) to the value
    /// of `value` writes.
    pub fn assignment(
        &self,
        target: &str,
        value: &str,
        frame: &Frame,
        read: ReadMem<'_>,
    ) -> Result<Write, String> {
        crate::expr::Evaluator::new(self, self.dwarf(), frame, read).assign(target, value)
    }

    /// Evaluate a breakpoint condition: true when non-zero.
    pub fn condition(&self, expr: &str, frame: &Frame, read: ReadMem<'_>) -> Result<bool, String> {
        crate::expr::Evaluator::new(self, self.dwarf(), frame, read).truth(expr)
    }

    /// A local variable or parameter of the frame by name (innermost
    /// scope first): its unit, type and location.
    #[allow(clippy::type_complexity)]
    pub(crate) fn find_local(
        &self,
        dwarf: &Dwarf<'_>,
        frame: &Frame,
        name: &str,
        read: ReadMem<'_>,
    ) -> Option<(
        gimli::DebugInfoOffset<usize>,
        Option<UnitOffset<usize>>,
        Result<Src, &'static str>,
    )> {
        let pc = frame.pc;
        let f = self
            .function_at(pc)
            .or_else(|| self.function_at(pc.wrapping_sub(2)))?;
        let header = dwarf.debug_info.header_from_offset(f.unit).ok()?;
        let unit = dwarf.unit(header).ok()?;
        // Walk the function's scopes, keeping the innermost match.
        let mut found = None;
        let mut entries = unit.entries_at_offset(f.die).ok()?;
        let mut depth = 0isize;
        let mut skip_below: Option<isize> = None;
        let mut first = true;
        while let Ok(Some((delta, e))) = entries.next_dfs() {
            depth += delta;
            // Past the function's own entries.
            if !first && depth <= 0 {
                break;
            }
            first = false;
            if let Some(d) = skip_below {
                if depth > d {
                    continue;
                }
                skip_below = None;
            }
            match e.tag() {
                gimli::DW_TAG_lexical_block
                    if die_contains(dwarf, &unit, e, pc as u64) == Some(false) =>
                {
                    skip_below = Some(depth)
                }
                gimli::DW_TAG_subprogram | gimli::DW_TAG_inlined_subroutine if depth > 0 => {
                    skip_below = Some(depth)
                }
                gimli::DW_TAG_formal_parameter | gimli::DW_TAG_variable
                    if name_of(dwarf, &unit, e).as_deref() == Some(name) =>
                {
                    let e = e.clone();
                    if let Some(src) = self.locate(dwarf, &unit, &e, frame, pc, read) {
                        found = Some((f.unit, type_of(&e), src));
                    }
                }
                _ => {}
            }
        }
        found
    }

    /// A global variable by name: its unit, type and address.
    pub(crate) fn find_global(
        &self,
        name: &str,
    ) -> Option<(
        gimli::DebugInfoOffset<usize>,
        Option<UnitOffset<usize>>,
        u32,
    )> {
        self.globals
            .iter()
            .find(|g| g.name == name)
            .map(|g| (g.unit, g.ty, g.addr))
    }

    /// The value of an enumeration constant by name.
    pub(crate) fn find_enumerator(&self, dwarf: &Dwarf<'_>, name: &str) -> Option<i64> {
        let mut units = dwarf.units();
        while let Ok(Some(header)) = units.next() {
            let Ok(unit) = dwarf.unit(header) else {
                continue;
            };
            let mut entries = unit.entries();
            while let Ok(Some((_, e))) = entries.next_dfs() {
                if e.tag() == gimli::DW_TAG_enumerator
                    && name_of(dwarf, &unit, e).as_deref() == Some(name)
                {
                    return match e.attr_value(gimli::DW_AT_const_value).ok().flatten() {
                        Some(AttributeValue::Sdata(v)) => Some(v),
                        Some(v) => attr_u64(v).map(|u| u as i64),
                        None => None,
                    };
                }
            }
        }
        None
    }

    pub(crate) fn size_of(&self, unit: &Unit<'_>, ty: Option<UnitOffset<usize>>) -> Option<u32> {
        self.byte_size(unit, ty)
    }

    pub(crate) fn dims_of(&self, unit: &Unit<'_>, off: UnitOffset<usize>) -> Vec<u32> {
        self.array_dims(unit, off)
    }

    /// Offset and type of a struct member by name.
    pub(crate) fn member_of(
        &self,
        dwarf: &Dwarf<'_>,
        unit: &Unit<'_>,
        off: UnitOffset<usize>,
        name: &str,
    ) -> Option<Member> {
        let mut tree = unit.entries_tree(Some(off)).ok()?;
        let root = tree.root().ok()?;
        let mut ch = root.children();
        while let Ok(Some(c)) = ch.next() {
            let e = c.entry();
            if e.tag() == gimli::DW_TAG_member && name_of(dwarf, unit, e).as_deref() == Some(name) {
                let moff = e
                    .attr_value(gimli::DW_AT_data_member_location)
                    .ok()
                    .flatten()
                    .and_then(attr_u64)
                    .unwrap_or(0) as u32;
                // A bit field: its first bit from the start of the struct.
                let bits = e
                    .attr_value(gimli::DW_AT_bit_size)
                    .ok()
                    .flatten()
                    .and_then(attr_u64)
                    .map(|width| (self.bit_start(unit, e, moff, width) as u32, width as u32));
                return Some((moff, type_of(e), bits));
            }
        }
        None
    }

    /// First bit of bit-field member `e` (`width` bits, byte offset
    /// `moff`), counted from the start of the struct: DWARF 5's
    /// `DW_AT_data_bit_offset`, or DWARF 4's `DW_AT_bit_offset` (from the
    /// most significant bit of the storage unit).
    fn bit_start(
        &self,
        unit: &Unit<'_>,
        e: &gimli::DebuggingInformationEntry<'_, '_, R<'_>>,
        moff: u32,
        width: u64,
    ) -> u64 {
        let attr = |a| e.attr_value(a).ok().flatten().and_then(attr_u64);
        if let Some(start) = attr(gimli::DW_AT_data_bit_offset) {
            return start;
        }
        match attr(gimli::DW_AT_bit_offset) {
            Some(from_msb) => {
                let unit_bytes = attr(gimli::DW_AT_byte_size)
                    .or_else(|| self.byte_size(unit, type_of(e)).map(u64::from))
                    .unwrap_or(4);
                legacy_bit_start(moff, unit_bytes, from_msb, width)
            }
            None => moff as u64 * 8,
        }
    }

    pub(crate) fn render_value(
        &self,
        dwarf: &Dwarf<'_>,
        unit: &Unit<'_>,
        ty: Option<UnitOffset<usize>>,
        src: Src,
        read: ReadMem<'_>,
    ) -> Value {
        self.render(dwarf, unit, ty, src, read, 0)
    }

    /// The rest of an array after `skip` dimensions were indexed.
    pub(crate) fn render_array_tail(
        &self,
        dwarf: &Dwarf<'_>,
        unit: &Unit<'_>,
        ty: Option<UnitOffset<usize>>,
        skip: usize,
        src: Src,
        read: ReadMem<'_>,
    ) -> Value {
        let Some(off) = ty else {
            return Value::default();
        };
        let dims = self.array_dims(unit, off);
        let elem = unit.entry(off).ok().and_then(|e| type_of(&e));
        let mut v = self.render_array(
            dwarf,
            unit,
            elem,
            &dims[skip.min(dims.len())..],
            src,
            read,
            0,
        );
        v.ty = format!(
            "{}{}",
            self.type_name(dwarf, unit, elem),
            dims[skip.min(dims.len())..]
                .iter()
                .map(|n| format!("[{n}]"))
                .collect::<String>()
        );
        v
    }

    /// Parameters and local variables of a frame that are in scope at its pc.
    pub fn locals(&self, frame: &Frame, read: ReadMem<'_>) -> Vec<Value> {
        let lookup = if frame.regs[15].is_some() {
            frame.pc
        } else {
            return Vec::new();
        };
        let Some(f) = self
            .function_at(lookup)
            .or_else(|| self.function_at(lookup.wrapping_sub(2)))
        else {
            return Vec::new();
        };
        let dwarf = self.dwarf();
        let Ok(header) = dwarf.debug_info.header_from_offset(f.unit) else {
            return Vec::new();
        };
        let Ok(unit) = dwarf.unit(header) else {
            return Vec::new();
        };
        let Ok(mut tree) = unit.entries_tree(Some(f.die)) else {
            return Vec::new();
        };
        let Ok(root) = tree.root() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        self.collect_locals(&dwarf, &unit, root, frame, lookup, read, &mut out);
        out
    }

    #[allow(clippy::too_many_arguments)]
    fn collect_locals(
        &self,
        dwarf: &Dwarf<'_>,
        unit: &Unit<'_>,
        node: gimli::EntriesTreeNode<'_, '_, '_, R<'_>>,
        frame: &Frame,
        pc: u32,
        read: ReadMem<'_>,
        out: &mut Vec<Value>,
    ) {
        let mut children = node.children();
        while let Ok(Some(child)) = children.next() {
            let e = child.entry().clone();
            match e.tag() {
                gimli::DW_TAG_formal_parameter | gimli::DW_TAG_variable => {
                    let Some(name) = name_of(dwarf, unit, &e) else {
                        continue;
                    };
                    let ty = type_of(&e);
                    let src = self.locate(dwarf, unit, &e, frame, pc, read);
                    let mut v = match src {
                        Some(Ok(src)) => self.render(dwarf, unit, ty, src, read, 0),
                        Some(Err(why)) => Value {
                            ty: self.type_name(dwarf, unit, ty),
                            value: why.to_string(),
                            ..Default::default()
                        },
                        None => continue,
                    };
                    v.name = name;
                    out.push(v);
                }
                gimli::DW_TAG_lexical_block
                    if die_contains(dwarf, unit, &e, pc as u64) != Some(false) =>
                {
                    self.collect_locals(dwarf, unit, child, frame, pc, read, out);
                }
                _ => {}
            }
        }
    }

    /// Where a variable is at `pc`: `None` without a location attribute,
    /// `Err` when it cannot be shown (optimised out).
    fn locate(
        &self,
        dwarf: &Dwarf<'_>,
        unit: &Unit<'_>,
        e: &gimli::DebuggingInformationEntry<'_, '_, R<'_>>,
        frame: &Frame,
        pc: u32,
        read: ReadMem<'_>,
    ) -> Option<Result<Src, &'static str>> {
        let attr = e.attr_value(gimli::DW_AT_location).ok()??;
        let expr = match attr {
            AttributeValue::Exprloc(expr) => expr,
            AttributeValue::LocationListsRef(_)
            | AttributeValue::DebugLocListsIndex(_)
            | AttributeValue::SecOffset(_) => {
                let offset = match dwarf.attr_locations_offset(unit, attr) {
                    Ok(Some(o)) => o,
                    _ => return Some(Err("<optimized out>")),
                };
                let Ok(mut iter) = dwarf.locations(unit, offset) else {
                    return Some(Err("<optimized out>"));
                };
                let mut found = None;
                while let Ok(Some(entry)) = iter.next() {
                    if (entry.range.begin..entry.range.end).contains(&(pc as u64)) {
                        found = Some(entry.data);
                        break;
                    }
                }
                match found {
                    Some(d) => d,
                    None => return Some(Err("<optimized out>")),
                }
            }
            _ => return Some(Err("<unsupported location>")),
        };
        let word = |a: u32| read(a, 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
        let mut eval: Evaluation<R<'_>> = expr.evaluation(unit.encoding());
        let mut result = eval.evaluate();
        for _ in 0..64 {
            match result {
                Ok(EvaluationResult::Complete) => break,
                Ok(EvaluationResult::RequiresRegister { register, .. }) => {
                    let v = frame.regs.get(register.0 as usize).copied().flatten();
                    let Some(v) = v else {
                        return Some(Err("<optimized out>"));
                    };
                    result = eval.resume_with_register(gimli::Value::Generic(v as u64));
                }
                Ok(EvaluationResult::RequiresFrameBase)
                | Ok(EvaluationResult::RequiresCallFrameCfa) => {
                    let Some(cfa) = frame.cfa else {
                        return Some(Err("<optimized out>"));
                    };
                    result = if matches!(result, Ok(EvaluationResult::RequiresFrameBase)) {
                        eval.resume_with_frame_base(cfa as u64)
                    } else {
                        eval.resume_with_call_frame_cfa(cfa as u64)
                    };
                }
                Ok(EvaluationResult::RequiresMemory { address, size, .. }) => {
                    let Some(v) = (if size == 4 {
                        word(address as u32)
                    } else {
                        read(address as u32, size as usize)
                            .map(|b| b.iter().rev().fold(0u32, |a, &x| a << 8 | x as u32))
                    }) else {
                        return Some(Err("<unreadable>"));
                    };
                    result = eval.resume_with_memory(gimli::Value::Generic(v as u64));
                }
                Ok(EvaluationResult::RequiresRelocatedAddress(a)) => {
                    result = eval.resume_with_relocated_address(a)
                }
                Ok(EvaluationResult::RequiresEntryValue(_)) | Ok(_) => {
                    return Some(Err("<optimized out>"))
                }
                Err(_) => return Some(Err("<unsupported location>")),
            }
        }
        let pieces: Vec<Piece<R<'_>>> = eval.result();
        let mut bytes = Vec::new();
        for p in &pieces {
            let size = p.size_in_bits.map_or(4, |b| (b as usize).div_ceil(8));
            match &p.location {
                Location::Address { address } if pieces.len() == 1 => {
                    return Some(Ok(Src::Addr(*address as u32)))
                }
                Location::Address { address } => {
                    bytes.extend(read(*address as u32, size).unwrap_or_default())
                }
                Location::Register { register } => {
                    let v = frame.regs.get(register.0 as usize).copied().flatten();
                    let Some(v) = v else {
                        return Some(Err("<optimized out>"));
                    };
                    if pieces.len() == 1 {
                        return Some(Ok(Src::Reg(register.0, v)));
                    }
                    bytes.extend(&v.to_le_bytes()[..size.min(4)]);
                }
                Location::Value { value } => {
                    let v = match *value {
                        gimli::Value::Generic(v) | gimli::Value::U64(v) => v,
                        gimli::Value::U32(v) => v as u64,
                        gimli::Value::I32(v) => v as u32 as u64,
                        gimli::Value::F32(f) => f.to_bits() as u64,
                        _ => 0,
                    };
                    bytes.extend(&v.to_le_bytes()[..size.min(8)]);
                }
                Location::Empty => return Some(Err("<optimized out>")),
                _ => return Some(Err("<unsupported location>")),
            }
        }
        Some(Ok(Src::Bytes(bytes)))
    }

    /// The C spelling of a type.
    fn type_name(
        &self,
        dwarf: &Dwarf<'_>,
        unit: &Unit<'_>,
        ty: Option<UnitOffset<usize>>,
    ) -> String {
        let Some(off) = ty else {
            return "void".into();
        };
        let Ok(e) = unit.entry(off) else {
            return "?".into();
        };
        let named = name_of(dwarf, unit, &e);
        match e.tag() {
            gimli::DW_TAG_base_type | gimli::DW_TAG_typedef => named.unwrap_or_else(|| "?".into()),
            gimli::DW_TAG_structure_type => format!("struct {}", named.unwrap_or_default())
                .trim_end()
                .to_string(),
            gimli::DW_TAG_union_type => format!("union {}", named.unwrap_or_default())
                .trim_end()
                .to_string(),
            gimli::DW_TAG_enumeration_type => format!("enum {}", named.unwrap_or_default())
                .trim_end()
                .to_string(),
            gimli::DW_TAG_pointer_type => format!("{} *", self.type_name(dwarf, unit, type_of(&e))),
            gimli::DW_TAG_const_type => {
                let inner = self.type_name(dwarf, unit, type_of(&e));
                if inner.starts_with("const ") {
                    inner
                } else {
                    format!("const {inner}")
                }
            }
            gimli::DW_TAG_volatile_type => {
                let inner = self.type_name(dwarf, unit, type_of(&e));
                if inner.starts_with("volatile ") {
                    inner
                } else {
                    format!("volatile {inner}")
                }
            }
            gimli::DW_TAG_array_type => {
                let dims: String = self
                    .array_dims(unit, off)
                    .iter()
                    .map(|n| format!("[{n}]"))
                    .collect();
                format!("{}{dims}", self.type_name(dwarf, unit, type_of(&e)))
            }
            gimli::DW_TAG_subroutine_type => "function".into(),
            _ => named.unwrap_or_else(|| "?".into()),
        }
    }

    fn byte_size(&self, unit: &Unit<'_>, ty: Option<UnitOffset<usize>>) -> Option<u32> {
        let e = unit.entry(ty?).ok()?;
        if let Some(v) = e
            .attr_value(gimli::DW_AT_byte_size)
            .ok()
            .flatten()
            .and_then(attr_u64)
        {
            return Some(v as u32);
        }
        match e.tag() {
            gimli::DW_TAG_pointer_type => Some(4),
            gimli::DW_TAG_typedef | gimli::DW_TAG_const_type | gimli::DW_TAG_volatile_type => {
                self.byte_size(unit, type_of(&e))
            }
            gimli::DW_TAG_array_type => Some(
                self.array_dims(unit, e.offset()).iter().product::<u32>()
                    * self.byte_size(unit, type_of(&e))?,
            ),
            _ => None,
        }
    }

    /// Element counts of each dimension (`int a[2][3]` → [2, 3]).
    fn array_dims(&self, unit: &Unit<'_>, off: UnitOffset<usize>) -> Vec<u32> {
        let mut dims = Vec::new();
        let Ok(mut tree) = unit.entries_tree(Some(off)) else {
            return dims;
        };
        let Ok(root) = tree.root() else {
            return dims;
        };
        let mut children = root.children();
        while let Ok(Some(c)) = children.next() {
            let e = c.entry();
            if e.tag() == gimli::DW_TAG_subrange_type {
                let n = if let Some(n) = e
                    .attr_value(gimli::DW_AT_count)
                    .ok()
                    .flatten()
                    .and_then(attr_u64)
                {
                    n as u32
                } else if let Some(n) = e
                    .attr_value(gimli::DW_AT_upper_bound)
                    .ok()
                    .flatten()
                    .and_then(attr_u64)
                {
                    n as u32 + 1
                } else {
                    0
                };
                dims.push(n);
            }
        }
        dims
    }

    /// An array with dimensions `dims` of `elem` at `src`.
    #[allow(clippy::too_many_arguments)]
    fn render_array(
        &self,
        dwarf: &Dwarf<'_>,
        unit: &Unit<'_>,
        elem: Option<UnitOffset<usize>>,
        dims: &[u32],
        src: Src,
        read: ReadMem<'_>,
        depth: u32,
    ) -> Value {
        let mut v = Value::default();
        let n = dims.first().copied().unwrap_or(0);
        let rest = &dims[dims.len().min(1)..];
        let esize = self.byte_size(unit, elem).unwrap_or(1) * rest.iter().product::<u32>();
        let ename = self.type_name(dwarf, unit, elem);
        let base = ename
            .trim_start_matches("const ")
            .trim_start_matches("volatile ");
        // char arrays read as strings.
        if rest.is_empty() && base == "char" && n > 0 {
            if let Some(b) = self.bytes(&src, 0, n as usize, read) {
                let end = b.iter().position(|&c| c == 0).unwrap_or(b.len());
                if end > 0 && b[..end].iter().all(|c| c.is_ascii_graphic() || *c == b' ') {
                    v.value = format!("\"{}\"", String::from_utf8_lossy(&b[..end]));
                    return v;
                }
            }
        }
        v.value = format!("[{n}]");
        if depth >= 3 {
            return v;
        }
        for i in 0..n.min(32) {
            let sub = match &src {
                Src::Addr(a) => Src::Addr(a + i * esize),
                Src::Bytes(_) | Src::Reg(..) => {
                    match self.bytes(&src, i * esize, esize as usize, read) {
                        Some(b) => Src::Bytes(b),
                        None => break,
                    }
                }
            };
            let mut c = if rest.is_empty() {
                self.render(dwarf, unit, elem, sub, read, depth + 1)
            } else {
                let mut c = self.render_array(dwarf, unit, elem, rest, sub, read, depth + 1);
                c.ty = format!(
                    "{ename}{}",
                    rest.iter().map(|n| format!("[{n}]")).collect::<String>()
                );
                c
            };
            if c.ty.is_empty() {
                c.ty = ename.clone();
            }
            c.name = format!("[{i}]");
            v.children.push(c);
        }
        v
    }

    fn bytes(&self, src: &Src, offset: u32, len: usize, read: ReadMem<'_>) -> Option<Vec<u8>> {
        match src {
            Src::Addr(a) => read(a + offset, len),
            Src::Bytes(b) => {
                let s = offset as usize;
                (s + len <= b.len()).then(|| b[s..s + len].to_vec())
            }
            Src::Reg(_, v) => {
                let s = offset as usize;
                (s + len <= 4).then(|| v.to_le_bytes()[s..s + len].to_vec())
            }
        }
    }

    /// Format the value of type `ty` stored at `src`.
    fn render(
        &self,
        dwarf: &Dwarf<'_>,
        unit: &Unit<'_>,
        ty: Option<UnitOffset<usize>>,
        src: Src,
        read: ReadMem<'_>,
        depth: u32,
    ) -> Value {
        let ty_name = self.type_name(dwarf, unit, ty);
        let mut v = Value {
            ty: ty_name,
            ..Default::default()
        };
        if let Src::Addr(a) = src {
            v.addr = Some(a);
        }
        let Some(off) = ty else {
            v.value = "void".into();
            return v;
        };
        let Ok(e) = unit.entry(off) else {
            return v;
        };
        let unreadable = || "<unreadable>".to_string();
        match e.tag() {
            gimli::DW_TAG_typedef | gimli::DW_TAG_const_type | gimli::DW_TAG_volatile_type => {
                let inner = self.render(dwarf, unit, type_of(&e), src, read, depth);
                v.value = inner.value;
                v.children = inner.children;
            }
            gimli::DW_TAG_base_type => {
                let size = self.byte_size(unit, ty).unwrap_or(4) as usize;
                let enc = e.attr_value(gimli::DW_AT_encoding).ok().flatten();
                let Some(b) = self.bytes(&src, 0, size, read) else {
                    v.value = unreadable();
                    return v;
                };
                let raw = b.iter().rev().fold(0u64, |a, &x| a << 8 | x as u64);
                let signed = |raw: u64| -> i64 {
                    let shift = 64 - 8 * size as u32;
                    ((raw << shift) as i64) >> shift
                };
                v.value = match enc {
                    Some(AttributeValue::Encoding(gimli::DW_ATE_float)) if size == 4 => {
                        format_float(f32::from_bits(raw as u32) as f64)
                    }
                    Some(AttributeValue::Encoding(gimli::DW_ATE_float)) if size == 8 => {
                        format_float(f64::from_bits(raw))
                    }
                    Some(AttributeValue::Encoding(gimli::DW_ATE_boolean)) => (raw != 0).to_string(),
                    Some(AttributeValue::Encoding(gimli::DW_ATE_signed_char))
                    | Some(AttributeValue::Encoding(gimli::DW_ATE_unsigned_char)) => {
                        let c = raw as u8;
                        let is_char = name_of(dwarf, unit, &e).as_deref() == Some("char");
                        if is_char && (c.is_ascii_graphic() || c == b' ') {
                            format!(
                                "{} '{}'",
                                if matches!(
                                    enc,
                                    Some(AttributeValue::Encoding(gimli::DW_ATE_signed_char))
                                ) {
                                    signed(raw)
                                } else {
                                    raw as i64
                                },
                                c as char
                            )
                        } else {
                            format!(
                                "{}",
                                if matches!(
                                    enc,
                                    Some(AttributeValue::Encoding(gimli::DW_ATE_signed_char))
                                ) {
                                    signed(raw)
                                } else {
                                    raw as i64
                                }
                            )
                        }
                    }
                    Some(AttributeValue::Encoding(gimli::DW_ATE_signed)) => signed(raw).to_string(),
                    _ => raw.to_string(),
                };
            }
            gimli::DW_TAG_enumeration_type => {
                let size = self.byte_size(unit, ty).unwrap_or(4) as usize;
                let Some(b) = self.bytes(&src, 0, size, read) else {
                    v.value = unreadable();
                    return v;
                };
                let raw_u = b.iter().rev().fold(0u64, |a, &x| a << 8 | x as u64);
                let mask = if size >= 8 {
                    u64::MAX
                } else {
                    (1u64 << (8 * size)) - 1
                };
                let shift = 64 - 8 * size.min(8) as u32;
                let sext = |u: u64| ((u << shift) as i64) >> shift;
                // Enumerators, and whether the enum is signed (its underlying
                // type, or a negative enumerator).
                let mut enumerators: Vec<(String, i64)> = Vec::new();
                let mut signed = type_of(&e)
                    .and_then(|t| unit.entry(t).ok())
                    .and_then(|t| t.attr_value(gimli::DW_AT_encoding).ok().flatten())
                    .is_some_and(|enc| enc == AttributeValue::Encoding(gimli::DW_ATE_signed));
                if let Ok(mut tree) = unit.entries_tree(Some(off)) {
                    if let Ok(root) = tree.root() {
                        let mut ch = root.children();
                        while let Ok(Some(c)) = ch.next() {
                            let ce = c.entry();
                            let cv = match ce.attr_value(gimli::DW_AT_const_value).ok().flatten() {
                                Some(AttributeValue::Sdata(s)) => {
                                    signed |= s < 0;
                                    Some(s)
                                }
                                Some(other) => attr_u64(other).map(|u| u as i64),
                                None => None,
                            };
                            if let (Some(cv), Some(n)) = (cv, name_of(dwarf, unit, ce)) {
                                enumerators.push((n, cv));
                            }
                        }
                    }
                }
                let shown = if signed { sext(raw_u) } else { raw_u as i64 };
                v.value = shown.to_string();
                // Compare within the enum's width: a 4-byte −1 stored as
                // 0xFFFFFFFF matches the enumerator −1.
                if let Some((n, _)) = enumerators
                    .iter()
                    .find(|(_, cv)| (*cv as u64) & mask == raw_u & mask)
                {
                    v.value = format!("{n} ({shown})");
                }
            }
            gimli::DW_TAG_pointer_type => {
                let Some(b) = self.bytes(&src, 0, 4, read) else {
                    v.value = unreadable();
                    return v;
                };
                let p = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
                v.value = format!("0x{p:08X}");
                // char *: show the string.
                let target = type_of(&e).and_then(|t| unit.entry(t).ok());
                let target = target.and_then(|t| {
                    let mut t = t;
                    for _ in 0..4 {
                        if matches!(
                            t.tag(),
                            gimli::DW_TAG_const_type
                                | gimli::DW_TAG_volatile_type
                                | gimli::DW_TAG_typedef
                        ) {
                            t = unit.entry(type_of(&t)?).ok()?;
                        }
                    }
                    Some(t)
                });
                let is_char = target.as_ref().is_some_and(|t| {
                    t.tag() == gimli::DW_TAG_base_type
                        && matches!(
                            t.attr_value(gimli::DW_AT_encoding).ok().flatten(),
                            Some(AttributeValue::Encoding(gimli::DW_ATE_signed_char))
                                | Some(AttributeValue::Encoding(gimli::DW_ATE_unsigned_char))
                        )
                });
                if is_char && p != 0 {
                    if let Some(s) = read(p, 40) {
                        let end = s.iter().position(|&c| c == 0).unwrap_or(s.len());
                        let text: String = s[..end]
                            .iter()
                            .map(|&c| {
                                if c.is_ascii_graphic() || c == b' ' {
                                    c as char
                                } else {
                                    '.'
                                }
                            })
                            .collect();
                        v.value = format!(
                            "0x{p:08X} \"{text}{}\"",
                            if end == s.len() { "…" } else { "" }
                        );
                    }
                } else if let Some(f) = self.function_at(p & !1) {
                    if f.low == p & !1 {
                        v.value = format!("0x{p:08X} <{}>", f.name);
                    }
                }
            }
            gimli::DW_TAG_array_type => {
                let dims = self.array_dims(unit, off);
                let inner = self.render_array(dwarf, unit, type_of(&e), &dims, src, read, depth);
                v.value = inner.value;
                v.children = inner.children;
            }
            gimli::DW_TAG_structure_type | gimli::DW_TAG_union_type => {
                v.value = "{…}".into();
                if depth >= 3 {
                    return v;
                }
                let Ok(mut tree) = unit.entries_tree(Some(off)) else {
                    return v;
                };
                let Ok(root) = tree.root() else {
                    return v;
                };
                let mut ch = root.children();
                while let Ok(Some(c)) = ch.next() {
                    let ce = c.entry();
                    if ce.tag() != gimli::DW_TAG_member {
                        continue;
                    }
                    let moff = ce
                        .attr_value(gimli::DW_AT_data_member_location)
                        .ok()
                        .flatten()
                        .and_then(attr_u64)
                        .unwrap_or(0) as u32;
                    let mty = type_of(ce);
                    let sub = match &src {
                        Src::Addr(a) => Src::Addr(a + moff),
                        Src::Bytes(_) | Src::Reg(..) => match self.bytes(
                            &src,
                            moff,
                            self.byte_size(unit, mty).unwrap_or(4) as usize,
                            read,
                        ) {
                            Some(b) => Src::Bytes(b),
                            None => continue,
                        },
                    };
                    let mut m = self.render(dwarf, unit, mty, sub, read, depth + 1);
                    // Bit fields.
                    if let Some(bits) = ce
                        .attr_value(gimli::DW_AT_bit_size)
                        .ok()
                        .flatten()
                        .and_then(attr_u64)
                    {
                        let start = self.bit_start(unit, ce, moff, bits);
                        if let Some(b) = self.bytes(
                            &src,
                            (start / 8) as u32,
                            8.min(((start % 8 + bits).div_ceil(8)) as usize),
                            read,
                        ) {
                            let raw = b.iter().rev().fold(0u64, |a, &x| a << 8 | x as u64);
                            m.value = ((raw >> (start % 8)) & ((1u64 << bits) - 1)).to_string();
                        }
                    }
                    m.name = name_of(dwarf, unit, ce).unwrap_or_default();
                    v.children.push(m);
                }
            }
            _ => v.value = "?".into(),
        }
        v
    }
}

/// DWARF 4 bit field position to a bit offset from the start of the struct
/// (little-endian): the storage unit of `unit_bytes` at byte `moff`, the
/// field `width` bits wide, `from_msb` bits below the unit's top.
fn legacy_bit_start(moff: u32, unit_bytes: u64, from_msb: u64, width: u64) -> u64 {
    (moff as u64 * 8 + unit_bytes * 8).saturating_sub(from_msb + width)
}

fn format_float(f: f64) -> String {
    if f == f.trunc() && f.abs() < 1e15 {
        format!("{f:.1}")
    } else {
        format!("{}", (f * 1e6).round() / 1e6)
    }
}

/// Whether a path from DWARF is absolute: POSIX `/…`, or a Windows drive
/// (`C:/…`, `C:\…`) or UNC (`\\server\…`) path from a student's PC.
fn is_absolute(p: &str) -> bool {
    let b = p.as_bytes();
    p.starts_with('/')
        || p.starts_with('\\')
        || (b.len() >= 3
            && b[0].is_ascii_alphabetic()
            && b[1] == b':'
            && matches!(b[2], b'/' | b'\\'))
}

/// The full path of a line-table file: the name, else under its directory,
/// else under the compilation directory; `\` becomes `/` (CubeIDE on
/// Windows writes `C:\Users\…\Debug` and `../Core/Src/main.c`) and `.`/`..`
/// are collapsed.
fn source_path(comp_dir: Option<&str>, dir: &str, name: &str) -> String {
    let mut path = name.to_string();
    if !is_absolute(&path) && !dir.is_empty() {
        path = format!("{dir}/{path}");
    }
    if !is_absolute(&path) {
        if let Some(c) = comp_dir.filter(|c| !c.is_empty()) {
            path = format!("{c}/{path}");
        }
    }
    normalize(&path.replace('\\', "/"))
}

/// Collapse `a/./b` and `a/x/../b` so paths from different units match.
fn normalize(p: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for s in p.split('/') {
        match s {
            "." | "" if !parts.is_empty() => {}
            ".." if parts.last().is_some_and(|l| *l != "..") && parts.len() > 1 => {
                parts.pop();
            }
            _ => parts.push(s),
        }
    }
    parts.join("/")
}

#[cfg(test)]
mod tests {
    use super::{legacy_bit_start, source_path};

    #[test]
    fn source_paths_from_any_pc() {
        // POSIX: absolute name, name under a directory, under comp_dir.
        assert_eq!(source_path(Some("/w"), "", "/h/p/main.c"), "/h/p/main.c");
        assert_eq!(
            source_path(Some("/w"), "/h/p/Core/Src", "main.c"),
            "/h/p/Core/Src/main.c"
        );
        assert_eq!(
            source_path(Some("/h/p/Debug"), "", "../Core/Src/main.c"),
            "/h/p/Core/Src/main.c"
        );
        assert_eq!(
            source_path(Some("/h/p/Debug"), "../Core/Src", "main.c"),
            "/h/p/Core/Src/main.c"
        );
        // CubeIDE on Windows: backslashes, a drive letter, relative to Debug.
        assert_eq!(
            source_path(
                Some(r"C:\Users\kim\ws\blinky\Debug"),
                "",
                "../Core/Src/main.c"
            ),
            "C:/Users/kim/ws/blinky/Core/Src/main.c"
        );
        assert_eq!(
            source_path(
                Some(r"C:\Users\kim\ws\blinky\Debug"),
                r"C:\Users\kim\ws\blinky\Core\Inc",
                "main.h"
            ),
            "C:/Users/kim/ws/blinky/Core/Inc/main.h"
        );
        assert_eq!(
            source_path(Some("/x"), "", r"D:\STM32Cube\Drivers\hal.c"),
            "D:/STM32Cube/Drivers/hal.c"
        );
        // No comp_dir: stays relative (matched by suffix later).
        assert_eq!(
            source_path(None, "", "../Core/Src/main.c"),
            "../Core/Src/main.c"
        );
    }

    #[test]
    fn dwarf4_bit_offsets() {
        // `struct { unsigned a:3; unsigned b:5; unsigned c:24; }`: GCC's
        // DWARF 4 gives bit offsets 29, 24 and 0 in a 4-byte unit.
        assert_eq!(legacy_bit_start(0, 4, 29, 3), 0);
        assert_eq!(legacy_bit_start(0, 4, 24, 5), 3);
        assert_eq!(legacy_bit_start(0, 4, 0, 24), 8);
        // A unit further into the struct.
        assert_eq!(legacy_bit_start(4, 2, 12, 4), 32);
    }
}
