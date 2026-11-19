//! Pin-level waveforms of the byte-level peripherals, for probes.
//!
//! USART, I2C and SPI move whole bytes (see their modules): their pins do
//! not toggle bit by bit. When a probe watches one of their routed pins,
//! the bus logs each byte as a [`WireEvent`] and [`WireEvent::edges`]
//! turns it into the edges the byte would make on the wire, at the
//! configured timing (baud rate, SCK from the prescaler, SCL from CCR).
//! These *synthesized* edges go to the probes only; the functional models
//! are unchanged.

use simucleo_core::Cycles;

use crate::i2c::{I2cOp, I2cReply};

/// (port, pin), port 0 = A.
pub type Pin = (u8, u8);

/// UART parity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Parity {
    None,
    Even,
    Odd,
}

/// A byte a peripheral moved, with what is needed to draw it on its pins.
#[derive(Debug, Clone, PartialEq)]
pub enum WireEvent {
    /// A UART frame on `pin`, from its start bit at `start`.
    Uart {
        pin: Pin,
        /// Sent by the USART (logged as it starts) or received (logged
        /// when its last bit arrived, ten bit times after the start).
        tx: bool,
        start: Cycles,
        /// Core cycles per bit.
        bit: f64,
        /// Data field as the USART holds it (`data_bits` wide; with parity
        /// its top bit is replaced by the parity bit, as the hardware does).
        data: u16,
        data_bits: u32,
        parity: Parity,
        /// Stop bits ×2.
        stop_halves: u32,
    },
    /// One SPI frame (8 or 16 SCK periods) that ended at `end`.
    Spi {
        sck: Pin,
        mosi: Pin,
        miso: Option<Pin>,
        start: Cycles,
        end: Cycles,
        cpol: bool,
        cpha: bool,
        /// Bytes in wire order, each MSB first on the wire: (MOSI, MISO).
        bytes: Vec<(u8, u8)>,
    },
    /// One I2C operation. For a START, write or read it is logged when the
    /// byte and its acknowledge bit end (`time`); a STOP when it is issued.
    I2c {
        scl: Pin,
        sda: Pin,
        time: Cycles,
        /// SCL period in core cycles.
        period: f64,
        op: I2cOp,
        reply: I2cReply,
        /// End of the controller's previous operation on the wire: a
        /// (repeated) START squeezes in after it.
        after: f64,
    },
}

/// An edge on a pin at a (fractional) core cycle.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SynthEdge {
    pub pin: Pin,
    pub time: f64,
    pub level: bool,
}

/// Which byte-level signal a pin carries (what it idles at).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireSignal {
    /// USART TX or RX: idles high.
    Uart,
    /// I2C SCL or SDA: open drain, pulled high.
    I2c,
    /// SPI SCK: idles at CPOL.
    SpiSck { cpol: bool },
    /// SPI MOSI or MISO: holds its last bit.
    SpiData,
}

impl WireSignal {
    /// Level of the line between transfers (`None`: whatever it was).
    pub fn idle(self) -> Option<bool> {
        match self {
            WireSignal::Uart | WireSignal::I2c => Some(true),
            WireSignal::SpiSck { cpol } => Some(cpol),
            WireSignal::SpiData => None,
        }
    }
}

struct Out<'a> {
    edges: &'a mut Vec<SynthEdge>,
}

impl Out<'_> {
    fn put(&mut self, pin: Pin, time: f64, level: bool) {
        self.edges.push(SynthEdge { pin, time, level });
    }
}

impl WireEvent {
    /// When the event's first edge is (core cycles).
    pub fn start(&self) -> f64 {
        match self {
            WireEvent::Uart { start, .. } => *start as f64,
            WireEvent::Spi { start, .. } => *start as f64,
            WireEvent::I2c {
                time, period, op, ..
            } => match op {
                I2cOp::Start { .. } => *time as f64 - 10.0 * period,
                I2cOp::Stop => *time as f64,
                _ => *time as f64 - 9.0 * period,
            },
        }
    }

