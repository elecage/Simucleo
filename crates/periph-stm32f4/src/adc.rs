//! ADC1 (RM0368 §11): 12-bit successive-approximation converter.
//!
//! Modelled: power (ADON), regular group (SQR1–3) with single, scan and
//! continuous modes, software start, per-channel sampling time (SMPR) and
//! resolution (RES) in the conversion timing, data alignment, EOC/OVR flags
//! and interrupts, EOCS, the analog watchdog on the regular group, and the
//! internal channels (temperature sensor, VREFINT, VBAT/4). The voltage of
//! channels 0–15 comes from the pins (the external circuit). Not yet:
//! injected group, external (timer) triggers, DMA requests.

use simucleo_core::sched::Scheduler;
use simucleo_core::Cycles;

use crate::rcc::Clocks;

// SR
pub const AWD: u32 = 1 << 0;
pub const EOC: u32 = 1 << 1;
pub const STRT: u32 = 1 << 4;
pub const OVR: u32 = 1 << 5;
// CR1
const AWDIE: u32 = 1 << 6;
const EOCIE: u32 = 1 << 5;
const SCAN: u32 = 1 << 8;
const AWDSGL: u32 = 1 << 9;
const AWDEN: u32 = 1 << 23;
const OVRIE: u32 = 1 << 26;
// CR2
const ADON: u32 = 1 << 0;
const CONT: u32 = 1 << 1;
const DMA: u32 = 1 << 8;
const EOCS: u32 = 1 << 10;
const ALIGN: u32 = 1 << 11;
const SWSTART: u32 = 1 << 30;
// CCR
const TSVREFE: u32 = 1 << 23;
const VBATE: u32 = 1 << 22;

/// Sampling time in ADC clock cycles for SMPx = 0…7.
const SAMPLE_CYCLES: [u32; 8] = [3, 15, 28, 56, 84, 112, 144, 480];

/// Pin of each external channel 0–15: (port, pin).
pub const CHANNEL_PINS: [(u8, u8); 16] = [
    (0, 0),
    (0, 1),
    (0, 2),
    (0, 3),
    (0, 4),
    (0, 5),
    (0, 6),
    (0, 7),
    (1, 0),
    (1, 1),
    (2, 0),
    (2, 1),
    (2, 2),
    (2, 3),
    (2, 4),
    (2, 5),
];

/// Reference voltage (VREF+ = VDDA = 3.3 V on the Nucleo).
pub const VREF: f64 = 3.3;
/// Internal reference voltage (datasheet typical).
pub const VREFINT: f64 = 1.21;

#[derive(Debug, Clone)]
pub struct Adc {
    pub sr: u32,
    pub cr1: u32,
    pub cr2: u32,
    pub smpr: [u32; 2],
    pub jofr: [u32; 4],
    pub htr: u32,
    pub ltr: u32,
    pub sqr: [u32; 3],
    pub jsqr: u32,
    pub dr: u32,
    pub ccr: u32,
    /// Position in the regular sequence of the conversion in progress.
    seq_pos: u32,
    /// Channel being converted, if any.
    pub converting: Option<u8>,
    /// Bumped to invalidate scheduled conversions.
    pub gen: u32,
    /// Die temperature for the internal sensor, °C.
    pub die_temp: f64,
}

impl Default for Adc {
    fn default() -> Self {
        Self {
            sr: 0,
            cr1: 0,
            cr2: 0,
            smpr: [0; 2],
            jofr: [0; 4],
            htr: 0x0FFF,
            ltr: 0,
            sqr: [0; 3],
            jsqr: 0,
            dr: 0,
            ccr: 0,
            seq_pos: 0,
            converting: None,
            gen: 0,
            die_temp: 25.0,
        }
    }
}

/// What the bus must do after a register write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdcAction {
    None,
    /// Start converting the first channel of the regular sequence.
    Start,
    /// Conversions were cancelled (ADON cleared).
    Stop,
}

