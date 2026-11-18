//! Cortex-M4 system level: NVIC, SCB, SysTick, DWT, FPU control registers and
//! the exception model (priorities, entry, return, fault escalation).
//!
//! This lives outside the CPU backends so that every backend (our own
//! interpreter and, natively, Unicorn) gets identical interrupt semantics.
//! References: ARMv7-M Architecture Reference Manual (DDI 0403E) B1.5, B3;
//! Cortex-M4 Devices Generic User Guide (DUI 0553).

use crate::bus::{AccessSize, Bus, BusError};
use crate::cpu::Registers;
use crate::Cycles;

/// Number of external interrupt lines modelled (STM32F401 uses 0..=84).
pub const NUM_IRQS: usize = 96;
/// Implemented priority bits (STM32: 4, so priorities read back as `0xN0`).
pub const PRIO_BITS: u32 = 4;
/// SCR.SEVONPEND
const SCR_SEVONPEND: u32 = 1 << 4;
const PRIO_MASK: u8 = (0xFF << (8 - PRIO_BITS)) as u8;

pub mod exc {
    pub const RESET: u16 = 1;
    pub const NMI: u16 = 2;
    pub const HARD_FAULT: u16 = 3;
    pub const MEM_MANAGE: u16 = 4;
    pub const BUS_FAULT: u16 = 5;
    pub const USAGE_FAULT: u16 = 6;
    pub const SVCALL: u16 = 11;
    pub const DEBUG_MON: u16 = 12;
    pub const PENDSV: u16 = 14;
    pub const SYSTICK: u16 = 15;
    pub const IRQ0: u16 = 16;

    pub fn name(n: u16) -> String {
        match n {
            0 => "Thread".into(),
            RESET => "Reset".into(),
            NMI => "NMI".into(),
            HARD_FAULT => "HardFault".into(),
            MEM_MANAGE => "MemManage".into(),
            BUS_FAULT => "BusFault".into(),
            USAGE_FAULT => "UsageFault".into(),
            SVCALL => "SVCall".into(),
            DEBUG_MON => "DebugMonitor".into(),
            PENDSV => "PendSV".into(),
            SYSTICK => "SysTick".into(),
            n if n >= IRQ0 => format!("IRQ{}", n - IRQ0),
            n => format!("Reserved{n}"),
        }
    }
}

/// xPSR bit positions.
pub mod psr {
    pub const N: u32 = 1 << 31;
    pub const Z: u32 = 1 << 30;
    pub const C: u32 = 1 << 29;
    pub const V: u32 = 1 << 28;
    pub const Q: u32 = 1 << 27;
    pub const T: u32 = 1 << 24;
    pub const GE_SHIFT: u32 = 16;
    pub const IPSR_MASK: u32 = 0x1FF;
    /// Stack-alignment flag, only meaningful in a stacked xPSR.
    pub const ALIGN: u32 = 1 << 9;
    /// EPSR.IT/ICI bits: [26:25] and [15:10].
    pub const IT_MASK: u32 = (0b11 << 25) | (0x3F << 10);

    pub fn it(xpsr: u32) -> u8 {
        (((xpsr >> 25) & 0b11) | (((xpsr >> 10) & 0x3F) << 2)) as u8
    }

    pub fn with_it(xpsr: u32, it: u8) -> u32 {
        let it = it as u32;
        (xpsr & !IT_MASK) | ((it & 0b11) << 25) | ((it >> 2) << 10)
    }
}

/// CONTROL register bits.
pub mod control {
    pub const NPRIV: u32 = 1 << 0;
    pub const SPSEL: u32 = 1 << 1;
    pub const FPCA: u32 = 1 << 2;
}

/// Synchronous faults raised by the CPU.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fault {
    UndefInstr,
    InvState,
    InvPc,
    NoCoprocessor,
    Unaligned,
    DivByZero,
    InstructionBus { addr: u32 },
    PreciseBus { addr: u32 },
}

impl Fault {
    /// The configurable fault exception this maps to and its CFSR bit.
    fn class(self) -> (u16, u32) {
        match self {
            Fault::UndefInstr => (exc::USAGE_FAULT, 1 << 16),
            Fault::InvState => (exc::USAGE_FAULT, 1 << 17),
            Fault::InvPc => (exc::USAGE_FAULT, 1 << 18),
            Fault::NoCoprocessor => (exc::USAGE_FAULT, 1 << 19),
            Fault::Unaligned => (exc::USAGE_FAULT, 1 << 24),
            Fault::DivByZero => (exc::USAGE_FAULT, 1 << 25),
            Fault::InstructionBus { .. } => (exc::BUS_FAULT, 1 << 8),
            Fault::PreciseBus { .. } => (exc::BUS_FAULT, (1 << 9) | (1 << 15)),
        }
    }
}

/// The processor cannot take any more exceptions (e.g. a fault inside
/// HardFault). Real hardware stops executing ("lockup").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Lockup;

#[derive(Debug, Clone, Default)]
pub struct SysTick {
    pub enable: bool,
    pub tickint: bool,
    /// `true`: processor clock; `false`: external reference (HCLK/8 on STM32).
    pub clksource: bool,
    pub countflag: bool,
    pub rvr: u32,
    pub cvr: u32,
    /// Accumulated processor cycles not yet turned into ticks (for HCLK/8).
    prescale: u32,
}

impl SysTick {
    fn divider(&self) -> u64 {
        if self.clksource {
            1
        } else {
            8
        }
    }