    /// When its last edge is (core cycles).
    pub fn end(&self) -> f64 {
        match self {
            WireEvent::Uart { .. } => self.start(),
            WireEvent::Spi { end, .. } => *end as f64,
            WireEvent::I2c {
                time, period, op, ..
            } => *time as f64 + if *op == I2cOp::Stop { *period } else { 0.0 },
        }
    }

    /// How long after its first edge the event is logged (core cycles):
    /// a UART frame is logged as it starts, an SPI frame or I2C byte when
    /// it ends.
    pub fn latency(&self) -> f64 {
        match self {
            WireEvent::Uart { tx: true, .. } => 0.0,
            WireEvent::Uart { bit, .. } => 10.0 * bit,
            WireEvent::Spi { start, end, .. } => (end - start) as f64,
            WireEvent::I2c { time, .. } => *time as f64 - self.start(),
        }
    }

    /// The levels the event puts on its pins, in time order per pin. Levels
    /// that do not change are left in (the probes ignore them).
    pub fn edges(&self, edges: &mut Vec<SynthEdge>) {
        let mut o = Out { edges };
        match *self {
            WireEvent::Uart {
                pin,
                start,
                bit,
                data,
                data_bits,
                parity,
                ..
            } => {
                let t0 = start as f64;
                let mut bits: Vec<bool> = Vec::with_capacity(data_bits as usize);
                let payload_bits = if parity == Parity::None {
                    data_bits
                } else {
                    data_bits - 1
                };
                for i in 0..payload_bits {
                    bits.push(data >> i & 1 != 0);
                }
                if parity != Parity::None {
                    let ones = bits.iter().filter(|b| **b).count() as u32;
                    bits.push((ones % 2 == 1) ^ (parity == Parity::Odd));
                }
                o.put(pin, t0, false); // start bit
                for (i, &b) in bits.iter().enumerate() {
                    o.put(pin, t0 + (1 + i) as f64 * bit, b);
                }
                // Stop bit(s), then idle high.
                o.put(pin, t0 + (1 + bits.len()) as f64 * bit, true);
            }
            WireEvent::Spi {
                sck,
                mosi,
                miso,
                start,
                end,
                cpol,
                cpha,
                ref bytes,
            } => {
                let n = (bytes.len() * 8).max(1);
                let h = (end - start) as f64 / (2 * n) as f64;
                let t0 = start as f64;
                for (j, &(out, inp)) in bytes.iter().enumerate() {
                    for k in 0..8 {
                        let i = j * 8 + k;
                        let w = t0 + (2 * i) as f64 * h;
                        let (mo, mi) = (out >> (7 - k) & 1 != 0, inp >> (7 - k) & 1 != 0);
                        // CPHA 0: data before the leading edge, sampled on
                        // it. CPHA 1: data changes on the leading edge,
                        // sampled on the trailing one.
                        let (data_at, lead, trail) = if cpha {
                            (w, w, w + h)
                        } else {
                            (w, w + h, w + 2.0 * h)
                        };
                        o.put(mosi, data_at, mo);
                        if let Some(m) = miso {
                            o.put(m, data_at, mi);
                        }
                        o.put(sck, lead, !cpol);
                        o.put(sck, trail, cpol);
                    }
                }
            }
            WireEvent::I2c {
                scl,
                sda,
                time,
                period: p,
                op,
                reply,
                after,
            } => {
                let e = time as f64;
                let byte = |o: &mut Out, value: u8, ninth: bool| {
                    // Nine bits ending at e: SDA changes with SCL low, SCL
                    // high in each bit's second half.
                    let s = e - 9.0 * p;
                    for k in 0..9 {
                        let w = s + k as f64 * p;
                        let level = if k < 8 {
                            value >> (7 - k) & 1 != 0
                        } else {
                            ninth
                        };
                        o.put(sda, w + 0.25 * p, level);
                        o.put(scl, w + 0.5 * p, true);
                        o.put(scl, w + p, false);
                    }
                };
                // Acknowledge bit: low for ACK.
                let ack = |r: I2cReply| !matches!(r, I2cReply::Ack(true));
                match op {
                    I2cOp::Start { addr, read } => {
                        // (Repeated) START in the period before the address:
                        // SDA released, SCL high, SDA falls, SCL falls.
                        // (The model sets SB at once: the START gets the
                        // time between the previous operation and the
                        // address, a period at most.)
                        let s = e - 9.0 * p;
                        let q = (s - after).clamp(0.0, p);
                        o.put(sda, s - q, true);
                        o.put(scl, s - 0.75 * q, true);
                        o.put(sda, s - 0.5 * q, false);
                        o.put(scl, s, false);
                        byte(&mut o, addr << 1 | read as u8, ack(reply));
                    }
                    I2cOp::Write(b) => byte(&mut o, b, ack(reply)),
                    I2cOp::Read { ack: a } => {
                        let b = match reply {
                            I2cReply::Byte(b) => b,
                            I2cReply::Ack(_) => 0xFF,
                        };
                        byte(&mut o, b, !a);
                    }
                    I2cOp::Stop => {
                        // SDA low with SCL low, SCL rises, then SDA rises.
                        o.put(sda, e + 0.25 * p, false);
                        o.put(scl, e + 0.5 * p, true);
                        o.put(sda, e + p, true);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TX: Pin = (0, 2);

    fn edges(ev: &WireEvent) -> Vec<SynthEdge> {
        let mut v = Vec::new();
        ev.edges(&mut v);
        v
    }

    /// Level changes only (as a probe records them), per pin, starting
    /// from `idle`.
    fn changes(v: &[SynthEdge], pin: Pin, idle: bool) -> Vec<(f64, bool)> {
        let mut level = idle;
        let mut out = Vec::new();
        for e in v.iter().filter(|e| e.pin == pin) {
            if e.level != level {
                out.push((e.time, e.level));
                level = e.level;
            }
        }
        out
    }

    /// Level of `pin` at `t` from the changes.
    fn level_at(ch: &[(f64, bool)], idle: bool, t: f64) -> bool {
        ch.iter()
            .take_while(|e| e.0 <= t)
            .last()
            .map_or(idle, |e| e.1)
    }

    fn uart(data: u16, data_bits: u32, parity: Parity) -> WireEvent {
        // 115200 baud at 84 MHz: 729.17 cycles per bit.
        WireEvent::Uart {
            pin: TX,
            tx: true,
            start: 1000,
            bit: 84e6 / 115_200.0,
            data,
            data_bits,
            parity,
            stop_halves: 2,
        }
    }

    /// Sample a UART frame in the middle of each bit.
    fn sample_uart(ch: &[(f64, bool)], start: f64, bit: f64, n: usize) -> Vec<bool> {
        (0..n)
            .map(|i| level_at(ch, true, start + (i as f64 + 0.5) * bit))
            .collect()
    }

    #[test]
    fn uart_frame_bits_and_timing() {
        let ev = uart(b'A' as u16, 8, Parity::None);
        let bit = 84e6 / 115_200.0;
        let ch = changes(&edges(&ev), TX, true);
        // Start bit falls at the frame's start.
        assert_eq!(ch[0], (1000.0, false));
        // 'A' = 0x41: LSB first 1 0 0 0 0 0 1 0.
        let bits = sample_uart(&ch, 1000.0, bit, 10);
        assert_eq!(
            bits,
            vec![false, true, false, false, false, false, false, true, false, true]
        );
        // Every edge on a bit boundary at the baud rate.
        for (t, _) in &ch {
            let k = (t - 1000.0) / bit;
            assert!((k - k.round()).abs() < 1e-9, "edge at {k} bits");
        }
        // The stop bit starts 9 bits in, and the line stays high.
        let last = *ch.last().unwrap();
        assert!((last.0 - (1000.0 + 9.0 * bit)).abs() < 1e-6);
        assert!(last.1);
    }

    #[test]
    fn received_uart_frames_are_logged_a_frame_late() {
        // A received byte is logged when its stop bit arrived, its start
        // backdated: the scope has to hold back that long.
        let tx = uart(0x55, 8, Parity::None);
        assert_eq!(tx.latency(), 0.0);
        let mut rx = tx.clone();
        let WireEvent::Uart { tx: dir, bit, .. } = &mut rx else {
            unreachable!()
        };
        *dir = false;
        let bit = *bit;
        assert_eq!(rx.latency(), 10.0 * bit);
    }

    #[test]
    fn uart_even_and_odd_parity_replace_the_top_bit() {
        let bit = 84e6 / 115_200.0;
        // 9 data bits with parity: 8 payload bits + parity. 0x07 has three
        // ones: even parity 1, odd parity 0.
        for (parity, p) in [(Parity::Even, true), (Parity::Odd, false)] {
            let ch = changes(&edges(&uart(0x107, 9, parity)), TX, true);
            let bits = sample_uart(&ch, 1000.0, bit, 11);
            assert_eq!(
                &bits[1..9],
                &[true, true, true, false, false, false, false, false]
            );
            assert_eq!(bits[9], p, "{parity:?}");
            assert!(bits[10], "stop");
        }
    }

    fn spi(cpol: bool, cpha: bool) -> (WireEvent, Pin, Pin, Pin) {
        let (sck, mosi, miso) = ((0, 5), (0, 7), (0, 6));
        (
            WireEvent::Spi {
                sck,
                mosi,
                miso: Some(miso),
                start: 0,
                end: 1600, // 8 bits, 200 cycles each
                cpol,
                cpha,
                bytes: vec![(0xA5, 0x3C)],
            },
            sck,
            mosi,
            miso,
        )
    }

    #[test]
    fn spi_bits_are_valid_on_the_sampling_edge_in_every_mode() {
        for mode in 0..4 {
            let (cpol, cpha) = (mode & 2 != 0, mode & 1 != 0);
            let (ev, sck, mosi, miso) = spi(cpol, cpha);
            let v = edges(&ev);
            let clk = changes(&v, sck, cpol);
            assert_eq!(clk.len(), 16, "mode {mode}: 8 clock pulses");
            // Idle level before and after.
            assert_eq!(clk.last().unwrap().1, cpol, "mode {mode}");
            // Sampling edges: leading (idle → active) for CPHA 0, trailing
            // for CPHA 1.
            let sample: Vec<f64> = clk
                .iter()
                .filter(|e| (e.1 != cpol) != cpha)
                .map(|e| e.0)
                .collect();
            assert_eq!(sample.len(), 8);
            let mo = changes(&v, mosi, false);
            let mi = changes(&v, miso, false);
            let read = |ch: &[(f64, bool)]| {
                sample
                    .iter()
                    .fold(0u8, |a, &t| a << 1 | level_at(ch, false, t) as u8)
            };
            assert_eq!(read(&mo), 0xA5, "mode {mode} MOSI");
            assert_eq!(read(&mi), 0x3C, "mode {mode} MISO");
            // One SCK period every 200 cycles.
            assert!((sample[1] - sample[0] - 200.0).abs() < 1e-9);
            // Data never changes on a sampling edge.
            for t in &sample {
                assert!(mo.iter().all(|e| e.0 != *t), "mode {mode}");
            }
        }
    }

    const SCL: Pin = (1, 8);
    const SDA: Pin = (1, 9);

    fn i2c(time: Cycles, op: I2cOp, reply: I2cReply) -> WireEvent {
        // 100 kHz at 84 MHz: 840 cycles per SCL period.
        WireEvent::I2c {
            scl: SCL,
            sda: SDA,
            time,
            period: 840.0,
            op,
            reply,
            after: 0.0,
        }
    }

    /// Decode an I2C pin pair: START/STOP conditions and bytes sampled on
    /// SCL rising edges.
    fn decode(v: &[SynthEdge]) -> Vec<String> {
        let mut all: Vec<_> = v.to_vec();
        all.sort_by(|a, b| a.time.total_cmp(&b.time));
        let (mut scl, mut sda) = (true, true);
        let mut bits = Vec::new();
        let mut out = Vec::new();
        for e in all {
            if e.pin == SDA && e.level != sda {
                sda = e.level;
                if scl {
                    out.push(if sda { "P".into() } else { "S".into() });
                    bits.clear();
                }
            } else if e.pin == SCL && e.level != scl {
                scl = e.level;
                if scl {
                    bits.push(sda);
                    if bits.len() == 9 {
                        let b = bits[..8].iter().fold(0u8, |a, &x| a << 1 | x as u8);
                        out.push(format!("{b:02X}{}", if bits[8] { "N" } else { "A" }));
                        bits.clear();
                    }
                }
            }
        }
        out
    }

    #[test]
    fn i2c_start_address_ack_data_and_stop() {
        let p = 840.0;
        let t1 = 20_000;
        let t2 = t1 + 9 * 840;
        let mut v = Vec::new();
        i2c(
            t1,
            I2cOp::Start {
                addr: 0x76,
                read: false,
            },
            I2cReply::Ack(true),
        )
        .edges(&mut v);
        i2c(t2, I2cOp::Write(0xD0), I2cReply::Ack(true)).edges(&mut v);
        i2c(t2 + 1000, I2cOp::Stop, I2cReply::Ack(true)).edges(&mut v);
        assert_eq!(decode(&v), vec!["S", "ECA", "D0A", "P"]);
        // The START (SDA falling with SCL high) comes half a period before
        // the first clock falls, which starts the address byte 9 periods
        // before the ACK ends.
        let sda = changes(&v, SDA, true);
        let scl = changes(&v, SCL, true);
        let start = t1 as f64 - 9.0 * p;
        assert_eq!(sda[0], (start - 0.5 * p, false));
        assert_eq!(scl[0], (start, false));
        // 9 SCL pulses per byte, a period apart.
        let rises: Vec<f64> = scl.iter().filter(|e| e.1).map(|e| e.0).collect();
        assert!((rises[1] - rises[0] - p).abs() < 1e-9);
        // ACK: SDA low at the 9th rise.
        assert!(!level_at(&sda, true, rises[8]));
        // STOP: SDA rises a period after it was issued, SCL already high.
        let stop = (t2 + 1000) as f64;
        assert_eq!(*sda.last().unwrap(), (stop + p, true));
        assert_eq!(*scl.last().unwrap(), (stop + 0.5 * p, true));
    }

    #[test]
    fn i2c_nack_read_and_repeated_start() {
        let t1 = 20_000;
        let t2 = t1 + 9 * 840 + 3000;
        let t3 = t2 + 9 * 840;
        let mut v = Vec::new();
        i2c(
            t1,
            I2cOp::Start {
                addr: 0x3C,
                read: false,
            },
            I2cReply::Ack(false),
        )
        .edges(&mut v);
        // Repeated START for a read, one byte NACKed by the controller.
        i2c(
            t2,
            I2cOp::Start {
                addr: 0x3C,
                read: true,
            },
            I2cReply::Ack(true),
        )
        .edges(&mut v);
        i2c(t3, I2cOp::Read { ack: false }, I2cReply::Byte(0x5A)).edges(&mut v);
        i2c(t3, I2cOp::Stop, I2cReply::Ack(true)).edges(&mut v);
        assert_eq!(decode(&v), vec!["S", "78N", "S", "79A", "5AN", "P"]);
    }
}
