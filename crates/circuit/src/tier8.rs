//! Tier 8 parts (M19): the 74HC595 shift register, the TM1637 display
//! driver, the HC-SR501 PIR motion sensor and the BMP280 pressure sensor.
//!
//! The 74HC595 and the TM1637 watch their pins edge by edge (bit-banged
//! GPIO; the 595 also takes hardware SPI bytes), the PIR runs on its own
//! timers and the BMP280 is an I2C register file whose raw readings are
//! the datasheet's compensation formulas run backwards.

use crate::devices::{I2cDevice, Seconds};

// ------------------------------------------------------------ 74HC595

/// 74HC595 8-bit serial-in, parallel-out shift register with output
/// latch. DS is shifted into Q0 on a SHCP (SRCLK) rising edge while MR
/// is high, everything moving one stage on and stage 7 appearing on Q7';
/// the shift register is copied to the outputs on a STCP (RCLK) rising
/// edge; OE high puts Q0–Q7 into high impedance (Q7' stays driven).
#[derive(Debug, Clone, Default)]
pub struct Hc595 {
    /// The shift register, bit n = stage n (Q0 is bit 0).
    pub shift: u8,
    /// The storage register on Q0–Q7.
    pub latch: u8,
    last_sh: Option<bool>,
    last_st: Option<bool>,
    /// Clock edges and latches so far.
    pub shifts: u32,
    pub latches: u32,
    /// Powered, and OE low (Q0–Q7 drive), as last seen.
    pub powered: bool,
    pub enabled: bool,
}

impl Hc595 {
    /// The level on Q7': stage 7 of the shift register.
    pub fn q7s(&self) -> bool {
        self.shift & 0x80 != 0
    }

    /// One SHCP rising edge with `ds` on DS. Returns the bit that left
    /// stage 7 (what a chip chained on Q7' takes on the same edge).
    pub fn shift_bit(&mut self, ds: bool) -> bool {
        let out = self.q7s();
        self.shift = self.shift << 1 | ds as u8;
        self.shifts += 1;
        out
    }

    /// Eight SHCP edges, MSB first (one SPI byte): the first bit ends up
    /// on Q7, so bit n of `b` lands on Qn. Returns the eight bits that
    /// left on Q7' meanwhile, first one in the MSB.
    pub fn byte(&mut self, b: u8) -> u8 {
        let mut out = 0;
        for i in (0..8).rev() {
            out = out << 1 | self.shift_bit(b >> i & 1 != 0) as u8;
        }
        out
    }

    /// STCP rising edge: the outputs take the shift register.
    pub fn store(&mut self) {
        self.latch = self.shift;
        self.latches += 1;
    }

    /// The levels on SHCP, STCP, DS and MR now. Both clocks rising
    /// together latch the register as it was before the shift (the
    /// storage register is then one clock behind, as the datasheet says).
    pub fn pins(&mut self, sh: bool, st: bool, ds: bool, mr: bool) {
        if !mr {
            self.shift = 0;
        }
        if self.last_st == Some(false) && st {
            self.store();
        }
        if self.last_sh == Some(false) && sh && mr {
            self.shift_bit(ds);
        }
        self.last_sh = Some(sh);
        self.last_st = Some(st);
    }
}

// ------------------------------------------------------------- TM1637

/// What the TM1637 is in the middle of.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum TmState {
    /// Between a STOP and the next START.
    #[default]
    Idle,
    /// After a START: `bits` of the current byte so far (8 = waiting for
    /// the ACK clock), `first` = the byte is the command byte.
    Byte { bits: u8, value: u8, first: bool },
}

/// TM1637 LED driver with key scan (here: the 4-digit display module).
/// Two-wire protocol, not I2C: START is DIO falling while CLK is high,
/// STOP DIO rising while CLK is high, bits LSB first sampled on the CLK
/// rising edge, and after the eighth bit the chip pulls DIO low (ACK)
/// from the eighth falling edge to the ninth.
#[derive(Debug, Clone, Default)]
pub struct Tm1637 {
    /// Display RAM 0xC0–0xC5, one segment byte per digit (bit 0 = a …
    /// bit 6 = g, bit 7 = dp or the colon on digit 1).
    pub ram: [u8; 6],
    /// Display control: bit 3 on, bits 0–2 pulse width (brightness).
    pub control: u8,
    addr: u8,
    fixed: bool,
    /// The last command was an address command: data bytes follow.
    data_follows: bool,
    state: TmState,
    last_clk: Option<bool>,
    last_dio: Option<bool>,
    /// Pulling DIO low for the ACK.
    pub ack: bool,
    /// The last CLK edge (s).
    last_edge: Option<Seconds>,
    /// Bytes acknowledged so far.
    pub bytes: u32,
    /// Something the firmware did wrong, for a warning.
    pub warning: Option<String>,
}

