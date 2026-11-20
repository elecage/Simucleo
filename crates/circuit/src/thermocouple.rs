//! M35: K-type thermocouple amplifiers on SPI (read only).
//!
//! - MAX6675: 16-bit word — D15 dummy 0, D14–D3 the cold-junction
//!   compensated temperature (12 bits, 0.25 °C, 0 to 1023.75 °C), D2 high
//!   when the thermocouple input is open, D1 device ID 0, D0 three-state.
//!   A conversion takes up to 220 ms.
//! - MAX31855K: 32-bit word — D31–D18 the hot junction (14-bit signed,
//!   0.25 °C), D16 fault, D15–D4 the internal cold junction (12-bit
//!   signed, 0.0625 °C), D2 SCV (short to VCC), D1 SCG (short to GND), D0
//!   OC (open). A conversion takes up to 100 ms.
//!
//! The thermocouple makes the NIST ITS-90 type K voltage of the hot
//! junction less that of the cold one (the module, at ambient
//! temperature); the chips turn it into a temperature with a straight line
//! (MAX6675: 41 µV/°C, MAX31855K: 41.276 µV/°C) and add their own die
//! temperature, so the datasheets' nonlinearity error appears away from
//! 0–400 °C. A probe on the wrong way round reads downwards.
//!
//! Both chips put D(n−1) on SO when CS falls and the next bit after each
//! SCK falling edge (SPI mode 0). Pulling CS low stops a conversion in
//! progress — the word read is the last finished result — and a new
//! conversion starts when CS rises. The data comes either from hardware
//! SPI bytes ([`Thermocouple::exchange`], which knows the SCK rate and
//! mode) or from bit-banged pin edges ([`Thermocouple::pins`]).

use crate::devices::Seconds;

/// Supply the chips need (V): MAX6675 3.0–5.5 V, MAX31855 3.0–3.6 V
/// (the module regulates VIN).
pub const TC_VMIN: f64 = 3.0;

/// NIST ITS-90 type K thermocouple voltage (mV) at `t` °C, cold junction
/// at 0 °C (valid −270 to 1372 °C).
pub fn type_k_mv(t: f64) -> f64 {
    const NEG: [f64; 11] = [
        0.0,
        0.394_501_280_250e-1,
        0.236_223_735_980e-4,
        -0.328_589_067_840e-6,
        -0.499_048_287_770e-8,
        -0.675_090_591_730e-10,
        -0.574_103_274_280e-12,
        -0.310_888_728_940e-14,
        -0.104_516_093_650e-16,
        -0.198_892_668_780e-19,
        -0.163_226_974_860e-22,
    ];
    const POS: [f64; 10] = [
        -0.176_004_136_860e-1,
        0.389_212_049_750e-1,
        0.185_587_700_320e-4,
        -0.994_575_928_740e-7,
        0.318_409_457_190e-9,
        -0.560_728_448_890e-12,
        0.560_750_590_590e-15,
        -0.320_207_200_030e-18,
        0.971_511_471_520e-22,
        -0.121_047_212_750e-25,
    ];
    let t = t.clamp(-270.0, 1372.0);
    let poly = |c: &[f64]| c.iter().rev().fold(0.0, |acc, &k| acc * t + k);
    if t < 0.0 {
        poly(&NEG)
    } else {
        let (a0, a1, a2) = (0.118_597_6, -0.118_343_2e-3, 126.968_6);
        poly(&POS) + a0 * (a1 * (t - a2) * (t - a2)).exp()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TcChip {
    Max6675,
    Max31855,
}

impl TcChip {
    pub fn name(self) -> &'static str {
        match self {
            TcChip::Max6675 => "MAX6675",
            TcChip::Max31855 => "MAX31855",
        }
    }

    /// Bits in the word it shifts out.
    pub fn bits(self) -> u32 {
        match self {
            TcChip::Max6675 => 16,
            TcChip::Max31855 => 32,
        }
    }

    /// Conversion time (s), the datasheet maximum.
    pub fn conversion(self) -> Seconds {
        match self {
            TcChip::Max6675 => 0.22,
            TcChip::Max31855 => 0.10,
        }
    }

    /// Fastest SCK (Hz).
    pub fn max_sck(self) -> f64 {
        match self {
            TcChip::Max6675 => 4.3e6,
            TcChip::Max31855 => 5.0e6,
        }
    }

    /// The straight line the chip assumes (mV per °C).
    pub fn gain_mv(self) -> f64 {
        match self {
            TcChip::Max6675 => 0.041,
            TcChip::Max31855 => 0.041_276,
        }
    }
}

/// What is wrong with the probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ProbeFault {
    #[default]
    None,
    /// Unplugged or broken: no thermocouple between T+ and T−.
    Open,
    /// The thermocouple touches ground.
    ShortGnd,
    /// The thermocouple touches the supply.
    ShortVcc,
}