    /// Advance by `cycles` processor cycles; returns `true` if the counter
    /// reached zero (an interrupt should be pended when TICKINT is set).
    fn advance(&mut self, cycles: Cycles) -> bool {
        if !self.enable {
            return false;
        }
        let total = cycles + self.prescale as u64;
        let mut ticks = total / self.divider();
        self.prescale = (total % self.divider()) as u32;
        let mut fired = false;
        while ticks > 0 {
            if self.cvr == 0 {
                if self.rvr == 0 {
                    break;
                }
                self.cvr = self.rvr;
                ticks -= 1;
                continue;
            }
            let step = ticks.min(self.cvr as u64);
            self.cvr -= step as u32;
            ticks -= step;
            if self.cvr == 0 {
                self.countflag = true;
                fired = true;
                // Large jumps: skip whole periods arithmetically.
                if ticks > self.rvr as u64 + 1 && self.rvr != 0 {
                    let period = self.rvr as u64 + 1;
                    ticks %= period;
                }
            }
        }
        fired
    }

    /// Processor cycles until the counter next reaches zero.
    fn cycles_to_zero(&self) -> Option<Cycles> {
        if !self.enable || self.rvr == 0 && self.cvr == 0 {
            return None;
        }
        let ticks = if self.cvr == 0 {
            self.rvr as u64 + 1
        } else {
            self.cvr as u64
        };
        Some(
            (ticks * self.divider())
                .saturating_sub(self.prescale as u64)
                .max(1),
        )
    }
}

/// Cortex-M4 system control space and exception state.
#[derive(Debug, Clone)]
pub struct CortexM {
    // NVIC
    pub nvic_enabled: [u32; NUM_IRQS / 32],
    pub nvic_pending: [u32; NUM_IRQS / 32],
    nvic_active: [u32; NUM_IRQS / 32],
    nvic_prio: [u8; NUM_IRQS],

    // System exceptions 1..=15, bit n = exception n.
    sys_pending: u16,
    sys_active: u16,
    /// SHPR1–3: priorities of exceptions 4..=15.
    shpr: [u8; 12],

    // SCB
    pub vtor: u32,
    pub prigroup: u32,
    pub scr: u32,
    pub ccr: u32,
    pub shcsr_enables: u32,
    pub cfsr: u32,
    pub hfsr: u32,
    pub mmfar: u32,
    pub bfar: u32,
    pub cpacr: u32,
    pub actlr: u32,
    pub fpccr: u32,
    pub fpcar: u32,
    pub fpdscr: u32,
    mpu: [u32; 8],

    pub systick: SysTick,

    // Debug / trace
    pub dwt_ctrl: u32,
    pub dwt_cyccnt: u32,
    pub demcr: u32,
    pub dbgmcu_cr: u32,

    /// Total simulated processor cycles since power-on.
    pub cycles: Cycles,
    /// Set by AIRCR.SYSRESETREQ; the machine performs the reset.
    pub reset_requested: bool,
    /// Event latched for WFE by the system (SEVONPEND); the CPU consumes it
    /// with [`CortexM::take_event`].
    pub event: bool,
    /// System-space addresses accessed that are not modelled.
    pub unimplemented: Vec<u32>,
}

impl Default for CortexM {
    fn default() -> Self {
        Self::new()
    }
}

/// Resolved priority of an exception for preemption decisions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct PrioKey {
    group: i16,
    sub: i16,
    number: u16,
}

impl CortexM {
    pub fn new() -> Self {
        Self {
            nvic_enabled: [0; NUM_IRQS / 32],
            nvic_pending: [0; NUM_IRQS / 32],
            nvic_active: [0; NUM_IRQS / 32],
            nvic_prio: [0; NUM_IRQS],
            sys_pending: 0,
            sys_active: 0,
            shpr: [0; 12],
            vtor: 0,
            prigroup: 0,
            scr: 0,
            ccr: 0x200, // STKALIGN
            shcsr_enables: 0,
            cfsr: 0,
            hfsr: 0,
            mmfar: 0,
            bfar: 0,
            cpacr: 0,
            actlr: 0,
            fpccr: 0xC000_0000, // ASPEN | LSPEN
            fpcar: 0,
            fpdscr: 0,
            mpu: [0; 8],
            systick: SysTick {
                clksource: false,
                ..Default::default()
            },
            dwt_ctrl: 0x4000_0000,
            dwt_cyccnt: 0,
            demcr: 0,
            dbgmcu_cr: 0,
            cycles: 0,
            reset_requested: false,
            event: false,
            unimplemented: Vec::new(),
        }
    }

    /// System reset (keeps the cycle counter running, like a warm reset).
    pub fn reset(&mut self) {
        let cycles = self.cycles;
        *self = Self::new();
        self.cycles = cycles;
    }

    // ----------------------------------------------------------------- time

    /// Account for `cycles` processor cycles of execution.
    pub fn advance(&mut self, cycles: Cycles) {
        self.cycles += cycles;
        if self.dwt_ctrl & 1 != 0 {
            self.dwt_cyccnt = self.dwt_cyccnt.wrapping_add(cycles as u32);
        }
        if self.systick.advance(cycles) && self.systick.tickint {
            self.set_pending(exc::SYSTICK);
        }
    }

    /// Cycles until the next event this module generates by itself.
    pub fn next_event_in(&self) -> Option<Cycles> {
        if self.systick.tickint {
            self.systick.cycles_to_zero()
        } else {
            None
        }
    }

    // ----------------------------------------------------------- priorities

