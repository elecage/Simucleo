//! MCP2515 stand-alone CAN controller with a TJA1050 transceiver (the
//! common blue "MCP2515 CAN bus module": 8 MHz crystal, SPI header VCC,
//! GND, CS, SO, SI, SCK, INT, screw terminals CANH/CANL and a jumper for
//! the 120 Ω termination), and the CAN bus between such modules.
//!
//! The chip ([`Mcp2515`]) is its SPI instruction set (RESET, READ, WRITE,
//! READ RX BUFFER, LOAD TX BUFFER, RTS, READ STATUS, RX STATUS, BIT
//! MODIFY) over the register map of the datasheet (DS20001801): operating
//! modes in CANCTRL/CANSTAT, bit timing in CNF1–3, three transmit and two
//! receive buffers with masks and filters (standard and extended IDs,
//! rollover), interrupt enables and flags driving INT, error flags and the
//! error counters TEC/REC with error-passive and bus-off states.
//!
//! The bus ([`CanNet`]) works frame by frame: when a bus is idle and nodes
//! have messages pending, the frames are built bit for bit (stuff bits,
//! CRC-15), arbitration by ID decides which one goes, and the outcome —
//! acknowledged, or an ACK or bit error with its error frame — is known
//! from the nodes on the bus at that moment and applied when the frame
//! ends. Frame timing comes from the transmitter's bit time, so a probe on
//! CANH/CANL gets every bit edge at the time it is on the bus.
//! Nodes whose bit time differs from the transmitter's do not acknowledge
//! and (while error-active) destroy the frame with an error flag; a bus
//! without termination carries no frames a receiver could take, so the
//! transmitter sees no ACK; a lone node never gets one. Retransmission,
//! TEC/REC and error-passive/bus-off follow ISO 11898 (an error-passive
//! transmitter that only misses the ACK keeps TEC at 128).

use std::collections::{BTreeMap, VecDeque};

use crate::devices::Seconds;

/// The MCP2515 works from 2.7 V; the TJA1050 needs 4.75–5.25 V.
pub const CHIP_VMIN: f64 = 2.7;
pub const TRANSCEIVER_VMIN: f64 = 4.5;

/// Most bit edges queued per bus for probes (older ones are dropped).
const EDGE_QUEUE_MAX: usize = 1 << 16;

// ---------------------------------------------------------------- frames

/// A CAN 2.0B frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CanFrame {
    /// 11-bit (standard) or 29-bit (extended) identifier.
    pub id: u32,
    pub ext: bool,
    /// Remote frame (no data).
    pub rtr: bool,
    /// Data length code as sent (0–15; more than 8 means 8 bytes).
    pub dlc: u8,
    pub data: [u8; 8],
}

impl CanFrame {
    /// Data bytes on the bus.
    pub fn len(&self) -> usize {
        if self.rtr {
            0
        } else {
            (self.dlc as usize).min(8)
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// CRC-15 (polynomial 0x4599) over bits, as the CAN protocol computes it.
pub fn crc15(bits: &[bool]) -> u16 {
    let mut crc: u16 = 0;
    for &b in bits {
        let next = b ^ (crc & 0x4000 != 0);
        crc = (crc << 1) & 0x7FFF;
        if next {
            crc ^= 0x4599;
        }
    }
    crc
}

/// A frame as bits on the bus: `true` is recessive.
#[derive(Debug, Clone)]
pub struct FrameBits {
    /// SOF through the CRC sequence, stuff bits included, then the CRC
    /// delimiter, ACK slot (recessive here), ACK delimiter and EOF.
    pub bits: Vec<bool>,
    /// Index of the first bit after the arbitration field (stuffed).
    pub arb_end: usize,
    /// Index of the ACK slot.
    pub ack: usize,
}

fn push_bits(out: &mut Vec<bool>, v: u32, n: u32) {
    for i in (0..n).rev() {
        out.push(v >> i & 1 != 0);
    }
}

/// The bits of `f`, stuffed where the protocol stuffs.
pub fn frame_bits(f: &CanFrame) -> FrameBits {
    let mut raw = vec![false]; // SOF
    let arb_raw;
    if f.ext {
        push_bits(&mut raw, f.id >> 18 & 0x7FF, 11);
        raw.push(true); // SRR
        raw.push(true); // IDE
        push_bits(&mut raw, f.id & 0x3FFFF, 18);
        raw.push(f.rtr); // RTR: dominant (0) for data
        arb_raw = raw.len();
        raw.push(false); // r1
        raw.push(false); // r0
    } else {
        push_bits(&mut raw, f.id & 0x7FF, 11);
        raw.push(f.rtr); // RTR: dominant (0) for data
        arb_raw = raw.len();
        raw.push(false); // IDE
        raw.push(false); // r0
    }
    push_bits(&mut raw, f.dlc as u32 & 15, 4);
    for &b in &f.data[..f.len()] {
        push_bits(&mut raw, b as u32, 8);
    }
    let crc = crc15(&raw);
    push_bits(&mut raw, crc as u32, 15);
    // Stuffing: after five equal bits, one of the other level.
    let mut bits = Vec::with_capacity(raw.len() + raw.len() / 4 + 12);
    let mut arb_end = 0;
    let (mut last, mut run) = (None, 0);
    for (i, &b) in raw.iter().enumerate() {
        if i == arb_raw {
            arb_end = bits.len();
        }
        bits.push(b);
        if Some(b) == last {
            run += 1;
        } else {
            last = Some(b);
            run = 1;
        }
        if run == 5 {
            bits.push(!b);
            last = Some(!b);
            run = 1;
        }
    }
    bits.push(true); // CRC delimiter
    let ack = bits.len();
    bits.push(true); // ACK slot (a receiver drives it dominant)
    bits.push(true); // ACK delimiter
    bits.extend([true; 7]); // EOF
    FrameBits { bits, arb_end, ack }
}

// ------------------------------------------------------------------ chip

/// Register addresses.
pub mod reg {
    pub const BFPCTRL: u8 = 0x0C;
    pub const TXRTSCTRL: u8 = 0x0D;
    pub const CANSTAT: u8 = 0x0E;
    pub const CANCTRL: u8 = 0x0F;
    pub const TEC: u8 = 0x1C;
    pub const REC: u8 = 0x1D;
    pub const CNF3: u8 = 0x28;
    pub const CNF2: u8 = 0x29;
    pub const CNF1: u8 = 0x2A;
    pub const CANINTE: u8 = 0x2B;
    pub const CANINTF: u8 = 0x2C;
    pub const EFLG: u8 = 0x2D;
    pub const TXB0CTRL: u8 = 0x30;
    pub const RXB0CTRL: u8 = 0x60;
    pub const RXB1CTRL: u8 = 0x70;
}

/// CANINTF / CANINTE bits.
pub mod int {
    pub const RX0: u8 = 0x01;
    pub const RX1: u8 = 0x02;
    pub const TX0: u8 = 0x04;
    pub const ERR: u8 = 0x20;
    pub const WAK: u8 = 0x40;
    pub const MERR: u8 = 0x80;
}

/// TXBnCTRL bits.
const ABTF: u8 = 0x40;
const MLOA: u8 = 0x20;
const TXERR: u8 = 0x10;
const TXREQ: u8 = 0x08;

/// Operating mode (CANCTRL.REQOP / CANSTAT.OPMOD).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Normal,
    Sleep,
    Loopback,
    ListenOnly,
    Config,
}

impl Mode {
    fn from_bits(b: u8) -> Mode {
        match b >> 5 & 7 {
            0 => Mode::Normal,
            1 => Mode::Sleep,
            2 => Mode::Loopback,
            3 => Mode::ListenOnly,
            // 100 and the invalid 101–111 (read as configuration).
            _ => Mode::Config,
        }
    }

    fn bits(self) -> u8 {
        (match self {
            Mode::Normal => 0,
            Mode::Sleep => 1,
            Mode::Loopback => 2,
            Mode::ListenOnly => 3,
            Mode::Config => 4,
        }) << 5
    }

    pub fn name(self) -> &'static str {
        match self {
            Mode::Normal => "normal",
            Mode::Sleep => "sleep",
            Mode::Loopback => "loopback",
            Mode::ListenOnly => "listen-only",
            Mode::Config => "config",
        }
    }
}

/// Where an SPI instruction stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Spi {
    /// Next byte is an instruction.
    Instruction,
    /// The instruction is done: further bytes until CS rises are ignored.
    Ignore,
    ReadAddr,
    Read(u8),
    WriteAddr,
    Write(u8),
    /// READ RX BUFFER: the address, and which buffer's flag CS clears.
    ReadRx(u8, u8),
    LoadTx(u8),
    Status,
    RxStatus,
    ModifyAddr,
    ModifyMask(u8),
    ModifyData(u8, u8),
}

