//! Source-level debugging on the board: breakpoints by file and line,
//! stepping by instruction or source line (into, over, out of calls), the
//! call stack and variable values, from the firmware's DWARF information.

use std::collections::{BTreeSet, HashMap};

use simucleo_core::cpu::{RunResult, StopReason};
use simucleo_elf::debug::{DebugInfo, Frame, Value};

use crate::Nucleo;

/// How far to step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    /// One machine instruction.
    Instruction,
    /// To the next source line, entering calls.
    Into,
    /// To the next source line of this function, running calls to their end.
    Over,
    /// Until the current function returns.
    Out,
}

/// Why a step or a run-to stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StepEnd {
    /// It got where it was going.
    Done,
    /// A user breakpoint was hit on the way.
    Breakpoint,
    /// The firmware stopped (fault, lockup, …): see `diagnose`.
    Stopped(StopReason),
    /// It ran for too long without getting there (an endless loop).
    Limit,
}

/// Instructions a line step may take one at a time.
const STEP_LIMIT: u32 = 2_000_000;
/// Simulated time a step may run calls for.
const RUN_LIMIT_NS: f64 = 30e9;

#[derive(Default)]
pub(crate) struct DebugState {
    /// The ELF file, parsed for debug information on first use.
    pub elf: Option<std::rc::Rc<Vec<u8>>>,
    pub info: std::cell::OnceCell<Option<std::rc::Rc<DebugInfo>>>,
    /// User breakpoint addresses.
    pub breakpoints: BTreeSet<u32>,
    /// Conditions of conditional breakpoints, by address (several
    /// breakpoints may share one: it stops when any condition holds).
    pub conditions: HashMap<u32, Vec<String>>,
}

impl DebugState {
    pub fn new_firmware(&mut self, bytes: &[u8]) {
        self.elf = Some(std::rc::Rc::new(bytes.to_vec()));
        self.info = std::cell::OnceCell::new();
    }

    fn get(&self) -> Option<std::rc::Rc<DebugInfo>> {
        self.info
            .get_or_init(|| {
                self.elf
                    .as_ref()
                    .and_then(|b| DebugInfo::load(b))
                    .map(std::rc::Rc::new)
            })
            .clone()
    }
}

/// A breakpoint condition, if it has one (blank is none).
fn cond(c: &Option<String>) -> Option<&str> {
    c.as_deref().map(str::trim).filter(|c| !c.is_empty())
}

impl Nucleo {
    /// The firmware's debug information, if it has any.
    pub fn debug_info(&self) -> Option<std::rc::Rc<DebugInfo>> {
        self.debug.get()
    }

    /// Replace the user breakpoints (code addresses).
    pub fn set_breakpoints(&mut self, addrs: &[u32]) {
        let bps: Vec<(u32, Option<String>)> = addrs.iter().map(|&a| (a, None)).collect();
        self.set_conditional_breakpoints(&bps);
    }

    /// Replace the user breakpoints; one with a condition (a C expression)
    /// stops only when the condition is true there.
    pub fn set_conditional_breakpoints(&mut self, bps: &[(u32, Option<String>)]) {
        for a in std::mem::take(&mut self.debug.breakpoints) {
            self.cpu.remove_breakpoint(a);
        }
        self.debug.conditions.clear();
        // Several breakpoints may share an address (lines of one inlined
        // call): one without a condition makes it unconditional.
        let unconditional: BTreeSet<u32> = bps
            .iter()
            .filter(|(_, c)| cond(c).is_none())
            .map(|(a, _)| a & !1)
            .collect();
        for (a, c) in bps {
            let a = a & !1;
            self.cpu.add_breakpoint(a);
            self.debug.breakpoints.insert(a);
            if let Some(c) = cond(c).filter(|_| !unconditional.contains(&a)) {
                self.debug
                    .conditions
                    .entry(a)
                    .or_default()
                    .push(c.to_string());
            }
        }
    }

    /// Evaluate a C expression (variables, members, indexing, arithmetic,
    /// comparisons) in call-stack frame `frame`.
    pub fn evaluate(&self, expr: &str, frame: usize) -> Result<Value, String> {
        let info = self.debug.get().ok_or("no debug information")?;
        let frames = self.call_stack();
        let f = frames.get(frame).ok_or("no such frame")?;
        let read = |a: u32, n: usize| self.read_mem(a, n);
        info.evaluate(expr, f, &read)
    }

