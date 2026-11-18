//! CPU backend abstraction.
//!
//! The simulator ships its own ARMv7E-M interpreter (works in WASM). Native
//! builds may additionally offer other backends (e.g. Unicorn) for
//! differential testing; see `docs/adr/0002-cpu-backends.md`.

use crate::bus::{Bus, BusError};
use crate::Cycles;

/// Architectural register state of a Cortex-M4F core.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Registers {
    /// R0–R12, SP (banked view of the active stack pointer), LR, PC.
    pub r: [u32; 16],
    pub xpsr: u32,
    pub msp: u32,
    pub psp: u32,
    pub primask: u32,
    pub basepri: u32,
    pub faultmask: u32,
    pub control: u32,
    /// Single-precision FPU registers S0–S31.
    pub s: [u32; 32],
    pub fpscr: u32,
}

impl Registers {
    pub const SP: usize = 13;
    pub const LR: usize = 14;
    pub const PC: usize = 15;

    pub fn pc(&self) -> u32 {
        self.r[Self::PC]
    }
}

/// Why [`CpuBackend::run`] returned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopReason {
    /// The requested cycle budget was consumed.
    BudgetExhausted,
    /// The core executed WFI/WFE and is waiting for an event; the caller can
    /// fast-forward time to the next scheduled event.
    Sleeping,
    /// A breakpoint address was reached (before executing it).
    Breakpoint(u32),
    /// The bus rejected an access the core could not turn into a fault.
    BusError(BusError),
    /// An instruction the backend does not implement yet.
    Unimplemented { pc: u32, opcode: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunResult {
    pub cycles: Cycles,
    pub stop: StopReason,
}

/// A Cortex-M execution engine.
///
/// Exception entry/return and the NVIC live outside the backend in a shared
/// module so that every backend gets identical interrupt semantics.
pub trait CpuBackend {
    /// Human-readable backend name (`"rust"`, `"unicorn"`, …).
    fn name(&self) -> &'static str;

    /// Cold reset: load MSP and PC from the vector table at `vtor`.
    fn reset(&mut self, bus: &mut dyn Bus, vtor: u32) -> Result<(), BusError>;

    /// Execute until the cycle budget is used up or a stop condition occurs.
    fn run(&mut self, bus: &mut dyn Bus, max_cycles: Cycles) -> RunResult;

    fn registers(&self) -> &Registers;
    fn registers_mut(&mut self) -> &mut Registers;

    fn add_breakpoint(&mut self, addr: u32);
    fn remove_breakpoint(&mut self, addr: u32);
}
