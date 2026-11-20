//! Simucleo's own Cortex-M4F (ARMv7E-M + FPv4-SP) interpreter.
//!
//! * [`thumb16`] / [`thumb32`] – instruction decode and execute
//! * [`dsp`] – DSP extension (SIMD, saturating, packing)
//! * [`fpu`] – single-precision floating point
//!
//! Timing is an approximation of the Cortex-M4 cycle counts (1 cycle per
//! instruction, +1 per data access, +2 for a taken branch, …); the simulator
//! is functionally accurate, not cycle-exact.

mod alu;
mod dsp;
mod fpu;
mod thumb16;
mod thumb32;

use std::collections::BTreeSet;

use simucleo_core::bus::{AccessSize, Bus, BusError};
use simucleo_core::cortexm::{control, exc, psr, CortexM, Fault, Lockup};
use simucleo_core::cpu::{CpuBackend, Registers, RunResult, StopReason, Watchpoint};
use simucleo_core::Cycles;

/// Cycles for exception entry and return (Cortex-M4: 12 each, without FP).
const EXCEPTION_ENTRY_CYCLES: u64 = 12;

/// Why an instruction did not complete normally.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Trap {
    Fault(Fault),
    Unimplemented(u32),
}

impl From<Fault> for Trap {
    fn from(f: Fault) -> Self {
        Trap::Fault(f)
    }
}

pub(crate) type Exec = Result<(), Trap>;

/// Bus plus system control space, as seen by one instruction.
pub(crate) struct Ctx<'a> {
    pub bus: &'a mut dyn Bus,
    pub sys: &'a mut CortexM,
}

#[derive(Debug, Default)]
pub struct ArmV7M {
    /// R0–R14 (R13 is the active stack pointer). R15 is `pc`.
    r: [u32; 16],
    /// Address of the next instruction to execute.
    pc: u32,
    n: bool,
    z: bool,
    c: bool,
    v: bool,
    q: bool,
    ge: u8,
    /// EPSR.IT
    it: u8,
    /// EPSR.T
    t: bool,
    ipsr: u16,
    /// Banked stack pointer that is *not* currently in r[13].
    other_sp: u32,
    primask: u32,
    basepri: u32,
    faultmask: u32,
    control: u32,
    s: [u32; 32],
    fpscr: u32,

    exclusive: Option<u32>,
    event: bool,
    sleeping: bool,
    /// The core sleeps in WFE (woken by events) rather than WFI.
    sleep_wfe: bool,

    breakpoints: BTreeSet<u32>,
    /// Breakpoint address we stopped at; it is skipped once on resume.
    resume_from_bp: Option<u32>,
    watchpoints: Vec<Watchpoint>,
    /// A data access that hit a watchpoint: (address, write). The core
    /// stops once the instruction is done.
    watch_hit: Option<(u32, bool)>,

    // Per-instruction scratch.
    next_pc: u32,
    cyc: u64,
    it_written: bool,
    svc: bool,
    exc_return: Option<u32>,
    /// The instruction accessed peripheral space (see `Bus::poll`).
    periph_touched: bool,
    /// The instruction branched to itself.
    self_loop: bool,
    /// The instruction was a taken backward branch.
    back_branch: bool,
    /// Number of stores so far (busy-wait detection).
    stores: u64,
    /// Number of FP instructions so far (busy-wait detection).
    fp_ops: u64,
    /// Busy-wait detection: state at the last visit of recent loop heads
    /// (a loop that calls a function has several backward branches).
    loop_watch: [Option<LoopWatch>; 4],
    loop_watch_next: usize,
}

/// Architectural state at a loop head, for busy-wait detection.
#[derive(Debug, Clone, PartialEq, Eq)]
struct LoopState {
    head: u32,
    r: [u32; 15],
    psr: u32,
    masks: [u32; 4],
    fpscr: u32,
}

#[derive(Debug, Clone)]
struct LoopWatch {
    state: LoopState,
    cycle: Cycles,
    stores: u64,
    fp_ops: u64,
    epoch: u64,
    time_reads: u64,
}

impl ArmV7M {
    pub fn new() -> Self {
        Self {
            t: true,
            ..Default::default()
        }
    }

    // ---------------------------------------------------------- registers