/// A message being sent inside the chip (loopback), or an attempt that
/// cannot reach the bus (no transceiver).
#[derive(Debug, Clone, Copy)]
struct Local {
    end: Seconds,
    buf: usize,
    frame: CanFrame,
    /// The transceiver does not work: the chip reads back recessive where
    /// it sent the dominant SOF, a bit error.
    detached: bool,
}

/// One MCP2515.
#[derive(Debug, Clone)]
pub struct Mcp2515 {
    regs: [u8; 128],
    mode: Mode,
    spi: Spi,
    /// Crystal frequency (Hz).
    pub osc: f64,
    /// When each TX buffer's TXREQ was set.
    req_time: [Seconds; 3],
    /// Error passive: it may not start a frame before this (suspend
    /// transmission), nor before the last local frame's intermission.
    hold_until: Seconds,
    local: Option<Local>,
    /// Bus-off: back to error-active at this time.
    recover_at: Option<Seconds>,
    /// The MCP2515 has its supply (2.7–5.5 V) and the TJA1050 has 5 V.
    pub powered: bool,
    pub transceiver: bool,
    /// Bumped by every reset: outcomes of frames started before are
    /// dropped.
    pub generation: u32,
    /// Messages sent and received, for the part's display.
    pub sent: u32,
    pub received: u32,
    /// The last message received (for the part's display).
    pub last_rx: Option<CanFrame>,
    /// The message in RXB1 rolled over from RXB0.
    rolled: bool,
}

impl Default for Mcp2515 {
    fn default() -> Self {
        Self::new(8e6)
    }
}

/// Registers that can only be written in configuration mode: filters,
/// masks and the bit timing.
fn config_only(a: u8) -> bool {
    matches!(a, 0x00..=0x0B | 0x10..=0x1B | 0x20..=0x2A)
}

/// Registers BIT MODIFY works on (others take the mask as 0xFF).
fn bit_modifiable(a: u8) -> bool {
    matches!(
        a,
        reg::BFPCTRL
            | reg::TXRTSCTRL
            | reg::CNF3
            | reg::CNF2
            | reg::CNF1
            | reg::CANINTE
            | reg::CANINTF
            | reg::EFLG
            | 0x30
            | 0x40
            | 0x50
            | 0x60
            | 0x70
    ) || a & 0x0F == 0x0F
}

impl Mcp2515 {
    pub fn new(osc: f64) -> Self {
        let mut c = Self {
            regs: [0; 128],
            mode: Mode::Config,
            spi: Spi::Instruction,
            osc,
            req_time: [0.0; 3],
            hold_until: f64::NEG_INFINITY,
            local: None,
            recover_at: None,
            powered: false,
            transceiver: false,
            generation: 0,
            sent: 0,
            received: 0,
            last_rx: None,
            rolled: false,
        };
        c.reset();
        c
    }

    /// RESET instruction, or power-on: registers to their reset values,
    /// configuration mode.
    pub fn reset(&mut self) {
        self.regs = [0; 128];
        self.regs[reg::CANCTRL as usize] = 0x87;
        // TXnRTS pins are not wired on the module: internal pull-ups.
        self.regs[reg::TXRTSCTRL as usize] = 0x38;
        self.mode = Mode::Config;
        self.spi = Spi::Instruction;
        self.req_time = [0.0; 3];
        self.hold_until = f64::NEG_INFINITY;
        self.local = None;
        self.recover_at = None;
        self.generation = self.generation.wrapping_add(1);
    }