/// Shortest CLK high or low time accepted (the TM1637 is specified up to
/// 250 kHz with a 50 % duty: 2 µs; somewhat faster still works).
pub const TM1637_MIN_HALF: Seconds = 1e-6;

impl Tm1637 {
    pub fn new() -> Self {
        Self::default()
    }

    /// Display on (control bit 3).
    pub fn on(&self) -> bool {
        self.control & 0x08 != 0
    }

    /// Brightness 0–7 (pulse width 1/16 … 14/16).
    pub fn brightness(&self) -> u8 {
        self.control & 7
    }

    fn warn(&mut self, w: String) {
        self.warning.get_or_insert(w);
    }

    fn command(&mut self, b: u8) {
        self.data_follows = false;
        match b {
            0x40..=0x4F => {
                if b & 0x02 != 0 {
                    self.warn(format!(
                        "TM1637: command 0x{b:02X} reads the keys — key scan is not simulated (DIO stays high)"
                    ));
                }
                self.fixed = b & 0x04 != 0;
            }
            0x80..=0x8F => self.control = b,
            0xC0..=0xC5 => {
                self.addr = b - 0xC0;
                self.data_follows = true;
            }
            _ => {
                let rev = b.reverse_bits();
                let valid = |c: u8| matches!(c, 0x40..=0x4F | 0x80..=0x8F | 0xC0..=0xC5);
                if valid(rev) {
                    self.warn(format!(
                        "TM1637: unknown command 0x{b:02X} — sent MSB first? Reversed it is 0x{rev:02X}: the TM1637 takes bits LSB first"
                    ));
                } else {
                    self.warn(format!(
                        "TM1637: unknown command 0x{b:02X} (data 0x40/0x44, address 0xC0–0xC3, display 0x80–0x8F)"
                    ));
                }
            }
        }
    }

    fn data(&mut self, b: u8) {
        if !self.data_follows {
            self.warn(format!(
                "TM1637: data byte 0x{b:02X} without an address command (0xC0–0xC5) before it in this transfer"
            ));
            return;
        }
        self.ram[self.addr as usize % 6] = b;
        if !self.fixed {
            self.addr = (self.addr + 1) % 6;
        }
    }

    /// The levels of CLK and DIO now (DIO as seen on the line).
    pub fn pins(&mut self, now: Seconds, clk: bool, dio: bool) {
        let (Some(lc), Some(ld)) = (self.last_clk, self.last_dio) else {
            self.last_clk = Some(clk);
            self.last_dio = Some(dio);
            return;
        };
        if lc != clk {
            if let Some(t) = self.last_edge {
                let half = now - t;
                if half < TM1637_MIN_HALF && self.state != TmState::Idle {
                    self.warn(format!(
                        "TM1637: CLK {} for only {:.2} µs — keep each half period at least 2 µs (≤ 250 kHz)",
                        if lc { "high" } else { "low" },
                        half * 1e6
                    ));
                }
            }
            self.last_edge = Some(now);
        }
        // Our own ACK on DIO is not the controller's doing.
        let dio_changed = ld != dio && !self.ack;
        if lc && clk && dio_changed {
            if !dio {
                // START
                if let TmState::Byte { bits: 2..=8, .. } = self.state {
                    self.warn("TM1637: START in the middle of a byte — DIO changed while CLK was high (change DIO only while CLK is low)".into());
                }
                self.state = TmState::Byte {
                    bits: 0,
                    value: 0,
                    first: true,
                };
                self.data_follows = false;
            } else {
                // STOP
                // The clock that leads into a STOP samples one bit: fine.
                if let TmState::Byte { bits: 2..=8, .. } = self.state {
                    self.warn("TM1637: STOP in the middle of a byte — DIO changed while CLK was high (change DIO only while CLK is low)".into());
                }
                self.state = TmState::Idle;
            }
        } else if !lc && clk {
            // Rising edge: sample a data bit.
            if let TmState::Byte { bits, value, first } = self.state {
                if bits < 8 {
                    self.state = TmState::Byte {
                        bits: bits + 1,
                        value: value | (dio as u8) << bits,
                        first,
                    };
                }
            }
        } else if lc && !clk {
            // Falling edge: the eighth one starts the ACK, the ninth ends it.
            if self.ack {
                self.ack = false;
                if matches!(self.state, TmState::Byte { .. }) {
                    self.state = TmState::Byte {
                        bits: 0,
                        value: 0,
                        first: false,
                    };
                }
            } else if let TmState::Byte {
                bits: 8,
                value,
                first,
            } = self.state
            {
                self.ack = true;
                self.bytes += 1;
                if first {
                    self.command(value);
                } else {
                    self.data(value);
                }
            }
        }
        self.last_clk = Some(clk);
        self.last_dio = Some(dio);
    }
}

