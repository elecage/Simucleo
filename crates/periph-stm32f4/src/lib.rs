//! STM32F401RE memory map and peripherals.
//!
//! Modelled: flash, SRAM, boot alias, bit-banding, GPIO, EXTI, RCC (clock
//! tree), PWR, FLASH interface, SYSCFG, USART1/2/6, TIM1–5 and TIM9–11,
//! ADC1, I2C1–3 and SPI1–4. Every other peripheral is backed by a
//! register file initialised from ST's SVD, so firmware reads back what it
//! wrote and sees correct reset values; those accesses are counted so the
//! GUI can show which peripheral the firmware relies on that is not
//! simulated yet.

pub mod adc;
pub mod dma;
pub mod exti;
pub mod gpio;
pub mod i2c;
pub mod map;
pub mod rcc;
pub mod regmap;
pub mod spi;
#[rustfmt::skip]
pub mod svd;
pub mod svd_types;
pub mod sysctl;
pub mod timer;
pub mod usart;
pub mod wire;

use std::collections::BTreeSet;

use adc::{Adc, AdcAction};
use dma::{Dma, Request};
use exti::Exti;
use gpio::{Gpio, PinDrive, PinEvent};
use i2c::{I2c, I2cBus, I2cOp, I2cReply};
use rcc::{Clocks, Rcc, ResetCause};
use regmap::RegisterFile;
use simucleo_core::bus::{AccessSize, Bus, BusError, Memory};
use simucleo_core::cortexm::CortexM;
use simucleo_core::sched::Scheduler;
use simucleo_core::Cycles;
use spi::{Spi, SpiBus};
use sysctl::{FlashIf, Pwr, Syscfg};
use timer::{Timer, TIMERS};
use usart::{TerminalByte, Usart, UsartEventKind};
use wire::{WireEvent, WireSignal};

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
    Adc {
        gen: u32,
    },
    I2c {
        idx: u8,
        gen: u32,
    },
    Spi {
        idx: u8,
        gen: u32,
    },
    /// Something in the external circuit changes on its own (a sensor's
    /// reply on a data line).
    Circuit {
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
    /// When the circuit next changes by itself (a device driving a line on
    /// its own schedule); the bus calls [`ExternalCircuit::update`] then.
    fn next_event(&self) -> Option<Cycles> {
        None
    }
    /// Voltage the circuit puts on a pin (for the ADC), if it is connected.
    fn voltage(&self, _port: u8, _pin: u8) -> Option<f64> {
        None
    }
    /// One I2C bus operation at `time` for the devices on the nets of
    /// `scl` and `sda` (port, pin). Default: nobody answers.
    fn i2c(&mut self, _time: Cycles, _scl: (u8, u8), _sda: (u8, u8), op: I2cOp) -> I2cReply {
        i2c::NoDevices.transfer(op)
    }
    /// One SPI byte at `time` on the bus whose SCK and MOSI are those pins;
    /// returns what the selected device puts on `miso` (0xFF: nothing).
    fn spi(
        &mut self,
        _time: Cycles,
        _sck: (u8, u8),
        _mosi: (u8, u8),
        _miso: Option<(u8, u8)>,
        _out: u8,
    ) -> u8 {
        0xFF
    }
}

/// Pins as (port, pin, alternate function).
type I2cPins = &'static [(u8, u8, u8)];

/// An I2C instance and where its signals can go.
struct I2cInfo {
    name: &'static str,
    base: u32,
    irq_ev: u16,
    irq_er: u16,
    /// Bit in RCC.APB1ENR.
    enable_bit: u32,
    enable_name: &'static str,
    scl: I2cPins,
    sda: I2cPins,
}

const I2CS: [I2cInfo; 3] = [
    I2cInfo {
        name: "I2C1",
        base: 0x4000_5400,
        irq_ev: 31,
        irq_er: 32,
        enable_bit: 21,
        enable_name: "RCC.APB1ENR.I2C1EN",
        scl: &[(1, 6, 4), (1, 8, 4)],
        sda: &[(1, 7, 4), (1, 9, 4)],
    },
    I2cInfo {
        name: "I2C2",
        base: 0x4000_5800,
        irq_ev: 33,
        irq_er: 34,
        enable_bit: 22,
        enable_name: "RCC.APB1ENR.I2C2EN",
        scl: &[(1, 10, 4)],
        sda: &[(1, 3, 9), (1, 11, 4)],
    },
    I2cInfo {
        name: "I2C3",
        base: 0x4000_5C00,
        irq_ev: 72,
        irq_er: 73,
        enable_bit: 23,
        enable_name: "RCC.APB1ENR.I2C3EN",
        scl: &[(0, 8, 4)],
        sda: &[(2, 9, 4), (1, 4, 9)],
    },
];

/// The devices an I2C controller reaches through the external circuit.
struct CircuitI2c<'a> {
    circuit: Option<&'a mut Box<dyn ExternalCircuit>>,
    pins: Option<((u8, u8), (u8, u8))>,
    time: Cycles,
    /// Where to log the operations for probes, with the SCL period and
    /// the end of the last one logged.
    log: Option<(&'a mut Vec<WireEvent>, f64, &'a mut f64)>,
}

impl I2cBus for CircuitI2c<'_> {
    fn transfer(&mut self, op: I2cOp) -> I2cReply {
        let reply = match (&mut self.circuit, self.pins) {
            (Some(c), Some((scl, sda))) => c.i2c(self.time, scl, sda, op),
            _ => i2c::NoDevices.transfer(op),
        };
        if let (Some((log, period, last)), Some((scl, sda))) = (&mut self.log, self.pins) {
            let ev = WireEvent::I2c {
                scl,
                sda,
                time: self.time,
                period: *period,
                op,
                reply,
                after: **last,
            };
            **last = ev.end();
            log.push(ev);
        }
        reply
    }
}

/// An SPI instance and where its signals can go.
struct SpiInfo {
    name: &'static str,
    base: u32,
    irq: u16,
    /// On APB2 (else APB1); the enable bit is in that bus's ENR.
    apb2: bool,
    enable_bit: u32,
    enable_name: &'static str,
    sck: I2cPins,
    miso: I2cPins,
    mosi: I2cPins,
}