impl Adc {
    /// Reset, keeping the die temperature (an environment setting).
    pub fn reset(&mut self) {
        let (gen, die_temp) = (self.gen.wrapping_add(1), self.die_temp);
        *self = Self::default();
        self.gen = gen;
        self.die_temp = die_temp;
    }

    /// Number of conversions in the regular sequence.
    fn length(&self) -> u32 {
        if self.cr1 & SCAN == 0 {
            1
        } else {
            ((self.sqr[0] >> 20) & 0xF) + 1
        }
    }

    /// Channel at position `i` (0-based) of the regular sequence.
    fn sequence(&self, i: u32) -> u8 {
        // SQR3 holds SQ1–6, SQR2 SQ7–12, SQR1 SQ13–16; 5 bits each.
        let (reg, slot) = match i {
            0..=5 => (2, i),
            6..=11 => (1, i - 6),
            _ => (0, i - 12),
        };
        ((self.sqr[reg] >> (5 * slot)) & 0x1F) as u8
    }

    fn resolution_bits(&self) -> u32 {
        [12, 10, 8, 6][((self.cr1 >> 24) & 3) as usize]
    }

    /// ADC kernel clock: PCLK2 / 2, 4, 6 or 8 (ADCPRE).
    pub fn adc_clock(&self, clocks: &Clocks) -> u32 {
        clocks.pclk2 / (2 * (((self.ccr >> 16) & 3) + 1))
    }

    /// One conversion of `ch` in core clock cycles: sampling time plus one
    /// ADC clock per bit of resolution.
    pub fn conversion_cycles(&self, ch: u8, clocks: &Clocks) -> Cycles {
        let smp = if ch >= 10 {
            (self.smpr[0] >> (3 * (ch as u32 - 10))) & 7
        } else {
            (self.smpr[1] >> (3 * ch as u32)) & 7
        };
        let adc_cycles = SAMPLE_CYCLES[smp as usize] + self.resolution_bits();
        let per = clocks.hclk as f64 / self.adc_clock(clocks).max(1) as f64;
        ((adc_cycles as f64 * per).ceil() as Cycles).max(1)
    }

    /// Voltage of an internal channel (16 = temperature, 17 = VREFINT,
    /// 18 = VBAT/4), or `None` for external channels or disabled sensors.
    pub fn internal_voltage(&self, ch: u8) -> Option<f64> {
        match ch {
            // V25 = 0.76 V, 2.5 mV/°C (datasheet typical).
            16 if self.ccr & TSVREFE != 0 => Some(0.76 + 0.0025 * (self.die_temp - 25.0)),
            17 if self.ccr & TSVREFE != 0 => Some(VREFINT),
            // VBAT is tied to 3V3 on the Nucleo; the bridge divides by 4.
            18 if self.ccr & VBATE != 0 => Some(VREF / 4.0),
            16..=18 => Some(0.0),
            _ => None,
        }
    }

    /// Code for a voltage at the configured resolution and alignment.
    pub fn code(&self, volts: f64) -> u32 {
        let full = (volts / VREF * 4096.0).floor().clamp(0.0, 4095.0) as u32;
        let bits = self.resolution_bits();
        let v = full >> (12 - bits);
        if self.cr2 & ALIGN != 0 {
            // Left aligned: MSB at bit 15.
            v << (16 - bits)
        } else {
            v
        }
    }

    /// Interrupt request line.
    pub fn irq_line(&self) -> bool {
        (self.sr & EOC != 0 && self.cr1 & EOCIE != 0)
            || (self.sr & OVR != 0 && self.cr1 & OVRIE != 0)
            || (self.sr & AWD != 0 && self.cr1 & AWDIE != 0)
    }