/// One thermocouple module: the chip and its probe.
#[derive(Debug, Clone)]
pub struct Thermocouple {
    pub chip: TcChip,
    /// Hot junction (probe tip) and cold junction (the module) in °C.
    pub hot: f64,
    pub cold: f64,
    /// The probe's wires on the wrong terminals.
    pub reversed: bool,
    pub fault: ProbeFault,
    pub powered: bool,
    /// The last finished conversion: what a read shifts out.
    result: u32,
    /// A conversion finished since the last read.
    fresh: bool,
    /// When the running conversion started (CS high and powered).
    converting: Option<Seconds>,
    /// When CS last rose (or the chip powered up).
    since: Seconds,
    /// CS low: the word being shifted out and SCK falling edges so far.
    reading: Option<(u32, u32)>,
    /// This CS-low period has clocked bits out (it is a read).
    clocked: bool,
    /// Why the word being read is an old one, told once it is clocked.
    stale_note: Option<String>,
    last_sck: Option<bool>,
    last_cs: Option<bool>,
    /// Reads so far, and reads that stopped a conversion before it ended.
    pub reads: u32,
    pub stale: u32,
    /// Something the firmware did wrong, for the circuit's warnings.
    pub warning: Option<String>,
}

impl Thermocouple {
    pub fn new(chip: TcChip) -> Self {
        Self {
            chip,
            hot: 25.0,
            cold: 25.0,
            reversed: false,
            fault: ProbeFault::None,
            powered: false,
            result: 0,
            fresh: false,
            converting: None,
            since: 0.0,
            reading: None,
            clocked: false,
            stale_note: None,
            last_sck: None,
            last_cs: None,
            reads: 0,
            stale: 0,
            warning: None,
        }
    }

    /// The same chip and probe after a power cycle.
    pub fn power_cycled(&self) -> Self {
        Self {
            hot: self.hot,
            cold: self.cold,
            reversed: self.reversed,
            fault: self.fault,
            ..Self::new(self.chip)
        }
    }

    /// The thermocouple's voltage at the chip's input (mV).
    pub fn voltage_mv(&self) -> f64 {
        let v = type_k_mv(self.hot) - type_k_mv(self.cold);
        if self.reversed {
            -v
        } else {
            v
        }
    }

    /// What a conversion now gives.
    pub fn measure(&self) -> u32 {
        let t = self.cold + self.voltage_mv() / self.chip.gain_mv();
        match self.chip {
            TcChip::Max6675 => {
                // T− is grounded on the module, so a probe touching ground
                // reads as usual; the open-input detector (T+ pulled up)
                // also trips when it touches the supply, and the ADC is at
                // full scale then.
                let open = matches!(self.fault, ProbeFault::Open | ProbeFault::ShortVcc);
                let code = if open {
                    0xFFF
                } else {
                    (t * 4.0).round().clamp(0.0, 4095.0) as u32
                };
                code << 3 | (open as u32) << 2
            }
            TcChip::Max31855 => {
                // A faulty input leaves the ADC saturated: up when it is
                // open or at VCC, down when it is at ground.
                let (hot, bits) = match self.fault {
                    ProbeFault::None => ((t * 4.0).round().clamp(-8192.0, 8191.0) as i32, 0),
                    ProbeFault::Open => (8191, 0b001),
                    ProbeFault::ShortGnd => (-8192, 0b010),
                    ProbeFault::ShortVcc => (8191, 0b100),
                };
                let cj = (self.cold * 16.0).round().clamp(-2048.0, 2047.0) as i32;
                ((hot as u32 & 0x3FFF) << 18)
                    | ((bits != 0) as u32) << 16
                    | ((cj as u32 & 0xFFF) << 4)
                    | bits
            }
        }
    }