    fn raw_priority(&self, n: u16) -> i16 {
        match n {
            exc::RESET => -3,
            exc::NMI => -2,
            exc::HARD_FAULT => -1,
            4..=15 => self.shpr[n as usize - 4] as i16,
            _ => self.nvic_prio[(n - exc::IRQ0) as usize] as i16,
        }
    }

    fn key(&self, n: u16) -> PrioKey {
        let p = self.raw_priority(n);
        PrioKey {
            group: self.group(p),
            sub: p,
            number: n,
        }
    }

    /// Group (preemption) priority of a raw priority value.
    fn group(&self, p: i16) -> i16 {
        if p < 0 {
            return p;
        }
        let sub_bits = self.prigroup + 1;
        p & !((1i16 << sub_bits) - 1)
    }

    fn is_active(&self, n: u16) -> bool {
        if n < 16 {
            self.sys_active & (1 << n) != 0
        } else {
            let i = (n - 16) as usize;
            self.nvic_active[i / 32] & (1 << (i % 32)) != 0
        }
    }

    fn active_list(&self) -> impl Iterator<Item = u16> + '_ {
        (1..16u16)
            .filter(|n| self.sys_active & (1 << n) != 0)
            .chain(
                (0..NUM_IRQS as u16)
                    .filter(|i| self.nvic_active[*i as usize / 32] & (1 << (i % 32)) != 0)
                    .map(|i| i + 16),
            )
    }

    fn active_count(&self) -> u32 {
        self.sys_active.count_ones() + self.nvic_active.iter().map(|w| w.count_ones()).sum::<u32>()
    }

    /// Current execution priority (lower value = higher priority; 256 = thread
    /// mode with no masking).
    pub fn execution_priority(&self, regs: &Registers) -> i16 {
        let mut prio = 256;
        for n in self.active_list() {
            prio = prio.min(self.group(self.raw_priority(n)));
        }
        let basepri = (regs.basepri & PRIO_MASK as u32) as i16;
        if basepri != 0 {
            prio = prio.min(self.group(basepri));
        }
        if regs.primask & 1 != 0 {
            prio = prio.min(0);
        }
        if regs.faultmask & 1 != 0 {
            prio = prio.min(-1);
        }
        prio
    }

    fn pending_list(&self) -> impl Iterator<Item = u16> + '_ {
        (2..16u16)
            .filter(|n| self.sys_pending & (1 << n) != 0)
            .chain(
                (0..NUM_IRQS as u16)
                    .filter(|i| {
                        let (w, b) = (*i as usize / 32, i % 32);
                        self.nvic_pending[w] & self.nvic_enabled[w] & (1 << b) != 0
                    })
                    .map(|i| i + 16),
            )
    }

    /// Cheap check: is anything pending at all (enabled IRQs included)?
    #[inline]
    pub fn any_pending(&self) -> bool {
        self.sys_pending != 0
            || self
                .nvic_pending
                .iter()
                .zip(&self.nvic_enabled)
                .any(|(p, e)| p & e != 0)
    }

    /// Highest-priority pending exception, regardless of masking.
    pub fn highest_pending(&self) -> Option<u16> {
        self.pending_list()
            .map(|n| self.key(n))
            .min()
            .map(|k| k.number)
    }

    /// The exception that should be taken now, if any.
    pub fn exception_to_take(&self, regs: &Registers) -> Option<u16> {
        let n = self.highest_pending()?;
        (self.group(self.raw_priority(n)) < self.execution_priority(regs)).then_some(n)
    }

    /// WFI wake-up condition: a pending exception that would preempt if
    /// PRIMASK were clear.
    pub fn wakeup_pending(&self, regs: &Registers) -> bool {
        let unmasked = Registers {
            primask: 0,
            ..regs.clone()
        };
        self.exception_to_take(&unmasked).is_some()
    }

    pub fn set_pending(&mut self, n: u16) {
        let newly = if n < 16 {
            let was = self.sys_pending & (1 << n) != 0;
            self.sys_pending |= 1 << n;
            !was
        } else {
            let i = (n - 16) as usize;
            let was = self.nvic_pending[i / 32] & (1 << (i % 32)) != 0;
            self.nvic_pending[i / 32] |= 1 << (i % 32);
            !was
        };
        if newly {
            self.on_new_pending();
        }
    }

    /// SCR.SEVONPEND: an interrupt entering the pending state is a WFE
    /// wake-up event, even when it is disabled or masked (PM0214 §4.4.6).
    fn on_new_pending(&mut self) {
        if self.scr & SCR_SEVONPEND != 0 {
            self.event = true;
        }
    }

    /// Consume a pending wake-up event (see [`CortexM::event`]).
    pub fn take_event(&mut self) -> bool {
        std::mem::take(&mut self.event)
    }

    /// Pend an external interrupt line (peripheral IRQ number).
    pub fn set_irq_pending(&mut self, irq: u16) {
        self.set_pending(irq + exc::IRQ0);
    }

    fn clear_pending(&mut self, n: u16) {
        if n < 16 {
            self.sys_pending &= !(1 << n);
        } else {
            let i = (n - 16) as usize;
            self.nvic_pending[i / 32] &= !(1 << (i % 32));
        }
    }

    fn set_active(&mut self, n: u16, active: bool) {
        if n < 16 {
            if active {
                self.sys_active |= 1 << n;
            } else {
                self.sys_active &= !(1 << n);
            }
        } else {
            let i = (n - 16) as usize;
            if active {
                self.nvic_active[i / 32] |= 1 << (i % 32);
            } else {
                self.nvic_active[i / 32] &= !(1 << (i % 32));
            }
        }
    }

    /// Whether CP10 is accessible (else FP instructions raise NOCP). The
    /// simulated core always runs privileged code here, so "privileged only"
    /// (0b01) counts as enabled too.
    pub fn fpu_access(&self) -> bool {
        matches!((self.cpacr >> 20) & 3, 0b01 | 0b11)
    }

    // --------------------------------------------------------------- faults

    /// Decide which exception a synchronous fault turns into, recording the
    /// fault status. Returns `Err(Lockup)` if it cannot be taken at all.
    pub fn raise_fault(&mut self, fault: Fault, regs: &Registers) -> Result<u16, Lockup> {
        let (class, bit) = fault.class();
        match fault {
            Fault::PreciseBus { addr } => self.bfar = addr,
            Fault::InstructionBus { .. } => {}
            _ => {}
        }
        self.cfsr |= bit;
        let enabled = match class {
            exc::MEM_MANAGE => self.shcsr_enables & (1 << 16) != 0,
            exc::BUS_FAULT => self.shcsr_enables & (1 << 17) != 0,
            exc::USAGE_FAULT => self.shcsr_enables & (1 << 18) != 0,
            _ => false,
        };
        let exec = self.execution_priority(regs);
        if enabled && self.group(self.raw_priority(class)) < exec {
            return Ok(class);
        }
        self.escalate(regs)
    }

    /// Escalate to HardFault (HFSR.FORCED).
    fn escalate(&mut self, regs: &Registers) -> Result<u16, Lockup> {
        if self.execution_priority(regs) <= -1 {
            return Err(Lockup);
        }
        self.hfsr |= 1 << 30;
        Ok(exc::HARD_FAULT)
    }

    /// SVC instruction: SVCall if it can preempt, otherwise HardFault.
    pub fn svc(&mut self, regs: &Registers) -> Result<u16, Lockup> {
        if self.group(self.raw_priority(exc::SVCALL)) < self.execution_priority(regs) {
            Ok(exc::SVCALL)
        } else {
            self.escalate(regs)
        }
    }

    // ----------------------------------------------------- entry and return

    /// Exception entry (ARM ARM B1.5.6): stack the context, load the vector,
    /// switch to Handler mode. `return_addr` is the instruction to resume.
    pub fn exception_entry(
        &mut self,
        regs: &mut Registers,
        bus: &mut dyn Bus,
        number: u16,
        return_addr: u32,
    ) -> Result<(), Lockup> {
        sync_sp_banks(regs);
        let handler_mode = regs.xpsr & psr::IPSR_MASK != 0;
        let use_psp = !handler_mode && regs.control & control::SPSEL != 0;
        let fpca = regs.control & control::FPCA != 0;
        let frame_size: u32 = if fpca { 0x68 } else { 0x20 };
        let sp = if use_psp { regs.psp } else { regs.msp };
        let force_align = self.ccr & 0x200 != 0;
        let realign = force_align && sp & 4 != 0;
        let frame = sp.wrapping_sub(frame_size) & if force_align { !4 } else { !0 };

        let mut stacked_xpsr = regs.xpsr & !psr::ALIGN;
        if realign {
            stacked_xpsr |= psr::ALIGN;
        }
        let words = [
            regs.r[0],
            regs.r[1],
            regs.r[2],
            regs.r[3],
            regs.r[12],
            regs.r[14],
            return_addr,
            stacked_xpsr,
        ];
        let mut ok = words.iter().enumerate().all(|(i, w)| {
            bus.write(frame + 4 * i as u32, AccessSize::Word, *w)
                .is_ok()
        });
        if fpca && ok {
            for i in 0..16 {
                ok &= bus
                    .write(frame + 0x20 + 4 * i, AccessSize::Word, regs.s[i as usize])
                    .is_ok();
            }
            ok &= bus
                .write(frame + 0x60, AccessSize::Word, regs.fpscr)
                .is_ok();
            self.fpcar = frame + 0x20;
        }

        if use_psp {
            regs.psp = frame;
        } else {
            regs.msp = frame;
        }

        let mut number = number;
        if !ok {
            // Stacking error: BusFault STKERR, escalated as usual.
            self.cfsr |= 1 << 12;
            number = self.escalate(regs).unwrap_or(exc::HARD_FAULT);
        }

        regs.r[14] = if handler_mode {
            0xFFFF_FFE1 | if fpca { 0 } else { 0x10 }
        } else {
            0xFFFF_FFE9 | if fpca { 0 } else { 0x10 } | if use_psp { 0x4 } else { 0 }
        };

        let vector = bus
            .read(self.vtor.wrapping_add(4 * number as u32), AccessSize::Word)
            .map_err(|_| {
                self.hfsr |= 1 << 1; // VECTTBL
                Lockup
            })?;

        self.clear_pending(number);
        self.set_active(number, true);
        regs.r[15] = vector & !1;
        regs.xpsr = (regs.xpsr & !(psr::IPSR_MASK | psr::IT_MASK | psr::T))
            | number as u32
            | if vector & 1 != 0 { psr::T } else { 0 };
        regs.control &= !(control::SPSEL | control::FPCA);
        regs.r[13] = regs.msp;
        Ok(())
    }

    /// Exception return triggered by loading an EXC_RETURN value into PC.
    pub fn exception_return(
        &mut self,
        regs: &mut Registers,
        bus: &mut dyn Bus,
        exc_return: u32,
    ) -> Result<(), Fault> {
        sync_sp_banks(regs);
        let returning = (regs.xpsr & psr::IPSR_MASK) as u16;
        let to_thread = match exc_return & 0xF {
            0b0001 => false,
            0b1001 | 0b1101 => true,
            _ => return Err(Fault::InvPc),
        };
        if !self.is_active(returning) {
            return Err(Fault::InvPc);
        }
        self.set_active(returning, false);
        if returning != exc::NMI {
            regs.faultmask = 0;
        }

        let use_psp = exc_return & 0b0100 != 0;
        let fp_frame = exc_return & 0x10 == 0;
        let frame = if use_psp { regs.psp } else { regs.msp };
        let mut words = [0u32; 8];
        for (i, w) in words.iter_mut().enumerate() {
            *w = bus
                .read(frame + 4 * i as u32, AccessSize::Word)
                .map_err(|_| {
                    self.cfsr |= 1 << 11; // UNSTKERR
                    Fault::PreciseBus { addr: frame }
                })?;
        }
        if fp_frame {
            for (i, s) in regs.s.iter_mut().take(16).enumerate() {
                *s = bus
                    .read(frame + 0x20 + 4 * i as u32, AccessSize::Word)
                    .unwrap_or(0);
            }
            regs.fpscr = bus.read(frame + 0x60, AccessSize::Word).unwrap_or(0);
        }
        let [r0, r1, r2, r3, r12, lr, pc, xpsr] = words;
        regs.r[0] = r0;
        regs.r[1] = r1;
        regs.r[2] = r2;
        regs.r[3] = r3;
        regs.r[12] = r12;
        regs.r[14] = lr;
        regs.r[15] = pc & !1;

        let frame_size = if fp_frame { 0x68 } else { 0x20 };
        let new_sp = frame + frame_size + if xpsr & psr::ALIGN != 0 { 4 } else { 0 };
        if use_psp {
            regs.psp = new_sp;
        } else {
            regs.msp = new_sp;
        }

        regs.xpsr = xpsr & !psr::ALIGN;
        if to_thread {
            regs.xpsr &= !psr::IPSR_MASK;
        }
        regs.control = (regs.control & !(control::SPSEL | control::FPCA))
            | if to_thread && use_psp {
                control::SPSEL
            } else {
                0
            }
            | if fp_frame { control::FPCA } else { 0 };
        regs.r[13] = if to_thread && use_psp {
            regs.psp
        } else {
            regs.msp
        };
        Ok(())
    }

    // ------------------------------------------------------ register access

    pub fn read(&mut self, addr: u32, size: AccessSize) -> Result<u32, BusError> {
        let shift = (addr & 3) * 8;
        let word = self.read_word(addr & !3);
        let mask = if size == AccessSize::Word {
            u32::MAX
        } else {
            (1u32 << (8 * size.bytes())) - 1
        };
        Ok((word >> shift) & mask)
    }

    pub fn write(&mut self, addr: u32, size: AccessSize, value: u32) -> Result<(), BusError> {
        let shift = (addr & 3) * 8;
        let lanes = if size == AccessSize::Word {
            u32::MAX
        } else {
            ((1u32 << (8 * size.bytes())) - 1) << shift
        };
        self.write_word(addr & !3, value << shift, lanes);
        Ok(())
    }

    fn icsr(&self) -> u32 {
        let pending = self.highest_pending().unwrap_or(0) as u32;
        let isr_pending = self
            .nvic_pending
            .iter()
            .zip(&self.nvic_enabled)
            .any(|(p, e)| p & e != 0);
        let mut v = 0;
        if self.sys_pending & (1 << exc::NMI) != 0 {
            v |= 1 << 31;
        }
        if self.sys_pending & (1 << exc::PENDSV) != 0 {
            v |= 1 << 28;
        }
        if self.sys_pending & (1 << exc::SYSTICK) != 0 {
            v |= 1 << 26;
        }
        if isr_pending {
            v |= 1 << 22;
        }
        v |= (pending & 0x1FF) << 12;
        if self.active_count() <= 1 {
            v |= 1 << 11; // RETTOBASE
        }
        // VECTACTIVE mirrors IPSR; the CPU's IPSR is the authority, but the
        // highest active exception is the same thing outside of nesting.
        if let Some(a) = self
            .active_list()
            .max_by_key(|n| std::cmp::Reverse(self.key(*n)))
        {
            v |= a as u32;
        }
        v
    }

    fn read_word(&mut self, addr: u32) -> u32 {
        match addr {
            0xE000_E004 => (NUM_IRQS / 32 - 1) as u32,
            0xE000_E008 => self.actlr,
            0xE000_E010 => {
                let st = &mut self.systick;
                let v = st.enable as u32
                    | (st.tickint as u32) << 1
                    | (st.clksource as u32) << 2
                    | (st.countflag as u32) << 16;
                st.countflag = false;
                v
            }
            0xE000_E014 => self.systick.rvr,
            0xE000_E018 => self.systick.cvr,
            0xE000_E01C => 0x4000_0000 | 10_499, // NOREF=0, SKEW=1, TENMS for 84 MHz/8
            0xE000_E100..=0xE000_E108 => self.nvic_enabled[((addr - 0xE000_E100) / 4) as usize],
            0xE000_E180..=0xE000_E188 => self.nvic_enabled[((addr - 0xE000_E180) / 4) as usize],
            0xE000_E200..=0xE000_E208 => self.nvic_pending[((addr - 0xE000_E200) / 4) as usize],
            0xE000_E280..=0xE000_E288 => self.nvic_pending[((addr - 0xE000_E280) / 4) as usize],
            0xE000_E300..=0xE000_E308 => self.nvic_active[((addr - 0xE000_E300) / 4) as usize],
            0xE000_E400..=0xE000_E45C => {
                let i = (addr - 0xE000_E400) as usize;
                u32::from_le_bytes([
                    self.nvic_prio[i],
                    self.nvic_prio[i + 1],
                    self.nvic_prio[i + 2],
                    self.nvic_prio[i + 3],
                ])
            }
            0xE000_ED00 => 0x410F_C241, // Cortex-M4 r0p1
            0xE000_ED04 => self.icsr(),
            0xE000_ED08 => self.vtor,
            0xE000_ED0C => 0xFA05_0000 | (self.prigroup << 8),
            0xE000_ED10 => self.scr,
            0xE000_ED14 => self.ccr,
            0xE000_ED18..=0xE000_ED20 => {
                let i = (addr - 0xE000_ED18) as usize;
                u32::from_le_bytes([
                    self.shpr[i],
                    self.shpr[i + 1],
                    self.shpr[i + 2],
                    self.shpr[i + 3],
                ])
            }
            0xE000_ED24 => {
                let a = |n: u16| self.sys_active & (1 << n) != 0;
                let p = |n: u16| self.sys_pending & (1 << n) != 0;
                self.shcsr_enables
                    | a(exc::MEM_MANAGE) as u32
                    | (a(exc::BUS_FAULT) as u32) << 1
                    | (a(exc::USAGE_FAULT) as u32) << 3
                    | (a(exc::SVCALL) as u32) << 7
                    | (a(exc::DEBUG_MON) as u32) << 8
                    | (a(exc::PENDSV) as u32) << 10
                    | (a(exc::SYSTICK) as u32) << 11
                    | (p(exc::USAGE_FAULT) as u32) << 12
                    | (p(exc::MEM_MANAGE) as u32) << 13
                    | (p(exc::BUS_FAULT) as u32) << 14
                    | (p(exc::SVCALL) as u32) << 15
            }
            0xE000_ED28 => self.cfsr,
            0xE000_ED2C => self.hfsr,
            0xE000_ED30 => 0,
            0xE000_ED34 => self.mmfar,
            0xE000_ED38 => self.bfar,
            0xE000_ED3C => 0,
            // Processor feature registers (Cortex-M4F values).
            0xE000_ED40 => 0x0000_0030,
            0xE000_ED44 => 0x0000_0200,
            0xE000_ED48 => 0x0010_0000,
            0xE000_ED4C => 0,
            0xE000_ED50 => 0x0010_0030,
            0xE000_ED54 => 0,
            0xE000_ED58 => 0x0100_0000,
            0xE000_ED5C => 0,
            0xE000_ED60 => 0x0110_1110,
            0xE000_ED64 => 0x0211_1000,
            0xE000_ED68 => 0x2111_2231,
            0xE000_ED6C => 0x0111_1110,
            0xE000_ED70 => 0x0131_0132,
            0xE000_ED88 => self.cpacr,
            0xE000_ED90 => 0x0000_0800, // MPU_TYPE: 8 regions
            0xE000_ED94..=0xE000_EDB0 => self.mpu[((addr - 0xE000_ED94) / 4) as usize],
            0xE000_EDF0 => 0,
            0xE000_EDFC => self.demcr,
            0xE000_EF34 => self.fpccr,
            0xE000_EF38 => self.fpcar,
            0xE000_EF3C => self.fpdscr,
            0xE000_EF40 => 0x1011_0021,
            0xE000_EF44 => 0x1100_0011,
            0xE000_1000 => self.dwt_ctrl,
            0xE000_1004 => self.dwt_cyccnt,
            // ITM: report ports as disabled so ITM_SendChar returns at once.
            0xE000_0000..=0xE000_0FFC => 0,
            0xE004_2000 => 0x1000_6433, // DBGMCU IDCODE: STM32F401xD/E rev Z
            0xE004_2004 => self.dbgmcu_cr,
            0xE004_2008 | 0xE004_200C => 0,
            _ => {
                self.unimplemented.push(addr);
                0
            }
        }
    }

    fn write_word(&mut self, addr: u32, value: u32, lanes: u32) {
        let merge = |old: u32| (old & !lanes) | (value & lanes);
        let v = value & lanes;
        match addr {
            0xE000_E008 => self.actlr = merge(self.actlr),
            0xE000_E010 => {
                let st = &mut self.systick;
                st.enable = v & 1 != 0;
                st.tickint = v & 2 != 0;
                st.clksource = v & 4 != 0;
            }
            0xE000_E014 => self.systick.rvr = merge(self.systick.rvr) & 0x00FF_FFFF,
            0xE000_E018 => {
                self.systick.cvr = 0;
                self.systick.countflag = false;
            }
            0xE000_E100..=0xE000_E108 => {
                self.nvic_enabled[((addr - 0xE000_E100) / 4) as usize] |= v
            }
            0xE000_E180..=0xE000_E188 => {
                self.nvic_enabled[((addr - 0xE000_E180) / 4) as usize] &= !v
            }
            0xE000_E200..=0xE000_E208 => {
                let w = &mut self.nvic_pending[((addr - 0xE000_E200) / 4) as usize];
                let newly = v & !*w;
                *w |= v;
                if newly != 0 {
                    self.on_new_pending();
                }
            }
            0xE000_E280..=0xE000_E288 => {
                self.nvic_pending[((addr - 0xE000_E280) / 4) as usize] &= !v
            }
            0xE000_E400..=0xE000_E45C => {
                for b in 0..4 {
                    if lanes & (0xFF << (8 * b)) != 0 {
                        self.nvic_prio[(addr - 0xE000_E400) as usize + b] =
                            (value >> (8 * b)) as u8 & PRIO_MASK;
                    }
                }
            }
            0xE000_ED04 => {
                if v & (1 << 31) != 0 {
                    self.set_pending(exc::NMI);
                }
                if v & (1 << 28) != 0 {
                    self.set_pending(exc::PENDSV);
                }
                if v & (1 << 27) != 0 {
                    self.clear_pending(exc::PENDSV);
                }
                if v & (1 << 26) != 0 {
                    self.set_pending(exc::SYSTICK);
                }
                if v & (1 << 25) != 0 {
                    self.clear_pending(exc::SYSTICK);
                }
            }
            0xE000_ED08 => self.vtor = merge(self.vtor) & 0xFFFF_FF80,
            0xE000_ED0C => {
                if lanes == u32::MAX && value >> 16 == 0x05FA {
                    self.prigroup = (value >> 8) & 7;
                    if value & (1 << 2) != 0 {
                        self.reset_requested = true;
                    }
                    if value & (1 << 1) != 0 {
                        // VECTCLRACTIVE (debug only): clear active state.
                        self.sys_active = 0;
                        self.nvic_active = [0; NUM_IRQS / 32];
                    }
                }
            }
            0xE000_ED10 => self.scr = merge(self.scr) & 0b1_0110,
            0xE000_ED14 => self.ccr = merge(self.ccr) & 0x31B,
            0xE000_ED18..=0xE000_ED20 => {
                for b in 0..4 {
                    if lanes & (0xFF << (8 * b)) != 0 {
                        self.shpr[(addr - 0xE000_ED18) as usize + b] =
                            (value >> (8 * b)) as u8 & PRIO_MASK;
                    }
                }
            }
            0xE000_ED24 => {
                self.shcsr_enables = merge(self.shcsr_enables) & (0b111 << 16);
            }
            0xE000_ED28 => self.cfsr &= !v,
            0xE000_ED2C => self.hfsr &= !v,
            0xE000_ED34 => self.mmfar = merge(self.mmfar),
            0xE000_ED38 => self.bfar = merge(self.bfar),
            0xE000_ED88 => self.cpacr = merge(self.cpacr) & (0xF << 20),
            0xE000_ED94..=0xE000_EDB0 => {
                let i = ((addr - 0xE000_ED94) / 4) as usize;
                self.mpu[i] = merge(self.mpu[i]);
            }
            0xE000_EDF0 => {}
            0xE000_EDFC => self.demcr = merge(self.demcr),
            0xE000_EF00 => {
                let irq = (v & 0x1FF) as u16;
                if (irq as usize) < NUM_IRQS {
                    self.set_irq_pending(irq);
                }
            }
            0xE000_EF34 => self.fpccr = merge(self.fpccr) & 0xC000_01FB,
            0xE000_EF38 => self.fpcar = merge(self.fpcar) & !7,
            0xE000_EF3C => self.fpdscr = merge(self.fpdscr) & 0x07C0_0000,
            0xE000_1000 => self.dwt_ctrl = (merge(self.dwt_ctrl) & 0x0FFF_FFFF) | 0x4000_0000,
            0xE000_1004 => self.dwt_cyccnt = merge(self.dwt_cyccnt),
            0xE000_0000..=0xE000_0FFC => {}
            0xE004_2004 => self.dbgmcu_cr = merge(self.dbgmcu_cr),
            0xE004_2008 | 0xE004_200C => {}
            _ => self.unimplemented.push(addr),
        }
    }
}