const SPIS: [SpiInfo; 4] = [
    SpiInfo {
        name: "SPI1",
        base: 0x4001_3000,
        irq: 35,
        apb2: true,
        enable_bit: 12,
        enable_name: "RCC.APB2ENR.SPI1EN",
        sck: &[(0, 5, 5), (1, 3, 5)],
        miso: &[(0, 6, 5), (1, 4, 5)],
        mosi: &[(0, 7, 5), (1, 5, 5)],
    },
    SpiInfo {
        name: "SPI2",
        base: 0x4000_3800,
        irq: 36,
        apb2: false,
        enable_bit: 14,
        enable_name: "RCC.APB1ENR.SPI2EN",
        sck: &[(1, 10, 5), (1, 13, 5), (2, 7, 5)],
        miso: &[(1, 14, 5), (2, 2, 5)],
        mosi: &[(1, 15, 5), (2, 3, 5)],
    },
    SpiInfo {
        name: "SPI3",
        base: 0x4000_3C00,
        irq: 51,
        apb2: false,
        enable_bit: 15,
        enable_name: "RCC.APB1ENR.SPI3EN",
        sck: &[(1, 3, 6), (2, 10, 6)],
        miso: &[(1, 4, 6), (2, 11, 6)],
        mosi: &[(1, 5, 6), (2, 12, 6)],
    },
    SpiInfo {
        name: "SPI4",
        base: 0x4001_3400,
        irq: 84,
        apb2: true,
        enable_bit: 13,
        enable_name: "RCC.APB2ENR.SPI4EN",
        sck: &[(1, 13, 6)],
        miso: &[(0, 11, 6)],
        mosi: &[(0, 1, 5)],
    },
];

/// SCK, MOSI and (if routed) MISO of an SPI controller.
type SpiPins = ((u8, u8), (u8, u8), Option<(u8, u8)>);

/// The devices an SPI controller reaches through the external circuit.
struct CircuitSpi<'a> {
    circuit: Option<&'a mut Box<dyn ExternalCircuit>>,
    pins: Option<SpiPins>,
    time: Cycles,
    /// Bytes exchanged (MOSI, MISO), logged for probes.
    log: Option<Vec<(u8, u8)>>,
}

impl SpiBus for CircuitSpi<'_> {
    fn exchange(&mut self, out: u8) -> u8 {
        let inp = match (&mut self.circuit, self.pins) {
            (Some(c), Some((sck, mosi, miso))) => c.spi(self.time, sck, mosi, miso, out),
            _ => 0xFF,
        };
        if let Some(log) = &mut self.log {
            log.push((out, inp));
        }
        inp
    }
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

/// The (port, pin) a USART's TX and RX are routed to, if they are.
pub type UsartPins = (Option<(u8, u8)>, Option<(u8, u8)>);