    /// Bring the conversions (one after the other while CS is high) up to
    /// `now`.
    fn settle(&mut self, now: Seconds) {
        let conv = self.chip.conversion();
        if let Some(start) = self.converting {
            if now - start >= conv {
                self.result = self.measure();
                self.fresh = true;
                let done = ((now - start) / conv).floor();
                self.converting = Some(start + done * conv);
            }
        }
    }

    /// The word a read would give now (shown on the part).
    pub fn word(&mut self, now: Seconds) -> u32 {
        if self.reading.is_none() {
            self.settle(now);
        }
        self.result
    }

    /// The supply is (`on`) or is not enough: powering up starts a
    /// conversion, the result reads 0 until it ends.
    pub fn power(&mut self, now: Seconds, on: bool) {
        if on && !self.powered {
            *self = self.power_cycled();
            self.powered = true;
            self.converting = Some(now);
            self.since = now;
        } else if !on && self.powered {
            *self = self.power_cycled();
        }
    }

    /// CS falls (`low`) or rises.
    fn cs(&mut self, now: Seconds, low: bool) {
        if low {
            self.settle(now);
            self.stale_note = (!self.fresh).then(|| {
                let ms = (now - self.since) * 1e3;
                let after = if self.reads == 0 {
                    "power-up"
                } else {
                    "CS went high"
                };
                format!(
                    "read {ms:.0} ms after {after} — a conversion takes {:.0} ms and pulling CS low stops it, so the previous result is read again",
                    self.chip.conversion() * 1e3
                )
            });
            self.fresh = false;
            self.converting = None;
            self.reading = Some((self.result, 0));
            self.clocked = false;
        } else {
            self.reading = None;
            self.converting = Some(now);
            self.since = now;
        }
    }

    /// The first clock of a CS-low period: that is a read (CS going low
    /// alone, as the pins do while the MCU starts, is not).
    fn clock_in(&mut self) {
        if self.reading.is_some() && !self.clocked {
            self.clocked = true;
            self.reads += 1;
            if let Some(n) = self.stale_note.take() {
                self.stale += 1;
                self.warning = Some(n);
            }
        }
    }

    /// The levels of SCK and CS now (bit-banged or not): CS edges start
    /// and end a read, SCK falling edges move SO to the next bit.
    pub fn pins(&mut self, now: Seconds, sck: bool, cs: bool) {
        if !self.powered {
            return;
        }
        if self.last_cs != Some(cs) {
            if self.last_cs.is_some() || !cs {
                self.cs(now, !cs);
            }
            self.last_cs = Some(cs);
        }
        if self.last_sck.is_some_and(|l| l != sck) {
            self.clock_in();
        }
        if self.last_sck == Some(true) && !sck {
            if let Some((_, falls)) = &mut self.reading {
                *falls += 1;
            }
        }
        self.last_sck = Some(sck);
    }

    /// Bit `k` of a word as it leaves SO (MSB first); `None` past the end
    /// and on the MAX6675's three-state D0.
    fn bit(&self, word: u32, k: u32) -> Option<bool> {
        let n = self.chip.bits();
        if k >= n || (self.chip == TcChip::Max6675 && k == n - 1) {
            return None;
        }
        Some(word >> (n - 1 - k) & 1 != 0)
    }

    /// What the chip drives: 0 SO while CS is low, 1 the module's 3.3 V
    /// regulator output (MAX31855 3Vo).
    pub fn drive(&self, index: usize) -> Option<bool> {
        match index {
            0 => self.reading.and_then(|(w, k)| self.bit(w, k)),
            _ => self.powered.then_some(true),
        }
    }