// ----------------------------------------------------------- HC-SR501

/// After the output goes low the BISS0001 ignores motion this long.
pub const PIR_BLOCK: Seconds = 2.5;
/// Lowest supply of the HC-SR501 (its regulator needs 4.5–20 V).
pub const PIR_VMIN: f64 = 4.5;

/// HC-SR501 PIR motion sensor: OUT goes high (3.3 V) on motion for
/// `delay` seconds — in retrigger mode (H) counted from the end of the
/// motion, in single mode (L) from its start — and then stays low for
/// [`PIR_BLOCK`] whatever happens. For `warmup` seconds after power-up
/// it sees nothing.
#[derive(Debug, Clone)]
pub struct Pir {
    pub retrigger: bool,
    pub delay: Seconds,
    pub warmup: Seconds,
    /// Since when it is powered.
    powered_at: Option<Seconds>,
    /// Something moves in its field of view now, since then.
    pub motion: bool,
    motion_since: Seconds,
    pub out: bool,
    high_until: Seconds,
    block_until: Seconds,
    /// Times OUT went high.
    pub triggers: u32,
}

impl Pir {
    pub fn new(retrigger: bool, delay: Seconds, warmup: Seconds) -> Self {
        Self {
            retrigger,
            delay,
            warmup,
            powered_at: None,
            motion: false,
            motion_since: 0.0,
            out: false,
            high_until: 0.0,
            block_until: f64::NEG_INFINITY,
            triggers: 0,
        }
    }

    pub fn powered(&self) -> bool {
        self.powered_at.is_some()
    }

    /// Still warming up at `now` (or unpowered).
    pub fn warming(&self, now: Seconds) -> bool {
        self.powered_at.is_none_or(|t| now < t + self.warmup)
    }

    /// Blocked after the last pulse at `now`.
    pub fn blocked(&self, now: Seconds) -> bool {
        !self.out && now < self.block_until
    }

    fn trigger(&mut self, t: Seconds) {
        self.out = true;
        self.triggers += 1;
        self.high_until = if self.retrigger && self.motion {
            f64::INFINITY
        } else {
            t + self.delay
        };
    }

    /// When OUT next changes by itself.
    pub fn next(&self) -> Option<Seconds> {
        let on = self.powered_at? + self.warmup;
        if self.out {
            self.high_until.is_finite().then_some(self.high_until)
        } else if self.motion {
            Some(on.max(self.block_until).max(self.motion_since))
        } else {
            None
        }
    }

    pub fn advance(&mut self, now: Seconds) {
        while let Some(t) = self.next() {
            if t > now + 1e-12 {
                break;
            }
            if self.out {
                self.out = false;
                self.block_until = t + PIR_BLOCK;
            } else {
                self.trigger(t);
            }
        }
    }

    /// The supply came or went at `now`.
    pub fn power(&mut self, now: Seconds, on: bool) {
        self.advance(now);
        if on == self.powered() {
            return;
        }
        self.powered_at = on.then_some(now);
        self.out = false;
        self.block_until = f64::NEG_INFINITY;
    }

    /// Motion started or stopped at `now`.
    pub fn set_motion(&mut self, now: Seconds, motion: bool) {
        self.advance(now);
        if motion == self.motion {
            return;
        }
        self.motion = motion;
        self.motion_since = now;
        if self.out && self.retrigger {
            self.high_until = if motion {
                f64::INFINITY
            } else {
                now + self.delay
            };
        }
        self.advance(now);
    }

    /// New settings from the inspector (an output pulse running keeps its
    /// end unless the motion is still going on in retrigger mode).
    pub fn configure(&mut self, now: Seconds, retrigger: bool, delay: Seconds, warmup: Seconds) {
        self.advance(now);
        self.retrigger = retrigger;
        self.delay = delay;
        self.warmup = warmup;
        if self.out && !(retrigger && self.motion) && !self.high_until.is_finite() {
            self.high_until = now + delay;
        }
        self.advance(now);
    }
}