    /// Supply lost (or the board powered up again): everything starts
    /// over.
    pub fn power_cycle(&mut self) {
        self.reset();
        self.sent = 0;
        self.received = 0;
        self.last_rx = None;
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    pub fn tec(&self) -> u8 {
        self.regs[reg::TEC as usize]
    }

    pub fn rec(&self) -> u8 {
        self.regs[reg::REC as usize]
    }

    pub fn bus_off(&self) -> bool {
        self.regs[reg::EFLG as usize] & 0x20 != 0
    }

    fn error_passive(&self) -> bool {
        self.tec() >= 128 || self.rec() >= 128
    }

    /// INT is low: an enabled interrupt flag is set.
    pub fn int_active(&self) -> bool {
        self.regs[reg::CANINTE as usize] & self.regs[reg::CANINTF as usize] != 0
    }

    /// A register as read over SPI.
    pub fn read(&self, a: u8) -> u8 {
        let a = a & 0x7F;
        match a & 0x0F {
            0x0E => {
                // OPMOD and the highest-priority enabled interrupt.
                let pending = self.regs[reg::CANINTE as usize] & self.regs[reg::CANINTF as usize];
                let icod = if pending & int::ERR != 0 {
                    1
                } else if pending & int::WAK != 0 {
                    2
                } else if pending & 0x1C != 0 {
                    // TXB0, TXB1, TXB2 → 3, 4, 5
                    3 + (pending >> 2 & 7).trailing_zeros() as u8
                } else if pending & 0x03 != 0 {
                    6 + (pending & 3).trailing_zeros() as u8
                } else {
                    0
                };
                self.mode.bits() | icod << 1
            }
            0x0F => self.regs[reg::CANCTRL as usize],
            _ => self.regs[a as usize],
        }
    }

    /// A register written over SPI (or by BIT MODIFY with `mask`).
    fn write(&mut self, a: u8, v: u8, mask: u8, now: Seconds) {
        let a = a & 0x7F;
        let addr = if a & 0x0F == 0x0F { reg::CANCTRL } else { a };
        if config_only(addr) && self.mode != Mode::Config {
            return; // locked outside configuration mode
        }
        let old = self.regs[addr as usize];
        let writable: u8 = match addr {
            a if a & 0x0F == 0x0E => 0,
            reg::TEC | reg::REC => 0,
            reg::BFPCTRL => 0x3F,
            reg::TXRTSCTRL => 0x07,
            reg::EFLG => 0xC0, // RX0OVR, RX1OVR (to clear them)
            0x30 | 0x40 | 0x50 => TXREQ | 0x03,
            reg::RXB0CTRL => 0x64,
            reg::RXB1CTRL => 0x60,
            0x61..=0x6D | 0x71..=0x7D => 0, // receive buffers: read-only
            _ => 0xFF,
        };
        let m = mask & writable;
        let new = old & !m | v & m;
        if addr == reg::EFLG {
            // The overflow flags can only be cleared.
            self.regs[addr as usize] = old & (new | 0x3F);
            return;
        }
        self.regs[addr as usize] = new;
        if addr == reg::RXB0CTRL {
            // BUKT1 is a read-only copy of BUKT.
            self.regs[addr as usize] = new & !0x02 | (new >> 1 & 0x02);
        }
        if let 0x30 | 0x40 | 0x50 = addr {
            let n = ((addr >> 4) - 3) as usize;
            if new & TXREQ != 0 && old & TXREQ == 0 {
                self.request(n, now);
            } else if new & TXREQ == 0 && old & TXREQ != 0 {
                // Cleared by the firmware: an abort (a frame on the bus
                // finishes anyway).
                self.regs[addr as usize] |= ABTF;
            }
        }
        if addr == reg::CANCTRL {
            if new & 0x10 != 0 {
                // ABAT: abort every pending transmission.
                for n in 0..3 {
                    let c = 0x30 + 0x10 * n as usize;
                    if self.regs[c] & TXREQ != 0 {
                        self.regs[c] = self.regs[c] & !TXREQ | ABTF;
                    }
                }
            }
            let mode = Mode::from_bits(new);
            if mode != self.mode {
                self.set_mode(mode, now);
            }
        }
    }

    fn set_mode(&mut self, mode: Mode, now: Seconds) {
        self.mode = mode;
        if mode == Mode::Config {
            // Configuration mode clears the error counters.
            self.regs[reg::TEC as usize] = 0;
            self.regs[reg::REC as usize] = 0;
            self.regs[reg::EFLG as usize] &= 0xC0;
            self.recover_at = None;
            self.local = None;
        }
        if mode != Mode::Loopback {
            if let Some(l) = self.local {
                if !l.detached {
                    self.local = None;
                }
            }
        }
        // Waking up or leaving configuration: 11 recessive bits to join.
        if let Some(bit) = self.bit_time() {
            self.hold_until = self.hold_until.max(now + 11.0 * bit);
        }
    }

    fn request(&mut self, n: usize, now: Seconds) {
        let c = 0x30 + 0x10 * n;
        self.regs[c] &= !(ABTF | MLOA | TXERR);
        self.req_time[n] = now;
    }

    /// One byte over SPI while CS is low; returns what goes out on SO.
    pub fn spi_byte(&mut self, b: u8, now: Seconds) -> u8 {
        let mut out = 0xFF;
        self.spi = match self.spi {
            Spi::Instruction => match b {
                0xC0 => {
                    self.reset();
                    Spi::Ignore
                }
                0x03 => Spi::ReadAddr,
                0x02 => Spi::WriteAddr,
                0x90 | 0x92 | 0x94 | 0x96 => {
                    let nm = b >> 1 & 3;
                    let addr = [0x61, 0x66, 0x71, 0x76][nm as usize];
                    Spi::ReadRx(addr, if nm < 2 { int::RX0 } else { int::RX1 })
                }
                0x40..=0x45 => Spi::LoadTx([0x31, 0x36, 0x41, 0x46, 0x51, 0x56][(b & 7) as usize]),
                0x80..=0x87 => {
                    for n in 0..3 {
                        if b >> n & 1 != 0 {
                            let c = 0x30 + 0x10 * n;
                            if self.regs[c] & TXREQ == 0 {
                                self.regs[c] |= TXREQ;
                                self.request(n, now);
                            }
                        }
                    }
                    Spi::Ignore
                }
                0xA0 => Spi::Status,
                0xB0 => Spi::RxStatus,
                0x05 => Spi::ModifyAddr,
                _ => Spi::Ignore,
            },
            Spi::Ignore => Spi::Ignore,
            Spi::ReadAddr => Spi::Read(b & 0x7F),
            Spi::Read(a) => {
                out = self.read(a);
                Spi::Read((a + 1) & 0x7F)
            }
            Spi::WriteAddr => Spi::Write(b & 0x7F),
            Spi::Write(a) => {
                self.write(a, b, 0xFF, now);
                Spi::Write((a + 1) & 0x7F)
            }
            Spi::ReadRx(a, flag) => {
                out = self.regs[a as usize];
                // Within the buffer (SIDH … D7).
                let end = a & 0xF0 | 0x0D;
                Spi::ReadRx(if a < end { a + 1 } else { a }, flag)
            }
            Spi::LoadTx(a) => {
                self.regs[a as usize] = b;
                let end = a & 0xF0 | 0x0D;
                Spi::LoadTx(if a < end { a + 1 } else { a })
            }
            Spi::Status => {
                out = self.status();
                Spi::Status
            }
            Spi::RxStatus => {
                out = self.rx_status();
                Spi::RxStatus
            }
            Spi::ModifyAddr => Spi::ModifyMask(b & 0x7F),
            Spi::ModifyMask(a) => Spi::ModifyData(a, b),
            Spi::ModifyData(a, mask) => {
                let mask = if bit_modifiable(a) { mask } else { 0xFF };
                self.write(a, b, mask, now);
                Spi::Ignore
            }
        };
        out
    }

    /// CS went high: the instruction ends.
    pub fn deselect(&mut self) {
        if let Spi::ReadRx(_, flag) = self.spi {
            self.regs[reg::CANINTF as usize] &= !flag;
        }
        self.spi = Spi::Instruction;
    }

    /// READ STATUS.
    pub fn status(&self) -> u8 {
        let f = self.regs[reg::CANINTF as usize];
        let req = |n: usize| (self.regs[0x30 + 0x10 * n] & TXREQ != 0) as u8;
        (f & 1)
            | (f >> 1 & 1) << 1
            | req(0) << 2
            | (f >> 2 & 1) << 3
            | req(1) << 4
            | (f >> 3 & 1) << 5
            | req(2) << 6
            | (f >> 4 & 1) << 7
    }

    /// RX STATUS.
    pub fn rx_status(&self) -> u8 {
        let f = self.regs[reg::CANINTF as usize] & 3;
        let (base, filt) = match f {
            0 => return 0,
            1 | 3 => (0x60usize, self.regs[0x60] & 1),
            _ => {
                let fh = self.regs[0x70] & 7;
                // A message rolled over from RXB0: 110 / 111.
                (0x70usize, if fh <= 1 && self.rolled { fh + 6 } else { fh })
            }
        };
        let sidl = self.regs[base + 2];
        let ext = sidl & 0x08 != 0;
        let rtr = if ext {
            self.regs[base + 5] & 0x40 != 0
        } else {
            sidl & 0x10 != 0
        };
        f << 6 | (ext as u8) << 4 | (rtr as u8) << 3 | filt
    }

    /// Bit time (s) from CNF1–3 and the crystal, `None` while the timing
    /// is invalid.
    pub fn bit_time(&self) -> Option<Seconds> {
        let (cnf1, cnf2, cnf3) = (
            self.regs[reg::CNF1 as usize],
            self.regs[reg::CNF2 as usize],
            self.regs[reg::CNF3 as usize],
        );
        let tq = 2.0 * ((cnf1 & 0x3F) as f64 + 1.0) / self.osc;
        let (prseg, ps1) = ((cnf2 & 7) as u32 + 1, (cnf2 >> 3 & 7) as u32 + 1);
        // BTLMODE 0: PS2 is the larger of PS1 and the 2 TQ processing time.
        let ps2 = if cnf2 & 0x80 != 0 {
            (cnf3 & 7) as u32 + 1
        } else {
            ps1.max(2)
        };
        // (Settings outside the datasheet's rules — fewer than 5 TQ, PS2
        // under 2 TQ, as some libraries use for 1 Mbit/s — still run.)
        Some(tq * (1 + prseg + ps1 + ps2) as f64)
    }

    /// The bit rate (bit/s) the registers give.
    pub fn bit_rate(&self) -> Option<f64> {
        self.bit_time().map(|t| 1.0 / t)
    }

    /// The pending message that goes first: highest TXP, then the highest
    /// buffer number.
    fn tx_candidate(&self) -> Option<(usize, Seconds)> {
        if self.regs[reg::CANCTRL as usize] & 0x10 != 0 {
            return None; // ABAT held
        }
        (0..3)
            .filter(|&n| self.regs[0x30 + 0x10 * n] & TXREQ != 0)
            .max_by_key(|&n| (self.regs[0x30 + 0x10 * n] & 3, n))
            .map(|n| (n, self.req_time[n]))
    }

    /// The message in TX buffer `n`.
    pub fn tx_frame(&self, n: usize) -> CanFrame {
        let b = 0x31 + 0x10 * n;
        let r = &self.regs;
        let sid = (r[b] as u32) << 3 | (r[b + 1] as u32) >> 5;
        let ext = r[b + 1] & 0x08 != 0;
        let id = if ext {
            sid << 18 | ((r[b + 1] & 3) as u32) << 16 | (r[b + 2] as u32) << 8 | r[b + 3] as u32
        } else {
            sid
        };
        let mut data = [0; 8];
        data.copy_from_slice(&r[b + 5..b + 13]);
        CanFrame {
            id,
            ext,
            rtr: r[b + 4] & 0x40 != 0,
            dlc: r[b + 4] & 0x0F,
            data,
        }
    }

    /// Wants to start a frame on the bus at or after the returned time.
    fn wants_bus(&self) -> Option<Seconds> {
        if !self.powered
            || !self.transceiver
            || self.mode != Mode::Normal
            || self.bus_off()
            || self.local.is_some()
        {
            return None;
        }
        self.bit_time()?;
        self.tx_candidate().map(|(_, t)| t.max(self.hold_until))
    }

    /// Takes part in frames on the bus as a receiver.
    fn listening(&self) -> bool {
        self.powered
            && self.transceiver
            && matches!(self.mode, Mode::Normal | Mode::ListenOnly)
            && !self.bus_off()
    }

    // ------------------------------------------------- frame outcomes

    fn set_flags(&mut self, f: u8) {
        self.regs[reg::CANINTF as usize] |= f;
    }

    /// EFLG from the counters; ERRIF when a condition appears.
    fn update_eflg(&mut self) {
        let (tec, rec) = (self.tec(), self.rec());
        let old = self.regs[reg::EFLG as usize];
        let mut e = old & 0xE0; // overflows, TXBO
        if tec >= 128 && e & 0x20 == 0 {
            e |= 0x10;
        }
        if rec >= 128 {
            e |= 0x08;
        }
        if tec >= 96 {
            e |= 0x04;
        }
        if rec >= 96 {
            e |= 0x02;
        }
        if tec >= 96 || rec >= 96 {
            e |= 0x01;
        }
        self.regs[reg::EFLG as usize] = e;
        if e & !old != 0 {
            self.set_flags(int::ERR);
        }
    }

    fn tec_add(&mut self, n: u32, now: Seconds) {
        let tec = self.tec() as u32 + n;
        if tec > 255 {
            // Bus-off: no more frames until 128 × 11 recessive bits.
            self.regs[reg::TEC as usize] = 255;
            self.regs[reg::EFLG as usize] = self.regs[reg::EFLG as usize] & !0x10 | 0x20;
            let bit = self.bit_time().unwrap_or(1e-6);
            self.recover_at = Some(now + 128.0 * 11.0 * bit);
            self.set_flags(int::ERR);
        } else {
            self.regs[reg::TEC as usize] = tec as u8;
        }
        self.update_eflg();
    }

    fn rec_add(&mut self, n: u32) {
        let rec = (self.rec() as u32 + n).min(255);
        self.regs[reg::REC as usize] = rec as u8;
        self.update_eflg();
    }

    fn tx_ok(&mut self, n: usize) {
        let c = 0x30 + 0x10 * n;
        self.regs[c] &= !(TXREQ | TXERR | MLOA | ABTF);
        self.set_flags(int::TX0 << n);
        let tec = self.tec();
        self.regs[reg::TEC as usize] = tec.saturating_sub(1);
        self.update_eflg();
        self.sent += 1;
    }

    /// A transmission failed with an error (`ack`: only the ACK was
    /// missing). TXREQ stays for the retransmission unless one-shot.
    fn tx_failed(&mut self, n: usize, ack_only: bool, now: Seconds) {
        let c = 0x30 + 0x10 * n;
        self.regs[c] |= TXERR;
        if self.regs[reg::CANCTRL as usize] & 0x08 != 0 {
            self.regs[c] &= !TXREQ; // one-shot mode
        }
        self.set_flags(int::MERR);
        // ISO 11898: an error-passive transmitter that sees no ACK (and no
        // dominant bit in its passive error flag) does not count it.
        if !(ack_only && self.tec() >= 128) {
            self.tec_add(8, now);
        }
    }

    fn lost_arbitration(&mut self, n: usize) {
        let c = 0x30 + 0x10 * n;
        self.regs[c] |= MLOA;
        if self.regs[reg::CANCTRL as usize] & 0x08 != 0 {
            self.regs[c] &= !TXREQ;
        }
    }

    fn rx_error(&mut self) {
        self.set_flags(int::MERR);
        self.rec_add(1);
    }

    fn rx_ok(&mut self) {
        let rec = self.rec();
        self.regs[reg::REC as usize] = if rec > 127 {
            120
        } else {
            rec.saturating_sub(1)
        };
        self.update_eflg();
    }

    /// Whether filter `f` (0–5) under mask `m` (0–1) takes `fr`.
    fn filter_match(&self, m: usize, f: usize, fr: &CanFrame) -> bool {
        let fb = [0x00, 0x04, 0x08, 0x10, 0x14, 0x18][f];
        let mb = [0x20, 0x24][m];
        let r = &self.regs;
        let word = |b: usize| -> (u32, bool, u32) {
            let sid = (r[b] as u32) << 3 | (r[b + 1] as u32) >> 5;
            let eid = ((r[b + 1] & 3) as u32) << 16 | (r[b + 2] as u32) << 8 | r[b + 3] as u32;
            (sid, r[b + 1] & 0x08 != 0, eid)
        };
        let (fsid, fext, feid) = word(fb);
        let (msid, _, meid) = word(mb);
        if fext != fr.ext {
            return false;
        }
        if fr.ext {
            let fid = fsid << 18 | feid;
            let mask = msid << 18 | meid;
            (fr.id ^ fid) & mask & 0x1FFF_FFFF == 0
        } else {
            if (fr.id ^ fsid) & msid & 0x7FF != 0 {
                return false;
            }
            // Standard frames: the EID bits filter the first two data
            // bytes (bytes the frame does not have are not compared).
            let n = fr.len();
            let pairs = [(0usize, 8u32), (1usize, 0u32)];
            pairs.iter().all(|&(k, sh)| {
                k >= n || (fr.data[k] as u32 ^ feid >> sh) & (meid >> sh) & 0xFF == 0
            })
        }
    }

    /// A valid frame came in: into RXB0 or RXB1 by the masks and filters,
    /// or an overflow.
    fn receive(&mut self, fr: &CanFrame) {
        let mode0 = self.regs[0x60] >> 5 & 3;
        let mode1 = self.regs[0x70] >> 5 & 3;
        let kind_ok = |mode: u8| match mode {
            1 => !fr.ext,
            2 => fr.ext,
            _ => true,
        };
        let hit0 = if mode0 == 3 {
            Some(0)
        } else if kind_ok(mode0) {
            (0..2).find(|&f| self.filter_match(0, f, fr))
        } else {
            None
        };
        let hit1 = if mode1 == 3 {
            Some(2)
        } else if kind_ok(mode1) {
            (2..6).find(|&f| self.filter_match(1, f, fr))
        } else {
            None
        };
        if hit0.is_none() && hit1.is_none() {
            return;
        }
        let full0 = self.regs[reg::CANINTF as usize] & int::RX0 != 0;
        let full1 = self.regs[reg::CANINTF as usize] & int::RX1 != 0;
        let bukt = self.regs[0x60] & 0x04 != 0;
        if let (Some(f), false) = (hit0, full0) {
            self.store(0, f as u8, fr);
            self.rolled = false;
        } else if let (Some(f), true, true, false) = (hit0, full0, bukt, full1) {
            // Rollover: RXB0 is full, the message goes to RXB1.
            self.store(1, f as u8, fr);
            self.rolled = true;
        } else if let (Some(f), false) = (hit1, full1) {
            self.store(1, f as u8, fr);
            self.rolled = false;
        } else {
            // Overflow: the message is lost (in the buffer it was for).
            let bit = if hit0.is_some() && !bukt { 0x40 } else { 0x80 };
            self.regs[reg::EFLG as usize] |= bit;
            self.set_flags(int::ERR);
        }
    }

    fn store(&mut self, n: usize, filter: u8, fr: &CanFrame) {
        let b = 0x61 + 0x10 * n;
        let (sid, eid) = if fr.ext {
            (fr.id >> 18 & 0x7FF, fr.id & 0x3FFFF)
        } else {
            (fr.id & 0x7FF, 0)
        };
        self.regs[b] = (sid >> 3) as u8;
        self.regs[b + 1] = ((sid & 7) << 5) as u8
            | if fr.ext { 0x08 } else { 0 }
            | if !fr.ext && fr.rtr { 0x10 } else { 0 }
            | (eid >> 16 & 3) as u8;
        self.regs[b + 2] = (eid >> 8) as u8;
        self.regs[b + 3] = eid as u8;
        self.regs[b + 4] = if fr.ext && fr.rtr { 0x40 } else { 0 } | fr.dlc & 0x0F;
        self.regs[b + 5..b + 13].fill(0);
        let len = fr.len();
        self.regs[b + 5..b + 5 + len].copy_from_slice(&fr.data[..len]);
        let ctrl = b - 1;
        if n == 0 {
            self.regs[ctrl] = self.regs[ctrl] & !0x09 | if fr.rtr { 0x08 } else { 0 } | filter & 1;
        } else {
            self.regs[ctrl] = self.regs[ctrl] & !0x0F | if fr.rtr { 0x08 } else { 0 } | filter & 7;
        }
        self.set_flags(if n == 0 { int::RX0 } else { int::RX1 });
        self.received += 1;
        self.last_rx = Some(*fr);
    }

    /// What the part shows: mode, bit rate, error state.
    pub fn display(&self) -> String {
        let rate = match self.bit_rate() {
            Some(r) if r >= 1000.0 => format!("{} kbit/s", (r / 1000.0 * 10.0).round() / 10.0),
            Some(r) => format!("{} bit/s", r.round()),
            None => "-".into(),
        };
        let state = if self.bus_off() {
            "bus-off"
        } else if self.error_passive() {
            "error-passive"
        } else {
            "error-active"
        };
        format!(
            "{} {} {} TEC {} REC {} TX {} RX {}",
            self.mode.name(),
            rate,
            state,
            self.tec(),
            self.rec(),
            self.sent,
            self.received
        )
    }
}

// ------------------------------------------------------------------- bus

/// The nodes whose CANH and CANL are on the same two nets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BusDef {
    pub members: Vec<String>,
    /// Modules with their 120 Ω jumper fitted.
    pub terminators: usize,
}

