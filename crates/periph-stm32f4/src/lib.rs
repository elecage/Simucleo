//! STM32F401RE memory map and peripherals.
//!
//! Modelled: flash, SRAM, boot alias, bit-banding, GPIO, EXTI, RCC (clock
//! tree), PWR, FLASH interface, SYSCFG, USART1/2/6, TIM1–5 and TIM9–11. Every other peripheral is backed by a
//! register file initialised from ST's SVD, so firmware reads back what it
//! wrote and sees correct reset values; those accesses are counted so the
//! GUI can show which peripheral the firmware relies on that is not
//! simulated yet.

pub mod exti;
pub mod gpio;
pub mod map;
pub mod rcc;
pub mod regmap;
#[rustfmt::skip]
pub mod svd;
pub mod svd_types;
pub mod sysctl;
pub mod timer;
pub mod usart;

use std::collections::BTreeSet;

use exti::Exti;
use gpio::{Gpio, PinDrive, PinEvent};
use rcc::{Clocks, Rcc, ResetCause};
use regmap::RegisterFile;
use simucleo_core::bus::{AccessSize, Bus, BusError, Memory};
use simucleo_core::cortexm::CortexM;
use simucleo_core::sched::Scheduler;
use simucleo_core::Cycles;
use sysctl::{FlashIf, Pwr, Syscfg};
use timer::{Timer, TIMERS};
use usart::{TerminalByte, Usart, UsartEventKind};

/// Peripheral events on the virtual clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Event {
    Usart {
        idx: u8,
        kind: UsartEventKind,
        gen: u32,
    },
    Timer {
        idx: u8,
        gen: u32,
    },
}

/// Something the firmware did that would misbehave on real hardware.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Warning {
    /// Register access while the peripheral's bus clock is off: reads
    /// return 0 and writes are lost, as on the chip.
    ClockDisabled {
        peripheral: &'static str,
        enable_bit: &'static str,
    },
    /// HCLK too fast for the configured flash wait states.
    FlashLatency {
        hclk: u32,
        latency: u32,
        required: u32,
    },
}

impl std::fmt::Display for Warning {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Warning::ClockDisabled { peripheral, enable_bit } => {
                write!(f, "{peripheral} was accessed while its clock was off (set {enable_bit} first)")
            }
            Warning::FlashLatency { hclk, latency, required } => write!(
                f,
                "HCLK {:.0} MHz needs {required} flash wait states but FLASH.ACR.LATENCY is {latency}",
                *hclk as f64 / 1e6
            ),
        }
    }
}

/// A model of what is wired to the chip's pins (see `simucleo-circuit`).
/// The bus calls [`ExternalCircuit::update`] whenever the drive of a pin
/// may have changed, and applies the returned input levels at once, so
/// firmware reading a pin (or an EXTI edge) sees the circuit's response to
/// its own outputs immediately.
pub trait ExternalCircuit {
    /// Pins the circuit observes (port 0 = A, pin).
    fn pins(&self) -> Vec<(u8, u8)>;
    /// Drives of [`ExternalCircuit::pins`] at `time`. Returns the level
    /// each of those pins sees from outside (`None`: nothing drives it) if
    /// that may have changed.
    fn update(&mut self, time: Cycles, drives: &[PinDrive]) -> Option<Vec<Option<bool>>>;
}

/// USART instances: (name, base, IRQ, on APB2, ENR offset, enable bit).
const USARTS: [(&str, u32, u16, bool, u32, u32, &str); 3] = [
    (
        "USART1",
        map::USART1_BASE,
        37,
        true,
        0x44,
        4,
        "RCC.APB2ENR.USART1EN",
    ),
    (
        "USART2",
        map::USART2_BASE,
        38,
        false,
        0x40,
        17,
        "RCC.APB1ENR.USART2EN",
    ),
    (
        "USART6",
        0x4001_1400,
        71,
        true,
        0x44,
        5,
        "RCC.APB2ENR.USART6EN",
    ),
];

const GPIO_ENABLE_BITS: [&str; 8] = [
    "RCC.AHB1ENR.GPIOAEN",
    "RCC.AHB1ENR.GPIOBEN",
    "RCC.AHB1ENR.GPIOCEN",
    "RCC.AHB1ENR.GPIODEN",
    "RCC.AHB1ENR.GPIOEEN",
    "",
    "",
    "RCC.AHB1ENR.GPIOHEN",
];

/// The system bus of an STM32F401RE booting from main flash.
pub struct Stm32f401Bus {
    pub flash: Memory,
    pub sram: Memory,
    /// GPIOA..GPIOH (F and G do not exist on this part).
    pub gpio: [Gpio; 8],
    /// Pin level changes, oldest first. The owner drains it.
    pub pin_events: Vec<PinEvent>,
    /// Pin *level* changes (as IDR sees them, inputs included) of the pins
    /// in `probe_mask` (bit n of entry p = pin n of port p), for probes.
    /// The owner drains it.
    pub level_events: Vec<PinEvent>,
    pub probe_mask: [u16; 8],
    /// An SRAM word whose writes are logged in `watch_log` as (time, new
    /// value), e.g. the RTOS's current-task pointer to record context
    /// switches. The owner drains the log.
    pub watch: Option<u32>,
    pub watch_log: Vec<(Cycles, u32)>,
    pub rcc: Rcc,
    pub pwr: Pwr,
    pub flash_if: FlashIf,
    /// USART1, USART2 (ST-LINK virtual COM port), USART6.
    pub usart: [Usart; 3],
    pub exti: Exti,
    pub syscfg: Syscfg,
    /// TIM1, TIM2, TIM3, TIM4, TIM5, TIM9, TIM10, TIM11.
    pub timers: [Timer; 8],
    /// Firmware read a register whose value changes with time alone (a
    /// running timer's CNT or SR); reported to the CPU's loop elision.
    time_read: bool,
    /// Pin levels last reported to EXTI, per port.
    levels: [u16; 8],
    /// The external circuit, if one is attached.
    circuit: Option<Box<dyn ExternalCircuit>>,
    /// Pins the circuit currently drives from outside.
    circuit_pins: Vec<(u8, u8)>,
    /// Unmodelled peripherals.
    pub regs: RegisterFile,
    pub warnings: BTreeSet<Warning>,
    sched: Scheduler<Event>,
    now: Cycles,
    clocks: Clocks,
    clock_changed: bool,
    /// Earliest event the machine knows about (see `Bus::poll`).
    known_deadline: Option<Cycles>,
}

