//! Flash interface (FLASH, RM0368 §3): wait states and caches, and the
//! programming controller — unlocking with the key sequence, sector and
//! mass erase, byte/half-word/word programming with the PSIZE parallelism,
//! the error flags (WRPERR, PGAERR, PGPERR, PGSERR), the end-of-operation
//! and error interrupts, and the option bytes (write protection nWRP,
//! hardware watchdog WDG_SW, read protection level kept as a value).
//!
//! Erase and programming take their typical time (STM32F401 datasheet,
//! 2.7–3.6 V): BSY is set meanwhile. Programming only clears bits (it ANDs
//! the new value into the cells), as on the chip; the erase sets them back
//! to 1. Not modelled: read stalls while BSY, the x64 parallelism (needs
//! Vpp), OTP area, read protection effects, PCROP.

use simucleo_core::bus::{AccessSize, Memory};
use simucleo_core::Cycles;

/// Sectors of the 512 KB STM32F401RE: (start, size).
pub const SECTORS: [(u32, u32); 8] = [
    (0x0800_0000, 16 << 10),
    (0x0800_4000, 16 << 10),
    (0x0800_8000, 16 << 10),
    (0x0800_C000, 16 << 10),
    (0x0801_0000, 64 << 10),
    (0x0802_0000, 128 << 10),
    (0x0804_0000, 128 << 10),
    (0x0806_0000, 128 << 10),
];

/// The sector holding `addr`.
pub fn sector_of(addr: u32) -> Option<usize> {
    SECTORS.iter().position(|&(a, n)| addr >= a && addr - a < n)
}

// SR
pub const EOP: u32 = 1 << 0;
pub const OPERR: u32 = 1 << 1;
pub const WRPERR: u32 = 1 << 4;
pub const PGAERR: u32 = 1 << 5;
pub const PGPERR: u32 = 1 << 6;
pub const PGSERR: u32 = 1 << 7;
pub const RDERR: u32 = 1 << 8;
pub const BSY: u32 = 1 << 16;
const SR_ERRORS: u32 = OPERR | WRPERR | PGAERR | PGPERR | PGSERR | RDERR;
// CR
pub const PG: u32 = 1 << 0;
pub const SER: u32 = 1 << 1;
pub const MER: u32 = 1 << 2;
pub const STRT: u32 = 1 << 16;
pub const EOPIE: u32 = 1 << 24;
pub const ERRIE: u32 = 1 << 25;
pub const LOCK: u32 = 1 << 31;
// OPTCR
pub const OPTLOCK: u32 = 1 << 0;
pub const OPTSTRT: u32 = 1 << 1;
pub const WDG_SW: u32 = 1 << 5;

const KEY1: u32 = 0x4567_0123;
const KEY2: u32 = 0xCDEF_89AB;
const OPTKEY1: u32 = 0x0819_2A3B;
const OPTKEY2: u32 = 0x4C5D_6E7F;

/// Option bytes as shipped: no protection, software watchdog, RDP level 0.
pub const OPTION_BYTES_DEFAULT: u32 = 0x0FFF_AAEC;

/// Why a write to the flash array did nothing (a flag in SR says the same).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum FlashFault {
    /// Not unlocked (FLASH_CR.LOCK).
    Locked,
    /// PG not set, or an erase is selected too (PGSERR).
    Sequence,
    /// Access size other than FLASH_CR.PSIZE (PGPERR).
    Parallelism,
    /// The data crosses a 128-bit row (PGAERR).
    Alignment,
    /// The sector is write-protected by nWRP (WRPERR).
    Protected,
}

/// What the controller is doing, for a status view.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlashActivity {
    Idle,
    /// Erasing these sectors (bit n = sector n; 0xFF for a mass erase).
    Erasing(u8),
    Programming,
    /// Writing the option bytes.
    Options,
}

/// An operation in progress.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Op {
    /// Sectors to erase (bit n = sector n).
    Erase(u8),
    Program,
    /// Option bytes being written: their new value.
    Options(u32),
}