/// What happens to a frame, decided when it starts.
#[derive(Debug, Clone)]
enum Outcome {
    /// Acknowledged: these nodes take it.
    Ok { receivers: Vec<String> },
    /// Nobody acknowledged.
    NoAck,
    /// Destroyed by an error flag; `rx_errors` count a receive error.
    Error { rx_errors: Vec<String> },
}

#[derive(Debug, Clone)]
struct Flight {
    end: Seconds,
    free_at: Seconds,
    tx: String,
    gen: u32,
    buf: usize,
    frame: CanFrame,
    outcome: Outcome,
    /// Lost arbitration: (node, generation, buffer).
    losers: Vec<(String, u32, usize)>,
    /// A loser that sent different bits after the arbitration field:
    /// both get a bit error.
    collided: Vec<(String, u32, usize)>,
    /// Other nodes that sent the very same frame at the same time: they
    /// transmit with `tx` (no ACK from them) and share its outcome.
    co_tx: Vec<(String, u32, usize)>,
}

#[derive(Debug, Clone)]
struct BusState {
    def: BusDef,
    free_at: Seconds,
    flight: Option<Flight>,
    /// Bit edges not yet given to probes (time, recessive).
    edges: VecDeque<(Seconds, bool)>,
    /// Level last given to probes.
    level: bool,
    log: bool,
}