    #[inline]
    pub(crate) fn reg(&self, n: u32) -> u32 {
        if n == 15 {
            self.pc.wrapping_add(4)
        } else {
            self.r[n as usize]
        }
    }

    /// Write a register; R15 writes are `ALUWritePC` (simple branch).
    #[inline]
    pub(crate) fn set_reg(&mut self, n: u32, v: u32) {
        match n {
            15 => self.branch_write_pc(v),
            13 => self.r[13] = v & !3,
            _ => self.r[n as usize] = v,
        }
    }

    /// `Align(PC, 4)` as used by literal loads and ADR.
    #[inline]
    pub(crate) fn pc_aligned(&self) -> u32 {
        self.pc.wrapping_add(4) & !3
    }

    pub(crate) fn branch_write_pc(&mut self, addr: u32) {
        self.next_pc = addr & !1;
        self.self_loop = self.next_pc == self.pc;
        self.back_branch = self.next_pc < self.pc;
        self.cyc += 2;
    }

    /// `BXWritePC` / `LoadWritePC`: interworking branch, or exception return
    /// when an EXC_RETURN value is written in Handler mode.
    pub(crate) fn bx_write_pc(&mut self, addr: u32) {
        if self.ipsr != 0 && addr >> 28 == 0xF {
            self.exc_return = Some(addr);
            self.cyc += 2;
            return;
        }
        self.t = addr & 1 != 0;
        self.next_pc = addr & !1;
        self.back_branch = self.next_pc < self.pc;
        self.cyc += 2;
    }

    #[inline]
    pub(crate) fn in_it_block(&self) -> bool {
        self.it & 0xF != 0
    }

    #[inline]
    pub(crate) fn set_nz(&mut self, v: u32) {
        self.n = v >> 31 != 0;
        self.z = v == 0;
    }

    #[inline]
    pub(crate) fn set_nzcv(&mut self, v: u32, c: bool, ov: bool) {
        self.set_nz(v);
        self.c = c;
        self.v = ov;
    }

    pub(crate) fn cond_passed(&self, cond: u32) -> bool {
        let r = match cond >> 1 {
            0 => self.z,
            1 => self.c,
            2 => self.n,
            3 => self.v,
            4 => self.c && !self.z,
            5 => self.n == self.v,
            6 => self.n == self.v && !self.z,
            _ => true,
        };
        if cond & 1 != 0 && cond != 0xF {
            !r
        } else {
            r
        }
    }

    fn apsr(&self) -> u32 {
        (self.n as u32) << 31
            | (self.z as u32) << 30
            | (self.c as u32) << 29
            | (self.v as u32) << 28
            | (self.q as u32) << 27
            | (self.ge as u32) << psr::GE_SHIFT
    }

    fn set_apsr(&mut self, v: u32) {
        self.n = v & psr::N != 0;
        self.z = v & psr::Z != 0;
        self.c = v & psr::C != 0;
        self.v = v & psr::V != 0;
        self.q = v & psr::Q != 0;
        self.ge = ((v >> psr::GE_SHIFT) & 0xF) as u8;
    }

    fn xpsr(&self) -> u32 {
        let x = self.apsr() | self.ipsr as u32 | if self.t { psr::T } else { 0 };
        psr::with_it(x, self.it)
    }

    /// Is the process stack (PSP) the one in r[13]?
    fn psp_active(&self) -> bool {
        self.ipsr == 0 && self.control & control::SPSEL != 0
    }

    pub(crate) fn msp(&self) -> u32 {
        if self.psp_active() {
            self.other_sp
        } else {
            self.r[13]
        }
    }

    pub(crate) fn psp(&self) -> u32 {
        if self.psp_active() {
            self.r[13]
        } else {
            self.other_sp
        }
    }

    pub(crate) fn set_msp(&mut self, v: u32) {
        if self.psp_active() {
            self.other_sp = v & !3;
        } else {
            self.r[13] = v & !3;
        }
    }

    pub(crate) fn set_psp(&mut self, v: u32) {
        if self.psp_active() {
            self.r[13] = v & !3;
        } else {
            self.other_sp = v & !3;
        }
    }

    /// Write CONTROL, re-banking SP if SPSEL changes (Thread mode only).
    pub(crate) fn write_control(&mut self, v: u32) {
        let (msp, psp) = (self.msp(), self.psp());
        let mut mask = control::NPRIV | control::FPCA;
        if self.ipsr == 0 {
            mask |= control::SPSEL;
        }
        self.control = (self.control & !mask) | (v & mask);
        self.load_sp_banks(msp, psp);
    }