// ------------------------------------------------------------- BMP280

/// Trimming values of the datasheet's compensation example (BST-BMP280-
/// DS001 §3.12): dig_T1–T3, dig_P1–P9.
pub const BMP280_TRIM_T: (u16, i16, i16) = (27504, 26435, -1000);
pub const BMP280_TRIM_P: (u16, [i16; 8]) =
    (36477, [-10685, 3024, 2855, 140, -7, 15500, -14600, 6000]);

/// Datasheet 32-bit integer temperature compensation: (t_fine, °C·100).
pub fn bmp280_t_fine(adc_t: i32) -> (i32, i32) {
    let (t1, t2, t3) = (
        BMP280_TRIM_T.0 as i32,
        BMP280_TRIM_T.1 as i32,
        BMP280_TRIM_T.2 as i32,
    );
    let var1 = (((adc_t >> 3) - (t1 << 1)) * t2) >> 11;
    let var2 = (((((adc_t >> 4) - t1) * ((adc_t >> 4) - t1)) >> 12) * t3) >> 14;
    let t_fine = var1 + var2;
    (t_fine, (t_fine * 5 + 128) >> 8)
}

/// Datasheet 64-bit integer pressure compensation: Pa in Q24.8.
pub fn bmp280_pressure(adc_p: i32, t_fine: i32) -> u32 {
    let p1 = BMP280_TRIM_P.0 as i64;
    let [p2, p3, p4, p5, p6, p7, p8, p9] = BMP280_TRIM_P.1.map(|v| v as i64);
    let mut var1 = t_fine as i64 - 128000;
    let mut var2 = var1 * var1 * p6;
    var2 += (var1 * p5) << 17;
    var2 += p4 << 35;
    var1 = ((var1 * var1 * p3) >> 8) + ((var1 * p2) << 12);
    var1 = (((1i64 << 47) + var1) * p1) >> 33;
    if var1 == 0 {
        return 0;
    }
    let mut p = 1_048_576 - adc_p as i64;
    p = (((p << 31) - var2) * 3125) / var1;
    let var1 = (p9 * (p >> 13) * (p >> 13)) >> 25;
    let var2 = (p8 * p) >> 19;
    (((p + var1 + var2) >> 8) + (p7 << 4)) as u32
}

/// Over-sampling factor of an osrs_x setting (0 = skipped).
fn oversampling(osrs: u8) -> u32 {
    match osrs & 7 {
        0 => 0,
        1 => 1,
        2 => 2,
        3 => 4,
        4 => 8,
        _ => 16,
    }
}

/// Steps of the 20-bit raw value at an over-sampling setting: 16 bits at
/// ×1, one more bit per doubling up to 20 bits at ×16.
fn raw_step(osrs: u8) -> i32 {
    match oversampling(osrs) {
        1 => 16,
        2 => 8,
        4 => 4,
        8 => 2,
        _ => 1,
    }
}

