//! MFRC522 13.56 MHz RFID reader (NXP MFRC522 datasheet rev. 3.9) on its
//! SPI interface, and the ISO/IEC 14443 A cards a student places on its
//! antenna: MIFARE Classic 1K (NXP MF1S50) and MIFARE Ultralight (MF0ICU1).
//!
//! The reader side models the registers and commands firmware uses
//! (Arduino `MFRC522`, the common STM32 ports): CommandReg (Idle, Mem,
//! GenerateRandomID, CalcCRC, Transmit, Receive, Transceive, MFAuthent,
//! SoftReset), the 64-byte FIFO, the interrupt request bits and the IRQ
//! pin, BitFramingReg (StartSend, TxLastBits), ErrorReg, Status1/2,
//! TxControlReg (antenna drivers), TxASKReg (100 % ASK, which type A cards
//! need), Tx/RxModeReg (hardware CRC), ModeReg (CRC preset), the timer
//! (TModeReg, TPrescaler, TReload: with TAuto it starts at the end of each
//! transmission, so no card means TimerIRq) and VersionReg (0x92, v2.0).
//! Air time is modelled at 106 kbit/s (9 bits per byte with parity), with
//! the card's frame delay and the EEPROM write time of a MIFARE WRITE.
//!
//! Approximations: the Crypto1 cipher is not modelled — MFAuthent succeeds
//! when the key matches the sector trailer and the UID is the selected
//! card's, sets MFCrypto1On, and the card then takes plain frames only
//! while the reader has MFCrypto1On (a reader that forgot StopCrypto1, or
//! a card that never authenticated, sees garbage, as on hardware). One
//! card is on the antenna at a time (no anticollision collisions), parity
//! is not transmitted, RxAlign is ignored, value-block commands are not
//! supported (NAK), SPI mode is not checked.

use std::collections::VecDeque;

use crate::devices::Seconds;

/// Carrier frequency (Hz).
const FC: f64 = 13.56e6;
/// Air bit rate at 106 kbd (fc / 128).
const BIT_RATE: f64 = FC / 128.0;
/// Card's frame delay time after the reader's last bit (ISO 14443-3:
/// n = 9, 1236/fc for a last bit 1).
const FDT: f64 = 1236.0 / FC;
/// MIFARE Classic / Ultralight EEPROM write before the ACK.
const WRITE_TIME: Seconds = 2.5e-3;
/// Supply range of the module's 3.3V pin (datasheet: 2.5–3.6 V).
pub const VMIN: f64 = 2.5;
pub const VMAX: f64 = 3.7;
/// Chip version: MFRC522 v2.0.
pub const VERSION: u8 = 0x92;

// Register addresses (datasheet §9.2).
pub const COMMAND: u8 = 0x01;
pub const COM_IEN: u8 = 0x02;
pub const DIV_IEN: u8 = 0x03;
pub const COM_IRQ: u8 = 0x04;
pub const DIV_IRQ: u8 = 0x05;
pub const ERROR: u8 = 0x06;
pub const STATUS1: u8 = 0x07;
pub const STATUS2: u8 = 0x08;
pub const FIFO_DATA: u8 = 0x09;
pub const FIFO_LEVEL: u8 = 0x0A;
pub const WATER_LEVEL: u8 = 0x0B;
pub const CONTROL: u8 = 0x0C;
pub const BIT_FRAMING: u8 = 0x0D;
pub const COLL: u8 = 0x0E;
pub const MODE: u8 = 0x11;
pub const TX_MODE: u8 = 0x12;
pub const RX_MODE: u8 = 0x13;
pub const TX_CONTROL: u8 = 0x14;
pub const TX_ASK: u8 = 0x15;
pub const DEMOD: u8 = 0x19;
pub const CRC_RESULT_H: u8 = 0x21;
pub const CRC_RESULT_L: u8 = 0x22;
pub const T_MODE: u8 = 0x2A;
pub const T_PRESCALER: u8 = 0x2B;
pub const T_RELOAD_H: u8 = 0x2C;
pub const T_RELOAD_L: u8 = 0x2D;
pub const T_COUNTER_H: u8 = 0x2E;
pub const T_COUNTER_L: u8 = 0x2F;
pub const VERSION_REG: u8 = 0x37;

// Commands (CommandReg bits 3..0, datasheet §10.3).
pub const CMD_IDLE: u8 = 0x0;
pub const CMD_MEM: u8 = 0x1;
pub const CMD_RANDOM_ID: u8 = 0x2;
pub const CMD_CALC_CRC: u8 = 0x3;
pub const CMD_TRANSMIT: u8 = 0x4;
pub const CMD_NO_CHANGE: u8 = 0x7;
pub const CMD_RECEIVE: u8 = 0x8;
pub const CMD_TRANSCEIVE: u8 = 0xC;
pub const CMD_MF_AUTHENT: u8 = 0xE;
pub const CMD_SOFT_RESET: u8 = 0xF;

// ComIrqReg bits.
const TX_IRQ: u8 = 0x40;
const RX_IRQ: u8 = 0x20;
const IDLE_IRQ: u8 = 0x10;
const HI_ALERT_IRQ: u8 = 0x08;
const LO_ALERT_IRQ: u8 = 0x04;
const ERR_IRQ: u8 = 0x02;
const TIMER_IRQ: u8 = 0x01;
// DivIrqReg bits.
const CRC_IRQ: u8 = 0x04;
// ErrorReg bits.
const BUFFER_OVFL: u8 = 0x10;
const CRC_ERR: u8 = 0x04;
// Status2Reg.
const MF_CRYPTO1_ON: u8 = 0x08;

/// Reset values (datasheet table 20 onwards); 0 where not listed.
fn reset_registers() -> [u8; 64] {
    let mut r = [0u8; 64];
    for (a, v) in [
        (COMMAND, 0x20),
        (COM_IEN, 0x80),
        (COM_IRQ, 0x14),
        (STATUS1, 0x21),
        (WATER_LEVEL, 0x08),
        (CONTROL, 0x10),
        (COLL, 0xA0),
        (MODE, 0x3F),
        (TX_CONTROL, 0x80),
        (0x16, 0x10), // TxSelReg
        (0x17, 0x84), // RxSelReg
        (0x18, 0x84), // RxThresholdReg
        (DEMOD, 0x4D),
        (0x1C, 0x62), // MfTxReg
        (0x1F, 0xEB), // SerialSpeedReg
        (CRC_RESULT_H, 0xFF),
        (CRC_RESULT_L, 0xFF),
        (0x24, 0x26), // ModWidthReg
        (0x26, 0x48), // RFCfgReg
        (0x27, 0x88), // GsNReg
        (0x28, 0x20), // CWGsPReg
        (0x29, 0x20), // ModGsPReg
        (VERSION_REG, VERSION),
    ] {
        r[a as usize] = v;
    }
    r
}

/// CRC_A of ISO 14443-3 (x^16 + x^12 + x^5 + 1, LSB first) from `init`.
pub fn crc_a(init: u16, data: &[u8]) -> u16 {
    let mut crc = init;
    for &b in data {
        crc = crc_step(crc, b, false);
    }
    crc
}

fn crc_step(crc: u16, byte: u8, msb_first: bool) -> u16 {
    if msb_first {
        let mut c = crc ^ ((byte as u16) << 8);
        for _ in 0..8 {
            c = if c & 0x8000 != 0 {
                (c << 1) ^ 0x1021
            } else {
                c << 1
            };
        }
        c
    } else {
        let mut c = crc ^ byte as u16;
        for _ in 0..8 {
            c = if c & 1 != 0 {
                (c >> 1) ^ 0x8408
            } else {
                c >> 1
            };
        }
        c
    }
}

/// `data` followed by its CRC_A, low byte first.
pub fn with_crc(data: &[u8]) -> Vec<u8> {
    let c = crc_a(0x6363, data);
    let mut v = data.to_vec();
    v.extend_from_slice(&[c as u8, (c >> 8) as u8]);
    v
}

/// The frame ends in a correct CRC_A.
fn crc_ok(frame: &[u8]) -> bool {
    frame.len() >= 3 && crc_a(0x6363, frame) == 0
}

