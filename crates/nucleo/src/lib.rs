//! The Nucleo-F401RE as a whole machine.
//!
//! [`Nucleo`] owns the CPU backend, the STM32F401 bus and the Cortex-M system
//! block, loads firmware and advances simulated time. It also knows the
//! board around the MCU (the B1 button pull-up, the ST-LINK virtual COM
//! port on USART2) and explains why firmware stopped ([`Diagnosis`]).

mod debugger;
mod diagnose;
pub mod rtos;
pub mod swv;

pub use debugger::{Step, StepEnd};

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
use simucleo_periph_stm32f4::i2c::{I2cOp, I2cReply};
use simucleo_periph_stm32f4::rcc::ResetCause;
use simucleo_periph_stm32f4::{ExternalCircuit, Stm32f401Bus};
use thiserror::Error;

pub use diagnose::{Diagnosis, FaultInfo};
pub use rtos::{RtosSnapshot, TaskInfo, TaskState};
pub use simucleo_circuit::netlist::{BusCatalog, Circuit};
pub use simucleo_circuit::sim::{CircuitSim, Drive, MotorView, PartVisual, UartLink};
pub use simucleo_periph_stm32f4::gpio::PinEvent;
pub use simucleo_periph_stm32f4::usart::TerminalByte;
pub use simucleo_periph_stm32f4::wire::{SynthEdge, WireEvent, WireSignal};
pub use simucleo_periph_stm32f4::Warning;

/// USART2 is wired to the ST-LINK virtual COM port.
pub const VCP: usize = 1;

/// USART names by index (`Stm32f401Bus::usart`).
const USART_NAMES: [&str; 3] = ["USART1", "USART2", "USART6"];

/// What the Bluetooth panel shows of an HC-05 module.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BluetoothStatus {
    pub id: String,
    /// Bytes the phone received since the last call: (byte, re-sampled
    /// at a mismatched baud rate).
    pub received: Vec<(u8, bool)>,
    pub powered: bool,
    pub connected: bool,
    pub at_mode: bool,
    pub name: String,
    /// The module's UART baud rate (38400 in AT mode).
    pub baud: u32,
    /// The USART whose TX reaches the module's RXD, and the one whose RX
    /// the module's TXD reaches (routed pins wired to them).
    pub tx_usart: Option<&'static str>,
    pub rx_usart: Option<&'static str>,
    /// The baud rate that USART is configured for.
    pub mcu_baud: Option<f64>,
    /// An MCU TX pin is wired to the module's TXD (TX to TX).
    pub swapped: bool,
}

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

    fn voltage(&self, port: u8, pin: u8) -> Option<f64> {
        self.0.borrow().mcu_voltage(port, pin)
    }

    fn refresh(&mut self, time: Cycles) {
        self.0.borrow_mut().refresh(time);
    }

    fn next_event(&self) -> Option<Cycles> {
        self.0.borrow().next_event()
    }

    fn i2c(&mut self, time: Cycles, scl: (u8, u8), sda: (u8, u8), op: I2cOp) -> I2cReply {
        let mut c = self.0.borrow_mut();
        match op {
            I2cOp::Start { addr, read } => I2cReply::Ack(c.i2c_start(time, scl, sda, addr, read)),
            I2cOp::Write(b) => I2cReply::Ack(c.i2c_write(time, scl, b)),
            I2cOp::Read { .. } => I2cReply::Byte(c.i2c_read(time, scl)),
            I2cOp::Stop => {
                c.i2c_stop(time, scl);
                I2cReply::Ack(true)
            }
        }
    }

    fn spi(
        &mut self,
        time: Cycles,
        sck: (u8, u8),
        mosi: (u8, u8),
        miso: Option<(u8, u8)>,
        out: u8,
    ) -> u8 {
        self.0.borrow_mut().spi(time, sck, mosi, miso, out)
    }

    fn spi_clock(&mut self, sck: (u8, u8), hz: f64, cpol: bool, cpha: bool) {
        self.0.borrow_mut().spi_clock(sck, hz, cpol, cpha)
    }

    fn spi_rx(&mut self, time: Cycles, sck: (u8, u8), miso: Option<(u8, u8)>) -> u8 {
        self.0.borrow_mut().spi_rx(time, sck, miso)
    }
}