/// The raw value (a multiple of `step`) whose compensated result `f` is
/// closest to `target`; `f` rises with the raw value if `rising`.
fn invert(step: i32, rising: bool, target: f64, f: impl Fn(i32) -> f64) -> i32 {
    let n = (1 << 20) / step;
    let below = |k: i32| {
        let v = f(k * step);
        if rising {
            v < target
        } else {
            v > target
        }
    };
    // The first raw value at or past the target…
    let (mut lo, mut hi) = (0, n - 1);
    while lo < hi {
        let mid = (lo + hi) / 2;
        if below(mid) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    // …or the one before it, whichever comes nearer.
    (lo - 1..=lo)
        .filter(|k| (0..n).contains(k))
        .min_by(|&a, &b| {
            (f(a * step) - target)
                .abs()
                .total_cmp(&(f(b * step) - target).abs())
        })
        .unwrap_or(lo)
        * step
}

/// BMP280 barometric pressure and temperature sensor on I2C (0x76 with
/// SDO low, 0x77 high). Registers: 0x88–0x9F trimming, 0xD0 chip id
/// 0x58, 0xE0 reset (0xB6), 0xF3 status, 0xF4 ctrl_meas (osrs_t, osrs_p,
/// mode), 0xF5 config, 0xF7–0xFC raw pressure and temperature (20 bits
/// each, MSB first). The IIR filter and the standby time are not
/// modelled: in normal mode a read gives the present values.
#[derive(Debug, Clone)]
pub struct Bmp280 {
    pub address: u8,
    /// What it measures (°C, Pa).
    pub temp: f64,
    pub pressure: f64,
    pub ctrl_meas: u8,
    pub config: u8,
    /// The raw readings in 0xF7–0xFC (0x80000 = skipped / none yet).
    raw_p: i32,
    raw_t: i32,
    /// A forced measurement is running until then.
    busy_until: Option<Seconds>,
    /// Register pointer, and whether the next written byte is one.
    ptr: u8,
    expect_reg: bool,
    /// Conversions finished so far.
    pub measurements: u32,
    pub warning: Option<String>,
}

impl Bmp280 {
    pub const CHIP_ID: u8 = 0x58;

    pub fn new(address: u8, temp: f64, pressure: f64) -> Self {
        Self {
            address,
            temp,
            pressure,
            ctrl_meas: 0,
            config: 0,
            raw_p: 0x80000,
            raw_t: 0x80000,
            busy_until: None,
            ptr: 0,
            expect_reg: true,
            measurements: 0,
            warning: None,
        }
    }

    fn mode(&self) -> u8 {
        self.ctrl_meas & 3
    }

    /// Conversion time of the present settings (datasheet typical).
    pub fn measure_time(&self) -> Seconds {
        let ost = oversampling(self.ctrl_meas >> 5) as f64;
        let osp = oversampling(self.ctrl_meas >> 2) as f64;
        (1.25 + 2.3 * ost + if osp > 0.0 { 2.3 * osp + 0.575 } else { 0.0 }) * 1e-3
    }

    /// The raw ADC values that the compensation turns into the present
    /// temperature and pressure, at the configured resolution.
    pub fn raw(&self) -> (i32, i32) {
        let (osrs_t, osrs_p) = (self.ctrl_meas >> 5 & 7, self.ctrl_meas >> 2 & 7);
        let t = self.temp.clamp(-40.0, 85.0);
        let adc_t = invert(raw_step(osrs_t.max(1)), true, t * 100.0, |a| {
            bmp280_t_fine(a).0 as f64 * 100.0 / 5120.0
        });
        let t_fine = bmp280_t_fine(adc_t).0;
        let adc_t = if osrs_t == 0 { 0x80000 } else { adc_t };
        // Aim half a pascal up: firmware usually truncates the Q24.8 result.
        let p = self.pressure.clamp(30_000.0, 110_000.0) * 256.0 + 128.0;
        let adc_p = if osrs_p == 0 {
            0x80000
        } else {
            invert(raw_step(osrs_p), false, p, |a| {
                bmp280_pressure(a, t_fine) as f64
            })
        };
        (adc_t, adc_p)
    }

    fn finish(&mut self, now: Seconds) {
        if self.busy_until.is_some_and(|t| now >= t) {
            self.busy_until = None;
            (self.raw_t, self.raw_p) = self.raw();
            self.measurements += 1;
            // Forced mode: back to sleep.
            if self.mode() == 1 || self.mode() == 2 {
                self.ctrl_meas &= !3;
            }
        }
        if self.mode() == 3 && self.busy_until.is_none() {
            (self.raw_t, self.raw_p) = self.raw();
        }
    }

    fn reg(&mut self, r: u8, now: Seconds) -> u8 {
        self.finish(now);
        let trim: [u8; 24] = {
            let (t1, t2, t3) = BMP280_TRIM_T;
            let (p1, p) = BMP280_TRIM_P;
            let mut b = [0u8; 24];
            b[0..2].copy_from_slice(&t1.to_le_bytes());
            b[2..4].copy_from_slice(&t2.to_le_bytes());
            b[4..6].copy_from_slice(&t3.to_le_bytes());
            b[6..8].copy_from_slice(&p1.to_le_bytes());
            for (i, v) in p.iter().enumerate() {
                b[8 + 2 * i..10 + 2 * i].copy_from_slice(&v.to_le_bytes());
            }
            b
        };
        let busy = self.busy_until.is_some();
        match r {
            0x88..=0x9F => trim[(r - 0x88) as usize],
            0xD0 => Self::CHIP_ID,
            0xE0 => 0,
            0xF3 => (busy as u8) << 3,
            0xF4 => self.ctrl_meas,
            0xF5 => self.config,
            0xF7..=0xFC => {
                if self.measurements == 0 && self.mode() == 0 && !busy {
                    self.warning.get_or_insert_with(|| {
                        "BMP280: data read before any measurement — ctrl_meas (0xF4) is in sleep mode; set forced (01) or normal (11) mode".into()
                    });
                }
                let (p, t) = (self.raw_p, self.raw_t);
                match r {
                    0xF7 => (p >> 12) as u8,
                    0xF8 => (p >> 4) as u8,
                    0xF9 => ((p & 0xF) << 4) as u8,
                    0xFA => (t >> 12) as u8,
                    0xFB => (t >> 4) as u8,
                    _ => ((t & 0xF) << 4) as u8,
                }
            }
            _ => 0,
        }
    }

    fn write_reg(&mut self, r: u8, v: u8, now: Seconds) {
        self.finish(now);
        match r {
            0xE0 if v == 0xB6 => *self = Self::new(self.address, self.temp, self.pressure),
            0xF4 => {
                self.ctrl_meas = v;
                if v & 3 != 0 {
                    self.busy_until = Some(now + self.measure_time());
                }
            }
            0xF5 => self.config = v,
            _ => {}
        }
    }
}

impl I2cDevice for Bmp280 {
    fn address(&self) -> u8 {
        self.address
    }
    fn start(&mut self, _read: bool, _now: Seconds) {
        self.expect_reg = true;
    }
    fn write(&mut self, b: u8, now: Seconds) -> bool {
        // Writes come in (register, value) pairs.
        if self.expect_reg {
            self.ptr = b;
        } else {
            self.write_reg(self.ptr, b, now);
        }
        self.expect_reg = !self.expect_reg;
        true
    }
    fn read(&mut self, now: Seconds) -> u8 {
        let v = self.reg(self.ptr, now);
        self.ptr = self.ptr.wrapping_add(1);
        v
    }
    fn stop(&mut self, now: Seconds) {
        self.finish(now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hc595_shifts_on_srclk_and_latches_on_rclk() {
        let mut s = Hc595::default();
        s.pins(false, false, false, true);
        // Bit-bang 0b1010_0001, MSB first.
        for i in (0..8).rev() {
            let bit = 0xA1u8 >> i & 1 != 0;
            s.pins(false, false, bit, true);
            s.pins(true, false, bit, true);
        }
        assert_eq!(s.shift, 0xA1);
        assert_eq!(s.latch, 0, "outputs change only on RCLK");
        s.pins(false, true, false, true);
        assert_eq!(s.latch, 0xA1);
        assert!(s.q7s());
        // MR low clears the shift register, not the outputs.
        s.pins(false, true, false, false);
        assert_eq!((s.shift, s.latch), (0, 0xA1));
        // No shift while MR is low.
        s.pins(true, true, true, false);
        assert_eq!(s.shift, 0);
    }

    #[test]
    fn hc595_with_tied_clocks_latches_one_behind() {
        let mut s = Hc595::default();
        s.pins(false, false, true, true);
        s.pins(true, true, true, true);
        assert_eq!((s.shift, s.latch), (1, 0));
        s.pins(false, false, true, true);
        s.pins(true, true, true, true);
        assert_eq!((s.shift, s.latch), (3, 1));
    }

    #[test]
    fn hc595_spi_byte_and_cascade_overflow() {
        let mut a = Hc595::default();
        let mut b = Hc595::default();
        // Two bytes for a two-chip chain: the first sent ends in the far one.
        for byte in [0x0F, 0x81] {
            let out = a.byte(byte);
            b.byte(out);
        }
        a.store();
        b.store();
        assert_eq!((a.latch, b.latch), (0x81, 0x0F));
    }

    /// Bit-bangs a TM1637 transfer: START, the bytes LSB first with an
    /// ACK clock each, STOP. Returns the DIO level the controller saw in
    /// each ACK clock.
    fn tm_transfer(tm: &mut Tm1637, t: &mut f64, bytes: &[u8], lsb_first: bool) -> Vec<bool> {
        let half = 5e-6;
        let mut step = |tm: &mut Tm1637, clk, dio| {
            *t += half;
            tm.pins(*t, clk, dio && !tm.ack);
        };
        step(tm, true, true);
        step(tm, true, false); // START
        let mut acks = Vec::new();
        for &b in bytes {
            for i in 0..8 {
                let bit = if lsb_first {
                    b >> i & 1
                } else {
                    b >> (7 - i) & 1
                } != 0;
                step(tm, false, bit);
                step(tm, true, bit);
            }
            step(tm, false, true); // eighth falling edge: the chip pulls DIO
            acks.push(!tm.ack);
            step(tm, true, true);
            step(tm, false, false); // ninth falling edge: released
        }
        step(tm, true, false);
        step(tm, true, true); // STOP
        acks
    }

    #[test]
    fn tm1637_takes_commands_lsb_first_and_acks_each_byte() {
        let mut tm = Tm1637::new();
        let mut t = 0.0;
        tm.pins(t, true, true);
        assert_eq!(tm_transfer(&mut tm, &mut t, &[0x40], true), [false]);
        let acks = tm_transfer(&mut tm, &mut t, &[0xC0, 0x06, 0xDB, 0x4F, 0x66], true);
        assert_eq!(acks, [false; 5], "ACK is DIO low");
        tm_transfer(&mut tm, &mut t, &[0x8A], true);
        assert_eq!(&tm.ram[..4], &[0x06, 0xDB, 0x4F, 0x66]);
        assert!(tm.on());
        assert_eq!(tm.brightness(), 2);
        assert!(tm.warning.is_none(), "{:?}", tm.warning);
        assert_eq!(tm.bytes, 7);
        assert!(!tm.ack, "DIO released after the ninth clock");

        // Fixed address mode writes one digit.
        tm_transfer(&mut tm, &mut t, &[0x44], true);
        tm_transfer(&mut tm, &mut t, &[0xC2, 0x3F], true);
        assert_eq!(tm.ram[2], 0x3F);
        assert_eq!(tm.ram[3], 0x66);
        tm_transfer(&mut tm, &mut t, &[0x80], true);
        assert!(!tm.on());
    }

    #[test]
    fn tm1637_warns_about_msb_first_and_fast_clocks() {
        let mut tm = Tm1637::new();
        let mut t = 0.0;
        tm.pins(t, true, true);
        tm_transfer(&mut tm, &mut t, &[0x40], false);
        let w = tm.warning.take().unwrap();
        assert!(w.contains("0x02") && w.contains("LSB first"), "{w}");

        // A data byte without an address.
        tm_transfer(&mut tm, &mut t, &[0x40, 0x12], true);
        assert!(tm.warning.take().unwrap().contains("without an address"));

        // A clock far too fast.
        let mut fast = Tm1637::new();
        let mut t = 0.0;
        fast.pins(t, true, true);
        t += 1e-6;
        fast.pins(t, true, false);
        for _ in 0..3 {
            t += 0.1e-6;
            fast.pins(t, false, false);
            t += 0.1e-6;
            fast.pins(t, true, false);
        }
        assert!(fast.warning.unwrap().contains("CLK"));
    }

    #[test]
    fn tm1637_without_ack_clock_does_not_take_the_byte() {
        let mut tm = Tm1637::new();
        let mut t = 0.0;
        tm.pins(t, true, true);
        t += 1e-5;
        tm.pins(t, true, false);
        // Seven bits only, then STOP.
        for _ in 0..7 {
            t += 1e-5;
            tm.pins(t, false, false);
            t += 1e-5;
            tm.pins(t, true, false);
        }
        t += 1e-5;
        tm.pins(t, true, true);
        assert_eq!(tm.bytes, 0);
        assert!(tm.warning.unwrap().contains("STOP in the middle"));
    }

    #[test]
    fn pir_retrigger_holds_until_delay_after_the_motion() {
        let mut p = Pir::new(true, 3.0, 2.0);
        p.power(0.0, true);
        // Motion during the warm-up is ignored…
        p.set_motion(0.5, true);
        p.advance(1.9);
        assert!(!p.out);
        // …until it is over.
        p.advance(2.0);
        assert!(p.out);
        p.set_motion(4.0, false);
        p.advance(6.9);
        assert!(p.out, "high until 3 s after the motion ended");
        p.advance(7.0);
        assert!(!p.out);
        // Blocked for 2.5 s.
        p.set_motion(8.0, true);
        assert!(!p.out);
        assert_eq!(p.next(), Some(9.5));
        p.advance(9.5);
        assert!(p.out);
        assert_eq!(p.triggers, 2);
    }

    #[test]
    fn pir_single_mode_ends_after_the_delay_while_motion_goes_on() {
        let mut p = Pir::new(false, 3.0, 0.0);
        p.power(0.0, true);
        p.set_motion(1.0, true);
        assert!(p.out);
        p.advance(3.9);
        assert!(p.out);
        p.advance(4.0);
        assert!(!p.out, "single: 3 s from the start");
        // Motion still there: again after the block time.
        p.advance(6.4);
        assert!(!p.out);
        p.advance(6.5);
        assert!(p.out);
        // Unpowered: nothing.
        p.power(7.0, false);
        assert!(!p.out);
        assert_eq!(p.next(), None);
    }

    #[test]
    fn bmp280_compensation_matches_the_datasheet_example() {
        let (t_fine, t) = bmp280_t_fine(519888);
        assert_eq!(t, 2508);
        let p = bmp280_pressure(415148, t_fine);
        assert!(
            (p as f64 / 256.0 - 100653.27).abs() < 0.05,
            "{}",
            p as f64 / 256.0
        );
    }

    fn read_regs(b: &mut Bmp280, reg: u8, n: usize, now: f64) -> Vec<u8> {
        b.start(false, now);
        b.write(reg, now);
        b.start(true, now);
        let v = (0..n).map(|_| b.read(now)).collect();
        b.stop(now);
        v
    }

    fn write_reg(b: &mut Bmp280, reg: u8, v: u8, now: f64) {
        b.start(false, now);
        b.write(reg, now);
        b.write(v, now);
        b.stop(now);
    }

    #[test]
    fn bmp280_forced_measurement_returns_the_configured_values() {
        let mut b = Bmp280::new(0x76, 21.5, 95_000.0);
        assert_eq!(read_regs(&mut b, 0xD0, 1, 0.0), [0x58]);
        let trim = read_regs(&mut b, 0x88, 24, 0.0);
        assert_eq!(u16::from_le_bytes([trim[0], trim[1]]), 27504);
        assert_eq!(i16::from_le_bytes([trim[22], trim[23]]), 6000);
        // Sleep: reset values, and a warning.
        assert_eq!(read_regs(&mut b, 0xF7, 6, 0.0), [0x80, 0, 0, 0x80, 0, 0]);
        assert!(b.warning.take().is_some());

        // Forced, T ×2, P ×16: busy, then the data, then back to sleep.
        write_reg(&mut b, 0xF4, 0x55, 0.010); // T ×2, P ×16, forced
        assert_eq!(read_regs(&mut b, 0xF3, 1, 0.011), [0x08]);
        let t_end = 0.010 + b.measure_time();
        assert_eq!(read_regs(&mut b, 0xF3, 1, t_end + 1e-4), [0x00]);
        assert_eq!(read_regs(&mut b, 0xF4, 1, t_end + 1e-4)[0] & 3, 0);
        let d = read_regs(&mut b, 0xF7, 6, t_end + 1e-4);
        let adc_p = (d[0] as i32) << 12 | (d[1] as i32) << 4 | (d[2] as i32) >> 4;
        let adc_t = (d[3] as i32) << 12 | (d[4] as i32) << 4 | (d[5] as i32) >> 4;
        assert_eq!(adc_t % 8, 0, "17-bit temperature at ×2");
        let (t_fine, t) = bmp280_t_fine(adc_t);
        assert!((t as f64 / 100.0 - 21.5).abs() <= 0.05, "{t}");
        let p = bmp280_pressure(adc_p, t_fine) as f64 / 256.0;
        assert!((p - 95_000.0).abs() < 0.5, "{p}");
        assert!(b.warning.is_none());

        // Pressure skipped: 0x80000.
        b.pressure = 101_325.0;
        write_reg(&mut b, 0xF4, 0x21, 1.0); // T ×1, P skipped, forced
        let d = read_regs(&mut b, 0xF7, 3, 1.1);
        assert_eq!(d, [0x80, 0, 0]);
        // Reset.
        write_reg(&mut b, 0xE0, 0xB6, 2.0);
        assert_eq!(read_regs(&mut b, 0xF4, 1, 2.0), [0]);
    }

    #[test]
    fn bmp280_normal_mode_follows_the_inputs() {
        let mut b = Bmp280::new(0x77, 25.0, 101_325.0);
        write_reg(&mut b, 0xF4, 0xB7, 0.0); // T ×16, P ×16, normal
        let t = 0.1;
        let read = |b: &mut Bmp280, now| {
            let d = read_regs(b, 0xF7, 6, now);
            let adc_p = (d[0] as i32) << 12 | (d[1] as i32) << 4 | (d[2] as i32) >> 4;
            let adc_t = (d[3] as i32) << 12 | (d[4] as i32) << 4 | (d[5] as i32) >> 4;
            let (tf, tc) = bmp280_t_fine(adc_t);
            (tc, bmp280_pressure(adc_p, tf) as f64 / 256.0)
        };
        let (tc, p) = read(&mut b, t);
        assert_eq!(tc, 2500);
        assert!((p - 101_325.0).abs() < 0.2, "{p}");
        b.temp = -10.25;
        b.pressure = 80_000.0;
        let (tc, p) = read(&mut b, t + 1.0);
        assert_eq!(tc, -1025);
        assert!((p - 80_000.0).abs() < 0.2, "{p}");
    }
}
