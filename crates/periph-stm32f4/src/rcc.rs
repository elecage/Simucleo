//! Reset and clock control (RM0368 §6) and the resulting clock tree.
//!
//! Oscillators become ready as soon as they are switched on (HAL polls the
//! ready flags with timeouts, so start-up delays do not matter), with the
//! board's real constraints:
//! * HSE: the Nucleo-F401RE has no crystal fitted by default. The ST-LINK
//!   feeds an 8 MHz clock into OSC_IN, so HSE only becomes ready in
//!   **bypass** mode (`HSEBYP`). Enabling HSE without bypass times out, just
//!   like on the real board — a classic CubeMX configuration mistake.
//! * LSE: 32.768 kHz crystal (X2) is fitted.

pub const HSI_HZ: u32 = 16_000_000;
/// ST-LINK MCO output on the Nucleo board.
pub const HSE_BYPASS_HZ: u32 = 8_000_000;
pub const LSE_HZ: u32 = 32_768;
pub const LSI_HZ: u32 = 32_000;

// CR
const HSION: u32 = 1 << 0;
const HSIRDY: u32 = 1 << 1;
const HSEON: u32 = 1 << 16;
const HSERDY: u32 = 1 << 17;
const HSEBYP: u32 = 1 << 18;
const PLLON: u32 = 1 << 24;
const PLLRDY: u32 = 1 << 25;
const PLLI2SON: u32 = 1 << 26;
const PLLI2SRDY: u32 = 1 << 27;
// BDCR / CSR
const LSEON: u32 = 1 << 0;
const LSERDY: u32 = 1 << 1;
const LSION: u32 = 1 << 0;
const LSIRDY: u32 = 1 << 1;
const RMVF: u32 = 1 << 24;

/// Why the chip (re)started, reflected in RCC_CSR.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResetCause {
    PowerOn,
    Pin,
    Software,
}

/// Bus clock frequencies in Hz.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Clocks {
    pub sysclk: u32,
    pub hclk: u32,
    pub pclk1: u32,
    pub pclk2: u32,
    /// Timer kernel clocks (×2 when the APB prescaler is not 1).
    pub tim_apb1: u32,
    pub tim_apb2: u32,
}

#[derive(Debug, Clone)]
pub struct Rcc {
    pub cr: u32,
    pub pllcfgr: u32,
    pub cfgr: u32,
    pub cir: u32,
    pub ahb1rstr: u32,
    pub ahb2rstr: u32,
    pub apb1rstr: u32,
    pub apb2rstr: u32,
    pub ahb1enr: u32,
    pub ahb2enr: u32,
    pub apb1enr: u32,
    pub apb2enr: u32,
    pub ahb1lpenr: u32,
    pub ahb2lpenr: u32,
    pub apb1lpenr: u32,
    pub apb2lpenr: u32,
    pub bdcr: u32,
    pub csr: u32,
    pub sscgr: u32,
    pub plli2scfgr: u32,
    pub dckcfgr: u32,
    /// Board option: HSE crystal fitted (X3). Default false (Nucleo default).
    pub hse_crystal: bool,
}

impl Rcc {
    pub fn new(cause: ResetCause) -> Self {
        let mut r = Self {
            cr: 0x0000_0083,
            pllcfgr: 0x2400_3010,
            cfgr: 0,
            cir: 0,
            ahb1rstr: 0,
            ahb2rstr: 0,
            apb1rstr: 0,
            apb2rstr: 0,
            ahb1enr: 0,
            ahb2enr: 0,
            apb1enr: 0,
            apb2enr: 0,
            ahb1lpenr: 0x0061_900F,
            ahb2lpenr: 0x0000_0080,
            apb1lpenr: 0x10E2_C80F,
            apb2lpenr: 0x0007_7930,
            bdcr: 0,
            csr: 0,
            sscgr: 0,
            plli2scfgr: 0x2400_3000,
            dckcfgr: 0,
            hse_crystal: false,
        };
        r.csr = match cause {
            // BORRSTF | PINRSTF | PORRSTF
            ResetCause::PowerOn => 0x0E00_0000,
            ResetCause::Pin => 0x0400_0000,
            // SFTRSTF | PINRSTF (the reset pin is driven during any reset)
            ResetCause::Software => 0x1400_0000,
        };
        r
    }

    /// System reset: everything except the backup domain (BDCR) returns to
    /// its reset value; reset flags accumulate until RMVF.
    pub fn system_reset(&mut self, cause: ResetCause) {
        let bdcr = self.bdcr;
        let flags = self.csr & 0xFE00_0000;
        let crystal = self.hse_crystal;
        *self = Self::new(cause);
        self.bdcr = bdcr;
        self.csr |= flags;
        self.hse_crystal = crystal;
    }

    fn hse_ready(&self) -> bool {
        self.cr & HSEON != 0 && (self.cr & HSEBYP != 0 || self.hse_crystal)
    }

