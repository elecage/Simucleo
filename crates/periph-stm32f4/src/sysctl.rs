//! Power controller (PWR, RM0368 §5) and system configuration controller
//! (SYSCFG, §7).

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

#[cfg(test)]
mod tests {
    use super::*;

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
