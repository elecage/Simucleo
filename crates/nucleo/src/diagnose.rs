//! Explain why firmware stopped, in terms a student can act on.

use simucleo_core::bus::Bus;
use simucleo_core::cortexm::exc;
use simucleo_core::cpu::{RunResult, StopReason};
use simucleo_periph_stm32f4::regmap;

use crate::Nucleo;

/// Details of a fault taken by the core.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FaultInfo {
    /// Exception being handled (HardFault, BusFault, …).
    pub handler: String,
    /// Address of the instruction that faulted, from the stacked frame.
    pub fault_pc: Option<u32>,
    pub fault_function: Option<String>,
    /// Decoded CFSR/HFSR bits, e.g. "UNDEFINSTR: undefined instruction".
    pub reasons: Vec<String>,
    pub cfsr: u32,
    pub hfsr: u32,
    pub bfar: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Diagnosis {
    /// CubeMX's `Error_Handler()` was called: a HAL function returned an
    /// error (often a clock configuration that times out).
    ErrorHandler { caller: Option<String> },
    /// The firmware is stuck in a fault handler.
    Fault(FaultInfo),
    /// An enabled interrupt has no handler and ended in `Default_Handler`.
    UnhandledInterrupt { exception: u16, name: String },
    /// Some other infinite loop with interrupts off.
    Halted { pc: u32, function: Option<String> },
    /// A fault happened that could not be handled (e.g. inside HardFault).
    Lockup { pc: u32, function: Option<String> },
    /// An instruction the simulator does not implement yet.
    Unimplemented {
        pc: u32,
        opcode: u32,
        function: Option<String>,
    },
}

const CFSR_BITS: &[(u32, &str)] = &[
    (0, "IACCVIOL: instruction access violation (MPU)"),
    (1, "DACCVIOL: data access violation (MPU)"),
    (3, "MUNSTKERR: MemManage fault on exception return"),
    (4, "MSTKERR: MemManage fault on exception entry"),
    (8, "IBUSERR: instruction fetch from an invalid address"),
    (9, "PRECISERR: data access to an invalid address"),
    (10, "IMPRECISERR: imprecise data bus error"),
    (11, "UNSTKERR: bus fault on exception return"),
    (12, "STKERR: bus fault while stacking (stack overflow?)"),
    (16, "UNDEFINSTR: undefined instruction"),
    (
        17,
        "INVSTATE: branch to an address without the Thumb bit (function pointer bug?)",
    ),
    (18, "INVPC: invalid EXC_RETURN"),
    (19, "NOCP: FPU used while disabled (CPACR)"),
    (24, "UNALIGNED: unaligned access with UNALIGN_TRP set"),
    (25, "DIVBYZERO: division by zero with DIV_0_TRP set"),
];

impl Nucleo {
    /// Interpret a run result. `None` means nothing is wrong.
    pub fn diagnose(&mut self, r: &RunResult) -> Option<Diagnosis> {
        let regs = self.cpu.registers();
        let func = |b: &Nucleo, a: u32| b.symbol_at(a).map(str::to_string);
        match r.stop {
            StopReason::Halted { pc } => {
                let ipsr = regs.ipsr();
                if self.symbol_at(pc) == Some("Error_Handler") {
                    // Leaf function: LR still holds the return address.
                    let caller = func(self, regs.r[14].wrapping_sub(2) & !1);
                    return Some(Diagnosis::ErrorHandler { caller });
                }
                match ipsr {
                    exc::HARD_FAULT | exc::MEM_MANAGE | exc::BUS_FAULT | exc::USAGE_FAULT => {
                        Some(Diagnosis::Fault(self.fault_info(ipsr)))
                    }
                    0 => Some(Diagnosis::Halted {
                        pc,
                        function: func(self, pc),
                    }),
                    n => {
                        let name = if n >= exc::IRQ0 {
                            regmap::interrupt_name(n - exc::IRQ0)
                                .map(|s| format!("{s} (IRQ {})", n - exc::IRQ0))
                                .unwrap_or_else(|| exc::name(n))
                        } else {
                            exc::name(n)
                        };
                        Some(Diagnosis::UnhandledInterrupt { exception: n, name })
                    }
                }
            }
            StopReason::Lockup { pc } => Some(Diagnosis::Lockup {
                pc,
                function: func(self, pc),
            }),
            StopReason::Unimplemented { pc, opcode } => Some(Diagnosis::Unimplemented {
                pc,
                opcode,
                function: func(self, pc),
            }),
            _ => None,
        }
    }

