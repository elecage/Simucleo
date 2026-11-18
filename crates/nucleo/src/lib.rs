//! The Nucleo-F401RE as a whole machine.
//!
//! [`Nucleo`] owns the CPU backend, the STM32F401 bus and the Cortex-M system
//! block, loads firmware and advances simulated time.

use simucleo_core::cortexm::CortexM;
use simucleo_core::cpu::{CpuBackend, RunResult, StopReason};
use simucleo_core::Cycles;
use simucleo_cpu_armv7m::ArmV7M;
use simucleo_elf::{ElfError, FirmwareImage};
use simucleo_periph_stm32f4::Stm32f401Bus;
use thiserror::Error;

pub use simucleo_periph_stm32f4::gpio::PinEvent;

/// Core clock after reset: the 16 MHz HSI oscillator.
pub const RESET_CLOCK_HZ: u32 = 16_000_000;

#[derive(Debug, Error)]
pub enum LoadError {
    #[error(transparent)]
    Elf(#[from] ElfError),
    #[error("segment at {addr:#010x} ({len} bytes) does not fit in flash or SRAM")]
    Placement { addr: u32, len: usize },
    #[error("cannot read the vector table: {0}")]
    VectorTable(simucleo_core::bus::BusError),
}

pub struct Nucleo {
    pub cpu: Box<dyn CpuBackend>,
    pub bus: Stm32f401Bus,
    pub sys: CortexM,
    pub firmware: Option<FirmwareImage>,
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
        Self {
            cpu,
            bus: Stm32f401Bus::new(),
            sys: CortexM::new(),
            firmware: None,
        }
    }

    /// Program an ELF image into flash and reset.
    pub fn load_elf(&mut self, bytes: &[u8]) -> Result<(), LoadError> {
        let fw = FirmwareImage::parse(bytes)?;
        self.bus = Stm32f401Bus::new();
        for seg in &fw.segments {
            self.bus
                .load(seg.addr, &seg.data)
                .map_err(|_| LoadError::Placement {
                    addr: seg.addr,
                    len: seg.data.len(),
                })?;
        }
        self.firmware = Some(fw);
        self.reset().map_err(LoadError::VectorTable)
    }

    /// Press the reset button: CPU and system reset; SRAM and flash keep
    /// their contents (like a real reset, unlike power-on).
    pub fn reset(&mut self) -> Result<(), simucleo_core::bus::BusError> {
        let flash = self.bus.flash.clone();
        let sram = self.bus.sram.clone();
        self.bus = Stm32f401Bus::new();
        self.bus.flash = flash;
        self.bus.sram = sram;
        self.cpu.reset(&mut self.bus, &mut self.sys)
    }

    /// Current simulated time in core clock cycles.
    pub fn now(&self) -> Cycles {
        self.sys.cycles
    }

    /// Core clock frequency (fixed at the reset value until RCC is modelled).
    pub fn clock_hz(&self) -> u32 {
        RESET_CLOCK_HZ
    }

    /// Run for up to `cycles`. Sleeping time is fast-forwarded.
    pub fn run(&mut self, cycles: Cycles) -> RunResult {
        let start = self.sys.cycles;
        let end = start + cycles;
        loop {
            let budget = end.saturating_sub(self.sys.cycles);
            let r = self.cpu.run(&mut self.bus, &mut self.sys, budget);
            if self.sys.reset_requested {
                self.sys.reset_requested = false;
                if self.reset().is_err() {
                    return RunResult {
                        cycles: self.sys.cycles - start,
                        stop: StopReason::Lockup { pc: 0 },
                    };
                }
                continue;
            }
            match r.stop {
                StopReason::Sleeping => {
                    // Nothing on the board can wake the core yet (peripheral
                    // interrupts arrive in M1): sleep until the budget ends.
                    self.sys.advance(end.saturating_sub(self.sys.cycles));
                    return RunResult {
                        cycles: self.sys.cycles - start,
                        stop: StopReason::Sleeping,
                    };
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

    /// Level of a GPIO pin, e.g. `pin('A', 5)` for LD2.
    pub fn pin(&self, port: char, pin: u8) -> bool {
        let idx = (port.to_ascii_uppercase() as u8 - b'A') as usize;
        self.bus.gpio[idx].level(pin)
    }

    /// Take the pin level changes recorded since the last call.
    pub fn take_pin_events(&mut self) -> Vec<PinEvent> {
        std::mem::take(&mut self.bus.pin_events)
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