#[derive(Debug, Clone)]
pub struct FlashIf {
    pub acr: u32,
    pub cr: u32,
    pub sr: u32,
    /// The OPTCR register as the firmware sees it.
    pub optcr: u32,
    /// The programmed option bytes (kept over resets).
    pub option_bytes: u32,
    key_step: u8,
    /// A wrong key: FLASH_CR stays locked until the next reset.
    key_poisoned: bool,
    opt_key_step: u8,
    op: Option<(Op, Cycles)>,
    pub gen: u32,
    /// Erases per sector (wear), kept over resets.
    pub erase_counts: [u32; 8],
    /// Bytes programmed per sector since its last erase, kept over resets.
    pub programmed: [u32; 8],
    hclk: u32,
}

impl Default for FlashIf {
    fn default() -> Self {
        Self::with_option_bytes(OPTION_BYTES_DEFAULT)
    }
}

impl FlashIf {
    fn with_option_bytes(option_bytes: u32) -> Self {
        Self {
            acr: 0,
            cr: LOCK,
            sr: 0,
            optcr: option_bytes | OPTLOCK,
            option_bytes,
            key_step: 0,
            key_poisoned: false,
            opt_key_step: 0,
            op: None,
            gen: 0,
            erase_counts: [0; 8],
            programmed: [0; 8],
            hclk: 16_000_000,
        }
    }

    /// The state after a system reset: registers back to their reset
    /// values with the option bytes loaded; what the cells went through
    /// stays. An operation in progress is lost (the cells keep what it had
    /// done so far — here, nothing for an erase).
    pub fn system_reset(&mut self) {
        let (ob, counts, programmed) = (self.option_bytes, self.erase_counts, self.programmed);
        *self = Self::with_option_bytes(ob);
        self.erase_counts = counts;
        self.programmed = programmed;
    }

    pub fn read(&self, offset: u32) -> u32 {
        match offset {
            0x00 => self.acr,
            0x0C => self.sr | if self.op.is_some() { BSY } else { 0 },
            0x10 => self.cr,
            0x14 => self.optcr,
            _ => 0,
        }
    }

    pub fn busy(&self) -> bool {
        self.op.is_some()
    }

    /// The operation in progress, if any.
    pub fn activity(&self) -> FlashActivity {
        match self.op {
            None => FlashActivity::Idle,
            Some((Op::Erase(s), _)) => FlashActivity::Erasing(s),
            Some((Op::Program, _)) => FlashActivity::Programming,
            Some((Op::Options(_), _)) => FlashActivity::Options,
        }
    }

    /// Sectors write-protected by the option bytes (bit n = sector n).
    pub fn write_protected(&self) -> u8 {
        (0..SECTORS.len())
            .filter(|&s| self.protected(s))
            .fold(0, |m, s| m | 1 << s)
    }

    /// FLASH_CR.LOCK is set.
    pub fn locked(&self) -> bool {
        self.cr & LOCK != 0
    }

    /// When the operation in progress ends.
    pub fn deadline(&self) -> Option<Cycles> {
        self.op.map(|(_, t)| t)
    }

    /// A register write; returns when a started operation ends (schedule
    /// `Event::Flash` with the new `gen`).
    pub fn write(&mut self, offset: u32, value: u32, lanes: u32, now: Cycles) -> Option<Cycles> {
        let m = |old: u32| (old & !lanes) | (value & lanes);
        match offset {
            0x00 => self.acr = m(self.acr) & 0x1F0F,
            0x04 => {
                // KEYR: KEY1 then KEY2 unlocks; anything else locks until reset.
                if self.cr & LOCK == 0 || self.key_poisoned {
                    return None;
                }
                self.key_step = match (self.key_step, value) {
                    (0, KEY1) => 1,
                    (1, KEY2) => {
                        self.cr &= !LOCK;
                        0
                    }
                    _ => {
                        self.key_poisoned = true;
                        0
                    }
                };
            }
            0x08 => {
                // OPTKEYR
                if self.optcr & OPTLOCK == 0 {
                    return None;
                }
                self.opt_key_step = match (self.opt_key_step, value) {
                    (0, OPTKEY1) => 1,
                    (1, OPTKEY2) => {
                        self.optcr &= !OPTLOCK;
                        0
                    }
                    _ => 0,
                };
            }
            0x0C => {
                // SR: EOP and the error flags clear by writing 1.
                self.sr &= !(value & lanes & (EOP | SR_ERRORS));
            }
            0x10 => {
                // CR: writable only unlocked and not busy; LOCK sets.
                if self.cr & LOCK != 0 || self.op.is_some() {
                    return None;
                }
                let v = m(self.cr) & 0x8301_037F;
                self.cr = v & !STRT;
                if v & LOCK != 0 {
                    return None;
                }
                if v & STRT != 0 {
                    return self.start_erase(now);
                }
            }
            0x14 => {
                if self.optcr & OPTLOCK != 0 || self.op.is_some() {
                    return None;
                }
                let v = m(self.optcr) & 0x8FFF_FFEF;
                self.optcr = v & !OPTSTRT;
                if v & OPTLOCK != 0 {
                    return None;
                }
                if v & OPTSTRT != 0 {
                    // About 16 ms (byte programming of the option bytes).
                    let ob = v & !(OPTLOCK | OPTSTRT);
                    return Some(self.begin(Op::Options(ob), 16_000.0, now));
                }
            }
            _ => {}
        }
        None
    }