// ------------------------------------------------------------- cards

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardKind {
    /// MIFARE Classic 1K: 4-byte UID, 16 sectors × 4 blocks of 16 bytes.
    Classic1k,
    /// MIFARE Ultralight: 7-byte UID, 16 pages of 4 bytes.
    Ultralight,
}

/// ISO 14443-3 PICC states; `halted` marks READY*/ACTIVE* (woken from
/// HALT, where an error goes back to HALT instead of IDLE).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardState {
    Off,
    Idle,
    /// Selecting: the cascade level (1, 2) being resolved.
    Ready(u8),
    Active,
    Halt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyType {
    A,
    B,
}

/// A card's answer: bytes and the valid bits of the last one (0 = 8).
#[derive(Debug, Clone, PartialEq)]
pub struct Answer {
    pub data: Vec<u8>,
    pub last_bits: u8,
    /// Extra time the card needs before answering (EEPROM write).
    pub delay: Seconds,
}

impl Answer {
    fn bytes(data: Vec<u8>) -> Self {
        Answer {
            data,
            last_bits: 0,
            delay: 0.0,
        }
    }
    fn nibble(v: u8) -> Self {
        Answer {
            data: vec![v & 0x0F],
            last_bits: 4,
            delay: 0.0,
        }
    }
}

pub const ACK: u8 = 0xA;
/// NAK: operation not allowed (access conditions, not authenticated, bad
/// address).
pub const NAK_NOT_ALLOWED: u8 = 0x4;
/// NAK: transmission error (CRC).
pub const NAK_CRC: u8 = 0x5;
/// Ultralight NAK: invalid argument.
pub const NAK_INVALID: u8 = 0x0;

#[derive(Debug, Clone)]
pub struct Card {
    pub kind: CardKind,
    pub uid: Vec<u8>,
    /// Classic: 1024 bytes; Ultralight: 64 bytes.
    pub mem: Vec<u8>,
    pub state: CardState,
    halted: bool,
    /// Authenticated sector and key (Classic).
    pub auth: Option<(u8, KeyType)>,
    /// First half of a two-step WRITE: the block/page to write next.
    write_to: Option<u8>,
    /// Sent its nonce to a plain AUTH frame: the next frame cannot be the
    /// encrypted reader answer.
    nonce_sent: bool,
    seed: u32,
}

fn bcc(b: &[u8]) -> u8 {
    b.iter().fold(0, |a, x| a ^ x)
}

impl Card {
    /// A MIFARE Classic 1K with `uid`, transport configuration (keys
    /// FF FF FF FF FF FF, access bits FF 07 80 69) and `blocks` written.
    pub fn classic(uid: [u8; 4], blocks: &[(u8, &[u8])]) -> Self {
        let mut mem = vec![0u8; 1024];
        mem[..4].copy_from_slice(&uid);
        mem[4] = bcc(&uid);
        mem[5] = 0x08; // SAK
        mem[6..8].copy_from_slice(&[0x04, 0x00]); // ATQA
        mem[8..16].copy_from_slice(&[0x62, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69]);
        for s in 0..16 {
            let t = (s * 4 + 3) * 16;
            mem[t..t + 6].fill(0xFF);
            mem[t + 6..t + 10].copy_from_slice(&[0xFF, 0x07, 0x80, 0x69]);
            mem[t + 10..t + 16].fill(0xFF);
        }
        for &(b, data) in blocks {
            let o = b as usize * 16;
            mem[o..o + data.len().min(16)].copy_from_slice(&data[..data.len().min(16)]);
        }
        Self::new(CardKind::Classic1k, uid.to_vec(), mem)
    }

    /// A MIFARE Ultralight with a 7-byte `uid` and `pages` from page 4 on.
    pub fn ultralight(uid: [u8; 7], user: &[u8]) -> Self {
        let mut mem = vec![0u8; 64];
        mem[..3].copy_from_slice(&uid[..3]);
        mem[3] = 0x88 ^ bcc(&uid[..3]);
        mem[4..8].copy_from_slice(&uid[3..]);
        mem[8] = bcc(&uid[3..]);
        mem[9] = 0x48;
        let n = user.len().min(48);
        mem[16..16 + n].copy_from_slice(&user[..n]);
        Self::new(CardKind::Ultralight, uid.to_vec(), mem)
    }

    fn new(kind: CardKind, uid: Vec<u8>, mem: Vec<u8>) -> Self {
        let seed = uid
            .iter()
            .fold(0x1234_5678u32, |a, &b| a.rotate_left(5) ^ b as u32);
        Card {
            kind,
            uid,
            mem,
            state: CardState::Off,
            halted: false,
            auth: None,
            write_to: None,
            nonce_sent: false,
            seed,
        }
    }

    pub fn atqa(&self) -> [u8; 2] {
        match self.kind {
            CardKind::Classic1k => [0x04, 0x00],
            CardKind::Ultralight => [0x44, 0x00],
        }
    }

    fn cascade_levels(&self) -> u8 {
        if self.uid.len() == 4 {
            1
        } else {
            2
        }
    }

    /// UID CLn plus BCC: the five bytes of cascade level `level`.
    fn cl_bytes(&self, level: u8) -> [u8; 5] {
        let part: [u8; 4] = match (self.uid.len(), level) {
            (4, _) => [self.uid[0], self.uid[1], self.uid[2], self.uid[3]],
            (_, 1) => [0x88, self.uid[0], self.uid[1], self.uid[2]],
            _ => [self.uid[3], self.uid[4], self.uid[5], self.uid[6]],
        };
        [part[0], part[1], part[2], part[3], bcc(&part)]
    }

    fn sak(&self, level: u8) -> u8 {
        if level < self.cascade_levels() {
            0x04 // UID not complete
        } else {
            match self.kind {
                CardKind::Classic1k => 0x08,
                CardKind::Ultralight => 0x00,
            }
        }
    }

    /// The field came on (or the card was put on a live antenna).
    pub fn power_on(&mut self) {
        if self.state == CardState::Off {
            self.state = CardState::Idle;
            self.halted = false;
            self.reset_session();
        }
    }

    pub fn power_off(&mut self) {
        self.state = CardState::Off;
        self.reset_session();
    }

    fn reset_session(&mut self) {
        self.auth = None;
        self.write_to = None;
        self.nonce_sent = false;
    }

    /// Something it does not understand: back to IDLE (HALT if woken
    /// from there), no answer.
    fn error(&mut self) -> Option<Answer> {
        if matches!(self.state, CardState::Ready(_) | CardState::Active) {
            self.state = if self.halted {
                CardState::Halt
            } else {
                CardState::Idle
            };
        }
        self.reset_session();
        None
    }

    /// A frame from the reader: `bits` valid bits in the last byte (0 =
    /// 8); `crypto`: the reader encrypts it (MFCrypto1On).
    pub fn frame(&mut self, data: &[u8], bits: u8, crypto: bool) -> Option<Answer> {
        if self.state == CardState::Off || data.is_empty() {
            return None;
        }
        // Encrypted frames only make sense to an authenticated card, plain
        // ones only to one that is not.
        if crypto != self.auth.is_some() {
            return self.error();
        }
        if std::mem::take(&mut self.nonce_sent) {
            // The plain AUTH's next frame is the reader's encrypted answer,
            // which a reader without Crypto1 cannot give.
            return self.error();
        }
        // Short frame: REQA / WUPA (7 bits).
        if bits == 7 && data.len() == 1 {
            let wake = match data[0] {
                0x26 => self.state == CardState::Idle,
                0x52 => matches!(self.state, CardState::Idle | CardState::Halt),
                _ => return self.error(),
            };
            if wake {
                self.halted = self.state == CardState::Halt;
                self.state = CardState::Ready(1);
                return Some(Answer::bytes(self.atqa().to_vec()));
            }
            return self.error();
        }
        if bits != 0 {
            return self.error();
        }
        match self.state {
            CardState::Ready(level) => self.select(level, data),
            CardState::Active => match self.kind {
                CardKind::Classic1k => self.classic_command(data),
                CardKind::Ultralight => self.ultralight_command(data),
            },
            _ => None,
        }
    }