    /// Whether the user breakpoint at `addr`, just hit, should stop: it
    /// has no condition, its condition holds, or the condition cannot be
    /// evaluated (stopping shows the user why).
    pub fn breakpoint_stops(&self, addr: u32) -> bool {
        let Some(conds) = self.debug.conditions.get(&(addr & !1)) else {
            return true;
        };
        let Some(info) = self.debug.get() else {
            return true;
        };
        let frames = self.call_stack();
        let Some(f) = frames.first() else {
            return true;
        };
        let read = |a: u32, n: usize| self.read_mem(a, n);
        conds
            .iter()
            .any(|c| info.condition(c, f, &read).unwrap_or(true))
    }

    /// `run_for_ns` that goes on past conditional breakpoints whose
    /// condition is false.
    pub fn run_for_ns_debug(&mut self, ns: f64) -> RunResult {
        let end = self.time_ns() + ns;
        let mut cycles = 0;
        loop {
            let r = self.run_for_ns((end - self.time_ns()).max(0.0));
            cycles += r.cycles;
            match r.stop {
                // A false condition is no stop, even when the hit is right
                // at the end of the time budget (the next run resumes past
                // it).
                StopReason::Breakpoint(a) if !self.breakpoint_stops(a) => {
                    if self.time_ns() >= end {
                        return RunResult {
                            cycles,
                            stop: StopReason::BudgetExhausted,
                        };
                    }
                }
                stop => return RunResult { cycles, stop },
            }
        }
    }

    fn read_mem(&self, addr: u32, len: usize) -> Option<Vec<u8>> {
        (0..len as u32)
            .map(|i| self.peek_byte(addr.wrapping_add(i)))
            .collect()
    }

    /// The call stack, innermost first.
    pub fn call_stack(&self) -> Vec<Frame> {
        let Some(info) = self.debug.get() else {
            return Vec::new();
        };
        let r = self.cpu.registers();
        let read = |a: u32, n: usize| self.read_mem(a, n);
        info.unwind(r.r, r.msp, r.psp, &read)
    }

    /// Parameters and local variables of call-stack frame `frame`.
    pub fn locals(&self, frame: usize) -> Vec<Value> {
        let Some(info) = self.debug.get() else {
            return Vec::new();
        };
        let frames = self.call_stack();
        let Some(f) = frames.get(frame) else {
            return Vec::new();
        };
        let read = |a: u32, n: usize| self.read_mem(a, n);
        info.locals(f, &read)
    }

    /// File-scope variables declared in the given source files.
    pub fn globals(&self, files: &[u32]) -> Vec<Value> {
        let Some(info) = self.debug.get() else {
            return Vec::new();
        };
        let read = |a: u32, n: usize| self.read_mem(a, n);
        info.globals(files, &read)
    }

    /// Machine code around `addr`: up to `before` instructions before it
    /// and `after` from it, decoded from the start of the function so the
    /// instruction boundaries are right. Each comes with its source line.
    pub fn disassemble_around(
        &self,
        addr: u32,
        before: usize,
        after: usize,
    ) -> Vec<(simucleo_elf::disasm::Insn, Option<(u32, u32)>)> {
        let info = self.debug.get();
        let addr = addr & !1;
        let start = info
            .as_ref()
            .and_then(|i| i.function_at(addr).map(|f| f.low))
            .or_else(|| {
                self.firmware
                    .as_ref()
                    .and_then(|f| f.symbols.range(..=addr).next_back().map(|(a, _)| *a))
            })
            .filter(|s| addr - s < 0x4000)
            .unwrap_or(addr);
        let read = |a: u32, n: usize| self.read_mem(a, n);
        let symbols = self.firmware.as_ref().map(|f| &f.symbols);
        let symbol = |a: u32| symbols.and_then(|m| m.get(&(a & !1)).cloned());
        // From the function start to the address, then `after` more.
        let mut insns = Vec::new();
        let mut pc = start;
        while pc < addr {
            let Some(i) = simucleo_elf::disasm::disassemble(&read, pc, 1, &symbol).pop() else {
                break;
            };
            pc = i.addr + i.bytes.split(' ').count() as u32 * 2;
            insns.push(i);
        }
        let skip = insns.len().saturating_sub(before);
        let mut out: Vec<_> = insns.split_off(skip);
        out.extend(simucleo_elf::disasm::disassemble(&read, pc, after, &symbol));
        out.into_iter()
            .map(|i| {
                let loc = info.as_ref().and_then(|d| d.location(i.addr));
                (i, loc)
            })
            .collect()
    }

