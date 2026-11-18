//! CPU backend abstraction.
//!
//! The simulator ships its own ARMv7E-M interpreter (works in WASM). Native
//! builds may additionally offer other backends (e.g. Unicorn) for
//! differential testing; see `docs/adr/0002-cpu-backends.md`.

use crate::bus::{Bus, BusError};
use crate::cortexm::CortexM;
use crate::Cycles;

/// Architectural register state of a Cortex-M4F core.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Registers {
    /// R0–R12, SP (the active stack pointer), LR, PC.
    pub r: [u32; 16],
    /// APSR | IPSR | EPSR (T bit and IT/ICI state).
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

    /// Exception number in IPSR (0 = Thread mode).
    pub fn ipsr(&self) -> u16 {
        (self.xpsr & crate::cortexm::psr::IPSR_MASK) as u16
    }
}

/// Why [`CpuBackend::run`] returned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StopReason {
    /// The requested cycle budget was consumed.
    BudgetExhausted,
    /// The core executed WFI/WFE and nothing it knows about will wake it;
    /// the caller can fast-forward time to the next peripheral event.
    Sleeping,
    /// A breakpoint address was reached (before executing it).
    Breakpoint(u32),
    /// The core locked up: a fault occurred that could not be handled
    /// (e.g. inside HardFault, or an unreadable vector table).
    Lockup { pc: u32 },
    /// An instruction the backend does not implement yet.
    Unimplemented { pc: u32, opcode: u32 },
    /// Software requested a system reset (AIRCR.SYSRESETREQ); the caller
    /// resets the machine before anything else executes.
    ResetRequested,
    /// The bus rejected an access in a way the core could not report.
    BusError(BusError),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunResult {
    pub cycles: Cycles,
    pub stop: StopReason,
}

/// A Cortex-M execution engine.
///
/// The system control space (NVIC, SCB, SysTick, …) and the exception model
/// live in [`CortexM`], shared by every backend. Accesses to
/// `0xE000_0000..` go to it; everything else goes to the [`Bus`].
pub trait CpuBackend {
    /// Human-readable backend name (`"rust"`, `"unicorn"`, …).
    fn name(&self) -> &'static str;

    /// Cold reset: load MSP and PC from the vector table at `sys.vtor`.
    fn reset(&mut self, bus: &mut dyn Bus, sys: &mut CortexM) -> Result<(), BusError>;

    /// Execute until the cycle budget is used up or a stop condition occurs.
    /// Elapsed time is accounted in `sys` (`sys.advance`).
    fn run(&mut self, bus: &mut dyn Bus, sys: &mut CortexM, max_cycles: Cycles) -> RunResult;

    fn registers(&self) -> Registers;
    fn set_registers(&mut self, regs: &Registers);

    fn add_breakpoint(&mut self, addr: u32);
    fn remove_breakpoint(&mut self, addr: u32);
}