impl Default for Stm32f401Bus {
    fn default() -> Self {
        Self::new()
    }
}

impl Stm32f401Bus {
    pub fn new() -> Self {
        let rcc = Rcc::new(ResetCause::PowerOn);
        let clocks = rcc.clocks();
        let mut bus = Self {
            flash: Memory::new(map::FLASH_BASE, map::FLASH_SIZE, false),
            sram: Memory::new(map::SRAM_BASE, map::SRAM_SIZE, true),
            gpio: std::array::from_fn(|i| Gpio::new(i as u8)),
            pin_events: Vec::new(),
            level_events: Vec::new(),
            probe_mask: [0; 8],
            watch: None,
            watch_log: Vec::new(),
            rcc,
            pwr: Pwr::default(),
            flash_if: FlashIf::default(),
            usart: USARTS.map(|(name, _, irq, apb2, ..)| Usart::new(name, irq, apb2)),
            exti: Exti::default(),
            syscfg: Syscfg::default(),
            timers: TIMERS.map(Timer::new),
            time_read: false,
            levels: [0; 8],
            circuit: None,
            circuit_pins: Vec::new(),
            regs: RegisterFile::default(),
            warnings: BTreeSet::new(),
            sched: Scheduler::new(),
            now: 0,
            clocks,
            clock_changed: false,
            known_deadline: None,
        };
        bus.retime_timers();
        bus.update_timer_gates();
        bus.sync_levels();
        bus
    }

    /// Freeze or resume timers whose RCC enable bit changed.
    fn update_timer_gates(&mut self) {
        let now = self.now;
        for i in 0..self.timers.len() {
            let gated = !self.rcc.clock_enabled(timer_enr(i), TIMERS[i].enable_bit);
            if self.timers[i].gated != gated {
                // Bring the counter to now under the old state; while gated
                // `sync` only moves the reference, so it resumes in phase.
                self.timers[i].sync(now);
                self.timers[i].gated = gated;
                self.reschedule_timer(i);
            }
        }
    }

    /// Give every timer the current HCLK / TIMxCLK relation.
    fn retime_timers(&mut self) {
        let (c, now) = (self.clocks, self.now);
        for t in &mut self.timers {
            let timclk = if t.info.apb2 { c.tim_apb2 } else { c.tim_apb1 };
            t.set_clock(c.hclk, timclk, now);
        }
        for i in 0..self.timers.len() {
            self.reschedule_timer(i);
        }
    }

    fn reschedule_timer(&mut self, i: usize) {
        let t = &mut self.timers[i];
        t.gen = t.gen.wrapping_add(1);
        if let Some(at) = t.next_event() {
            let gen = t.gen;
            self.sched
                .schedule_at(at, Event::Timer { idx: i as u8, gen });
        }
    }

    /// A timer's state changed at `time`: update its pins and its schedule.
    fn timer_changed(&mut self, i: usize, time: Cycles) {
        self.apply_af(time);
        self.reschedule_timer(i);
    }

    /// Drive alternate-function pins from the peripheral outputs selected
    /// on them (timer channels).
    fn apply_af(&mut self, time: Cycles) {
        let mut want = [(0u16, 0u16); 8]; // (driven, level) per port
        for &(port, pin, af, ti, ch) in timer::PIN_MAP {
            let g = &self.gpio[port as usize];
            if g.mode(pin) != gpio::PinMode::Alternate || g.af(pin) != af {
                continue;
            }
            if let Some(level) = self.timers[ti as usize].output(ch as usize) {
                want[port as usize].0 |= 1 << pin;
                if level {
                    want[port as usize].1 |= 1 << pin;
                }
            }
        }
        for (port, (driven, out)) in want.into_iter().enumerate() {
            let g = &self.gpio[port];
            if g.af_driven == driven && g.af_out & driven == out {
                continue;
            }
            let before: Vec<_> = (0..16).map(|p| g.driven(p)).collect();
            let g = &mut self.gpio[port];
            g.af_driven = driven;
            g.af_out = out;
            for (pin, old) in before.into_iter().enumerate() {
                let new = self.gpio[port].driven(pin as u8);
                if new != old {
                    self.pin_events.push(PinEvent {
                        time,
                        port: port as u8,
                        pin: pin as u8,
                        level: new,
                    });
                }
            }
            self.refresh_port(port, time);
        }
        self.circuit_update(time);
    }

    /// Take the current pin levels as the reference for edge detection.
    fn sync_levels(&mut self) {
        for (l, g) in self.levels.iter_mut().zip(&self.gpio) {
            *l = g.levels();
        }
    }

    /// Port selected for EXTI line `line` in SYSCFG_EXTICRx (0 = A).
    fn exti_source(&self, line: u8) -> usize {
        self.syscfg.exti_port(line)
    }