    /// ANTICOLLISION and SELECT of cascade level `level`.
    fn select(&mut self, level: u8, data: &[u8]) -> Option<Answer> {
        let sel = [0x93, 0x95, 0x97][(level - 1) as usize];
        if data.len() < 2 || data[0] != sel {
            return self.error();
        }
        let nvb = data[1];
        let cl = self.cl_bytes(level);
        if nvb == 0x70 {
            if data.len() != 9 || !crc_ok(data) || data[2..7] != cl {
                return self.error();
            }
            let sak = self.sak(level);
            self.state = if level < self.cascade_levels() {
                CardState::Ready(level + 1)
            } else {
                CardState::Active
            };
            return Some(Answer::bytes(with_crc(&[sak])));
        }
        // ANTICOLLISION: NVB = bytes sent (with SEL and NVB) << 4 | bits.
        let (bytes, extra) = ((nvb >> 4) as usize, nvb & 0x0F);
        if !(2..=6).contains(&bytes) || extra != 0 || data.len() != bytes {
            // Bit-oriented anticollision frames (only after a collision)
            // are not modelled.
            return self.error();
        }
        let known = &data[2..];
        if known != &cl[..known.len()] {
            // Another UID: this card keeps quiet.
            return None;
        }
        Some(Answer::bytes(cl[known.len()..].to_vec()))
    }

    fn halt(&mut self, data: &[u8]) -> Option<Answer> {
        if data.len() == 4 && data[1] == 0 && crc_ok(data) {
            self.state = CardState::Halt;
            self.halted = true;
            self.reset_session();
            return None;
        }
        self.error()
    }

    fn classic_command(&mut self, data: &[u8]) -> Option<Answer> {
        if let Some(block) = self.write_to.take() {
            // Second step of WRITE: 16 bytes and CRC.
            if data.len() != 18 {
                return self.error();
            }
            if !crc_ok(data) {
                return Some(Answer::nibble(NAK_CRC));
            }
            let o = block as usize * 16;
            self.mem[o..o + 16].copy_from_slice(&data[..16]);
            return Some(Answer {
                delay: WRITE_TIME,
                ..Answer::nibble(ACK)
            });
        }
        if data.len() != 4 {
            return self.error();
        }
        if !crc_ok(data) {
            return Some(Answer::nibble(NAK_CRC));
        }
        let (cmd, block) = (data[0], data[1]);
        match cmd {
            0x50 => self.halt(data),
            0x60 | 0x61 => {
                // AUTH sent as a plain frame (not by MFAuthent): the card
                // answers its nonce nT and waits for the encrypted answer.
                if block >= 64 {
                    return Some(Answer::nibble(NAK_NOT_ALLOWED));
                }
                self.nonce_sent = true;
                self.seed = self.seed.wrapping_mul(1_103_515_245).wrapping_add(12345);
                Some(Answer::bytes(self.seed.to_be_bytes().to_vec()))
            }
            0x30 => {
                if !self.allowed(block, false) {
                    return Some(Answer::nibble(NAK_NOT_ALLOWED));
                }
                let mut out = self.mem[block as usize * 16..][..16].to_vec();
                if block % 4 == 3 {
                    // Key A never reads back; key B only where readable.
                    out[..6].fill(0);
                    if !self.key_b_readable(block / 4) {
                        out[10..].fill(0);
                    }
                }
                Some(Answer::bytes(with_crc(&out)))
            }
            0xA0 => {
                if !self.allowed(block, true) {
                    return Some(Answer::nibble(NAK_NOT_ALLOWED));
                }
                self.write_to = Some(block);
                Some(Answer::nibble(ACK))
            }
            // Value blocks (INCREMENT, DECREMENT, RESTORE, TRANSFER) are not
            // modelled.
            _ => Some(Answer::nibble(NAK_NOT_ALLOWED)),
        }
    }

    /// Access bits C1 C2 C3 of `block` in sector `sector`, or `None` if
    /// the trailer's bytes 6–8 are not a valid (inverted copy) pattern.
    fn access_bits(&self, sector: u8, block: u8) -> Option<u8> {
        let t = (sector as usize * 4 + 3) * 16;
        let (b6, b7, b8) = (self.mem[t + 6], self.mem[t + 7], self.mem[t + 8]);
        let c1 = b7 >> 4;
        let c2 = b8 & 0x0F;
        let c3 = b8 >> 4;
        if (!b6 & 0x0F) != c1 || (!b6 >> 4) != c2 || (!b7 & 0x0F) != c3 {
            return None;
        }
        let bit = |c: u8| (c >> block) & 1;
        Some(bit(c1) << 2 | bit(c2) << 1 | bit(c3))
    }

    fn key_b_readable(&self, sector: u8) -> bool {
        // Trailer access 000, 010 and 001 let key A read key B.
        matches!(self.access_bits(sector, 3), Some(0b000..=0b010))
    }

    /// READ (`write` false) or WRITE of `block` allowed with the key used
    /// for the authentication (MF1S50 §8.7).
    fn allowed(&self, block: u8, write: bool) -> bool {
        let Some((sector, key)) = self.auth else {
            return false;
        };
        if block >= 64 || block / 4 != sector {
            return false;
        }
        if write && block == 0 {
            return false; // manufacturer block
        }
        let Some(c) = self.access_bits(sector, block % 4) else {
            return false; // blocked sector
        };
        // Key B readable: it cannot serve for authentication.
        if key == KeyType::B && self.key_b_readable(sector) {
            return false;
        }
        let a = key == KeyType::A;
        if block % 4 == 3 {
            // Trailer: reading gives the access bits (key A or B per the
            // table); writing keys or access bits needs the right key.
            return if write {
                match c {
                    0b000 | 0b001 => a,
                    0b100 | 0b011 => !a,
                    _ => false,
                }
            } else {
                true
            };
        }
        match (c, write) {
            (0b000, _) => true,
            (0b010 | 0b100 | 0b110 | 0b001, false) => true,
            (0b011 | 0b101, false) => !a,
            (0b100 | 0b110 | 0b011, true) => !a,
            _ => false,
        }
    }

    /// MIFARE authentication with `key` of type `kind` for `block`, by a
    /// reader that has the card's `uid`: true when the card accepts.
    pub fn authenticate(&mut self, kind: KeyType, block: u8, key: &[u8], uid: &[u8]) -> bool {
        if self.state != CardState::Active || self.kind != CardKind::Classic1k || block >= 64 {
            return false;
        }
        let t = ((block / 4) as usize * 4 + 3) * 16;
        let stored = match kind {
            KeyType::A => &self.mem[t..t + 6],
            KeyType::B => &self.mem[t + 10..t + 16],
        };
        if stored == key && uid == &self.uid[..4] {
            self.auth = Some((block / 4, kind));
            true
        } else {
            false
        }
    }

    /// The card answered the first AUTH step (nT): it was ACTIVE, Classic.
    pub fn answers_auth(&self, block: u8) -> bool {
        self.state == CardState::Active && self.kind == CardKind::Classic1k && block < 64
    }

    /// Failed authentication: back to IDLE (or HALT).
    pub fn auth_failed(&mut self) {
        self.error();
    }

    fn ultralight_command(&mut self, data: &[u8]) -> Option<Answer> {
        if let Some(page) = self.write_to.take() {
            // COMPATIBILITY WRITE, second step: 16 bytes, the first 4 kept.
            if data.len() != 18 {
                return self.error();
            }
            if !crc_ok(data) {
                return Some(Answer::nibble(0x1));
            }
            return Some(self.ul_write(page, &data[..4]));
        }
        if data.len() < 4 || !crc_ok(data) {
            return if data.len() >= 4 {
                Some(Answer::nibble(0x1))
            } else {
                self.error()
            };
        }
        let page = data[1];
        match (data[0], data.len()) {
            (0x50, 4) => self.halt(data),
            (0x30, 4) => {
                if page >= 16 {
                    return Some(Answer::nibble(NAK_INVALID));
                }
                // Four pages, rolling over from 15 to 0.
                let out: Vec<u8> = (0..16)
                    .map(|i| self.mem[(page as usize * 4 + i) % 64])
                    .collect();
                Some(Answer::bytes(with_crc(&out)))
            }
            (0xA2, 8) => Some(self.ul_write(page, &data[2..6])),
            (0xA0, 4) => {
                if page >= 16 {
                    return Some(Answer::nibble(NAK_INVALID));
                }
                self.write_to = Some(page);
                Some(Answer::nibble(ACK))
            }
            _ => Some(Answer::nibble(NAK_INVALID)),
        }
    }