    fn protected(&self, sector: usize) -> bool {
        self.option_bytes & (1 << (16 + sector)) == 0
    }

    fn psize(&self) -> u32 {
        (self.cr >> 8) & 3
    }

    /// Erase time (µs) of one sector of `len` bytes at the PSIZE.
    fn erase_us(&self, len: u32) -> f64 {
        let x32 = match len >> 10 {
            16 => 250_000.0,
            64 => 550_000.0,
            _ => 1_100_000.0,
        };
        x32 * match self.psize() {
            0 => 1.6, // x8
            1 => 1.2, // x16
            _ => 1.0,
        }
    }

    fn begin(&mut self, op: Op, us: f64, now: Cycles) -> Cycles {
        let end = now + ((us * self.hclk as f64 / 1e6).ceil() as Cycles).max(1);
        self.op = Some((op, end));
        self.gen = self.gen.wrapping_add(1);
        end
    }

    fn start_erase(&mut self, now: Cycles) -> Option<Cycles> {
        let (ser, mer) = (self.cr & SER != 0, self.cr & MER != 0);
        if ser == mer || self.cr & PG != 0 {
            self.sr |= PGSERR;
            return None;
        }
        let sectors: u8 = if mer {
            0xFF
        } else {
            let snb = ((self.cr >> 3) & 0xF) as usize;
            if snb >= SECTORS.len() {
                self.sr |= PGSERR;
                return None;
            }
            1 << snb
        };
        if (0..8).any(|s| sectors & (1 << s) != 0 && self.protected(s)) {
            self.sr |= WRPERR;
            return None;
        }
        let us: f64 = (0..8)
            .filter(|s| sectors & (1 << s) != 0)
            .map(|s| self.erase_us(SECTORS[s].1))
            .sum();
        // A mass erase is quicker than the sectors one by one (8 s at x32
        // for 512 KB on the F401 versus 4.2 s summed — the datasheet's
        // typical is 8 s, sector sums are what HAL loops take).
        let us = if mer { 8_000_000.0 } else { us };
        Some(self.begin(Op::Erase(sectors), us, now))
    }

    /// A write to the flash array (an access of `size` at `addr`): program
    /// it, or say why not (the SR flag is set as well). Returns when the
    /// programming ends.
    pub fn program(
        &mut self,
        mem: &mut Memory,
        addr: u32,
        size: AccessSize,
        value: u32,
        now: Cycles,
    ) -> Result<Cycles, FlashFault> {
        let fault = |s: &mut Self, flag: u32, f: FlashFault| {
            s.sr |= flag;
            Err(f)
        };
        if self.cr & LOCK != 0 {
            return fault(self, PGSERR, FlashFault::Locked);
        }
        if self.cr & PG == 0 || self.cr & (SER | MER) != 0 {
            return fault(self, PGSERR, FlashFault::Sequence);
        }
        let want = match self.psize() {
            0 => AccessSize::Byte,
            1 => AccessSize::Half,
            _ => AccessSize::Word, // x64 is word pairs; a word is a parallelism error there too
        };
        if size != want || self.psize() == 3 {
            return fault(self, PGPERR, FlashFault::Parallelism);
        }
        let n = size.bytes();
        if addr % 16 + n > 16 {
            return fault(self, PGAERR, FlashFault::Alignment);
        }
        let Some(sector) = sector_of(addr) else {
            return fault(self, PGSERR, FlashFault::Sequence);
        };
        if self.protected(sector) {
            return fault(self, WRPERR, FlashFault::Protected);
        }
        // Programming can only take bits from 1 to 0.
        let old = mem.read(addr, size).unwrap_or(0);
        let mut bytes = [0u8; 4];
        let new = old & value;
        for (i, b) in bytes.iter_mut().enumerate().take(n as usize) {
            *b = (new >> (8 * i)) as u8;
        }
        mem.load(addr, &bytes[..n as usize]).ok();
        self.programmed[sector] += n;
        Ok(self.begin(Op::Program, 16.0, now))
    }