    /// Re-read the levels of a port's pins and report edges to EXTI.
    fn refresh_port(&mut self, port: usize, time: Cycles) {
        let new = self.gpio[port].levels();
        let changed = new ^ self.levels[port];
        self.levels[port] = new;
        if changed == 0 {
            return;
        }
        let probed = changed & self.probe_mask[port];
        if probed != 0 {
            for pin in (0..16u8).filter(|p| probed & (1 << p) != 0) {
                self.level_events.push(PinEvent {
                    time,
                    port: port as u8,
                    pin,
                    level: Some(new & (1 << pin) != 0),
                });
            }
        }
        for line in (0..16u8).filter(|l| changed & (1 << l) != 0) {
            if self.exti_source(line) == port {
                self.exti.edge(line, new & (1 << line) != 0);
            }
        }
    }

    /// Attach (or with `None` detach) the external circuit and let it see
    /// the present pin drives.
    pub fn set_circuit(&mut self, circuit: Option<Box<dyn ExternalCircuit>>) {
        self.circuit = circuit;
        self.circuit_changed();
    }

    /// The circuit's topology changed (or a switch moved): re-read its pin
    /// list, release pins it no longer watches, and update it.
    pub fn circuit_changed(&mut self) {
        let pins = self.circuit.as_ref().map(|c| c.pins()).unwrap_or_default();
        for (port, pin) in std::mem::take(&mut self.circuit_pins) {
            if !pins.contains(&(port, pin)) {
                self.set_external(port as usize, pin, None);
            }
        }
        self.circuit_pins = pins;
        self.circuit_update_forced(self.now);
    }

    fn circuit_update(&mut self, time: Cycles) {
        if self.circuit.is_some() {
            self.circuit_update_forced(time);
        }
    }

    fn circuit_update_forced(&mut self, time: Cycles) {
        let Some(mut c) = self.circuit.take() else {
            return;
        };
        let drives: Vec<PinDrive> = self
            .circuit_pins
            .iter()
            .map(|&(port, pin)| self.gpio[port as usize].drive(pin))
            .collect();
        let levels = c.update(time, &drives);
        self.circuit = Some(c);
        if let Some(levels) = levels {
            let pins = self.circuit_pins.clone();
            for (&(port, pin), level) in pins.iter().zip(levels) {
                self.set_external_at(port as usize, pin, level, time);
            }
        }
    }

    /// Drive a pin from outside the chip (`Some(level)`), or release it
    /// (`None`: it floats and follows its pull resistor).
    pub fn set_external(&mut self, port: usize, pin: u8, level: Option<bool>) {
        self.set_external_at(port, pin, level, self.now);
    }

    fn set_external_at(&mut self, port: usize, pin: u8, level: Option<bool>, time: Cycles) {
        let g = &mut self.gpio[port];
        let bit = 1u16 << pin;
        match level {
            Some(l) => {
                g.external_driven |= bit;
                if l {
                    g.external |= bit;
                } else {
                    g.external &= !bit;
                }
            }
            None => g.external_driven &= !bit,
        }
        self.refresh_port(port, time);
    }

    /// System reset: peripherals return to their reset state; memories,
    /// the backup domain, external pin levels and terminal logs survive.
    pub fn system_reset(&mut self, cause: ResetCause) {
        for g in &mut self.gpio {
            let (ext, driven) = (g.external, g.external_driven);
            *g = Gpio::new(g.port);
            g.external = ext;
            g.external_driven = driven;
        }
        self.rcc.system_reset(cause);
        self.pwr = Pwr::default();
        self.flash_if = FlashIf::default();
        for u in &mut self.usart {
            u.reset();
        }
        self.exti = Exti::default();
        self.syscfg = Syscfg::default();
        let now = self.sched.now().max(self.now);
        for t in &mut self.timers {
            t.reset(now);
        }
        self.regs.clear();
        self.update_timer_gates();
        self.sync_levels();
        self.circuit_update(now);
        let now = self.sched.now();
        self.sched = Scheduler::new();
        self.sched.advance_to(now);
        self.clocks = self.rcc.clocks();
        self.clock_changed = true;
        self.retime_timers();
    }

    /// Program a firmware segment into flash or SRAM.
    pub fn load(&mut self, addr: u32, bytes: &[u8]) -> Result<(), BusError> {
        let addr = map::resolve_alias(addr);
        if self.flash.contains(addr, AccessSize::Byte) {
            self.flash.load(addr, bytes)
        } else {
            self.sram.load(addr, bytes)
        }
    }

    pub fn clocks(&self) -> Clocks {
        self.clocks
    }

    /// Cycle of the next peripheral event, if any. The machine runs the
    /// CPU no further than this.
    pub fn next_deadline(&mut self) -> Option<Cycles> {
        self.known_deadline = self.sched.next_deadline();
        self.known_deadline
    }

    /// Run every peripheral event due at or before `now`.
    pub fn run_events(&mut self, now: Cycles) {
        self.sched.advance_to(now.max(self.sched.now()));
        let clocks = self.clocks;
        while let Some((at, ev)) = self.sched.pop_due() {
            match ev {
                Event::Usart { idx, kind, gen } => {
                    self.usart[idx as usize].event(idx, kind, gen, at, &clocks, &mut self.sched)
                }
                Event::Timer { idx, gen } => {
                    let i = idx as usize;
                    if self.timers[i].gen == gen {
                        self.timers[i].sync(at);
                        self.timer_changed(i, at);
                    }
                }
            }
        }
    }