    pub fn read(&mut self, offset: u32) -> u32 {
        match offset {
            0x00 => self.sr,
            0x04 => self.cr1,
            0x08 => self.cr2,
            0x0C => self.smpr[0],
            0x10 => self.smpr[1],
            0x14..=0x20 => self.jofr[((offset - 0x14) / 4) as usize],
            0x24 => self.htr,
            0x28 => self.ltr,
            0x2C..=0x34 => self.sqr[((offset - 0x2C) / 4) as usize],
            0x38 => self.jsqr,
            0x4C => {
                // Reading DR clears EOC.
                self.sr &= !EOC;
                self.dr
            }
            // Common registers.
            0x300 => self.sr & 0x3F, // CSR mirrors ADC1's flags
            0x304 => self.ccr,
            _ => 0,
        }
    }

    pub fn peek(&self, offset: u32) -> u32 {
        match offset {
            0x4C => self.dr,
            _ => self.clone().read(offset),
        }
    }

    pub fn write(&mut self, offset: u32, value: u32, lanes: u32) -> AdcAction {
        let merge = |old: u32| (old & !lanes) | (value & lanes);
        match offset {
            // rc_w0 flags
            0x00 => self.sr &= (value | !lanes) | !0x3F,
            0x04 => self.cr1 = merge(self.cr1),
            0x08 => {
                let was_on = self.cr2 & ADON != 0;
                let v = merge(self.cr2);
                self.cr2 = v & !SWSTART & !(1 << 22); // start bits read as 0
                if was_on && self.cr2 & ADON == 0 {
                    self.converting = None;
                    self.sr &= !STRT;
                    self.gen = self.gen.wrapping_add(1);
                    return AdcAction::Stop;
                }
                // SWSTART only starts a powered converter that is idle.
                if v & lanes & SWSTART != 0 && self.cr2 & ADON != 0 && self.converting.is_none() {
                    self.seq_pos = 0;
                    self.sr |= STRT;
                    return AdcAction::Start;
                }
            }
            0x0C => self.smpr[0] = merge(self.smpr[0]) & 0x07FF_FFFF,
            0x10 => self.smpr[1] = merge(self.smpr[1]) & 0x3FFF_FFFF,
            0x14..=0x20 => {
                let i = ((offset - 0x14) / 4) as usize;
                self.jofr[i] = merge(self.jofr[i]) & 0xFFF;
            }
            0x24 => self.htr = merge(self.htr) & 0xFFF,
            0x28 => self.ltr = merge(self.ltr) & 0xFFF,
            0x2C..=0x34 => {
                let i = ((offset - 0x2C) / 4) as usize;
                self.sqr[i] = merge(self.sqr[i]);
            }
            0x38 => self.jsqr = merge(self.jsqr),
            0x304 => self.ccr = merge(self.ccr) & 0x00C3_EF00,
            _ => {}
        }
        AdcAction::None
    }

    /// Begin the conversion at the current sequence position.
    pub fn begin(&mut self, now: Cycles, clocks: &Clocks, sched: &mut Scheduler<crate::Event>) {
        let ch = self.sequence(self.seq_pos);
        self.converting = Some(ch);
        self.gen = self.gen.wrapping_add(1);
        let at = now + self.conversion_cycles(ch, clocks);
        sched.schedule_at(at, crate::Event::Adc { gen: self.gen });
    }

