//! USART in asynchronous mode (RM0368 §19), connected to a host terminal.
//!
//! Transmission is timed from the baud rate: a byte written to DR moves to
//! the shift register, TXE/TC follow the frame timing, and the byte reaches
//! the terminal when its stop bit ends. The terminal has its own baud rate;
//! when the two differ, bytes are re-sampled the way a real UART receiver
//! would, so a wrong `BRR` (or wrong clock tree) shows up as garbage — just
//! like on the bench.

use std::collections::VecDeque;

use simucleo_core::sched::Scheduler;
use simucleo_core::Cycles;

use crate::rcc::Clocks;

// SR bits
pub const PE: u32 = 1 << 0;
pub const FE: u32 = 1 << 1;
pub const NF: u32 = 1 << 2;
pub const ORE: u32 = 1 << 3;
pub const IDLE: u32 = 1 << 4;
pub const RXNE: u32 = 1 << 5;
pub const TC: u32 = 1 << 6;
pub const TXE: u32 = 1 << 7;
// CR1 bits
const RE: u32 = 1 << 2;
const TE: u32 = 1 << 3;
const IDLEIE: u32 = 1 << 4;
const RXNEIE: u32 = 1 << 5;
const TCIE: u32 = 1 << 6;
const TXEIE: u32 = 1 << 7;
const PEIE: u32 = 1 << 8;
const M: u32 = 1 << 12;
const UE: u32 = 1 << 13;
const OVER8: u32 = 1 << 15;

/// What a scheduled USART event does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum UsartEventKind {
    TxDone,
    RxDeliver,
    Idle,
}

/// A byte as the host terminal received it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalByte {
    pub time: Cycles,
    pub byte: u8,
    /// The two sides' baud rates differ by more than 3 %: the byte was
    /// re-sampled and is probably garbage.
    pub garbled: bool,
}

#[derive(Debug, Clone)]
pub struct Usart {
    pub name: &'static str,
    pub irq: u16,
    /// USART1/6 run from PCLK2, USART2 from PCLK1.
    pub apb2: bool,
    pub sr: u32,
    rdr: u16,
    pub brr: u32,
    pub cr1: u32,
    pub cr2: u32,
    pub cr3: u32,
    pub gtpr: u32,
    tdr: Option<u16>,
    shifting: Option<u16>,
    sr_read: bool,
    rx_queue: VecDeque<u8>,
    rx_busy: bool,
    /// Bumped on disable so stale scheduled events are ignored.
    gen: u32,
    /// Baud rate of the connected terminal.
    pub host_baud: u32,
    pub terminal: Vec<TerminalByte>,
}

impl Usart {
    pub fn new(name: &'static str, irq: u16, apb2: bool) -> Self {
        Self {
            name,
            irq,
            apb2,
            sr: TXE | TC,
            rdr: 0,
            brr: 0,
            cr1: 0,
            cr2: 0,
            cr3: 0,
            gtpr: 0,
            tdr: None,
            shifting: None,
            sr_read: false,
            rx_queue: VecDeque::new(),
            rx_busy: false,
            gen: 0,
            host_baud: 115_200,
            terminal: Vec::new(),
        }
    }

    /// Peripheral reset (keeps the terminal connection and its log).
    pub fn reset(&mut self) {
        let (host_baud, terminal) = (self.host_baud, std::mem::take(&mut self.terminal));
        let gen = self.gen + 1;
        *self = Self::new(self.name, self.irq, self.apb2);
        self.host_baud = host_baud;
        self.terminal = terminal;
        self.gen = gen;
    }

    fn enabled(&self) -> bool {
        self.cr1 & UE != 0
    }

    /// Divider D such that baud = f_ck / D.
    fn divider(&self) -> u32 {
        if self.cr1 & OVER8 != 0 {
            8 * (self.brr >> 4) + (self.brr & 7)
        } else {
            self.brr & 0xFFFF
        }
    }

    pub fn baud(&self, clocks: &Clocks) -> Option<f64> {
        let d = self.divider();
        if d < 8 {
            return None;
        }
        let fck = if self.apb2 {
            clocks.pclk2
        } else {
            clocks.pclk1
        };
        Some(fck as f64 / d as f64)
    }

    fn data_bits(&self) -> u32 {
        if self.cr1 & M != 0 {
            9
        } else {
            8
        }
    }

    /// Stop bits ×2 (to represent 0.5 and 1.5).
    fn stop_halves(&self) -> u32 {
        match (self.cr2 >> 12) & 3 {
            0 => 2,
            1 => 1,
            2 => 4,
            _ => 3,
        }
    }