    /// Characters typed into the terminal attached to a USART (0 = USART1,
    /// 1 = USART2 / ST-LINK VCP, 2 = USART6).
    pub fn terminal_send(&mut self, idx: usize, bytes: &[u8]) {
        let (now, clocks) = (self.sched.now().max(self.now), self.clocks);
        self.usart[idx].host_send(idx as u8, bytes, now, &clocks, &mut self.sched);
    }

    /// Take what the terminal on a USART received.
    pub fn terminal_take(&mut self, idx: usize) -> Vec<TerminalByte> {
        std::mem::take(&mut self.usart[idx].terminal)
    }

    fn after_clock_write(&mut self) {
        let c = self.rcc.clocks();
        if c != self.clocks {
            self.clocks = c;
            self.clock_changed = true;
            self.retime_timers();
        }
        let required = FlashIf::required_latency(c.hclk);
        let latency = self.flash_if.latency();
        if latency < required {
            self.warnings.insert(Warning::FlashLatency {
                hclk: c.hclk,
                latency,
                required,
            });
        }
    }

    /// RCC xxxRSTR: a set bit holds that peripheral in reset (HAL's
    /// `__HAL_RCC_xxx_FORCE_RESET()` / `_RELEASE_RESET()`). Bit names come
    /// from the SVD (`USART2RST` → `USART2`).
    fn apply_peripheral_resets(&mut self, off: u32) {
        let bits = self.rcc.read(off);
        if bits == 0 {
            return;
        }
        let Some((_, reg)) = regmap::register_at(map::RCC_BASE + off) else {
            return;
        };
        for f in reg.fields.iter().filter(|f| bits & (1 << f.lsb) != 0) {
            let name = f.name.strip_suffix("RST").unwrap_or(f.name);
            // SVD field names that differ from the peripheral names.
            let name = match name {
                "UART2" => "USART2",
                "ADC" => "ADC1",
                n => n,
            };
            if let Some(port) = GPIO_NAMES.iter().position(|g| *g == name) {
                let g = &mut self.gpio[port];
                let before: Vec<_> = (0..16).map(|p| g.driven(p)).collect();
                let (ext, driven) = (g.external, g.external_driven);
                *g = Gpio::new(port as u8);
                g.external = ext;
                g.external_driven = driven;
                for (pin, old) in before.into_iter().enumerate() {
                    let new = self.gpio[port].driven(pin as u8);
                    if new != old {
                        self.pin_events.push(PinEvent {
                            time: self.now,
                            port: port as u8,
                            pin: pin as u8,
                            level: new,
                        });
                    }
                }
                self.refresh_port(port, self.now);
                self.circuit_update(self.now);
            } else if let Some(i) = USARTS.iter().position(|u| u.0 == name) {
                self.usart[i].reset(); // also drops its scheduled events
            } else if let Some(i) = TIMERS.iter().position(|t| t.name == name) {
                self.timers[i].reset(self.now);
                self.timer_changed(i, self.now);
            } else if name == "PWR" {
                self.pwr = Pwr::default();
            } else if name == "SYSCFG" {
                self.syscfg = Syscfg::default();
            } else if let Some(p) = regmap::peripheral_by_name(name) {
                self.regs.reset_block(p.base);
            }
        }
    }

    fn gated(
        &mut self,
        enr: u32,
        bit: u32,
        peripheral: &'static str,
        enable_bit: &'static str,
    ) -> bool {
        if self.rcc.clock_enabled(enr, bit) {
            return false;
        }
        self.warnings.insert(Warning::ClockDisabled {
            peripheral,
            enable_bit,
        });
        true
    }

    /// Read for a debugger view (memory viewer): the same value firmware
    /// would read, but without side effects — no flags cleared, no warnings,
    /// no access recorded. Returns `None` for unmapped addresses.
    pub fn peek(&self, addr: u32, size: AccessSize) -> Option<u32> {
        if let Some((word, bit)) = bit_band(addr) {
            return self.peek(word, AccessSize::Word).map(|w| (w >> bit) & 1);
        }
        let a = map::resolve_alias(addr);
        if self.flash.contains(a, size) {
            return self.flash.read(a, size).ok();
        }
        if self.sram.contains(a, size) {
            return self.sram.read(a, size).ok();
        }
        if !map::is_peripheral_space(a) {
            return None;
        }
        let off = a & 0x3FC;
        let enabled = |enr: u32, bit: u32| self.rcc.clock_enabled(enr, bit);
        let word = if let Some(port) = gpio_port(a) {
            if enabled(0x30, port as u32) {
                self.gpio[port].read(off)
            } else {
                0
            }
        } else {
            match a & !0x3FF {
                map::RCC_BASE => self.rcc.read(off),
                map::FLASH_IF_BASE => self.flash_if.read(off),
                map::EXTI_BASE => self.exti.read(off),
                map::SYSCFG_BASE => {
                    if enabled(0x44, 14) {
                        self.syscfg.read(off)
                    } else {
                        0
                    }
                }
                map::PWR_BASE => {
                    if enabled(0x40, 28) {
                        self.pwr.read(off)
                    } else {
                        0
                    }
                }
                base if timer_index(base).is_some() => {
                    let i = timer_index(base).unwrap();
                    if enabled(timer_enr(i), TIMERS[i].enable_bit) {
                        let mut t = self.timers[i].clone();
                        t.sync(self.now);
                        t.read(off)
                    } else {
                        0
                    }
                }
                base => match USARTS.iter().position(|u| u.1 == base) {
                    Some(i) => {
                        let (_, _, _, _, enr, bit, _) = USARTS[i];
                        if enabled(enr, bit) {
                            self.usart[i].peek(off)
                        } else {
                            0
                        }
                    }
                    None => self.regs.peek(a),
                },
            }
        };
        Some((word >> ((a & 3) * 8)) & size_mask(size))
    }