    /// Eight SCK periods of hardware SPI at `hz` in mode (`cpol`, `cpha`):
    /// the byte the MCU samples (1 where SO is three-state). SO changes
    /// after each falling edge; data that is not valid yet (the SCK is too
    /// fast: the datasheet's maximum is what SO's delay and the MCU's
    /// setup time allow) or sampled on the wrong edge is read a bit off.
    pub fn exchange(&mut self, hz: f64, cpol: bool, cpha: bool) -> u8 {
        self.clock_in();
        let Some((word, falls)) = self.reading else {
            return 0xFF;
        };
        let period = 1.0 / hz.max(1.0);
        // Time from a falling edge until SO shows the next bit.
        let delay = 0.5 / self.chip.max_sck();
        let mut byte = 0u8;
        let mut off = false;
        for i in 0..8 {
            let g = falls + i;
            // Falling edges before the sample, and the time since the last.
            let (edges, dt) = match (cpol, cpha) {
                (false, false) => (g, period / 2.0),
                (false, true) | (true, false) => (g, period),
                (true, true) => (g + 1, period / 2.0),
            };
            let late = if dt >= delay {
                0
            } else {
                (((delay - dt) / period).floor() as u32 + 1).min(edges)
            };
            let k = edges - late;
            off |= k != g;
            byte = byte << 1 | self.bit(word, k).unwrap_or(true) as u8;
        }
        self.reading = Some((word, falls + 8));
        if off {
            let name = self.chip.name();
            self.warning = Some(if hz > self.chip.max_sck() {
                format!(
                    "SCK {:.2} MHz is faster than the {name}'s {} MHz — SO changes after each falling edge too late for the MCU to sample it, the bits are read one place off",
                    hz / 1e6,
                    self.chip.max_sck() / 1e6
                )
            } else {
                format!(
                    "read in SPI mode {} (CPOL {}, CPHA {}) — the {name} changes SO after SCK falling edges and is read in mode 0, so the first bit is lost",
                    (cpol as u8) << 1 | cpha as u8,
                    cpol as u8,
                    cpha as u8
                )
            });
        }
        byte
    }
}

/// MAX6675 word → (°C, thermocouple open).
pub fn decode_max6675(word: u16) -> (f64, bool) {
    ((word >> 3 & 0xFFF) as f64 * 0.25, word & 4 != 0)
}