    /// The operation in progress ends (`Event::Flash` with the current gen).
    pub fn complete(&mut self, mem: &mut Memory) {
        let Some((op, _)) = self.op.take() else {
            return;
        };
        match op {
            Op::Erase(sectors) => {
                for (s, &(a, n)) in SECTORS.iter().enumerate() {
                    if sectors & (1 << s) != 0 {
                        mem.load(a, &vec![0xFF; n as usize]).ok();
                        self.erase_counts[s] += 1;
                        self.programmed[s] = 0;
                    }
                }
            }
            Op::Program => {}
            Op::Options(ob) => {
                self.option_bytes = ob;
                self.optcr = (self.optcr & OPTLOCK) | ob;
            }
        }
        if self.cr & EOPIE != 0 {
            self.sr |= EOP;
        }
    }

    /// The FLASH global interrupt (IRQ 4).
    pub fn irq_line(&self) -> bool {
        (self.cr & EOPIE != 0 && self.sr & EOP != 0)
            || (self.cr & ERRIE != 0 && self.sr & OPERR != 0)
    }

    /// The core clock changed: an operation in progress keeps its time
    /// left. Returns its new end.
    pub fn set_clock(&mut self, hclk: u32, now: Cycles) -> Option<Cycles> {
        let old = std::mem::replace(&mut self.hclk, hclk.max(1));
        let (op, end) = self.op?;
        let left = end.saturating_sub(now) as f64 * self.hclk as f64 / old.max(1) as f64;
        let end = now + (left.ceil() as Cycles).max(1);
        self.op = Some((op, end));
        self.gen = self.gen.wrapping_add(1);
        Some(end)
    }

    /// The hardware watchdog option (WDG_SW = 0): the IWDG runs from reset.
    pub fn hardware_watchdog(&self) -> bool {
        self.option_bytes & WDG_SW == 0
    }

    pub fn latency(&self) -> u32 {
        self.acr & 0xF
    }