    fn periph_read(&mut self, a: u32) -> u32 {
        let off = a & 0x3FC;
        if let Some(port) = gpio_port(a) {
            if self.gated(0x30, port as u32, GPIO_NAMES[port], GPIO_ENABLE_BITS[port]) {
                return 0;
            }
            return self.gpio[port].read(off);
        }
        match a & !0x3FF {
            map::RCC_BASE => return self.rcc.read(off),
            map::FLASH_IF_BASE => return self.flash_if.read(off),
            map::EXTI_BASE => return self.exti.read(off),
            map::SYSCFG_BASE => {
                if self.gated(0x44, 14, "SYSCFG", "RCC.APB2ENR.SYSCFGEN") {
                    return 0;
                }
                return self.syscfg.read(off);
            }
            map::PWR_BASE => {
                if self.gated(0x40, 28, "PWR", "RCC.APB1ENR.PWREN") {
                    return 0;
                }
                return self.pwr.read(off);
            }
            _ => {}
        }
        if let Some(i) = USARTS.iter().position(|u| u.1 == a & !0x3FF) {
            let (name, _, _, _, enr, bit, en) = USARTS[i];
            if self.gated(enr, bit, name, en) {
                return 0;
            }
            return self.usart[i].read(off);
        }
        if let Some(i) = timer_index(a & !0x3FF) {
            let info = TIMERS[i];
            if self.gated(timer_enr(i), info.enable_bit, info.name, info.enable_name) {
                return 0;
            }
            let t = &mut self.timers[i];
            t.sync(self.now);
            if t.running() && matches!(off, 0x10 | 0x24) {
                self.time_read = true;
            }
            return t.read(off);
        }
        self.regs.read(a)
    }

    fn periph_write(&mut self, a: u32, value: u32, lanes: u32) {
        let off = a & 0x3FC;
        if let Some(port) = gpio_port(a) {
            if self.gated(0x30, port as u32, GPIO_NAMES[port], GPIO_ENABLE_BITS[port]) {
                return;
            }
            self.gpio[port].write(off, value, lanes, self.now, &mut self.pin_events);
            if matches!(off, 0x00 | 0x20 | 0x24) {
                self.apply_af(self.now);
            }
            self.refresh_port(port, self.now);
            self.circuit_update(self.now);
            return;
        }
        match a & !0x3FF {
            map::RCC_BASE => {
                if self.rcc.write(off, value, lanes) {
                    self.after_clock_write();
                }
                if matches!(off, 0x10 | 0x14 | 0x20 | 0x24) {
                    self.apply_peripheral_resets(off);
                }
                if matches!(off, 0x40 | 0x44) {
                    self.update_timer_gates();
                }
                return;
            }
            map::FLASH_IF_BASE => {
                self.flash_if.write(off, value, lanes);
                return;
            }
            map::EXTI_BASE => {
                self.exti.write(off, value, lanes);
                return;
            }
            map::SYSCFG_BASE => {
                if !self.gated(0x44, 14, "SYSCFG", "RCC.APB2ENR.SYSCFGEN") {
                    self.syscfg.write(off, value, lanes);
                }
                return;
            }
            map::PWR_BASE => {
                if !self.gated(0x40, 28, "PWR", "RCC.APB1ENR.PWREN") {
                    self.pwr.write(off, value, lanes);
                }
                return;
            }
            _ => {}
        }
        if let Some(i) = USARTS.iter().position(|u| u.1 == a & !0x3FF) {
            let (name, _, _, _, enr, bit, en) = USARTS[i];
            if !self.gated(enr, bit, name, en) {
                let (now, clocks) = (self.now, self.clocks);
                self.usart[i].write(i as u8, off, value, lanes, now, &clocks, &mut self.sched);
            }
            return;
        }
        if let Some(i) = timer_index(a & !0x3FF) {
            let info = TIMERS[i];
            if !self.gated(timer_enr(i), info.enable_bit, info.name, info.enable_name) {
                let now = self.now;
                self.timers[i].sync(now);
                self.timers[i].write(off, value, lanes, now);
                self.timer_changed(i, now);
            }
            return;
        }
        self.regs.write(a, value, lanes);
    }

    fn read_inner(&mut self, addr: u32, size: AccessSize) -> Result<u32, BusError> {
        let a = map::resolve_alias(addr);
        if self.flash.contains(a, size) {
            return self.flash.read(a, size);
        }
        if self.sram.contains(a, size) {
            return self.sram.read(a, size);
        }
        if map::is_peripheral_space(a) {
            let word = self.periph_read(a);
            return Ok((word >> ((a & 3) * 8)) & size_mask(size));
        }
        Err(BusError::Unmapped(addr))
    }

    fn write_inner(&mut self, addr: u32, size: AccessSize, value: u32) -> Result<(), BusError> {
        let a = map::resolve_alias(addr);
        if self.sram.contains(a, size) {
            self.sram.write(a, size, value)?;
            if let Some(w) = self.watch {
                if a & !3 == w {
                    let v = self.sram.read(w, AccessSize::Word)?;
                    self.watch_log.push((self.now, v));
                }
            }
            return Ok(());
        }
        if self.flash.contains(a, size) {
            // Flash programming goes through the FLASH interface (later).
            return Err(BusError::ReadOnly(addr));
        }
        if map::is_peripheral_space(a) {
            let shift = (a & 3) * 8;
            self.periph_write(a, value << shift, size_mask(size) << shift);
            return Ok(());
        }
        Err(BusError::Unmapped(addr))
    }
}

