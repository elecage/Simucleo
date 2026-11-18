//! The Nucleo-F401RE as a whole machine.
//!
//! [`Nucleo`] owns the CPU backend, the STM32F401 bus and the Cortex-M system
//! block, loads firmware and advances simulated time. It also knows the
//! board around the MCU (the B1 button pull-up, the ST-LINK virtual COM
//! port on USART2) and explains why firmware stopped ([`Diagnosis`]).

mod diagnose;

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use simucleo_core::bus::Bus;
use simucleo_core::cortexm::CortexM;
use simucleo_core::cpu::{CpuBackend, RunResult, StopReason};
use simucleo_core::Cycles;
use simucleo_cpu_armv7m::ArmV7M;
use simucleo_elf::{ElfError, FirmwareImage};
use simucleo_periph_stm32f4::gpio::PinDrive;
use simucleo_periph_stm32f4::rcc::ResetCause;
use simucleo_periph_stm32f4::{ExternalCircuit, Stm32f401Bus};
use thiserror::Error;

pub use diagnose::{Diagnosis, FaultInfo};
pub use simucleo_circuit::netlist::{BusCatalog, Circuit};
pub use simucleo_circuit::sim::{CircuitSim, Drive, PartVisual};
pub use simucleo_periph_stm32f4::gpio::PinEvent;
pub use simucleo_periph_stm32f4::usart::TerminalByte;
pub use simucleo_periph_stm32f4::Warning;

/// USART2 is wired to the ST-LINK virtual COM port.
pub const VCP: usize = 1;

#[derive(Debug, Error)]
pub enum LoadError {
    #[error(transparent)]
    Elf(#[from] ElfError),
    #[error("segment at {addr:#010x} ({len} bytes) does not fit in flash or SRAM")]
    Placement { addr: u32, len: usize },
    #[error("cannot read the vector table: {0}")]
    VectorTable(simucleo_core::bus::BusError),
}

/// A stretch of simulated time with a constant core clock.
#[derive(Debug, Clone, Copy)]
struct Segment {
    cycle: Cycles,
    ns: f64,
    hz: u32,
}

/// Connects the circuit simulation to the bus.
struct CircuitLink(Rc<RefCell<CircuitSim>>);

impl ExternalCircuit for CircuitLink {
    fn pins(&self) -> Vec<(u8, u8)> {
        self.0.borrow().mcu_pins()
    }

    fn update(&mut self, time: Cycles, drives: &[PinDrive]) -> Option<Vec<Option<bool>>> {
        let d: Vec<Drive> = drives
            .iter()
            .map(|d| match d {
                PinDrive::High => Drive::High,
                PinDrive::Low => Drive::Low,
                PinDrive::PullUp => Drive::PullUp,
                PinDrive::PullDown => Drive::PullDown,
                PinDrive::Float => Drive::Float,
            })
            .collect();
        self.0.borrow_mut().update(time, &d)
    }
}

pub struct Nucleo {
    pub cpu: Box<dyn CpuBackend>,
    pub bus: Stm32f401Bus,
    pub sys: CortexM,
    pub firmware: Option<FirmwareImage>,
    resets: u32,
    timeline: Vec<Segment>,
    /// Everything wired to the board, plus LD2 and B1.
    circuit: Rc<RefCell<CircuitSim>>,
}

impl Default for Nucleo {
    fn default() -> Self {
        Self::new()
    }
}

impl Nucleo {
    /// A board with the built-in Rust CPU core.
    pub fn new() -> Self {
        Self::with_backend(Box::new(ArmV7M::new()))
    }

    pub fn with_backend(cpu: Box<dyn CpuBackend>) -> Self {
        let mut board = Self {
            cpu,
            bus: Stm32f401Bus::new(),
            sys: CortexM::new(),
            firmware: None,
            resets: 0,
            timeline: Vec::new(),
            circuit: Rc::new(RefCell::new(CircuitSim::new(
                &Circuit::default(),
                &BusCatalog::default(),
                &HashMap::new(),
                0,
            ))),
        };
        board.power_on();
        board
    }

    /// Fresh chip state plus the board wiring around it.
    fn power_on(&mut self) {
        self.bus = Stm32f401Bus::new();
        // The circuit (LD2, B1 with its pull-up, and anything wired to the
        // headers) sees the chip's reset pin states.
        self.circuit.borrow_mut().reset_time(self.sys.cycles);
        self.bus.set_time(self.sys.cycles);
        self.bus
            .set_circuit(Some(Box::new(CircuitLink(self.circuit.clone()))));
        self.timeline = vec![Segment {
            cycle: self.sys.cycles,
            ns: self.time_ns(),
            hz: self.bus.clocks().hclk,
        }];
    }