/// A module in the circuit: the nodes of its pins.
#[derive(Debug, Clone)]
pub struct CanPart {
    pub id: String,
    pub vcc: usize,
    pub gnd: usize,
    pub cs: usize,
    pub canh: usize,
    pub canl: usize,
    /// The 120 Ω jumper is fitted.
    pub term: bool,
}

/// The buses the modules form (CANH to CANH, CANL to CANL), and what is
/// wrong with the wiring.
pub fn group_buses(parts: &[CanPart]) -> (Vec<BusDef>, Vec<String>) {
    let mut warnings = Vec::new();
    let mut groups: Vec<((usize, usize), Vec<&CanPart>)> = Vec::new();
    for p in parts {
        match groups.iter_mut().find(|g| g.0 == (p.canh, p.canl)) {
            Some(g) => g.1.push(p),
            None => groups.push(((p.canh, p.canl), vec![p])),
        }
    }
    for p in parts {
        if p.canh == p.canl {
            warnings.push(format!(
                "{}: CANH and CANL are shorted together — no frame can get through",
                p.id
            ));
        }
        if let Some(q) = parts
            .iter()
            .find(|q| q.id != p.id && q.canl == p.canh && q.canh != p.canh)
        {
            warnings.push(format!(
                "CAN: {}'s CANH is wired to {}'s CANL — connect CANH to CANH and CANL to CANL",
                p.id, q.id
            ));
        }
    }
    let defs = groups
        .into_iter()
        .map(|((h, l), ps)| {
            let names: Vec<&str> = ps.iter().map(|p| p.id.as_str()).collect();
            let terminators = ps.iter().filter(|p| p.term).count();
            if ps.len() > 1 && terminators == 0 {
                warnings.push(format!(
                    "CAN bus {}: no 120 Ω termination — fit the jumper on the modules at the two ends (without it no frame is acknowledged)",
                    names.join("–")
                ));
            } else if terminators > 2 {
                warnings.push(format!(
                    "CAN bus {}: {terminators} terminations — 120 Ω belongs only at the two ends of the bus",
                    names.join("–")
                ));
            }
            BusDef {
                members: ps.iter().map(|p| p.id.clone()).collect(),
                terminators: if h == l { 0 } else { terminators },
            }
        })
        .collect();
    (defs, warnings)
}

/// The CAN buses between the modules of a circuit.
#[derive(Debug, Clone, Default)]
pub struct CanNet {
    buses: Vec<BusState>,
}

/// The chips by part id.
pub type Chips<'a> = BTreeMap<&'a str, &'a mut Mcp2515>;

impl CanNet {
    /// The buses of the circuit as it is now; a bus whose nodes did not
    /// change keeps its state.
    pub fn set_buses(&mut self, defs: Vec<BusDef>) {
        let mut old = std::mem::take(&mut self.buses);
        for def in defs {
            let state = match old.iter().position(|b| b.def.members == def.members) {
                Some(i) => {
                    let mut b = old.swap_remove(i);
                    b.def = def;
                    b
                }
                None => BusState {
                    def,
                    free_at: f64::NEG_INFINITY,
                    flight: None,
                    edges: VecDeque::new(),
                    level: true,
                    log: false,
                },
            };
            self.buses.push(state);
        }
    }

    /// Simulated time starts again: nothing is on the buses.
    pub fn reset_time(&mut self) {
        for b in &mut self.buses {
            b.free_at = f64::NEG_INFINITY;
            b.flight = None;
            b.edges.clear();
            b.level = true;
        }
    }

    pub fn buses(&self) -> impl Iterator<Item = &BusDef> {
        self.buses.iter().map(|b| &b.def)
    }

    /// The bus a node is on.
    pub fn bus_of(&self, id: &str) -> Option<usize> {
        self.buses
            .iter()
            .position(|b| b.def.members.iter().any(|m| m == id))
    }

    /// Keep bit edges of these buses for probes.
    pub fn set_logging(&mut self, buses: &[usize]) {
        for (i, b) in self.buses.iter_mut().enumerate() {
            b.log = buses.contains(&i);
            if !b.log {
                b.edges.clear();
            }
        }
    }

    /// The level probes of bus `i` show now (true: recessive).
    pub fn level(&self, i: usize) -> bool {
        self.buses.get(i).is_none_or(|b| b.level)
    }

    /// Bit edges up to `now` of the logged buses: (bus, time, recessive).
    pub fn take_edges(&mut self, now: Seconds) -> Vec<(usize, Seconds, bool)> {
        let mut out = Vec::new();
        for (i, b) in self.buses.iter_mut().enumerate() {
            while let Some(&(t, l)) = b.edges.front() {
                if t > now {
                    break;
                }
                b.edges.pop_front();
                if l != b.level {
                    b.level = l;
                    out.push((i, t, l));
                }
            }
        }
        out.sort_by(|a, b| a.1.total_cmp(&b.1));
        out
    }

    /// When a frame should start on bus `b`, if one is waiting.
    fn start_time(b: &BusState, get: &dyn Fn(&str) -> Option<(Seconds, bool)>) -> Option<Seconds> {
        if b.flight.is_some() {
            return None;
        }
        b.def
            .members
            .iter()
            .filter_map(|m| get(m).map(|(t, _)| t))
            .min_by(|a, c| a.total_cmp(c))
            .map(|t| t.max(b.free_at))
    }