/// Index in [`TIMERS`] of the timer whose register block starts at `base`.
fn timer_index(base: u32) -> Option<usize> {
    TIMERS.iter().position(|t| t.base == base)
}

/// RCC enable register offset of a timer (APB2ENR or APB1ENR).
fn timer_enr(i: usize) -> u32 {
    if TIMERS[i].apb2 {
        0x44
    } else {
        0x40
    }
}

const GPIO_NAMES: [&str; 8] = ["GPIOA", "GPIOB", "GPIOC", "GPIOD", "GPIOE", "", "", "GPIOH"];

/// GPIO port index for an address in the AHB1 GPIO block, if it exists.
fn gpio_port(addr: u32) -> Option<usize> {
    if !(map::GPIOA_BASE..map::GPIOA_BASE + 0x2000).contains(&addr) {
        return None;
    }
    let port = ((addr - map::GPIOA_BASE) / 0x400) as usize;
    // GPIOF/GPIOG are reserved on the STM32F401.
    (port != 5 && port != 6).then_some(port)
}

/// Translate a bit-band alias address → (word address, bit).
fn bit_band(addr: u32) -> Option<(u32, u32)> {
    let (alias, target) = match addr {
        0x2200_0000..=0x23FF_FFFF => (0x2200_0000, 0x2000_0000),
        0x4200_0000..=0x43FF_FFFF => (0x4200_0000, 0x4000_0000),
        _ => return None,
    };
    let off = addr - alias;
    Some((target + ((off >> 5) & !3), (off >> 2) & 31))
}

fn size_mask(size: AccessSize) -> u32 {
    match size {
        AccessSize::Byte => 0xFF,
        AccessSize::Half => 0xFFFF,
        AccessSize::Word => u32::MAX,
    }
}

impl Bus for Stm32f401Bus {
    fn read(&mut self, addr: u32, size: AccessSize) -> Result<u32, BusError> {
        if let Some((word, bit)) = bit_band(addr) {
            return Ok((self.read_inner(word, AccessSize::Word)? >> bit) & 1);
        }
        self.read_inner(addr, size)
    }

    fn write(&mut self, addr: u32, size: AccessSize, value: u32) -> Result<(), BusError> {
        if let Some((word, bit)) = bit_band(addr) {
            let old = self.read_inner(word, AccessSize::Word)?;
            let new = if value & 1 != 0 {
                old | (1 << bit)
            } else {
                old & !(1 << bit)
            };
            return self.write_inner(word, AccessSize::Word, new);
        }
        self.write_inner(addr, size, value)
    }

    fn set_time(&mut self, now: Cycles) {
        self.now = now;
    }

