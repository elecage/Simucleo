//! STM32F401RE memory map and peripherals.
//!
//! Modelled: flash, SRAM, boot alias, bit-banding, GPIO, RCC (clock tree),
//! PWR, FLASH interface, USART1/2/6. Every other peripheral is backed by a
//! register file initialised from ST's SVD, so firmware reads back what it
//! wrote and sees correct reset values; those accesses are counted so the
//! GUI can show which peripheral the firmware relies on that is not
//! simulated yet.

pub mod gpio;
pub mod map;
pub mod rcc;
pub mod regmap;
#[rustfmt::skip]
pub mod svd;
pub mod svd_types;
pub mod sysctl;
pub mod usart;

use std::collections::BTreeSet;

use gpio::{Gpio, PinEvent};
use rcc::{Clocks, Rcc, ResetCause};
use regmap::RegisterFile;
use simucleo_core::bus::{AccessSize, Bus, BusError, Memory};
use simucleo_core::cortexm::CortexM;
use simucleo_core::sched::Scheduler;
use simucleo_core::Cycles;
use sysctl::{FlashIf, Pwr};
use usart::{TerminalByte, Usart, UsartEventKind};

/// Peripheral events on the virtual clock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Event {
    Usart {
        idx: u8,
        kind: UsartEventKind,
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
    pub rcc: Rcc,
    pub pwr: Pwr,
    pub flash_if: FlashIf,
    /// USART1, USART2 (ST-LINK virtual COM port), USART6.
    pub usart: [Usart; 3],
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
        Self {
            flash: Memory::new(map::FLASH_BASE, map::FLASH_SIZE, false),
            sram: Memory::new(map::SRAM_BASE, map::SRAM_SIZE, true),
            gpio: std::array::from_fn(|i| Gpio::new(i as u8)),
            pin_events: Vec::new(),
            rcc,
            pwr: Pwr::default(),
            flash_if: FlashIf::default(),
            usart: USARTS.map(|(name, _, irq, apb2, ..)| Usart::new(name, irq, apb2)),
            regs: RegisterFile::default(),
            warnings: BTreeSet::new(),
            sched: Scheduler::new(),
            now: 0,
            clocks,
            clock_changed: false,
            known_deadline: None,
        }
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
        self.regs.clear();
        let now = self.sched.now();
        self.sched = Scheduler::new();
        self.sched.advance_to(now);
        self.clocks = self.rcc.clocks();
        self.clock_changed = true;
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
        self.regs.read(a)
    }

    fn periph_write(&mut self, a: u32, value: u32, lanes: u32) {
        let off = a & 0x3FC;
        if let Some(port) = gpio_port(a) {
            if self.gated(0x30, port as u32, GPIO_NAMES[port], GPIO_ENABLE_BITS[port]) {
                return;
            }
            self.gpio[port].write(off, value, lanes, self.now, &mut self.pin_events);
            return;
        }
        match a & !0x3FF {
            map::RCC_BASE => {
                if self.rcc.write(off, value, lanes) {
                    self.after_clock_write();
                }
                return;
            }
            map::FLASH_IF_BASE => {
                self.flash_if.write(off, value, lanes);
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
            return self.sram.write(a, size, value);
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
        let tim3_arr = 0x4000_042C;
        let reset = regmap::register_at(tim3_arr).unwrap().1.reset;
        assert_eq!(bus.read_u32(tim3_arr).unwrap(), reset, "SVD reset value");
        bus.write(tim3_arr, AccessSize::Word, 999).unwrap();
        assert_eq!(bus.read_u32(tim3_arr).unwrap(), 999);
        assert_eq!(bus.regs.accesses.len(), 2);
        assert_eq!(regmap::describe(tim3_arr), "TIM3.ARR");
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