    fn ul_write(&mut self, page: u8, d: &[u8]) -> Answer {
        let locked = |m: &[u8], p: u8| match p {
            0 | 1 => true,
            3..=7 => m[10] >> p & 1 != 0,
            8..=15 => m[11] >> (p - 8) & 1 != 0,
            _ => false,
        };
        if page >= 16 || locked(&self.mem, page) {
            return Answer::nibble(NAK_INVALID);
        }
        let o = page as usize * 4;
        match page {
            // Lock bytes and OTP: bits only go from 0 to 1.
            2 => {
                self.mem[o + 2] |= d[2];
                self.mem[o + 3] |= d[3];
            }
            3 => {
                for i in 0..4 {
                    self.mem[o + i] |= d[i];
                }
            }
            _ => self.mem[o..o + 4].copy_from_slice(d),
        }
        Answer {
            delay: WRITE_TIME,
            ..Answer::nibble(ACK)
        }
    }
}

/// The cards the editor offers (prop `card`: 1–4; 0 = none on the
/// antenna).
pub fn stock_cards() -> Vec<Card> {
    let pad = |s: &str| {
        let mut b = [0u8; 16];
        b[..s.len().min(16)].copy_from_slice(&s.as_bytes()[..s.len().min(16)]);
        b
    };
    vec![
        // White ISO card.
        Card::classic([0x7A, 0x3B, 0x1C, 0x9D], &[(4, &pad("Card A: guest"))]),
        // Second white card.
        Card::classic([0x5E, 0x82, 0xF4, 0x03], &[(4, &pad("Card B: visitor"))]),
        // Blue key fob.
        Card::classic([0xC1, 0x9A, 0x6E, 0x22], &[(4, &pad("Fob: staff #42"))]),
        // NFC sticker (Ultralight).
        Card::ultralight(
            [0x04, 0xA1, 0xB2, 0xC3, 0xD4, 0xE5, 0x80],
            b"Sticker: hello RFID!",
        ),
    ]
}

// ------------------------------------------------------------- reader

/// A timed step of the command on the air.
#[derive(Debug, Clone)]
enum Step {
    /// The reader's frame is out: TxIRq, the timer starts (TAuto).
    TxEnd,
    /// The card's first bit: the timer stops (TAuto).
    RxStart,
    /// The card's frame is in the FIFO.
    RxEnd(Vec<u8>, u8),
    /// MFAuthent: the second reader frame is out (timer starts again).
    AuthTx,
    /// MFAuthent done: Crypto1 on.
    AuthDone,
}

#[derive(Debug, Clone)]
pub struct Mfrc522 {
    regs: [u8; 64],
    fifo: VecDeque<u8>,
    /// The 25-byte internal buffer (Mem, GenerateRandomID).
    buffer: [u8; 25],
    /// Running CRC of CalcCRC.
    crc: u16,
    /// Steps of the command on the air, in time order.
    steps: VecDeque<(Seconds, Step)>,
    /// Timer counting down from TReload since this time (None: stopped).
    timer_start: Option<Seconds>,
    /// Value the stopped timer holds.
    timer_held: u16,
    /// SPI: inside a CS-low frame, its mode and address.
    in_frame: bool,
    reading: bool,
    address: u8,
    pending_read: Option<u8>,
    /// Pins: VCC present and NRSTPD high.
    pub powered: bool,
    pub running: bool,
    /// The antenna field as last worked out.
    pub field: bool,
    pub cards: Vec<Card>,
    /// Index into `cards` of the one on the antenna.
    pub card: Option<usize>,
    random: u32,
    /// Frames sent on the air and cards that answered (for tests and the
    /// UI).
    pub frames: u32,
    pub answers: u32,
}

impl Default for Mfrc522 {
    fn default() -> Self {
        Self::new()
    }
}

impl Mfrc522 {
    pub fn new() -> Self {
        Mfrc522 {
            regs: reset_registers(),
            fifo: VecDeque::new(),
            buffer: [0; 25],
            crc: 0,
            steps: VecDeque::new(),
            timer_start: None,
            timer_held: 0,
            in_frame: false,
            reading: false,
            address: 0,
            pending_read: None,
            powered: true,
            running: true,
            field: false,
            cards: stock_cards(),
            card: None,
            random: 0x2545_F491,
            frames: 0,
            answers: 0,
        }
    }

    pub fn reg(&self, a: u8) -> u8 {
        self.regs[a as usize & 0x3F]
    }

    pub fn crypto_on(&self) -> bool {
        self.regs[STATUS2 as usize] & MF_CRYPTO1_ON != 0
    }

    /// The card on the antenna.
    pub fn present(&self) -> Option<&Card> {
        self.card.and_then(|i| self.cards.get(i))
    }

    fn present_mut(&mut self) -> Option<&mut Card> {
        self.card.and_then(|i| self.cards.get_mut(i))
    }

    /// Put card `n` (1-based, 0 = none) on the antenna.
    pub fn set_card(&mut self, n: usize) {
        let next = (n >= 1 && n <= self.cards.len()).then(|| n - 1);
        if next == self.card {
            return;
        }
        if let Some(c) = self.present_mut() {
            c.power_off();
        }
        self.card = next;
        let field = self.field;
        if let Some(c) = self.present_mut() {
            if field {
                c.power_on();
            }
        }
    }

    /// Everything back to the reset values (power-up, NRSTPD, SoftReset).
    fn reset(&mut self) {
        self.regs = reset_registers();
        self.fifo.clear();
        self.steps.clear();
        self.timer_start = None;
        self.timer_held = 0;
        self.crc = 0;
        self.update_field();
    }

    /// Supply and NRSTPD: `powered` (VCC above its minimum) and `rst`
    /// (NRSTPD high).
    pub fn pins(&mut self, powered: bool, rst: bool, cs_high: bool) {
        let run = powered && rst;
        if run != self.running || powered != self.powered {
            self.powered = powered;
            if run && !self.running {
                // Power-up or the rising edge of NRSTPD: a hard reset.
                self.running = true;
                self.reset();
                self.buffer = [0; 25];
            } else if !run {
                self.running = false;
                self.reset();
            }
        }
        if cs_high {
            self.end_frame();
        }
    }

    /// Power cycle (the board restarted): reset, card unpowered.
    pub fn power_cycle(&mut self) {
        self.running = true;
        self.powered = true;
        self.reset();
        self.buffer = [0; 25];
        self.end_frame();
    }

    /// NSS went high: the next byte is an address again.
    pub fn end_frame(&mut self) {
        self.in_frame = false;
        self.pending_read = None;
    }

    fn update_field(&mut self) {
        let field = self.running
            && self.regs[COMMAND as usize] & 0x10 == 0
            && self.regs[TX_CONTROL as usize] & 0x03 != 0;
        if field != self.field {
            self.field = field;
            if let Some(c) = self.present_mut() {
                if field {
                    c.power_on();
                } else {
                    c.power_off();
                }
            }
        }
    }

    /// One byte on SPI while NSS is low; returns the byte on MISO.
    pub fn exchange(&mut self, now: Seconds, byte: u8) -> u8 {
        if !self.running {
            return 0xFF; // MISO high impedance in hard power-down
        }
        self.advance(now);
        let reply = match self.pending_read.take() {
            Some(a) => self.read(now, a),
            None => 0x00,
        };
        let addr = (byte >> 1) & 0x3F;
        if !self.in_frame {
            self.in_frame = true;
            self.reading = byte & 0x80 != 0;
            self.address = addr;
            if self.reading {
                self.pending_read = Some(addr);
            }
        } else if self.reading {
            // Each further byte names the next register to read; the last
            // one (0x00) only clocks out the previous value.
            if byte & 0x80 != 0 {
                self.pending_read = Some(addr);
            }
        } else {
            self.write(now, self.address, byte);
        }
        reply
    }