    fn poll(&mut self, sys: &mut CortexM) -> bool {
        for u in &self.usart {
            if u.irq_line() {
                sys.set_irq_pending(u.irq);
            }
        }
        for irq in self.exti.irqs() {
            sys.set_irq_pending(irq);
        }
        for t in &self.timers {
            if t.info.advanced {
                if t.irq_update() {
                    sys.set_irq_pending(t.info.irq_update);
                }
                if t.irq_cc() {
                    sys.set_irq_pending(t.info.irq_cc);
                }
            } else if t.irq_any() {
                sys.set_irq_pending(t.info.irq_update);
            }
        }
        if std::mem::take(&mut self.time_read) {
            sys.time_reads += 1;
        }
        if std::mem::take(&mut self.exti.event) {
            sys.event = true;
        }
        // A register write may have scheduled an event (e.g. a UART frame)
        // earlier than the deadline the CPU was given: hand back control so
        // the machine stops the CPU in time for it.
        let next = self.sched.next_deadline();
        let earlier = match (next, self.known_deadline) {
            (Some(n), Some(k)) => n < k,
            (Some(_), None) => true,
            _ => false,
        };
        std::mem::take(&mut self.clock_changed) || earlier
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boot_alias_maps_to_flash() {
        let mut bus = Stm32f401Bus::new();
        bus.load(map::FLASH_BASE, &0x2001_8000u32.to_le_bytes())
            .unwrap();
        assert_eq!(bus.read_u32(0x0000_0000).unwrap(), 0x2001_8000);
        assert_eq!(bus.read_u32(map::FLASH_BASE).unwrap(), 0x2001_8000);
    }

    #[test]
    fn unmodelled_peripherals_keep_values_and_are_counted() {
        let mut bus = Stm32f401Bus::new();
        let i2c1_oar1 = map::I2C1_BASE + 0x08;
        let reset = regmap::register_at(i2c1_oar1).unwrap().1.reset;
        assert_eq!(bus.read_u32(i2c1_oar1).unwrap(), reset, "SVD reset value");
        bus.write(i2c1_oar1, AccessSize::Word, 0x4033).unwrap();
        assert_eq!(bus.read_u32(i2c1_oar1).unwrap(), 0x4033);
        assert_eq!(bus.regs.accesses.len(), 2);
        assert_eq!(regmap::describe(i2c1_oar1), "I2C1.OAR1");
    }

    #[test]
    fn gpio_needs_its_clock() {
        let mut bus = Stm32f401Bus::new();
        bus.write(map::GPIOA_BASE, AccessSize::Word, 1 << 10)
            .unwrap();
        assert_eq!(
            bus.read_u32(map::GPIOA_BASE).unwrap(),
            0,
            "clock off: write lost, reads 0"
        );
        assert!(bus.warnings.contains(&Warning::ClockDisabled {
            peripheral: "GPIOA",
            enable_bit: "RCC.AHB1ENR.GPIOAEN"
        }));
        bus.write(map::RCC_BASE + 0x30, AccessSize::Word, 1)
            .unwrap();
        bus.write(map::GPIOA_BASE, AccessSize::Word, 0xA800_0000 | 1 << 10)
            .unwrap();
        assert_eq!(bus.read_u32(map::GPIOA_BASE).unwrap(), 0xA800_0400);
    }

    #[test]
    fn bit_banding_sram_and_gpio() {
        let mut bus = Stm32f401Bus::new();
        bus.write(map::RCC_BASE + 0x30, AccessSize::Word, 1)
            .unwrap();
        // SRAM word 0x2000_0010, bit 3
        bus.write(0x2200_0000 + 0x10 * 32 + 3 * 4, AccessSize::Word, 1)
            .unwrap();
        assert_eq!(bus.read_u32(0x2000_0010).unwrap(), 1 << 3);
        assert_eq!(bus.read_u32(0x2200_0000 + 0x10 * 32 + 3 * 4).unwrap(), 1);
        // GPIOA ODR bit 5 via the peripheral alias
        bus.write(map::GPIOA_BASE, AccessSize::Word, 1 << 10)
            .unwrap();
        let odr5 = 0x4200_0000 + (map::GPIOA_BASE + 0x14 - 0x4000_0000) * 32 + 5 * 4;
        bus.write(odr5, AccessSize::Word, 1).unwrap();
        assert!(bus.gpio[0].level(5));
        assert_eq!(bus.pin_events.last().unwrap().level, Some(true));
    }

    #[test]
    fn rcc_reset_bits_reset_the_peripheral() {
        let mut bus = Stm32f401Bus::new();
        let usart2 = map::USART2_BASE;
        bus.write(map::RCC_BASE + 0x40, AccessSize::Word, 1 << 17)
            .unwrap(); // USART2EN
        bus.write(usart2 + 0x08, AccessSize::Word, 0x16D).unwrap();
        bus.write(usart2 + 0x0C, AccessSize::Word, 0x200C).unwrap();
        bus.write(usart2 + 0x04, AccessSize::Word, b'x' as u32)
            .unwrap();
        assert!(bus.next_deadline().is_some(), "a frame is being sent");
        // __HAL_RCC_USART2_FORCE_RESET(); __HAL_RCC_USART2_RELEASE_RESET();
        bus.write(map::RCC_BASE + 0x20, AccessSize::Word, 1 << 17)
            .unwrap();
        bus.write(map::RCC_BASE + 0x20, AccessSize::Word, 0)
            .unwrap();
        assert_eq!(bus.read_u32(usart2 + 0x08).unwrap(), 0);
        assert_eq!(bus.read_u32(usart2 + 0x0C).unwrap(), 0);
        bus.run_events(1_000_000);
        assert!(
            bus.terminal_take(1).is_empty(),
            "the frame in flight was dropped"
        );

        // A timer (TIM3) and GPIO.
        bus.write(0x4000_042C, AccessSize::Word, 123).unwrap();
        bus.write(map::RCC_BASE + 0x20, AccessSize::Word, 1 << 1)
            .unwrap(); // TIM3RST
        assert_eq!(
            bus.read_u32(0x4000_042C).unwrap(),
            regmap::register_at(0x4000_042C).unwrap().1.reset
        );
        bus.write(map::RCC_BASE + 0x30, AccessSize::Word, 1)
            .unwrap();
        bus.write(map::GPIOA_BASE, AccessSize::Word, 0xA800_0400)
            .unwrap();
        bus.write(map::RCC_BASE + 0x10, AccessSize::Word, 1)
            .unwrap(); // GPIOARST
        assert_eq!(bus.read_u32(map::GPIOA_BASE).unwrap(), 0xA800_0000);
    }

    #[test]
    fn pin_edges_reach_the_nvic_through_exti() {
        let mut bus = Stm32f401Bus::new();
        let mut sys = CortexM::new();
        // GPIOC clock, PC13 input; EXTI13 ← port C, falling edge, unmasked.
        bus.write(map::RCC_BASE + 0x30, AccessSize::Word, 1 << 2)
            .unwrap();
        bus.write(map::RCC_BASE + 0x44, AccessSize::Word, 1 << 14)
            .unwrap(); // SYSCFGEN
        bus.set_external(2, 13, Some(true));
        bus.write(map::SYSCFG_BASE + 0x14, AccessSize::Word, 2 << 4)
            .unwrap();
        bus.write(map::EXTI_BASE + 0x0C, AccessSize::Word, 1 << 13)
            .unwrap();
        bus.write(map::EXTI_BASE, AccessSize::Word, 1 << 13)
            .unwrap();
        bus.set_external(2, 13, Some(false));
        assert_eq!(bus.read_u32(map::EXTI_BASE + 0x14).unwrap(), 1 << 13);
        bus.poll(&mut sys);
        assert_ne!(
            sys.peek(0xE000_E204, AccessSize::Word) & (1 << 8),
            0,
            "EXTI15_10 pending in NVIC_ISPR1"
        );
        // A different port on the same line is ignored.
        bus.write(map::EXTI_BASE + 0x14, AccessSize::Word, 1 << 13)
            .unwrap();
        bus.set_external(0, 13, Some(true));
        bus.set_external(0, 13, Some(false));
        assert_eq!(bus.read_u32(map::EXTI_BASE + 0x14).unwrap(), 0);
        // An output toggled by firmware is an edge too.
        bus.write(map::SYSCFG_BASE + 0x08, AccessSize::Word, 0)
            .unwrap();
        bus.write(map::RCC_BASE + 0x30, AccessSize::Word, 1)
            .unwrap();
        bus.write(map::GPIOA_BASE, AccessSize::Word, 1 << 2 | 0xA800_0000)
            .unwrap(); // PA1 output
        bus.write(map::EXTI_BASE + 0x08, AccessSize::Word, 1 << 1)
            .unwrap();
        bus.write(map::EXTI_BASE, AccessSize::Word, 1 << 1).unwrap();
        bus.write(map::GPIOA_BASE + 0x18, AccessSize::Word, 1 << 1)
            .unwrap();
        assert_eq!(bus.read_u32(map::EXTI_BASE + 0x14).unwrap(), 1 << 1);
    }

    #[test]
    fn tim2_pwm_drives_ld2_through_its_alternate_function() {
        let mut bus = Stm32f401Bus::new();
        let mut sys = CortexM::new();
        let w = |bus: &mut Stm32f401Bus, a: u32, v: u32| {
            bus.write(a, AccessSize::Word, v).unwrap();
        };
        w(&mut bus, map::RCC_BASE + 0x30, 1); // GPIOAEN
        w(&mut bus, map::RCC_BASE + 0x40, 1); // TIM2EN
        w(&mut bus, map::GPIOA_BASE, 0xA800_0000 | 2 << 10); // PA5 AF
        w(&mut bus, map::GPIOA_BASE + 0x20, 1 << 20); // AF1 = TIM2_CH1
        let tim2 = map::TIM2_BASE;
        w(&mut bus, tim2 + 0x28, 15); // 16 MHz / 16 = 1 MHz
        w(&mut bus, tim2 + 0x2C, 999); // 1 kHz
        w(&mut bus, tim2 + 0x34, 250); // 25 %
        w(&mut bus, tim2 + 0x18, 6 << 4 | 1 << 3); // PWM1, preload
        w(&mut bus, tim2 + 0x20, 1); // CC1E
        w(&mut bus, tim2 + 0x14, 1); // UG
        w(&mut bus, tim2 + 0x0C, 1); // UIE
        w(&mut bus, tim2, 1 << 7 | 1); // ARPE | CEN
        assert!(bus.gpio[0].level(5), "PWM starts high");
        bus.pin_events.clear();
        for t in (0..=32_000u64).step_by(100) {
            bus.set_time(t);
            bus.run_events(t);
        }
        let edges: Vec<_> = bus.pin_events.iter().map(|e| (e.time, e.level)).collect();
        assert_eq!(
            edges,
            vec![
                (4_000, Some(false)),
                (16_000, Some(true)),
                (20_000, Some(false)),
                (32_000, Some(true)),
            ]
        );
        bus.poll(&mut sys);
        assert_ne!(
            sys.peek(0xE000_E100 + 0x100, AccessSize::Word) & (1 << 28),
            0,
            "TIM2 update interrupt pending"
        );
        // Reading CNT of a running timer counts as a time read.
        let before = sys.time_reads;
        bus.set_time(32_123);
        assert_eq!(bus.read_u32(tim2 + 0x24).unwrap(), 7);
        bus.poll(&mut sys);
        assert_eq!(sys.time_reads, before + 1);
    }

    #[test]
    fn peek_has_no_side_effects() {
        let mut bus = Stm32f401Bus::new();
        bus.write(map::RCC_BASE + 0x40, AccessSize::Word, 1 << 17)
            .unwrap();
        bus.write(map::USART2_BASE + 0x08, AccessSize::Word, 0x8B) // 115200 at 16 MHz PCLK1
            .unwrap();
        bus.write(map::USART2_BASE + 0x0C, AccessSize::Word, 0x200C)
            .unwrap();
        bus.terminal_send(1, b"x");
        bus.run_events(1_000_000);
        let sr = map::USART2_BASE;
        assert_ne!(bus.peek(sr, AccessSize::Word).unwrap() & usart::RXNE, 0);
        // Viewing SR and DR (as the memory viewer does) changes nothing.
        assert_eq!(bus.peek(sr + 4, AccessSize::Word), Some(b'x' as u32));
        assert_ne!(
            bus.peek(sr, AccessSize::Word).unwrap() & usart::RXNE,
            0,
            "RXNE still set"
        );
        let accesses = bus.regs.accesses.len();
        bus.peek(map::I2C1_BASE + 0x08, AccessSize::Word);
        assert_eq!(bus.regs.accesses.len(), accesses, "peeks are not recorded");
        assert_eq!(bus.peek(0x6000_0000, AccessSize::Byte), None);
    }

    #[test]
    fn clock_switch_is_reported_and_flash_latency_checked() {
        let mut bus = Stm32f401Bus::new();
        let mut sys = CortexM::new();
        // PLL 84 MHz from HSI, switch without raising flash latency.
        bus.write(
            map::RCC_BASE + 4,
            AccessSize::Word,
            16 | (336 << 6) | (1 << 16) | (7 << 24),
        )
        .unwrap();
        bus.write(map::RCC_BASE, AccessSize::Word, 0x83 | 1 << 24)
            .unwrap();
        bus.write(map::RCC_BASE + 8, AccessSize::Word, 2).unwrap();
        assert!(bus.poll(&mut sys));
        assert_eq!(bus.clocks().hclk, 84_000_000);
        assert!(bus.warnings.contains(&Warning::FlashLatency {
            hclk: 84_000_000,
            latency: 0,
            required: 2
        }));
        assert!(!bus.poll(&mut sys));
    }
}
