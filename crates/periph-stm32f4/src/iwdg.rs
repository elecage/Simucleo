//! Independent watchdog (IWDG, RM0368 §17): a 12-bit down-counter on the
//! 32 kHz LSI through a /4…/256 prescaler. KR 0xCCCC starts it (and the
//! LSI), 0xAAAA reloads it from RLR, 0x5555 opens PR and RLR for writing;
//! PVU/RVU in SR show a new prescaler/reload value travelling into the LSI
//! domain (five LSI periods). When the counter reaches 0 it resets the
//! chip. Nothing but a reset stops it. With the WDG_SW option byte cleared
//! (hardware watchdog) it runs from reset.

use simucleo_core::Cycles;

/// LSI frequency (Hz): nominally 32 kHz (17–47 kHz on the F401).
pub const LSI_HZ: f64 = 32_000.0;

#[derive(Debug, Clone)]
pub struct Iwdg {
    pub pr: u32,
    pub rlr: u32,
    /// PR/RLR writable (after KR = 0x5555).
    access: bool,
    /// The values the counter uses (PR/RLR as they were at the last reload
    /// once their update finished).
    running: bool,
    /// When the counter last reloaded, and with how many ticks.
    reload_at: Cycles,
    /// When PVU / RVU clear.
    pvu_until: Cycles,
    rvu_until: Cycles,
    hclk: u32,
    pub gen: u32,
    /// Counter value (prescaled ticks) at `reload_at`.
    count: f64,
}

impl Default for Iwdg {
    fn default() -> Self {
        Self {
            pr: 0,
            rlr: 0xFFF,
            access: false,
            running: false,
            reload_at: 0,
            pvu_until: 0,
            rvu_until: 0,
            hclk: 16_000_000,
            gen: 0,
            count: 0.0,
        }
    }
}

impl Iwdg {
    pub fn running(&self) -> bool {
        self.running
    }

    /// Core cycles per counter tick.
    fn tick_cycles(&self) -> f64 {
        let div = 4u32 << self.pr.min(6);
        div as f64 * self.hclk as f64 / LSI_HZ
    }

    fn lsi_cycles(&self, n: f64) -> Cycles {
        (n * self.hclk as f64 / LSI_HZ).ceil() as Cycles
    }

    /// The counter value now.
    pub fn counter(&self, now: Cycles) -> u32 {
        if !self.running {
            return self.rlr;
        }
        let gone = now.saturating_sub(self.reload_at) as f64 / self.tick_cycles();
        (self.count - gone).max(0.0) as u32
    }

    /// When it resets the chip (reaches 0).
    pub fn deadline(&self) -> Option<Cycles> {
        self.running
            .then(|| self.reload_at + (self.count * self.tick_cycles()).ceil() as Cycles)
    }

    fn reload(&mut self, now: Cycles) -> Option<Cycles> {
        self.reload_at = now;
        self.count = self.rlr as f64 + 1.0;
        self.gen = self.gen.wrapping_add(1);
        self.deadline()
    }

    /// Start it (KR = 0xCCCC, or the hardware watchdog at reset).
    pub fn start(&mut self, now: Cycles) -> Option<Cycles> {
        self.running = true;
        self.reload(now)
    }

    pub fn read(&self, offset: u32, now: Cycles) -> u32 {
        match offset {
            0x04 => self.pr,
            0x08 => self.rlr,
            0x0C => (now < self.pvu_until) as u32 | ((now < self.rvu_until) as u32) << 1,
            _ => 0,
        }
    }

    /// A register write; returns the new reset time when it changed
    /// (schedule `Event::Iwdg` with the new `gen`).
    pub fn write(&mut self, offset: u32, value: u32, now: Cycles) -> Option<Cycles> {
        match offset {
            0x00 => match value & 0xFFFF {
                0xCCCC => return self.start(now),
                0xAAAA if self.running => return self.reload(now),
                0x5555 => self.access = true,
                _ => self.access = false,
            },
            0x04 if self.access => {
                self.pr = value & 7;
                self.pvu_until = now + self.lsi_cycles(5.0);
            }
            0x08 if self.access => {
                self.rlr = value & 0xFFF;
                self.rvu_until = now + self.lsi_cycles(5.0);
            }
            _ => {}
        }
        None
    }

    /// The core clock changed: the counter keeps counting in LSI time.
    pub fn set_clock(&mut self, hclk: u32, now: Cycles) -> Option<Cycles> {
        if self.running {
            self.count = self.counter_exact(now);
            self.reload_at = now;
        }
        let ratio = hclk.max(1) as f64 / self.hclk.max(1) as f64;
        self.pvu_until = now + (self.pvu_until.saturating_sub(now) as f64 * ratio) as Cycles;
        self.rvu_until = now + (self.rvu_until.saturating_sub(now) as f64 * ratio) as Cycles;
        self.hclk = hclk.max(1);
        if self.running {
            self.gen = self.gen.wrapping_add(1);
        }
        self.deadline()
    }

    fn counter_exact(&self, now: Cycles) -> f64 {
        let gone = now.saturating_sub(self.reload_at) as f64 / self.tick_cycles();
        (self.count - gone).max(0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_down_reloads_and_times_out() {
        let mut w = Iwdg::default();
        assert!(w.deadline().is_none());
        // HAL_IWDG_Init: start, unlock, PR = /32 (3), RLR = 999, wait SR, reload.
        w.write(0, 0xCCCC, 0);
        w.write(0, 0x5555, 0);
        w.write(4, 3, 0);
        w.write(8, 999, 0);
        assert_eq!(w.read(0x0C, 0), 3, "PVU and RVU");
        let five_lsi = (5.0 * 16e6 / LSI_HZ) as Cycles;
        assert_eq!(w.read(0x0C, five_lsi + 1), 0);
        let end = w.write(0, 0xAAAA, 1000).unwrap();
        // 1000 ticks of 32/32 kHz = 1 s at 16 MHz.
        assert_eq!(end, 1000 + 16_000_000);
        assert_eq!(w.counter(1000 + 8_000_000), 500);
        // Refresh half way: another second from there.
        let end = w.write(0, 0xAAAA, 8_000_000).unwrap();
        assert_eq!(end, 8_000_000 + 16_000_000);
        // Writes without the key are ignored.
        w.write(0, 0, 0);
        w.write(8, 5, 0);
        assert_eq!(w.rlr, 999);
    }

    #[test]
    fn the_clock_does_not_change_its_time() {
        let mut w = Iwdg::default();
        w.write(0, 0x5555, 0);
        w.write(4, 0, 0); // /4: 8 kHz ticks
        w.write(8, 799, 0); // 100 ms
        let end = w.write(0, 0xCCCC, 0).unwrap();
        assert_eq!(end, 1_600_000);
        // At 50 ms the core goes from 16 to 84 MHz: 50 ms left = 4.2 M cycles.
        let end = w.set_clock(84_000_000, 800_000).unwrap();
        assert_eq!(end, 800_000 + 4_200_000);
    }
}