/// Make `msp`/`psp` consistent with the live stack pointer `r[13]`.
pub fn sync_sp_banks(regs: &mut Registers) {
    let handler = regs.xpsr & psr::IPSR_MASK != 0;
    if !handler && regs.control & control::SPSEL != 0 {
        regs.psp = regs.r[13];
    } else {
        regs.msp = regs.r[13];
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bus::Memory;

    struct Ram(Memory);
    impl Bus for Ram {
        fn read(&mut self, a: u32, s: AccessSize) -> Result<u32, BusError> {
            self.0.read(a, s)
        }
        fn write(&mut self, a: u32, s: AccessSize, v: u32) -> Result<(), BusError> {
            self.0.write(a, s, v)
        }
    }

    fn thread_regs(sp: u32) -> Registers {
        let mut r = Registers {
            xpsr: psr::T,
            ..Default::default()
        };
        r.r[13] = sp;
        r.msp = sp;
        r
    }

    #[test]
    fn priority_registers_implement_four_bits() {
        let mut s = CortexM::new();
        s.write(0xE000_E400, AccessSize::Byte, 0xFF).unwrap();
        assert_eq!(s.read(0xE000_E400, AccessSize::Byte).unwrap(), 0xF0);
        s.write(0xE000_ED23, AccessSize::Byte, 0xFF).unwrap(); // SysTick priority
        assert_eq!(s.read(0xE000_ED20, AccessSize::Word).unwrap(), 0xF000_0000);
    }

    #[test]
    fn aircr_needs_vectkey() {
        let mut s = CortexM::new();
        s.write(0xE000_ED0C, AccessSize::Word, 3 << 8).unwrap();
        assert_eq!(s.prigroup, 0);
        s.write(0xE000_ED0C, AccessSize::Word, 0x05FA_0000 | 3 << 8)
            .unwrap();
        assert_eq!(s.read(0xE000_ED0C, AccessSize::Word).unwrap(), 0xFA05_0300);
    }

    #[test]
    fn systick_period_and_countflag() {
        let mut s = CortexM::new();
        s.write(0xE000_E014, AccessSize::Word, 999).unwrap(); // 1000-cycle period
        s.write(0xE000_E018, AccessSize::Word, 0).unwrap();
        s.write(0xE000_E010, AccessSize::Word, 0b111).unwrap(); // enable, tickint, cpu clock
        assert_eq!(s.next_event_in(), Some(1000));
        s.advance(999);
        assert_eq!(s.highest_pending(), None);
        s.advance(1);
        assert_eq!(s.highest_pending(), Some(exc::SYSTICK));
        assert_eq!(s.read(0xE000_E010, AccessSize::Word).unwrap() >> 16, 1);
        assert_eq!(s.read(0xE000_E010, AccessSize::Word).unwrap() >> 16, 0);
        assert_eq!(s.next_event_in(), Some(1000));
    }

    #[test]
    fn basepri_masks_lower_priority_interrupts() {
        let mut s = CortexM::new();
        s.write(0xE000_E100, AccessSize::Word, 0b11).unwrap();
        s.write(0xE000_E400, AccessSize::Byte, 0x50).unwrap(); // IRQ0 prio 5
        s.write(0xE000_E401, AccessSize::Byte, 0x20).unwrap(); // IRQ1 prio 2
        s.set_irq_pending(0);
        let mut regs = thread_regs(0x2000_1000);
        regs.basepri = 0x50;
        assert_eq!(s.exception_to_take(&regs), None);
        s.set_irq_pending(1);
        assert_eq!(s.exception_to_take(&regs), Some(17));
        regs.primask = 1;
        assert_eq!(s.exception_to_take(&regs), None);
        assert!(s.wakeup_pending(&regs));
    }

    #[test]
    fn entry_and_return_restore_context() {
        let mut s = CortexM::new();
        let mut ram = Ram(Memory::new(0, 0x1000, true));
        ram.0
            .load(4 * exc::SYSTICK as u32, &0x0000_0201u32.to_le_bytes())
            .unwrap();
        let mut regs = thread_regs(0x0FFC); // misaligned to 8 → realign
        regs.r = [
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 0x0FFC, 0x111, 0x300,
        ];
        regs.xpsr |= psr::C;
        let before = regs.clone();
        s.set_pending(exc::SYSTICK);
        s.exception_entry(&mut regs, &mut ram, exc::SYSTICK, 0x300)
            .unwrap();
        assert_eq!(regs.pc(), 0x200);
        assert_eq!(regs.r[14], 0xFFFF_FFF9);
        assert_eq!(regs.xpsr & psr::IPSR_MASK, exc::SYSTICK as u32);
        assert_eq!(regs.r[13], 0x0FF8 - 0x20);
        assert!(s.highest_pending().is_none());

        regs.r[0] = 0xDEAD;
        s.exception_return(&mut regs, &mut ram, 0xFFFF_FFF9)
            .unwrap();
        assert_eq!(regs.r, before.r);
        assert_eq!(regs.xpsr, before.xpsr);
        assert_eq!(regs.xpsr & psr::IPSR_MASK, 0);
    }

    #[test]
    fn freertos_style_psp_and_fp_frame() {
        let mut s = CortexM::new();
        let mut ram = Ram(Memory::new(0, 0x1000, true));
        ram.0
            .load(4 * exc::PENDSV as u32, &0x0000_0101u32.to_le_bytes())
            .unwrap();
        let mut regs = thread_regs(0x0800);
        regs.control = control::SPSEL | control::FPCA;
        regs.psp = 0x0F00;
        regs.r[13] = 0x0F00;
        regs.s[3] = 0x4049_0FDB; // pi
        regs.fpscr = 0x0300_0000;
        s.exception_entry(&mut regs, &mut ram, exc::PENDSV, 0x40)
            .unwrap();
        assert_eq!(regs.r[14], 0xFFFF_FFED);
        assert_eq!(regs.psp, 0x0F00 - 0x68);
        assert_eq!(regs.r[13], 0x0800, "handler runs on MSP");
        assert_eq!(regs.control & (control::SPSEL | control::FPCA), 0);
        regs.s[3] = 0;
        s.exception_return(&mut regs, &mut ram, 0xFFFF_FFED)
            .unwrap();
        assert_eq!(regs.s[3], 0x4049_0FDB);
        assert_eq!(regs.fpscr, 0x0300_0000);
        assert_eq!(regs.r[13], 0x0F00);
        assert_eq!(
            regs.control & (control::SPSEL | control::FPCA),
            control::SPSEL | control::FPCA
        );
    }

    #[test]
    fn fault_escalates_to_hardfault_then_lockup() {
        let mut s = CortexM::new();
        let mut regs = thread_regs(0x100);
        assert_eq!(s.raise_fault(Fault::UndefInstr, &regs), Ok(exc::HARD_FAULT));
        assert_ne!(s.hfsr & (1 << 30), 0);
        assert_ne!(s.cfsr & (1 << 16), 0);
        s.set_active(exc::HARD_FAULT, true);
        regs.xpsr |= exc::HARD_FAULT as u32;
        assert_eq!(s.raise_fault(Fault::UndefInstr, &regs), Err(Lockup));
    }
}