    fn pc(&self) -> u32 {
        self.cpu.registers().pc()
    }

    /// Execute one instruction (an exception entry counts as one).
    fn step_instruction(&mut self) -> Result<(), StopReason> {
        let pc = self.pc();
        for _ in 0..2 {
            let r = self.run(1);
            match r.stop {
                // Stopping at a breakpoint on the instruction we are on
                // does not move: go again.
                StopReason::Breakpoint(a) if a == pc => continue,
                StopReason::BudgetExhausted
                | StopReason::Breakpoint(_)
                | StopReason::Sleeping
                | StopReason::Yield => return Ok(()),
                other => return Err(other),
            }
        }
        Ok(())
    }

    /// Run until `addr` is reached (a temporary breakpoint) or a user
    /// breakpoint or stop gets in the way.
    fn run_to(&mut self, addr: u32) -> StepEnd {
        let addr = addr & !1;
        let temporary = !self.debug.breakpoints.contains(&addr);
        if temporary {
            self.cpu.add_breakpoint(addr);
        }
        let start = self.time_ns();
        let end = loop {
            let r = self.run_for_ns(10e6);
            match r.stop {
                StopReason::Breakpoint(a) if a == addr => break StepEnd::Done,
                StopReason::Breakpoint(a) if self.breakpoint_stops(a) => break StepEnd::Breakpoint,
                StopReason::Breakpoint(_)
                | StopReason::BudgetExhausted
                | StopReason::Sleeping
                | StopReason::Yield => {}
                other => break StepEnd::Stopped(other),
            }
            if self.time_ns() - start > RUN_LIMIT_NS {
                break StepEnd::Limit;
            }
        };
        if temporary {
            self.cpu.remove_breakpoint(addr);
        }
        end
    }

    /// Step by an instruction or a source line.
    pub fn step(&mut self, kind: Step) -> StepEnd {
        let Some(info) = self.debug.get() else {
            return match self.step_instruction() {
                Ok(()) => StepEnd::Done,
                Err(e) => StepEnd::Stopped(e),
            };
        };
        match kind {
            Step::Instruction => match self.step_instruction() {
                Ok(()) => StepEnd::Done,
                Err(e) => StepEnd::Stopped(e),
            },
            Step::Out => {
                let frames = self.call_stack();
                match frames.get(1) {
                    Some(caller) => self.run_to(caller.pc),
                    None => StepEnd::Limit,
                }
            }
            Step::Into | Step::Over => {
                let start = info.location(self.pc());
                let start_ipsr = self.cpu.registers().ipsr();
                let symbols: BTreeSet<u32> = self
                    .firmware
                    .as_ref()
                    .map(|f| f.symbols.keys().copied().collect())
                    .unwrap_or_default();
                for _ in 0..STEP_LIMIT {
                    if let Err(e) = self.step_instruction() {
                        return StepEnd::Stopped(e);
                    }
                    let pc = self.pc();
                    if self.debug.breakpoints.contains(&pc) && self.breakpoint_stops(pc) {
                        return StepEnd::Breakpoint;
                    }
                    let ipsr = self.cpu.registers().ipsr();
                    // A call or an interrupt: step over runs it to the end;
                    // step into does so only for code without line info.
                    let entered = symbols.contains(&pc) || (ipsr != start_ipsr && ipsr != 0);
                    if entered
                        && (kind == Step::Over || info.location(pc).is_none() || ipsr != start_ipsr)
                    {
                        let frames = self.call_stack();
                        if let Some(caller) = frames.get(1) {
                            match self.run_to(caller.pc) {
                                StepEnd::Done => {}
                                other => return other,
                            }
                        }
                    }
                    // A new line starts here (also right where a call
                    // returned to).
                    let pc = self.pc();
                    let here = info.location(pc);
                    if here.is_some() && here != start && info.is_statement(pc) {
                        return StepEnd::Done;
                    }
                }
                StepEnd::Limit
            }
        }
    }
}
