//! I2C1–3 in master mode (RM0368 §18), connected to devices on the bus at
//! transaction level (start/address, byte, stop) rather than bit level.
//!
//! The flag sequence follows the hardware closely enough for the HAL's
//! polling and interrupt drivers: SB after START, ADDR (or AF on NACK)
//! after the address byte, TXE/BTF while transmitting, RXNE/BTF while
//! receiving with clock stretching when DR is full, ACK/POS deciding which
//! received byte is NACKed, STOP after the current byte. Each byte takes
//! nine SCL periods derived from CCR and PCLK1. Not modelled: slave mode,
//! 10-bit addressing, SMBus/PEC, DMA requests, arbitration loss.

use simucleo_core::sched::Scheduler;
use simucleo_core::Cycles;

use crate::rcc::Clocks;

// CR1
const PE: u32 = 1 << 0;
const START: u32 = 1 << 8;
const STOP: u32 = 1 << 9;
const ACK: u32 = 1 << 10;
const POS: u32 = 1 << 11;
const SWRST: u32 = 1 << 15;
// CR2
const ITERREN: u32 = 1 << 8;
const ITEVTEN: u32 = 1 << 9;
const ITBUFEN: u32 = 1 << 10;
// SR1
pub const SB: u32 = 1 << 0;
pub const ADDR: u32 = 1 << 1;
pub const BTF: u32 = 1 << 2;
pub const RXNE: u32 = 1 << 6;
pub const TXE: u32 = 1 << 7;
pub const BERR: u32 = 1 << 8;
pub const AF: u32 = 1 << 10;
/// Error flags (rc_w0), reported on the error interrupt.
const ERRORS: u32 = 0xDF00;
// SR2
const MSL: u32 = 1 << 0;
const BUSY: u32 = 1 << 1;
const TRA: u32 = 1 << 2;

/// What the controller asks of the bus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum I2cOp {
    /// START (or repeated START) followed by the 7-bit address and the R/W
    /// bit. The answer is whether a device acknowledged.
    Start {
        addr: u8,
        read: bool,
    },
    /// A byte from the controller; the answer is the device's ACK.
    Write(u8),
    /// A byte from the device; `ack` is what the controller answers.
    Read {
        ack: bool,
    },
    Stop,
}

/// The bus's answer: an acknowledge bit, or a byte read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum I2cReply {
    Ack(bool),
    Byte(u8),
}

/// Devices on an I2C bus (the external circuit).
pub trait I2cBus {
    fn transfer(&mut self, op: I2cOp) -> I2cReply;
}

/// No device answers.
pub struct NoDevices;

