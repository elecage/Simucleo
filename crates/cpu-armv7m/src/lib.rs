//! Simucleo's own Cortex-M4F interpreter.
//!
//! Status: skeleton. Reset and the fetch loop are in place; instruction
//! decoding is milestone M0 (see `docs/roadmap.md`). Every instruction
//! currently stops with [`StopReason::Unimplemented`].

use std::collections::BTreeSet;

use simucleo_core::bus::{AccessSize, Bus, BusError};
use simucleo_core::cpu::{CpuBackend, Registers, RunResult, StopReason};
use simucleo_core::Cycles;

/// Thumb state bit in xPSR.
const XPSR_T: u32 = 1 << 24;

#[derive(Debug, Default)]
pub struct ArmV7M {
    regs: Registers,
    breakpoints: BTreeSet<u32>,
}

impl ArmV7M {
    pub fn new() -> Self {
        Self::default()
    }

    /// Returns `(opcode, is_32bit)` for the instruction at `pc`.
    fn fetch(bus: &mut dyn Bus, pc: u32) -> Result<(u32, bool), BusError> {
        let hw1 = bus.read(pc, AccessSize::Half)?;
        // Thumb-2: first halfword 0b11101, 0b11110 or 0b11111 => 32-bit.
        if hw1 >> 11 >= 0b11101 {
            let hw2 = bus.read(pc.wrapping_add(2), AccessSize::Half)?;
            Ok(((hw1 << 16) | hw2, true))
        } else {
            Ok((hw1, false))
        }
    }
}

impl CpuBackend for ArmV7M {
    fn name(&self) -> &'static str {
        "rust"
    }

    fn reset(&mut self, bus: &mut dyn Bus, vtor: u32) -> Result<(), BusError> {
        let msp = bus.read_u32(vtor)?;
        let reset_vector = bus.read_u32(vtor + 4)?;
        self.regs = Registers::default();
        self.regs.msp = msp & !0b11;
        self.regs.r[Registers::SP] = self.regs.msp;
        self.regs.r[Registers::LR] = 0xFFFF_FFFF;
        self.regs.r[Registers::PC] = reset_vector & !1;
        self.regs.xpsr = if reset_vector & 1 != 0 { XPSR_T } else { 0 };
        Ok(())
    }

    fn run(&mut self, bus: &mut dyn Bus, max_cycles: Cycles) -> RunResult {
        let cycles = 0;
        if max_cycles == 0 {
            return RunResult {
                cycles,
                stop: StopReason::BudgetExhausted,
            };
        }
        let pc = self.regs.pc();
        if self.breakpoints.contains(&pc) {
            return RunResult {
                cycles,
                stop: StopReason::Breakpoint(pc),
            };
        }
        match Self::fetch(bus, pc) {
            // TODO(M0): decode and execute.
            Ok((opcode, _)) => RunResult {
                cycles,
                stop: StopReason::Unimplemented { pc, opcode },
            },
            Err(e) => RunResult {
                cycles,
                stop: StopReason::BusError(e),
            },
        }
    }

    fn registers(&self) -> &Registers {
        &self.regs
    }

    fn registers_mut(&mut self) -> &mut Registers {
        &mut self.regs
    }

    fn add_breakpoint(&mut self, addr: u32) {
        self.breakpoints.insert(addr & !1);
    }

    fn remove_breakpoint(&mut self, addr: u32) {
        self.breakpoints.remove(&(addr & !1));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use simucleo_core::bus::Memory;

    struct TestBus(Memory);

    impl Bus for TestBus {
        fn read(&mut self, addr: u32, size: AccessSize) -> Result<u32, BusError> {
            self.0.read(addr, size)
        }
        fn write(&mut self, addr: u32, size: AccessSize, value: u32) -> Result<(), BusError> {
            self.0.write(addr, size, value)
        }
    }

    #[test]
    fn reset_loads_vector_table() {
        let mut mem = Memory::new(0, 64, true);
        mem.load(0, &0x2001_8000u32.to_le_bytes()).unwrap();
        mem.load(4, &0x0000_0021u32.to_le_bytes()).unwrap(); // Reset_Handler | Thumb
        let mut bus = TestBus(mem);
        let mut cpu = ArmV7M::new();
        cpu.reset(&mut bus, 0).unwrap();
        assert_eq!(cpu.registers().r[Registers::SP], 0x2001_8000);
        assert_eq!(cpu.registers().pc(), 0x20);
        assert_ne!(cpu.registers().xpsr & XPSR_T, 0);
    }

    #[test]
    fn detects_32bit_thumb2_encoding() {
        let mut mem = Memory::new(0, 8, true);
        // BL (32-bit): F000 F800 ; MOVS r0,#1 (16-bit): 2001
        mem.load(0, &[0x00, 0xF0, 0x00, 0xF8, 0x01, 0x20]).unwrap();
        let mut bus = TestBus(mem);
        assert_eq!(ArmV7M::fetch(&mut bus, 0).unwrap(), (0xF000_F800, true));
        assert_eq!(ArmV7M::fetch(&mut bus, 4).unwrap(), (0x2001, false));
    }
}