    fn fault_info(&mut self, handler: u16) -> FaultInfo {
        let regs = self.cpu.registers();
        // The handler may have pushed registers before looping; look for a
        // plausible exception frame (Thumb xPSR, PC in flash) near SP.
        let sp = if regs.r[14] & 0xFFFF_FFE0 == 0xFFFF_FFE0 && regs.r[14] & 4 != 0 {
            regs.psp
        } else {
            regs.msp
        };
        let mut fault_pc = None;
        for k in 0..16u32 {
            let frame = sp.wrapping_add(4 * k);
            let (Ok(pc), Ok(xpsr)) = (self.bus.read_u32(frame + 24), self.bus.read_u32(frame + 28))
            else {
                break;
            };
            let in_code = (0x0800_0000..0x0808_0000).contains(&pc) || pc < 0x0008_0000;
            if xpsr & (1 << 24) != 0 && in_code {
                fault_pc = Some(pc);
                break;
            }
        }
        let cfsr = self.sys.cfsr;
        let hfsr = self.sys.hfsr;
        let mut reasons: Vec<String> = CFSR_BITS
            .iter()
            .filter(|(b, _)| cfsr & (1 << b) != 0)
            .map(|(_, s)| s.to_string())
            .collect();
        if hfsr & (1 << 30) != 0 {
            reasons.push(
                "FORCED: escalated to HardFault (the specific fault handler is disabled)".into(),
            );
        }
        if hfsr & (1 << 1) != 0 {
            reasons.push("VECTTBL: vector table read failed".into());
        }
        FaultInfo {
            handler: exc::name(handler),
            fault_pc,
            fault_function: fault_pc.and_then(|pc| self.symbol_at(pc).map(str::to_string)),
            reasons,
            cfsr,
            hfsr,
            bfar: (cfsr & (1 << 15) != 0).then_some(self.sys.bfar),
        }
    }
}

impl std::fmt::Display for Diagnosis {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let at =
            |func: &Option<String>| func.as_ref().map(|s| format!(" <{s}>")).unwrap_or_default();
        match self {
            Diagnosis::ErrorHandler { caller } => {
                write!(f, "Error_Handler() was called")?;
                if let Some(c) = caller {
                    write!(f, " from {c}()")?;
                }
                write!(f, ": a HAL call returned an error")
            }
            Diagnosis::Fault(i) => {
                write!(f, "stuck in {}", i.handler)?;
                if let Some(pc) = i.fault_pc {
                    write!(
                        f,
                        " — faulting instruction at {pc:#010x}{}",
                        at(&i.fault_function)
                    )?;
                }
                for r in &i.reasons {
                    write!(f, "\n  {r}")?;
                }
                if let Some(a) = i.bfar {
                    write!(f, "\n  bus fault address: {a:#010x}")?;
                }
                Ok(())
            }
            Diagnosis::UnhandledInterrupt { name, .. } => {
                write!(
                    f,
                    "interrupt {name} is enabled but has no handler (ended in Default_Handler)"
                )
            }
            Diagnosis::Halted { pc, function } => {
                write!(
                    f,
                    "stuck in an endless loop with interrupts disabled at {pc:#010x}{}",
                    at(function)
                )
            }
            Diagnosis::Lockup { pc, function } => {
                write!(
                    f,
                    "core lockup at {pc:#010x}{} (a fault occurred inside a fault handler)",
                    at(function)
                )
            }
            Diagnosis::Unimplemented {
                pc,
                opcode,
                function,
            } => write!(
                f,
                "instruction {opcode:#06x} at {pc:#010x}{} is not implemented in the simulator yet",
                at(function)
            ),
        }
    }
}