    /// Program an ELF image into flash and power the board up.
    pub fn load_elf(&mut self, bytes: &[u8]) -> Result<(), LoadError> {
        let fw = FirmwareImage::parse(bytes)?;
        self.sys = CortexM::new();
        self.timeline.clear();
        self.power_on();
        for seg in &fw.segments {
            self.bus
                .load(seg.addr, &seg.data)
                .map_err(|_| LoadError::Placement {
                    addr: seg.addr,
                    len: seg.data.len(),
                })?;
        }
        self.firmware = Some(fw);
        self.resets = 0;
        self.cpu
            .reset(&mut self.bus, &mut self.sys)
            .map_err(LoadError::VectorTable)
    }

    /// Press the reset button (B2): CPU and peripherals reset; SRAM, flash
    /// and the backup domain keep their contents.
    pub fn reset(&mut self) -> Result<(), simucleo_core::bus::BusError> {
        self.system_reset(ResetCause::Pin)
    }

    fn system_reset(&mut self, cause: ResetCause) -> Result<(), simucleo_core::bus::BusError> {
        self.bus.system_reset(cause);
        self.note_clock();
        self.cpu.reset(&mut self.bus, &mut self.sys)
    }

    /// Current simulated time in core clock cycles.
    pub fn now(&self) -> Cycles {
        self.sys.cycles
    }

    /// Current core clock (HCLK) in Hz.
    pub fn clock_hz(&self) -> u32 {
        self.bus.clocks().hclk
    }

    /// Simulated time in nanoseconds of a cycle count (clock changes are
    /// taken into account).
    pub fn ns_at(&self, cycle: Cycles) -> f64 {
        let seg = self
            .timeline
            .iter()
            .rev()
            .find(|s| s.cycle <= cycle)
            .or(self.timeline.first());
        match seg {
            Some(s) => s.ns + (cycle as f64 - s.cycle as f64) * 1e9 / s.hz as f64,
            None => cycle as f64 * 1e9 / self.bus.clocks().hclk as f64,
        }
    }

    /// Current simulated time in nanoseconds.
    pub fn time_ns(&self) -> f64 {
        self.ns_at(self.sys.cycles)
    }

    fn note_clock(&mut self) {
        let hz = self.bus.clocks().hclk;
        if self.timeline.last().map(|s| s.hz) != Some(hz) {
            let ns = self.time_ns();
            self.timeline.push(Segment {
                cycle: self.sys.cycles,
                ns,
                hz,
            });
        }
    }

    /// Run for up to `cycles` core cycles. Peripheral events happen on time
    /// and sleeping (WFI/WFE or an idle `b .` loop) is fast-forwarded.
    pub fn run(&mut self, cycles: Cycles) -> RunResult {
        let end = self.sys.cycles.saturating_add(cycles);
        self.run_until(end, None)
    }

    /// Run for a simulated duration. The deadline is kept in nanoseconds, so
    /// it holds even when the firmware changes the core clock mid-way.
    pub fn run_for_ns(&mut self, ns: f64) -> RunResult {
        let target = self.time_ns() + ns;
        self.run_until(Cycles::MAX, Some(target))
    }

    fn run_until(&mut self, end_cycles: Cycles, end_ns: Option<f64>) -> RunResult {
        let start = self.sys.cycles;
        let mut sleeping = false;
        loop {
            let now = self.sys.cycles;
            // Re-derive the cycle deadline from the time deadline each round:
            // the clock may have changed (clock changes always end a round).
            let mut end = end_cycles;
            if let Some(t) = end_ns {
                let left = t - self.time_ns();
                end = if left <= 0.0 {
                    now
                } else {
                    end.min(now + ((left * self.clock_hz() as f64 / 1e9).ceil() as Cycles).max(1))
                };
            }
            if now >= end {
                let stop = if sleeping {
                    StopReason::Sleeping
                } else {
                    StopReason::BudgetExhausted
                };
                return RunResult {
                    cycles: now - start,
                    stop,
                };
            }
            let until = self
                .bus
                .next_deadline()
                .unwrap_or(Cycles::MAX)
                .clamp(now + 1, end);
            let r = self.cpu.run(&mut self.bus, &mut self.sys, until - now);
            self.after_step();
            sleeping = false;
            match r.stop {
                StopReason::BudgetExhausted | StopReason::Yield => {}
                StopReason::Sleeping => {
                    // Only a peripheral can wake the core: skip to its event.
                    let target = self.bus.next_deadline().map_or(end, |d| d.min(end));
                    if target > self.sys.cycles {
                        self.sys.advance(target - self.sys.cycles);
                    }
                    self.after_step();
                    sleeping = true;
                }
                StopReason::ResetRequested => {
                    self.sys.reset_requested = false;
                    self.resets += 1;
                    if self.system_reset(ResetCause::Software).is_err() {
                        return RunResult {
                            cycles: self.sys.cycles - start,
                            stop: StopReason::Lockup { pc: 0 },
                        };
                    }
                }
                stop => {
                    return RunResult {
                        cycles: self.sys.cycles - start,
                        stop,
                    }
                }
            }
        }
    }