    fn load_sp_banks(&mut self, msp: u32, psp: u32) {
        if self.psp_active() {
            self.r[13] = psp;
            self.other_sp = msp;
        } else {
            self.r[13] = msp;
            self.other_sp = psp;
        }
    }

    pub(crate) fn privileged(&self) -> bool {
        self.ipsr != 0 || self.control & control::NPRIV == 0
    }

    // ------------------------------------------------------------- memory

    #[inline]
    pub(crate) fn read(&mut self, ctx: &mut Ctx, addr: u32, size: AccessSize) -> Result<u32, Trap> {
        self.cyc += 1;
        if addr >= 0xE000_0000 {
            return Ok(ctx.sys.read(addr, size).unwrap_or(0));
        }
        if addr >= 0x4000_0000 {
            self.periph_touched = true;
        }
        let v = ctx
            .bus
            .read(addr, size)
            .map_err(|_| Trap::Fault(Fault::PreciseBus { addr }))?;
        if !self.watchpoints.is_empty() {
            self.check_watch(addr, size, false);
        }
        if ctx.sys.trace_data {
            self.trace_data(ctx, addr, size, v, false);
        }
        Ok(v)
    }

    /// Note a data access that hits a watchpoint (the first one counts).
    fn check_watch(&mut self, addr: u32, size: AccessSize, write: bool) {
        if self.watch_hit.is_none()
            && self
                .watchpoints
                .iter()
                .any(|w| w.hits(addr, size.bytes(), write))
        {
            self.watch_hit = Some((addr, write));
        }
    }

    #[inline]
    pub(crate) fn write(&mut self, ctx: &mut Ctx, addr: u32, size: AccessSize, value: u32) -> Exec {
        self.cyc += 1;
        self.stores += 1;
        if addr >= 0xE000_0000 {
            return ctx
                .sys
                .write(addr, size, value)
                .map_err(|_| Trap::Fault(Fault::PreciseBus { addr }));
        }
        if addr >= 0x4000_0000 {
            self.periph_touched = true;
        }
        ctx.bus
            .write(addr, size, value)
            .map_err(|_| Trap::Fault(Fault::PreciseBus { addr }))?;
        if !self.watchpoints.is_empty() {
            self.check_watch(addr, size, true);
        }
        if ctx.sys.trace_data {
            self.trace_data(ctx, addr, size, value, true);
        }
        Ok(())
    }

    /// A data access for the DWT's data trace comparators.
    #[cold]
    fn trace_data(&self, ctx: &mut Ctx, addr: u32, size: AccessSize, value: u32, write: bool) {
        let bytes = size.bytes();
        let value = if bytes == 4 {
            value
        } else {
            value & ((1u32 << (8 * bytes)) - 1)
        };
        let (demcr, cycle) = (ctx.sys.demcr, ctx.sys.cycles);
        ctx.sys
            .trace
            .data_access(demcr, cycle, addr, bytes as u8, value, write, self.pc);
    }

    /// Unaligned word/halfword accesses are allowed unless CCR.UNALIGN_TRP.
    pub(crate) fn check_unaligned(&self, ctx: &Ctx, addr: u32, size: AccessSize) -> Exec {
        if addr & (size.bytes() - 1) != 0 && ctx.sys.ccr & (1 << 3) != 0 {
            return Err(Fault::Unaligned.into());
        }
        Ok(())
    }

    /// LDM/STM/LDRD/STRD/LDREX and friends always require alignment.
    pub(crate) fn check_aligned(&self, addr: u32, size: u32) -> Exec {
        if addr & (size - 1) != 0 {
            return Err(Fault::Unaligned.into());
        }
        Ok(())
    }

    pub(crate) fn read_u32(&mut self, ctx: &mut Ctx, addr: u32) -> Result<u32, Trap> {
        self.read(ctx, addr, AccessSize::Word)
    }

    pub(crate) fn write_u32(&mut self, ctx: &mut Ctx, addr: u32, value: u32) -> Exec {
        self.write(ctx, addr, AccessSize::Word, value)
    }