    fn pll_input_ready(&self) -> bool {
        if self.pllcfgr & (1 << 22) != 0 {
            self.hse_ready()
        } else {
            self.cr & HSION != 0
        }
    }

    /// Recompute the ready flags and the actual clock switch (SWS).
    fn settle(&mut self) {
        let mut cr = self.cr & !(HSIRDY | HSERDY | PLLRDY | PLLI2SRDY);
        // HSI cannot be stopped while it feeds the system clock.
        if (self.cfgr >> 2) & 3 == 0 {
            cr |= HSION;
        }
        self.cr = cr;
        if cr & HSION != 0 {
            self.cr |= HSIRDY;
        }
        if self.hse_ready() {
            self.cr |= HSERDY;
        }
        if cr & PLLON != 0 && self.pll_input_ready() {
            self.cr |= PLLRDY;
        }
        if cr & PLLI2SON != 0 && self.pll_input_ready() {
            self.cr |= PLLI2SRDY;
        }
        // The switch happens only to a ready source.
        let sw = self.cfgr & 3;
        let ready = match sw {
            0 => self.cr & HSIRDY != 0,
            1 => self.cr & HSERDY != 0,
            2 => self.cr & PLLRDY != 0,
            _ => false,
        };
        if ready {
            self.cfgr = (self.cfgr & !(3 << 2)) | (sw << 2);
        }
        // LSE (crystal fitted) and LSI.
        self.bdcr = (self.bdcr & !LSERDY) | if self.bdcr & LSEON != 0 { LSERDY } else { 0 };
        self.csr = (self.csr & !LSIRDY) | if self.csr & LSION != 0 { LSIRDY } else { 0 };
    }

    pub fn read(&self, offset: u32) -> u32 {
        match offset {
            0x00 => self.cr,
            0x04 => self.pllcfgr,
            0x08 => self.cfgr,
            0x0C => self.cir,
            0x10 => self.ahb1rstr,
            0x14 => self.ahb2rstr,
            0x20 => self.apb1rstr,
            0x24 => self.apb2rstr,
            0x30 => self.ahb1enr,
            0x34 => self.ahb2enr,
            0x40 => self.apb1enr,
            0x44 => self.apb2enr,
            0x50 => self.ahb1lpenr,
            0x54 => self.ahb2lpenr,
            0x60 => self.apb1lpenr,
            0x64 => self.apb2lpenr,
            0x70 => self.bdcr,
            0x74 => self.csr,
            0x80 => self.sscgr,
            0x84 => self.plli2scfgr,
            0x8C => self.dckcfgr,
            _ => 0,
        }
    }

    /// Returns `true` if the clock tree may have changed.
    pub fn write(&mut self, offset: u32, value: u32, lanes: u32) -> bool {
        let m = |old: u32| (old & !lanes) | (value & lanes);
        match offset {
            0x00 => {
                // HSITRIM and the ON/BYP bits are writable; ready bits are not.
                let mask = 0x050D_00F9 & lanes;
                self.cr = (self.cr & !mask) | (value & mask);
            }
            0x04 => self.pllcfgr = m(self.pllcfgr) & 0x0F43_7FFF,
            0x08 => self.cfgr = (m(self.cfgr) & !(3 << 2)) | (self.cfgr & (3 << 2)),
            0x0C => self.cir = m(self.cir) & 0x0000_3F00,
            0x10 => self.ahb1rstr = m(self.ahb1rstr),
            0x14 => self.ahb2rstr = m(self.ahb2rstr),
            0x20 => self.apb1rstr = m(self.apb1rstr),
            0x24 => self.apb2rstr = m(self.apb2rstr),
            0x30 => self.ahb1enr = m(self.ahb1enr) & 0x0060_109F,
            0x34 => self.ahb2enr = m(self.ahb2enr) & 0x80,
            0x40 => self.apb1enr = m(self.apb1enr) & 0x10E2_C80F,
            0x44 => self.apb2enr = m(self.apb2enr) & 0x0007_7931,
            0x50 => self.ahb1lpenr = m(self.ahb1lpenr),
            0x54 => self.ahb2lpenr = m(self.ahb2lpenr),
            0x60 => self.apb1lpenr = m(self.apb1lpenr),
            0x64 => self.apb2lpenr = m(self.apb2lpenr),
            0x70 => {
                if value & lanes & (1 << 16) != 0 {
                    self.bdcr = 0; // BDRST
                } else {
                    self.bdcr = m(self.bdcr) & 0x0001_8305;
                }
            }
            0x74 => {
                if value & lanes & RMVF != 0 {
                    self.csr &= 0x00FF_FFFF;
                }
                self.csr = (self.csr & !LSION) | (value & lanes & LSION);
            }
            0x80 => self.sscgr = m(self.sscgr),
            0x84 => self.plli2scfgr = m(self.plli2scfgr),
            0x8C => self.dckcfgr = m(self.dckcfgr) & (1 << 24),
            _ => return false,
        }
        self.settle();
        matches!(offset, 0x00 | 0x04 | 0x08 | 0x8C)
    }