/// Where each USART's TX and RX can go: (USART index, port, pin, AF, TX).
/// USART1 on PA9/PA10 (D8/D2) or PB6/PB7, USART2 on PA2/PA3 (the ST-LINK
/// virtual COM port), USART6 on PA11/PA12 or PC6/PC7.
pub const USART_PINS: [(usize, u8, u8, u8, bool); 10] = [
    (0, 0, 9, 7, true),
    (0, 1, 6, 7, true),
    (0, 0, 10, 7, false),
    (0, 1, 7, 7, false),
    (1, 0, 2, 7, true),
    (1, 0, 3, 7, false),
    (2, 0, 11, 8, true),
    (2, 2, 6, 8, true),
    (2, 0, 12, 8, false),
    (2, 2, 7, 8, false),
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
    /// Bytes USART, I2C and SPI moved on probed pins, to draw them bit by
    /// bit (see [`wire`]). The owner drains it with
    /// [`Stm32f401Bus::take_wire_events`].
    pub wire_events: Vec<WireEvent>,
    /// End of the last I2C operation logged, per controller.
    i2c_wire_end: [f64; 3],
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
    pub adc: Adc,
    /// I2C1, I2C2, I2C3.
    pub i2c: [I2c; 3],
    /// SPI1, SPI2, SPI3, SPI4.
    pub spi: [Spi; 4],
    /// DMA1, DMA2.
    pub dma: [Dma; 2],
    /// A DMA transfer is being made (its register accesses must not start
    /// another round).
    dma_busy: bool,
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
    /// Generation of the circuit's own scheduled event.
    circuit_gen: u32,
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
            wire_events: Vec::new(),
            i2c_wire_end: [0.0; 3],
            watch: None,
            watch_log: Vec::new(),
            rcc,
            pwr: Pwr::default(),
            flash_if: FlashIf::default(),
            usart: USARTS.map(|(name, _, irq, apb2, ..)| Usart::new(name, irq, apb2)),
            exti: Exti::default(),
            syscfg: Syscfg::default(),
            adc: Adc::default(),
            i2c: I2CS.map(|c| I2c::new(c.name, c.irq_ev, c.irq_er)),
            spi: SPIS.map(|c| Spi::new(c.name, c.irq)),
            dma: [Dma::new(0), Dma::new(1)],
            dma_busy: false,
            timers: TIMERS.map(Timer::new),
            time_read: false,
            levels: [0; 8],
            circuit: None,
            circuit_pins: Vec::new(),
            circuit_gen: 0,
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
        bus.update_adc_gate();
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

    /// Pause the ADC while its bus clock is off: the conversion in progress
    /// is dropped from the schedule and starts over when the clock returns.
    fn update_adc_gate(&mut self) {
        let gated = !self.rcc.clock_enabled(0x44, 8);
        if self.adc.gated == gated {
            return;
        }
        self.adc.gated = gated;
        if gated {
            self.adc.gen = self.adc.gen.wrapping_add(1);
        } else if self.adc.converting.is_some() {
            let (now, clocks) = (self.now, self.clocks);
            self.adc.begin(now, &clocks, &mut self.sched);
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
        // TIM1 complementary outputs.
        for &(port, pin, af, ch) in timer::PIN_MAP_N {
            let g = &self.gpio[port as usize];
            if g.mode(pin) != gpio::PinMode::Alternate || g.af(pin) != af {
                continue;
            }
            if let Some(level) = self.timers[0].output_n(ch as usize) {
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
        self.update_break_input(time);
        self.circuit_update(time);
    }

    /// TIM1's break input follows its pin (PA6 or PB12 in AF1).
    fn update_break_input(&mut self, time: Cycles) {
        let pin = timer::BKIN_PINS.iter().find(|&&(port, pin, af)| {
            let g = &self.gpio[port as usize];
            g.mode(pin) == gpio::PinMode::Alternate && g.af(pin) == af
        });
        let (routed, level) = match pin {
            Some(&(port, pin, _)) => (true, self.gpio[port as usize].level(pin)),
            None => (false, false),
        };
        if self.timers[0].set_break_input(routed, level, time) {
            self.timer_changed(0, time);
        }
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
        // Timer inputs (input capture, slave reset) on alternate-function pins.
        for &(p, pin, af, ti, ch) in timer::PIN_MAP {
            if p as usize != port || changed & (1 << pin) == 0 {
                continue;
            }
            let g = &self.gpio[port];
            if g.mode(pin) != gpio::PinMode::Alternate || g.af(pin) != af {
                continue;
            }
            if !(0..TIMERS[ti as usize].channels as usize)
                .any(|c| self.timers[ti as usize].is_input(c))
            {
                continue;
            }
            // The other input of the TI1/TI2 pair (encoder mode).
            let other = timer::PIN_MAP
                .iter()
                .find(|&&(op, opin, oaf, oti, och)| {
                    oti == ti
                        && och == ch ^ 1
                        && self.gpio[op as usize].mode(opin) == gpio::PinMode::Alternate
                        && self.gpio[op as usize].af(opin) == oaf
                })
                .map(|&(op, opin, ..)| self.gpio[op as usize].level(opin));
            self.timers[ti as usize].input_edge(ch as usize, new & (1 << pin) != 0, time, other);
            self.reschedule_timer(ti as usize);
        }
        if timer::BKIN_PINS
            .iter()
            .any(|&(p, pin, _)| p as usize == port && changed & (1 << pin) != 0)
        {
            self.update_break_input(time);
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
        // The circuit's own next change.
        self.circuit_gen = self.circuit_gen.wrapping_add(1);
        if let Some(at) = c.next_event() {
            let gen = self.circuit_gen;
            self.sched.schedule_at(at.max(time), Event::Circuit { gen });
        }
        self.circuit = Some(c);
        if let Some(levels) = levels {
            let pins = self.circuit_pins.clone();
            for (&(port, pin), level) in pins.iter().zip(levels) {
                self.set_external_at(port as usize, pin, level, time);
            }
        }
    }

    /// The SCL and SDA pins an I2C controller is routed to (GPIO in
    /// alternate-function mode with the right AF), if both are.
    fn i2c_pins(&self, i: usize) -> Option<((u8, u8), (u8, u8))> {
        let routed = |pins: I2cPins| {
            pins.iter()
                .find(|&&(port, pin, af)| {
                    let g = &self.gpio[port as usize];
                    g.mode(pin) == gpio::PinMode::Alternate && g.af(pin) == af
                })
                .map(|&(port, pin, _)| (port, pin))
        };
        Some((routed(I2CS[i].scl)?, routed(I2CS[i].sda)?))
    }

    /// The TX and RX pins USART `i` (0 = USART1, 1 = USART2, 2 = USART6) is
    /// routed to: GPIOs in alternate-function mode with its AF.
    pub fn usart_pins(&self, i: usize) -> UsartPins {
        let routed = |tx: bool| {
            USART_PINS
                .iter()
                .find(|&&(u, port, pin, af, t)| {
                    let g = &self.gpio[port as usize];
                    u == i && t == tx && g.mode(pin) == gpio::PinMode::Alternate && g.af(pin) == af
                })
                .map(|&(_, port, pin, ..)| (port, pin))
        };
        (routed(true), routed(false))
    }

    /// Baud rate USART `i` is configured for with the present clocks.
    pub fn usart_baud(&self, i: usize) -> Option<f64> {
        self.usart[i].baud(&self.clocks)
    }

    /// Whether a probe watches the pin.
    fn probed(&self, (port, pin): (u8, u8)) -> bool {
        self.probe_mask[port as usize] & (1 << pin) != 0
    }

    /// The SCL period (core cycles) to log I2C `i`'s operations with, when
    /// a probe watches its pins.
    fn i2c_log_period(&self, i: usize, pins: Option<((u8, u8), (u8, u8))>) -> Option<f64> {
        let (scl, sda) = pins?;
        (self.probed(scl) || self.probed(sda))
            .then(|| self.i2c[i].byte_cycles(&self.clocks) as f64 / 9.0)
    }

    /// Let each USART log its frames when a probe watches one of the pins
    /// its TX or RX can be routed to (call after changing `probe_mask`; the
    /// routing is looked up when the frames are taken).
    pub fn sync_wire_logging(&mut self) {
        for i in 0..self.usart.len() {
            let on = USART_PINS
                .iter()
                .any(|&(u, port, pin, ..)| u == i && self.probed((port, pin)));
            self.usart[i].wire_log = on;
            if !on {
                self.usart[i].wire.clear();
            }
        }
    }

    /// The byte-level transfers logged since the last call (see [`wire`]).
    pub fn take_wire_events(&mut self) -> Vec<WireEvent> {
        let mut out = std::mem::take(&mut self.wire_events);
        for i in 0..self.usart.len() {
            if self.usart[i].wire.is_empty() {
                continue;
            }
            let (tx, rx) = self.usart_pins(i);
            for f in std::mem::take(&mut self.usart[i].wire) {
                let Some(pin) = (if f.tx { tx } else { rx }) else {
                    continue;
                };
                out.push(WireEvent::Uart {
                    pin,
                    tx: f.tx,
                    start: f.start,
                    bit: f.bit,
                    data: f.data,
                    data_bits: f.data_bits,
                    parity: f.parity,
                    stop_halves: f.stop_halves,
                });
            }
        }
        out
    }

    /// The byte-level signal a pin is routed to (alternate function of a
    /// USART, I2C or SPI), whose probe shows synthesized edges.
    pub fn wire_signal(&self, port: u8, pin: u8) -> Option<WireSignal> {
        let g = &self.gpio[port as usize];
        if g.mode(pin) != gpio::PinMode::Alternate {
            return None;
        }
        let af = g.af(pin);
        if USART_PINS
            .iter()
            .any(|&(_, p, n, a, _)| (p, n, a) == (port, pin, af))
        {
            return Some(WireSignal::Uart);
        }
        let on = |pins: I2cPins| pins.contains(&(port, pin, af));
        if I2CS.iter().any(|c| on(c.scl) || on(c.sda)) {
            return Some(WireSignal::I2c);
        }
        for (i, c) in SPIS.iter().enumerate() {
            if on(c.sck) {
                return Some(WireSignal::SpiSck {
                    cpol: self.spi[i].cr1 & 2 != 0,
                });
            }
            if on(c.mosi) || on(c.miso) {
                return Some(WireSignal::SpiData);
            }
        }
        None
    }

    /// The pins an SPI controller is routed to: SCK and MOSI must be, MISO
    /// may be left out (transmit-only wiring).
    fn spi_pins(&self, i: usize) -> Option<SpiPins> {
        let routed = |pins: I2cPins| {
            pins.iter()
                .find(|&&(port, pin, af)| {
                    let g = &self.gpio[port as usize];
                    g.mode(pin) == gpio::PinMode::Alternate && g.af(pin) == af
                })
                .map(|&(port, pin, _)| (port, pin))
        };
        let c = &SPIS[i];
        Some((routed(c.sck)?, routed(c.mosi)?, routed(c.miso)))
    }

    fn spi_frame_cycles(&self, i: usize) -> Cycles {
        let pclk = if SPIS[i].apb2 {
            self.clocks.pclk2
        } else {
            self.clocks.pclk1
        };
        self.spi[i].frame_cycles(self.clocks.hclk, pclk)
    }

    fn spi_enr(i: usize) -> u32 {
        if SPIS[i].apb2 {
            0x44
        } else {
            0x40
        }
    }

    /// Voltage at an ADC channel: the internal sources, or the pin as the
    /// external circuit (or, without one, the pin's own drive) sets it.
    fn channel_voltage(&self, ch: u8) -> f64 {
        if let Some(v) = self.adc.internal_voltage(ch) {
            return v;
        }
        let Some(&(port, pin)) = adc::CHANNEL_PINS.get(ch as usize) else {
            return 0.0;
        };
        self.pin_voltage(port, pin)
    }

    /// Voltage on a pin (V).
    pub fn pin_voltage(&self, port: u8, pin: u8) -> f64 {
        if let Some(v) = self.circuit.as_ref().and_then(|c| c.voltage(port, pin)) {
            return v;
        }
        let level = match self.gpio[port as usize].drive(pin) {
            PinDrive::High | PinDrive::PullUp => true,
            PinDrive::Low | PinDrive::PullDown | PinDrive::Float => false,
        };
        if level {
            adc::VREF
        } else {
            0.0
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
        let now = (g.external_driven & bit != 0).then_some(g.external & bit != 0);
        if now == level {
            // Nothing changes on the pin (the circuit reports every input
            // whenever any changed).
            return;
        }
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
        self.adc.reset();
        for i in &mut self.i2c {
            i.reset();
        }
        for s in &mut self.spi {
            s.reset();
        }
        for d in &mut self.dma {
            d.reset();
        }
        let now = self.sched.now().max(self.now);
        for t in &mut self.timers {
            t.reset(now);
        }
        self.regs.clear();
        self.update_timer_gates();
        self.update_adc_gate();
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
                Event::I2c { idx, gen } => {
                    let i = idx as usize;
                    if self.i2c[i].gen == gen {
                        let pins = self.i2c_pins(i);
                        let period = self.i2c_log_period(i, pins);
                        let mut bus = CircuitI2c {
                            circuit: self.circuit.as_mut(),
                            pins,
                            time: at,
                            log: period
                                .map(|p| (&mut self.wire_events, p, &mut self.i2c_wire_end[i])),
                        };
                        self.i2c[i].event(at, &clocks, &mut self.sched, idx, &mut bus);
                    }
                }
                Event::Spi { idx, gen } => {
                    let i = idx as usize;
                    if self.spi[i].gen == gen {
                        let (pins, cycles) = (self.spi_pins(i), self.spi_frame_cycles(i));
                        let logging = pins.is_some_and(|(sck, mosi, miso)| {
                            self.probed(sck)
                                || self.probed(mosi)
                                || miso.is_some_and(|m| self.probed(m))
                        });
                        let mut bus = CircuitSpi {
                            circuit: self.circuit.as_mut(),
                            pins,
                            time: at,
                            log: logging.then(Vec::new),
                        };
                        self.spi[i].event(at, cycles, &mut self.sched, idx, &mut bus);
                        if let (Some(bytes), Some((sck, mosi, miso))) = (bus.log, pins) {
                            if !bytes.is_empty() {
                                let cr1 = self.spi[i].cr1;
                                self.wire_events.push(WireEvent::Spi {
                                    sck,
                                    mosi,
                                    miso,
                                    start: at.saturating_sub(cycles),
                                    end: at,
                                    cpol: cr1 & 2 != 0,
                                    cpha: cr1 & 1 != 0,
                                    bytes,
                                });
                            }
                        }
                    }
                }
                Event::Circuit { gen } => {
                    if self.circuit_gen == gen {
                        self.circuit_update_forced(at);
                    }
                }
                Event::Adc { gen } => {
                    if self.adc.gen == gen {
                        if let Some(ch) = self.adc.converting {
                            let v = self.channel_voltage(ch);
                            if self.adc.complete(v) {
                                self.adc.begin(at, &clocks, &mut self.sched);
                            }
                        }
                    }
                }
                Event::Timer { idx, gen } => {
                    let i = idx as usize;
                    if self.timers[i].gen == gen {
                        self.timers[i].sync(at);
                        self.timer_changed(i, at);
                    }
                }
            }
            // Requests the event raised are served at its time.
            let saved = self.now;
            self.now = at;
            self.service_dma();
            self.now = saved.max(at);
        }
    }

    /// Whether a peripheral DMA request line is active.
    fn dma_request_active(&self, r: Request) -> bool {
        match r {
            Request::UsartTx(i) => {
                let u = &self.usart[i as usize];
                u.cr3 & (1 << 7) != 0 && u.sr & usart::TXE != 0
            }
            Request::UsartRx(i) => {
                let u = &self.usart[i as usize];
                u.cr3 & (1 << 6) != 0 && u.sr & usart::RXNE != 0
            }
            Request::SpiTx(i) => {
                let s = &self.spi[i as usize];
                s.cr2 & 2 != 0 && s.sr & spi::TXE != 0
            }
            Request::SpiRx(i) => {
                let s = &self.spi[i as usize];
                s.cr2 & 1 != 0 && s.sr & spi::RXNE != 0
            }
            Request::Adc1 => self.adc.cr2 & (1 << 8) != 0 && self.adc.sr & adc::EOC != 0,
            Request::TimUp(t) => self.timers[t as usize].dma_req & 1 != 0,
            Request::TimCh(t, c) => self.timers[t as usize].dma_req & (2 << c) != 0,
        }
    }

    /// Move data for every DMA stream whose request is active, until none
    /// is (each transfer can clear or raise requests).
    fn service_dma(&mut self) {
        if self.dma_busy
            || !self
                .dma
                .iter()
                .any(|d| d.streams.iter().any(|s| s.enabled()))
        {
            return;
        }
        self.dma_busy = true;
        // A runaway (memory-to-memory of 65535 items, a peripheral that
        // keeps requesting) is bounded per round.
        for _ in 0..200_000 {
            let mut moved = false;
            for d in 0..2 {
                for i in 0..8 {
                    if !self.dma[d].streams[i].enabled() {
                        continue;
                    }
                    let reqs = self.dma[d].requests(i);
                    let m2m = self.dma[d].streams[i].dir() == 2;
                    if !m2m && !reqs.iter().any(|&r| self.dma_request_active(r)) {
                        continue;
                    }
                    let t = self.dma[d].next_transfer(i);
                    let size = match t.bytes {
                        1 => AccessSize::Byte,
                        2 => AccessSize::Half,
                        _ => AccessSize::Word,
                    };
                    let ok = match self.read_inner(t.src, size) {
                        Ok(v) => self.write_inner(t.dst, size, v).is_ok(),
                        Err(_) => false,
                    };
                    // Timer requests are events: one transfer serves one.
                    for r in reqs {
                        match r {
                            Request::TimUp(tm) => self.timers[tm as usize].dma_req &= !1,
                            Request::TimCh(tm, c) => self.timers[tm as usize].dma_req &= !(2 << c),
                            _ => {}
                        }
                    }
                    self.dma[d].advance(i, ok);
                    moved = true;
                }
            }
            if !moved {
                break;
            }
        }
        self.dma_busy = false;
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
            } else if let Some(i) = I2CS.iter().position(|c| c.name == name) {
                self.i2c[i].reset();
            } else if let Some(i) = SPIS.iter().position(|c| c.name == name) {
                self.spi[i].reset();
            } else if name == "DMA1" || name == "DMA2" {
                self.dma[(name == "DMA2") as usize].reset();
            } else if name == "ADC1" {
                self.adc.reset();
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
                DMA1_BASE | DMA2_BASE => {
                    let d = (a & !0x3FF == DMA2_BASE) as usize;
                    if enabled(0x30, 21 + d as u32) {
                        self.dma[d].read(off)
                    } else {
                        0
                    }
                }
                map::ADC1_BASE => {
                    if enabled(0x44, 8) {
                        self.adc.peek(off)
                    } else {
                        0
                    }
                }
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
                base if I2CS.iter().any(|c| c.base == base) => {
                    let i = I2CS.iter().position(|c| c.base == base).unwrap();
                    if enabled(0x40, I2CS[i].enable_bit) {
                        self.i2c[i].peek(off)
                    } else {
                        0
                    }
                }
                base if SPIS.iter().any(|c| c.base == base) => {
                    let i = SPIS.iter().position(|c| c.base == base).unwrap();
                    if enabled(Self::spi_enr(i), SPIS[i].enable_bit) {
                        self.spi[i].peek(off)
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
            DMA1_BASE | DMA2_BASE => {
                let d = (a & !0x3FF == DMA2_BASE) as usize;
                if self.gated(
                    0x30,
                    21 + d as u32,
                    ["DMA1", "DMA2"][d],
                    ["RCC.AHB1ENR.DMA1EN", "RCC.AHB1ENR.DMA2EN"][d],
                ) {
                    return 0;
                }
                return self.dma[d].read(off);
            }
            map::ADC1_BASE => {
                if self.gated(0x44, 8, "ADC1", "RCC.APB2ENR.ADC1EN") {
                    return 0;
                }
                return self.adc.read(off);
            }
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
        if let Some(i) = I2CS.iter().position(|c| c.base == a & !0x3FF) {
            let c = &I2CS[i];
            if self.gated(0x40, c.enable_bit, c.name, c.enable_name) {
                return 0;
            }
            let v = self.i2c[i].read(off);
            let (now, clocks, pins) = (self.now, self.clocks, self.i2c_pins(i));
            let period = self.i2c_log_period(i, pins);
            let mut bus = CircuitI2c {
                circuit: self.circuit.as_mut(),
                pins,
                time: now,
                log: period.map(|p| (&mut self.wire_events, p, &mut self.i2c_wire_end[i])),
            };
            self.i2c[i].after_read(off, now, &clocks, &mut self.sched, i as u8, &mut bus);
            return v;
        }
        if let Some(i) = SPIS.iter().position(|c| c.base == a & !0x3FF) {
            let c = &SPIS[i];
            if self.gated(Self::spi_enr(i), c.enable_bit, c.name, c.enable_name) {
                return 0;
            }
            return self.spi[i].read(off);
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
            let v = t.read(off);
            t.after_read(off);
            return v;
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
        if a & !0x3FF == DMA1_BASE || a & !0x3FF == DMA2_BASE {
            let d = (a & !0x3FF == DMA2_BASE) as usize;
            if !self.gated(
                0x30,
                21 + d as u32,
                ["DMA1", "DMA2"][d],
                ["RCC.AHB1ENR.DMA1EN", "RCC.AHB1ENR.DMA2EN"][d],
            ) {
                self.dma[d].write(off, value, lanes);
            }
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
                    self.update_adc_gate();
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
            map::ADC1_BASE => {
                if !self.gated(0x44, 8, "ADC1", "RCC.APB2ENR.ADC1EN")
                    && self.adc.write(off, value, lanes) == AdcAction::Start
                {
                    let (now, clocks) = (self.now, self.clocks);
                    self.adc.begin(now, &clocks, &mut self.sched);
                }
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
        if let Some(i) = I2CS.iter().position(|c| c.base == a & !0x3FF) {
            let c = &I2CS[i];
            if !self.gated(0x40, c.enable_bit, c.name, c.enable_name) {
                let (now, clocks, pins) = (self.now, self.clocks, self.i2c_pins(i));
                let period = self.i2c_log_period(i, pins);
                let mut bus = CircuitI2c {
                    circuit: self.circuit.as_mut(),
                    pins,
                    time: now,
                    log: period.map(|p| (&mut self.wire_events, p, &mut self.i2c_wire_end[i])),
                };
                self.i2c[i].write(
                    off,
                    value,
                    lanes,
                    now,
                    &clocks,
                    &mut self.sched,
                    i as u8,
                    &mut bus,
                );
            }
            return;
        }
        if let Some(i) = SPIS.iter().position(|c| c.base == a & !0x3FF) {
            let c = &SPIS[i];
            if !self.gated(Self::spi_enr(i), c.enable_bit, c.name, c.enable_name) {
                let (now, cycles) = (self.now, self.spi_frame_cycles(i));
                self.spi[i].write(off, value, lanes, now, cycles, &mut self.sched, i as u8);
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

const DMA1_BASE: u32 = 0x4002_6000;
const DMA2_BASE: u32 = 0x4002_6400;

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
            let v = (self.read_inner(word, AccessSize::Word)? >> bit) & 1;
            self.service_dma();
            return Ok(v);
        }
        let v = self.read_inner(addr, size);
        if map::is_peripheral_space(addr) {
            self.service_dma();
        }
        v
    }

    fn write(&mut self, addr: u32, size: AccessSize, value: u32) -> Result<(), BusError> {
        if let Some((word, bit)) = bit_band(addr) {
            let old = self.read_inner(word, AccessSize::Word)?;
            let new = if value & 1 != 0 {
                old | (1 << bit)
            } else {
                old & !(1 << bit)
            };
            let r = self.write_inner(word, AccessSize::Word, new);
            self.service_dma();
            return r;
        }
        let r = self.write_inner(addr, size, value);
        if map::is_peripheral_space(addr) {
            self.service_dma();
        }
        r
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
        if self.adc.irq_line() {
            sys.set_irq_pending(18);
        }
        for s in &self.spi {
            if s.irq_line() {
                sys.set_irq_pending(s.irq);
            }
        }
        for i in &self.i2c {
            let (ev, er) = i.irq_lines();
            if ev {
                sys.set_irq_pending(i.irq_ev);
            }
            if er {
                sys.set_irq_pending(i.irq_er);
            }
        }
        for d in &self.dma {
            for (irq, on) in d.irqs().into_iter().zip(d.irq_lines()) {
                if on {
                    sys.set_irq_pending(irq);
                }
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
                // TIM1_BRK_TIM9 and TIM1_TRG_COM_TIM11.
                if t.irq_break() {
                    sys.set_irq_pending(24);
                }
                if t.irq_trg_com() {
                    sys.set_irq_pending(26);
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
        let wwdg_cfr = 0x4000_2C04;
        let reset = regmap::register_at(wwdg_cfr).unwrap().1.reset;
        assert_eq!(bus.read_u32(wwdg_cfr).unwrap(), reset, "SVD reset value");
        bus.write(wwdg_cfr, AccessSize::Word, 0x1C0).unwrap();
        assert_eq!(bus.read_u32(wwdg_cfr).unwrap(), 0x1C0);
        assert_eq!(bus.regs.accesses.len(), 2);
        assert_eq!(regmap::describe(wwdg_cfr), "WWDG.CFR");
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
    fn tim1_complementary_pair_on_pa8_pa7_with_dead_time_and_bkin_on_pa6() {
        let mut bus = Stm32f401Bus::new();
        let mut sys = CortexM::new();
        let w = |bus: &mut Stm32f401Bus, a: u32, v: u32| {
            bus.write(a, AccessSize::Word, v).unwrap();
        };
        w(&mut bus, map::RCC_BASE + 0x30, 1); // GPIOAEN
        w(&mut bus, map::RCC_BASE + 0x44, 1); // TIM1EN
                                              // PA6 (BKIN), PA7 (CH1N), PA8 (CH1): AF1.
        w(
            &mut bus,
            map::GPIOA_BASE,
            0xA800_0000 | 2 << 12 | 2 << 14 | 2 << 16,
        );
        w(&mut bus, map::GPIOA_BASE + 0x20, 1 << 24 | 1 << 28);
        w(&mut bus, map::GPIOA_BASE + 0x24, 1);
        let tim1 = map::TIM1_BASE;
        w(&mut bus, tim1 + 0x2C, 99); // 100-cycle period at 16 MHz
        w(&mut bus, tim1 + 0x34, 40);
        w(&mut bus, tim1 + 0x18, 6 << 4); // PWM1
        w(&mut bus, tim1 + 0x20, 1 | 1 << 2); // CC1E | CC1NE
        w(&mut bus, tim1 + 0x0C, 1 << 7); // BIE
                                          // MOE | OSSI | BKE | BKP (active high), dead time 8 cycles.
        w(
            &mut bus,
            tim1 + 0x44,
            1 << 15 | 1 << 10 | 1 << 12 | 1 << 13 | 8,
        );
        bus.set_external(0, 6, Some(false));
        bus.pin_events.clear();
        w(&mut bus, tim1, 1); // CEN
        for t in 0..=220u64 {
            bus.set_time(t);
            bus.run_events(t);
        }
        let edges = |bus: &Stm32f401Bus, pin: u8| -> Vec<_> {
            bus.pin_events
                .iter()
                .filter(|e| e.port == 0 && e.pin == pin)
                .map(|e| (e.time, e.level))
                .collect()
        };
        assert_eq!(
            edges(&bus, 8),
            vec![
                (8, Some(true)),
                (40, Some(false)),
                (108, Some(true)),
                (140, Some(false)),
                (208, Some(true)),
            ]
        );
        assert_eq!(
            edges(&bus, 7),
            vec![
                (48, Some(true)),
                (100, Some(false)),
                (148, Some(true)),
                (200, Some(false))
            ]
        );
        // BKIN high: the break. Both pins go to their idle level (OIS1 =
        // OIS1N = 0) at once and the break interrupt is pending.
        bus.pin_events.clear();
        bus.set_external(0, 6, Some(true));
        assert_eq!(edges(&bus, 8), vec![(220, Some(false))]);
        assert!(!bus.gpio[0].level(7));
        assert_eq!(bus.read_u32(tim1 + 0x44).unwrap() & 1 << 15, 0, "MOE off");
        assert_ne!(bus.read_u32(tim1 + 0x10).unwrap() & 1 << 7, 0, "BIF");
        bus.poll(&mut sys);
        assert_ne!(
            sys.peek(0xE000_E200, AccessSize::Word) & (1 << 24),
            0,
            "TIM1_BRK_TIM9 interrupt pending"
        );
        for t in 220..=500u64 {
            bus.set_time(t);
            bus.run_events(t);
        }
        assert_eq!(edges(&bus, 8).len(), 1, "no PWM while broken");
    }

    #[test]
    fn dma_feeds_pwm_duty_cycles_from_memory() {
        // TIM3 CH1 PWM on PA6; DMA1 stream 4 channel 5 (TIM3_CH1) writes
        // CCR1 from a table at every compare event: the classic NeoPixel
        // set-up.
        let mut bus = Stm32f401Bus::new();
        let w = |bus: &mut Stm32f401Bus, a: u32, v: u32| {
            bus.write(a, AccessSize::Word, v).unwrap();
        };
        let duties = [30u16, 60, 30, 60, 0];
        for (i, d) in duties.iter().enumerate() {
            bus.write(0x2000_0100 + 2 * i as u32, AccessSize::Half, *d as u32)
                .unwrap();
        }
        w(&mut bus, map::RCC_BASE + 0x30, 1 | 1 << 21); // GPIOAEN, DMA1EN
        w(&mut bus, map::RCC_BASE + 0x40, 1 << 1); // TIM3EN
        w(&mut bus, map::GPIOA_BASE, 0xA800_0000 | 2 << 12); // PA6 AF
        w(&mut bus, map::GPIOA_BASE + 0x20, 2 << 24); // AF2 = TIM3_CH1
        let s4 = DMA1_BASE + 0x10 + 0x18 * 4;
        w(&mut bus, s4 + 0x04, duties.len() as u32);
        w(&mut bus, s4 + 0x08, map::TIM3_BASE + 0x34);
        w(&mut bus, s4 + 0x0C, 0x2000_0100);
        // Channel 5, memory → peripheral, MINC, 16-bit both sides, TCIE.
        w(
            &mut bus,
            s4,
            5 << 25 | 1 << 13 | 1 << 11 | 1 << 10 | 1 << 6 | 1 << 4 | 1,
        );
        let tim3 = map::TIM3_BASE;
        w(&mut bus, tim3 + 0x2C, 99); // 100-cycle period at 16 MHz
        w(&mut bus, tim3 + 0x18, 6 << 4 | 1 << 3); // PWM1, preload
        w(&mut bus, tim3 + 0x20, 1); // CC1E
        w(&mut bus, tim3 + 0x0C, 1 << 9); // CC1DE
        w(&mut bus, tim3, 1 << 7 | 1); // ARPE | CEN
        bus.pin_events.clear();
        for t in 0..=800u64 {
            bus.set_time(t);
            bus.run_events(t);
        }
        // High time of each period follows the table, one period late
        // (CCR is preloaded): 0, 30, 60, 30, 60, then 0.
        let highs: Vec<u64> = bus
            .pin_events
            .windows(2)
            .filter(|p| p[0].level == Some(true))
            .map(|p| p[1].time - p[0].time)
            .collect();
        assert_eq!(highs, [30, 60, 30, 60], "{:?}", bus.pin_events);
        assert!(!bus.dma[0].streams[4].enabled(), "transfer complete");
        assert_ne!(bus.dma[0].flags(4) & dma::TCIF, 0);
        assert!(bus.dma[0].irq_lines()[4]);
    }

    #[test]
    fn input_capture_sees_external_edges_on_its_pin() {
        // TIM2 CH1 on PA0 (AF1), rising-edge capture; the pin is driven
        // from outside, not by the timer.
        let mut bus = Stm32f401Bus::new();
        let w = |bus: &mut Stm32f401Bus, a: u32, v: u32| {
            bus.write(a, AccessSize::Word, v).unwrap();
        };
        w(&mut bus, map::RCC_BASE + 0x30, 1); // GPIOAEN
        w(&mut bus, map::RCC_BASE + 0x40, 1); // TIM2EN
        w(&mut bus, map::GPIOA_BASE, 0xA800_0000 | 2); // PA0 AF
        w(&mut bus, map::GPIOA_BASE + 0x20, 1); // AF1 = TIM2_CH1
        let tim2 = map::TIM2_BASE;
        w(&mut bus, tim2 + 0x18, 1); // CC1S = TI1
        w(&mut bus, tim2 + 0x20, 1); // CC1E, rising
        w(&mut bus, tim2, 1); // CEN
        assert_eq!(
            bus.gpio[0].driven(0),
            None,
            "an input channel drives nothing"
        );
        bus.set_time(500);
        bus.set_external(0, 0, Some(true));
        assert!(bus.gpio[0].level(0));
        bus.set_time(600);
        assert_eq!(
            bus.read_u32(tim2 + 0x34).unwrap(),
            500,
            "captured at the edge"
        );
        assert_eq!(
            bus.read_u32(tim2 + 0x10).unwrap() & 2,
            0,
            "reading CCR1 cleared CC1IF"
        );
    }

    #[test]
    fn dma_sends_a_string_through_usart2() {
        let mut bus = Stm32f401Bus::new();
        let w = |bus: &mut Stm32f401Bus, a: u32, v: u32| {
            bus.write(a, AccessSize::Word, v).unwrap();
        };
        for (i, b) in b"DMA!".iter().enumerate() {
            bus.write(0x2000_0200 + i as u32, AccessSize::Byte, *b as u32)
                .unwrap();
        }
        w(&mut bus, map::RCC_BASE + 0x30, 1 << 21); // DMA1EN
        w(&mut bus, map::RCC_BASE + 0x40, 1 << 17); // USART2EN
        let u2 = map::USART2_BASE;
        w(&mut bus, u2 + 0x08, 139); // 115200 Bd at 16 MHz
        w(&mut bus, u2 + 0x14, 1 << 7); // DMAT
        w(&mut bus, u2 + 0x0C, 1 << 13 | 1 << 3); // UE | TE
        let s6 = DMA1_BASE + 0x10 + 0x18 * 6;
        w(&mut bus, s6 + 0x04, 4);
        w(&mut bus, s6 + 0x08, u2 + 0x04);
        w(&mut bus, s6 + 0x0C, 0x2000_0200);
        w(&mut bus, s6, 4 << 25 | 1 << 10 | 1 << 6 | 1);
        for t in (0..=10_000u64).step_by(50) {
            bus.set_time(t);
            bus.run_events(t);
        }
        let text: Vec<u8> = bus.terminal_take(1).iter().map(|b| b.byte).collect();
        assert_eq!(text, b"DMA!");
        assert_eq!(bus.read_u32(s6 + 0x04).unwrap(), 0);
    }

    #[test]
    fn usart1_and_usart6_run_from_pclk2_and_are_routed_by_af() {
        let mut bus = Stm32f401Bus::new();
        let mut sys = CortexM::new();
        let w = |bus: &mut Stm32f401Bus, a: u32, v: u32| bus.write(a, AccessSize::Word, v).unwrap();
        // GPIOA and GPIOC clocks; USART1EN, USART6EN; APB2 at 16 MHz.
        w(&mut bus, map::RCC_BASE + 0x30, 0b101);
        w(&mut bus, map::RCC_BASE + 0x44, 1 << 4 | 1 << 5);
        assert_eq!(bus.usart_pins(0), (None, None));
        // PA9/PA10 AF7 (USART1), PC6/PC7 AF8 (USART6).
        w(&mut bus, 0x4002_0000, 0xA800_0000 | 0b1010 << 18);
        w(&mut bus, 0x4002_0024, 7 << 4 | 7 << 8);
        w(&mut bus, 0x4002_0800, 0b1010 << 12);
        w(&mut bus, 0x4002_0820, 8 << 24 | 8 << 28);
        assert_eq!(bus.usart_pins(0), (Some((0, 9)), Some((0, 10))));
        assert_eq!(bus.usart_pins(2), (Some((2, 6)), Some((2, 7))));
        assert_eq!(bus.usart_pins(1), (None, None), "PA2/PA3 not in AF mode");
        // The wrong AF number routes nothing.
        w(&mut bus, 0x4002_0024, 8 << 4 | 7 << 8);
        assert_eq!(bus.usart_pins(0), (None, Some((0, 10))));
        w(&mut bus, 0x4002_0024, 7 << 4 | 7 << 8);
        let (u1, u6) = (map::USART1_BASE, 0x4001_1400);
        for (u, brr) in [(u1, 1667), (u6, 139)] {
            w(&mut bus, u + 0x08, brr); // 9600 / 115200 Bd at 16 MHz
            w(&mut bus, u + 0x0C, 1 << 13 | 1 << 3 | 1 << 2 | 1 << 5); // UE TE RE RXNEIE
        }
        assert!((bus.usart_baud(0).unwrap() - 9598.1).abs() < 1.0);
        assert!((bus.usart_baud(2).unwrap() - 115_107.9).abs() < 1.0);
        bus.usart[0].host_baud = 9600;
        w(&mut bus, u1 + 0x04, b'1' as u32);
        w(&mut bus, u6 + 0x04, b'6' as u32);
        bus.terminal_send(0, b"a");
        for t in (0..=40_000u64).step_by(100) {
            bus.set_time(t);
            bus.run_events(t);
        }
        let got = |bus: &mut Stm32f401Bus, i| -> Vec<(u8, bool)> {
            bus.terminal_take(i)
                .iter()
                .map(|b| (b.byte, b.garbled))
                .collect()
        };
        assert_eq!(got(&mut bus, 0), [(b'1', false)]);
        assert_eq!(got(&mut bus, 2), [(b'6', false)]);
        assert_eq!(got(&mut bus, 1), []);
        // The byte typed at 9600 arrived on USART1, whose IRQ is 37.
        assert_eq!(bus.usart[0].sr & usart::RXNE, usart::RXNE);
        assert_eq!(bus.read_u32(u1 + 0x04).unwrap(), b'a' as u32);
        bus.terminal_send(2, b"z");
        for t in (40_000..=60_000u64).step_by(100) {
            bus.set_time(t);
            bus.run_events(t);
        }
        bus.poll(&mut sys);
        assert_ne!(
            sys.peek(0xE000_E200 + 8, AccessSize::Word) & (1 << (71 - 64)),
            0,
            "USART6 IRQ 71 pending"
        );
    }

    #[test]
    fn adc_conversion_waits_while_its_clock_is_off() {
        let mut bus = Stm32f401Bus::new();
        let mut sys = CortexM::new();
        let w = |bus: &mut Stm32f401Bus, a: u32, v: u32| bus.write(a, AccessSize::Word, v).unwrap();
        w(&mut bus, map::RCC_BASE + 0x44, 1 << 8); // ADC1EN
        let adc = map::ADC1_BASE;
        w(&mut bus, adc + 0x304, 1 << 23); // TSVREFE
        w(&mut bus, adc + 0x34, 17); // SQ1 = VREFINT
        w(&mut bus, adc + 0x04, 1 << 5); // EOCIE
        w(&mut bus, adc + 0x08, 1); // ADON
        w(&mut bus, adc + 0x08, 1 | 1 << 30); // SWSTART
                                              // Clock off before the conversion ends: nothing completes.
        w(&mut bus, map::RCC_BASE + 0x44, 0);
        for t in (0..10_000u64).step_by(100) {
            bus.set_time(t);
            bus.run_events(t);
        }
        assert_eq!(bus.adc.sr & adc::EOC, 0);
        bus.poll(&mut sys);
        assert_eq!(
            sys.peek(0xE000_E200, AccessSize::Word) & (1 << 18),
            0,
            "no ADC IRQ"
        );
        // Clock back on: the conversion starts over and completes.
        bus.set_time(10_000);
        w(&mut bus, map::RCC_BASE + 0x44, 1 << 8);
        for t in (10_000..20_000u64).step_by(100) {
            bus.set_time(t);
            bus.run_events(t);
        }
        assert_eq!(bus.adc.sr & adc::EOC, adc::EOC);
        assert_eq!(bus.adc.dr, bus.adc.code(adc::VREFINT));
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
        bus.peek(0x4000_2C04, AccessSize::Word);
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