    /// The next time something happens on the buses or in a chip.
    pub fn next_event<'a>(
        &self,
        chips: impl Iterator<Item = (&'a str, &'a Mcp2515)>,
    ) -> Option<Seconds> {
        let chips: BTreeMap<&str, &Mcp2515> = chips.collect();
        let get = |id: &str| chips.get(id).and_then(|c| c.wants_bus().map(|t| (t, true)));
        let mut next: Option<Seconds> = None;
        let mut at = |t: Seconds| next = Some(next.map_or(t, |n: f64| n.min(t)));
        for b in &self.buses {
            if let Some(f) = &b.flight {
                at(f.end);
            } else if let Some(t) = Self::start_time(b, &get) {
                at(t);
            }
        }
        for c in chips.values() {
            if let Some(t) = local_event(c) {
                at(t);
            }
        }
        next
    }

    /// Bring the buses and chips up to `now`.
    pub fn advance(&mut self, chips: &mut Chips, now: Seconds) {
        // (A bounded loop: each pass handles one event at or before now.)
        for _ in 0..10_000 {
            let mut best: Option<(Seconds, Ev)> = None;
            let mut consider = |t: Seconds, e: Ev| {
                // (Within a nanosecond: the board wakes the circuit at a
                // whole cycle, which may round a hair before the event.)
                if t <= now + 1e-9 && best.as_ref().is_none_or(|b| t < b.0) {
                    best = Some((t, e));
                }
            };
            {
                let get = |id: &str| chips.get(id).and_then(|c| c.wants_bus().map(|t| (t, true)));
                for (i, b) in self.buses.iter().enumerate() {
                    if let Some(f) = &b.flight {
                        consider(f.end, Ev::End(i));
                    } else if let Some(t) = Self::start_time(b, &get) {
                        consider(t, Ev::Start(i));
                    }
                }
            }
            for (id, c) in chips.iter() {
                if let Some(t) = local_event(c) {
                    consider(t, Ev::Local(id.to_string()));
                }
            }
            let Some((t, ev)) = best else {
                return;
            };
            match ev {
                Ev::Start(i) => self.start(i, chips, t),
                Ev::End(i) => self.end(i, chips, t),
                Ev::Local(id) => {
                    if let Some(c) = chips.get_mut(id.as_str()) {
                        local_step(c, t);
                    }
                }
            }
        }
    }

    fn start(&mut self, i: usize, chips: &mut Chips, t: Seconds) {
        let bus = &mut self.buses[i];
        let members = bus.def.members.clone();
        // Contenders: everyone ready to send by now.
        let mut cands: Vec<(String, usize, CanFrame, FrameBits, Seconds)> = Vec::new();
        for m in &members {
            let Some(c) = chips.get(m.as_str()) else {
                continue;
            };
            if c.wants_bus().is_some_and(|w| w <= t) {
                let (n, _) = c.tx_candidate().unwrap();
                let fr = c.tx_frame(n);
                let bits = frame_bits(&fr);
                cands.push((m.clone(), n, fr, bits, c.bit_time().unwrap()));
            }
        }
        if cands.is_empty() {
            return;
        }
        // Arbitration: the first dominant bit where the others are
        // recessive wins (bits are compared until all but one dropped out).
        let mut alive: Vec<usize> = (0..cands.len()).collect();
        let mut losers = Vec::new();
        let mut collided = Vec::new();
        let len = cands.iter().map(|c| c.3.bits.len()).max().unwrap();
        for k in 0..len {
            if alive.len() < 2 {
                break;
            }
            let level = |j: usize| cands[j].3.bits.get(k).copied().unwrap_or(true);
            if alive.iter().any(|&j| !level(j)) {
                let (keep, drop): (Vec<usize>, Vec<usize>) =
                    alive.iter().partition(|&&j| !level(j));
                for j in drop {
                    if k < cands[j].3.arb_end {
                        losers.push(j);
                    } else {
                        collided.push(j);
                    }
                }
                alive = keep;
            }
        }
        // Every survivor sent the same bits; the first stands for them all.
        let w = alive[0];
        let (tx_id, buf, frame, bits, bit) = cands[w].clone();
        let transmitting: Vec<String> = alive.iter().map(|&j| cands[j].0.clone()).collect();
        // Who listens, and at what bit time.
        let mut receivers = Vec::new();
        let mut mismatched_active = false;
        let mut rx_errors = Vec::new();
        for m in &members {
            if transmitting.contains(m) {
                continue;
            }
            let Some(c) = chips.get_mut(m.as_str()) else {
                continue;
            };
            // Bus activity wakes a sleeping chip with WAKIE set.
            if c.powered && c.mode == Mode::Sleep {
                c.set_flags(int::WAK);
                if c.regs[reg::CANINTE as usize] & int::WAK != 0 {
                    c.set_mode(Mode::ListenOnly, t);
                }
                continue;
            }
            if !c.listening() || bus.def.terminators == 0 {
                continue;
            }
            match c.bit_time() {
                Some(b) if ((b - bit) / bit).abs() <= 0.01 => receivers.push(m.clone()),
                _ => {
                    rx_errors.push(m.clone());
                    if c.mode == Mode::Normal && !c.error_passive() {
                        mismatched_active = true;
                    }
                }
            }
        }
        let ackers = receivers.iter().any(|m| {
            chips
                .get(m.as_str())
                .is_some_and(|c| c.mode == Mode::Normal)
        });
        // The flag is recessive only if every transmitter is error-passive.
        let tx_passive = transmitting
            .iter()
            .all(|m| chips[m.as_str()].error_passive());
        // The bits on the bus: up to an error, then the error flag (6
        // dominant; recessive if only an error-passive transmitter flags),
        // its delimiter (8 recessive).
        let (seq, outcome) = if mismatched_active || !collided.is_empty() {
            // An error flag after a few bits: the wrongly timed node sees a
            // stuff error, or two transmitters disagree after arbitration.
            let at = if !collided.is_empty() {
                (0..bits.bits.len())
                    .find(|&k| {
                        collided
                            .iter()
                            .any(|&j| cands[j].3.bits.get(k) != bits.bits.get(k))
                    })
                    .unwrap_or(bits.arb_end)
                    + 1
            } else {
                8.min(bits.ack)
            };
            let mut seq = bits.bits[..at].to_vec();
            seq.extend([false; 6]);
            seq.extend([true; 8]);
            for m in &receivers {
                rx_errors.push(m.clone());
            }
            (seq, Outcome::Error { rx_errors })
        } else if ackers {
            let mut seq = bits.bits.clone();
            seq[bits.ack] = false;
            (seq, Outcome::Ok { receivers })
        } else {
            let mut seq = bits.bits[..=bits.ack].to_vec();
            seq.extend([tx_passive; 6]);
            seq.extend([true; 8]);
            (seq, Outcome::NoAck)
        };
        let end = t + seq.len() as f64 * bit;
        if bus.log {
            let mut level = true;
            for (k, &b) in seq.iter().enumerate() {
                if b != level {
                    bus.edges.push_back((t + k as f64 * bit, b));
                    level = b;
                }
            }
            if !level {
                bus.edges.push_back((end, true));
            }
            while bus.edges.len() > EDGE_QUEUE_MAX {
                bus.edges.pop_front();
            }
        }
        let gen_of = |id: &str| chips.get(id).map_or(0, |c| c.generation);
        bus.flight = Some(Flight {
            end,
            free_at: end + 3.0 * bit,
            gen: gen_of(&tx_id),
            tx: tx_id,
            buf,
            frame,
            outcome,
            losers: losers
                .iter()
                .map(|&j| (cands[j].0.clone(), gen_of(&cands[j].0), cands[j].1))
                .collect(),
            collided: collided
                .iter()
                .map(|&j| (cands[j].0.clone(), gen_of(&cands[j].0), cands[j].1))
                .collect(),
            co_tx: alive[1..]
                .iter()
                .map(|&j| (cands[j].0.clone(), gen_of(&cands[j].0), cands[j].1))
                .collect(),
        });
    }

    fn end(&mut self, i: usize, chips: &mut Chips, t: Seconds) {
        let bus = &mut self.buses[i];
        let Some(f) = bus.flight.take() else {
            return;
        };
        bus.free_at = f.free_at;
        let live =
            |chips: &Chips, id: &str, gen: u32| chips.get(id).is_some_and(|c| c.generation == gen);
        let senders = std::iter::once((f.tx.clone(), f.gen, f.buf)).chain(f.co_tx.iter().cloned());
        for (id, gen, buf) in senders {
            if !live(chips, &id, gen) {
                continue;
            }
            let c = chips.get_mut(id.as_str()).unwrap();
            let passive = c.error_passive();
            match &f.outcome {
                Outcome::Ok { .. } => c.tx_ok(buf),
                Outcome::NoAck => c.tx_failed(buf, true, t),
                Outcome::Error { .. } => c.tx_failed(buf, false, t),
            }
            if passive || c.error_passive() {
                // Suspend transmission: 8 more bits before sending again.
                let bit = c.bit_time().unwrap_or(0.0);
                c.hold_until = c.hold_until.max(f.free_at + 8.0 * bit);
            }
        }
        for (id, gen, n) in &f.losers {
            if live(chips, id, *gen) {
                chips.get_mut(id.as_str()).unwrap().lost_arbitration(*n);
            }
        }
        for (id, gen, n) in &f.collided {
            if live(chips, id, *gen) {
                chips.get_mut(id.as_str()).unwrap().tx_failed(*n, false, t);
            }
        }
        match &f.outcome {
            Outcome::Ok { receivers } => {
                for id in receivers {
                    if let Some(c) = chips.get_mut(id.as_str()) {
                        if c.listening() {
                            c.rx_ok();
                            c.receive(&f.frame);
                        }
                    }
                }
            }
            Outcome::Error { rx_errors } => {
                for id in rx_errors {
                    if let Some(c) = chips.get_mut(id.as_str()) {
                        if c.listening() && c.mode == Mode::Normal {
                            c.rx_error();
                        }
                    }
                }
            }
            Outcome::NoAck => {}
        }
    }
}

enum Ev {
    Start(usize),
    End(usize),
    Local(String),
}

/// A chip's own next event: the end of a loopback frame or of an
/// attempt without transceiver, the start of one, or bus-off recovery.
fn local_event(c: &Mcp2515) -> Option<Seconds> {
    if !c.powered {
        return None;
    }
    if let Some(l) = c.local {
        return Some(l.end);
    }
    if let Some(t) = c.recover_at {
        return Some(t);
    }
    c.bit_time()?;
    let (_, req) = c.tx_candidate()?;
    match c.mode {
        Mode::Loopback => Some(req.max(c.hold_until)),
        Mode::Normal if !c.transceiver && !c.bus_off() => Some(req.max(c.hold_until)),
        _ => None,
    }
}