    /// Process due peripheral events and forward interrupt lines.
    fn after_step(&mut self) {
        self.bus.run_events(self.sys.cycles);
        self.bus.poll(&mut self.sys);
        self.note_clock();
    }

    /// Level of a GPIO pin, e.g. `pin('A', 5)` for LD2.
    pub fn pin(&self, port: char, pin: u8) -> bool {
        let idx = (port.to_ascii_uppercase() as u8 - b'A') as usize;
        self.bus.gpio[idx].level(pin)
    }

    /// Press (`true`) or release the blue user button B1 (PC13, active low).
    pub fn set_user_button(&mut self, pressed: bool) {
        self.press("B1", pressed);
    }

    /// Press or release a switch: a `tact-switch` part of the circuit, or
    /// `"B1"`. A resulting interrupt is pending at once.
    pub fn press(&mut self, part: &str, pressed: bool) {
        let now = self.sys.cycles;
        if self.circuit.borrow_mut().set_pressed(part, pressed, now) {
            self.circuit_changed();
        }
    }

    fn circuit_changed(&mut self) {
        self.bus.set_time(self.sys.cycles);
        self.bus.circuit_changed();
        self.bus.poll(&mut self.sys);
    }

    /// Wire up an external circuit (hot-plug allowed while running).
    /// `catalog` holds the internal buses of each part kind and `signals`
    /// maps the board's pin ids (`"D13"`) to MCU signals (`"PA5"`).
    pub fn set_circuit(
        &mut self,
        circuit: &Circuit,
        catalog: &BusCatalog,
        signals: &HashMap<String, String>,
    ) {
        let now = self.sys.cycles;
        {
            let mut c = self.circuit.borrow_mut();
            c.set_catalog(catalog, signals);
            c.set_circuit(circuit, now);
        }
        self.circuit_changed();
    }

    /// What each part shows over the display frame that ends now;
    /// `seconds` is the frame's simulated length.
    pub fn circuit_frame(&mut self, seconds: f64) -> Vec<PartVisual> {
        self.circuit
            .borrow_mut()
            .end_frame(self.sys.cycles, seconds)
    }

    /// Electrical-rule violations found so far (LED without resistor, …).
    pub fn circuit_warnings(&self) -> Vec<String> {
        self.circuit.borrow().warnings.iter().cloned().collect()
    }

    /// Voltage on the net of a pin (`part`, `pin`), for probes.
    pub fn voltage(&self, part: &str, pin: &str) -> Option<f64> {
        self.circuit
            .borrow()
            .voltage(&simucleo_circuit::netlist::PinRef::new(part, pin))
    }

    /// Drive a pin from outside (`port` 0 = A): `Some(level)`, or `None` to
    /// let it float. An interrupt this causes (EXTI) is pending at once, so
    /// a sleeping core wakes up.
    pub fn drive_pin(&mut self, port: usize, pin: u8, level: Option<bool>) {
        self.bus.set_time(self.sys.cycles);
        self.bus.set_external(port, pin, level);
        self.bus.poll(&mut self.sys);
    }

    /// Take the pin level changes recorded since the last call.
    pub fn take_pin_events(&mut self) -> Vec<PinEvent> {
        std::mem::take(&mut self.bus.pin_events)
    }

    /// Bytes the ST-LINK virtual COM port received from USART2.
    pub fn take_console(&mut self) -> Vec<TerminalByte> {
        self.bus.terminal_take(VCP)
    }

    /// Type into the virtual COM port (delivered at the UART's baud rate).
    pub fn console_send(&mut self, bytes: &[u8]) {
        self.bus.terminal_send(VCP, bytes);
    }