/// MAX31855 word → (hot junction °C, cold junction °C, fault bits
/// SCV·SCG·OC).
pub fn decode_max31855(word: u32) -> (f64, f64, u8) {
    let hot = ((word as i32) >> 18) as f64 * 0.25;
    let cold = (((word << 16) as i32) >> 20) as f64 * 0.0625;
    (hot, cold, (word & 7) as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn type_k_matches_the_nist_table() {
        for (t, mv) in [
            (-200.0, -5.891),
            (-100.0, -3.554),
            (0.0, 0.0),
            (25.0, 1.000),
            (100.0, 4.096),
            (500.0, 20.644),
            (1000.0, 41.276),
            (1300.0, 52.410),
        ] {
            assert!(
                (type_k_mv(t) - mv).abs() < 0.0015,
                "{t} °C: {}",
                type_k_mv(t)
            );
        }
    }

    fn reading(chip: TcChip, hot: f64, cold: f64) -> Thermocouple {
        let mut t = Thermocouple::new(chip);
        t.power(0.0, true);
        (t.hot, t.cold) = (hot, cold);
        t
    }

    #[test]
    fn max6675_word_and_its_linear_error() {
        let t = reading(TcChip::Max6675, 100.0, 25.0);
        let (c, open) = decode_max6675(t.measure() as u16);
        assert!(!open);
        assert!((c - 100.5).abs() < 0.13, "{c}");
        // 41 µV/°C is close to type K up to 400 °C, high above it.
        let (c, _) = decode_max6675(reading(TcChip::Max6675, 700.0, 25.0).measure() as u16);
        assert!((c - 711.0).abs() < 0.5, "{c}");
        // Below 0 °C it reads 0; D15, D1 are 0.
        let w = reading(TcChip::Max6675, -20.0, 25.0).measure();
        assert_eq!(w, 0);
        let mut t = reading(TcChip::Max6675, 100.0, 25.0);
        t.fault = ProbeFault::Open;
        assert_eq!(t.measure(), 0x7FFC);
        // T− is grounded on the module: a grounded probe reads normally.
        t.fault = ProbeFault::ShortGnd;
        assert!(!decode_max6675(t.measure() as u16).1);
    }

    #[test]
    fn max31855_word_faults_and_reversed_probe() {
        let t = reading(TcChip::Max31855, 1000.0, 25.0);
        let (hot, cold, f) = decode_max31855(t.measure());
        // (41.276 − 1.000) mV / 41.276 µV/°C + 25 °C.
        assert!((hot - 1000.75).abs() < 0.2, "{hot}");
        assert_eq!((cold, f), (25.0, 0));
        let mut t = reading(TcChip::Max31855, -100.0, 22.3);
        let (hot, cold, _) = decode_max31855(t.measure());
        // The straight line is far off below 0 °C.
        assert!((hot + 85.4).abs() < 0.3, "{hot}");
        assert_eq!(cold, 22.3125);
        // Wires swapped: it goes down as the tip heats up.
        t.hot = 200.0;
        t.reversed = true;
        let (hot, _, _) = decode_max31855(t.measure());
        assert!((hot + 153.25).abs() < 0.3, "{hot}");
        for (fault, bits) in [
            (ProbeFault::Open, 1),
            (ProbeFault::ShortGnd, 2),
            (ProbeFault::ShortVcc, 4),
        ] {
            t.fault = fault;
            let w = t.measure();
            assert_eq!((w & 7, w >> 16 & 1), (bits, 1));
        }
    }

    /// CS low, `n` bytes at `hz` in `mode`, CS high.
    fn read(t: &mut Thermocouple, now: f64, n: usize, hz: f64, mode: u8) -> u32 {
        t.pins(now, mode >= 2, false);
        let w = (0..n).fold(0u32, |a, _| {
            a << 8 | t.exchange(hz, mode >= 2, mode & 1 != 0) as u32
        });
        t.pins(now + 1e-5, mode >= 2, true);
        w
    }

    #[test]
    fn reading_stops_the_conversion() {
        let mut t = Thermocouple::new(TcChip::Max6675);
        t.pins(0.0, false, true);
        t.power(0.0, true);
        t.pins(0.0, false, true);
        t.hot = 100.0;
        // Too early after power-up: 0, and a warning.
        assert_eq!(read(&mut t, 0.1, 2, 1e6, 0), 0x0001);
        assert!(t.warning.take().unwrap().contains("after power-up"));
        // 250 ms later: done.
        let w = read(&mut t, 0.35, 2, 1e6, 0);
        assert!((decode_max6675(w as u16).0 - 100.5).abs() < 0.3);
        assert!(t.warning.is_none());
        // Every 100 ms: each read stops the conversion, the value is stuck.
        t.hot = 200.0;
        assert_eq!(read(&mut t, 0.45, 2, 1e6, 0), w);
        assert!(t.warning.take().unwrap().contains("previous result"));
        assert_eq!(read(&mut t, 0.55, 2, 1e6, 0), w);
        assert_eq!(read(&mut t, 0.80, 2, 1e6, 0) >> 3, t.measure() >> 3);
        assert_eq!(t.stale, 3);
    }

    #[test]
    fn too_fast_or_wrong_mode_reads_bits_off() {
        let mut t = reading(TcChip::Max31855, 100.0, 25.0);
        t.pins(0.0, false, true);
        let good = read(&mut t, 0.2, 4, 5e6, 0);
        assert_eq!(good, t.measure());
        assert!(t.warning.is_none());
        // 5.25 MHz (84 MHz / 16): each bit arrives one clock late.
        let fast = read(&mut t, 0.4, 4, 5.25e6, 0);
        assert_eq!(fast, good >> 1);
        assert!(t.warning.take().unwrap().contains("faster than"));
        // Mode 1 at a slow clock still works; mode 3 loses D31.
        assert_eq!(read(&mut t, 0.6, 4, 1e6, 1), good);
        let m3 = read(&mut t, 0.8, 4, 1e6, 3);
        assert_eq!(m3, good << 1 | 1);
        assert!(t.warning.take().unwrap().contains("mode 3"));
        // The MAX6675 is slower: 5 MHz is already too fast.
        let mut m = reading(TcChip::Max6675, 100.0, 25.0);
        m.pins(0.0, false, true);
        let ok = read(&mut m, 0.3, 2, 4.2e6, 0);
        assert_eq!(ok, m.measure() | 1);
        assert_ne!(read(&mut m, 0.6, 2, 5.25e6, 0), ok);
    }

    #[test]
    fn bit_banged_read_follows_sck_falling_edges() {
        let mut t = reading(TcChip::Max6675, 300.0, 25.0);
        t.pins(0.0, false, true);
        t.pins(0.3, false, false);
        let mut w = 0u32;
        for i in 0..16 {
            let now = 0.3 + i as f64 * 1e-6;
            t.pins(now, true, false);
            // Sampled on the rising edge: D15 first; D0 is three-state.
            w = w << 1 | t.drive(0).unwrap_or(true) as u32;
            t.pins(now + 5e-7, false, false);
        }
        assert_eq!(w, t.measure() | 1);
        t.pins(0.31, false, true);
        assert_eq!(t.drive(0), None);
    }
}
