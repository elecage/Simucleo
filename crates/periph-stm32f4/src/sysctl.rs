//! Power controller (PWR, RM0368 §5), flash interface (FLASH, §3) and
//! system configuration controller (SYSCFG, §7).

/// PWR: VOS and the backup-domain write protection matter to HAL; the
/// voltage scaling is "ready" at once.
#[derive(Debug, Clone)]
pub struct Pwr {
    pub cr: u32,
    pub csr: u32,
}

impl Default for Pwr {
    fn default() -> Self {
        Self {
            cr: 0x0000_8000,
            csr: 0,
        }
    }
}

impl Pwr {
    const VOSRDY: u32 = 1 << 14;

    pub fn read(&self, offset: u32) -> u32 {
        match offset {
            0x00 => self.cr,
            0x04 => self.csr | Self::VOSRDY,
            _ => 0,
        }
    }

    pub fn write(&mut self, offset: u32, value: u32, lanes: u32) {
        match offset {
            0x00 => {
                let v = (self.cr & !lanes) | (value & lanes);
                // CWUF (bit 2) / CSBF (bit 3) clear WUF / SBF and read as 0.
                if v & (1 << 2) != 0 {
                    self.csr &= !1;
                }
                if v & (1 << 3) != 0 {
                    self.csr &= !2;
                }
                self.cr = v & 0x0000_CFF3;
            }
            0x04 => self.csr = (self.csr & !(lanes & 0x300)) | (value & lanes & 0x300), // EWUP, BRE
            _ => {}
        }
    }

    /// Backup-domain write access enabled (DBP).
    pub fn dbp(&self) -> bool {
        self.cr & (1 << 8) != 0
    }
}

/// Flash interface: wait states and caches (no programming yet).
#[derive(Debug, Clone)]
pub struct FlashIf {
    pub acr: u32,
    pub cr: u32,
    pub optcr: u32,
    key_step: u8,
}

impl Default for FlashIf {
    fn default() -> Self {
        // OPTCR reset per RM0368 (the SVD's value is wrong).
        Self {
            acr: 0,
            cr: 0x8000_0000,
            optcr: 0x0FFF_AAED,
            key_step: 0,
        }
    }
}

impl FlashIf {
    pub fn read(&self, offset: u32) -> u32 {
        match offset {
            0x00 => self.acr,
            0x0C => 0, // SR: never busy, no errors
            0x10 => self.cr,
            0x14 => self.optcr,
            _ => 0,
        }
    }

    pub fn write(&mut self, offset: u32, value: u32, lanes: u32) {
        let m = |old: u32| (old & !lanes) | (value & lanes);
        match offset {
            0x00 => self.acr = m(self.acr) & 0x1F0F,
            0x04 => {
                // KEYR unlock sequence
                self.key_step = match (self.key_step, value) {
                    (0, 0x4567_0123) => 1,
                    (1, 0xCDEF_89AB) => {
                        self.cr &= !(1 << 31);
                        0
                    }
                    _ => 0,
                };
            }
            // CR is writable only once unlocked.
            0x10 if self.cr & (1 << 31) == 0 => self.cr = m(self.cr) & 0x8101_037F,
            _ => {}
        }
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

    #[test]
    fn flash_latency_table() {
        assert_eq!(FlashIf::required_latency(16_000_000), 0);
        assert_eq!(FlashIf::required_latency(42_000_000), 1);
        assert_eq!(FlashIf::required_latency(84_000_000), 2);
        let mut f = FlashIf::default();
        f.write(0x00, 0x702, u32::MAX);
        assert_eq!(f.latency(), 2);
    }

    #[test]
    fn flash_unlock() {
        let mut f = FlashIf::default();
        f.write(0x04, 0x4567_0123, u32::MAX);
        f.write(0x04, 0xCDEF_89AB, u32::MAX);
        assert_eq!(f.read(0x10) >> 31, 0);
    }

    #[test]
    fn pwr_vos_ready() {
        let p = Pwr::default();
        assert_ne!(p.read(0x04) & (1 << 14), 0);
    }
}

/// SYSCFG: EXTI line routing (EXTICR1–4); the memory remap and compensation
/// cell keep their values.
#[derive(Debug, Clone, Default)]
pub struct Syscfg {
    pub memrmp: u32,
    pub pmc: u32,
    pub exticr: [u32; 4],
    pub cmpcr: u32,
}

impl Syscfg {
    pub fn read(&self, offset: u32) -> u32 {
        match offset {
            0x00 => self.memrmp,
            0x04 => self.pmc,
            0x08..=0x14 => self.exticr[((offset - 0x08) / 4) as usize],
            // READY follows CMP_PD at once.
            0x20 => self.cmpcr | ((self.cmpcr & 1) << 8),
            _ => 0,
        }
    }

    pub fn write(&mut self, offset: u32, value: u32, lanes: u32) {
        let merge = |old: u32, mask: u32| ((old & !lanes) | (value & lanes)) & mask;
        match offset {
            0x00 => self.memrmp = merge(self.memrmp, 3),
            0x04 => self.pmc = merge(self.pmc, 1 << 16),
            0x08..=0x14 => {
                let i = ((offset - 0x08) / 4) as usize;
                self.exticr[i] = merge(self.exticr[i], 0xFFFF);
            }
            0x20 => self.cmpcr = merge(self.cmpcr, 1),
            _ => {}
        }
    }

    /// Port (0 = A) routed to EXTI line `line` (0–15).
    pub fn exti_port(&self, line: u8) -> usize {
        ((self.exticr[line as usize / 4] >> (4 * (line % 4))) & 0xF) as usize
    }
}