    /// Number of software resets (SYSRESETREQ) performed so far.
    pub fn software_resets(&self) -> u32 {
        self.resets
    }

    /// Read memory for a debugger view without disturbing the simulation
    /// (no peripheral read side effects). Unmapped bytes read as `None`.
    pub fn peek_byte(&self, addr: u32) -> Option<u8> {
        if addr >= 0xE000_0000 {
            return Some(self.sys.peek(addr, simucleo_core::bus::AccessSize::Byte) as u8);
        }
        self.bus
            .peek(addr, simucleo_core::bus::AccessSize::Byte)
            .map(|v| v as u8)
    }

    /// Name of the function containing `addr` (nearest symbol at or below).
    pub fn symbol_at(&self, addr: u32) -> Option<&str> {
        let fw = self.firmware.as_ref()?;
        fw.symbols
            .range(..=addr & !1)
            .next_back()
            .map(|(_, n)| n.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use simucleo_core::bus::Bus;

    /// Reset handler: count boots in SRAM[0]; on the first boot request a
    /// reset (AIRCR = 0x05FA0004; DSB) and then write 0xAA to SRAM[4], which
    /// must never execute. Assembled from:
    ///   ldr r2,=0x20000000; ldr r3,[r2]; adds r3,#1; str r3,[r2]; cmp r3,#1
    ///   bne done; ldr r0,=0xE000ED0C; ldr r1,=0x05FA0004; str r1,[r0]; dsb
    ///   movs r3,#0xAA; str r3,[r2,#4]; done: b done
    const RESET_PROGRAM: [u8; 48] = [
        0x00, 0x10, 0x00, 0x20, 0x09, 0x00, 0x00, 0x08, 0x4f, 0xf0, 0x00, 0x52, 0x13, 0x68, 0x01,
        0x33, 0x13, 0x60, 0x01, 0x2b, 0x06, 0xd1, 0x04, 0x48, 0x04, 0x49, 0x01, 0x60, 0xbf, 0xf3,
        0x4f, 0x8f, 0xaa, 0x23, 0x53, 0x60, 0xfe, 0xe7, 0x00, 0x00, 0x0c, 0xed, 0x00, 0xe0, 0x04,
        0x00, 0xfa, 0x05,
    ];

    /// SCR.SEVONPEND = 1; SEV; WFE (consumes the event); WFE (sleeps);
    /// SRAM[0] = 1; pend disabled IRQ4 via ISPR; WFE (returns at once);
    /// SRAM[0] = 2; loop.
    const SEVONPEND_PROGRAM: [u8; 52] = [
        0x00, 0x10, 0x00, 0x20, 0x09, 0x00, 0x00, 0x08, 0x08, 0x48, 0x10, 0x21, 0x01, 0x60, 0x4f,
        0xf0, 0x00, 0x52, 0x40, 0xbf, 0x20, 0xbf, 0x20, 0xbf, 0x01, 0x23, 0x13, 0x60, 0x04, 0x48,
        0x10, 0x21, 0x01, 0x60, 0x20, 0xbf, 0x02, 0x23, 0x13, 0x60, 0xfe, 0xe7, 0x00, 0x00, 0x10,
        0xed, 0x00, 0xe0, 0x00, 0xe2, 0x00, 0xe0,
    ];

    #[test]
    fn sevonpend_wakes_wfe_for_disabled_interrupts() {
        let mut board = Nucleo::new();
        board.bus.load(0x0800_0000, &SEVONPEND_PROGRAM).unwrap();
        board.reset().unwrap();
        let r = board.run(1_000);
        assert_eq!(r.stop, StopReason::Sleeping);
        assert_eq!(
            board.bus.read_u32(0x2000_0000).unwrap(),
            0,
            "still asleep in WFE"
        );
        // A disabled interrupt becomes pending (e.g. a peripheral flag).
        board.sys.set_irq_pending(3);
        board.run(1_000);
        assert_eq!(
            board.bus.read_u32(0x2000_0000).unwrap(),
            2,
            "woke, and the ISPR write woke the next WFE"
        );
    }

    /// RCC_CFGR.HPRE = /8 (HCLK 16 → 2 MHz), then a busy loop.
    const SLOW_CLOCK_PROGRAM: [u8; 24] = [
        0x00, 0x10, 0x00, 0x20, 0x09, 0x00, 0x00, 0x08, 0x02, 0x48, 0xa0, 0x21, 0x01, 0x60, 0x01,
        0x32, 0xfd, 0xe7, 0x00, 0x00, 0x08, 0x38, 0x02, 0x40,
    ];

    #[test]
    fn run_for_ns_holds_its_deadline_when_the_clock_slows_down() {
        let mut board = Nucleo::new();
        board.bus.load(0x0800_0000, &SLOW_CLOCK_PROGRAM).unwrap();
        board.reset().unwrap();
        board.run_for_ns(10e6);
        assert_eq!(board.clock_hz(), 2_000_000);
        let ms = board.time_ns() / 1e6;
        assert!((10.0..10.01).contains(&ms), "ran {ms} ms instead of 10");
    }

    /// SysTick 1000-cycle period without interrupt; poll COUNTFLAG and
    /// count wraps in SRAM[0].
    const COUNTFLAG_PROGRAM: [u8; 48] = [
        0x00, 0x10, 0x00, 0x20, 0x09, 0x00, 0x00, 0x08, 0x08, 0x48, 0x40, 0xf2, 0xe7, 0x31, 0x41,
        0x60, 0x00, 0x21, 0x81, 0x60, 0x05, 0x21, 0x01, 0x60, 0x4f, 0xf0, 0x00, 0x52, 0x01, 0x68,
        0x11, 0xf4, 0x80, 0x3f, 0xfb, 0xd0, 0x13, 0x68, 0x01, 0x33, 0x13, 0x60, 0xf7, 0xe7, 0x10,
        0xe0, 0x00, 0xe0,
    ];

    #[test]
    fn busy_wait_skipping_keeps_polling_loops_exact() {
        // The polling loop is a steady state the CPU skips through, but the
        // result must match running one cycle at a time (no skipping
        // possible), including a SysTick wrap that lands mid-iteration.
        for horizon in [1_500u64, 3_500, 100_000] {
            let mut results = Vec::new();
            for step in [1, horizon] {
                let mut board = Nucleo::new();
                board.bus.load(0x0800_0000, &COUNTFLAG_PROGRAM).unwrap();
                board.reset().unwrap();
                while board.now() < horizon {
                    board.run(step.min(horizon - board.now()));
                }
                results.push((
                    board.bus.read_u32(0x2000_0000).unwrap(),
                    board.cpu.registers().pc(),
                    board.now(),
                ));
            }
            assert_eq!(results[0], results[1], "horizon {horizon}");
        }
    }

    /// Enable DWT CYCCNT, then poll it with `lsrs r1, r1, #8; beq` (exits
    /// once CYCCNT >= 256) and write a mark to SRAM[0].
    const CYCCNT_PROGRAM: [u8; 36] = [
        0x00, 0x10, 0x00, 0x20, 0x09, 0x00, 0x00, 0x08, 0x05, 0x48, 0x01, 0x21, 0x01, 0x60, 0x04,
        0x30, 0x01, 0x68, 0x09, 0x0a, 0xfc, 0xd0, 0x4f, 0xf0, 0x00, 0x52, 0x10, 0x60, 0xfe, 0xe7,
        0x00, 0x00, 0x00, 0x10, 0x00, 0xe0,
    ];

    #[test]
    fn loops_reading_a_cycle_counter_are_not_skipped() {
        // The registers look the same each iteration because the counter is
        // shifted away, but it keeps changing: the loop must exit on time.
        let mut board = Nucleo::new();
        board.bus.load(0x0800_0000, &CYCCNT_PROGRAM).unwrap();
        board.reset().unwrap();
        board.run(1_000);
        assert_eq!(
            board.bus.read_u32(0x2000_0000).unwrap(),
            0xE000_1004,
            "loop exited"
        );
    }

    #[test]
    fn sysresetreq_resets_at_the_next_instruction_boundary() {
        // https://github.com/elecage/Simucleo/issues/5
        for budget in [20, 100, 10_000] {
            let mut board = Nucleo::new();
            board.bus.load(0x0800_0000, &RESET_PROGRAM).unwrap();
            board.reset().unwrap();
            let r = board.run(budget);
            // The program ends in `b done` with interrupts enabled, an idle
            // loop the board sleeps through once it gets there.
            assert!(
                matches!(r.stop, StopReason::Sleeping | StopReason::BudgetExhausted),
                "budget {budget}"
            );
            assert_eq!(board.software_resets(), 1, "budget {budget}");
            assert_eq!(
                board.bus.read_u32(0x2000_0000).unwrap(),
                2,
                "booted twice (budget {budget})"
            );
            assert_eq!(
                board.bus.read_u32(0x2000_0004).unwrap(),
                0,
                "code after the request ran (budget {budget})"
            );
        }
    }
}