impl I2cBus for NoDevices {
    fn transfer(&mut self, op: I2cOp) -> I2cReply {
        match op {
            I2cOp::Read { .. } => I2cReply::Byte(0xFF),
            _ => I2cReply::Ack(false),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Idle,
    /// Address byte on the wire.
    Address {
        read: bool,
    },
    /// ADDR set; waiting for software to clear it.
    AddrWait {
        read: bool,
    },
    /// Transmitting the byte in `shift`.
    Tx,
    /// Transmitter idle (BTF or waiting for DR).
    TxIdle,
    /// Receiving a byte.
    Rx,
    /// Receiver stalled: DR and the shift register are full (BTF).
    RxStall,
    /// The last byte was NACKed; waiting for STOP or a restart.
    RxDone,
    /// NACK received while transmitting.
    Nacked,
}

#[derive(Debug, Clone)]
pub struct I2c {
    pub name: &'static str,
    pub irq_ev: u16,
    pub irq_er: u16,
    pub cr1: u32,
    pub cr2: u32,
    pub oar1: u32,
    pub oar2: u32,
    pub dr: u8,
    pub sr1: u32,
    pub sr2: u32,
    pub ccr: u32,
    pub trise: u32,
    pub fltr: u32,
    phase: Phase,
    /// Byte in the shift register (transmit: being sent; receive: held
    /// while DR is full).
    shift: Option<u8>,
    /// DR holds a byte to transmit (TXE clear).
    tx_pending: bool,
    /// Bytes received in this read transfer (for POS).
    rx_count: u32,
    /// ACK decided for the byte now being received under POS.
    pos_ack: bool,
    /// Address byte of the pending (repeated) START.
    restart: bool,
    pub gen: u32,
}

impl I2c {
    pub fn new(name: &'static str, irq_ev: u16, irq_er: u16) -> Self {
        Self {
            name,
            irq_ev,
            irq_er,
            cr1: 0,
            cr2: 0,
            oar1: 0,
            oar2: 0,
            dr: 0,
            sr1: 0,
            sr2: 0,
            ccr: 0,
            trise: 2,
            fltr: 0,
            phase: Phase::Idle,
            shift: None,
            tx_pending: false,
            rx_count: 0,
            pos_ack: true,
            restart: false,
            gen: 0,
        }
    }

    pub fn reset(&mut self) {
        let gen = self.gen.wrapping_add(1);
        *self = Self::new(self.name, self.irq_ev, self.irq_er);
        self.gen = gen;
    }

    /// One byte (8 bits + acknowledge) in core cycles.
    pub fn byte_cycles(&self, clocks: &Clocks) -> Cycles {
        let ccr = (self.ccr & 0xFFF).max(1) as u64;
        // SCL period in PCLK1 cycles: standard mode 2·CCR, fast mode
        // 3·CCR (duty 2:1) or 25·CCR (duty 16:9).
        let pclks = if self.ccr & (1 << 15) == 0 {
            2 * ccr
        } else if self.ccr & (1 << 14) == 0 {
            3 * ccr
        } else {
            25 * ccr
        };
        (9 * pclks * clocks.hclk as u64)
            .div_ceil(clocks.pclk1.max(1) as u64)
            .max(1)
    }

    /// Event and error interrupt request lines.
    pub fn irq_lines(&self) -> (bool, bool) {
        let ev = self.cr2 & ITEVTEN != 0
            && (self.sr1 & (SB | ADDR | BTF) != 0
                || (self.cr2 & ITBUFEN != 0 && self.sr1 & (TXE | RXNE) != 0));
        let er = self.cr2 & ITERREN != 0 && self.sr1 & ERRORS != 0;
        (ev, er)
    }

    fn schedule(
        &mut self,
        now: Cycles,
        clocks: &Clocks,
        sched: &mut Scheduler<crate::Event>,
        idx: u8,
    ) {
        self.gen = self.gen.wrapping_add(1);
        let at = now + self.byte_cycles(clocks);
        sched.schedule_at(at, crate::Event::I2c { idx, gen: self.gen });
    }

    fn stop(&mut self, bus: &mut dyn I2cBus) {
        bus.transfer(I2cOp::Stop);
        self.cr1 &= !STOP;
        self.sr2 &= !(MSL | BUSY | TRA);
        self.sr1 &= !(TXE | BTF);
        self.phase = Phase::Idle;
        self.shift = None;
        self.tx_pending = false;
        self.gen = self.gen.wrapping_add(1);
    }

    /// Issue the START the software asked for (now, or after the byte in
    /// progress for a repeated START).
    fn do_start(&mut self) {
        self.cr1 &= !START;
        self.sr1 |= SB;
        self.sr1 &= !(TXE | BTF | RXNE);
        self.sr2 |= MSL | BUSY;
        self.phase = Phase::Idle;
        self.shift = None;
        self.tx_pending = false;
        self.restart = true;
    }

    pub fn read(&mut self, offset: u32) -> u32 {
        match offset {
            0x00 => self.cr1,
            0x04 => self.cr2,
            0x08 => self.oar1,
            0x0C => self.oar2,
            0x10 => self.dr as u32,
            0x14 => self.sr1,
            0x18 => {
                // Reading SR2 after SR1 clears ADDR.
                let v = self.sr2;
                self.sr1 &= !ADDR;
                v
            }
            0x1C => self.ccr,
            0x20 => self.trise,
            0x24 => self.fltr,
            _ => 0,
        }
    }

    pub fn peek(&self, offset: u32) -> u32 {
        match offset {
            0x18 => self.sr2,
            0x10 => self.dr as u32,
            _ => self.clone().read(offset),
        }
    }

    /// Software side effects that need the bus or the scheduler: reading
    /// DR, clearing ADDR. Call after `read`.
    pub fn after_read(
        &mut self,
        offset: u32,
        now: Cycles,
        clocks: &Clocks,
        sched: &mut Scheduler<crate::Event>,
        idx: u8,
        bus: &mut dyn I2cBus,
    ) {
        match offset {
            0x18 => {
                if let Phase::AddrWait { read } = self.phase {
                    if read {
                        self.rx_count = 0;
                        self.pos_ack = true;
                        self.phase = Phase::Rx;
                        self.schedule(now, clocks, sched, idx);
                    } else {
                        self.phase = Phase::TxIdle;
                        self.sr1 |= TXE;
                    }
                }
            }
            0x10 if self.sr1 & RXNE != 0 => {
                self.sr1 &= !RXNE;
                if let Some(b) = self.shift.take() {
                    // The held byte moves into DR; reception resumes.
                    self.dr = b;
                    self.sr1 |= RXNE;
                    self.sr1 &= !BTF;
                    if self.phase == Phase::RxStall {
                        self.phase = Phase::Rx;
                        self.schedule(now, clocks, sched, idx);
                    }
                }
                if self.phase == Phase::RxDone && self.cr1 & STOP != 0 && self.shift.is_none() {
                    self.stop(bus);
                }
            }
            _ => {}
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn write(
        &mut self,
        offset: u32,
        value: u32,
        lanes: u32,
        now: Cycles,
        clocks: &Clocks,
        sched: &mut Scheduler<crate::Event>,
        idx: u8,
        bus: &mut dyn I2cBus,
    ) {
        let merge = |old: u32| (old & !lanes) | (value & lanes);
        match offset {
            0x00 => {
                let v = merge(self.cr1);
                if v & SWRST != 0 {
                    let gen = self.gen.wrapping_add(1);
                    *self = Self::new(self.name, self.irq_ev, self.irq_er);
                    self.gen = gen;
                    self.cr1 = SWRST;
                    return;
                }
                self.cr1 = v;
                if self.cr1 & PE == 0 {
                    self.phase = Phase::Idle;
                    self.sr1 = 0;
                    self.sr2 = 0;
                    self.gen = self.gen.wrapping_add(1);
                    return;
                }
                if self.cr1 & START != 0 {
                    // A repeated START waits for the byte in progress.
                    if !matches!(self.phase, Phase::Tx | Phase::Rx | Phase::Address { .. }) {
                        self.do_start();
                    }
                }
                if self.cr1 & STOP != 0 && self.sr2 & MSL != 0 {
                    match self.phase {
                        Phase::TxIdle | Phase::Nacked | Phase::Idle | Phase::AddrWait { .. } => {
                            self.stop(bus)
                        }
                        Phase::RxDone if self.sr1 & RXNE == 0 || self.shift.is_none() => {
                            // Data already received stays readable in DR.
                            let (dr, rxne) = (self.dr, self.sr1 & RXNE);
                            self.stop(bus);
                            self.dr = dr;
                            self.sr1 |= rxne;
                        }
                        Phase::RxStall => {
                            // The held byte was the last: the STOP goes out
                            // now, both bytes stay readable.
                            let (dr, shift) = (self.dr, self.shift);
                            bus.transfer(I2cOp::Stop);
                            self.cr1 &= !STOP;
                            self.sr2 &= !(MSL | BUSY);
                            self.phase = Phase::RxDone;
                            self.dr = dr;
                            self.shift = shift;
                            self.gen = self.gen.wrapping_add(1);
                        }
                        _ => {} // after the byte in progress
                    }
                }
            }
            0x04 => self.cr2 = merge(self.cr2),
            0x08 => self.oar1 = merge(self.oar1),
            0x0C => self.oar2 = merge(self.oar2),
            0x10 => {
                let b = (value & lanes & 0xFF) as u8;
                self.dr = b;
                if self.sr1 & SB != 0 {
                    // Address byte.
                    self.sr1 &= !SB;
                    let read = b & 1 != 0;
                    self.phase = Phase::Address { read };
                    self.shift = Some(b);
                    self.schedule(now, clocks, sched, idx);
                } else if matches!(self.phase, Phase::TxIdle) {
                    self.sr1 &= !BTF;
                    self.shift = Some(b);
                    self.phase = Phase::Tx;
                    self.sr1 |= TXE;
                    self.schedule(now, clocks, sched, idx);
                } else if self.phase == Phase::Tx {
                    self.tx_pending = true;
                    self.sr1 &= !TXE;
                }
            }
            0x14 => {
                // Only the error flags are writable (rc_w0).
                self.sr1 &= (value | !lanes) | !ERRORS;
            }
            0x1C => self.ccr = merge(self.ccr) & 0xCFFF,
            0x20 => self.trise = merge(self.trise) & 0x3F,
            0x24 => self.fltr = merge(self.fltr) & 0x1F,
            _ => {}
        }
    }

    /// The byte on the wire finished.
    pub fn event(
        &mut self,
        now: Cycles,
        clocks: &Clocks,
        sched: &mut Scheduler<crate::Event>,
        idx: u8,
        bus: &mut dyn I2cBus,
    ) {
        match self.phase {
            Phase::Address { read } => {
                let b = self.shift.take().unwrap_or(0);
                let acked = matches!(
                    bus.transfer(I2cOp::Start { addr: b >> 1, read }),
                    I2cReply::Ack(true)
                );
                self.restart = false;
                if acked {
                    self.sr1 |= ADDR;
                    if read {
                        self.sr2 &= !TRA;
                    } else {
                        self.sr2 |= TRA;
                    }
                    self.phase = Phase::AddrWait { read };
                } else {
                    self.sr1 |= AF;
                    self.phase = Phase::Nacked;
                }
            }
            Phase::Tx => {
                let b = self.shift.take().unwrap_or(0);
                let acked = matches!(bus.transfer(I2cOp::Write(b)), I2cReply::Ack(true));
                if !acked {
                    self.sr1 |= AF;
                    self.phase = Phase::Nacked;
                    self.tx_pending = false;
                } else if self.cr1 & START != 0 {
                    self.do_start();
                } else if self.cr1 & STOP != 0 {
                    self.stop(bus);
                } else if self.tx_pending {
                    self.tx_pending = false;
                    self.shift = Some(self.dr);
                    self.sr1 |= TXE;
                    self.schedule(now, clocks, sched, idx);
                } else {
                    self.phase = Phase::TxIdle;
                    self.sr1 |= BTF | TXE;
                }
            }
            Phase::Rx => {
                // The (N)ACK for this byte: with POS it was decided one byte
                // ahead, otherwise ACK is sampled now.
                let ack = if self.cr1 & POS != 0 {
                    let a = self.pos_ack;
                    self.pos_ack = self.cr1 & ACK != 0;
                    a
                } else {
                    self.cr1 & ACK != 0
                };
                let b = match bus.transfer(I2cOp::Read { ack }) {
                    I2cReply::Byte(b) => b,
                    I2cReply::Ack(_) => 0xFF,
                };
                self.rx_count += 1;
                if self.sr1 & RXNE == 0 {
                    self.dr = b;
                    self.sr1 |= RXNE;
                } else {
                    self.shift = Some(b);
                    self.sr1 |= BTF;
                }
                if !ack {
                    self.phase = Phase::RxDone;
                    if self.cr1 & STOP != 0 && self.shift.is_none() {
                        let dr = self.dr;
                        self.stop(bus);
                        self.dr = dr;
                        self.sr1 |= RXNE;
                    }
                } else if self.cr1 & START != 0 && self.shift.is_none() {
                    self.do_start();
                } else if self.cr1 & STOP != 0 && self.shift.is_none() {
                    let dr = self.dr;
                    self.stop(bus);
                    self.dr = dr;
                    self.sr1 |= RXNE;
                } else if self.shift.is_some() {
                    self.phase = Phase::RxStall;
                } else {
                    self.schedule(now, clocks, sched, idx);
                }
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A device at 0x3C holding bytes to read; records what it saw.
    #[derive(Default)]
    struct Dev {
        log: Vec<String>,
        data: Vec<u8>,
    }

    impl I2cBus for Dev {
        fn transfer(&mut self, op: I2cOp) -> I2cReply {
            self.log.push(format!("{op:?}"));
            match op {
                I2cOp::Start { addr, .. } => I2cReply::Ack(addr == 0x3C),
                I2cOp::Write(_) => I2cReply::Ack(true),
                I2cOp::Read { .. } => I2cReply::Byte(if self.data.is_empty() {
                    0xFF
                } else {
                    self.data.remove(0)
                }),
                I2cOp::Stop => I2cReply::Ack(true),
            }
        }
    }

    struct Rig {
        i2c: I2c,
        dev: Dev,
        sched: Scheduler<crate::Event>,
        clocks: Clocks,
        now: Cycles,
    }

    impl Rig {
        fn new() -> Self {
            let mut i2c = I2c::new("I2C1", 31, 32);
            i2c.cr1 = PE;
            i2c.ccr = 210; // 100 kHz at 42 MHz
            Self {
                i2c,
                dev: Dev::default(),
                sched: Scheduler::new(),
                clocks: Clocks {
                    sysclk: 84_000_000,
                    hclk: 84_000_000,
                    pclk1: 42_000_000,
                    pclk2: 84_000_000,
                    tim_apb1: 84_000_000,
                    tim_apb2: 84_000_000,
                },
                now: 0,
            }
        }
        fn w(&mut self, off: u32, v: u32) {
            self.i2c.write(
                off,
                v,
                u32::MAX,
                self.now,
                &self.clocks,
                &mut self.sched,
                0,
                &mut self.dev,
            );
        }
        fn r(&mut self, off: u32) -> u32 {
            let v = self.i2c.read(off);
            self.i2c.after_read(
                off,
                self.now,
                &self.clocks,
                &mut self.sched,
                0,
                &mut self.dev,
            );
            v
        }
        /// Run scheduled byte completions until `flag` (SR1) is set.
        fn wait(&mut self, flag: u32) {
            for _ in 0..10 {
                if self.i2c.sr1 & flag != 0 {
                    return;
                }
                let Some(at) = self.sched.next_deadline() else {
                    break;
                };
                self.now = at;
                self.sched.advance_to(at);
                while let Some((_, crate::Event::I2c { gen, .. })) = self.sched.pop_due() {
                    if gen == self.i2c.gen {
                        self.i2c
                            .event(self.now, &self.clocks, &mut self.sched, 0, &mut self.dev);
                    }
                }
            }
            assert_ne!(
                self.i2c.sr1 & flag,
                0,
                "flag {flag:#x} never set (SR1 {:#x})",
                self.i2c.sr1
            );
        }
    }

    #[test]
    fn byte_time_at_100khz() {
        let r = Rig::new();
        // 9 bits × 10 µs at 84 MHz.
        assert_eq!(r.i2c.byte_cycles(&r.clocks), 7560);
    }

    #[test]
    fn hal_master_transmit_sequence() {
        let mut r = Rig::new();
        r.w(0x00, PE | START);
        r.wait(SB);
        r.w(0x10, 0x3C << 1);
        r.wait(ADDR);
        r.r(0x14);
        r.r(0x18);
        for b in [0x00, 0xAF, 0x81] {
            r.wait(TXE);
            r.w(0x10, b);
        }
        r.wait(BTF);
        r.w(0x00, PE | STOP);
        assert_eq!(r.i2c.sr2 & BUSY, 0);
        assert_eq!(
            r.dev.log,
            [
                "Start { addr: 60, read: false }",
                "Write(0)",
                "Write(175)",
                "Write(129)",
                "Stop"
            ]
        );
    }

    #[test]
    fn nack_on_address_sets_af() {
        let mut r = Rig::new();
        r.w(0x00, PE | START);
        r.wait(SB);
        r.w(0x10, 0x50 << 1);
        r.wait(AF);
        r.w(0x00, PE | STOP);
        r.w(0x14, !AF);
        assert_eq!(r.i2c.sr1 & AF, 0);
        assert_eq!(r.dev.log.last().unwrap(), "Stop");
    }

    /// HAL_I2C_Master_Receive for 1, 2 and 4 bytes (the three code paths).
    #[test]
    fn hal_master_receive_sequences() {
        // One byte: ACK off before clearing ADDR, then STOP.
        let mut r = Rig::new();
        r.dev.data = vec![0x11];
        r.w(0x00, PE | ACK | START);
        r.wait(SB);
        r.w(0x10, (0x3C << 1) | 1);
        r.wait(ADDR);
        r.w(0x00, PE);
        r.r(0x14);
        r.r(0x18);
        r.w(0x00, PE | STOP);
        r.wait(RXNE);
        assert_eq!(r.r(0x10), 0x11);
        assert_eq!(r.dev.log[1..], ["Read { ack: false }", "Stop"]);

        // Two bytes: POS, ACK off, clear ADDR, wait BTF, STOP, read, read.
        let mut r = Rig::new();
        r.dev.data = vec![0x21, 0x22];
        r.w(0x00, PE | ACK | START);
        r.wait(SB);
        r.w(0x10, (0x3C << 1) | 1);
        r.wait(ADDR);
        r.w(0x00, PE | POS);
        r.r(0x14);
        r.r(0x18);
        r.wait(BTF);
        r.w(0x00, PE | POS | STOP);
        assert_eq!(r.r(0x10), 0x21);
        assert_eq!(r.r(0x10), 0x22);
        assert_eq!(
            r.dev.log[1..],
            ["Read { ack: true }", "Read { ack: false }", "Stop"]
        );

        // Four bytes: read 1 via RXNE; last three via BTF, ACK off, BTF, STOP.
        let mut r = Rig::new();
        r.dev.data = vec![1, 2, 3, 4];
        r.w(0x00, PE | ACK | START);
        r.wait(SB);
        r.w(0x10, (0x3C << 1) | 1);
        r.wait(ADDR);
        r.r(0x14);
        r.r(0x18);
        r.wait(RXNE);
        assert_eq!(r.r(0x10), 1);
        r.wait(BTF);
        r.w(0x00, PE);
        assert_eq!(r.r(0x10), 2);
        r.wait(BTF);
        r.w(0x00, PE | STOP);
        assert_eq!(r.r(0x10), 3);
        assert_eq!(r.r(0x10), 4);
        assert_eq!(
            r.dev.log[1..],
            [
                "Read { ack: true }",
                "Read { ack: true }",
                "Read { ack: true }",
                "Read { ack: false }",
                "Stop"
            ]
        );
        assert_eq!(r.i2c.sr2 & BUSY, 0);
    }

    #[test]
    fn repeated_start_for_a_register_read() {
        let mut r = Rig::new();
        r.dev.data = vec![0x42];
        r.w(0x00, PE | START);
        r.wait(SB);
        r.w(0x10, 0x3C << 1);
        r.wait(ADDR);
        r.r(0x14);
        r.r(0x18);
        r.wait(TXE);
        r.w(0x10, 0x07); // register
        r.wait(TXE);
        r.w(0x00, PE | START | ACK);
        r.wait(SB);
        r.w(0x10, (0x3C << 1) | 1);
        r.wait(ADDR);
        r.w(0x00, PE);
        r.r(0x14);
        r.r(0x18);
        r.w(0x00, PE | STOP);
        r.wait(RXNE);
        assert_eq!(r.r(0x10), 0x42);
        assert_eq!(
            r.dev.log,
            [
                "Start { addr: 60, read: false }",
                "Write(7)",
                "Start { addr: 60, read: true }",
                "Read { ack: false }",
                "Stop"
            ]
        );
    }
}
