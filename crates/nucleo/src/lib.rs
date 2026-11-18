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
    resets: u32,
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
            resets: 0,
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
            if self.sys.reset_requested || r.stop == StopReason::ResetRequested {
                self.sys.reset_requested = false;
                self.resets += 1;
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

    /// Number of software resets (SYSRESETREQ) performed so far.
    pub fn software_resets(&self) -> u32 {
        self.resets
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

    #[test]
    fn sysresetreq_resets_at_the_next_instruction_boundary() {
        // https://github.com/elecage/Simucleo/issues/5
        for budget in [20, 100, 10_000] {
            let mut board = Nucleo::new();
            board.bus.load(0x0800_0000, &RESET_PROGRAM).unwrap();
            board.reset().unwrap();
            let r = board.run(budget);
            assert_eq!(r.stop, StopReason::BudgetExhausted, "budget {budget}");
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