    fn fetch16(&mut self, ctx: &mut Ctx, addr: u32) -> Result<u32, Trap> {
        ctx.bus
            .read(addr, AccessSize::Half)
            .map_err(|_| Trap::Fault(Fault::InstructionBus { addr }))
    }

    // ---------------------------------------------------------- execution

    /// Execute one instruction at `self.pc`.
    fn step(&mut self, ctx: &mut Ctx) -> Exec {
        let pc = self.pc;
        if !self.t {
            return Err(Fault::InvState.into());
        }
        let hw1 = self.fetch16(ctx, pc)?;
        let wide = hw1 >> 11 >= 0b11101;
        let hw2 = if wide {
            self.fetch16(ctx, pc.wrapping_add(2))?
        } else {
            0
        };
        self.next_pc = pc.wrapping_add(if wide { 4 } else { 2 });
        self.cyc = 1;
        self.it_written = false;

        let in_it = self.in_it_block();
        if !in_it || self.cond_passed((self.it >> 4) as u32) {
            if wide {
                self.exec32(ctx, hw1, hw2)?;
            } else {
                self.exec16(ctx, hw1)?;
            }
        }
        if in_it && !self.it_written {
            self.it = if self.it & 0x7 == 0 {
                0
            } else {
                (self.it & 0xE0) | ((self.it << 1) & 0x1F)
            };
        }
        self.pc = self.next_pc;
        Ok(())
    }

    /// Busy-wait elision. At a taken backward branch, compare the state with
    /// the previous visit of the same loop head. If nothing changed — same
    /// registers, flags and masks, no store and no FP instruction in
    /// between — the next iteration is identical, and so is every one after
    /// it until something outside the loop changes: an interrupt, a
    /// peripheral event (the machine's deadline, `end`) or the SysTick
    /// counter. Skip whole iterations up to that point. This is what makes
    /// `HAL_Delay()` and flag-polling loops cheap; their observable
    /// behaviour (including when they exit) is unchanged.
    fn watch_loop(&mut self, ctx: &mut Ctx, end: Cycles) {
        let mut r = [0u32; 15];
        r.copy_from_slice(&self.r[..15]);
        let state = LoopState {
            head: self.pc,
            r,
            psr: self.apsr() | self.it as u32,
            masks: [self.primask, self.basepri, self.faultmask, self.control],
            fpscr: self.fpscr,
        };
        let now = ctx.sys.cycles;
        let slot = self
            .loop_watch
            .iter()
            .position(|w| w.as_ref().is_some_and(|w| w.state.head == state.head));
        if let Some(w) = slot.and_then(|i| self.loop_watch[i].as_ref()) {
            // `epoch` changes whenever something outside the CPU changed
            // (SysTick wrapped, an interrupt became pending): an iteration
            // that straddles such a change may still be about to see it.
            let steady = w.state == state
                && w.stores == self.stores
                && w.fp_ops == self.fp_ops
                && w.epoch == ctx.sys.epoch
                && w.time_reads == ctx.sys.time_reads;
            let period = now - w.cycle;
            if steady && period > 0 && !Self::has_pending(ctx.sys) {
                let mut limit = end;
                if let Some(dt) = ctx.sys.next_change_in() {
                    limit = limit.min(now + dt);
                }
                if limit > now {
                    let n = (limit - now) / period;
                    if n > 0 {
                        ctx.sys.advance(n * period);
                    }
                }
            }
        }
        let watch = LoopWatch {
            state,
            cycle: ctx.sys.cycles,
            stores: self.stores,
            fp_ops: self.fp_ops,
            epoch: ctx.sys.epoch,
            time_reads: ctx.sys.time_reads,
        };
        let i = slot.unwrap_or_else(|| {
            let i = self.loop_watch_next;
            self.loop_watch_next = (i + 1) % self.loop_watch.len();
            i
        });
        self.loop_watch[i] = Some(watch);
    }

    /// Take exception `number`, resuming later at `self.pc`.
    fn take_exception(&mut self, ctx: &mut Ctx, number: u16) -> Result<(), Lockup> {
        let mut regs = self.registers();
        let ret = self.pc;
        ctx.sys.exception_entry(&mut regs, ctx.bus, number, ret)?;
        self.set_registers(&regs);
        self.loop_watch = Default::default();
        self.exclusive = None;
        self.event = true;
        self.sleeping = false;
        Ok(())
    }