    // ---- timer

    fn timer_tick(&self) -> Seconds {
        let p = ((self.regs[T_MODE as usize] as u32 & 0x0F) << 8)
            | self.regs[T_PRESCALER as usize] as u32;
        let even = self.regs[DEMOD as usize] & 0x10 != 0;
        (2 * p + if even { 2 } else { 1 }) as f64 / FC
    }

    fn reload(&self) -> u16 {
        u16::from_be_bytes([
            self.regs[T_RELOAD_H as usize],
            self.regs[T_RELOAD_L as usize],
        ])
    }

    fn timer_expiry(&self) -> Option<Seconds> {
        self.timer_start
            .map(|s| s + (self.reload() as f64 + 1.0) * self.timer_tick())
    }

    fn timer_value(&self, now: Seconds) -> u16 {
        match self.timer_start {
            Some(s) => {
                let k = ((now - s) / self.timer_tick()).floor().max(0.0) as u64;
                (self.reload() as u64).saturating_sub(k) as u16
            }
            None => self.timer_held,
        }
    }

    fn start_timer(&mut self, at: Seconds) {
        self.timer_start = Some(at);
    }

    fn stop_timer(&mut self, at: Seconds) {
        if self.timer_start.is_some() {
            self.timer_held = self.timer_value(at);
            self.timer_start = None;
        }
    }

    fn t_auto(&self) -> bool {
        self.regs[T_MODE as usize] & 0x80 != 0
    }

    // ---- scheduled steps