    /// Minimum wait states for `hclk` at 2.7–3.6 V (RM0368 Table 6).
    pub fn required_latency(hclk: u32) -> u32 {
        match hclk {
            0..=30_000_000 => 0,
            30_000_001..=60_000_000 => 1,
            _ => 2,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flash() -> Memory {
        let mut m = Memory::new(0x0800_0000, 512 << 10, false);
        m.load(0x0800_0000, &vec![0xFF; 512 << 10]).unwrap();
        m
    }

    fn unlocked() -> FlashIf {
        let mut f = FlashIf::default();
        f.write(0x04, KEY1, u32::MAX, 0);
        f.write(0x04, KEY2, u32::MAX, 0);
        f
    }

    #[test]
    fn flash_latency_table() {
        assert_eq!(FlashIf::required_latency(16_000_000), 0);
        assert_eq!(FlashIf::required_latency(42_000_000), 1);
        assert_eq!(FlashIf::required_latency(84_000_000), 2);
        let mut f = FlashIf::default();
        f.write(0x00, 0x702, u32::MAX, 0);
        assert_eq!(f.latency(), 2);
    }

    #[test]
    fn unlock_and_a_wrong_key_locks_until_reset() {
        let f = unlocked();
        assert_eq!(f.read(0x10) & LOCK, 0);
        let mut f = FlashIf::default();
        f.write(0x04, KEY2, u32::MAX, 0);
        f.write(0x04, KEY1, u32::MAX, 0);
        f.write(0x04, KEY2, u32::MAX, 0);
        assert_ne!(f.read(0x10) & LOCK, 0, "poisoned by the wrong key");
        f.system_reset();
        f.write(0x04, KEY1, u32::MAX, 0);
        f.write(0x04, KEY2, u32::MAX, 0);
        assert_eq!(f.read(0x10) & LOCK, 0);
        // LOCK sets again.
        let mut f = unlocked();
        f.write(0x10, LOCK, u32::MAX, 0);
        assert_ne!(f.read(0x10) & LOCK, 0);
    }

    #[test]
    fn programming_needs_pg_and_the_psize_and_only_clears_bits() {
        let mut m = flash();
        let mut f = FlashIf::default();
        let a = 0x0802_0000;
        assert_eq!(
            f.program(&mut m, a, AccessSize::Word, 0, 0),
            Err(FlashFault::Locked)
        );
        let mut f = unlocked();
        assert_eq!(
            f.program(&mut m, a, AccessSize::Word, 0, 0),
            Err(FlashFault::Sequence)
        );
        assert_ne!(f.read(0x0C) & PGSERR, 0);
        f.write(0x0C, PGSERR, u32::MAX, 0);
        assert_eq!(f.read(0x0C), 0);
        // PSIZE x32 (2), PG.
        f.write(0x10, 2 << 8 | PG, u32::MAX, 0);
        assert_eq!(
            f.program(&mut m, a, AccessSize::Byte, 0, 0),
            Err(FlashFault::Parallelism)
        );
        assert_ne!(f.read(0x0C) & PGPERR, 0);
        let hclk = 16_000_000u64;
        let end = f
            .program(&mut m, a, AccessSize::Word, 0x1234_5678, 0)
            .unwrap();
        assert_eq!(end, 16 * hclk / 1_000_000, "16 µs");
        assert_ne!(f.read(0x0C) & BSY, 0);
        f.complete(&mut m);
        assert_eq!(f.read(0x0C) & BSY, 0);
        assert_eq!(m.read(a, AccessSize::Word).unwrap(), 0x1234_5678);
        // Programming again ANDs.
        f.program(&mut m, a, AccessSize::Word, 0xFFFF_0F0F, 0)
            .unwrap();
        f.complete(&mut m);
        assert_eq!(m.read(a, AccessSize::Word).unwrap(), 0x1234_0608);
        assert_eq!(f.programmed[5], 8);
        // A word across a 128-bit row.
        f.write(0x10, PG, u32::MAX, 0); // x8
        f.write(0x10, 1 << 8 | PG, u32::MAX, 0); // x16
        assert_eq!(
            f.program(&mut m, a + 15, AccessSize::Half, 0, 0),
            Err(FlashFault::Alignment)
        );
    }

    #[test]
    fn sector_erase_takes_its_time_and_sets_eop() {
        let mut m = flash();
        let mut f = unlocked();
        f.write(0x10, 2 << 8 | PG, u32::MAX, 0);
        f.program(&mut m, 0x0800_4010, AccessSize::Word, 0, 0)
            .unwrap();
        f.complete(&mut m);
        // SER, sector 1, x32, EOPIE, STRT.
        let cr = EOPIE | 2 << 8 | 1 << 3 | SER;
        let end = f.write(0x10, cr | STRT, u32::MAX, 100).unwrap();
        assert_eq!(end, 100 + 250_000 * 16, "250 ms at 16 MHz");
        assert_eq!(f.read(0x10) & STRT, 0);
        assert!(f.busy());
        // CR is not writable while busy.
        f.write(0x10, 0, u32::MAX, 200);
        assert_eq!(f.read(0x10), cr);
        assert_eq!(m.read(0x0800_4010, AccessSize::Word).unwrap(), 0);
        f.complete(&mut m);
        assert_eq!(m.read(0x0800_4010, AccessSize::Word).unwrap(), 0xFFFF_FFFF);
        assert_eq!(f.erase_counts[1], 1);
        assert_eq!(f.programmed[1], 0);
        assert_eq!(f.read(0x0C), EOP);
        assert!(f.irq_line());
        f.write(0x0C, EOP, u32::MAX, 0);
        assert!(!f.irq_line());
        // 128 KB sector at x8: 1.1 s × 1.6.
        f.write(0x10, 5 << 3 | SER, u32::MAX, 0);
        let end = f.write(0x10, 5 << 3 | SER | STRT, u32::MAX, 0).unwrap();
        assert_eq!(end, (1_760_000.0f64 * 16.0) as u64);
        // Both SER and MER: a sequence error.
        let mut f = unlocked();
        assert!(f.write(0x10, SER | MER | STRT, u32::MAX, 0).is_none());
        assert_ne!(f.read(0x0C) & PGSERR, 0);
    }

    #[test]
    fn option_bytes_protect_sectors_and_survive_reset() {
        let mut m = flash();
        let mut f = unlocked();
        f.write(0x08, OPTKEY1, u32::MAX, 0);
        f.write(0x08, OPTKEY2, u32::MAX, 0);
        assert_eq!(f.read(0x14) & OPTLOCK, 0);
        // Protect sector 0 (nWRP0 = 0) and select the hardware watchdog.
        let ob = OPTION_BYTES_DEFAULT & !(1 << 16) & !WDG_SW;
        f.write(0x14, ob, u32::MAX, 0);
        assert_eq!(f.option_bytes, OPTION_BYTES_DEFAULT, "not before OPTSTRT");
        f.write(0x14, ob | OPTSTRT, u32::MAX, 0).unwrap();
        f.complete(&mut m);
        assert_eq!(f.option_bytes, ob);
        assert!(f.hardware_watchdog());
        f.system_reset();
        assert_eq!(f.read(0x14), ob | OPTLOCK);
        let mut f2 = f.clone();
        f2.write(0x04, KEY1, u32::MAX, 0);
        f2.write(0x04, KEY2, u32::MAX, 0);
        f2.write(0x10, 2 << 8 | PG, u32::MAX, 0);
        assert_eq!(
            f2.program(&mut m, 0x0800_0000, AccessSize::Word, 0, 0),
            Err(FlashFault::Protected)
        );
        assert_ne!(f2.read(0x0C) & WRPERR, 0);
        f2.write(0x10, SER, u32::MAX, 0);
        assert!(f2.write(0x10, SER | STRT, u32::MAX, 0).is_none());
        assert_ne!(f2.read(0x0C) & WRPERR, 0);
    }

    #[test]
    fn activity_names_the_sectors_being_erased() {
        let mut m = flash();
        let mut f = unlocked();
        assert_eq!(f.activity(), FlashActivity::Idle);
        assert!(!f.locked());
        assert_eq!(f.write_protected(), 0);
        f.write(0x10, 2 << 8 | 6 << 3 | SER, u32::MAX, 0);
        f.write(0x10, 2 << 8 | 6 << 3 | SER | STRT, u32::MAX, 0)
            .unwrap();
        assert_eq!(f.activity(), FlashActivity::Erasing(1 << 6));
        f.complete(&mut m);
        assert_eq!(f.activity(), FlashActivity::Idle);
        f.write(0x10, 2 << 8 | PG, u32::MAX, 0);
        f.program(&mut m, 0x0804_0000, AccessSize::Word, 0, 0)
            .unwrap();
        assert_eq!(f.activity(), FlashActivity::Programming);
        f.complete(&mut m);
        f.option_bytes &= !(1 << 17 | 1 << 19);
        assert_eq!(f.write_protected(), 0b1010);
    }

    #[test]
    fn a_clock_change_keeps_the_time_left() {
        let mut m = flash();
        let mut f = unlocked();
        f.write(0x10, 2 << 8 | SER, u32::MAX, 0);
        let end = f.write(0x10, 2 << 8 | SER | STRT, u32::MAX, 0).unwrap();
        // Half way, the core goes to 84 MHz.
        let end2 = f.set_clock(84_000_000, end / 2).unwrap();
        assert_eq!(end2, end / 2 + (end / 2) * 84 / 16);
        f.complete(&mut m);
    }
}