    fn pll_out(&self) -> (u32, u32) {
        let src = if self.pllcfgr & (1 << 22) != 0 {
            HSE_BYPASS_HZ
        } else {
            HSI_HZ
        } as u64;
        let m = (self.pllcfgr & 0x3F).max(2) as u64;
        let n = ((self.pllcfgr >> 6) & 0x1FF) as u64;
        let p = (((self.pllcfgr >> 16) & 3) as u64 + 1) * 2;
        let q = ((self.pllcfgr >> 24) & 0xF).max(2) as u64;
        let vco = src * n / m;
        ((vco / p) as u32, (vco / q) as u32)
    }

    pub fn clocks(&self) -> Clocks {
        let sysclk = match (self.cfgr >> 2) & 3 {
            1 => HSE_BYPASS_HZ,
            2 => self.pll_out().0,
            _ => HSI_HZ,
        };
        let hpre = (self.cfgr >> 4) & 0xF;
        let ahb_div = if hpre < 8 {
            1
        } else {
            [2, 4, 8, 16, 64, 128, 256, 512][(hpre - 8) as usize]
        };
        let apb_div = |bits: u32| if bits < 4 { 1 } else { 1 << (bits - 3) };
        let hclk = sysclk / ahb_div;
        let d1 = apb_div((self.cfgr >> 10) & 7);
        let d2 = apb_div((self.cfgr >> 13) & 7);
        let pclk1 = hclk / d1;
        let pclk2 = hclk / d2;
        Clocks {
            sysclk,
            hclk,
            pclk1,
            pclk2,
            tim_apb1: if d1 == 1 { pclk1 } else { pclk1 * 2 },
            tim_apb2: if d2 == 1 { pclk2 } else { pclk2 * 2 },
        }
    }

    /// Is the bus clock of a peripheral enabled? `reg` is the ENR offset.
    pub fn clock_enabled(&self, enr: u32, bit: u32) -> bool {
        self.read(enr) & (1 << bit) != 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: u32 = u32::MAX;

    #[test]
    fn reset_state_runs_on_hsi() {
        let r = Rcc::new(ResetCause::PowerOn);
        assert_eq!(r.read(0x00) & 3, 3); // HSION | HSIRDY
        assert_eq!(r.clocks().hclk, 16_000_000);
        assert_eq!(r.read(0x74) >> 24, 0x0E);
    }

    #[test]
    fn cubemx_nucleo_f401re_84mhz_from_hsi() {
        let mut r = Rcc::new(ResetCause::PowerOn);
        // PLLM=16, PLLN=336, PLLP=/4, PLLQ=7, source HSI
        r.write(0x04, 16 | (336 << 6) | (1 << 16) | (7 << 24), W);
        r.write(0x00, r.read(0x00) | PLLON, W);
        assert_ne!(r.read(0x00) & PLLRDY, 0);
        // APB1 /2, then switch to PLL
        r.write(0x08, (4 << 10) | 2, W);
        assert_eq!((r.read(0x08) >> 2) & 3, 2, "SWS follows SW");
        let c = r.clocks();
        assert_eq!(
            (c.sysclk, c.hclk, c.pclk1, c.pclk2, c.tim_apb1),
            (84_000_000, 84_000_000, 42_000_000, 84_000_000, 84_000_000)
        );
    }

    #[test]
    fn hse_needs_bypass_on_nucleo() {
        let mut r = Rcc::new(ResetCause::PowerOn);
        r.write(0x00, r.read(0x00) | HSEON, W);
        assert_eq!(r.read(0x00) & HSERDY, 0, "no crystal: HSE never ready");
        r.write(0x08, 1, W);
        assert_eq!(
            (r.read(0x08) >> 2) & 3,
            0,
            "switch to an unready source is ignored"
        );
        r.write(0x00, r.read(0x00) | HSEBYP, W);
        assert_ne!(r.read(0x00) & HSERDY, 0);
        r.write(0x08, 1, W);
        assert_eq!(r.clocks().sysclk, 8_000_000);
    }

    #[test]
    fn reset_flags() {
        let mut r = Rcc::new(ResetCause::PowerOn);
        r.write(0x74, RMVF, W);
        assert_eq!(r.read(0x74) >> 24, 0);
        r.write(0x70, LSEON, W);
        r.system_reset(ResetCause::Software);
        assert_eq!(r.read(0x74) >> 24, 0x14);
        assert_eq!(
            r.read(0x70) & 3,
            LSEON | LSERDY,
            "backup domain survives reset"
        );
    }
}