    /// The conversion in progress finished with the input at `volts`.
    /// Returns whether another conversion follows (call `begin` again).
    pub fn complete(&mut self, volts: f64) -> bool {
        let Some(ch) = self.converting.take() else {
            return false;
        };
        let code = self.code(volts);
        // Overrun: a result that nobody read is lost (detected when DMA
        // or EOCS is used, RM0368 §11.8.2).
        if self.sr & EOC != 0 && self.cr2 & (DMA | EOCS) != 0 {
            self.sr |= OVR;
            self.sr &= !STRT;
            return false;
        }
        self.dr = code;
        // Analog watchdog on the regular group.
        if self.cr1 & AWDEN != 0 && (self.cr1 & AWDSGL == 0 || ch as u32 == self.cr1 & 0x1F) {
            let raw = (volts / VREF * 4096.0).floor().clamp(0.0, 4095.0) as u32;
            if raw > self.htr || raw < self.ltr {
                self.sr |= AWD;
            }
        }
        let last = self.seq_pos + 1 >= self.length();
        if self.cr2 & EOCS != 0 || last {
            self.sr |= EOC;
        }
        if !last {
            self.seq_pos += 1;
            true
        } else if self.cr2 & CONT != 0 {
            self.seq_pos = 0;
            true
        } else {
            self.seq_pos = 0;
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn clocks() -> Clocks {
        Clocks {
            sysclk: 84_000_000,
            hclk: 84_000_000,
            pclk1: 42_000_000,
            pclk2: 84_000_000,
            tim_apb1: 84_000_000,
            tim_apb2: 84_000_000,
        }
    }

    #[test]
    fn codes_and_alignment() {
        let mut a = Adc::default();
        assert_eq!(a.code(0.0), 0);
        assert_eq!(a.code(3.3), 4095);
        assert_eq!(a.code(1.65), 2048);
        a.cr1 = 2 << 24; // 8-bit
        assert_eq!(a.code(1.65), 128);
        a.cr2 = ALIGN;
        assert_eq!(a.code(1.65), 128 << 8);
    }

    #[test]
    fn conversion_time_follows_prescaler_and_sampling() {
        // PCLK2 84 MHz / 4 = 21 MHz ADC clock; 3 + 12 cycles → 60 core cycles.
        let mut a = Adc {
            ccr: 1 << 16,
            ..Default::default()
        };
        assert_eq!(a.conversion_cycles(0, &clocks()), 60);
        a.smpr[1] = 7 << 3; // channel 1: 480 cycles
        assert_eq!(a.conversion_cycles(1, &clocks()), (480 + 12) * 4);
    }

    #[test]
    fn scan_sequence_sets_eoc_at_the_end() {
        let mut a = Adc::default();
        let mut sched = Scheduler::new();
        a.write(0x04, SCAN, u32::MAX);
        a.write(0x2C, 1 << 20, u32::MAX); // L = 1: two conversions
        a.write(0x34, 3 | (16 << 5), u32::MAX); // ch3, ch16
        a.write(0x304, TSVREFE, u32::MAX);
        assert_eq!(a.write(0x08, ADON, u32::MAX), AdcAction::None);
        assert_eq!(a.write(0x08, ADON | SWSTART, u32::MAX), AdcAction::Start);
        a.begin(0, &clocks(), &mut sched);
        assert_eq!(a.converting, Some(3));
        assert!(a.complete(1.0));
        assert_eq!(a.sr & EOC, 0, "EOC at the end of the sequence (EOCS = 0)");
        a.begin(100, &clocks(), &mut sched);
        assert_eq!(a.converting, Some(16));
        let v = a.internal_voltage(16).unwrap();
        assert!((v - 0.76).abs() < 1e-9);
        assert!(!a.complete(v));
        assert_eq!(a.sr & EOC, EOC);
        assert_eq!(a.read(0x4C), a.code(0.76));
        assert_eq!(a.sr & EOC, 0, "reading DR clears EOC");
    }

    #[test]
    fn overrun_with_eocs() {
        let mut a = Adc::default();
        let mut sched = Scheduler::new();
        a.write(0x08, ADON | CONT | EOCS, u32::MAX);
        a.write(0x08, ADON | CONT | EOCS | SWSTART, u32::MAX);
        a.begin(0, &clocks(), &mut sched);
        assert!(a.complete(1.0));
        a.begin(10, &clocks(), &mut sched);
        assert!(!a.complete(2.0), "DR not read: overrun stops conversions");
        assert_eq!(a.sr & OVR, OVR);
    }
}