    /// When an output (IRQ) may next change by itself.
    pub fn next(&self) -> Option<Seconds> {
        if !self.running {
            return None;
        }
        let step = self.steps.front().map(|s| s.0);
        match (step, self.timer_expiry()) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    /// Run the steps and the timer up to `now`.
    pub fn advance(&mut self, now: Seconds) {
        if !self.running {
            return;
        }
        loop {
            let step = self.steps.front().map(|s| s.0).filter(|&t| t <= now);
            let timer = self.timer_expiry().filter(|&t| t <= now);
            match (step, timer) {
                (Some(s), Some(t)) if t < s => self.timer_fires(t),
                (None, Some(t)) => self.timer_fires(t),
                (Some(_), _) => {
                    let (t, step) = self.steps.pop_front().unwrap();
                    self.run_step(t, step);
                }
                (None, None) => break,
            }
        }
    }

    fn timer_fires(&mut self, t: Seconds) {
        self.regs[COM_IRQ as usize] |= TIMER_IRQ;
        if self.regs[T_MODE as usize] & 0x10 != 0 {
            self.timer_start = Some(t); // TAutoRestart
        } else {
            self.timer_start = None;
            self.timer_held = 0;
        }
    }

    fn run_step(&mut self, t: Seconds, step: Step) {
        match step {
            Step::TxEnd => {
                self.regs[COM_IRQ as usize] |= TX_IRQ;
                if self.command() == CMD_TRANSMIT {
                    self.finish();
                }
                if self.t_auto() {
                    self.start_timer(t);
                }
            }
            Step::AuthTx => {
                if self.t_auto() {
                    self.start_timer(t);
                }
            }
            Step::RxStart => {
                if self.t_auto() && self.regs[RX_MODE as usize] & 0x04 == 0 {
                    self.stop_timer(t);
                }
            }
            Step::RxEnd(data, bits) => self.receive(data, bits),
            Step::AuthDone => {
                self.regs[STATUS2 as usize] |= MF_CRYPTO1_ON;
                self.finish();
            }
        }
    }

    /// A frame from the card lands in the FIFO.
    fn receive(&mut self, mut data: Vec<u8>, bits: u8) {
        if self.regs[RX_MODE as usize] & 0x80 != 0 && bits == 0 {
            // RxCRCEn: the CRC is checked and not put in the FIFO.
            if crc_ok(&data) {
                data.truncate(data.len() - 2);
            } else {
                self.regs[ERROR as usize] |= CRC_ERR;
                self.regs[COM_IRQ as usize] |= ERR_IRQ;
            }
        }
        for b in data {
            self.push_fifo(b);
        }
        self.regs[CONTROL as usize] = (self.regs[CONTROL as usize] & !0x07) | (bits & 0x07);
        self.regs[COLL as usize] = 0xA0 | (self.regs[COLL as usize] & 0x80);
        self.regs[COM_IRQ as usize] |= RX_IRQ;
        if self.command() == CMD_RECEIVE {
            self.finish();
        }
    }

    /// The command ended by itself: IdleIRq, CommandReg to Idle.
    fn finish(&mut self) {
        self.regs[COMMAND as usize] &= 0xF0;
        self.regs[COM_IRQ as usize] |= IDLE_IRQ;
    }

    fn command(&self) -> u8 {
        self.regs[COMMAND as usize] & 0x0F
    }

    fn push_fifo(&mut self, b: u8) {
        if self.fifo.len() >= 64 {
            self.regs[ERROR as usize] |= BUFFER_OVFL;
            self.regs[COM_IRQ as usize] |= ERR_IRQ;
        } else {
            self.fifo.push_back(b);
        }
        self.alerts();
    }

    fn alerts(&mut self) {
        let wl = self.regs[WATER_LEVEL as usize] as usize & 0x3F;
        if self.fifo.len() <= wl {
            self.regs[COM_IRQ as usize] |= LO_ALERT_IRQ;
        }
        if 64 - self.fifo.len() <= wl {
            self.regs[COM_IRQ as usize] |= HI_ALERT_IRQ;
        }
    }

    fn air_time(bytes: usize, last_bits: u8) -> Seconds {
        let bits = if bytes == 0 {
            0
        } else {
            (bytes - 1) * 9
                + if last_bits == 0 {
                    9
                } else {
                    last_bits as usize
                }
        };
        // Start of communication and end bits.
        (bits + 2) as f64 / BIT_RATE
    }

    /// The reader's frame from the FIFO goes out at `now` (Transmit or
    /// Transceive with StartSend).
    fn transmit(&mut self, now: Seconds) {
        let mut data: Vec<u8> = self.fifo.drain(..).collect();
        self.alerts();
        let framing = self.regs[BIT_FRAMING as usize];
        let last = framing & 0x07;
        if self.regs[TX_MODE as usize] & 0x80 != 0 {
            data = self.with_reader_crc(&data); // TxCRCEn
        }
        self.regs[ERROR as usize] &= 0x40; // TempErr stays
        let tx_end = now + Self::air_time(data.len(), last);
        self.steps.clear();
        self.steps.push_back((tx_end, Step::TxEnd));
        self.frames += 1;
        if self.command() != CMD_TRANSCEIVE {
            return;
        }
        let crypto = self.crypto_on();
        // Type A cards only demodulate 100 % ASK (TxASKReg Force100ASK).
        let hears = self.field && self.regs[TX_ASK as usize] & 0x40 != 0;
        let answer = match self.present_mut() {
            Some(c) if hears => c.frame(&data, last, crypto),
            _ => None,
        };
        if let Some(a) = answer {
            self.answers += 1;
            let rx_start = tx_end + FDT + a.delay;
            let rx_end = rx_start + Self::air_time(a.data.len(), a.last_bits);
            self.steps.push_back((rx_start, Step::RxStart));
            self.steps
                .push_back((rx_end, Step::RxEnd(a.data, a.last_bits)));
        }
    }

    fn with_reader_crc(&self, data: &[u8]) -> Vec<u8> {
        let c = self.crc_over(data);
        let mut v = data.to_vec();
        v.extend_from_slice(&[c as u8, (c >> 8) as u8]);
        v
    }

    fn crc_preset(&self) -> u16 {
        [0x0000, 0x6363, 0xA671, 0xFFFF][(self.regs[MODE as usize] & 3) as usize]
    }

    fn crc_over(&self, data: &[u8]) -> u16 {
        let msb = self.regs[MODE as usize] & 0x80 != 0;
        data.iter()
            .fold(self.crc_preset(), |c, &b| crc_step(c, b, msb))
    }

    /// MFAuthent: FIFO = 0x60/0x61, block, 6 key bytes, 4 UID bytes.
    fn authenticate(&mut self, now: Seconds) {
        let d: Vec<u8> = self.fifo.drain(..).collect();
        self.alerts();
        self.regs[ERROR as usize] &= 0x40;
        self.steps.clear();
        self.frames += 1;
        let tx1 = now + Self::air_time(4, 0);
        self.steps.push_back((tx1, Step::TxEnd));
        let ok_frame = d.len() >= 12 && (d[0] == 0x60 || d[0] == 0x61);
        let hears = self.field && self.regs[TX_ASK as usize] & 0x40 != 0;
        let crypto = self.crypto_on();
        let (block, kind) = (
            d.get(1).copied().unwrap_or(0),
            if d.first() == Some(&0x61) {
                KeyType::B
            } else {
                KeyType::A
            },
        );
        let Some(card) = self.card.and_then(|i| self.cards.get_mut(i)) else {
            return;
        };
        if !hears || !ok_frame {
            return; // nobody answers: the timer runs out
        }
        // A nested authentication goes encrypted under the present key;
        // a first one in plain.
        if crypto != card.auth.is_some() {
            card.auth_failed();
            return;
        }
        if !card.answers_auth(block) {
            return;
        }
        // nT (4 bytes), then the reader's nR + aR (8 bytes), then aT.
        let nt_start = tx1 + FDT;
        let nt_end = nt_start + Self::air_time(4, 0);
        let tx2 = nt_end + 2e-4 + Self::air_time(8, 0);
        self.steps.push_back((nt_start, Step::RxStart));
        self.steps.push_back((tx2, Step::AuthTx));
        if card.authenticate(kind, block, &d[2..8], &d[8..12]) {
            let at_start = tx2 + FDT;
            self.steps.push_back((at_start, Step::RxStart));
            self.steps
                .push_back((at_start + Self::air_time(4, 0), Step::AuthDone));
            self.answers += 1;
        } else {
            card.auth_failed();
        }
    }

    fn start_command(&mut self, now: Seconds, cmd: u8) {
        // Any command cancels what is on the air.
        self.steps.clear();
        match cmd {
            CMD_IDLE | CMD_RECEIVE | CMD_TRANSCEIVE => {}
            CMD_MEM => {
                if self.fifo.is_empty() {
                    for b in self.buffer {
                        self.push_fifo(b);
                    }
                } else {
                    for i in 0..25 {
                        self.buffer[i] = self.fifo.pop_front().unwrap_or(0);
                    }
                    self.alerts();
                }
                self.finish();
            }
            CMD_RANDOM_ID => {
                for i in 0..10 {
                    self.random ^= self.random << 13;
                    self.random ^= self.random >> 17;
                    self.random ^= self.random << 5;
                    self.buffer[i] = self.random as u8;
                }
                self.finish();
            }
            CMD_CALC_CRC => {
                self.crc = self.crc_preset();
                self.feed_crc();
            }
            CMD_TRANSMIT => self.transmit(now),
            CMD_MF_AUTHENT => self.authenticate(now),
            CMD_SOFT_RESET => {
                self.reset();
            }
            _ => {}
        }
    }

    /// CalcCRC takes every byte that is in the FIFO, and keeps taking
    /// those written to it until another command.
    fn feed_crc(&mut self) {
        let msb = self.regs[MODE as usize] & 0x80 != 0;
        while let Some(b) = self.fifo.pop_front() {
            self.crc = crc_step(self.crc, b, msb);
        }
        self.alerts();
        self.regs[CRC_RESULT_H as usize] = (self.crc >> 8) as u8;
        self.regs[CRC_RESULT_L as usize] = self.crc as u8;
        self.regs[DIV_IRQ as usize] |= CRC_IRQ;
    }

    fn write(&mut self, now: Seconds, a: u8, v: u8) {
        let i = a as usize;
        match a {
            COMMAND => {
                let cmd = v & 0x0F;
                let keep = if cmd == CMD_NO_CHANGE {
                    self.command()
                } else {
                    cmd
                };
                self.regs[i] = (v & 0x30) | keep;
                if cmd != CMD_NO_CHANGE {
                    self.start_command(now, cmd);
                }
                self.update_field();
            }
            COM_IRQ | DIV_IRQ => {
                let mask = v & 0x7F;
                if v & 0x80 != 0 {
                    self.regs[i] |= mask;
                } else {
                    self.regs[i] &= !mask;
                }
            }
            FIFO_DATA => {
                self.push_fifo(v);
                if self.command() == CMD_CALC_CRC {
                    self.feed_crc();
                }
            }
            FIFO_LEVEL => {
                if v & 0x80 != 0 {
                    self.fifo.clear();
                    self.regs[ERROR as usize] &= !BUFFER_OVFL;
                    self.alerts();
                }
            }
            CONTROL => {
                if v & 0x80 != 0 {
                    self.stop_timer(now);
                }
                if v & 0x40 != 0 {
                    self.start_timer(now);
                }
            }
            BIT_FRAMING => {
                self.regs[i] = v;
                if v & 0x80 != 0 && self.command() == CMD_TRANSCEIVE {
                    self.transmit(now);
                }
            }
            STATUS2 => {
                // MFCrypto1On can only be cleared; bits 7 and 6 are R/W.
                let crypto = self.regs[i] & v & MF_CRYPTO1_ON;
                self.regs[i] = (v & 0xC0) | crypto | (self.regs[i] & 0x07);
            }
            TX_CONTROL => {
                self.regs[i] = v;
                self.update_field();
            }
            // Read-only.
            // ValuesAfterColl is the one writable bit.
            COLL => self.regs[i] = (self.regs[i] & 0x7F) | (v & 0x80),
            ERROR | STATUS1 | CRC_RESULT_H | CRC_RESULT_L | T_COUNTER_H | T_COUNTER_L
            | VERSION_REG | 0x00 | 0x0F | 0x10 | 0x20 | 0x30 => {}
            _ => self.regs[i] = v,
        }
    }

    fn irq_active(&self) -> bool {
        let com = self.regs[COM_IRQ as usize] & self.regs[COM_IEN as usize] & 0x7F;
        let div = self.regs[DIV_IRQ as usize] & self.regs[DIV_IEN as usize] & 0x14;
        com != 0 || div != 0
    }

    fn read(&mut self, now: Seconds, a: u8) -> u8 {
        match a {
            FIFO_DATA => {
                let b = self.fifo.pop_front().unwrap_or(0);
                self.alerts();
                b
            }
            FIFO_LEVEL => self.fifo.len() as u8,
            STATUS1 => {
                let wl = self.regs[WATER_LEVEL as usize] as usize & 0x3F;
                let crc_ok = self.crc == 0;
                (crc_ok as u8) << 6
                    | 1 << 5 // CRCReady
                    | (self.irq_active() as u8) << 4
                    | (self.timer_start.is_some() as u8) << 3
                    | ((64 - self.fifo.len() <= wl) as u8) << 1
                    | (self.fifo.len() <= wl) as u8
            }
            STATUS2 => {
                let modem = match self.command() {
                    CMD_TRANSCEIVE if self.steps.is_empty() => 1,
                    CMD_TRANSCEIVE | CMD_RECEIVE | CMD_TRANSMIT | CMD_MF_AUTHENT => {
                        match self.steps.front() {
                            Some((_, Step::TxEnd | Step::AuthTx)) => 3,
                            Some((_, Step::RxEnd(..) | Step::AuthDone)) => 6,
                            _ => 5,
                        }
                    }
                    _ => 0,
                };
                (self.regs[STATUS2 as usize] & 0xF8) | modem
            }
            T_COUNTER_H => (self.timer_value(now) >> 8) as u8,
            T_COUNTER_L => self.timer_value(now) as u8,
            BIT_FRAMING => {
                // StartSend reads back while the frame is going out.
                let sending = matches!(self.steps.front(), Some((_, Step::TxEnd)));
                (self.regs[BIT_FRAMING as usize] & 0x7F) | (sending as u8) << 7
            }
            0x00 | 0x0F | 0x10 | 0x20 | 0x30 => 0,
            _ => self.regs[a as usize],
        }
    }

    /// The IRQ pin: `Some(level)` driven, `None` released (open drain,
    /// the default; DivIEnReg IRQPushPull makes it push-pull). ComIEnReg
    /// IRqInv (set after reset) makes it active low.
    pub fn irq_pin(&self) -> Option<bool> {
        if !self.running {
            return None;
        }
        let inv = self.regs[COM_IEN as usize] & 0x80 != 0;
        let level = self.irq_active() != inv;
        if self.regs[DIV_IEN as usize] & 0x80 != 0 {
            Some(level)
        } else {
            (!level).then_some(false)
        }
    }

    /// Short state of the card on the antenna for the UI: "none", "off",
    /// "idle", "ready", "active", "auth", "halt".
    pub fn card_state(&self) -> &'static str {
        match self.present() {
            None => "none",
            Some(c) => match c.state {
                CardState::Off => "off",
                CardState::Idle => "idle",
                CardState::Ready(_) => "ready",
                CardState::Active if c.auth.is_some() => "auth",
                CardState::Active => "active",
                CardState::Halt => "halt",
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A driver like the Arduino MFRC522 library, on the model directly.
    struct Drv {
        r: Mfrc522,
        t: Seconds,
    }

    impl Drv {
        fn new() -> Self {
            let mut d = Drv {
                r: Mfrc522::new(),
                t: 0.0,
            };
            d.init();
            d
        }
        fn tick(&mut self, dt: Seconds) {
            self.t += dt;
            self.r.advance(self.t);
        }
        fn wr(&mut self, a: u8, v: u8) {
            self.t += 2e-6;
            self.r.exchange(self.t, a << 1);
            self.r.exchange(self.t, v);
            self.r.end_frame();
        }
        fn rd(&mut self, a: u8) -> u8 {
            self.t += 2e-6;
            self.r.exchange(self.t, 0x80 | a << 1);
            let v = self.r.exchange(self.t, 0);
            self.r.end_frame();
            v
        }
        fn init(&mut self) {
            self.wr(COMMAND, CMD_SOFT_RESET);
            self.wr(T_MODE, 0x80);
            self.wr(T_PRESCALER, 0xA9);
            self.wr(T_RELOAD_H, 0x03);
            self.wr(T_RELOAD_L, 0xE8);
            self.wr(TX_ASK, 0x40);
            self.wr(MODE, 0x3D);
            let v = self.rd(TX_CONTROL);
            self.wr(TX_CONTROL, v | 0x03);
        }
        /// Transceive `data` with `bits`; Ok((bytes, valid bits)) or Err(irq).
        fn transceive(&mut self, data: &[u8], bits: u8) -> Result<(Vec<u8>, u8), u8> {
            self.wr(COMMAND, CMD_IDLE);
            self.wr(COM_IRQ, 0x7F);
            self.wr(FIFO_LEVEL, 0x80);
            for &b in data {
                self.wr(FIFO_DATA, b);
            }
            self.wr(BIT_FRAMING, bits);
            self.wr(COMMAND, CMD_TRANSCEIVE);
            let f = self.rd(BIT_FRAMING);
            self.wr(BIT_FRAMING, f | 0x80);
            loop {
                self.tick(20e-6);
                let n = self.rd(COM_IRQ);
                if n & 0x30 != 0 {
                    break;
                }
                if n & 0x01 != 0 {
                    return Err(n);
                }
                assert!(self.t < 1.0);
            }
            let n = self.rd(FIFO_LEVEL);
            let out = (0..n).map(|_| self.rd(FIFO_DATA)).collect();
            Ok((out, self.rd(CONTROL) & 7))
        }
        fn select(&mut self) -> Option<Vec<u8>> {
            // A card still ACTIVE takes the first REQA as an error (IDLE).
            let atqa = self
                .transceive(&[0x26], 7)
                .or_else(|_| self.transceive(&[0x26], 7))
                .ok()?;
            assert_eq!(atqa.0.len(), 2);
            let mut uid = Vec::new();
            for sel in [0x93u8, 0x95] {
                let (cl, _) = self.transceive(&[sel, 0x20], 0).ok()?;
                let mut f = vec![sel, 0x70];
                f.extend_from_slice(&cl);
                let (sak, _) = self.transceive(&with_crc(&f), 0).ok()?;
                assert!(crc_ok(&sak));
                if cl[0] == 0x88 {
                    uid.extend_from_slice(&cl[1..4]);
                } else {
                    uid.extend_from_slice(&cl[..4]);
                }
                if sak[0] & 0x04 == 0 {
                    return Some(uid);
                }
            }
            None
        }
        fn auth(&mut self, cmd: u8, block: u8, key: [u8; 6], uid: &[u8]) -> bool {
            self.wr(COMMAND, CMD_IDLE);
            self.wr(COM_IRQ, 0x7F);
            self.wr(FIFO_LEVEL, 0x80);
            for b in [cmd, block]
                .into_iter()
                .chain(key)
                .chain(uid[..4].iter().copied())
            {
                self.wr(FIFO_DATA, b);
            }
            self.wr(COMMAND, CMD_MF_AUTHENT);
            loop {
                self.tick(50e-6);
                let n = self.rd(COM_IRQ);
                if n & 0x10 != 0 {
                    return self.rd(STATUS2) & 0x08 != 0;
                }
                if n & 0x01 != 0 {
                    return false;
                }
            }
        }
    }

    #[test]
    fn crc_a_matches_iso14443_vectors() {
        // HALT: 50 00 57 CD; SELECT of a 4-byte UID; 00 00 → A0 1E.
        assert_eq!(with_crc(&[0x50, 0x00]), [0x50, 0x00, 0x57, 0xCD]);
        assert_eq!(crc_a(0x6363, &[0x00, 0x00]), 0x1EA0);
        assert!(crc_ok(&[0x50, 0x00, 0x57, 0xCD]));
    }

    #[test]
    fn version_and_registers_after_reset() {
        let mut d = Drv::new();
        assert_eq!(d.rd(VERSION_REG), 0x92);
        assert_eq!(d.rd(T_PRESCALER), 0xA9);
        assert_eq!(d.rd(TX_CONTROL), 0x83);
        assert!(d.r.field);
        // Burst read: address bytes, the reply of each comes one byte later.
        d.r.exchange(1.0, 0x80 | VERSION_REG << 1);
        assert_eq!(d.r.exchange(1.0, 0x80 | T_PRESCALER << 1), 0x92);
        assert_eq!(d.r.exchange(1.0, 0), 0xA9);
        d.r.end_frame();
        d.wr(COMMAND, CMD_SOFT_RESET);
        assert_eq!(d.rd(TX_CONTROL), 0x80);
        assert!(!d.r.field);
        assert_eq!(d.rd(COMMAND), 0x20);
    }

    #[test]
    fn calc_crc_command() {
        let mut d = Drv::new();
        d.wr(COMMAND, CMD_IDLE);
        d.wr(DIV_IRQ, 0x04);
        d.wr(FIFO_LEVEL, 0x80);
        d.wr(FIFO_DATA, 0x50);
        d.wr(FIFO_DATA, 0x00);
        d.wr(COMMAND, CMD_CALC_CRC);
        assert_ne!(d.rd(DIV_IRQ) & 0x04, 0);
        assert_eq!((d.rd(CRC_RESULT_L), d.rd(CRC_RESULT_H)), (0x57, 0xCD));
        assert_eq!(d.rd(FIFO_LEVEL), 0);
    }

    #[test]
    fn no_card_times_out_after_the_reload_period() {
        let mut d = Drv::new();
        let t0 = d.t;
        let e = d.transceive(&[0x26], 7).unwrap_err();
        assert_ne!(e & 0x40, 0, "TxIRq");
        // 25 ms (40 kHz × 1001) after the 7-bit frame.
        let took = d.t - t0;
        assert!((0.0249..0.0258).contains(&took), "{took}");
    }

    #[test]
    fn reqa_anticollision_select_read_write() {
        let mut d = Drv::new();
        d.r.set_card(1);
        assert_eq!(d.r.card_state(), "idle");
        let (atqa, bits) = d.transceive(&[0x26], 7).unwrap();
        assert_eq!((atqa, bits), (vec![0x04, 0x00], 0));
        let (cl, _) = d.transceive(&[0x93, 0x20], 0).unwrap();
        assert_eq!(cl, [0x7A, 0x3B, 0x1C, 0x9D, 0x7A ^ 0x3B ^ 0x1C ^ 0x9D]);
        // A SELECT without its CRC is not understood: back to IDLE.
        let mut f = vec![0x93, 0x70];
        f.extend_from_slice(&cl);
        assert!(d.transceive(&f, 0).is_err());
        assert_eq!(d.r.card_state(), "idle");
        let uid = d.select().unwrap();
        assert_eq!(uid, [0x7A, 0x3B, 0x1C, 0x9D]);
        assert_eq!(d.r.card_state(), "active");
        // READ before authenticating: NAK.
        let (nak, bits) = d.transceive(&with_crc(&[0x30, 4]), 0).unwrap();
        assert_eq!((nak, bits), (vec![NAK_NOT_ALLOWED], 4));
        // Wrong key: timeout, the card drops back to IDLE.
        let uid = d.select().unwrap();
        assert!(!d.auth(0x60, 4, [0; 6], &uid));
        assert_eq!(d.r.card_state(), "idle");
        let uid = d.select().unwrap();
        assert!(d.auth(0x60, 4, [0xFF; 6], &uid));
        assert_eq!(d.r.card_state(), "auth");
        let (data, _) = d.transceive(&with_crc(&[0x30, 4]), 0).unwrap();
        assert!(crc_ok(&data));
        assert_eq!(&data[..13], b"Card A: guest");
        // Another sector: not allowed.
        let (nak, _) = d.transceive(&with_crc(&[0x30, 8]), 0).unwrap();
        assert_eq!(nak, [NAK_NOT_ALLOWED]);
        let (ack, bits) = d.transceive(&with_crc(&[0xA0, 5]), 0).unwrap();
        assert_eq!((ack, bits), (vec![ACK], 4));
        let t0 = d.t;
        let (ack, _) = d.transceive(&with_crc(&[7u8; 16]), 0).unwrap();
        assert_eq!(ack, [ACK]);
        assert!(d.t - t0 > WRITE_TIME, "EEPROM write time");
        let (data, _) = d.transceive(&with_crc(&[0x30, 5]), 0).unwrap();
        assert_eq!(data[..16], [7u8; 16]);
        // Trailer: key A reads as zeros, access bits and key B (readable
        // in the transport configuration).
        let (data, _) = d.transceive(&with_crc(&[0x30, 7]), 0).unwrap();
        assert_eq!(data[..10], [0, 0, 0, 0, 0, 0, 0xFF, 0x07, 0x80, 0x69]);
        assert_eq!(data[10..16], [0xFF; 6]);
        // Block 0 is read-only.
        assert!(d.auth(0x60, 0, [0xFF; 6], &uid));
        let (nak, _) = d.transceive(&with_crc(&[0xA0, 0]), 0).unwrap();
        assert_eq!(nak, [NAK_NOT_ALLOWED]);
        // HALT: no answer (a timeout is success), then REQA is ignored
        // but WUPA wakes it.
        assert!(d.transceive(&with_crc(&[0x50, 0]), 0).is_err());
        assert_eq!(d.r.card_state(), "halt");
        // Crypto1 still on: even WUPA is garbage to the halted card.
        assert!(d.transceive(&[0x52], 7).is_err());
        d.wr(STATUS2, 0x00);
        assert!(!d.r.crypto_on());
        assert!(d.transceive(&[0x26], 7).is_err());
        assert!(d.transceive(&[0x52], 7).is_ok());
        // The written data stays on the card when it leaves the antenna.
        d.r.set_card(2);
        assert_eq!(d.select().unwrap(), [0x5E, 0x82, 0xF4, 0x03]);
        d.r.set_card(1);
        assert_eq!(d.r.cards[0].mem[5 * 16], 7);
    }

    #[test]
    fn key_b_readable_cannot_be_used() {
        let mut d = Drv::new();
        d.r.set_card(3);
        let uid = d.select().unwrap();
        assert!(d.auth(0x61, 4, [0xFF; 6], &uid));
        let (nak, _) = d.transceive(&with_crc(&[0x30, 4]), 0).unwrap();
        assert_eq!(nak, [NAK_NOT_ALLOWED]);
    }

    #[test]
    fn antenna_off_or_no_100_percent_ask_reaches_no_card() {
        let mut d = Drv::new();
        d.r.set_card(1);
        d.wr(TX_ASK, 0x00);
        assert!(d.transceive(&[0x26], 7).is_err());
        d.wr(TX_ASK, 0x40);
        d.wr(TX_CONTROL, 0x80);
        assert_eq!(d.r.card_state(), "off");
        assert!(d.transceive(&[0x26], 7).is_err());
        d.wr(TX_CONTROL, 0x83);
        assert!(d.transceive(&[0x26], 7).is_ok());
        // Wrong bit count for REQA: not a short frame.
        let mut d = Drv::new();
        d.r.set_card(1);
        assert!(d.transceive(&[0x26], 0).is_err());
    }

    #[test]
    fn ultralight_cascade_and_pages() {
        let mut d = Drv::new();
        d.r.set_card(4);
        let (atqa, _) = d.transceive(&[0x26], 7).unwrap();
        assert_eq!(atqa, [0x44, 0x00]);
        // REQA again in READY is an error: IDLE again.
        assert!(d.transceive(&[0x26], 7).is_err());
        let uid = d.select().unwrap();
        assert_eq!(uid, [0x04, 0xA1, 0xB2, 0xC3, 0xD4, 0xE5, 0x80]);
        let (data, _) = d.transceive(&with_crc(&[0x30, 4]), 0).unwrap();
        assert_eq!(&data[..16], b"Sticker: hello R");
        let (ack, _) = d.transceive(&with_crc(&[0xA2, 6, 1, 2, 3, 4]), 0).unwrap();
        assert_eq!(ack, [ACK]);
        let (nak, _) = d.transceive(&with_crc(&[0xA2, 1, 1, 2, 3, 4]), 0).unwrap();
        assert_eq!(nak, [NAK_INVALID]);
        let (data, _) = d.transceive(&with_crc(&[0x30, 6]), 0).unwrap();
        assert_eq!(data[..4], [1, 2, 3, 4]);
    }

    #[test]
    fn hardware_crc_and_irq_pin() {
        let mut d = Drv::new();
        d.r.set_card(1);
        // Open drain, active low after reset: released while nothing is
        // pending (after clearing the reset IRQ bits).
        d.wr(COM_IRQ, 0x7F);
        assert_eq!(d.r.irq_pin(), None);
        d.wr(COM_IEN, 0x80 | 0x20); // RxIEn
        d.transceive(&[0x26], 7).unwrap();
        assert_eq!(d.r.irq_pin(), Some(false));
        d.wr(COM_IRQ, 0x7F);
        assert_eq!(d.r.irq_pin(), None);
        d.wr(DIV_IEN, 0x80); // push-pull
        assert_eq!(d.r.irq_pin(), Some(true));
        // TxCRCEn / RxCRCEn: the chip adds and checks the CRC.
        d.transceive(&[0x93, 0x20], 0).unwrap();
        d.wr(TX_MODE, 0x80);
        d.wr(RX_MODE, 0x80);
        let (sak, _) = d
            .transceive(
                &[
                    0x93,
                    0x70,
                    0x7A,
                    0x3B,
                    0x1C,
                    0x9D,
                    0x7A ^ 0x3B ^ 0x1C ^ 0x9D,
                ],
                0,
            )
            .unwrap();
        assert_eq!(sak, [0x08]);
        assert_eq!(d.rd(ERROR), 0);
    }

    #[test]
    fn hard_power_down_resets_and_ignores_spi() {
        let mut d = Drv::new();
        d.r.set_card(1);
        assert!(d.r.field);
        d.r.pins(true, false, true);
        assert!(!d.r.field);
        assert_eq!(d.r.cards[0].state, CardState::Off);
        assert_eq!(d.rd(VERSION_REG), 0xFF);
        d.r.pins(true, true, true);
        assert_eq!(d.rd(VERSION_REG), 0x92);
        assert_eq!(d.rd(TX_CONTROL), 0x80);
    }
}