fn local_step(c: &mut Mcp2515, t: Seconds) {
    if let Some(l) = c.local {
        if t < l.end {
            return;
        }
        c.local = None;
        let bit = c.bit_time().unwrap_or(1e-6);
        if l.detached {
            c.tx_failed(l.buf, false, t);
            c.hold_until = t + 3.0 * bit + if c.error_passive() { 8.0 * bit } else { 0.0 };
        } else {
            c.tx_ok(l.buf);
            c.receive(&l.frame);
            c.hold_until = t + 3.0 * bit;
        }
        return;
    }
    if let Some(r) = c.recover_at {
        if t >= r {
            c.recover_at = None;
            c.regs[reg::TEC as usize] = 0;
            c.regs[reg::REC as usize] = 0;
            c.regs[reg::EFLG as usize] &= 0xC0;
        }
        return;
    }
    let (Some(bit), Some((n, _))) = (c.bit_time(), c.tx_candidate()) else {
        return;
    };
    let frame = c.tx_frame(n);
    let detached = c.mode != Mode::Loopback;
    // Without a transceiver: SOF, then the error flag and its delimiter.
    let bits = if detached {
        1 + 6 + 8
    } else {
        frame_bits(&frame).bits.len()
    };
    c.local = Some(Local {
        end: t + bits as f64 * bit,
        buf: n,
        frame,
        detached,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 125 kbit/s at 8 MHz (the common libraries' CNF values).
    const CNF_125K: [u8; 3] = [0x01, 0xB1, 0x85];
    const CNF_500K: [u8; 3] = [0x00, 0x90, 0x82];

    fn spi(c: &mut Mcp2515, bytes: &[u8], now: Seconds) -> Vec<u8> {
        let out = bytes.iter().map(|&b| c.spi_byte(b, now)).collect();
        c.deselect();
        out
    }

    fn chip(cnf: [u8; 3], mode: u8) -> Mcp2515 {
        let mut c = Mcp2515::new(8e6);
        c.powered = true;
        c.transceiver = true;
        spi(&mut c, &[0xC0], 0.0);
        spi(&mut c, &[0x02, 0x28, cnf[2], cnf[1], cnf[0]], 0.0);
        // Receive any message in both buffers, all interrupts on.
        spi(&mut c, &[0x02, 0x60, 0x60], 0.0);
        spi(&mut c, &[0x02, 0x70, 0x60], 0.0);
        spi(&mut c, &[0x02, 0x2B, 0xFF], 0.0);
        spi(&mut c, &[0x05, 0x0F, 0xE0, mode], 0.0);
        c
    }

    fn load(c: &mut Mcp2515, n: u8, id: u32, ext: bool, data: &[u8], now: Seconds) {
        let (sidh, sidl, eid8, eid0) = if ext {
            (
                (id >> 21) as u8,
                ((id >> 13) & 0xE0) as u8 | 0x08 | ((id >> 16) & 3) as u8,
                (id >> 8) as u8,
                id as u8,
            )
        } else {
            ((id >> 3) as u8, ((id & 7) << 5) as u8, 0, 0)
        };
        let mut b = vec![0x40 | (n * 2), sidh, sidl, eid8, eid0, data.len() as u8];
        b.extend_from_slice(data);
        spi(c, &b, now);
        spi(c, &[0x81 << n], now);
    }

    fn run(net: &mut CanNet, chips: &mut [(&str, &mut Mcp2515)], until: Seconds) {
        let mut map: Chips = chips.iter_mut().map(|(id, c)| (*id, &mut **c)).collect();
        net.advance(&mut map, until);
    }

    #[test]
    fn crc_and_stuffing_match_a_known_frame() {
        // (The whole frame, CRC included, is checked against the
        // independent TypeScript decoder by the hal-can-mcp2515 E2E.)
        let f = CanFrame {
            id: 0x7FF,
            ext: false,
            rtr: false,
            dlc: 0,
            data: [0; 8],
        };
        let b = frame_bits(&f);
        // SOF 0, then eleven 1s: stuffed after the 5th and 10th one.
        assert_eq!(
            &b.bits[..8],
            &[false, true, true, true, true, true, false, true]
        );
        // No run of six equal bits before the CRC delimiter.
        let body = &b.bits[..b.ack - 1];
        assert!(body.windows(6).all(|w| w.iter().any(|&x| x != w[0])));
        // Without the stuff bits: RTR (after the 11 ID bits) is dominant
        // for a data frame, recessive for a remote one; IDE dominant.
        let raw = |f: &CanFrame| {
            let b = frame_bits(f).bits;
            let (mut out, mut last, mut run) = (Vec::new(), None, 0);
            let mut i = 0;
            while out.len() < 14 {
                out.push(b[i]);
                run = if Some(b[i]) == last { run + 1 } else { 1 };
                last = Some(b[i]);
                i += 1;
                if run == 5 {
                    last = Some(b[i]);
                    run = 1;
                    i += 1;
                }
            }
            out
        };
        let data = CanFrame { id: 0x123, ..f };
        assert_eq!(&raw(&data)[12..14], &[false, false]);
        assert_eq!(
            &raw(&CanFrame { rtr: true, ..data })[12..14],
            &[true, false]
        );
        assert_eq!(crc15(&[false]), 0);
        // A one shifted in: the polynomial.
        assert_eq!(crc15(&[true]), 0x4599);
    }

    #[test]
    fn bit_timing_gives_the_common_rates() {
        let c = chip(CNF_125K, 0x80);
        assert!((c.bit_rate().unwrap() - 125_000.0).abs() < 1e-6);
        let c = chip(CNF_500K, 0x80);
        assert!((c.bit_rate().unwrap() - 500_000.0).abs() < 1e-6);
        // A 16 MHz library setting on the 8 MHz crystal: half the rate.
        let c = chip([0x03, 0xF0, 0x86], 0x80);
        assert!((c.bit_rate().unwrap() - 62_500.0).abs() < 1e-6);
    }

    #[test]
    fn registers_modes_and_config_lock() {
        let mut c = Mcp2515::new(8e6);
        assert_eq!(spi(&mut c, &[0x03, 0x0E, 0], 0.0)[2], 0x80);
        assert_eq!(spi(&mut c, &[0x03, 0x0F, 0], 0.0)[2], 0x87);
        // Normal mode, then CNF1 is locked.
        spi(&mut c, &[0x02, 0x2A, 0x01], 0.0);
        spi(&mut c, &[0x05, 0x0F, 0xE0, 0x00], 0.0);
        assert_eq!(spi(&mut c, &[0x03, 0x3E, 0], 0.0)[2] >> 5, 0);
        spi(&mut c, &[0x02, 0x2A, 0x07], 0.0);
        assert_eq!(spi(&mut c, &[0x03, 0x2A, 0], 0.0)[2], 0x01);
        // Loopback, listen-only, sleep, config.
        for m in [0x40u8, 0x60, 0x20, 0x80] {
            spi(&mut c, &[0x05, 0x0F, 0xE0, m], 0.0);
            assert_eq!(spi(&mut c, &[0x03, 0x0E, 0], 0.0)[2] & 0xE0, m);
        }
        // Sequential read and write.
        spi(&mut c, &[0x02, 0x00, 1, 2, 3], 0.0);
        assert_eq!(spi(&mut c, &[0x03, 0x00, 0, 0, 0], 0.0)[2..], [1, 2, 3]);
        // RESET.
        spi(&mut c, &[0xC0], 0.0);
        assert_eq!(spi(&mut c, &[0x03, 0x00, 0], 0.0)[2], 0);
    }

    #[test]
    fn loopback_delivers_to_itself_with_int() {
        let mut net = CanNet::default();
        let mut a = chip(CNF_125K, 0x40);
        load(&mut a, 0, 0x123, false, &[0xDE, 0xAD], 0.0);
        assert!(!a.int_active());
        // READ STATUS shows TXREQ set.
        assert_eq!(spi(&mut a, &[0xA0, 0], 0.0)[1] & 0x04, 0x04);
        run(&mut net, &mut [("a", &mut a)], 1.0);
        assert!(a.int_active());
        // TX0IF and RX0IF.
        assert_eq!(spi(&mut a, &[0xA0, 0], 1.0)[1], 0x09);
        assert_eq!(spi(&mut a, &[0xB0, 0], 1.0)[1], 0x40);
        let rx = spi(&mut a, &[0x90, 0, 0, 0, 0, 0, 0, 0], 1.0);
        assert_eq!(rx[1..8], [0x24, 0x60, 0, 0, 2, 0xDE, 0xAD]);
        // READ RX BUFFER cleared RX0IF.
        assert_eq!(spi(&mut a, &[0x03, 0x2C, 0], 1.0)[2], 0x04);
    }

    fn two(cnf_b: [u8; 3]) -> (CanNet, Mcp2515, Mcp2515) {
        let mut net = CanNet::default();
        net.set_buses(vec![BusDef {
            members: vec!["a".into(), "b".into()],
            terminators: 2,
        }]);
        (net, chip(CNF_125K, 0), chip(cnf_b, 0))
    }

    #[test]
    fn a_frame_goes_to_the_other_node_after_its_bit_time() {
        let (mut net, mut a, mut b) = two(CNF_125K);
        net.set_logging(&[0]);
        load(&mut a, 0, 0x1ABCDE01, true, &[1, 2, 3, 4, 5, 6, 7, 8], 0.0);
        let bits = frame_bits(&a.tx_frame(0)).bits.len() as f64;
        run(&mut net, &mut [("a", &mut a), ("b", &mut b)], 0.5e-3);
        assert!(!b.int_active(), "not before its end");
        run(
            &mut net,
            &mut [("a", &mut a), ("b", &mut b)],
            (bits + 11.0) * 8e-6 + 1e-9,
        );
        assert!(b.int_active());
        assert_eq!(b.last_rx.unwrap().id, 0x1ABCDE01);
        assert_eq!(a.tec(), 0);
        // Extended ID in RXB0: SIDL has EXIDE.
        let rx = spi(&mut b, &[0x90, 0, 0, 0, 0], 1.0);
        assert_eq!(rx[2] & 0x08, 0x08);
        // It starts once the bus was idle for 11 bits after the mode change.
        let start = 11.0 * 8e-6;
        let edges = net.take_edges(1.0);
        assert!((edges[0].1 - start).abs() < 1e-12);
        assert!(!edges[0].2);
        // The ACK slot is dominant: the last falling edge is 9 bits
        // before the end (ACK slot, ACK delimiter, EOF).
        let last_fall = edges.iter().rev().find(|e| !e.2).unwrap().1;
        assert!((last_fall - start - (bits - 9.0) * 8e-6).abs() < 1e-9);
    }

    #[test]
    fn arbitration_lets_the_lower_id_through_first() {
        let (mut net, mut a, mut b) = two(CNF_125K);
        load(&mut a, 0, 0x200, false, &[0xAA], 0.0);
        load(&mut b, 0, 0x100, false, &[0xBB], 0.0);
        run(&mut net, &mut [("a", &mut a), ("b", &mut b)], 0.8e-3);
        // b won: a lost arbitration (MLOA), took b's frame.
        assert_eq!(a.last_rx.unwrap().id, 0x100);
        assert_eq!(
            spi(&mut a, &[0x03, 0x30, 0], 1.0)[2] & (MLOA | TXREQ),
            MLOA | TXREQ
        );
        assert!(b.last_rx.is_none());
        run(&mut net, &mut [("a", &mut a), ("b", &mut b)], 2e-3);
        assert_eq!(b.last_rx.unwrap().id, 0x200);
    }

    #[test]
    fn identical_frames_sent_together_are_not_acknowledged_by_their_senders() {
        // a and b start the same frame at the same moment, nobody else on
        // the bus: neither wins arbitration, neither may ACK the other.
        let (mut net, mut a, mut b) = two(CNF_125K);
        load(&mut a, 0, 0x123, false, &[42], 0.0);
        load(&mut b, 0, 0x123, false, &[42], 0.0);
        run(&mut net, &mut [("a", &mut a), ("b", &mut b)], 2e-3);
        assert!(a.last_rx.is_none() && b.last_rx.is_none(), "no copies");
        assert_eq!((a.sent, b.sent), (0, 0));
        assert!(
            a.tec() > 0 && b.tec() > 0,
            "ACK errors: TEC {} {}",
            a.tec(),
            b.tec()
        );
        // Both still want to send.
        assert_ne!(spi(&mut a, &[0x03, 0x30, 0], 1.0)[2] & TXREQ, 0);
        assert_ne!(spi(&mut b, &[0x03, 0x30, 0], 1.0)[2] & TXREQ, 0);
    }

    #[test]
    fn wrong_bit_rate_lone_node_and_no_termination_get_no_ack() {
        // b at 500 kbit/s: a's frames are destroyed, TEC climbs to bus-off.
        let (mut net, mut a, mut b) = two(CNF_500K);
        load(&mut a, 0, 0x123, false, &[1], 0.0);
        run(&mut net, &mut [("a", &mut a), ("b", &mut b)], 2e-3);
        assert!(
            a.tec() > 0 && b.rec() > 0,
            "TEC {} REC {}",
            a.tec(),
            b.rec()
        );
        assert_eq!(b.received, 0);
        assert_eq!(spi(&mut a, &[0x03, 0x30, 0], 1.0)[2] & TXERR, TXERR);
        run(&mut net, &mut [("a", &mut a), ("b", &mut b)], 20e-3);
        assert!(a.bus_off());

        // Alone: ACK errors until error passive, where TEC stays at 128.
        let mut net = CanNet::default();
        net.set_buses(vec![BusDef {
            members: vec!["a".into()],
            terminators: 1,
        }]);
        let mut a = chip(CNF_125K, 0);
        load(&mut a, 0, 0x123, false, &[1], 0.0);
        run(&mut net, &mut [("a", &mut a)], 100e-3);
        assert_eq!(a.tec(), 128);
        assert!(!a.bus_off());
        assert_eq!(spi(&mut a, &[0x03, 0x2D, 0], 1.0)[2] & 0x10, 0x10, "TXEP");

        // No termination: nobody receives.
        let (mut net, mut a, mut b) = two(CNF_125K);
        net.buses[0].def.terminators = 0;
        load(&mut a, 0, 0x123, false, &[1], 0.0);
        run(&mut net, &mut [("a", &mut a), ("b", &mut b)], 5e-3);
        assert_eq!(b.received, 0);
        assert!(a.tec() >= 8);
    }

    #[test]
    fn masks_filters_and_rollover() {
        let (mut net, mut a, mut b) = two(CNF_125K);
        // b: config mode, RXB0 only std 0x123 exactly, RXB1 ext 0x1xxxxxxx.
        spi(&mut b, &[0x05, 0x0F, 0xE0, 0x80], 0.0);
        spi(&mut b, &[0x02, 0x20, 0xFF, 0xE0, 0, 0], 0.0); // RXM0 all SID
        spi(&mut b, &[0x02, 0x00, 0x24, 0x60, 0, 0], 0.0); // RXF0 0x123
        spi(&mut b, &[0x02, 0x04, 0x24, 0x60, 0, 0], 0.0); // RXF1 0x123
        spi(&mut b, &[0x02, 0x24, 0x80, 0x00, 0, 0], 0.0); // RXM1: top SID bit
        spi(&mut b, &[0x02, 0x08, 0x80, 0x08, 0, 0], 0.0); // RXF2 ext, top bit 1
        spi(&mut b, &[0x02, 0x10, 0x80, 0x08, 0, 0], 0.0);
        spi(&mut b, &[0x02, 0x14, 0x80, 0x08, 0, 0], 0.0);
        spi(&mut b, &[0x02, 0x18, 0x80, 0x08, 0, 0], 0.0);
        spi(&mut b, &[0x02, 0x60, 0x04, 0x00], 0.0); // filters on, BUKT
        spi(&mut b, &[0x02, 0x70, 0x00], 0.0);
        spi(&mut b, &[0x05, 0x0F, 0xE0, 0x00], 0.0);
        let t = std::cell::Cell::new(0.0);
        let mut send = |a: &mut Mcp2515, b: &mut Mcp2515, id: u32, ext: bool| {
            load(a, 0, id, ext, &[0x11], t.get());
            t.set(t.get() + 2e-3);
            run(&mut net, &mut [("a", a), ("b", b)], t.get());
        };
        send(&mut a, &mut b, 0x124, false); // rejected
        assert_eq!(b.received, 0);
        send(&mut a, &mut b, 0x123, false); // RXB0, filter 0
        assert_eq!(b.received, 1);
        send(&mut a, &mut b, 0x123, false); // rollover into RXB1
        assert_eq!(spi(&mut b, &[0xB0, 0], t.get())[1], 0xC0, "both full");
        spi(&mut b, &[0x05, 0x2C, 0x01, 0x00], t.get());
        assert_eq!(
            spi(&mut b, &[0xB0, 0], t.get())[1],
            0x80 | 6,
            "RXF0 rolled over into RXB1"
        );
        spi(&mut b, &[0x05, 0x2C, 0x01, 0x01], t.get());
        send(&mut a, &mut b, 0x123, false); // overflow
        assert_eq!(spi(&mut b, &[0x03, 0x2D, 0], t.get())[2] & 0xC0, 0x80);
        spi(&mut b, &[0x05, 0x2C, 0x03, 0x00], t.get()); // free both
        send(&mut a, &mut b, 0x1000_0001, true); // RXB1, filter 2
        assert_eq!(spi(&mut b, &[0x03, 0x70, 0], t.get())[2] & 7, 2);
        send(&mut a, &mut b, 0x0000_0001, true); // rejected
        assert_eq!(b.received, 3);
    }

    #[test]
    fn no_transceiver_power_is_a_bit_error() {
        let mut net = CanNet::default();
        let mut a = chip(CNF_125K, 0);
        a.transceiver = false;
        load(&mut a, 0, 0x123, false, &[1], 0.0);
        run(&mut net, &mut [("a", &mut a)], 1e-3);
        assert!(a.tec() >= 8 * 5, "{}", a.tec());
    }
}