    fn do_exception_return(&mut self, ctx: &mut Ctx, value: u32) -> Result<(), Fault> {
        let mut regs = self.registers();
        ctx.sys.exception_return(&mut regs, ctx.bus, value)?;
        self.set_registers(&regs);
        self.loop_watch = Default::default();
        self.exclusive = None;
        self.event = true;
        // SLEEPONEXIT: go back to sleep when returning to Thread mode.
        if self.ipsr == 0 && ctx.sys.scr & 0b10 != 0 {
            self.sleeping = true;
        }
        Ok(())
    }

    /// Handle a synchronous fault at `self.pc` (the faulting instruction).
    fn fault(&mut self, ctx: &mut Ctx, fault: Fault) -> Result<(), Lockup> {
        let regs = self.registers();
        let n = ctx.sys.raise_fault(fault, &regs)?;
        self.take_exception(ctx, n)
    }

    #[inline]
    fn has_pending(sys: &CortexM) -> bool {
        sys.any_pending()
    }
}

impl CpuBackend for ArmV7M {
    fn name(&self) -> &'static str {
        "rust"
    }

    fn reset(&mut self, bus: &mut dyn Bus, sys: &mut CortexM) -> Result<(), BusError> {
        sys.reset();
        let msp = bus.read(sys.vtor, AccessSize::Word)?;
        let reset_vector = bus.read(sys.vtor + 4, AccessSize::Word)?;
        // Debugger state survives a reset of the core.
        let bps = std::mem::take(&mut self.breakpoints);
        let wps = std::mem::take(&mut self.watchpoints);
        *self = Self::new();
        self.breakpoints = bps;
        self.watchpoints = wps;
        self.r[13] = msp & !3;
        self.r[14] = 0xFFFF_FFFF;
        self.pc = reset_vector & !1;
        self.t = reset_vector & 1 != 0;
        Ok(())
    }

    fn run(&mut self, bus: &mut dyn Bus, sys: &mut CortexM, max_cycles: Cycles) -> RunResult {
        let start = sys.cycles;
        let end = start.saturating_add(max_cycles);
        let mut ctx = Ctx { bus, sys };
        // Peripheral events may have happened since the last call.
        self.loop_watch = Default::default();
        let result = |ctx: &Ctx, stop| RunResult {
            cycles: ctx.sys.cycles - start,
            stop,
        };

        loop {
            // A watchpoint hit by the last instruction (or exception entry).
            if let Some((addr, write)) = self.watch_hit.take() {
                return result(&ctx, StopReason::Watchpoint { addr, write });
            }
            if ctx.sys.cycles >= end {
                return result(&ctx, StopReason::BudgetExhausted);
            }

            // Exceptions are taken at instruction boundaries.
            if Self::has_pending(ctx.sys) {
                let regs = self.registers();
                if let Some(n) = ctx.sys.exception_to_take(&regs) {
                    if self.take_exception(&mut ctx, n).is_err() {
                        return result(&ctx, StopReason::Lockup { pc: self.pc });
                    }
                    ctx.sys.advance(EXCEPTION_ENTRY_CYCLES);
                    continue;
                }
                if self.sleeping && ctx.sys.wakeup_pending(&regs) {
                    self.sleeping = false;
                }
            }

            if self.sleeping && ctx.sys.take_event() {
                if self.sleep_wfe {
                    self.sleeping = false;
                    continue;
                }
                self.event = true; // WFI ignores it; a later WFE will not
            }

            if self.sleeping {
                ctx.sys.trace.pc = None; // PC samples while asleep
                match ctx.sys.next_event_in() {
                    Some(dt) => {
                        ctx.sys.advance(dt.min(end - ctx.sys.cycles));
                        continue;
                    }
                    None => return result(&ctx, StopReason::Sleeping),
                }
            }

            if self.breakpoints.contains(&self.pc) && self.resume_from_bp != Some(self.pc) {
                self.resume_from_bp = Some(self.pc);
                return result(&ctx, StopReason::Breakpoint(self.pc));
            }
            self.resume_from_bp = None;

            ctx.bus.set_time(ctx.sys.cycles);
            ctx.sys.trace.pc = Some(self.pc);
            self.svc = false;
            self.exc_return = None;
            self.periph_touched = false;
            self.self_loop = false;
            self.back_branch = false;
            let step = self.step(&mut ctx);
            // Peripheral state may have changed: forward IRQ lines at once so
            // an interrupt the instruction enabled is taken before the next.
            if self.periph_touched && ctx.bus.poll(ctx.sys) {
                if step.is_ok() {
                    ctx.sys.advance(self.cyc);
                }
                return result(&ctx, StopReason::Yield);
            }
            match step {
                Ok(()) => {
                    ctx.sys.advance(self.cyc);
                    if ctx.sys.reset_requested {
                        return result(&ctx, StopReason::ResetRequested);
                    }
                    if self.self_loop && !self.in_it_block() {
                        // `b .`: nothing changes until an interrupt arrives.
                        let regs = self.registers();
                        if ctx.sys.execution_priority(&regs) <= 0 {
                            return result(&ctx, StopReason::Halted { pc: self.pc });
                        }
                        // Interruptible idle loop: sleep like WFI so time
                        // fast-forwards instead of spinning.
                        self.sleeping = true;
                        self.sleep_wfe = false;
                    } else if self.back_branch && !self.in_it_block() {
                        self.watch_loop(&mut ctx, end);
                    }
                    if self.svc {
                        let regs = self.registers();
                        let taken = ctx
                            .sys
                            .svc(&regs)
                            .and_then(|n| self.take_exception(&mut ctx, n));
                        if taken.is_err() {
                            return result(&ctx, StopReason::Lockup { pc: self.pc });
                        }
                        ctx.sys.advance(EXCEPTION_ENTRY_CYCLES);
                    }
                    if let Some(value) = self.exc_return {
                        if let Err(f) = self.do_exception_return(&mut ctx, value) {
                            if self.fault(&mut ctx, f).is_err() {
                                return result(&ctx, StopReason::Lockup { pc: self.pc });
                            }
                        }
                        ctx.sys.advance(EXCEPTION_ENTRY_CYCLES - 2);
                    }
                }
                Err(Trap::Fault(f)) => {
                    ctx.sys.advance(self.cyc);
                    if self.fault(&mut ctx, f).is_err() {
                        return result(&ctx, StopReason::Lockup { pc: self.pc });
                    }
                    ctx.sys.advance(EXCEPTION_ENTRY_CYCLES);
                }
                Err(Trap::Unimplemented(opcode)) => {
                    return result(
                        &ctx,
                        StopReason::Unimplemented {
                            pc: self.pc,
                            opcode,
                        },
                    );
                }
            }
        }
    }

    fn registers(&self) -> Registers {
        let mut r = self.r;
        r[15] = self.pc;
        Registers {
            r,
            xpsr: self.xpsr(),
            msp: self.msp(),
            psp: self.psp(),
            primask: self.primask,
            basepri: self.basepri,
            faultmask: self.faultmask,
            control: self.control,
            s: self.s,
            fpscr: self.fpscr,
        }
    }

    fn set_registers(&mut self, regs: &Registers) {
        self.r = regs.r;
        self.pc = regs.r[15] & !1;
        self.set_apsr(regs.xpsr);
        self.ipsr = (regs.xpsr & psr::IPSR_MASK) as u16;
        self.t = regs.xpsr & psr::T != 0;
        self.it = psr::it(regs.xpsr);
        self.primask = regs.primask & 1;
        self.basepri = regs.basepri & 0xFF;
        self.faultmask = regs.faultmask & 1;
        self.control = regs.control & 0b111;
        self.s = regs.s;
        self.fpscr = regs.fpscr;
        // r[13] is authoritative for the active bank.
        if self.psp_active() {
            self.other_sp = regs.msp;
        } else {
            self.other_sp = regs.psp;
        }
    }

    fn add_breakpoint(&mut self, addr: u32) {
        self.breakpoints.insert(addr & !1);
    }

    fn remove_breakpoint(&mut self, addr: u32) {
        self.breakpoints.remove(&(addr & !1));
    }

    fn set_watchpoints(&mut self, watchpoints: &[Watchpoint]) {
        self.watchpoints = watchpoints.to_vec();
        self.watch_hit = None;
    }
}

/// Exception number names for diagnostics.
pub fn exception_name(n: u16) -> String {
    exc::name(n)
}
