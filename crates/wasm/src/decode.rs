//! Streaming protocol decoders for the content trigger (M26).
//!
//! The waveform view decodes captured edges in TypeScript
//! (`web/src/run/decode.ts`) for display. To trigger on decoded content
//! exactly — at the cycle the matched item starts, however fast the
//! stream — the same decoders run here, inside the scope, on every probed
//! edge as it is fed in. They are the TypeScript ones rewritten to take
//! one edge at a time and keep their state between run slices: the items
//! they produce (start, kind, value, error) and the matches found in them
//! must be the same, which `tests/decode_parity.rs` checks on streams the
//! TypeScript side decoded (`web/scripts/decode-parity.ts`).
//!
//! Time is in ns. A decoder learns that time has reached `t` from an edge
//! at `t` (every edge before it is known then) or from `advance(t)` (every
//! edge up to `t` is known). A level is sampled as the TypeScript `levelAt`
//! does: the level just before the sample time, an edge at that very time
//! not counted.

use std::collections::VecDeque;

use serde::Deserialize;

/// What a decoded item is (the TypeScript `AnnotationKind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Data,
    Address,
    Start,
    Restart,
    Stop,
    Reset,
    Triplet,
    Pixel,
    /// NEC: the leader (9 ms mark, 4.5 ms space) with the frame's address
    /// and command once its 32 bits are in.
    Leader,
    /// NEC repeat code (9 ms mark, 2.25 ms space, mark).
    Repeat,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Data => "data",
            Kind::Address => "address",
            Kind::Start => "start",
            Kind::Restart => "restart",
            Kind::Stop => "stop",
            Kind::Reset => "reset",
            Kind::Triplet => "triplet",
            Kind::Pixel => "pixel",
            Kind::Leader => "leader",
            Kind::Repeat => "repeat",
        }
    }
}

/// An item's error, as far as matching cares: a byte or pixel cut short
/// never matches; other errors (framing, parity, NACK, timing) only break
/// a text or an IR frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fault {
    /// A 1-Wire byte, WS2812 pixel or NEC frame that did not finish.
    Partial,
    Other,
}

/// One decoded item.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Item {
    pub start: f64,
    pub end: f64,
    pub kind: Kind,
    /// Byte, word, colour (0xRRGGBB) or NEC command.
    pub value: Option<u32>,
    /// SPI: the word on MISO.
    pub miso: Option<u32>,
    /// I2C 7-bit address, NEC address.
    pub addr: Option<u32>,
    /// I2C direction (true: read).
    pub read: Option<bool>,
    /// WS2812 pixel number.
    pub index: Option<u32>,
    pub fault: Option<Fault>,
}

impl Item {
    fn new(kind: Kind, start: f64, end: f64) -> Self {
        Self {
            start,
            end,
            kind,
            value: None,
            miso: None,
            addr: None,
            read: None,
            index: None,
            fault: None,
        }
    }

    fn value(mut self, v: u32) -> Self {
        self.value = Some(v);
        self
    }