pub struct Nucleo {
    pub cpu: Box<dyn CpuBackend>,
    pub bus: Stm32f401Bus,
    pub sys: CortexM,
    pub firmware: Option<FirmwareImage>,
    debug: debugger::DebugState,
    resets: u32,
    /// Resets by the independent watchdog so far.
    watchdog_resets: u32,
    timeline: Vec<Segment>,
    /// Everything wired to the board, plus LD2 and B1.
    circuit: Rc<RefCell<CircuitSim>>,
    /// The RTOS kernel found in the firmware, if any.
    rtos: Option<rtos::FreeRtos>,
    /// UART modules (HC-05) and the MCU pins on their lines.
    uart_links: Vec<UartLink>,
    /// SWV settings, applied again to each new firmware's core.
    swv: Option<swv::SwvConfig>,
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
            debug: Default::default(),
            resets: 0,
            watchdog_resets: 0,
            timeline: Vec::new(),
            circuit: Rc::new(RefCell::new(CircuitSim::new(
                &Circuit::default(),
                &BusCatalog::default(),
                &HashMap::new(),
                0,
            ))),
            rtos: None,
            uart_links: Vec::new(),
            swv: None,
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
        // Log context switches: writes to the kernel's current-task pointer.
        self.bus.watch = self.rtos.as_ref().map(|r| r.current_tcb);
        self.timeline = vec![Segment {
            cycle: self.sys.cycles,
            ns: self.time_ns(),
            hz: self.bus.clocks().hclk,
        }];
        self.sync_circuit_clock();
        self.route_uarts();
    }

    /// Program an ELF image into flash and power the board up.
    pub fn load_elf(&mut self, bytes: &[u8]) -> Result<(), LoadError> {
        let fw = FirmwareImage::parse(bytes)?;
        self.rtos = rtos::FreeRtos::detect(&fw, bytes);
        self.set_breakpoints(&[]);
        self.set_watchpoints(&[]);
        self.debug.new_firmware(bytes);
        self.sys = CortexM::new();
        if let Some(cfg) = &self.swv {
            cfg.apply(&mut self.sys);
        }
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
        self.watchdog_resets = 0;
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
            self.sync_circuit_clock();
        }
    }

    /// Give the circuit (clock chips, sensor timing) the current time base.
    fn sync_circuit_clock(&mut self) {
        if let Some(s) = self.timeline.last() {
            self.circuit
                .borrow_mut()
                .set_clock(s.cycle, s.ns / 1e9, s.hz as f64);
        }
    }

    /// What the TFT display of part `id` shows (RGB565, little-endian).
    pub fn tft_pixels(&self, id: &str) -> Option<Vec<u8>> {
        self.circuit.borrow().tft_pixels(id)
    }

    /// The SD card of part `id` as a disk image.
    pub fn sd_image(&self, id: &str) -> Option<Vec<u8>> {
        self.circuit.borrow().sd_image(id)
    }

    /// The SD card of part `id` as just its blocks in use.
    pub fn sd_snapshot(&self, id: &str) -> Option<Vec<u8>> {
        self.circuit.borrow().sd_snapshot(id)
    }

    /// Put back what [`Nucleo::sd_snapshot`] gave.
    pub fn sd_restore(&mut self, id: &str, snapshot: &[u8]) -> bool {
        self.circuit.borrow_mut().sd_restore(id, snapshot)
    }

    /// Erase the SD card of part `id`.
    pub fn sd_wipe(&mut self, id: &str) -> bool {
        self.circuit.borrow_mut().sd_wipe(id)
    }

    /// Insert a disk image into the SD card of part `id`.
    pub fn sd_load(&mut self, id: &str, image: &[u8]) -> bool {
        self.circuit.borrow_mut().sd_load(id, image)
    }

    /// The real date and time (Unix seconds) that clock chips placed from
    /// now on start at.
    pub fn set_wall_clock(&mut self, unix: f64) {
        self.circuit.borrow_mut().set_wall_clock(unix);
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
        if let Some(cause) = self.bus.take_reset_request() {
            // The watchdog ran out: the chip resets at once.
            self.watchdog_resets += 1;
            // A vector table it cannot read shows up when the core runs.
            self.system_reset(cause).ok();
            return;
        }
        // Bytes on USART1/USART6 go to the modules wired to them.
        if !self.uart_links.is_empty()
            && !(self.bus.usart[0].terminal.is_empty() && self.bus.usart[2].terminal.is_empty())
        {
            self.route_uarts();
        }
        self.bus.poll(&mut self.sys);
        self.note_clock();
    }

    /// The USARTs a UART module is wired to: the one whose routed TX pin
    /// is on the module's RXD net, the one whose routed RX pin is on its
    /// TXD net; and whether some USART's TX is on its TXD (TX to TX).
    fn usarts_of(&self, link: &UartLink) -> (Option<usize>, Option<usize>, bool) {
        let routed: [_; 3] = std::array::from_fn(|u| self.bus.usart_pins(u));
        let on = |pins: &[(u8, u8)], p: Option<(u8, u8)>| p.is_some_and(|p| pins.contains(&p));
        let tx = (0..3).find(|&u| on(&link.rxd, routed[u].0));
        let rx = (0..3).find(|&u| on(&link.txd, routed[u].1));
        let swapped = (0..3).any(|u| on(&link.txd, routed[u].0));
        (tx, rx, swapped)
    }

    /// Move bytes between the USARTs and the UART modules wired to them:
    /// what the MCU transmitted reaches the module, the module's output
    /// (phone text, AT replies) the MCU's receiver. Each USART's terminal
    /// runs at its module's baud rate, so a mismatch garbles the bytes.
    fn route_uarts(&mut self) {
        let ends: Vec<_> = self.uart_links.iter().map(|l| self.usarts_of(l)).collect();
        // What each USART transmitted, taken once: every module whose RXD
        // is on that TX line gets its own copy (one that is unpowered or
        // has no phone drops it without starving the others).
        let mut sent: [Option<Vec<TerminalByte>>; 3] = Default::default();
        for &(tx, ..) in &ends {
            if let Some(u) = tx.filter(|&u| u != VCP) {
                if sent[u].is_none() {
                    sent[u] = Some(self.bus.terminal_take(u));
                }
            }
        }
        for (i, &(tx, rx, _)) in ends.iter().enumerate() {
            let link = &self.uart_links[i];
            // The terminal's baud follows the wiring alone (also before
            // the firmware routes its pins), USART2 stays the VCP's.
            let possible = |nets: &[(u8, u8)], want_tx: bool| {
                simucleo_periph_stm32f4::USART_PINS
                    .iter()
                    .find(|&&(u, port, pin, _, t)| {
                        u != VCP && t == want_tx && nets.contains(&(port, pin))
                    })
                    .map(|&(u, ..)| u)
            };
            let wired = [possible(&link.rxd, true), possible(&link.txd, false)];
            let mut c = self.circuit.borrow_mut();
            let Some(hc) = c.hc05(&link.id) else {
                continue;
            };
            let baud = hc.uart_baud();
            for u in wired.into_iter().flatten() {
                self.bus.usart[u].host_baud = baud;
            }
            for b in tx.and_then(|u| sent[u].as_deref()).unwrap_or_default() {
                hc.from_mcu(b.byte, b.garbled);
            }
            if hc.to_mcu.is_empty() {
                continue;
            }
            let out: Vec<u8> = hc.to_mcu.drain(..).collect();
            drop(c);
            if let Some(u) = rx.filter(|&u| u != VCP) {
                self.bus.set_time(self.sys.cycles);
                self.bus.terminal_send(u, &out);
            }
        }
        // Nothing listens on the other USART1/USART6 lines.
        if !self.uart_links.is_empty() {
            for u in [0, 2] {
                if sent[u].is_none() {
                    self.bus.usart[u].terminal.clear();
                }
            }
        }
    }

    /// The HC-05 modules in the circuit, with what their phones received
    /// since the last call.
    pub fn bluetooth(&mut self) -> Vec<BluetoothStatus> {
        self.route_uarts();
        let mut out = Vec::new();
        for link in self.uart_links.clone() {
            let (tx, rx, swapped) = self.usarts_of(&link);
            let mcu_baud = tx.or(rx).and_then(|u| self.bus.usart_baud(u));
            let mut c = self.circuit.borrow_mut();
            let Some(hc) = c.hc05(&link.id) else {
                continue;
            };
            out.push(BluetoothStatus {
                id: link.id.clone(),
                received: std::mem::take(&mut hc.to_phone),
                powered: hc.powered,
                connected: hc.connected,
                at_mode: hc.at_mode,
                name: hc.name.clone(),
                baud: hc.uart_baud(),
                tx_usart: tx.map(|u| USART_NAMES[u]),
                rx_usart: rx.map(|u| USART_NAMES[u]),
                mcu_baud,
                swapped,
            });
        }
        out
    }

    /// The phone sends `bytes` through HC-05 part `id`. Returns whether
    /// they went out (a powered module in data mode with a connection).
    pub fn bluetooth_send(&mut self, id: &str, bytes: &[u8]) -> bool {
        let sent = self
            .circuit
            .borrow_mut()
            .hc05(id)
            .is_some_and(|hc| hc.from_phone(bytes));
        self.route_uarts();
        self.bus.poll(&mut self.sys);
        sent
    }

    /// Connect (pair) or disconnect the phone of HC-05 part `id`; STATE
    /// follows.
    pub fn bluetooth_connect(&mut self, id: &str, on: bool) {
        let changed = match self.circuit.borrow_mut().hc05(id) {
            Some(hc) if hc.connected != on => {
                hc.connected = on;
                true
            }
            _ => false,
        };
        if changed {
            self.circuit_changed();
        }
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

    /// Turn a rotary encoder part by `detents` (negative: counter-clockwise).
    pub fn rotate(&mut self, part: &str, detents: i32) {
        let now = self.sys.cycles;
        if self.circuit.borrow_mut().rotate(part, detents, now) {
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
        self.uart_links = self.circuit.borrow().uart_links();
        self.circuit_changed();
        self.route_uarts();
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

    /// Analog probes: log the net voltage of each pin named (`"PA1"` or
    /// `"part.pin"`) whenever the circuit's operating point changes.
    pub fn set_voltage_probes(&mut self, names: &[String]) {
        let now = self.sys.cycles;
        self.circuit.borrow_mut().set_voltage_probes(names, now);
    }

    /// The voltages logged since the last call: (cycle, one per probe;
    /// `None` for a pin on no net).
    pub fn take_voltage_log(&mut self) -> Vec<(Cycles, Vec<Option<f64>>)> {
        self.circuit.borrow_mut().take_voltage_log()
    }

    /// M35: probe part pins as digital lines — a CAN module's CANH/CANL
    /// shows its bus (high: recessive).
    pub fn set_line_probes(&mut self, names: &[String]) {
        self.circuit.borrow_mut().set_line_probes(names);
    }

    /// The line probes' levels now (`None`: nothing to show).
    pub fn line_levels(&self) -> Vec<Option<bool>> {
        self.circuit.borrow().line_levels()
    }

    /// Level changes of the line probes up to now: (ns, probe, level).
    pub fn take_line_edges(&mut self) -> Vec<(f64, usize, bool)> {
        let now = self.sys.cycles;
        let mut e = self.circuit.borrow_mut().take_line_edges(now);
        for x in &mut e {
            x.0 *= 1e9;
        }
        e
    }

    /// The analog probes' voltages now.
    pub fn probe_voltages(&self) -> Vec<Option<f64>> {
        self.circuit.borrow().probe_voltages()
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

    /// Number of resets by the independent watchdog so far.
    pub fn watchdog_resets(&self) -> u32 {
        self.watchdog_resets
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

    /// Write memory as a debugger does: flash takes the bytes into its
    /// image; elsewhere they go through the bus like the CPU's stores, a
    /// whole aligned word or halfword at once (peripheral registers).
    pub fn write_memory(&mut self, addr: u32, data: &[u8]) -> bool {
        use simucleo_core::bus::{AccessSize, Bus};
        if (0x0800_0000..0x0808_0000).contains(&addr) {
            return self.bus.load(addr, data).is_ok();
        }
        let le = |b: &[u8]| b.iter().rev().fold(0u32, |a, &x| a << 8 | x as u32);
        let (size, chunk) = match data.len() {
            4 if addr.is_multiple_of(4) => (AccessSize::Word, 4),
            2 if addr.is_multiple_of(2) => (AccessSize::Half, 2),
            _ => (AccessSize::Byte, 1),
        };
        data.chunks(chunk).enumerate().all(|(i, c)| {
            let a = addr + (i * chunk) as u32;
            if a >= 0xE000_0000 {
                self.sys.write(a, size, le(c)).is_ok()
            } else {
                self.bus.write(a, size, le(c)).is_ok()
            }
        })
    }

    /// Tasks of the RTOS in the firmware (FreeRTOS), or `None` without one.
    pub fn rtos_snapshot(&self) -> Option<RtosSnapshot> {
        let r = self.rtos.as_ref()?;
        let word = |a: u32| self.bus.peek(a, simucleo_core::bus::AccessSize::Word);
        Some(r.snapshot(&word))
    }

    /// Context switches since the last call: (cycle, TCB of the task that
    /// now runs).
    pub fn take_task_switches(&mut self) -> Vec<(Cycles, u32)> {
        std::mem::take(&mut self.bus.watch_log)
    }

    /// Start (`Some`) or stop the SWV trace, as the debugger does; the
    /// settings stay for firmware loaded later.
    pub fn swv_configure(&mut self, cfg: Option<swv::SwvConfig>) {
        match &cfg {
            Some(c) => c.apply(&mut self.sys),
            None => swv::SwvConfig::stop(&mut self.sys),
        }
        self.swv = cfg;
    }

    /// The SWV trace since the last call.
    pub fn swv_take(&mut self) -> swv::SwvFrame {
        let drained = self.sys.trace.drain();
        swv::SwvFrame::collect(
            drained,
            |c| self.ns_at(c),
            |pc| self.symbol_at(pc).map(str::to_string),
        )
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
    use simucleo_core::bus::{AccessSize, Bus};

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

    /// `r0 = 0x2000_0000; loop: ldr r1, [r0]; cmp r1, #1; bne loop; b .`
    const POLL_PROGRAM: [u8; 20] = [
        0x00, 0x10, 0x00, 0x20, 0x09, 0x00, 0x00, 0x08, // SP, reset
        0x20, 0x20, 0x00, 0x06, // movs r0, #0x20; lsls r0, r0, #24
        0x01, 0x68, 0x01, 0x29, 0xfc, 0xd1, // ldr r1, [r0]; cmp r1, #1; bne loop
        0xfe, 0xe7, // b .
    ];

    #[test]
    fn traced_reads_in_a_polling_loop_are_all_reported() {
        // The loop reads the same word without changing anything: the CPU
        // would skip through it, but a data trace comparator on the word
        // must see every read (as on the chip).
        use crate::swv::{DataMode, DataTrace, SwvConfig};
        let mut board = Nucleo::new();
        board.bus.load(0x0800_0000, &POLL_PROGRAM).unwrap();
        board.reset().unwrap();
        board.swv_configure(Some(SwvConfig {
            ports: 0,
            pc_sampling: None,
            exceptions: false,
            data: vec![DataTrace {
                addr: 0x2000_0000,
                size: 4,
                mode: DataMode::Read,
            }],
        }));
        board.run(12_000);
        let reads = board.swv_take().data.len();
        // One read per iteration of about 6 cycles.
        assert!(
            (1_500..=2_500).contains(&reads),
            "{reads} reads in 12000 cycles"
        );
        // Without the comparator the loop is still skipped through.
        board.swv_configure(None);
        board.run(12_000);
        assert!(board.swv_take().data.is_empty());
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

    /// `b .` forever (the board sleeps through it).
    const IDLE_PROGRAM: [u8; 10] = [0x00, 0x10, 0x00, 0x20, 0x09, 0x00, 0x00, 0x08, 0xfe, 0xe7];

    /// An idle board with an HC-05 on 5 V and USART1 (PA9 TX → RXD,
    /// TXD → PA10 RX) set up at `brr` (16 MHz APB2) by register writes.
    fn bluetooth_board(module_baud: &str, brr: u32) -> Nucleo {
        let mut board = Nucleo::new();
        board.bus.load(0x0800_0000, &IDLE_PROGRAM).unwrap();
        board.reset().unwrap();
        let circuit: Circuit = serde_json::from_value(serde_json::json!({
            "parts": [{"id": "bt", "kind": "hc05", "props": {"baud": module_baud}}],
            "wires": [
                {"a": {"part": "board", "pin": "5V"}, "b": {"part": "bt", "pin": "VCC"}},
                {"a": {"part": "board", "pin": "GND"}, "b": {"part": "bt", "pin": "GND"}},
                {"a": {"part": "board", "pin": "PA9"}, "b": {"part": "bt", "pin": "RXD"}},
                {"a": {"part": "board", "pin": "PA10"}, "b": {"part": "bt", "pin": "TXD"}}
            ]
        }))
        .unwrap();
        board.set_circuit(&circuit, &BusCatalog::default(), &HashMap::new());
        let w = |b: &mut Nucleo, a: u32, v: u32| b.bus.write(a, AccessSize::Word, v).unwrap();
        w(&mut board, 0x4002_3830, 1); // GPIOAEN
        w(&mut board, 0x4002_3844, 1 << 4); // USART1EN
        w(&mut board, 0x4002_0000, 0xA800_0000 | 0b1010 << 18); // PA9, PA10 AF
        w(&mut board, 0x4002_0024, 7 << 4 | 7 << 8); // AF7
        w(&mut board, 0x4001_1008, brr);
        w(&mut board, 0x4001_100C, 0x200C); // UE TE RE
        board
    }

    /// Transmit on USART1 one byte at a time and return what the phone got.
    fn mcu_sends(board: &mut Nucleo, text: &[u8]) -> Vec<(u8, bool)> {
        for &c in text {
            board.bus.set_time(board.now());
            board
                .bus
                .write(0x4001_1004, AccessSize::Word, c as u32)
                .unwrap();
            board.run_for_ns(1.2e6);
        }
        board
            .bluetooth()
            .into_iter()
            .flat_map(|s| s.received)
            .collect()
    }

    /// The phone sends one byte; what USART1's DR then holds.
    fn phone_sends(board: &mut Nucleo, c: u8) -> Option<u32> {
        assert!(board.bluetooth_send("bt", &[c]));
        board.run_for_ns(1.5e6);
        let sr = board.bus.read_u32(0x4001_1000).unwrap();
        (sr & (1 << 5) != 0).then(|| board.bus.read_u32(0x4001_1004).unwrap())
    }

    #[test]
    fn hc05_bridges_usart1_to_the_phone_at_matching_baud() {
        let mut board = bluetooth_board("9600", 1667); // 9600 Bd
        let st = &board.bluetooth()[0];
        assert_eq!(
            (st.tx_usart, st.rx_usart, st.baud, st.swapped),
            (Some("USART1"), Some("USART1"), 9600, false)
        );
        // No phone yet: nothing arrives, and the phone cannot send.
        assert_eq!(mcu_sends(&mut board, b"x"), []);
        assert!(!board.bluetooth_send("bt", b"y"));
        board.bluetooth_connect("bt", true);
        assert_eq!(mcu_sends(&mut board, b"hi"), [(b'h', false), (b'i', false)]);
        assert_eq!(phone_sends(&mut board, b'k'), Some(b'k' as u32));
        assert!(board.take_console().is_empty(), "nothing on the VCP");
    }

    #[test]
    fn every_hc05_on_one_tx_line_hears_the_mcu() {
        // A second module's RXD on PA9 too; the first (unpowered once its
        // VCC is gone) must not swallow what the second should get.
        for first_powered in [true, false] {
            let mut board = bluetooth_board("9600", 1667);
            let mut wires = vec![
                serde_json::json!({"a": {"part": "board", "pin": "GND"}, "b": {"part": "bt", "pin": "GND"}}),
                serde_json::json!({"a": {"part": "board", "pin": "PA9"}, "b": {"part": "bt", "pin": "RXD"}}),
                serde_json::json!({"a": {"part": "board", "pin": "5V"}, "b": {"part": "bt2", "pin": "VCC"}}),
                serde_json::json!({"a": {"part": "board", "pin": "GND"}, "b": {"part": "bt2", "pin": "GND"}}),
                serde_json::json!({"a": {"part": "board", "pin": "PA9"}, "b": {"part": "bt2", "pin": "RXD"}}),
            ];
            if first_powered {
                wires.push(serde_json::json!({"a": {"part": "board", "pin": "5V"}, "b": {"part": "bt", "pin": "VCC"}}));
            }
            let circuit: Circuit = serde_json::from_value(serde_json::json!({
                "parts": [
                    {"id": "bt", "kind": "hc05", "props": {"baud": "9600"}},
                    {"id": "bt2", "kind": "hc05", "props": {"baud": "9600"}}
                ],
                "wires": wires
            }))
            .unwrap();
            board.set_circuit(&circuit, &BusCatalog::default(), &HashMap::new());
            board.bluetooth_connect("bt2", true);
            if first_powered {
                board.bluetooth_connect("bt", true);
            }
            for &c in b"hi" {
                board.bus.set_time(board.now());
                board
                    .bus
                    .write(0x4001_1004, AccessSize::Word, c as u32)
                    .unwrap();
                board.run_for_ns(1.2e6);
            }
            let st = board.bluetooth();
            let got = |id: &str| -> Vec<u8> {
                st.iter()
                    .find(|s| s.id == id)
                    .unwrap()
                    .received
                    .iter()
                    .map(|b| b.0)
                    .collect()
            };
            assert_eq!(got("bt2"), b"hi", "first powered: {first_powered}");
            assert_eq!(got("bt"), if first_powered { &b"hi"[..] } else { &[] });
        }
    }

    #[test]
    fn hc05_at_a_different_baud_garbles_both_ways() {
        let mut board = bluetooth_board("9600", 139); // firmware at 115200 Bd
        board.bluetooth_connect("bt", true);
        let got = mcu_sends(&mut board, b"h");
        assert_eq!(got.len(), 1);
        assert!(got[0].1, "flagged as re-sampled");
        assert_ne!(got[0].0, b'h');
        assert_ne!(phone_sends(&mut board, b'k'), Some(b'k' as u32));
        let st = &board.bluetooth()[0];
        assert!((st.mcu_baud.unwrap() - 115_108.0).abs() < 1.0);
        assert_eq!(st.baud, 9600);
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