    /// One frame in core clock cycles.
    fn frame_cycles(&self, clocks: &Clocks) -> Option<Cycles> {
        let baud = self.baud(clocks)?;
        let bits = 1.0 + self.data_bits() as f64 + self.stop_halves() as f64 / 2.0;
        Some(((bits * clocks.hclk as f64 / baud).round() as Cycles).max(1))
    }

    /// Interrupt request line level.
    pub fn irq_line(&self) -> bool {
        let (sr, cr1) = (self.sr, self.cr1);
        self.enabled()
            && ((cr1 & TXEIE != 0 && sr & TXE != 0)
                || (cr1 & TCIE != 0 && sr & TC != 0)
                || (cr1 & RXNEIE != 0 && sr & (RXNE | ORE) != 0)
                || (cr1 & IDLEIE != 0 && sr & IDLE != 0)
                || (cr1 & PEIE != 0 && sr & PE != 0))
    }

    pub fn read(&mut self, offset: u32) -> u32 {
        match offset {
            0x00 => {
                self.sr_read = true;
                self.sr
            }
            0x04 => {
                let v = self.rdr as u32;
                self.sr &= !RXNE;
                if self.sr_read {
                    self.sr &= !(ORE | NF | FE | PE | IDLE);
                    self.sr_read = false;
                }
                v
            }
            0x08 => self.brr,
            0x0C => self.cr1,
            0x10 => self.cr2,
            0x14 => self.cr3,
            0x18 => self.gtpr,
            _ => 0,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn write(
        &mut self,
        idx: u8,
        offset: u32,
        value: u32,
        lanes: u32,
        now: Cycles,
        clocks: &Clocks,
        sched: &mut Scheduler<crate::Event>,
    ) {
        let m = |old: u32| (old & !lanes) | (value & lanes);
        match offset {
            0x00 => {
                // RXNE, TC, LBD, CTS are rc_w0: writing 0 clears them.
                let clearable = (RXNE | TC | (1 << 8) | (1 << 9)) & lanes;
                self.sr &= !clearable | (value & clearable);
            }
            0x04 => {
                if self.sr_read {
                    self.sr &= !TC;
                    self.sr_read = false;
                }
                let data = (value & 0x1FF) as u16;
                if !self.enabled() || self.cr1 & TE == 0 {
                    return;
                }
                if self.shifting.is_none() {
                    self.start_shift(idx, data, now, clocks, sched);
                } else {
                    self.tdr = Some(data);
                    self.sr &= !TXE;
                }
            }
            0x08 => self.brr = m(self.brr) & 0xFFFF,
            0x0C => {
                let was_enabled = self.enabled();
                let was_rx = self.cr1 & RE != 0;
                self.cr1 = m(self.cr1) & 0xBFFF;
                if was_enabled && !self.enabled() {
                    // Disabling aborts transfers.
                    self.gen += 1;
                    self.shifting = None;
                    self.tdr = None;
                    self.rx_busy = false;
                    self.sr |= TXE | TC;
                }
                if self.enabled() && self.cr1 & RE != 0 && (!was_rx || !was_enabled) {
                    self.kick_rx(idx, now, clocks, sched);
                }
            }
            0x10 => self.cr2 = m(self.cr2) & 0x7F7F,
            0x14 => self.cr3 = m(self.cr3) & 0x0FFF,
            0x18 => self.gtpr = m(self.gtpr) & 0xFFFF,
            _ => {}
        }
    }

    fn start_shift(
        &mut self,
        idx: u8,
        data: u16,
        now: Cycles,
        clocks: &Clocks,
        sched: &mut Scheduler<crate::Event>,
    ) {
        self.shifting = Some(data);
        self.sr |= TXE;
        self.sr &= !TC;
        if let Some(frame) = self.frame_cycles(clocks) {
            sched.schedule_at(
                now + frame,
                crate::Event::Usart {
                    idx,
                    kind: UsartEventKind::TxDone,
                    gen: self.gen,
                },
            );
        }
    }

    fn kick_rx(
        &mut self,
        idx: u8,
        now: Cycles,
        clocks: &Clocks,
        sched: &mut Scheduler<crate::Event>,
    ) {
        if self.rx_busy || self.rx_queue.is_empty() || !self.enabled() || self.cr1 & RE == 0 {
            return;
        }
        // The terminal sends at its own baud rate (8N1), whatever the
        // receiver is configured for.
        if self.baud(clocks).is_some() {
            let frame =
                ((10.0 * clocks.hclk as f64 / self.host_baud as f64).round() as Cycles).max(1);
            self.rx_busy = true;
            sched.schedule_at(
                now + frame,
                crate::Event::Usart {
                    idx,
                    kind: UsartEventKind::RxDeliver,
                    gen: self.gen,
                },
            );
        }
    }

    /// Bytes typed into the terminal.
    pub fn host_send(
        &mut self,
        idx: u8,
        bytes: &[u8],
        now: Cycles,
        clocks: &Clocks,
        sched: &mut Scheduler<crate::Event>,
    ) {
        self.rx_queue.extend(bytes);
        self.kick_rx(idx, now, clocks, sched);
    }

    pub fn event(
        &mut self,
        idx: u8,
        kind: UsartEventKind,
        gen: u32,
        now: Cycles,
        clocks: &Clocks,
        sched: &mut Scheduler<crate::Event>,
    ) {
        if gen != self.gen {
            return;
        }
        match kind {
            UsartEventKind::TxDone => {
                if let Some(data) = self.shifting.take() {
                    let (byte, garbled) = self.seen_by_host(data, clocks);
                    self.terminal.push(TerminalByte {
                        time: now,
                        byte,
                        garbled,
                    });
                }
                if let Some(next) = self.tdr.take() {
                    self.start_shift(idx, next, now, clocks, sched);
                } else {
                    self.sr |= TC;
                }
            }
            UsartEventKind::RxDeliver => {
                self.rx_busy = false;
                if let Some(b) = self.rx_queue.pop_front() {
                    let data = self.received_from_host(b, clocks);
                    if self.sr & RXNE != 0 {
                        self.sr |= ORE; // previous byte not read: this one is lost
                    } else {
                        self.rdr = data;
                        self.sr |= RXNE;
                    }
                }
                if self.rx_queue.is_empty() {
                    if let Some(frame) = self.frame_cycles(clocks) {
                        sched.schedule_at(
                            now + frame,
                            crate::Event::Usart {
                                idx,
                                kind: UsartEventKind::Idle,
                                gen: self.gen,
                            },
                        );
                    }
                } else {
                    self.kick_rx(idx, now, clocks, sched);
                }
            }
            UsartEventKind::Idle => {
                if self.rx_queue.is_empty() && !self.rx_busy {
                    self.sr |= IDLE;
                }
            }
        }
    }

    fn mismatch(&self, clocks: &Clocks) -> Option<f64> {
        let baud = self.baud(clocks)?;
        let ratio = baud / self.host_baud as f64;
        ((ratio - 1.0).abs() > 0.03).then_some(ratio)
    }

    /// The byte the terminal decodes from a transmitted frame.
    fn seen_by_host(&self, data: u16, clocks: &Clocks) -> (u8, bool) {
        let payload = if self.cr1 & (1 << 10) != 0 {
            // Parity enabled: MSB of the data field is the parity bit.
            data & ((1 << (self.data_bits() - 1)) - 1)
        } else {
            data
        };
        match self.mismatch(clocks) {
            None => (payload as u8, false),
            // tx bit time / rx bit time = host_baud / baud
            Some(ratio) => (resample(data, self.data_bits(), 1.0 / ratio), true),
        }
    }

    fn received_from_host(&self, byte: u8, clocks: &Clocks) -> u16 {
        match self.mismatch(clocks) {
            None => byte as u16,
            Some(ratio) => resample(byte as u16, 8, ratio) as u16,
        }
    }
}

/// Decode a UART frame transmitted with bit time `t_tx` by a receiver with
/// bit time 1.0, where `t_tx` is given relative to the receiver
/// (`t_tx = rx_baud / tx_baud`). The receiver syncs on the start bit edge
/// and samples each data bit in its middle; after the frame the line idles
/// high.
fn resample(data: u16, data_bits: u32, t_tx: f64) -> u8 {
    let level = |t: f64| -> bool {
        let idx = (t / t_tx).floor() as i64;
        match idx {
            0 => false, // start bit
            i if (1..=data_bits as i64).contains(&i) => data >> (i - 1) & 1 != 0,
            _ => true, // stop / idle
        }
    };
    (0..8).fold(0u8, |acc, i| acc | (level(1.5 + i as f64) as u8) << i)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Event;

    fn clocks(pclk1: u32) -> Clocks {
        Clocks {
            sysclk: 84_000_000,
            hclk: 84_000_000,
            pclk1,
            pclk2: 84_000_000,
            tim_apb1: 84_000_000,
            tim_apb2: 84_000_000,
        }
    }

    fn drain(u: &mut Usart, sched: &mut Scheduler<Event>, c: &Clocks) {
        while let Some(t) = sched.next_deadline() {
            sched.advance_to(t);
            while let Some((at, Event::Usart { idx, kind, gen })) = sched.pop_due() {
                u.event(idx, kind, gen, at, c, sched);
            }
        }
    }

    #[test]
    fn transmit_timing_and_flags() {
        let c = clocks(42_000_000);
        let mut sched = Scheduler::new();
        let mut u = Usart::new("USART2", 38, false);
        // HAL: BRR for 115200 at 42 MHz = 0x16D (USARTDIV 22.8125)
        u.write(1, 0x08, 0x16D, u32::MAX, 0, &c, &mut sched);
        u.write(1, 0x0C, UE | TE | RE, u32::MAX, 0, &c, &mut sched);
        assert!((u.baud(&c).unwrap() - 115_068.5).abs() < 1.0);
        u.write(1, 0x04, b'O' as u32, u32::MAX, 0, &c, &mut sched);
        assert_eq!(
            u.sr & (TXE | TC),
            TXE,
            "first byte goes straight to the shift register"
        );
        u.write(1, 0x04, b'K' as u32, u32::MAX, 0, &c, &mut sched);
        assert_eq!(u.sr & TXE, 0, "second byte waits in TDR");
        // one 10-bit frame = 10 * 84e6 / 115068.5 ≈ 7300 cycles
        assert_eq!(sched.next_deadline(), Some(7300));
        drain(&mut u, &mut sched, &c);
        let text: Vec<u8> = u.terminal.iter().map(|b| b.byte).collect();
        assert_eq!(text, b"OK");
        assert!(u.terminal.iter().all(|b| !b.garbled));
        assert_eq!(u.terminal[1].time, 14_600);
        assert_eq!(u.sr & (TXE | TC), TXE | TC);
    }

    #[test]
    fn wrong_baud_rate_garbles_output() {
        let c = clocks(42_000_000);
        let mut sched = Scheduler::new();
        let mut u = Usart::new("USART2", 38, false);
        // Configured as if PCLK1 were 16 MHz: 115200 → BRR 0x8B, but PCLK1
        // is really 42 MHz → 302 kbaud on the wire.
        u.write(1, 0x08, 0x8B, u32::MAX, 0, &c, &mut sched);
        u.write(1, 0x0C, UE | TE, u32::MAX, 0, &c, &mut sched);
        u.write(1, 0x04, b'A' as u32, u32::MAX, 0, &c, &mut sched);
        drain(&mut u, &mut sched, &c);
        assert!(u.terminal[0].garbled);
        assert_ne!(u.terminal[0].byte, b'A');
    }

    #[test]
    fn receive_overrun_and_irq() {
        let c = clocks(42_000_000);
        let mut sched = Scheduler::new();
        let mut u = Usart::new("USART2", 38, false);
        u.write(1, 0x08, 0x16D, u32::MAX, 0, &c, &mut sched);
        u.write(1, 0x0C, UE | RE | RXNEIE, u32::MAX, 0, &c, &mut sched);
        assert!(!u.irq_line());
        u.host_send(1, b"hi", 0, &c, &mut sched);
        drain(&mut u, &mut sched, &c);
        assert!(u.irq_line());
        assert_ne!(
            u.sr & ORE,
            0,
            "second byte arrived before the first was read"
        );
        assert_ne!(u.sr & IDLE, 0);
        assert_eq!(u.read(0x00) & RXNE, RXNE);
        assert_eq!(u.read(0x04), b'h' as u32);
        assert_eq!(
            u.sr & (ORE | RXNE | IDLE),
            0,
            "SR then DR read clears ORE/IDLE"
        );
        assert!(!u.irq_line());
    }

    #[test]
    fn terminal_input_arrives_at_the_terminal_baud_rate() {
        // HCLK 16 MHz, USART at 115200 (BRR 139), terminal at 9600.
        let c = Clocks {
            sysclk: 16_000_000,
            hclk: 16_000_000,
            pclk1: 16_000_000,
            pclk2: 16_000_000,
            tim_apb1: 16_000_000,
            tim_apb2: 16_000_000,
        };
        let mut sched = Scheduler::new();
        let mut u = Usart::new("USART2", 38, false);
        u.host_baud = 9600;
        u.write(1, 0x08, 139, u32::MAX, 0, &c, &mut sched);
        u.write(1, 0x0C, UE | RE, u32::MAX, 0, &c, &mut sched);
        u.host_send(1, b"x", 0, &c, &mut sched);
        // 10 bits at 9600 baud = 1.0417 ms = 16 667 cycles
        assert_eq!(sched.next_deadline(), Some(16_667));
    }

    #[test]
    fn resample_identity_at_equal_rates() {
        for b in [0u16, 0x55, 0xA5, 0xFF] {
            assert_eq!(resample(b, 8, 1.0), b as u8);
        }
    }
}