    fn fault(mut self, f: Option<Fault>) -> Self {
        self.fault = f;
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Parity {
    #[default]
    None,
    Even,
    Odd,
}

/// A decoder as the waveform view sets it up (`DecoderCfg`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecoderSpec {
    /// `uart`, `i2c`, `spi`, `onewire`, `tm1637`, `ws2812` or `nec`.
    #[serde(rename = "type")]
    pub kind: String,
    /// The pins of its roles (see `roles`); `""` for an optional one left
    /// out.
    pub pins: Vec<String>,
    #[serde(default = "default_baud")]
    pub baud: f64,
    #[serde(default)]
    pub parity: Parity,
    /// SPI mode 0–3 (CPOL·2 + CPHA).
    #[serde(default)]
    pub mode: u8,
    #[serde(default)]
    pub lsb_first: bool,
}

fn default_baud() -> f64 {
    115_200.0
}

impl DecoderSpec {
    /// How many pins the decoder takes and how many of them it needs.
    pub fn roles(&self) -> Option<(usize, usize)> {
        Some(match self.kind.as_str() {
            "uart" | "onewire" | "ws2812" | "nec" => (1, 1),
            "i2c" | "tm1637" => (2, 2),
            // SCK, MOSI, MISO, CS.
            "spi" => (4, 2),
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum Rw {
    R,
    W,
    #[serde(rename = "any")]
    Any,
}

/// What the content trigger looks for (the TypeScript `ContentMatch`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Match {
    /// A byte (UART, I2C data, SPI MOSI or MISO, 1-Wire, TM1637).
    Byte { value: u32 },
    /// UART text: consecutive frames, none in error.
    Text { text: String },
    /// An I2C address byte.
    Address { addr: u32, rw: Rw },
    /// A WS2812 pixel by number (and colour).
    Pixel {
        index: u32,
        #[serde(default)]
        color: Option<u32>,
    },
    /// An NEC frame by command (and address), check bytes right.
    Nec {
        cmd: u32,
        #[serde(default)]
        addr: Option<u32>,
    },
}

/// Finds a `Match` in a stream of items; returns where a match starts
/// (for a text, its first byte).
#[derive(Debug, Clone)]
pub struct Matcher {
    m: Match,
    /// The text as UTF-16 code units (a frame is one, as in JavaScript).
    text: Vec<u32>,
    /// The latest good frames of a run: (start, byte).
    run: VecDeque<(f64, u32)>,
}

impl Matcher {
    pub fn new(m: Match) -> Self {
        let text = match &m {
            Match::Text { text } => text.encode_utf16().map(u32::from).collect(),
            _ => Vec::new(),
        };
        Self {
            m,
            text,
            run: VecDeque::new(),
        }
    }

    pub fn item(&mut self, a: &Item) -> Option<f64> {
        match &self.m {
            Match::Text { .. } => {
                if self.text.is_empty() || a.kind != Kind::Data {
                    return None;
                }
                let v = a.value?;
                if a.fault.is_some() {
                    // A frame not received ends the run.
                    self.run.clear();
                    return None;
                }
                self.run.push_back((a.start, v));
                if self.run.len() > self.text.len() {
                    self.run.pop_front();
                }
                (self.run.len() == self.text.len()
                    && self.run.iter().zip(&self.text).all(|(r, &c)| r.1 == c))
                .then(|| self.run[0].0)
            }
            &Match::Byte { value } => (a.kind == Kind::Data
                && a.fault != Some(Fault::Partial)
                && (a.value == Some(value) || a.miso == Some(value)))
            .then_some(a.start),
            &Match::Address { addr, rw } => (a.kind == Kind::Address
                && a.addr == Some(addr)
                && match rw {
                    Rw::Any => true,
                    Rw::R => a.read == Some(true),
                    Rw::W => a.read == Some(false),
                })
            .then_some(a.start),
            &Match::Pixel { index, color } => (a.kind == Kind::Pixel
                && a.index == Some(index)
                && a.fault != Some(Fault::Partial)
                && color.is_none_or(|c| a.value == Some(c)))
            .then_some(a.start),
            &Match::Nec { cmd, addr } => (a.kind == Kind::Leader
                && a.fault.is_none()
                && a.value == Some(cmd)
                && addr.is_none_or(|x| a.addr == Some(x)))
            .then_some(a.start),
        }
    }
}

/// A line's level, and the level before its last edge: sampling at `s`
/// gives the level just before `s`.
#[derive(Debug, Clone, Copy)]
struct LineSt {
    level: bool,
    prev: bool,
    t: f64,
}

impl LineSt {
    fn new(level: bool) -> Self {
        Self {
            level,
            prev: level,
            t: f64::NEG_INFINITY,
        }
    }

    fn set(&mut self, t: f64, level: bool) {
        if t > self.t {
            self.prev = self.level;
            self.t = t;
        }
        self.level = level;
    }

    /// Level just before `s` (`s` not earlier than the last edge).
    fn at(&self, s: f64) -> bool {
        if self.t < s {
            self.level
        } else {
            self.prev
        }
    }
}

/// Edges at one time, held until time moves on so that they are handled
/// in the order the TypeScript decoders take them (clock before data, CS
/// before the clock), whatever order they arrived in.
#[derive(Debug, Clone, Default)]
struct Batch {
    t: f64,
    edges: Vec<(usize, bool)>,
}

impl Batch {
    /// The edges to handle before one at `t` (or time `t` with `inclusive`).
    fn take(&mut self, t: f64, inclusive: bool, prio: impl Fn(usize) -> u8) -> Vec<(usize, bool)> {
        if self.edges.is_empty() || self.t > t || (self.t == t && !inclusive) {
            return Vec::new();
        }
        let mut e = std::mem::take(&mut self.edges);
        e.sort_by_key(|&(r, _)| prio(r));
        e
    }
}

// ------------------------------------------------------------------ UART

#[derive(Debug, Clone)]
pub struct Uart {
    bit: f64,
    parity: Parity,
    /// Level before the first edge of `buf`.
    level0: bool,
    /// Edges not yet consumed: from a possible start bit on.
    buf: VecDeque<(f64, bool)>,
    /// The next start bit comes after the middle of the last stop bit.
    resume: f64,
    last: bool,
}

impl Uart {
    const DATA_BITS: u32 = 8;
    const STOP_BITS: u32 = 1;

    fn new(baud: f64, parity: Parity, level: bool) -> Self {
        Self {
            bit: 1e9 / baud,
            parity,
            level0: level,
            buf: VecDeque::new(),
            resume: f64::NEG_INFINITY,
            last: level,
        }
    }

    fn at(&self, s: f64) -> bool {
        let i = self.buf.partition_point(|e| e.0 < s);
        if i == 0 {
            self.level0
        } else {
            self.buf[i - 1].1
        }
    }

    fn edge(&mut self, t: f64, level: bool, out: &mut Vec<Item>) {
        self.advance(t, out);
        if level != self.last {
            self.last = level;
            self.buf.push_back((t, level));
        }
    }

    /// Frames whose last sample is at or before `known`.
    fn advance(&mut self, known: f64, out: &mut Vec<Item>) {
        let bit = self.bit;
        let n = Self::DATA_BITS;
        let p = u32::from(self.parity != Parity::None);
        let frame = (1 + n + p + Self::STOP_BITS) as f64 * bit;
        loop {
            // Up to a start bit (the line leaves idle) after the last frame.
            while let Some(&(t, l)) = self.buf.front() {
                if t < self.resume || l {
                    self.level0 = l;
                    self.buf.pop_front();
                } else {
                    break;
                }
            }
            let Some(&(t, _)) = self.buf.front() else {
                return;
            };
            if t + frame - bit / 2.0 > known {
                return;
            }
            if self.at(t + bit / 2.0) {
                // A glitch, not a start bit.
                self.level0 = false;
                self.buf.pop_front();
                continue;
            }
            let mut value = 0;
            let mut ones = 0;
            for k in 0..n {
                if self.at(t + (1.5 + k as f64) * bit) {
                    value |= 1 << k;
                    ones += 1;
                }
            }
            let mut k = 1 + n;
            let mut fault = None;
            if self.parity != Parity::None {
                let b = self.at(t + (k as f64 + 0.5) * bit);
                if ((ones + u32::from(b)) % 2 == 1) != (self.parity == Parity::Odd) {
                    fault = Some(Fault::Other);
                }
                k += 1;
            }
            for _ in 0..Self::STOP_BITS {
                if !self.at(t + (k as f64 + 0.5) * bit) {
                    fault = Some(Fault::Other);
                }
                k += 1;
            }
            out.push(
                Item::new(Kind::Data, t, t + k as f64 * bit)
                    .value(value)
                    .fault(fault),
            );
            self.resume = t + (k as f64 - 0.5) * bit;
        }
    }
}

// ------------------------------------------------------------------- I2C

/// I2C and TM1637: START/STOP while the clock is high, 9 bits per byte on
/// the clock's rising edges.
#[derive(Debug, Clone)]
pub struct TwoWire {
    c: bool,
    d: bool,
    active: bool,
    first: bool,
    read: bool,
    bits: Vec<bool>,
    byte_start: f64,
    last_fall: f64,
    last_rise: f64,
    period: f64,
    batch: Batch,
    /// TM1637: bytes LSB first, with commands; else I2C.
    tm1637: bool,
}

impl TwoWire {
    fn new(clock: bool, data: bool, tm1637: bool) -> Self {
        Self {
            c: clock,
            d: data,
            active: false,
            first: false,
            read: false,
            bits: Vec::with_capacity(9),
            byte_start: 0.0,
            last_fall: f64::NAN,
            last_rise: f64::NAN,
            period: f64::NAN,
            batch: Batch::default(),
            tm1637,
        }
    }

    fn edge(&mut self, role: usize, t: f64, level: bool, out: &mut Vec<Item>) {
        self.advance_to(t, false, out);
        self.batch.t = t;
        self.batch.edges.push((role, level));
    }

    fn advance_to(&mut self, t: f64, inclusive: bool, out: &mut Vec<Item>) {
        let bt = self.batch.t;
        for (role, l) in self.batch.take(t, inclusive, |r| r as u8) {
            self.handle(role, bt, l, out);
        }
    }

    fn handle(&mut self, role: usize, t: f64, l: bool, out: &mut Vec<Item>) {
        if role == 0 {
            if l == self.c {
                return;
            }
            self.c = l;
            if !l {
                self.last_fall = t;
                return;
            }
            if !self.active {
                return;
            }
            if self.bits.is_empty() {
                self.byte_start = if self.last_fall.is_nan() {
                    t
                } else {
                    self.last_fall
                };
            }
            if !self.last_rise.is_nan() && !self.bits.is_empty() {
                self.period = t - self.last_rise;
            }
            self.last_rise = t;
            self.bits.push(self.d);
            if self.bits.len() < 9 {
                return;
            }
            let value = if self.tm1637 {
                self.bits[..8]
                    .iter()
                    .enumerate()
                    .fold(0, |a, (k, &x)| a | (u32::from(x) << k))
            } else {
                self.bits[..8]
                    .iter()
                    .fold(0, |a, &x| (a << 1) | u32::from(x))
            };
            let ack = !self.bits[8];
            let end = t + if self.period.is_nan() {
                t - self.byte_start
            } else {
                self.period / 2.0
            };
            let mut it = Item::new(Kind::Data, self.byte_start, end).value(value);
            if self.tm1637 {
                let mut bad = !ack;
                if self.first {
                    self.first = false;
                    // Data (0x40), display control (0x80) or address (0xC0).
                    bad |= value & 0xc0 == 0;
                }
                it.fault = bad.then_some(Fault::Other);
            } else if self.first {
                self.read = value & 1 == 1;
                it.kind = Kind::Address;
                it.addr = Some(value >> 1);
                it.read = Some(self.read);
                it.fault = (!ack).then_some(Fault::Other);
                self.first = false;
            } else {
                it.fault = (!ack && !self.read).then_some(Fault::Other);
            }
            out.push(it);
            self.bits.clear();
        } else {
            if l == self.d {
                return;
            }
            self.d = l;
            if !self.c {
                return;
            }
            if !l {
                let kind = if self.active && !self.tm1637 {
                    Kind::Restart
                } else {
                    Kind::Start
                };
                out.push(Item::new(kind, t, t));
                self.active = true;
                self.first = true;
            } else {
                out.push(Item::new(Kind::Stop, t, t));
                self.active = false;
            }
            self.bits.clear();
        }
    }
}

// ------------------------------------------------------------------- SPI

#[derive(Debug, Clone)]
pub struct Spi {
    sample_level: bool,
    msb: bool,
    has_miso: bool,
    has_cs: bool,
    mosi: LineSt,
    miso: LineSt,
    selected: bool,
    prev: bool,
    mo: Vec<bool>,
    mi: Vec<bool>,
    first: f64,
    last: f64,
    period: f64,
    batch: Batch,
}

impl Spi {
    const BITS: usize = 8;

    fn new(mode: u8, lsb_first: bool, levels: [bool; 4], has_miso: bool, has_cs: bool) -> Self {
        let cpol = mode & 2 != 0;
        let cpha = mode & 1 != 0;
        Self {
            sample_level: if cpha { cpol } else { !cpol },
            msb: !lsb_first,
            has_miso,
            has_cs,
            mosi: LineSt::new(levels[1]),
            miso: LineSt::new(levels[2]),
            selected: if has_cs { !levels[3] } else { true },
            prev: levels[0],
            mo: Vec::with_capacity(Self::BITS),
            mi: Vec::with_capacity(Self::BITS),
            first: 0.0,
            last: f64::NAN,
            period: f64::NAN,
            batch: Batch::default(),
        }
    }

    fn word(&self, bits: &[bool]) -> u32 {
        let f = |a: u32, &x: &bool| (a << 1) | u32::from(x);
        if self.msb {
            bits.iter().fold(0, f)
        } else {
            bits.iter().rev().fold(0, f)
        }
    }

    fn edge(&mut self, role: usize, t: f64, level: bool, out: &mut Vec<Item>) {
        // Clock edges before `t` sample the data lines as they were.
        self.advance_to(t, false, out);
        match role {
            1 => self.mosi.set(t, level),
            2 => self.miso.set(t, level),
            _ => {
                self.batch.t = t;
                self.batch.edges.push((role, level));
            }
        }
    }

    fn advance_to(&mut self, t: f64, inclusive: bool, out: &mut Vec<Item>) {
        let bt = self.batch.t;
        // CS before SCK at the same time.
        for (role, l) in self.batch.take(t, inclusive, |r| u8::from(r == 0)) {
            self.handle(role, bt, l, out);
        }
    }

    fn handle(&mut self, role: usize, t: f64, l: bool, out: &mut Vec<Item>) {
        if role == 3 {
            if self.has_cs {
                self.selected = !l;
                // CS moved: a word in progress is dropped.
                self.mo.clear();
                self.mi.clear();
            }
            return;
        }
        if l == self.prev {
            return;
        }
        self.prev = l;
        if l != self.sample_level || !self.selected {
            return;
        }
        if !self.has_cs
            && !self.mo.is_empty()
            && !self.period.is_nan()
            && t - self.last > 8.0 * self.period
        {
            self.mo.clear();
            self.mi.clear();
        }
        if !self.last.is_nan() && !self.mo.is_empty() {
            self.period = t - self.last;
        }
        if self.mo.is_empty() {
            self.first = t;
        }
        self.last = t;
        self.mo.push(self.mosi.at(t));
        if self.has_miso {
            self.mi.push(self.miso.at(t));
        }
        if self.mo.len() == Self::BITS {
            let half = if self.period.is_nan() {
                0.0
            } else {
                self.period / 2.0
            };
            let mut it =
                Item::new(Kind::Data, self.first - half, t + half).value(self.word(&self.mo));
            if self.has_miso {
                it.miso = Some(self.word(&self.mi));
            }
            out.push(it);
            self.mo.clear();
            self.mi.clear();
        }
    }
}

// ---------------------------------------------------------------- 1-Wire

/// 1-Wire timing (standard speed), ns: the TypeScript `OW`.
mod ow {
    pub const RESET_MIN: f64 = 480e3;
    pub const RESET_LIKE: f64 = 300e3;
    pub const SLOT_MAX: f64 = 120e3;
    pub const SAMPLE: f64 = 15e3;
    pub const SLOT_MIN: f64 = 60e3;
    pub const PRESENCE_WAIT: f64 = 80e3;
    pub const PRESENCE_MIN: f64 = 60e3;
    pub const PRESENCE_MAX: f64 = 240e3;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OwPhase {
    None,
    Rom,
    RomCode,
    Search,
    Func,
    Data,
}

#[derive(Debug, Clone)]
pub struct OneWire {
    level: bool,
    fall: f64,
    /// A reset pulse whose presence pulse (the next low) is not seen yet.
    reset: Option<(f64, f64)>,
    phase: OwPhase,
    count: u32,
    bits: Vec<bool>,
    bit_err: bool,
    byte_start: f64,
    last_fall: f64,
}

impl OneWire {
    fn new(level: bool) -> Self {
        Self {
            level,
            fall: f64::NAN,
            reset: None,
            phase: OwPhase::None,
            count: 0,
            bits: Vec::with_capacity(8),
            bit_err: false,
            byte_start: 0.0,
            last_fall: f64::NAN,
        }
    }

    fn edge(&mut self, t: f64, l: bool, out: &mut Vec<Item>) {
        if l == self.level {
            return;
        }
        self.level = l;
        if !l {
            self.fall = t;
        } else if !self.fall.is_nan() {
            let f = self.fall;
            self.fall = f64::NAN;
            self.pulse(f, t, out);
        }
    }

    fn flush_partial(&mut self, end: f64, out: &mut Vec<Item>) {
        if !self.bits.is_empty() {
            out.push(
                Item::new(Kind::Data, self.byte_start, end)
                    .value(0)
                    .fault(Some(Fault::Partial)),
            );
        }
        self.bits.clear();
        self.bit_err = false;
    }

    fn pulse(&mut self, f: f64, r: f64, out: &mut Vec<Item>) {
        let w = r - f;
        if let Some((f0, r0)) = self.reset.take() {
            let w0 = r0 - f0;
            let presence = f - r0 <= ow::PRESENCE_WAIT
                && (ow::PRESENCE_MIN / 2.0..=2.0 * ow::PRESENCE_MAX).contains(&w);
            let mut err = w0 < ow::RESET_MIN;
            let mut end = r0;
            if presence {
                end = r;
                err |= !(ow::PRESENCE_MIN..=ow::PRESENCE_MAX).contains(&w);
            } else {
                err = true;
            }
            out.push(Item::new(Kind::Reset, f0, end).fault(err.then_some(Fault::Other)));
            self.phase = OwPhase::Rom;
            self.last_fall = f64::NAN;
            if presence {
                return;
            }
        }
        if w >= ow::RESET_LIKE {
            self.flush_partial(f, out);
            self.reset = Some((f, r));
            return;
        }
        // A time slot.
        let err =
            w > ow::SLOT_MAX || (!self.last_fall.is_nan() && f - self.last_fall < ow::SLOT_MIN);
        self.last_fall = f;
        if self.bits.is_empty() {
            self.byte_start = f;
        }
        self.bits.push(w < ow::SAMPLE);
        self.bit_err |= err;
        let slot_end = f + ow::SLOT_MIN.max(w);
        if self.phase == OwPhase::Search {
            if self.bits.len() < 3 {
                return;
            }
            let (b, c) = (self.bits[0], self.bits[1]);
            let fault = (self.bit_err || (b && c)).then_some(Fault::Other);
            let mut it = Item::new(Kind::Triplet, self.byte_start, slot_end).fault(fault);
            it.index = Some(64 - self.count);
            out.push(it);
            self.bits.clear();
            self.bit_err = false;
            self.count -= 1;
            if self.count == 0 {
                self.phase = OwPhase::Func;
            }
            return;
        }
        if self.bits.len() < 8 {
            return;
        }
        let value = self
            .bits
            .iter()
            .enumerate()
            .fold(0, |a, (k, &x)| a | (u32::from(x) << k));
        match self.phase {
            OwPhase::Rom => match value {
                0x33 | 0x55 => {
                    self.phase = OwPhase::RomCode;
                    self.count = 8;
                }
                0xf0 | 0xec => {
                    self.phase = OwPhase::Search;
                    self.count = 64;
                }
                0xcc => self.phase = OwPhase::Func,
                _ => self.phase = OwPhase::Data,
            },
            OwPhase::RomCode => {
                self.count -= 1;
                if self.count == 0 {
                    self.phase = OwPhase::Func;
                }
            }
            OwPhase::Func => self.phase = OwPhase::Data,
            _ => {}
        }
        out.push(
            Item::new(Kind::Data, self.byte_start, slot_end)
                .value(value)
                .fault(self.bit_err.then_some(Fault::Other)),
        );
        self.bits.clear();
        self.bit_err = false;
    }
}

// ---------------------------------------------------------------- WS2812

mod ws {
    pub const T0H: f64 = 400.0;
    pub const T1H: f64 = 800.0;
    pub const TOLERANCE: f64 = 150.0;
    pub const RESET: f64 = 50_000.0;
    pub const BIT: f64 = 1250.0;
}

#[derive(Debug, Clone)]
pub struct Ws2812 {
    level: bool,
    rise: f64,
    last_fall: f64,
    /// The low before the next rise started when watching did: no reset
    /// item for it.
    from_window: bool,
    index: Option<u32>,
    bits: u32,
    nbits: u32,
    err: bool,
    pix_start: f64,
    last_rise: f64,
}

impl Ws2812 {
    /// `from`: when watching started (an idle-low line there counts as a
    /// reset for the first pixel).
    fn new(level: bool, from: f64) -> Self {
        Self {
            level,
            rise: f64::NAN,
            last_fall: if level { f64::NAN } else { from },
            from_window: !level,
            index: None,
            bits: 0,
            nbits: 0,
            err: false,
            pix_start: 0.0,
            last_rise: f64::NAN,
        }
    }

    fn edge(&mut self, t: f64, l: bool, out: &mut Vec<Item>) {
        if l == self.level {
            return;
        }
        self.level = l;
        if l {
            if !self.last_fall.is_nan() && t - self.last_fall >= ws::RESET {
                if self.nbits > 0 {
                    let mut it = Item::new(Kind::Pixel, self.pix_start, self.last_fall)
                        .value(0)
                        .fault(Some(Fault::Partial));
                    it.index = self.index;
                    out.push(it);
                }
                self.nbits = 0;
                self.bits = 0;
                self.err = false;
                if !self.from_window {
                    out.push(Item::new(Kind::Reset, self.last_fall, t));
                }
                self.index = Some(0);
            }
            self.from_window = false;
            self.rise = t;
            return;
        }
        self.last_fall = t;
        if self.rise.is_nan() {
            return;
        }
        let h = t - self.rise;
        let one = h > (ws::T0H + ws::T1H) / 2.0;
        if (h - if one { ws::T1H } else { ws::T0H }).abs() > ws::TOLERANCE {
            self.err = true;
        }
        if self.nbits == 0 {
            self.pix_start = self.rise;
        }
        let period = if self.last_rise.is_nan() || self.rise - self.last_rise > 4.0 * ws::BIT {
            ws::BIT
        } else {
            self.rise - self.last_rise
        };
        self.last_rise = self.rise;
        self.bits = (self.bits << 1) | u32::from(one);
        self.nbits += 1;
        self.rise = f64::NAN;
        if self.nbits < 24 {
            return;
        }
        let grb = self.bits;
        let value = (((grb >> 8) & 0xff) << 16) | (((grb >> 16) & 0xff) << 8) | (grb & 0xff);
        let mut it = Item::new(Kind::Pixel, self.pix_start, self.last_rise + period)
            .value(value)
            .fault(self.err.then_some(Fault::Other));
        it.index = self.index;
        out.push(it);
        if let Some(i) = &mut self.index {
            *i += 1;
        }
        self.bits = 0;
        self.nbits = 0;
        self.err = false;
    }
}

// ------------------------------------------------------------------- NEC

/// NEC timing (the receiver's demodulated output), ns: the TypeScript
/// `NEC`.
pub mod nec {
    pub const LEADER_MARK_MIN: f64 = 7e6;
    pub const LEADER_MARK_MAX: f64 = 11e6;
    pub const LEADER_SPACE_MIN: f64 = 3.5e6;
    pub const LEADER_SPACE_MAX: f64 = 5.5e6;
    pub const REPEAT_SPACE_MIN: f64 = 1.75e6;
    pub const REPEAT_SPACE_MAX: f64 = 2.75e6;
    pub const MARK_MIN: f64 = 300e3;
    pub const MARK_MAX: f64 = 900e3;
    pub const ONE_MIN: f64 = 1.2e6;
    pub const ONE_MAX: f64 = 2.2e6;
}

#[derive(Debug, Clone, Copy)]
enum NecSt {
    Idle,
    /// The leader mark ended; its space decides frame or repeat.
    Leader {
        start: f64,
    },
    Bits {
        start: f64,
        lead_end: f64,
        n: u32,
        bits: u32,
        byte_start: f64,
    },
    Repeat {
        start: f64,
    },
}

#[derive(Debug, Clone)]
pub struct Nec {
    level: bool,
    last_fall: f64,
    last_rise: f64,
    st: NecSt,
}

fn within(x: f64, lo: f64, hi: f64) -> bool {
    x >= lo && x <= hi
}

impl Nec {
    fn new(level: bool) -> Self {
        Self {
            level,
            last_fall: f64::NAN,
            last_rise: f64::NAN,
            st: NecSt::Idle,
        }
    }

    fn edge(&mut self, t: f64, l: bool, out: &mut Vec<Item>) {
        use nec::*;
        if l == self.level {
            return;
        }
        self.level = l;
        if !l {
            // A mark begins: the space before it is over.
            let space = t - self.last_rise;
            match self.st {
                NecSt::Leader { start } => {
                    if within(space, LEADER_SPACE_MIN, LEADER_SPACE_MAX) {
                        self.st = NecSt::Bits {
                            start,
                            lead_end: t,
                            n: 0,
                            bits: 0,
                            byte_start: t,
                        };
                    } else if within(space, REPEAT_SPACE_MIN, REPEAT_SPACE_MAX) {
                        self.st = NecSt::Repeat { start };
                    } else {
                        out.push(Item::new(Kind::Leader, start, t).fault(Some(Fault::Other)));
                        self.st = NecSt::Idle;
                    }
                }
                NecSt::Bits {
                    start,
                    lead_end,
                    mut n,
                    mut bits,
                    mut byte_start,
                } => {
                    let one = within(space, ONE_MIN, ONE_MAX);
                    if !one && !within(space, MARK_MIN, MARK_MAX) {
                        out.push(
                            Item::new(Kind::Leader, start, lead_end).fault(Some(Fault::Other)),
                        );
                        self.st = NecSt::Idle;
                    } else {
                        bits |= u32::from(one) << n;
                        n += 1;
                        if n % 8 == 0 {
                            out.push(
                                Item::new(Kind::Data, byte_start, t)
                                    .value((bits >> (n - 8)) & 0xff),
                            );
                            byte_start = t;
                        }
                        if n == 32 {
                            let b = |k: u32| (bits >> (8 * k)) & 0xff;
                            let ok = b(0) ^ b(1) == 0xff && b(2) ^ b(3) == 0xff;
                            let mut it = Item::new(Kind::Leader, start, lead_end)
                                .value(b(2))
                                .fault((!ok).then_some(Fault::Other));
                            it.addr = Some(b(0));
                            out.push(it);
                            self.st = NecSt::Idle;
                        } else {
                            self.st = NecSt::Bits {
                                start,
                                lead_end,
                                n,
                                bits,
                                byte_start,
                            };
                        }
                    }
                }
                NecSt::Idle | NecSt::Repeat { .. } => {}
            }
            self.last_fall = t;
        } else {
            // A mark ends.
            let w = t - self.last_fall;
            if within(w, LEADER_MARK_MIN, LEADER_MARK_MAX) {
                if let NecSt::Bits {
                    start, lead_end, ..
                } = self.st
                {
                    // The frame did not finish.
                    out.push(Item::new(Kind::Leader, start, lead_end).fault(Some(Fault::Partial)));
                }
                self.st = NecSt::Leader {
                    start: self.last_fall,
                };
            } else {
                match self.st {
                    NecSt::Bits {
                        start, lead_end, ..
                    } if !within(w, MARK_MIN, MARK_MAX) => {
                        out.push(
                            Item::new(Kind::Leader, start, lead_end).fault(Some(Fault::Other)),
                        );
                        self.st = NecSt::Idle;
                    }
                    NecSt::Repeat { start } => {
                        let bad = !within(w, MARK_MIN, MARK_MAX);
                        out.push(
                            Item::new(Kind::Repeat, start, t).fault(bad.then_some(Fault::Other)),
                        );
                        self.st = NecSt::Idle;
                    }
                    _ => {}
                }
            }
            self.last_rise = t;
        }
    }
}

// --------------------------------------------------------------- Decoder

/// One streaming decoder.
#[derive(Debug, Clone)]
pub enum Decoder {
    Uart(Uart),
    TwoWire(Box<TwoWire>),
    Spi(Box<Spi>),
    OneWire(OneWire),
    Ws2812(Ws2812),
    Nec(Nec),
}

impl Decoder {
    /// A decoder for `spec`, with its pins at `levels` (in role order; a
    /// missing optional pin's level is ignored) when watching starts at
    /// `from`. None for an unknown type.
    pub fn new(spec: &DecoderSpec, levels: &[bool], present: &[bool], from: f64) -> Option<Self> {
        let l = |k: usize| levels.get(k).copied().unwrap_or(false);
        let has = |k: usize| present.get(k).copied().unwrap_or(false);
        Some(match spec.kind.as_str() {
            "uart" => Decoder::Uart(Uart::new(spec.baud.max(1.0), spec.parity, l(0))),
            "i2c" => Decoder::TwoWire(Box::new(TwoWire::new(l(0), l(1), false))),
            "tm1637" => Decoder::TwoWire(Box::new(TwoWire::new(l(0), l(1), true))),
            "spi" => Decoder::Spi(Box::new(Spi::new(
                spec.mode,
                spec.lsb_first,
                [l(0), l(1), l(2), l(3)],
                has(2),
                has(3),
            ))),
            "onewire" => Decoder::OneWire(OneWire::new(l(0))),
            "ws2812" => Decoder::Ws2812(Ws2812::new(l(0), from)),
            "nec" => Decoder::Nec(Nec::new(l(0))),
            _ => return None,
        })
    }

    /// The pin of `role` changed to `level` at `t` (in time order).
    pub fn edge(&mut self, role: usize, t: f64, level: bool, out: &mut Vec<Item>) {
        match self {
            Decoder::Uart(d) => d.edge(t, level, out),
            Decoder::TwoWire(d) => d.edge(role, t, level, out),
            Decoder::Spi(d) => d.edge(role, t, level, out),
            Decoder::OneWire(d) => d.edge(t, level, out),
            Decoder::Ws2812(d) => d.edge(t, level, out),
            Decoder::Nec(d) => d.edge(t, level, out),
        }
    }

    /// Every edge up to `now` is known.
    pub fn advance(&mut self, now: f64, out: &mut Vec<Item>) {
        match self {
            Decoder::Uart(d) => d.advance(now, out),
            Decoder::TwoWire(d) => d.advance_to(now, true, out),
            Decoder::Spi(d) => d.advance_to(now, true, out),
            Decoder::OneWire(_) | Decoder::Ws2812(_) | Decoder::Nec(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    //! The TypeScript decoders' unit cases (web/test/decode.test.ts,
    //! m25.test.ts, m26.test.ts), streamed; the full cross-check is
    //! tests/decode_parity.rs.
    use super::*;

    const BIT: f64 = 1e9 / 115_200.0;

    /// Edges of 8N1 frames (`bad`: indices whose stop bit is low).
    fn uart(text: &[u8], t0: f64, bad: &[usize]) -> Vec<(f64, bool)> {
        let mut e = Vec::new();
        let mut level = true;
        let mut at = |t: f64, l: bool, e: &mut Vec<(f64, bool)>| {
            if l != level {
                e.push((t, l));
                level = l;
            }
        };
        let mut t = t0;
        for (i, &v) in text.iter().enumerate() {
            at(t, false, &mut e);
            for k in 0..8 {
                at(t + (1 + k) as f64 * BIT, v >> k & 1 == 1, &mut e);
            }
            let stop = !bad.contains(&i);
            at(t + 9.0 * BIT, stop, &mut e);
            t += 10.0 * BIT;
            if !stop {
                at(t, true, &mut e);
                t += BIT;
            }
        }
        e
    }

    fn spec(kind: &str) -> DecoderSpec {
        DecoderSpec {
            kind: kind.into(),
            pins: vec![],
            baud: 115_200.0,
            parity: Parity::None,
            mode: 0,
            lsb_first: false,
        }
    }

    /// Feed one line's edges (role 0), then let time run on.
    fn run1(d: &mut Decoder, edges: &[(f64, bool)]) -> Vec<Item> {
        let mut out = Vec::new();
        for &(t, l) in edges {
            d.edge(0, t, l, &mut out);
        }
        let end = edges.last().map_or(0.0, |e| e.0) + 1e9;
        d.advance(end, &mut out);
        out
    }

    fn matches(m: Match, items: &[Item]) -> Vec<f64> {
        let mut x = Matcher::new(m);
        items.iter().filter_map(|i| x.item(i)).collect()
    }

    #[test]
    fn uart_frames_text_and_a_bad_frame_breaks_a_text() {
        let e = uart(b"tick 1tick 1", 1000.0, &[3]);
        let mut d = Decoder::new(&spec("uart"), &[true], &[true], 0.0).unwrap();
        let items = run1(&mut d, &e);
        let v: Vec<u32> = items.iter().map(|i| i.value.unwrap()).collect();
        assert_eq!(
            v,
            b"tick 1tick 1"
                .iter()
                .map(|&b| u32::from(b))
                .collect::<Vec<_>>()
        );
        assert_eq!(items[3].fault, Some(Fault::Other), "framing error");
        // The first "tick 1" has a frame in error: only the second matches
        // (M25's fix: no text across a byte not received).
        let text = Match::Text {
            text: "tick 1".into(),
        };
        assert_eq!(matches(text, &items), vec![items[6].start]);
        assert!((items[6].start - (1000.0 + 6.0 * 10.0 * BIT + BIT)).abs() < 1e-6);
        // A byte matches even in error (as in TypeScript).
        assert_eq!(
            matches(
                Match::Byte {
                    value: u32::from(b'k')
                },
                &items
            )
            .len(),
            2
        );
    }

    #[test]
    fn uart_parity_glitch_and_frames_finish_without_an_edge() {
        // 'A' (0x41, two 1s) with even parity: parity bit 0; then a wrong one.
        let mut e = vec![
            (1000.0, false),
            (1000.0 + BIT, true),
            (1000.0 + 2.0 * BIT, false),
        ];
        e.push((1000.0 + 7.0 * BIT, true));
        e.push((1000.0 + 8.0 * BIT, false));
        // parity 0 at bit 9, stop high at 10.
        e.push((1000.0 + 10.0 * BIT, true));
        let mut s = spec("uart");
        s.parity = Parity::Even;
        let mut d = Decoder::new(&s, &[true], &[true], 0.0).unwrap();
        let mut out = Vec::new();
        for &(t, l) in &e {
            d.edge(0, t, l, &mut out);
        }
        // The stop bit's middle is not reached yet.
        d.advance(1000.0 + 10.4 * BIT, &mut out);
        assert!(out.is_empty());
        d.advance(1000.0 + 10.5 * BIT, &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!((out[0].value, out[0].fault), (Some(0x41), None));
        s.parity = Parity::Odd;
        let mut d = Decoder::new(&s, &[true], &[true], 0.0).unwrap();
        assert_eq!(run1(&mut d, &e)[0].fault, Some(Fault::Other));
        // A glitch shorter than half a bit is no start bit.
        let g = [(500.0, false), (500.0 + BIT / 4.0, true)];
        let mut d = Decoder::new(&spec("uart"), &[true], &[true], 0.0).unwrap();
        assert!(run1(&mut d, &g).is_empty());
    }

    const P: f64 = 10_000.0;

    /// I2C lines from a script, merged: (time, role, level).
    fn i2c(script: &[(&str, u32, bool)]) -> Vec<(f64, usize, bool)> {
        let mut e = Vec::new();
        let (mut c, mut d) = (true, true);
        let mut t = 5000.0;
        let mut at = |t: f64, role: usize, l: bool, e: &mut Vec<(f64, usize, bool)>| {
            let cur = if role == 0 { &mut c } else { &mut d };
            if *cur != l {
                *cur = l;
                e.push((t, role, l));
            }
        };
        for &(s, v, ack) in script {
            match s {
                "S" => {
                    at(t, 1, true, &mut e);
                    at(t + P / 4.0, 0, true, &mut e);
                    at(t + P / 2.0, 1, false, &mut e);
                    at(t + P, 0, false, &mut e);
                    t += P;
                }
                "P" => {
                    at(t + P / 4.0, 1, false, &mut e);
                    at(t + P / 2.0, 0, true, &mut e);
                    at(t + P, 1, true, &mut e);
                    t += 2.0 * P;
                }
                _ => {
                    for k in 0..9 {
                        let b = if k < 8 { v >> (7 - k) & 1 == 1 } else { !ack };
                        at(t + P / 4.0, 1, b, &mut e);
                        at(t + P / 2.0, 0, true, &mut e);
                        at(t + P, 0, false, &mut e);
                        t += P;
                    }
                }
            }
        }
        e
    }

    fn run(d: &mut Decoder, e: &[(f64, usize, bool)]) -> Vec<Item> {
        let mut out = Vec::new();
        for &(t, r, l) in e {
            d.edge(r, t, l, &mut out);
        }
        d.advance(e.last().unwrap().0 + 1e9, &mut out);
        out
    }

    #[test]
    fn i2c_address_rw_nack_and_repeated_start() {
        let e = i2c(&[
            ("S", 0, true),
            ("B", 0x3c << 1, false),
            ("P", 0, true),
            ("S", 0, true),
            ("B", 0x68 << 1, true),
            ("B", 0x00, true),
            ("S", 0, true),
            ("B", (0x68 << 1) | 1, true),
            ("B", 0x12, true),
            ("B", 0x34, false),
            ("P", 0, true),
        ]);
        let mut d = Decoder::new(&spec("i2c"), &[true, true], &[true, true], 0.0).unwrap();
        let items = run(&mut d, &e);
        let kinds: Vec<_> = items.iter().map(|i| i.kind.name()).collect();
        assert_eq!(
            kinds,
            [
                "start", "address", "stop", "start", "address", "data", "restart", "address",
                "data", "data", "stop"
            ]
        );
        assert_eq!(items[1].fault, Some(Fault::Other), "NACK on the address");
        assert_eq!((items[7].addr, items[7].read), (Some(0x68), Some(true)));
        // A read's last NACK is no error.
        assert_eq!(items[9].fault, None);
        let read = matches(
            Match::Address {
                addr: 0x68,
                rw: Rw::R,
            },
            &items,
        );
        assert_eq!(read, vec![items[7].start]);
        assert_eq!(
            matches(
                Match::Address {
                    addr: 0x68,
                    rw: Rw::Any
                },
                &items
            )
            .len(),
            2
        );
        assert!(matches(
            Match::Address {
                addr: 0x3d,
                rw: Rw::Any
            },
            &items
        )
        .is_empty());
        assert_eq!(
            matches(Match::Byte { value: 0x12 }, &items),
            vec![items[8].start]
        );
    }

    #[test]
    fn i2c_edges_at_the_same_time_go_clock_first_whatever_their_order() {
        // SDA falls at the very time SCL falls: no START (SCL first).
        let e = [(100.0, 1, false), (100.0, 0, false)];
        let mut d = Decoder::new(&spec("i2c"), &[true, true], &[true, true], 0.0).unwrap();
        assert!(run(&mut d, &e).is_empty());
    }

    #[test]
    fn spi_modes_cs_and_bit_order() {
        for mode in 0..4u8 {
            let (cpol, cpha) = (mode & 2 != 0, mode & 1 != 0);
            let mut e = vec![(800.0, 3, false)];
            let mut t = 1000.0;
            let mut sck = cpol;
            for v in [0xa5u32, 0x3c] {
                for k in 0..8 {
                    let b = v >> (7 - k) & 1 == 1;
                    if cpha {
                        sck = !cpol;
                        e.push((t, 0, sck));
                        e.push((t + 1.0, 1, b));
                        e.push((t + 100.0, 0, cpol));
                    } else {
                        e.push((t, 1, b));
                        e.push((t + 100.0, 0, !cpol));
                        e.push((t + 200.0, 0, cpol));
                    }
                    t += 200.0;
                }
                t += 400.0;
            }
            let _ = sck;
            // (Same level twice in a row is no edge: drop repeats.)
            let mut lv = [cpol, false, true, true];
            e.retain(|&(_, r, l)| {
                let keep = lv[r] != l;
                lv[r] = l;
                keep
            });
            let mut s = spec("spi");
            s.mode = mode;
            let mut d = Decoder::new(
                &s,
                &[cpol, false, true, true],
                &[true, true, false, true],
                0.0,
            )
            .unwrap();
            let v: Vec<_> = run(&mut d, &e).iter().map(|i| i.value.unwrap()).collect();
            assert_eq!(v, [0xa5, 0x3c], "mode {mode}");
            s.lsb_first = true;
            let mut d = Decoder::new(
                &s,
                &[cpol, false, true, true],
                &[true, true, false, true],
                0.0,
            )
            .unwrap();
            let v: Vec<_> = run(&mut d, &e).iter().map(|i| i.value.unwrap()).collect();
            assert_eq!(v, [0xa5, 0x3c], "mode {mode} LSB first");
        }
    }

    #[test]
    fn spi_cs_rising_mid_word_drops_it() {
        let mut e = vec![(0.0, 3, false)];
        for k in 0..4 {
            e.push((100.0 + 200.0 * k as f64, 0, true));
            e.push((200.0 + 200.0 * k as f64, 0, false));
        }
        e.push((900.0, 3, true));
        e.push((1000.0, 3, false));
        for k in 0..8 {
            e.push((1100.0 + 200.0 * k as f64, 0, true));
            e.push((1200.0 + 200.0 * k as f64, 0, false));
        }
        let mut d = Decoder::new(
            &spec("spi"),
            &[false, false, false, true],
            &[true, true, false, true],
            0.0,
        )
        .unwrap();
        let items = run(&mut d, &e);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].start, 1100.0 - 100.0);
    }

    const US: f64 = 1000.0;

    /// 1-Wire DQ from (low, high) durations, idle high.
    fn ow(script: &[(f64, f64)]) -> Vec<(f64, bool)> {
        let mut e = Vec::new();
        let mut t = 100.0 * US;
        for &(lo, hi) in script {
            e.push((t, false));
            e.push((t + lo, true));
            t += lo + hi;
        }
        e
    }

    fn ow_byte(v: u32, read: bool) -> Vec<(f64, f64)> {
        (0..8)
            .map(|k| {
                let one = v >> k & 1 == 1;
                let lo = if one {
                    6.0
                } else if read {
                    30.0
                } else {
                    60.0
                } * US;
                (lo, 70.0 * US - lo)
            })
            .collect()
    }

    #[test]
    fn onewire_reset_presence_skip_rom_convert_and_a_cut_byte() {
        let mut s = vec![(480.0 * US, 30.0 * US), (120.0 * US, 330.0 * US)];
        s.extend(ow_byte(0xcc, false));
        s.extend(ow_byte(0x44, false));
        s.push((6.0 * US, 64.0 * US)); // a bit, then a reset
        s.push((480.0 * US, 480.0 * US)); // no presence
        s.push((6.0 * US, 64.0 * US));
        let mut d = Decoder::new(&spec("onewire"), &[true], &[true], 0.0).unwrap();
        let items = run1(&mut d, &ow(&s));
        let k: Vec<_> = items
            .iter()
            .map(|i| (i.kind.name(), i.value, i.fault))
            .collect();
        assert_eq!(
            k,
            [
                ("reset", None, None),
                ("data", Some(0xcc), None),
                ("data", Some(0x44), None),
                ("data", Some(0), Some(Fault::Partial)),
                ("reset", None, Some(Fault::Other)),
            ]
        );
        assert_eq!(
            matches(Match::Byte { value: 0x44 }, &items),
            vec![items[2].start]
        );
        // A byte cut short never matches, even as 0.
        assert!(matches(Match::Byte { value: 0 }, &items).is_empty());
    }

    #[test]
    fn tm1637_bytes_are_lsb_first_with_commands() {
        // START, 0x40 (LSB first), STOP.
        let mut e = vec![(100.0, 1, false), (200.0, 0, false)];
        let mut t = 300.0;
        for k in 0..9 {
            let b = if k < 8 { 0x40 >> k & 1 == 1 } else { false };
            e.push((t, 1, b));
            e.push((t + 100.0, 0, true));
            e.push((t + 200.0, 0, false));
            t += 200.0;
        }
        e.push((t, 1, false));
        e.push((t + 100.0, 0, true));
        e.push((t + 200.0, 1, true));
        let mut prev = [true, true];
        e.retain(|&(_, r, l)| {
            let keep = prev[r] != l;
            prev[r] = l;
            keep
        });
        let mut d = Decoder::new(&spec("tm1637"), &[true, true], &[true, true], 0.0).unwrap();
        let items = run(&mut d, &e);
        let k: Vec<_> = items.iter().map(|i| (i.kind.name(), i.value)).collect();
        assert_eq!(k, [("start", None), ("data", Some(0x40)), ("stop", None)]);
        assert_eq!(items[1].fault, None);
    }

    #[test]
    fn ws2812_pixels_grb_numbered_from_the_reset() {
        let mut e = Vec::new();
        let mut t = 10_000.0;
        let pixel = |c: u32, e: &mut Vec<(f64, bool)>, t: &mut f64| {
            let grb = ((c >> 8) & 0xff) << 16 | ((c >> 16) & 0xff) << 8 | (c & 0xff);
            for k in (0..24).rev() {
                let h = if grb >> k & 1 == 1 { 800.0 } else { 400.0 };
                e.push((*t, true));
                e.push((*t + h, false));
                *t += 1250.0;
            }
        };
        pixel(0xff8000, &mut e, &mut t);
        t += 60_000.0;
        pixel(0x123456, &mut e, &mut t);
        pixel(0x00ff00, &mut e, &mut t);
        // Watching started with the line low 60 µs before: a reset.
        let mut d = Decoder::new(&spec("ws2812"), &[false], &[true], -50_000.0).unwrap();
        let items = run1(&mut d, &e);
        let k: Vec<_> = items
            .iter()
            .map(|i| (i.kind.name(), i.value, i.index))
            .collect();
        assert_eq!(
            k,
            [
                ("pixel", Some(0xff8000), Some(0)),
                ("reset", None, None),
                ("pixel", Some(0x123456), Some(0)),
                ("pixel", Some(0x00ff00), Some(1)),
            ]
        );
        let m = Match::Pixel {
            index: 1,
            color: Some(0x00ff00),
        };
        assert_eq!(matches(m, &items), vec![items[3].start]);
        // Low only 10 ns before, or from the middle of a frame: no number
        // until a reset.
        let mut d = Decoder::new(&spec("ws2812"), &[false], &[true], 9_990.0).unwrap();
        assert_eq!(run1(&mut d, &e)[0].index, None);
        let mut d = Decoder::new(&spec("ws2812"), &[true], &[true], 0.0).unwrap();
        assert_eq!(run1(&mut d, &e[1..])[0].index, None);
    }

    const M: f64 = 562_500.0;

    /// The receiver's output for marks and spaces (ns), idle high.
    fn ir(script: &[(f64, f64)]) -> Vec<(f64, bool)> {
        let mut e = Vec::new();
        let mut t = 1e6;
        for &(mark, space) in script {
            e.push((t, false));
            e.push((t + mark, true));
            t += mark + space;
        }
        e
    }

    fn nec_frame(bytes: [u32; 4], after: f64) -> Vec<(f64, f64)> {
        let mut s = vec![(9e6, 4.5e6)];
        for b in bytes {
            for k in 0..8 {
                s.push((M, if b >> k & 1 == 1 { 3.0 * M } else { M }));
            }
        }
        s.push((M, after));
        s
    }

    #[test]
    fn nec_frames_repeats_and_errors() {
        let mut s = nec_frame([0x00, 0xff, 0x1c, 0xe3], 40e6);
        s.push((9e6, 2.25e6));
        s.push((M, 96e6));
        s.extend(nec_frame([0x00, 0xff, 0x1c, 0xe2], 40e6)); // bad check byte
        s.extend(nec_frame([0x01, 0xfe, 0x45, 0xba], 40e6));
        let mut d = Decoder::new(&spec("nec"), &[true], &[true], 0.0).unwrap();
        let items = run1(&mut d, &ir(&s));
        let leaders: Vec<_> = items
            .iter()
            .filter(|i| i.kind != Kind::Data)
            .map(|i| (i.kind.name(), i.addr, i.value, i.fault))
            .collect();
        assert_eq!(
            leaders,
            [
                ("leader", Some(0), Some(0x1c), None),
                ("repeat", None, None, None),
                ("leader", Some(0), Some(0x1c), Some(Fault::Other)),
                ("leader", Some(1), Some(0x45), None),
            ]
        );
        assert_eq!(items[0].kind, Kind::Data);
        assert_eq!(items[2].value, Some(0x1c), "the command byte");
        // The leader comes once the 32 bits are in (after the 4 bytes) and
        // starts at the leader's mark.
        assert_eq!(items[4].start, 1e6);
        let cmd = |cmd, addr| matches(Match::Nec { cmd, addr }, &items);
        assert_eq!(cmd(0x1c, None), vec![1e6], "the bad frame does not match");
        assert_eq!(cmd(0x45, Some(1)).len(), 1);
        assert!(cmd(0x45, Some(0)).is_empty());
        // A new leader cuts a frame short.
        let mut s = vec![(9e6, 4.5e6)];
        s.extend(std::iter::repeat_n((M, M), 12));
        s.extend(nec_frame([0, 0xff, 8, 0xf7], 1e6));
        let mut d = Decoder::new(&spec("nec"), &[true], &[true], 0.0).unwrap();
        let items = run1(&mut d, &ir(&s));
        let l: Vec<_> = items
            .iter()
            .filter(|i| i.kind == Kind::Leader)
            .map(|i| i.fault)
            .collect();
        assert_eq!(l, [Some(Fault::Partial), None]);
    }
}
