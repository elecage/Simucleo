//! Bus devices (M6), modelled at transaction level: an I2C device sees
//! START/address, bytes and STOP; an SPI device sees selected byte
//! exchanges. Each keeps the state a student would observe (display RAM,
//! clock registers, measurements).

use std::collections::{HashMap, VecDeque};

/// Simulated seconds since power-up, given to devices that keep time.
pub type Seconds = f64;

/// An I2C target.
pub trait I2cDevice {
    fn address(&self) -> u8;
    /// START (or repeated START) addressed to this device.
    fn start(&mut self, read: bool, now: Seconds);
    /// A byte from the controller; returns the ACK.
    fn write(&mut self, byte: u8, now: Seconds) -> bool;
    /// A byte to the controller.
    fn read(&mut self, now: Seconds) -> u8;
    fn stop(&mut self, now: Seconds);
}

// ------------------------------------------------------------- SSD1306

/// SSD1306 128×64 OLED controller (I2C or 4-wire SPI front end).
#[derive(Debug, Clone)]
pub struct Ssd1306 {
    pub address: u8,
    /// Display RAM: 8 pages × 128 columns, bit n of a byte = row page·8+n.
    pub ram: [[u8; 128]; 8],
    pub on: bool,
    pub charge_pump: bool,
    pub inverted: bool,
    pub entire_on: bool,
    pub contrast: u8,
    seg_remap: bool,
    com_reverse: bool,
    start_line: u8,
    addressing: u8,
    col: u8,
    page: u8,
    col_range: (u8, u8),
    page_range: (u8, u8),
    /// Command bytes still expected as arguments, and the command.
    pending: Vec<u8>,
    args_left: usize,
    // I2C framing
    expect_control: bool,
    data_mode: bool,
    single: bool,
    /// Something changed since the display was last shown.
    pub dirty: bool,
}

impl Ssd1306 {
    pub fn new(address: u8) -> Self {
        Self {
            address,
            ram: [[0; 128]; 8],
            on: false,
            charge_pump: false,
            inverted: false,
            entire_on: false,
            contrast: 0x7F,
            seg_remap: false,
            com_reverse: false,
            start_line: 0,
            addressing: 2,
            col: 0,
            page: 0,
            col_range: (0, 127),
            page_range: (0, 7),
            pending: Vec::new(),
            args_left: 0,
            expect_control: true,
            data_mode: false,
            single: false,
            dirty: true,
        }
    }

    /// One command byte (or an argument of the command in progress).
    pub fn command(&mut self, b: u8) {
        if self.args_left > 0 {
            self.pending.push(b);
            self.args_left -= 1;
            if self.args_left == 0 {
                self.finish_command();
            }
            return;
        }
        self.dirty = true;
        let args = match b {
            0x81 | 0x20 | 0xA8 | 0xD3 | 0xD5 | 0xD9 | 0xDA | 0xDB | 0x8D | 0xA3 => 1,
            0x21 | 0x22 => 2,
            0x26 | 0x27 => 6,
            0x29 | 0x2A => 5,
            _ => 0,
        };
        if args > 0 {
            self.pending = vec![b];
            self.args_left = args;
            return;
        }
        match b {
            0xAE => self.on = false,
            0xAF => self.on = true,
            0xA4 => self.entire_on = false,
            0xA5 => self.entire_on = true,
            0xA6 => self.inverted = false,
            0xA7 => self.inverted = true,
            0xA0 => self.seg_remap = false,
            0xA1 => self.seg_remap = true,
            0xC0 => self.com_reverse = false,
            0xC8 => self.com_reverse = true,
            0x40..=0x7F => self.start_line = b - 0x40,
            0xB0..=0xB7 => self.page = b - 0xB0,
            0x00..=0x0F => self.col = (self.col & 0xF0) | b,
            0x10..=0x1F => self.col = (self.col & 0x0F) | ((b & 0x0F) << 4),
            _ => {} // NOP (0xE3), scroll on/off, …
        }
    }

    fn finish_command(&mut self) {
        let p = std::mem::take(&mut self.pending);
        match p[0] {
            0x81 => self.contrast = p[1],
            0x20 => self.addressing = p[1] & 3,
            0x21 => {
                self.col_range = (p[1] & 0x7F, p[2] & 0x7F);
                self.col = self.col_range.0;
            }
            0x22 => {
                self.page_range = (p[1] & 7, p[2] & 7);
                self.page = self.page_range.0;
            }
            0x8D => self.charge_pump = p[1] & 0x04 != 0,
            _ => {}
        }
    }

    /// One byte of display data at the current address.
    pub fn data(&mut self, b: u8) {
        self.dirty = true;
        self.ram[(self.page & 7) as usize][(self.col & 0x7F) as usize] = b;
        match self.addressing {
            0 => {
                // Horizontal: columns, then the next page.
                if self.col >= self.col_range.1 {
                    self.col = self.col_range.0;
                    self.page = if self.page >= self.page_range.1 {
                        self.page_range.0
                    } else {
                        self.page + 1
                    };
                } else {
                    self.col += 1;
                }
            }
            1 => {
                // Vertical: pages, then the next column.
                if self.page >= self.page_range.1 {
                    self.page = self.page_range.0;
                    self.col = if self.col >= self.col_range.1 {
                        self.col_range.0
                    } else {
                        self.col + 1
                    };
                } else {
                    self.page += 1;
                }
            }
            _ => {
                // Page addressing: the column wraps within the page.
                self.col = (self.col + 1) & 0x7F;
            }
        }
    }

    /// Whether anything is visible: display on with its charge pump
    /// (modules have no external VCC).
    pub fn lit(&self) -> bool {
        self.on && self.charge_pump
    }

    /// The screen as 64 rows × 128 columns, row-major, MSB first
    /// (1024 bytes), after remapping, scan direction, start line and
    /// inversion.
    pub fn screen(&self) -> Vec<u8> {
        let mut out = vec![0u8; 1024];
        if !self.lit() {
            return out;
        }
        for y in 0..64usize {
            // Modules mount the panel so that the usual A1/C8 setting is
            // upright with the header at the top: SEG0 is on the right,
            // COM0 at the bottom.
            let row = if self.com_reverse { y } else { 63 - y };
            let line = (row + self.start_line as usize) % 64;
            for x in 0..128usize {
                let seg = if self.seg_remap { x } else { 127 - x };
                let mut px = self.ram[line / 8][seg] >> (line % 8) & 1 != 0;
                if self.entire_on {
                    px = true;
                }
                if self.inverted {
                    px = !px;
                }
                if px {
                    out[y * 16 + x / 8] |= 0x80 >> (x % 8);
                }
            }
        }
        out
    }
}

impl I2cDevice for Ssd1306 {
    fn address(&self) -> u8 {
        self.address
    }
    fn start(&mut self, _read: bool, _now: Seconds) {
        self.expect_control = true;
    }
    fn write(&mut self, b: u8, _now: Seconds) -> bool {
        if self.expect_control {
            // Control byte: Co (bit 7) = one byte follows, D/C# (bit 6).
            self.single = b & 0x80 != 0;
            self.data_mode = b & 0x40 != 0;
            self.expect_control = false;
            return true;
        }
        if self.data_mode {
            self.data(b);
        } else {
            self.command(b);
        }
        if self.single {
            self.expect_control = true;
        }
        true
    }
    fn read(&mut self, _now: Seconds) -> u8 {
        // Status: bit 6 = display off.
        if self.on {
            0x00
        } else {
            0x40
        }
    }
    fn stop(&mut self, _now: Seconds) {}
}

// -------------------------------------------------------------- DS3231

/// Days since 1970-01-01 → (year, month 1–12, day 1–31) (proleptic
/// Gregorian; H. Hinnant's algorithm).
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// (year, month, day) → days since 1970-01-01.
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn bcd(v: u32) -> u8 {
    (((v / 10) << 4) | (v % 10)) as u8
}

fn from_bcd(b: u8) -> u32 {
    (b >> 4) as u32 * 10 + (b & 0x0F) as u32
}

/// DS3231 real-time clock (I2C 0x68): BCD time and date that run with
/// simulated time, alarm/control/status registers kept, and the
/// temperature registers.
#[derive(Debug, Clone)]
pub struct Ds3231 {
    /// Unix time at simulated second 0.
    pub epoch_at_zero: f64,
    pub regs: [u8; 0x13],
    pointer: u8,
    first_write: bool,
    pub temp: f64,
    /// Time registers latched at START, like the device's read buffer.
    latched: [u8; 7],
    /// The time registers were written in this transfer.
    time_written: bool,
}

impl Ds3231 {
    pub fn new(unix_now: f64) -> Self {
        let mut regs = [0u8; 0x13];
        regs[0x0E] = 0x1C; // INTCN, RS2, RS1
        Self {
            epoch_at_zero: unix_now,
            regs,
            pointer: 0,
            first_write: false,
            temp: 25.0,
            latched: [0; 7],
            time_written: false,
        }
    }

    /// Unix time now.
    pub fn unix(&self, now: Seconds) -> f64 {
        self.epoch_at_zero + now
    }

    /// The seven time registers (seconds … year) for a Unix time.
    fn time_regs(&self, unix: f64) -> [u8; 7] {
        let t = unix.floor() as i64;
        let days = t.div_euclid(86_400);
        let secs = t.rem_euclid(86_400) as u32;
        let (y, m, d) = civil_from_days(days);
        let dow = ((days + 4).rem_euclid(7) + 1) as u32; // 1 = Sunday … 7
        let (h, min, s) = (secs / 3600, secs / 60 % 60, secs % 60);
        let twelve = self.regs[2] & 0x40 != 0;
        let hour = if twelve {
            let pm = h >= 12;
            let h12 = if h % 12 == 0 { 12 } else { h % 12 };
            0x40 | if pm { 0x20 } else { 0 } | bcd(h12)
        } else {
            bcd(h)
        };
        let century = if y >= 2100 { 0x80 } else { 0 };
        [
            bcd(s),
            bcd(min),
            hour,
            dow as u8,
            bcd(d),
            century | bcd(m),
            bcd((y % 100) as u32),
        ]
    }

    /// Set the clock from the time registers just written.
    fn apply_time(&mut self, now: Seconds) {
        let r = &self.regs;
        let s = from_bcd(r[0] & 0x7F);
        let min = from_bcd(r[1] & 0x7F);
        let h = if r[2] & 0x40 != 0 {
            let h12 = from_bcd(r[2] & 0x1F) % 12;
            h12 + if r[2] & 0x20 != 0 { 12 } else { 0 }
        } else {
            from_bcd(r[2] & 0x3F)
        };
        let d = from_bcd(r[4] & 0x3F).max(1);
        let m = from_bcd(r[5] & 0x1F).clamp(1, 12);
        let y = 2000 + from_bcd(r[6]) as i64 + if r[5] & 0x80 != 0 { 100 } else { 0 };
        let unix = days_from_civil(y, m, d) * 86_400 + (h * 3600 + min * 60 + s) as i64;
        self.epoch_at_zero = unix as f64 - now.floor();
    }

    /// Set the clock from time registers written in this transfer.
    fn commit(&mut self, now: Seconds) {
        if self.time_written {
            // The 12/24 h bit lives in the hours register.
            let mode = self.regs[2] & 0x40;
            self.apply_time(now);
            self.regs[2] = (self.regs[2] & !0x40) | mode;
            self.time_written = false;
        }
    }

    /// Text for the part on screen: "2026-11-18 21:30:05".
    pub fn display(&self, now: Seconds) -> String {
        let t = self.unix(now).floor() as i64;
        let (y, m, d) = civil_from_days(t.div_euclid(86_400));
        let s = t.rem_euclid(86_400);
        format!(
            "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}",
            s / 3600,
            s / 60 % 60,
            s % 60
        )
    }
}

impl I2cDevice for Ds3231 {
    fn address(&self) -> u8 {
        0x68
    }
    fn start(&mut self, _read: bool, now: Seconds) {
        // A repeated START ends the write phase: commit it first.
        self.commit(now);
        self.latched = self.time_regs(self.unix(now));
        // Writing some of the time registers keeps the others running.
        self.regs[..7].copy_from_slice(&self.latched);
        self.first_write = true;
        self.time_written = false;
    }
    fn write(&mut self, b: u8, _now: Seconds) -> bool {
        if self.first_write {
            self.pointer = b % 0x13;
            self.first_write = false;
        } else {
            let p = self.pointer as usize;
            self.regs[p] = b;
            if p < 7 {
                self.time_written = true;
            }
            self.pointer = (self.pointer + 1) % 0x13;
        }
        true
    }
    fn read(&mut self, _now: Seconds) -> u8 {
        let p = self.pointer as usize;
        let v = match p {
            0..=6 => self.latched[p],
            0x11 => self.temp.floor() as i8 as u8,
            0x12 => (((self.temp - self.temp.floor()) * 4.0) as u8) << 6,
            _ => self.regs[p],
        };
        self.pointer = (self.pointer + 1) % 0x13;
        v
    }
    fn stop(&mut self, now: Seconds) {
        self.commit(now);
    }
}

// --------------------------------------------------------------- AHT20

/// AHT20 temperature/humidity sensor (I2C 0x38): initialise (0xBE),
/// trigger (0xAC 0x33 0x00), busy for 80 ms, then status + 20-bit
/// humidity + 20-bit temperature + CRC.
#[derive(Debug, Clone)]
pub struct Aht20 {
    pub temp: f64,
    pub humidity: f64,
    calibrated: bool,
    busy_until: Option<Seconds>,
    out: [u8; 7],
    read_pos: usize,
    cmd: Vec<u8>,
}

impl Aht20 {
    pub fn new(temp: f64, humidity: f64) -> Self {
        Self {
            temp,
            humidity,
            calibrated: false,
            busy_until: None,
            out: [0x18, 0, 0, 0, 0, 0, 0],
            read_pos: 0,
            cmd: Vec::new(),
        }
    }

    fn crc8(data: &[u8]) -> u8 {
        let mut crc = 0xFFu8;
        for &b in data {
            crc ^= b;
            for _ in 0..8 {
                crc = if crc & 0x80 != 0 {
                    (crc << 1) ^ 0x31
                } else {
                    crc << 1
                };
            }
        }
        crc
    }

    fn status(&self, now: Seconds) -> u8 {
        let busy = self.busy_until.is_some_and(|t| now < t);
        (if busy { 0x80 } else { 0 }) | if self.calibrated { 0x08 } else { 0 } | 0x10
    }
}

impl I2cDevice for Aht20 {
    fn address(&self) -> u8 {
        0x38
    }
    fn start(&mut self, read: bool, now: Seconds) {
        self.cmd.clear();
        self.read_pos = 0;
        if read {
            self.out[0] = self.status(now);
            self.out[6] = Self::crc8(&self.out[..6]);
        }
    }
    fn write(&mut self, b: u8, _now: Seconds) -> bool {
        self.cmd.push(b);
        true
    }
    fn read(&mut self, _now: Seconds) -> u8 {
        let v = self.out.get(self.read_pos).copied().unwrap_or(0xFF);
        self.read_pos += 1;
        v
    }
    fn stop(&mut self, now: Seconds) {
        match self.cmd.first() {
            Some(0xBE) | Some(0xE1) => self.calibrated = true,
            Some(0xBA) => {
                self.calibrated = false;
                self.busy_until = None;
            }
            Some(0xAC) => {
                self.busy_until = Some(now + 0.080);
                let h = ((self.humidity.clamp(0.0, 100.0) / 100.0) * 1_048_576.0).round() as u32;
                let t =
                    (((self.temp.clamp(-50.0, 150.0) + 50.0) / 200.0) * 1_048_576.0).round() as u32;
                let h = h.min(0xF_FFFF);
                let t = t.min(0xF_FFFF);
                self.out[1] = (h >> 12) as u8;
                self.out[2] = (h >> 4) as u8;
                self.out[3] = ((h & 0xF) << 4) as u8 | (t >> 16) as u8;
                self.out[4] = (t >> 8) as u8;
                self.out[5] = t as u8;
            }
            _ => {}
        }
        self.out[0] = self.status(now);
        self.out[6] = Self::crc8(&self.out[..6]);
        self.cmd.clear();
    }
}

// ------------------------------------------------------------- SD card

/// CRC-7 of SD commands and registers (polynomial x⁷ + x³ + 1).
pub fn crc7(data: &[u8]) -> u8 {
    let mut crc = 0u8;
    for &b in data {
        for i in (0..8).rev() {
            let bit = (b >> i) & 1 ^ (crc >> 6) & 1;
            crc = (crc << 1) & 0x7F;
            if bit != 0 {
                crc ^= 0x09;
            }
        }
    }
    crc
}

/// CRC-16-CCITT of SD data blocks.
pub fn crc16(data: &[u8]) -> u16 {
    let mut crc = 0u16;
    for &b in data {
        crc ^= (b as u16) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
        }
    }
    crc
}

pub const SD_BLOCK: usize = 512;

#[derive(Debug, Clone)]
enum SdWrite {
    /// Waiting for a start token (0xFE single, 0xFC multiple, 0xFD stop).
    Token { block: u32, multi: bool },
    /// Collecting a data block and its CRC.
    Data {
        block: u32,
        multi: bool,
        buf: Vec<u8>,
    },
}

/// SDHC card in SPI mode: CMD0/8/55/ACMD41/58 initialisation, CSD/CID,
/// single and multiple block reads and writes. Blocks never written read
/// as zeros; storage is sparse.
/// Header of [`SdCard::sparse`].
const SPARSE_MAGIC: &[u8; 4] = b"SDS1";

#[derive(Debug, Clone)]
pub struct SdCard {
    pub blocks: u32,
    /// The size the card was made with (MB), before any image replaced it.
    pub nominal_mb: u32,
    data: HashMap<u32, Box<[u8; SD_BLOCK]>>,
    cmd: Vec<u8>,
    out: VecDeque<u8>,
    idle: bool,
    app_cmd: bool,
    init_tries: u32,
    write: Option<SdWrite>,
    /// Next block of a CMD18 transfer.
    multi_read: Option<u32>,
    /// Blocks read and written since the last look (for the UI).
    pub reads: u32,
    pub writes: u32,
    /// Contents changed since the image was last exported.
    pub dirty: bool,
    /// Moves on every change of the contents (a block written, an image
    /// put in, the card wiped): the UI saves the card when it moves.
    pub generation: u32,
}

impl SdCard {
    pub fn new(megabytes: u32) -> Self {
        Self {
            blocks: megabytes.clamp(1, 32 * 1024) * 2048,
            nominal_mb: megabytes,
            data: HashMap::new(),
            cmd: Vec::new(),
            out: VecDeque::new(),
            idle: true,
            app_cmd: false,
            init_tries: 0,
            write: None,
            multi_read: None,
            reads: 0,
            writes: 0,
            dirty: false,
            generation: 0,
        }
    }

    /// Protocol state back to power-up; the contents stay.
    pub fn power_cycle(&mut self) {
        let mut fresh = Self::new(1);
        fresh.blocks = self.blocks;
        fresh.nominal_mb = self.nominal_mb;
        fresh.data = std::mem::take(&mut self.data);
        fresh.dirty = self.dirty;
        fresh.generation = self.generation;
        *self = fresh;
    }

    pub fn read_block(&self, block: u32) -> [u8; SD_BLOCK] {
        self.data.get(&block).map_or([0; SD_BLOCK], |b| **b)
    }

    pub fn write_block(&mut self, block: u32, data: &[u8]) {
        let mut b = [0u8; SD_BLOCK];
        b[..data.len().min(SD_BLOCK)].copy_from_slice(&data[..data.len().min(SD_BLOCK)]);
        if b.iter().all(|&x| x == 0) {
            self.data.remove(&block);
        } else {
            self.data.insert(block, Box::new(b));
        }
        self.dirty = true;
        self.generation = self.generation.wrapping_add(1);
    }

    /// Every block back to zeros (no file system any more); the size stays.
    pub fn wipe(&mut self) {
        self.data.clear();
        self.dirty = true;
        self.generation = self.generation.wrapping_add(1);
    }

    /// The contents as just the blocks in use, to keep them small: "SDS1",
    /// the card's size in blocks, then each block that is not all zeros as
    /// its number and its 512 bytes, in block order (numbers u32 LE).
    pub fn sparse(&self) -> Vec<u8> {
        let mut used: Vec<u32> = self.data.keys().copied().collect();
        used.sort_unstable();
        let mut out = Vec::with_capacity(8 + used.len() * (4 + SD_BLOCK));
        out.extend_from_slice(SPARSE_MAGIC);
        out.extend_from_slice(&self.blocks.to_le_bytes());
        for n in used {
            out.extend_from_slice(&n.to_le_bytes());
            out.extend_from_slice(&self.data[&n][..]);
        }
        out
    }

    /// Replace the contents with what [`SdCard::sparse`] gave (the card
    /// takes its size too). False, with nothing changed, if `bytes` is not
    /// in that form.
    pub fn load_sparse(&mut self, bytes: &[u8]) -> bool {
        let word = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        if bytes.len() < 8
            || &bytes[..4] != SPARSE_MAGIC
            || !(bytes.len() - 8).is_multiple_of(4 + SD_BLOCK)
        {
            return false;
        }
        let blocks = word(4);
        let entries = (8..bytes.len()).step_by(4 + SD_BLOCK);
        if blocks == 0 || entries.clone().any(|at| word(at) >= blocks) {
            return false;
        }
        self.data.clear();
        self.blocks = blocks;
        for at in entries {
            self.write_block(word(at), &bytes[at + 4..at + 4 + SD_BLOCK]);
        }
        self.dirty = false;
        true
    }

    /// The whole card as a disk image.
    pub fn image(&self) -> Vec<u8> {
        let mut img = vec![0u8; self.blocks as usize * SD_BLOCK];
        for (&n, b) in &self.data {
            let at = n as usize * SD_BLOCK;
            img[at..at + SD_BLOCK].copy_from_slice(&b[..]);
        }
        img
    }

    /// Replace the contents with a disk image; the card takes its size
    /// (rounded up to whole 512 KiB units, as the CSD counts them).
    pub fn load_image(&mut self, img: &[u8]) {
        self.data.clear();
        let blocks = img.len().div_ceil(SD_BLOCK) as u32;
        self.blocks = blocks.div_ceil(1024).max(1) * 1024;
        for (n, chunk) in img.chunks(SD_BLOCK).enumerate() {
            if chunk.iter().any(|&x| x != 0) {
                self.write_block(n as u32, chunk);
            }
        }
        self.dirty = false;
    }

    fn csd(&self) -> [u8; 16] {
        let c = self.blocks / 1024 - 1;
        let mut r = [
            0x40,
            0x0E,
            0x00,
            0x32,
            0x5B,
            0x59,
            0x00,
            (c >> 16) as u8 & 0x3F,
            (c >> 8) as u8,
            c as u8,
            0x7F,
            0x80,
            0x0A,
            0x40,
            0x00,
            0x00,
        ];
        r[15] = crc7(&r[..15]) << 1 | 1;
        r
    }

    fn cid() -> [u8; 16] {
        let mut r = [
            0x03, b'S', b'M', b'S', b'I', b'M', b'U', b'C', 0x10, 0x12, 0x34, 0x56, 0x78, 0x01,
            0x9A, 0,
        ];
        r[15] = crc7(&r[..15]) << 1 | 1;
        r
    }

    fn r1(&self) -> u8 {
        self.idle as u8
    }

    fn queue_block(&mut self, data: &[u8]) {
        let crc = crc16(data);
        self.out.extend([0xFF, 0xFE]);
        self.out.extend(data);
        self.out.extend([(crc >> 8) as u8, crc as u8]);
    }

    fn queue_read(&mut self, block: u32) {
        let b = self.read_block(block);
        self.reads += 1;
        self.queue_block(&b);
    }

    fn command(&mut self, c: [u8; 6]) {
        let idx = c[0] & 0x3F;
        let arg = u32::from_be_bytes([c[1], c[2], c[3], c[4]]);
        let app = std::mem::take(&mut self.app_cmd);
        // In SPI mode only CMD0 and CMD8 are CRC-checked.
        if (idx == 0 || idx == 8) && crc7(&c[..5]) << 1 | 1 != c[5] {
            self.out.extend([0xFF, self.r1() | 0x08]);
            return;
        }
        // NCR: one byte before the response.
        self.out.push_back(0xFF);
        let ready = !self.idle;
        let in_range = arg < self.blocks;
        match (app, idx) {
            (_, 0) => {
                self.idle = true;
                self.init_tries = 0;
                self.write = None;
                self.multi_read = None;
                self.out.push_back(0x01);
            }
            (_, 8) => self
                .out
                .extend([self.r1(), 0x00, 0x00, (arg >> 8) as u8 & 0x0F, arg as u8]),
            (_, 55) => {
                self.app_cmd = true;
                self.out.push_back(self.r1());
            }
            (true, 41) | (false, 1) => {
                // Ready on the second try, as cards take a while.
                self.init_tries += 1;
                if self.init_tries >= 2 {
                    self.idle = false;
                }
                self.out.push_back(self.r1());
            }
            (_, 58) => {
                let ocr0 = if ready { 0xC0 } else { 0x40 };
                self.out.extend([self.r1(), ocr0, 0xFF, 0x80, 0x00]);
            }
            (_, 59) | (_, 16) | (true, 23) | (false, 23) => self.out.push_back(self.r1()),
            (_, 9) if ready => {
                self.out.push_back(0x00);
                let csd = self.csd();
                self.queue_block(&csd);
            }
            (_, 10) if ready => {
                self.out.push_back(0x00);
                self.queue_block(&Self::cid());
            }
            (true, 13) if ready => {
                self.out.extend([0x00, 0x00]);
                self.queue_block(&[0u8; 64]);
            }
            (true, 51) if ready => {
                self.out.push_back(0x00);
                self.queue_block(&[0x02, 0x35, 0x80, 0x00, 0, 0, 0, 0]);
            }
            (_, 13) => self.out.extend([self.r1(), 0x00]),
            (_, 12) => {
                // Stop: drop the block in flight; R1b with a short busy.
                self.multi_read = None;
                self.out.clear();
                self.out.extend([0xFF, 0x00, 0x00, 0xFF]);
            }
            (_, 17) | (_, 18) | (_, 24) | (_, 25) if ready && !in_range => self.out.push_back(0x40),
            (_, 17) if ready => {
                self.out.push_back(0x00);
                self.queue_read(arg);
            }
            (_, 18) if ready => {
                self.out.push_back(0x00);
                self.queue_read(arg);
                self.multi_read = Some(arg + 1);
            }
            (_, 24) | (_, 25) if ready => {
                self.out.push_back(0x00);
                self.write = Some(SdWrite::Token {
                    block: arg,
                    multi: idx == 25,
                });
            }
            _ => self.out.push_back(self.r1() | 0x04), // illegal command
        }
    }

    fn receive(&mut self, b: u8) {
        match self.write.take() {
            Some(SdWrite::Token { block, multi }) => {
                self.write = match b {
                    0xFE if !multi => Some(SdWrite::Data {
                        block,
                        multi,
                        buf: Vec::with_capacity(514),
                    }),
                    0xFC if multi => Some(SdWrite::Data {
                        block,
                        multi,
                        buf: Vec::with_capacity(514),
                    }),
                    0xFD if multi => {
                        // Stop token: a little busy, then done.
                        self.out.extend([0xFF, 0x00, 0x00]);
                        None
                    }
                    _ => Some(SdWrite::Token { block, multi }),
                };
            }
            Some(SdWrite::Data {
                block,
                multi,
                mut buf,
            }) => {
                buf.push(b);
                if buf.len() < SD_BLOCK + 2 {
                    self.write = Some(SdWrite::Data { block, multi, buf });
                } else if block >= self.blocks {
                    self.out.extend([0x0D, 0x00, 0xFF]); // write error
                } else {
                    self.write_block(block, &buf[..SD_BLOCK]);
                    self.writes += 1;
                    // Data accepted, then busy while "programming".
                    self.out.extend([0x05, 0x00, 0x00, 0x00]);
                    if multi {
                        self.write = Some(SdWrite::Token {
                            block: block + 1,
                            multi,
                        });
                    }
                }
            }
            None => {
                if self.cmd.is_empty() && b & 0xC0 != 0x40 {
                    return;
                }
                self.cmd.push(b);
                if self.cmd.len() == 6 {
                    let c: [u8; 6] = self.cmd[..].try_into().unwrap();
                    self.cmd.clear();
                    self.command(c);
                }
            }
        }
    }

    /// One byte each way while the card is selected.
    pub fn exchange(&mut self, b: u8) -> u8 {
        let reply = self.out.pop_front().unwrap_or(0xFF);
        // A command can stop a multiple-block read mid-stream.
        if self.multi_read.is_some() && self.cmd.is_empty() && b == 0x4C {
            self.cmd.push(b);
            return reply;
        }
        self.receive(b);
        if self.out.is_empty() && self.cmd.is_empty() {
            if let Some(n) = self.multi_read {
                if n < self.blocks {
                    self.queue_read(n);
                    self.multi_read = Some(n + 1);
                }
            }
        }
        reply
    }
}

// ----------------------------------------------------------------- DHT

/// DHT11/DHT22 temperature and humidity sensor on a single open-drain data
/// line. The host pulls the line low (DHT11 ≥ 18 ms, DHT22 ≥ 1 ms) and
/// releases it; the sensor answers 80 µs low, 80 µs high, then 40 bits,
/// each 50 µs low followed by 26–28 µs (0) or 70 µs (1) high.
#[derive(Debug, Clone)]
pub struct Dht {
    pub dht22: bool,
    pub temp: f64,
    pub humidity: f64,
    /// The host has held the line low since then.
    low_since: Option<Seconds>,
    /// Planned line changes: (time, sensor pulls low).
    plan: VecDeque<(Seconds, bool)>,
    /// The sensor pulls the line low now.
    pub pulling: bool,
    /// The last start signal was too short to be noticed.
    pub short_start: Option<Seconds>,
    pub reads: u32,
}

impl Dht {
    pub fn new(dht22: bool, temp: f64, humidity: f64) -> Self {
        Self {
            dht22,
            temp,
            humidity,
            low_since: None,
            plan: VecDeque::new(),
            pulling: false,
            short_start: None,
            reads: 0,
        }
    }

    /// The 5 data bytes: humidity, temperature, checksum.
    pub fn frame(&self) -> [u8; 5] {
        let mut d = [0u8; 5];
        if self.dht22 {
            let h = (self.humidity.clamp(0.0, 100.0) * 10.0).round() as u16;
            let t = (self.temp.clamp(-40.0, 80.0).abs() * 10.0).round() as u16
                | if self.temp < 0.0 { 0x8000 } else { 0 };
            d[..4].copy_from_slice(&[(h >> 8) as u8, h as u8, (t >> 8) as u8, t as u8]);
        } else {
            let t = self.temp.clamp(0.0, 50.0);
            d[0] = self.humidity.clamp(20.0, 90.0).round() as u8;
            d[2] = t.trunc() as u8;
            d[3] = ((t.fract() * 10.0).round() as u8).min(9);
        }
        d[4] = d[..4].iter().fold(0u8, |a, &b| a.wrapping_add(b));
        d
    }

    /// The line's level changed (as seen while the sensor is not pulling).
    pub fn observe(&mut self, now: Seconds, high: bool) {
        if !self.plan.is_empty() || self.pulling {
            return; // busy answering
        }
        match (high, self.low_since) {
            (false, None) => self.low_since = Some(now),
            (true, Some(start)) => {
                self.low_since = None;
                let min = if self.dht22 { 0.0008 } else { 0.018 };
                if now - start < min {
                    self.short_start = Some(now - start);
                    return;
                }
                self.short_start = None;
                self.reads += 1;
                // Answer 30 µs after the release.
                let frame = self.frame();
                let mut t = now + 30e-6;
                let mut push = |dt: f64, low: bool, t: &mut f64| {
                    self.plan.push_back((*t, low));
                    *t += dt;
                };
                push(80e-6, true, &mut t);
                push(80e-6, false, &mut t);
                for byte in frame {
                    for bit in (0..8).rev() {
                        push(50e-6, true, &mut t);
                        let one = byte >> bit & 1 != 0;
                        push(if one { 70e-6 } else { 27e-6 }, false, &mut t);
                    }
                }
                push(50e-6, true, &mut t);
                push(0.0, false, &mut t);
            }
            _ => {}
        }
    }

    /// Apply planned changes up to `now`; whether the output changed.
    pub fn advance(&mut self, now: Seconds) -> bool {
        let before = self.pulling;
        while let Some(&(t, low)) = self.plan.front() {
            if t > now + 1e-12 {
                break;
            }
            self.pulling = low;
            self.plan.pop_front();
        }
        self.pulling != before
    }

    pub fn next(&self) -> Option<Seconds> {
        self.plan.front().map(|&(t, _)| t)
    }
}

// ------------------------------------------------------------ NeoPixel

/// WS2812B chain decoder: bits from the width of each high pulse (0:
/// 0.4 µs, 1: 0.8 µs, ±150 ns), 24 bits per LED in G, R, B order, the
/// first LED keeping the first 24 bits; a low of more than 50 µs latches.
#[derive(Debug, Clone)]
pub struct NeoPixel {
    /// Colour of each LED as 0xRRGGBB.
    pub leds: Vec<u32>,
    bits: Vec<bool>,
    rise: Option<Seconds>,
    last_fall: Option<Seconds>,
    /// The last pulse that fitted neither bit (µs), for a warning.
    pub bad_pulse: Option<f64>,
    pub frames: u32,
}

impl NeoPixel {
    pub fn new(count: usize) -> Self {
        Self {
            leds: vec![0; count],
            bits: Vec::new(),
            rise: None,
            last_fall: None,
            bad_pulse: None,
            frames: 0,
        }
    }

    fn latch(&mut self) {
        if self.bits.is_empty() {
            return;
        }
        for (i, led) in self.leds.iter_mut().enumerate() {
            let chunk = self.bits.get(i * 24..i * 24 + 24);
            let Some(chunk) = chunk else {
                break;
            };
            let v = chunk.iter().fold(0u32, |a, &b| a << 1 | b as u32);
            let (g, r, b) = (v >> 16 & 0xFF, v >> 8 & 0xFF, v & 0xFF);
            *led = r << 16 | g << 8 | b;
        }
        self.bits.clear();
        self.frames += 1;
    }

    /// Latch if the line has been low long enough by `now`.
    pub fn settle(&mut self, now: Seconds) {
        if self.rise.is_none() && self.last_fall.is_some_and(|f| now - f > 50e-6) {
            self.latch();
        }
    }

    /// DIN changed level at `now`.
    pub fn edge(&mut self, now: Seconds, high: bool) {
        if high {
            if self.last_fall.is_some_and(|f| now - f > 50e-6) {
                self.latch();
            }
            self.rise = Some(now);
        } else if let Some(r) = self.rise.take() {
            let w = (now - r) * 1e6;
            self.last_fall = Some(now);
            let bit = if (0.25..=0.55).contains(&w) {
                false
            } else if (0.65..=0.95).contains(&w) {
                true
            } else {
                self.bad_pulse = Some(w);
                w > 0.6
            };
            self.bits.push(bit);
        }
    }
}

// ------------------------------------------------------------- Encoder

/// Rotary encoder module (KY-040 class): contacts A (CLK) and B (DT) close
/// to the common pin as the shaft turns, one full quadrature cycle per
/// detent, A leading clockwise. Turning is scheduled in time.
#[derive(Debug, Clone, Default)]
pub struct Encoder {
    /// Planned contact states: (time, A closed, B closed).
    plan: VecDeque<(Seconds, bool, bool)>,
    /// Contacts closed now (A, B).
    pub closed: [bool; 2],
    /// Detents turned so far (clockwise positive).
    pub position: i64,
}

impl Encoder {
    /// Time between the four contact changes of one detent.
    pub const STEP: Seconds = 0.0015;

    /// Turn by `detents` (negative: counter-clockwise), starting at `now`
    /// or after a turn already under way.
    pub fn rotate(&mut self, now: Seconds, detents: i32) {
        let mut t = self.plan.back().map_or(now, |&(t, _, _)| t.max(now)) + Self::STEP;
        let cw = detents > 0;
        for _ in 0..detents.unsigned_abs() {
            let seq: [(bool, bool); 4] = if cw {
                [(true, false), (true, true), (false, true), (false, false)]
            } else {
                [(false, true), (true, true), (true, false), (false, false)]
            };
            for (a, b) in seq {
                self.plan.push_back((t, a, b));
                t += Self::STEP;
            }
            self.position += if cw { 1 } else { -1 };
        }
    }

    /// The time base restarted `elapsed` seconds earlier: keep pending
    /// contact changes the same distance ahead.
    pub fn rebase(&mut self, elapsed: Seconds) {
        for (t, _, _) in &mut self.plan {
            *t = (*t - elapsed).max(0.0);
        }
    }

    pub fn advance(&mut self, now: Seconds) {
        while let Some(&(t, a, b)) = self.plan.front() {
            if t > now + 1e-12 {
                break;
            }
            self.closed = [a, b];
            self.plan.pop_front();
        }
    }

    pub fn next(&self) -> Option<Seconds> {
        self.plan.front().map(|&(t, _, _)| t)
    }
}

// ------------------------------------------------------------- HC-SR04

/// Ultrasonic distance sensor (HC-SR04P, 3.3–5 V): a TRIG pulse of at
/// least 10 µs sends a burst; ECHO then goes high for the sound's round
/// trip, 58 µs per cm (38 ms when nothing is in range).
#[derive(Debug, Clone)]
pub struct Sonar {
    pub distance_cm: f64,
    trig_rise: Option<Seconds>,
    plan: VecDeque<(Seconds, bool)>,
    pub echo: bool,
    /// A trigger pulse too short to start a measurement (s).
    pub short_trigger: Option<Seconds>,
}

impl Sonar {
    pub fn new(distance_cm: f64) -> Self {
        Self {
            distance_cm,
            trig_rise: None,
            plan: VecDeque::new(),
            echo: false,
            short_trigger: None,
        }
    }

    /// TRIG changed level.
    pub fn trig(&mut self, now: Seconds, high: bool) {
        if high {
            self.trig_rise = Some(now);
            return;
        }
        let Some(rise) = self.trig_rise.take() else {
            return;
        };
        if now - rise < 10e-6 {
            self.short_trigger = Some(now - rise);
            return;
        }
        if !self.plan.is_empty() || self.echo {
            return; // still measuring
        }
        let d = self.distance_cm;
        let width = if (2.0..=400.0).contains(&d) {
            d * 58e-6
        } else {
            38e-3
        };
        // Eight 40 kHz cycles go out first.
        let start = now + 250e-6;
        self.plan.push_back((start, true));
        self.plan.push_back((start + width, false));
    }

    pub fn advance(&mut self, now: Seconds) {
        while let Some(&(t, high)) = self.plan.front() {
            if t > now + 1e-12 {
                break;
            }
            self.echo = high;
            self.plan.pop_front();
        }
    }

    pub fn next(&self) -> Option<Seconds> {
        self.plan.front().map(|&(t, _)| t)
    }
}

// ------------------------------------------------------------- DS18B20

/// Dallas/Maxim CRC-8 (x⁸ + x⁵ + x⁴ + 1, LSB first).
pub fn crc8_maxim(data: &[u8]) -> u8 {
    let mut crc = 0u8;
    for &b in data {
        let mut x = b;
        for _ in 0..8 {
            let mix = (crc ^ x) & 1;
            crc >>= 1;
            if mix != 0 {
                crc ^= 0x8C;
            }
            x >>= 1;
        }
    }
    crc
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OwPhase {
    /// Waiting for a reset pulse.
    Idle,
    /// After presence: a ROM command.
    Rom,
    /// MATCH ROM: receiving 8 bytes.
    Match,
    /// SEARCH ROM / ALARM SEARCH: bit `bit` of the ROM code, in slot
    /// `sub` of its triplet (0 = the bit, 1 = its complement, 2 = the
    /// direction the host writes).
    Search { bit: u8, sub: u8 },
    /// A function command.
    Function,
    /// WRITE SCRATCHPAD: receiving TH, TL, configuration.
    WriteScratch,
    /// Answering read slots from `tx`; then `then`.
    Send,
    /// CONVERT T: read slots answer 0 while busy, then 1.
    Converting,
    /// Not addressed: ignore everything until the next reset.
    Deselected,
}

/// DS18B20 1-Wire digital thermometer. Several of them can share one line
/// (multi-drop): each pulls the open-drain line low on its own and the
/// circuit solve gives the wired-AND, so on a read slot any device sending
/// a 0 wins. The host times the slots: reset ≥ 480 µs low (every device
/// answers with a presence pulse), write slots (low < 15 µs = 1, ≥ 60 µs =
/// 0), read slots (a device holds the line low ~30 µs to send a 0). ROM
/// commands: READ ROM (0x33; collides with more than one device, as on the
/// real bus), MATCH ROM (0x55), SKIP ROM (0xCC), SEARCH ROM (0xF0) and
/// ALARM SEARCH (0xEC).
#[derive(Debug, Clone)]
pub struct Ds18b20 {
    pub temp: f64,
    pub rom: [u8; 8],
    /// Scratchpad: temperature LSB, MSB, TH, TL, configuration, 3 reserved.
    pad: [u8; 8],
    phase: OwPhase,
    /// Where `Send` goes once `tx` is empty.
    then: OwPhase,
    fall: Option<Seconds>,
    /// The slot that began at `fall` is a read slot (its rising edge is
    /// not a bit the host writes).
    read_slot: bool,
    rx: u16,
    rx_bits: u32,
    rx_bytes: Vec<u8>,
    tx: VecDeque<bool>,
    conv_done: Seconds,
    /// The reading being converted; it reaches the scratchpad at `conv_done`.
    pending: Option<[u8; 2]>,
    plan: VecDeque<(Seconds, bool)>,
    pub pulling: bool,
    pub conversions: u32,
}

/// ROM code of a DS18B20: family 0x28, a 48-bit serial (LSB first), CRC.
pub fn ds18b20_rom(serial: u64) -> [u8; 8] {
    let mut rom = [0x28, 0, 0, 0, 0, 0, 0, 0];
    rom[1..7].copy_from_slice(&serial.to_le_bytes()[..6]);
    rom[7] = crc8_maxim(&rom[..7]);
    rom
}

impl Ds18b20 {
    pub fn new(temp: f64, serial: u64) -> Self {
        Self {
            temp,
            rom: ds18b20_rom(serial),
            // Power-up value: 85 °C, alarm limits, 12-bit resolution.
            pad: [0x50, 0x05, 0x4B, 0x46, 0x7F, 0xFF, 0x0C, 0x10],
            phase: OwPhase::Idle,
            then: OwPhase::Deselected,
            fall: None,
            read_slot: false,
            rx: 0,
            rx_bits: 0,
            rx_bytes: Vec::new(),
            tx: VecDeque::new(),
            conv_done: 0.0,
            pending: None,
            plan: VecDeque::new(),
            pulling: false,
            conversions: 0,
        }
    }

    /// The ROM code as printed on labels and by the examples:
    /// family-serial, the serial most significant byte first.
    pub fn rom_text(&self) -> String {
        let r = &self.rom;
        format!(
            "{:02X}-{:02X}{:02X}{:02X}{:02X}{:02X}{:02X}",
            r[0], r[6], r[5], r[4], r[3], r[2], r[1]
        )
    }

    /// Conversion time for the configured resolution.
    fn conversion_time(&self) -> Seconds {
        0.09375 * (1 << ((self.pad[4] >> 5) & 3)) as f64
    }

    /// The last reading is at or above TH or at or below TL (whole °C).
    fn alarm(&self) -> bool {
        let t = i16::from_le_bytes([self.pad[0], self.pad[1]]) >> 4;
        t >= self.pad[2] as i8 as i16 || t <= self.pad[3] as i8 as i16
    }

    fn send_bytes(&mut self, bytes: &[u8], then: OwPhase) {
        for &b in bytes {
            for i in 0..8 {
                self.tx.push_back(b >> i & 1 != 0);
            }
        }
        self.phase = OwPhase::Send;
        self.then = then;
    }

    fn rom_bit(&self, bit: u8) -> bool {
        self.rom[bit as usize / 8] >> (bit % 8) & 1 != 0
    }

    fn byte(&mut self, b: u8, now: Seconds) {
        match self.phase {
            OwPhase::Rom => match b {
                0x33 => {
                    let rom = self.rom;
                    self.send_bytes(&rom, OwPhase::Function);
                }
                0xCC => self.phase = OwPhase::Function,
                0x55 => {
                    self.rx_bytes.clear();
                    self.phase = OwPhase::Match;
                }
                0xF0 => self.phase = OwPhase::Search { bit: 0, sub: 0 },
                0xEC if self.alarm() => self.phase = OwPhase::Search { bit: 0, sub: 0 },
                _ => self.phase = OwPhase::Deselected,
            },
            OwPhase::Match => {
                self.rx_bytes.push(b);
                if self.rx_bytes.len() == 8 {
                    self.phase = if self.rx_bytes[..] == self.rom {
                        OwPhase::Function
                    } else {
                        OwPhase::Deselected
                    };
                }
            }
            OwPhase::Function => match b {
                0x44 => {
                    // The reading is ready when the conversion ends; bits
                    // below the resolution read as zero.
                    self.conversions += 1;
                    self.conv_done = now + self.conversion_time();
                    let res = (self.pad[4] >> 5) & 3;
                    let raw = (self.temp.clamp(-55.0, 125.0) * 16.0).round() as i16;
                    let raw = raw & !((1i16 << (3 - res)) - 1);
                    self.pending = Some([raw as u8, (raw >> 8) as u8]);
                    self.phase = OwPhase::Converting;
                }
                0xBE => {
                    let mut out = [0u8; 9];
                    out[..8].copy_from_slice(&self.pad);
                    out[8] = crc8_maxim(&self.pad);
                    self.send_bytes(&out, OwPhase::Deselected);
                }
                0x4E => {
                    self.rx_bytes.clear();
                    self.phase = OwPhase::WriteScratch;
                }
                0xB4 => self.send_bytes(&[0xFF], OwPhase::Deselected), // externally powered
                _ => self.phase = OwPhase::Deselected,
            },
            OwPhase::WriteScratch => {
                self.rx_bytes.push(b);
                if self.rx_bytes.len() == 3 {
                    self.pad[2] = self.rx_bytes[0];
                    self.pad[3] = self.rx_bytes[1];
                    self.pad[4] = (self.rx_bytes[2] & 0x60) | 0x1F;
                    self.phase = OwPhase::Deselected;
                }
            }
            _ => {}
        }
    }

    /// The line changed level (seen while the device is not pulling it;
    /// another device on the same line may be).
    pub fn observe(&mut self, now: Seconds, high: bool) {
        // A finished conversion updates the scratchpad.
        if now >= self.conv_done {
            if let Some([lo, hi]) = self.pending.take() {
                self.pad[0] = lo;
                self.pad[1] = hi;
            }
        }
        if !high {
            self.fall = Some(now);
            // A read slot: the device answers a 0 by holding the line low.
            let (read, zero) = match self.phase {
                OwPhase::Send => (true, self.tx.front().is_some_and(|b| !b)),
                OwPhase::Converting => (true, now < self.conv_done),
                // The bit, then its complement; every device still in the
                // search sends at once and the line carries their AND.
                OwPhase::Search { bit, sub: 0 } => (true, !self.rom_bit(bit)),
                OwPhase::Search { bit, sub: 1 } => (true, self.rom_bit(bit)),
                _ => (false, false),
            };
            self.read_slot = read;
            if zero {
                self.plan.push_back((now, true));
                self.plan.push_back((now + 30e-6, false));
            }
            match self.phase {
                OwPhase::Send => {
                    self.tx.pop_front();
                    if self.tx.is_empty() {
                        self.phase = self.then;
                    }
                }
                OwPhase::Search { bit, sub } if sub < 2 => {
                    self.phase = OwPhase::Search { bit, sub: sub + 1 }
                }
                _ => {}
            }
            return;
        }
        let Some(fall) = self.fall.take() else {
            return;
        };
        let w = now - fall;
        if w >= 480e-6 {
            // Reset: presence pulse after 30 µs, 120 µs long.
            self.plan.clear();
            self.plan.push_back((now + 30e-6, true));
            self.plan.push_back((now + 150e-6, false));
            self.phase = OwPhase::Rom;
            self.rx = 0;
            self.rx_bits = 0;
            self.tx.clear();
            self.read_slot = false;
            return;
        }
        // The end of a read slot (the host's release, or the last device
        // letting go of the line) carries no bit.
        if std::mem::take(&mut self.read_slot) {
            return;
        }
        // Write slot: sampled 30 µs after the falling edge.
        let bit = w < 30e-6;
        match self.phase {
            OwPhase::Search { bit: i, sub: 2 } => {
                // The host chose a direction: devices whose bit differs
                // drop out until the next reset.
                self.phase = if bit != self.rom_bit(i) {
                    OwPhase::Deselected
                } else if i == 63 {
                    OwPhase::Function
                } else {
                    OwPhase::Search { bit: i + 1, sub: 0 }
                };
            }
            OwPhase::Rom | OwPhase::Match | OwPhase::Function | OwPhase::WriteScratch => {
                self.rx |= (bit as u16) << self.rx_bits;
                self.rx_bits += 1;
                if self.rx_bits == 8 {
                    let b = self.rx as u8;
                    self.rx = 0;
                    self.rx_bits = 0;
                    self.byte(b, now);
                }
            }
            _ => {}
        }
    }

    pub fn advance(&mut self, now: Seconds) {
        while let Some(&(t, low)) = self.plan.front() {
            if t > now + 1e-12 {
                break;
            }
            self.pulling = low;
            self.plan.pop_front();
        }
    }

    pub fn next(&self) -> Option<Seconds> {
        self.plan.front().map(|&(t, _)| t)
    }
}

// ---------------------------------------------------- HD44780 via PCF8574

/// HD44780 character LCD controller (16×2) behind a PCF8574 I2C port
/// expander, wired as on the common backpack: P0 RS, P1 RW, P2 E,
/// P3 backlight, P4–P7 D4–D7. The controller latches on the falling edge
/// of E; after power-up it is in 8-bit mode until a function set with
/// DL = 0 switches it to 4-bit transfers.
#[derive(Debug, Clone)]
pub struct CharLcd {
    pub address: u8,
    /// Last byte written to the expander.
    pub port: u8,
    pub ddram: [u8; 128],
    pub cgram: [u8; 64],
    addr: u8,
    /// The address counter points into CGRAM.
    cg: bool,
    increment: bool,
    shift_display: bool,
    pub display_on: bool,
    pub cursor: bool,
    pub blink: bool,
    pub two_lines: bool,
    eight_bit: bool,
    /// First nibble of a 4-bit transfer.
    high: Option<u8>,
    pub shift: i32,
}

impl CharLcd {
    pub fn new(address: u8) -> Self {
        Self {
            address,
            port: 0xFF,
            ddram: [b' '; 128],
            cgram: [0; 64],
            addr: 0,
            cg: false,
            increment: true,
            shift_display: false,
            display_on: false,
            cursor: false,
            blink: false,
            two_lines: false,
            eight_bit: true,
            high: None,
            shift: 0,
        }
    }

    pub fn backlight(&self) -> bool {
        self.port & 0x08 != 0
    }

    fn step_addr(&mut self) {
        if self.cg {
            self.addr = if self.increment {
                self.addr + 1
            } else {
                self.addr.wrapping_sub(1)
            } & 0x3F;
        } else {
            self.addr = if self.increment {
                self.addr + 1
            } else {
                self.addr.wrapping_sub(1)
            } & 0x7F;
            if self.shift_display {
                self.shift += if self.increment { 1 } else { -1 };
            }
        }
    }

    fn instruction(&mut self, c: u8) {
        if c & 0x80 != 0 {
            self.addr = c & 0x7F;
            self.cg = false;
        } else if c & 0x40 != 0 {
            self.addr = c & 0x3F;
            self.cg = true;
        } else if c & 0x20 != 0 {
            self.eight_bit = c & 0x10 != 0;
            self.two_lines = c & 0x08 != 0;
        } else if c & 0x10 != 0 {
            // Cursor or display shift.
            let right = c & 0x04 != 0;
            if c & 0x08 != 0 {
                // Shifting the display right moves the text right: the
                // window's start column goes down.
                self.shift += if right { -1 } else { 1 };
            } else {
                self.addr = if right {
                    self.addr + 1
                } else {
                    self.addr.wrapping_sub(1)
                } & 0x7F;
            }
        } else if c & 0x08 != 0 {
            self.display_on = c & 0x04 != 0;
            self.cursor = c & 0x02 != 0;
            self.blink = c & 0x01 != 0;
        } else if c & 0x04 != 0 {
            self.increment = c & 0x02 != 0;
            self.shift_display = c & 0x01 != 0;
        } else if c & 0x02 != 0 {
            self.addr = 0;
            self.cg = false;
            self.shift = 0;
        } else if c & 0x01 != 0 {
            self.ddram = [b' '; 128];
            self.addr = 0;
            self.cg = false;
            self.shift = 0;
            self.increment = true;
        }
    }

    fn data(&mut self, d: u8) {
        if self.cg {
            self.cgram[self.addr as usize & 0x3F] = d & 0x1F;
        } else {
            // DDRAM: line 1 at 0x00–0x27, line 2 at 0x40–0x67.
            self.ddram[self.addr as usize & 0x7F] = d;
        }
        self.step_addr();
    }

    /// The expander's outputs changed to `v`.
    pub fn write_port(&mut self, v: u8) {
        let old = self.port;
        self.port = v;
        // E falling edge: latch.
        if old & 0x04 != 0 && v & 0x04 == 0 && v & 0x02 == 0 {
            let rs = v & 0x01 != 0;
            let nibble = v >> 4;
            let byte = if self.eight_bit {
                // D0–D3 are not wired: they read as 0.
                Some(nibble << 4)
            } else if let Some(hi) = self.high.take() {
                Some(hi << 4 | nibble)
            } else {
                self.high = Some(nibble);
                None
            };
            if let Some(b) = byte {
                if rs {
                    self.data(b);
                } else {
                    self.instruction(b);
                }
            }
        }
    }

    /// The visible characters, one string of 16 codes per line.
    pub fn rows(&self) -> Vec<Vec<u8>> {
        let lines = if self.two_lines { 2 } else { 1 };
        (0..2)
            .map(|r| {
                (0..16)
                    .map(|c| {
                        if r >= lines || !self.display_on {
                            return b' ';
                        }
                        let col = (c + self.shift).rem_euclid(40) as usize;
                        self.ddram[r as usize * 0x40 + col]
                    })
                    .collect()
            })
            .collect()
    }

    /// Cursor position (row, column) if it is on screen.
    pub fn cursor_at(&self) -> Option<(u8, u8)> {
        if !(self.cursor || self.blink) || !self.display_on || self.cg {
            return None;
        }
        let row = (self.addr >= 0x40) as u8;
        let col = (self.addr as i32 & 0x3F) - self.shift;
        (0..16).contains(&col).then_some((row, col as u8))
    }
}

impl I2cDevice for CharLcd {
    fn address(&self) -> u8 {
        self.address
    }
    fn start(&mut self, _read: bool, _now: Seconds) {}
    fn write(&mut self, b: u8, _now: Seconds) -> bool {
        self.write_port(b);
        true
    }
    fn read(&mut self, _now: Seconds) -> u8 {
        // Quasi-bidirectional pins read their level: the busy flag (D7)
        // is never set here.
        self.port & 0x7F
    }
    fn stop(&mut self, _now: Seconds) {}
}

// ------------------------------------------------------------- MPU-6050

/// MPU-6050 accelerometer and gyroscope (I2C 0x68, 0x69 with AD0 high).
/// The host writes a register pointer and then reads or writes from there
/// with auto-increment. It starts asleep (PWR_MGMT_1 = 0x40), when the
/// data registers read 0. Readings come from the board's tilt (roll,
/// pitch), its rotation rates and the temperature.
#[derive(Debug, Clone)]
pub struct Mpu6050 {
    pub address: u8,
    /// Rotation about X and Y (degrees): gravity seen in the chip's axes.
    pub roll: f64,
    pub pitch: f64,
    /// Rotation rates about X, Y, Z (°/s).
    pub gyro: [f64; 3],
    /// Acceleration on top of gravity along X, Y, Z (g): a shake.
    pub extra: [f64; 3],
    pub temp: f64,
    pub regs: [u8; 0x80],
    pointer: u8,
    /// The next byte written is the register pointer.
    expect_pointer: bool,
    /// ACCEL_XOUT_H … GYRO_ZOUT_L, sampled when a read starts.
    sample: [u8; 14],
}

impl Mpu6050 {
    pub const WHO_AM_I: u8 = 0x75;
    pub const PWR_MGMT_1: u8 = 0x6B;
    pub const SMPLRT_DIV: u8 = 0x19;
    pub const CONFIG: u8 = 0x1A;
    pub const GYRO_CONFIG: u8 = 0x1B;
    pub const ACCEL_CONFIG: u8 = 0x1C;
    pub const ACCEL_XOUT_H: u8 = 0x3B;
    pub const GYRO_ZOUT_L: u8 = 0x48;

    pub fn new(address: u8) -> Self {
        let mut s = Self {
            address,
            roll: 0.0,
            pitch: 0.0,
            gyro: [0.0; 3],
            extra: [0.0; 3],
            temp: 25.0,
            regs: [0; 0x80],
            pointer: 0,
            expect_pointer: true,
            sample: [0; 14],
        };
        s.reset_registers();
        s
    }

    /// Power-on register values: everything 0 except SLEEP and WHO_AM_I.
    fn reset_registers(&mut self) {
        self.regs = [0; 0x80];
        self.regs[Self::PWR_MGMT_1 as usize] = 0x40;
        self.regs[Self::WHO_AM_I as usize] = 0x68;
    }

    pub fn asleep(&self) -> bool {
        self.regs[Self::PWR_MGMT_1 as usize] & 0x40 != 0
    }

    /// Acceleration (g) along X, Y, Z: gravity turned by roll and pitch,
    /// plus any shake.
    pub fn accel_g(&self) -> [f64; 3] {
        let (r, p) = (self.roll.to_radians(), self.pitch.to_radians());
        let g = [-p.sin(), r.sin() * p.cos(), r.cos() * p.cos()];
        [0, 1, 2].map(|i| g[i] + self.extra[i])
    }

    /// LSB per g for ACCEL_CONFIG.AFS_SEL (±2/4/8/16 g).
    pub fn accel_scale(&self) -> f64 {
        16384.0 / (1 << (self.regs[Self::ACCEL_CONFIG as usize] >> 3 & 3)) as f64
    }

    /// LSB per °/s for GYRO_CONFIG.FS_SEL (±250/500/1000/2000 °/s).
    pub fn gyro_scale(&self) -> f64 {
        [131.0, 65.5, 32.8, 16.4][(self.regs[Self::GYRO_CONFIG as usize] >> 3 & 3) as usize]
    }

    /// The 14 data bytes (big-endian int16): accel X/Y/Z, temperature,
    /// gyro X/Y/Z; all 0 while asleep.
    pub fn data(&self) -> [u8; 14] {
        let mut out = [0u8; 14];
        if self.asleep() {
            return out;
        }
        let raw = |v: f64| v.round().clamp(-32768.0, 32767.0) as i16;
        let a = self.accel_g();
        let words = [
            raw(a[0] * self.accel_scale()),
            raw(a[1] * self.accel_scale()),
            raw(a[2] * self.accel_scale()),
            // Datasheet: °C = raw / 340 + 36.53.
            raw((self.temp - 36.53) * 340.0),
            raw(self.gyro[0] * self.gyro_scale()),
            raw(self.gyro[1] * self.gyro_scale()),
            raw(self.gyro[2] * self.gyro_scale()),
        ];
        for (i, w) in words.iter().enumerate() {
            out[2 * i..2 * i + 2].copy_from_slice(&w.to_be_bytes());
        }
        out
    }

    fn write_register(&mut self, r: u8, v: u8) {
        match r {
            Self::WHO_AM_I => {} // read-only
            Self::PWR_MGMT_1 if v & 0x80 != 0 => self.reset_registers(),
            _ => self.regs[r as usize & 0x7F] = v,
        }
    }
}

impl I2cDevice for Mpu6050 {
    fn address(&self) -> u8 {
        self.address
    }
    fn start(&mut self, read: bool, _now: Seconds) {
        self.expect_pointer = !read;
        if read {
            self.sample = self.data();
        }
    }
    fn write(&mut self, b: u8, _now: Seconds) -> bool {
        if self.expect_pointer {
            self.pointer = b & 0x7F;
            self.expect_pointer = false;
        } else {
            self.write_register(self.pointer, b);
            self.pointer = (self.pointer + 1) & 0x7F;
        }
        true
    }
    fn read(&mut self, _now: Seconds) -> u8 {
        let r = self.pointer;
        self.pointer = (r + 1) & 0x7F;
        match r {
            Self::ACCEL_XOUT_H..=Self::GYRO_ZOUT_L => {
                self.sample[(r - Self::ACCEL_XOUT_H) as usize]
            }
            _ => self.regs[r as usize],
        }
    }
    fn stop(&mut self, _now: Seconds) {}
}

// ------------------------------------------------------------- MAX7219

/// Code-B font of the MAX7219 (decode mode) as segments DP A B C D E F G
/// (bit 7 … bit 0): 0–9, −, E, H, L, P, blank.
const CODE_B: [u8; 16] = [
    0x7E, 0x30, 0x6D, 0x79, 0x33, 0x5B, 0x5F, 0x70, 0x7F, 0x7B, 0x01, 0x4F, 0x37, 0x0E, 0x67, 0x00,
];

/// A chain of up to 4 MAX7219 LED drivers, each with an 8×8 matrix (the
/// FC-16 module). 16-bit frames (address nibble, data byte) are shifted in
/// MSB first on CLK rising edges while CS is low and taken on the CS rising
/// edge; with N chips the last 16·N bits count, the first frame shifted
/// ending up in the farthest chip. What falls out of the farthest chip's
/// register comes out on DOUT (its MSB, 16·N clocks after it went in,
/// changing on the CLK falling edge), so a further module on DOUT carries
/// the chain on.
#[derive(Debug, Clone)]
pub struct Max7219 {
    pub count: usize,
    /// The chained shift registers, the nearest chip in the low 16 bits.
    shift: u64,
    /// The level on DOUT: the register's MSB as of the last CLK falling
    /// edge (or the end of the last SPI byte).
    pub dout: bool,
    /// Registers 0x0–0xF of each chip (0x1–0x8 digits, 0x9 decode mode,
    /// 0xA intensity, 0xB scan limit, 0xC shutdown, 0xF display test).
    pub regs: [[u8; 16]; 4],
    last_clk: Option<bool>,
    last_cs: Option<bool>,
    /// Frames latched so far.
    pub latches: u32,
}

impl Max7219 {
    pub const MAX_CHAIN: usize = 4;

    /// Power-up: all registers 0, so the chips start in shutdown.
    pub fn new(count: usize) -> Self {
        Self {
            count: count.clamp(1, Self::MAX_CHAIN),
            shift: 0,
            dout: false,
            regs: [[0; 16]; 4],
            last_clk: None,
            last_cs: None,
            latches: 0,
        }
    }

    fn mask(&self) -> u64 {
        if self.count >= 4 {
            u64::MAX
        } else {
            (1u64 << (16 * self.count)) - 1
        }
    }

    /// The register's MSB: the bit the next clock pushes out.
    fn msb(&self) -> bool {
        self.shift >> (16 * self.count - 1) & 1 != 0
    }

    /// One bit into DIN; returns the bit pushed out of the far end.
    pub fn shift_bit(&mut self, bit: bool) -> bool {
        let out = self.msb();
        self.shift = (self.shift << 1 | bit as u64) & self.mask();
        out
    }

    /// Eight bits, MSB first (an SPI byte). Returns the eight bits that
    /// left on DOUT meanwhile, first one in the MSB: what a module chained
    /// on DOUT receives. The clock idles low afterwards (SPI mode 0), so
    /// DOUT already shows the new MSB.
    pub fn byte(&mut self, b: u8) -> u8 {
        let mut out = 0;
        for i in (0..8).rev() {
            out = out << 1 | self.shift_bit(b >> i & 1 != 0) as u8;
        }
        self.dout = self.msb();
        out
    }

    /// CS rising edge: every chip takes the frame in its shift register.
    pub fn latch(&mut self) {
        for i in 0..self.count {
            let frame = (self.shift >> (16 * i)) as u16;
            let addr = (frame >> 8 & 0xF) as usize;
            if addr != 0 {
                self.regs[i][addr] = frame as u8;
            }
        }
        self.latches += 1;
    }

    /// The levels of CLK, CS and DIN now (bit-banged or not): shift on a
    /// CLK rising edge with CS low, latch on a CS rising edge, DOUT
    /// follows the MSB on a CLK falling edge.
    pub fn pins(&mut self, clk: bool, cs: bool, din: bool) {
        if self.last_clk == Some(false) && clk && !cs {
            self.shift_bit(din);
        }
        if self.last_clk == Some(true) && !clk {
            self.dout = self.msb();
        }
        if self.last_cs == Some(false) && cs {
            self.latch();
        }
        self.last_clk = Some(clk);
        self.last_cs = Some(cs);
    }

    /// Rows (digits 0–7, top first) of chip `i` as displayed: blank in
    /// shutdown, all on in display test, digits past the scan limit dark,
    /// Code-B decoded where the decode mode says so. Bit 7 is the left
    /// column.
    pub fn rows(&self, i: usize) -> [u8; 8] {
        let r = &self.regs[i];
        if r[0xF] & 1 != 0 {
            return [0xFF; 8];
        }
        let mut out = [0u8; 8];
        if r[0xC] & 1 == 0 {
            return out;
        }
        for (d, row) in out.iter_mut().enumerate() {
            if d > (r[0xB] & 7) as usize {
                break;
            }
            let v = r[1 + d];
            *row = if r[0x9] >> d & 1 != 0 {
                CODE_B[(v & 0xF) as usize] | (v & 0x80)
            } else {
                v
            };
        }
        out
    }

    /// Duty setting 0–15 of chip `i` (15 in display test).
    pub fn intensity(&self, i: usize) -> u8 {
        if self.regs[i][0xF] & 1 != 0 {
            15
        } else {
            self.regs[i][0xA] & 0xF
        }
    }
}

// ------------------------------------------------------------ IR remote

/// Buttons of the 17-key remote (NEC, address 0x00) and their commands.
pub const IR_KEYS: [(&str, u8); 17] = [
    ("1", 0x45),
    ("2", 0x46),
    ("3", 0x47),
    ("4", 0x44),
    ("5", 0x40),
    ("6", 0x43),
    ("7", 0x07),
    ("8", 0x15),
    ("9", 0x09),
    ("*", 0x16),
    ("0", 0x19),
    ("#", 0x0D),
    ("UP", 0x18),
    ("LEFT", 0x08),
    ("OK", 0x1C),
    ("RIGHT", 0x5A),
    ("DOWN", 0x52),
];

/// NEC address the remote sends.
pub const IR_ADDRESS: u8 = 0x00;

/// An IR receiver (VS1838B class) with its remote: a pressed button makes
/// the receiver's active-low output carry the demodulated NEC frame — 9 ms
/// mark, 4.5 ms space, 32 bits LSB first (address, ~address, command,
/// ~command), each a 562.5 µs mark then a 562.5 µs (0) or 1687.5 µs (1)
/// space, and a final mark. While the button is held, a repeat code
/// (9 ms mark, 2.25 ms space, mark) follows every 108 ms.
#[derive(Debug, Clone, Default)]
pub struct IrRemote {
    /// Planned output changes: (time, output pulled low).
    plan: VecDeque<(Seconds, bool)>,
    /// The output is low (a mark) now.
    pub low: bool,
    /// The command of the button held down.
    held: Option<u8>,
    next_repeat: Option<Seconds>,
    /// The last frame sent: (command, repeat).
    pub last: Option<(u8, bool)>,
}

impl IrRemote {
    pub const MARK: Seconds = 562.5e-6;
    pub const REPEAT_PERIOD: Seconds = 0.108;

    /// The command of a button label ("5", "OK", …).
    pub fn command(key: &str) -> Option<u8> {
        IR_KEYS.iter().find(|(k, _)| *k == key).map(|&(_, c)| c)
    }

    fn push(&mut self, t: Seconds, low: bool) {
        self.plan.push_back((t, low));
    }

    /// The pulse train of one full frame from `t`; returns its end.
    fn frame(&mut self, mut t: Seconds, cmd: u8) -> Seconds {
        let bytes = [IR_ADDRESS, !IR_ADDRESS, cmd, !cmd];
        self.push(t, true);
        t += 9e-3;
        self.push(t, false);
        t += 4.5e-3;
        for byte in bytes {
            for bit in 0..8 {
                self.push(t, true);
                t += Self::MARK;
                self.push(t, false);
                t += if byte >> bit & 1 != 0 {
                    3.0 * Self::MARK
                } else {
                    Self::MARK
                };
            }
        }
        self.push(t, true);
        t += Self::MARK;
        self.push(t, false);
        t
    }

    /// A button goes down at `now`.
    pub fn press(&mut self, now: Seconds, cmd: u8) {
        // After a frame still going out.
        let start = self.plan.back().map_or(now, |&(t, _)| t.max(now));
        self.frame(start, cmd);
        self.held = Some(cmd);
        self.next_repeat = Some(start + Self::REPEAT_PERIOD);
        self.last = Some((cmd, false));
    }

    /// The button is let go: the frame going out finishes, no more repeats.
    pub fn release(&mut self) {
        self.held = None;
        self.next_repeat = None;
    }

    pub fn advance(&mut self, now: Seconds) {
        while let (Some(t), Some(cmd)) = (self.next_repeat, self.held) {
            if t > now + 1e-12 {
                break;
            }
            self.push(t, true);
            self.push(t + 9e-3, false);
            self.push(t + 11.25e-3, true);
            self.push(t + 11.25e-3 + Self::MARK, false);
            self.next_repeat = Some(t + Self::REPEAT_PERIOD);
            self.last = Some((cmd, true));
        }
        while let Some(&(t, low)) = self.plan.front() {
            if t > now + 1e-12 {
                break;
            }
            self.low = low;
            self.plan.pop_front();
        }
    }

    pub fn next(&self) -> Option<Seconds> {
        match (self.plan.front().map(|&(t, _)| t), self.next_repeat) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }
}

// -------------------------------------------------------------- HC-05

/// HC-05 Bluetooth serial module (ZS-040 board). In data mode it bridges
/// its UART (RXD/TXD, 8N1 at `baud`, 9600 by default) to the paired phone;
/// with EN (KEY) high at power-up it starts in AT command mode at 38400
/// baud and answers commands instead. The UART is modelled at the byte
/// level, like the virtual COM port: the board routes the bytes of the
/// USART whose pins are wired to RXD/TXD here.
#[derive(Debug, Clone)]
pub struct Hc05 {
    /// Data-mode baud rate (`AT+UART` changes it).
    pub baud: u32,
    /// The part's `baud` prop it was last set from.
    pub prop_baud: u32,
    pub name: String,
    /// The phone is paired and connected (the panel's toggle).
    pub connected: bool,
    /// Started in AT command mode (EN high at power-up).
    pub at_mode: bool,
    /// Supply present (seen at the last circuit update).
    pub powered: bool,
    /// Received from the MCU, for the phone: (byte, re-sampled at a
    /// mismatched baud rate).
    pub to_phone: Vec<(u8, bool)>,
    /// For the MCU's RX: what the phone typed, or AT replies.
    pub to_mcu: VecDeque<u8>,
    /// AT command being received.
    line: Vec<u8>,
    /// Bytes the MCU sent with no phone connected (dropped).
    pub dropped: u32,
}

/// Baud rate of the HC-05 AT command mode.
pub const HC05_AT_BAUD: u32 = 38_400;

impl Hc05 {
    pub fn new(baud: u32) -> Self {
        Self {
            baud,
            prop_baud: baud,
            name: "HC-05".into(),
            connected: false,
            at_mode: false,
            powered: false,
            to_phone: Vec::new(),
            to_mcu: VecDeque::new(),
            line: Vec::new(),
            dropped: 0,
        }
    }

    /// The baud rate its UART runs at now.
    pub fn uart_baud(&self) -> u32 {
        if self.at_mode {
            HC05_AT_BAUD
        } else {
            self.baud
        }
    }

    /// Data passes between the MCU and the phone.
    pub fn linked(&self) -> bool {
        self.powered && self.connected && !self.at_mode
    }

    /// Power came (`en`: level of EN then) or went.
    pub fn power(&mut self, on: bool, en: bool) {
        if on && !self.powered {
            self.at_mode = en;
            self.line.clear();
            self.to_mcu.clear();
        }
        self.powered = on;
    }

    /// A byte arrived on RXD.
    pub fn from_mcu(&mut self, byte: u8, garbled: bool) {
        if !self.powered {
            return;
        }
        if self.at_mode {
            self.at_byte(byte);
        } else if self.connected {
            self.to_phone.push((byte, garbled));
        } else {
            self.dropped += 1;
        }
    }

    /// The phone sends text; it reaches the MCU only over a connection.
    pub fn from_phone(&mut self, bytes: &[u8]) -> bool {
        if !self.linked() {
            return false;
        }
        self.to_mcu.extend(bytes);
        true
    }

    fn reply(&mut self, s: &str) {
        self.to_mcu.extend(s.as_bytes());
    }

    fn at_byte(&mut self, b: u8) {
        if b != b'\n' {
            if b != b'\r' && self.line.len() < 64 {
                self.line.push(b);
            }
            return;
        }
        let cmd = String::from_utf8_lossy(&std::mem::take(&mut self.line)).to_string();
        let upper = cmd.trim().to_ascii_uppercase();
        if upper.is_empty() {
            return;
        }
        match upper.as_str() {
            "AT" | "AT+RESET" | "AT+INIT" => self.reply("OK\r\n"),
            "AT+NAME?" | "AT+NAME" => {
                let r = format!("+NAME:{}\r\nOK\r\n", self.name);
                self.reply(&r);
            }
            "AT+VERSION?" | "AT+VERSION" => self.reply("+VERSION:2.0-20100601\r\nOK\r\n"),
            "AT+ROLE?" => self.reply("+ROLE:0\r\nOK\r\n"),
            "AT+ADDR?" => self.reply("+ADDR:98d3:31:fd5c42\r\nOK\r\n"),
            "AT+UART?" => {
                let r = format!("+UART:{},0,0\r\nOK\r\n", self.baud);
                self.reply(&r);
            }
            _ if upper.starts_with("AT+NAME=") => {
                self.name = cmd.trim()[8..].to_string();
                self.reply("OK\r\n");
            }
            _ if upper.starts_with("AT+UART=") => {
                match upper[8..]
                    .split(',')
                    .next()
                    .and_then(|b| b.parse::<u32>().ok())
                {
                    Some(b) if (1200..=1_382_400).contains(&b) => {
                        self.baud = b;
                        self.reply("OK\r\n");
                    }
                    _ => self.reply("ERROR:(1D)\r\n"),
                }
            }
            _ => self.reply("ERROR:(0)\r\n"),
        }
    }
}

// -------------------------------------------------------------- relay

/// Mechanics of a small signal relay (SRD-05VDC-SL-C): the contacts move
/// this long after the coil changes, and bounce on the way.
pub const RELAY_OPERATE: Seconds = 0.010;
pub const RELAY_RELEASE: Seconds = 0.005;

/// A relay module's armature: whether COM touches NO, and the contact
/// changes still to come (operate delay and bounce).
#[derive(Debug, Clone, Default)]
pub struct Relay {
    /// The coil is energised now.
    pub coil: bool,
    /// COM is connected to NO (else to NC).
    pub closed: bool,
    plan: VecDeque<(Seconds, bool)>,
    /// Contact changes (bounces included), for the click.
    pub clicks: u32,
}

impl Relay {
    /// The coil's drive changed at `now`.
    pub fn set_coil(&mut self, now: Seconds, on: bool) {
        if on == self.coil {
            return;
        }
        self.coil = on;
        // A change of mind before the contacts moved restarts the travel.
        self.plan.clear();
        let t = now + if on { RELAY_OPERATE } else { RELAY_RELEASE };
        // The moving contact lands, bounces off twice and settles.
        for (dt, state) in [
            (0.0, on),
            (0.3e-3, !on),
            (0.6e-3, on),
            (1.0e-3, !on),
            (1.3e-3, on),
        ] {
            self.plan.push_back((t + dt, state));
        }
    }

    pub fn advance(&mut self, now: Seconds) {
        while let Some(&(t, state)) = self.plan.front() {
            if t > now + 1e-12 {
                break;
            }
            if state != self.closed {
                self.clicks += 1;
            }
            self.closed = state;
            self.plan.pop_front();
        }
    }

    pub fn next(&self) -> Option<Seconds> {
        self.plan.front().map(|&(t, _)| t)
    }

    /// The contacts are where the coil puts them (no travel pending).
    pub fn settled(&self) -> bool {
        self.plan.is_empty()
    }
}

/// A bus device part's state, kept across circuit edits.
#[derive(Debug, Clone)]
pub enum Device {
    Oled(Box<Ssd1306>),
    Rtc(Ds3231),
    Aht(Aht20),
    Sd(Box<SdCard>),
    Dht(Dht),
    Pixels(NeoPixel),
    Encoder(Encoder),
    Sonar(Sonar),
    Thermo(Ds18b20),
    Lcd(Box<CharLcd>),
    Imu(Box<Mpu6050>),
    Matrix(Max7219),
    Ir(IrRemote),
    Bluetooth(Box<Hc05>),
    Relay(Relay),
}

impl Device {
    /// The I2C side of the device, if it has one.
    pub fn i2c(&mut self) -> Option<&mut dyn I2cDevice> {
        match self {
            Device::Oled(d) => Some(d.as_mut()),
            Device::Rtc(d) => Some(d),
            Device::Aht(d) => Some(d),
            Device::Lcd(d) => Some(d.as_mut()),
            Device::Imu(d) => Some(d.as_mut()),
            _ => None,
        }
    }

    /// Bring scheduled output changes up to `now`.
    pub fn advance(&mut self, now: Seconds) {
        match self {
            Device::Dht(d) => {
                d.advance(now);
            }
            Device::Encoder(e) => e.advance(now),
            Device::Sonar(s) => s.advance(now),
            Device::Thermo(d) => d.advance(now),
            Device::Ir(d) => d.advance(now),
            Device::Relay(r) => r.advance(now),
            _ => {}
        }
    }

    /// What the device drives on its output `index`: `Some(false)` low,
    /// `Some(true)` high, `None` nothing.
    pub fn drive(&self, index: usize) -> Option<bool> {
        match self {
            Device::Dht(d) => d.pulling.then_some(false),
            Device::Thermo(d) => d.pulling.then_some(false),
            Device::Encoder(e) => e.closed[index.min(1)].then_some(false),
            Device::Sonar(s) => Some(s.echo),
            Device::Ir(d) => d.low.then_some(false),
            Device::Matrix(m) => Some(m.dout),
            // STATE (0) is high while a phone is connected; TXD (1) idles high.
            Device::Bluetooth(b) => match index {
                0 => Some(b.powered && b.connected && !b.at_mode),
                _ => b.powered.then_some(true),
            },
            _ => None,
        }
    }

    /// When the device next changes an output by itself.
    pub fn next_change(&self) -> Option<Seconds> {
        match self {
            Device::Dht(d) => d.next(),
            Device::Encoder(e) => e.next(),
            Device::Sonar(s) => s.next(),
            Device::Thermo(d) => d.next(),
            Device::Ir(d) => d.next(),
            Device::Relay(r) => r.next(),
            _ => None,
        }
    }

    pub fn address(&self) -> u8 {
        match self {
            Device::Oled(d) => d.address,
            Device::Rtc(_) => 0x68,
            Device::Aht(_) => 0x38,
            Device::Lcd(d) => d.address,
            Device::Imu(d) => d.address,
            _ => 0,
        }
    }
}

/// Base64 (standard alphabet, padded), for display frames sent to the UI.
pub fn base64(data: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16
            | (*c.get(1).unwrap_or(&0) as u32) << 8
            | *c.get(2).unwrap_or(&0) as u32;
        out.push(A[(n >> 18) as usize & 63] as char);
        out.push(A[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 {
            A[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if c.len() > 2 {
            A[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn i2c_write(d: &mut dyn I2cDevice, bytes: &[u8], now: Seconds) {
        d.start(false, now);
        for &b in bytes {
            assert!(d.write(b, now));
        }
        d.stop(now);
    }

    #[test]
    fn ssd1306_draws_with_horizontal_addressing() {
        let mut o = Ssd1306::new(0x3C);
        // Typical init: off, charge pump on, horizontal mode, remap, on.
        i2c_write(
            &mut o,
            &[0x00, 0xAE, 0x8D, 0x14, 0x20, 0x00, 0xA1, 0xC8, 0xAF],
            0.0,
        );
        assert!(o.lit());
        // Columns 0..1, pages 0..1; then 4 data bytes.
        i2c_write(&mut o, &[0x00, 0x21, 0, 1, 0x22, 0, 1], 0.0);
        i2c_write(&mut o, &[0x40, 0x01, 0x80, 0xFF, 0x00], 0.0);
        assert_eq!(o.ram[0][0], 0x01);
        assert_eq!(o.ram[0][1], 0x80);
        assert_eq!(o.ram[1][0], 0xFF);
        let screen = o.screen();
        // With remap and COM reversed (header at the top), RAM page 0,
        // column 0, bit 0 is the top-left pixel.
        assert_eq!(screen[0] & 0x80, 0x80);
        assert_eq!(screen[16] & 0x80, 0x00);
    }

    #[test]
    fn ds3231_runs_with_simulated_time_and_can_be_set() {
        // 2026-11-18 21:30:05 UTC
        let t0 = (days_from_civil(2026, 11, 18) * 86_400 + 21 * 3600 + 30 * 60 + 5) as f64;
        let mut r = Ds3231::new(t0);
        let read_all = |r: &mut Ds3231, now: f64| {
            i2c_write(r, &[0x00], now);
            r.start(true, now);
            let v: Vec<u8> = (0..7).map(|_| r.read(now)).collect();
            r.stop(now);
            v
        };
        assert_eq!(
            read_all(&mut r, 0.0),
            [0x05, 0x30, 0x21, 4, 0x18, 0x11, 0x26]
        ); // Wed = 4
        assert_eq!(read_all(&mut r, 61.0)[..2], [0x06, 0x31]);
        // Set 2027-01-01 00:00:00 at t = 100 s.
        i2c_write(
            &mut r,
            &[0x00, 0x00, 0x00, 0x00, 0x06, 0x01, 0x01, 0x27],
            100.0,
        );
        assert_eq!(
            read_all(&mut r, 102.5)[..7],
            [0x02, 0x00, 0x00, 6, 0x01, 0x01, 0x27]
        );
        assert_eq!(r.display(102.5), "2027-01-01 00:00:02");
        // Write the seconds, then a repeated START to read them back.
        r.start(false, 200.0);
        r.write(0x00, 200.0);
        r.write(0x30, 200.0);
        r.start(false, 200.0);
        r.write(0x00, 200.0);
        r.start(true, 200.0);
        assert_eq!(r.read(200.0), 0x30);
        r.stop(200.0);
    }

    #[test]
    fn aht20_measures_after_80_ms() {
        let mut s = Aht20::new(23.5, 45.0);
        i2c_write(&mut s, &[0xBE, 0x08, 0x00], 0.0);
        i2c_write(&mut s, &[0xAC, 0x33, 0x00], 0.010);
        s.start(true, 0.050);
        assert_eq!(s.read(0.050) & 0x80, 0x80, "busy");
        s.stop(0.050);
        s.start(true, 0.100);
        let d: Vec<u8> = (0..7).map(|_| s.read(0.100)).collect();
        s.stop(0.100);
        assert_eq!(d[0] & 0x88, 0x08, "ready, calibrated");
        let h = ((d[1] as u32) << 12 | (d[2] as u32) << 4 | (d[3] as u32) >> 4) as f64
            / 1_048_576.0
            * 100.0;
        let t = (((d[3] as u32 & 0xF) << 16) | (d[4] as u32) << 8 | d[5] as u32) as f64
            / 1_048_576.0
            * 200.0
            - 50.0;
        assert!(
            (h - 45.0).abs() < 0.01 && (t - 23.5).abs() < 0.01,
            "{h} {t}"
        );
        assert_eq!(d[6], Aht20::crc8(&d[..6]));
    }

    #[test]
    fn base64_encodes() {
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"M"), "TQ==");
    }

    fn sd_cmd(sd: &mut SdCard, idx: u8, arg: u32) -> u8 {
        let mut c = [
            0x40 | idx,
            (arg >> 24) as u8,
            (arg >> 16) as u8,
            (arg >> 8) as u8,
            arg as u8,
            0,
        ];
        c[5] = crc7(&c[..5]) << 1 | 1;
        for b in c {
            sd.exchange(b);
        }
        // R1: the first byte with bit 7 clear.
        (0..8)
            .map(|_| sd.exchange(0xFF))
            .find(|r| r & 0x80 == 0)
            .unwrap_or(0xFF)
    }

    fn sd_init(sd: &mut SdCard) {
        assert_eq!(crc7(&[0x40, 0, 0, 0, 0]) << 1 | 1, 0x95);
        assert_eq!(sd_cmd(sd, 0, 0), 0x01);
        assert_eq!(sd_cmd(sd, 8, 0x1AA), 0x01);
        let r7: Vec<u8> = (0..4).map(|_| sd.exchange(0xFF)).collect();
        assert_eq!(r7, [0, 0, 1, 0xAA]);
        let mut r = 1;
        for _ in 0..10 {
            sd_cmd(sd, 55, 0);
            r = sd_cmd(sd, 41, 1 << 30);
            if r == 0 {
                break;
            }
        }
        assert_eq!(r, 0);
        assert_eq!(sd_cmd(sd, 58, 0), 0);
        assert_eq!(sd.exchange(0xFF) & 0x40, 0x40, "SDHC");
        for _ in 0..3 {
            sd.exchange(0xFF);
        }
    }

    #[test]
    fn sd_card_snapshot_keeps_only_used_blocks_and_counts_changes() {
        let mut sd = SdCard::new(32);
        assert_eq!(sd.generation, 0);
        sd.write_block(0, &[0xEB, 0x3C, 0x90]);
        sd.write_block(40_000, b"time,temp_c\n");
        assert_eq!(sd.generation, 2);
        let snap = sd.sparse();
        // Two blocks of 512 bytes, not a 32 MB image.
        assert_eq!(snap.len(), 8 + 2 * (4 + SD_BLOCK));
        assert_eq!(&snap[..4], b"SDS1");
        let image = sd.image();
        // Power cycles keep the contents and the count.
        sd.power_cycle();
        assert_eq!(sd.generation, 2);
        sd.wipe();
        assert_eq!((sd.read_block(0)[0], sd.generation), (0, 3));
        assert_eq!(sd.blocks, 32 * 2048, "the size stays");
        // Back from the snapshot: the same image.
        let mut back = SdCard::new(1);
        assert!(back.load_sparse(&snap));
        assert_eq!(back.blocks, 32 * 2048);
        assert_eq!(&back.read_block(40_000)[..12], b"time,temp_c\n");
        assert!(back.image() == image);
        // Not a snapshot (a raw image, a truncated one): nothing changes.
        assert!(!back.load_sparse(&[0u8; 1024]));
        assert!(!back.load_sparse(&snap[..snap.len() - 1]));
        let mut beyond = snap.clone();
        beyond[4..8].copy_from_slice(&100u32.to_le_bytes());
        assert!(!back.load_sparse(&beyond));
        assert_eq!(back.read_block(0)[0], 0xEB);
    }

    #[test]
    fn sd_card_initialises_writes_and_reads_blocks() {
        let mut sd = SdCard::new(32);
        // Wrong CRC on CMD0: CRC error.
        for b in [0x40, 0, 0, 0, 0, 0x01] {
            sd.exchange(b);
        }
        assert_eq!(sd.exchange(0xFF), 0xFF);
        assert_eq!(sd.exchange(0xFF), 0x09);
        sd_init(&mut sd);

        // CSD: C_SIZE = 32 MiB / 512 KiB − 1 = 63.
        assert_eq!(sd_cmd(&mut sd, 9, 0), 0);
        while sd.exchange(0xFF) != 0xFE {}
        let csd: Vec<u8> = (0..16).map(|_| sd.exchange(0xFF)).collect();
        assert_eq!(csd[0] >> 6, 1);
        assert_eq!(
            ((csd[7] as u32 & 0x3F) << 16) | (csd[8] as u32) << 8 | csd[9] as u32,
            63
        );
        sd.exchange(0xFF);
        sd.exchange(0xFF);

        // Write block 5.
        assert_eq!(sd_cmd(&mut sd, 24, 5), 0);
        sd.exchange(0xFF);
        sd.exchange(0xFE);
        for i in 0..512u32 {
            sd.exchange(i as u8);
        }
        sd.exchange(0xFF);
        sd.exchange(0xFF);
        assert_eq!(sd.exchange(0xFF) & 0x1F, 0x05, "data accepted");
        while sd.exchange(0xFF) == 0x00 {}
        assert_eq!(sd.read_block(5)[511], 0xFF);

        // Read it back with CMD18 and stop after one block.
        assert_eq!(sd_cmd(&mut sd, 18, 5), 0);
        while sd.exchange(0xFF) != 0xFE {}
        let data: Vec<u8> = (0..512).map(|_| sd.exchange(0xFF)).collect();
        assert_eq!(data[300], 300u32 as u8);
        let crc = (sd.exchange(0xFF) as u16) << 8 | sd.exchange(0xFF) as u16;
        assert_eq!(crc, crc16(&data));
        assert_eq!(sd_cmd(&mut sd, 12, 0), 0);
        while sd.exchange(0xFF) != 0xFF {}
        assert_eq!(sd_cmd(&mut sd, 13, 0), 0);

        // Out of range.
        sd.exchange(0xFF);
        assert_eq!(sd_cmd(&mut sd, 17, 70_000), 0x40);
        let img = sd.image();
        assert_eq!(img.len(), 32 << 20);
        assert_eq!(img[5 * 512 + 2], 2);
        let mut other = SdCard::new(8);
        other.load_image(&img);
        assert_eq!(other.blocks, 65536);
        assert_eq!(other.read_block(5)[2], 2);
    }

    #[test]
    fn dht22_answers_a_long_enough_start_signal() {
        let mut d = Dht::new(true, -3.5, 61.2);
        d.observe(0.0, false);
        d.observe(0.0005, true);
        assert!(d.next().is_none(), "0.5 ms is too short");
        assert!(d.short_start.is_some());
        d.observe(1.0, false);
        d.observe(1.002, true);
        // Replay the plan and decode it like firmware would.
        let mut edges = Vec::new();
        while let Some(t) = d.next() {
            d.advance(t);
            edges.push((t, d.pulling));
        }
        assert!(!d.pulling);
        // Bits: the high time after each 50 µs low (skip the 80/80 header).
        let highs: Vec<f64> = edges
            .windows(2)
            .skip(2)
            .filter(|w| !w[0].1)
            .map(|w| w[1].0 - w[0].0)
            .collect();
        let bits: Vec<bool> = highs.iter().take(40).map(|&h| h > 50e-6).collect();
        let bytes: Vec<u8> = bits
            .chunks(8)
            .map(|c| c.iter().fold(0, |a, &b| a << 1 | b as u8))
            .collect();
        assert_eq!(bytes[..2], [0x02, 0x64]); // 612
        assert_eq!(bytes[2..4], [0x80, 0x23]); // −35
        assert_eq!(
            bytes[4],
            bytes[..4].iter().fold(0u8, |a, &b| a.wrapping_add(b))
        );
    }

    #[test]
    fn neopixel_decodes_grb_and_latches() {
        let mut n = NeoPixel::new(2);
        let mut t = 0.0;
        let send = |n: &mut NeoPixel, byte: u8, t: &mut f64| {
            for bit in (0..8).rev() {
                let h = if byte >> bit & 1 != 0 { 0.8e-6 } else { 0.4e-6 };
                n.edge(*t, true);
                n.edge(*t + h, false);
                *t += 1.25e-6;
            }
        };
        for b in [0x10, 0xFF, 0x00, 0x00, 0x00, 0x80] {
            send(&mut n, b, &mut t);
        }
        assert_eq!(n.leds, [0, 0], "not latched yet");
        n.settle(t + 60e-6);
        assert_eq!(n.leds, [0xFF1000, 0x000080]);
        assert!(n.bad_pulse.is_none());
        n.edge(t + 100e-6, true);
        n.edge(t + 100.6e-6, false);
        assert!(n.bad_pulse.is_some_and(|w| (w - 0.6).abs() < 0.01));
    }

    #[test]
    fn encoder_turns_a_full_quadrature_cycle_per_detent() {
        let mut e = Encoder::default();
        e.rotate(0.0, 1);
        e.rotate(0.0, -1);
        let mut states = Vec::new();
        while let Some(t) = e.next() {
            e.advance(t);
            states.push(e.closed);
        }
        assert_eq!(
            states,
            [
                [true, false],
                [true, true],
                [false, true],
                [false, false],
                [false, true],
                [true, true],
                [true, false],
                [false, false]
            ]
        );
        assert_eq!(e.position, 0);
        // A turn pending when the time base restarts stays just as close.
        e.rotate(100.0, 1);
        e.rebase(100.0);
        assert!((e.next().unwrap() - Encoder::STEP).abs() < 1e-9);
    }

    /// A host bit-banging 1-Wire against the device model.
    struct Host<'a> {
        d: &'a mut Ds18b20,
        t: f64,
    }

    impl Host<'_> {
        fn low(&mut self, w: f64) {
            self.d.observe(self.t, false);
            self.d.advance(self.t);
            self.t += w;
            self.d.advance(self.t);
            if !self.d.pulling {
                self.d.observe(self.t, true);
            }
        }
        fn reset(&mut self) -> bool {
            self.low(500e-6);
            // Sample for presence 70 µs after the release.
            self.t += 70e-6;
            self.d.advance(self.t);
            let present = self.d.pulling;
            self.t += 430e-6;
            self.d.advance(self.t);
            present
        }
        fn write(&mut self, b: u8) {
            for i in 0..8 {
                let one = b >> i & 1 != 0;
                self.low(if one { 6e-6 } else { 60e-6 });
                self.t += if one { 64e-6 } else { 10e-6 };
            }
        }
        fn read(&mut self) -> u8 {
            let mut b = 0;
            for i in 0..8 {
                self.d.observe(self.t, false);
                self.d.advance(self.t);
                self.t += 6e-6;
                self.d.advance(self.t);
                if !self.d.pulling {
                    self.d.observe(self.t, true);
                }
                // Sample 9 µs after the release.
                self.t += 9e-6;
                self.d.advance(self.t);
                if !self.d.pulling {
                    b |= 1 << i;
                }
                self.t += 55e-6;
                self.d.advance(self.t);
                if !self.d.pulling && self.d.fall.is_some() {
                    self.d.observe(self.t, true);
                }
            }
            b
        }
    }

    #[test]
    fn ds18b20_converts_and_reads_its_scratchpad() {
        let mut d = Ds18b20::new(-10.125, 0x0123_4567_89AB);
        let mut h = Host { d: &mut d, t: 0.0 };
        assert!(h.reset(), "presence");
        h.write(0x33);
        let rom: Vec<u8> = (0..8).map(|_| h.read()).collect();
        assert_eq!(rom[0], 0x28);
        assert_eq!(crc8_maxim(&rom), 0, "a valid ROM code");
        // Before any conversion the scratchpad holds 85 °C.
        assert!(h.reset());
        h.write(0xCC);
        h.write(0xBE);
        let pad: Vec<u8> = (0..9).map(|_| h.read()).collect();
        assert_eq!(pad[..2], [0x50, 0x05]);
        assert_eq!(crc8_maxim(&pad), 0);
        // Convert: busy (0) until 750 ms later.
        assert!(h.reset());
        h.write(0xCC);
        h.write(0x44);
        assert_eq!(h.read(), 0);
        h.t += 0.8;
        assert_eq!(h.read(), 0xFF);
        assert!(h.reset());
        h.write(0xCC);
        h.write(0xBE);
        let pad: Vec<u8> = (0..9).map(|_| h.read()).collect();
        let raw = i16::from_le_bytes([pad[0], pad[1]]);
        assert_eq!(raw, -162); // −10.125 × 16
                               // Reading too early gives the previous result.
        h.d.temp = 30.0;
        assert!(h.reset());
        h.write(0xCC);
        h.write(0x44);
        assert!(h.reset());
        h.write(0xCC);
        h.write(0xBE);
        let pad: Vec<u8> = (0..9).map(|_| h.read()).collect();
        assert_eq!(
            i16::from_le_bytes([pad[0], pad[1]]),
            -162,
            "conversion not finished"
        );
    }

    /// Several devices on one open-drain line with its pull-up: the line
    /// is low while the host or any device pulls it (wired-AND), and every
    /// device not pulling sees each edge, as `CircuitSim::observe_lines`
    /// delivers them.
    struct Line {
        d: Vec<Ds18b20>,
        t: f64,
        host_low: bool,
        high: bool,
    }

    impl Line {
        fn new(d: Vec<Ds18b20>) -> Self {
            Self {
                d,
                t: 0.0,
                host_low: false,
                high: true,
            }
        }
        fn settle(&mut self) {
            loop {
                for d in &mut self.d {
                    d.advance(self.t);
                }
                let high = !(self.host_low || self.d.iter().any(|d| d.pulling));
                if high == self.high {
                    break;
                }
                self.high = high;
                for d in &mut self.d {
                    if !d.pulling {
                        d.observe(self.t, high);
                    }
                }
            }
        }
        fn wait(&mut self, dt: f64) {
            let end = self.t + dt;
            while let Some(t) = self
                .d
                .iter()
                .filter_map(|d| d.next())
                .filter(|&t| t <= end)
                .reduce(f64::min)
            {
                self.t = t.max(self.t);
                self.settle();
            }
            self.t = end;
            self.settle();
        }
        fn host(&mut self, low: bool) {
            self.host_low = low;
            self.settle();
        }
        fn reset(&mut self) -> bool {
            self.host(true);
            self.wait(500e-6);
            self.host(false);
            self.wait(70e-6);
            let present = !self.high;
            self.wait(430e-6);
            present
        }
        fn write_bit(&mut self, one: bool) {
            self.host(true);
            self.wait(if one { 6e-6 } else { 60e-6 });
            self.host(false);
            self.wait(if one { 64e-6 } else { 10e-6 });
        }
        fn read_bit(&mut self) -> bool {
            self.host(true);
            self.wait(6e-6);
            self.host(false);
            self.wait(9e-6);
            let b = self.high;
            self.wait(55e-6);
            b
        }
        fn write(&mut self, b: u8) {
            for i in 0..8 {
                self.write_bit(b >> i & 1 != 0);
            }
        }
        fn read(&mut self) -> u8 {
            (0..8).fold(0, |b, i| b | (self.read_bit() as u8) << i)
        }
        /// The Maxim search algorithm (application note 187): every ROM
        /// code on the line, in the order the search finds them.
        fn search(&mut self, command: u8) -> Vec<[u8; 8]> {
            let mut found = Vec::new();
            let mut rom = [0u8; 8];
            let mut last_discrepancy: i32 = -1;
            loop {
                assert!(self.reset(), "presence");
                self.write(command);
                let mut last_zero = -1;
                for i in 0..64 {
                    let (b, c) = (self.read_bit(), self.read_bit());
                    let dir = match (b, c) {
                        (true, true) => return found, // nobody answers
                        (false, true) => false,
                        (true, false) => true,
                        // Both values present: a discrepancy.
                        (false, false) => {
                            let d = if i < last_discrepancy {
                                rom[i as usize / 8] >> (i % 8) & 1 != 0
                            } else {
                                i == last_discrepancy
                            };
                            if !d {
                                last_zero = i;
                            }
                            d
                        }
                    };
                    if dir {
                        rom[i as usize / 8] |= 1 << (i % 8);
                    } else {
                        rom[i as usize / 8] &= !(1 << (i % 8));
                    }
                    self.write_bit(dir);
                }
                found.push(rom);
                last_discrepancy = last_zero;
                if last_discrepancy < 0 {
                    return found;
                }
            }
        }
    }

    fn three_sensors() -> Vec<Ds18b20> {
        vec![
            Ds18b20::new(21.5, 0x0000_0012_3456),
            Ds18b20::new(-4.0, 0x0000_0012_3457),
            Ds18b20::new(30.25, 0x00AB_CDEF_0001),
        ]
    }

    #[test]
    fn ds18b20_rom_codes_carry_family_serial_and_crc() {
        let d = Ds18b20::new(25.0, 0x0123_4567_89AB);
        assert_eq!(d.rom[0], 0x28);
        assert_eq!(d.rom[1..7], [0xAB, 0x89, 0x67, 0x45, 0x23, 0x01]);
        assert_eq!(d.rom[7], crc8_maxim(&d.rom[..7]));
        assert_eq!(crc8_maxim(&d.rom), 0, "CRC over all 8 bytes is 0");
        assert_eq!(d.rom_text(), "28-0123456789AB");
        // The example in Maxim application note 27.
        assert_eq!(
            crc8_maxim(&[0x02, 0x1C, 0xB8, 0x01, 0x00, 0x00, 0x00]),
            0xA2
        );
    }

    #[test]
    fn search_rom_finds_every_device_on_a_shared_line() {
        let mut line = Line::new(three_sensors());
        let mut want: Vec<[u8; 8]> = line.d.iter().map(|d| d.rom).collect();
        let mut found = line.search(0xF0);
        assert_eq!(found.len(), 3, "{found:02X?}");
        for rom in &found {
            assert_eq!(crc8_maxim(rom), 0);
        }
        found.sort();
        want.sort();
        assert_eq!(found, want);
        // One device alone is found in a single pass.
        let mut one = Line::new(vec![Ds18b20::new(20.0, 77)]);
        assert_eq!(one.search(0xF0), vec![ds18b20_rom(77)]);
    }

    #[test]
    fn match_rom_addresses_one_device_and_read_rom_collides() {
        let mut line = Line::new(three_sensors());
        // SKIP ROM + CONVERT T reaches all of them.
        assert!(line.reset());
        line.write(0xCC);
        line.write(0x44);
        line.wait(0.8);
        assert!(line.d.iter().all(|d| d.conversions == 1));
        for (i, want) in [21.5, -4.0, 30.25].into_iter().enumerate() {
            let rom = line.d[i].rom;
            assert!(line.reset());
            line.write(0x55);
            for b in rom {
                line.write(b);
            }
            line.write(0xBE);
            let pad: Vec<u8> = (0..9).map(|_| line.read()).collect();
            assert_eq!(crc8_maxim(&pad), 0, "only device {i} answers: {pad:02X?}");
            let t = i16::from_le_bytes([pad[0], pad[1]]) as f64 / 16.0;
            assert_eq!(t, want);
        }
        // MATCH ROM with a code nobody has: the line stays high.
        assert!(line.reset());
        line.write(0x55);
        for b in ds18b20_rom(999) {
            line.write(b);
        }
        line.write(0xBE);
        assert_eq!(line.read(), 0xFF);
        // READ ROM with three devices: their codes AND together on the line
        // and the CRC no longer checks.
        assert!(line.reset());
        line.write(0x33);
        let rom: Vec<u8> = (0..8).map(|_| line.read()).collect();
        let and: Vec<u8> = (0..8)
            .map(|i| line.d.iter().fold(0xFF, |a, d| a & d.rom[i]))
            .collect();
        assert_eq!(rom, and);
        assert_ne!(crc8_maxim(&rom), 0);
    }

    #[test]
    fn alarm_search_finds_only_devices_outside_their_limits() {
        let mut line = Line::new(three_sensors());
        // TH 25 °C, TL −10 °C for all, then convert.
        assert!(line.reset());
        line.write(0xCC);
        line.write(0x4E);
        line.write(25);
        line.write(-10i8 as u8);
        line.write(0x7F);
        assert!(line.reset());
        line.write(0xCC);
        line.write(0x44);
        line.wait(0.8);
        let found = line.search(0xEC);
        assert_eq!(found, vec![line.d[2].rom], "only the 30.25 °C sensor");
    }

    #[test]
    fn sonar_echo_width_is_58_us_per_cm() {
        let mut s = Sonar::new(25.0);
        s.trig(0.0, true);
        s.trig(5e-6, false);
        assert!(s.next().is_none() && s.short_trigger.is_some());
        s.trig(1.0, true);
        s.trig(1.0 + 12e-6, false);
        let rise = s.next().unwrap();
        s.advance(rise);
        assert!(s.echo);
        let fall = s.next().unwrap();
        assert!(((fall - rise) - 25.0 * 58e-6).abs() < 1e-9);
    }

    #[test]
    fn lcd_backpack_4bit_init_and_text() {
        let mut l = CharLcd::new(0x27);
        // Send a byte as two nibbles with the backlight on, like the
        // usual LiquidCrystal_I2C driver.
        let nibble = |l: &mut CharLcd, n: u8, rs: bool| {
            let v = n << 4 | 0x08 | rs as u8;
            l.write_port(v | 0x04);
            l.write_port(v);
        };
        let send = |l: &mut CharLcd, b: u8, rs: bool| {
            nibble(l, b >> 4, rs);
            nibble(l, b & 0xF, rs);
        };
        for n in [3, 3, 3, 2] {
            nibble(&mut l, n, false);
        }
        for c in [0x28, 0x0C, 0x06, 0x01] {
            send(&mut l, c, false);
        }
        for b in b"Hello" {
            send(&mut l, *b, true);
        }
        send(&mut l, 0xC0 | 3, false);
        // A custom character at CGRAM 0, shown on line 2.
        send(&mut l, 0x40, false);
        for row in [0x0A, 0x1F, 0x1F, 0x0E, 0x04, 0, 0, 0] {
            send(&mut l, row, true);
        }
        send(&mut l, 0xC3, false);
        send(&mut l, 0x00, true);
        let rows = l.rows();
        assert_eq!(&rows[0][..6], b"Hello ");
        assert_eq!(rows[1][3], 0);
        assert_eq!(l.cgram[1], 0x1F);
        assert!(l.backlight() && l.display_on && l.two_lines);
        assert_eq!(l.cursor_at(), None);
        // Display shift right: the text moves one column right.
        send(&mut l, 0x1C, false);
        assert_eq!(&l.rows()[0][..6], b" Hello");
        send(&mut l, 0x18, false);
        assert_eq!(&l.rows()[0][..5], b"Hello");
    }

    /// HAL_I2C_Mem_Read: pointer write, repeated START, burst read.
    fn mem_read(d: &mut dyn I2cDevice, reg: u8, n: usize) -> Vec<u8> {
        d.start(false, 0.0);
        assert!(d.write(reg, 0.0));
        d.start(true, 0.0);
        let out = (0..n).map(|_| d.read(0.0)).collect();
        d.stop(0.0);
        out
    }

    #[test]
    fn mpu6050_wakes_up_and_reads_tilt_rates_and_temperature() {
        let mut m = Mpu6050::new(0x68);
        assert_eq!(mem_read(&mut m, 0x75, 1), [0x68]);
        assert_eq!(mem_read(&mut m, 0x6B, 1), [0x40], "starts asleep");
        m.roll = 30.0;
        m.gyro = [10.0, -250.0, 300.0];
        m.temp = 25.0;
        assert_eq!(mem_read(&mut m, 0x3B, 14), [0; 14], "asleep: zeros");
        // Wake up, ±4 g, ±500 °/s.
        i2c_write(&mut m, &[0x6B, 0x00], 0.0);
        i2c_write(&mut m, &[0x1B, 0x08, 0x08], 0.0);
        assert_eq!(mem_read(&mut m, 0x19, 4), [0, 0, 0x08, 0x08]);
        let d = mem_read(&mut m, 0x3B, 14);
        let w = |i: usize| i16::from_be_bytes([d[2 * i], d[2 * i + 1]]);
        assert_eq!(w(0), 0);
        assert_eq!(w(1), 4096, "sin 30° · 8192");
        assert_eq!(w(2), (30f64.to_radians().cos() * 8192.0).round() as i16);
        assert!(((w(3) as f64 / 340.0 + 36.53) - 25.0).abs() < 0.01);
        assert_eq!(w(4), 655);
        assert_eq!(w(5), -16375);
        assert_eq!(w(6), 19650);
        // Pitch forward: X sees −sin θ; the gyro clamps at full scale.
        m.roll = 0.0;
        m.pitch = 90.0;
        m.gyro = [0.0, 0.0, 2000.0];
        let d = mem_read(&mut m, 0x3B, 14);
        let w = |i: usize| i16::from_be_bytes([d[2 * i], d[2 * i + 1]]);
        assert_eq!((w(0), w(1), w(2)), (-8192, 0, 0));
        assert_eq!(w(6), 32767);
        // Reads run on past the data into the next registers.
        assert_eq!(mem_read(&mut m, 0x47, 2)[0], 0x7F);
        // DEVICE_RESET puts it back to sleep with the defaults.
        i2c_write(&mut m, &[0x6B, 0x80], 0.0);
        assert_eq!(mem_read(&mut m, 0x1B, 2), [0, 0]);
        assert_eq!(mem_read(&mut m, 0x6B, 1), [0x40]);
        assert!(m.asleep());
    }

    #[test]
    fn mpu6050_shake_adds_to_gravity_and_saturates_at_full_scale() {
        let mut m = Mpu6050::new(0x68);
        i2c_write(&mut m, &[0x6B, 0x00], 0.0);
        let accel = |m: &mut Mpu6050| {
            let d = mem_read(m, 0x3B, 6);
            [0, 1, 2].map(|i| i16::from_be_bytes([d[2 * i], d[2 * i + 1]]))
        };
        assert_eq!(accel(&mut m), [0, 0, 16384]);
        m.extra = [0.5, -0.25, 0.75];
        assert_eq!(accel(&mut m), [8192, -4096, 16384 + 12288]);
        // ±2 g: a hard knock clips.
        m.extra = [3.0, 0.0, 0.0];
        assert_eq!(accel(&mut m)[0], 32767);
        // ±8 g has room for it.
        i2c_write(&mut m, &[0x1C, 0x10], 0.0);
        assert_eq!(accel(&mut m), [12288, 0, 4096]);
    }

    #[test]
    fn max7219_chain_shifts_latches_and_shows_rows() {
        let mut m = Max7219::new(2);
        let send = |m: &mut Max7219, frames: &[u16]| {
            for f in frames {
                m.byte((f >> 8) as u8);
                m.byte(*f as u8);
            }
            m.latch();
        };
        // Starts in shutdown: nothing shows.
        send(&mut m, &[0x0181, 0x0118]);
        assert_eq!(m.rows(0), [0; 8]);
        // The first frame goes to the far chip, the second to the near one.
        assert_eq!((m.regs[1][1], m.regs[0][1]), (0x81, 0x18));
        send(&mut m, &[0x0C01, 0x0C01]);
        send(&mut m, &[0x0B07, 0x0B07]);
        send(&mut m, &[0x0A03, 0x0A08]);
        assert_eq!(m.rows(0)[0], 0x18);
        assert_eq!(m.rows(1)[0], 0x81);
        assert_eq!((m.intensity(0), m.intensity(1)), (8, 3));
        // No-op (address 0) for the far chip, display test on the near one.
        send(&mut m, &[0x0000, 0x0F01]);
        assert_eq!(m.rows(0), [0xFF; 8]);
        assert_eq!(m.rows(1)[0], 0x81);
        send(&mut m, &[0x0000, 0x0F00]);
        // Scan limit 0: only digit 0 is shown.
        send(&mut m, &[0x0B00, 0x0B00]);
        send(&mut m, &[0x0255, 0x0255]);
        assert_eq!(m.rows(0)[1], 0);
        // Code-B decode on digit 0: "3" with the decimal point.
        send(&mut m, &[0x0901, 0x0901]);
        send(&mut m, &[0x0183, 0x0183]);
        assert_eq!(m.rows(0)[0], 0x79 | 0x80);

        // Bit-banged: shift on CLK rising edges while CS is low.
        let mut m = Max7219::new(1);
        m.pins(false, true, false);
        let frame = |m: &mut Max7219, f: u16| {
            m.pins(false, false, false);
            for i in (0..16).rev() {
                let b = f >> i & 1 != 0;
                m.pins(false, false, b);
                m.pins(true, false, b);
            }
            m.pins(false, false, false);
            m.pins(false, true, false);
        };
        frame(&mut m, 0x0C01);
        frame(&mut m, 0x0B07);
        frame(&mut m, 0x0842);
        assert_eq!(m.rows(0)[7], 0x42);
        assert_eq!(m.latches, 3);
        // Clocks with CS high shift nothing.
        m.pins(true, true, true);
        m.pins(false, true, true);
        m.pins(true, true, true);
        m.pins(false, false, false);
        m.pins(false, true, false);
        assert_eq!(m.rows(0)[7], 0x42);
    }

    #[test]
    fn max7219_dout_carries_the_bits_pushed_out_16_clocks_later() {
        // One module: a 16-bit frame comes out of DOUT 16 clocks later.
        let mut a = Max7219::new(1);
        assert_eq!((a.byte(0x0C), a.byte(0x01)), (0, 0));
        assert!(!a.dout);
        assert_eq!((a.byte(0x0A), a.byte(0x07)), (0x0C, 0x01));
        // Two separate modules, B on A's DOUT: B ends up with the frame
        // sent first, A with the last; both take them on the shared CS.
        let mut a = Max7219::new(1);
        let mut b = Max7219::new(1);
        for byte in [0x01, 0x81, 0x01, 0x18] {
            let over = a.byte(byte);
            b.byte(over);
        }
        a.latch();
        b.latch();
        assert_eq!((b.regs[0][1], a.regs[0][1]), (0x81, 0x18));
        // The same as one part with count 2.
        let mut c = Max7219::new(2);
        for byte in [0x01, 0x81, 0x01, 0x18] {
            assert_eq!(c.byte(byte), 0);
        }
        c.latch();
        assert_eq!((c.regs[1][1], c.regs[0][1]), (0x81, 0x18));

        // Bit-banged: DOUT shows the MSB from the CLK falling edge on.
        let mut a = Max7219::new(1);
        a.pins(false, false, false);
        let mut seen = Vec::new();
        for i in 0..32 {
            let bit = i == 0 || i == 15; // 0x8001, then zeros
            a.pins(false, false, bit);
            seen.push(a.dout); // what a module on DOUT samples now
            a.pins(true, false, bit);
            assert_eq!(a.dout, seen[i], "DOUT holds while CLK is high");
        }
        a.pins(false, false, false);
        // Bit i went in at clock i and is sampled downstream at clock i + 16.
        let ones: Vec<usize> = (0..32).filter(|&i| seen[i]).collect();
        assert_eq!(ones, [16, 31]);
    }

    #[test]
    fn ir_remote_sends_nec_frames_and_repeats_while_held() {
        let mut r = IrRemote::default();
        let cmd = IrRemote::command("OK").unwrap();
        assert_eq!(cmd, 0x1C);
        r.press(1.0, cmd);
        // Collect (time, low) changes until the button is let go at 1.25 s.
        let mut edges = Vec::new();
        let mut released = false;
        while let Some(t) = r.next() {
            if t > 1.25 && !released {
                r.release();
                released = true;
                continue;
            }
            let before = r.low;
            r.advance(t);
            if r.low != before {
                edges.push((t - 1.0, r.low));
            }
        }
        assert!(!r.low);
        // Durations of the levels after each change.
        let widths: Vec<f64> = edges.windows(2).map(|w| (w[1].0 - w[0].0) * 1e6).collect();
        assert!((widths[0] - 9000.0).abs() < 1e-3 && (widths[1] - 4500.0).abs() < 1e-3);
        let mut bits = 0u32;
        for i in 0..32 {
            assert!((widths[2 + 2 * i] - 562.5).abs() < 1e-3);
            let space = widths[3 + 2 * i];
            assert!((space - 562.5).abs() < 1e-3 || (space - 1687.5).abs() < 1e-3);
            bits |= ((space > 1000.0) as u32) << i;
        }
        assert_eq!(bits.to_le_bytes(), [0x00, 0xFF, 0x1C, 0xE3]);
        // Then two repeat codes (at 108 and 216 ms), none after the release.
        let rest: Vec<f64> = edges[68..].iter().map(|e| e.0 * 1e3).collect();
        assert_eq!(rest.len(), 8, "{rest:?}");
        assert!((rest[0] - 108.0).abs() < 1e-6 && (rest[4] - 216.0).abs() < 1e-6);
        assert!((rest[1] - rest[0] - 9.0).abs() < 1e-6);
        assert!((rest[2] - rest[1] - 2.25).abs() < 1e-6);
        assert_eq!(r.last, Some((0x1C, true)));
    }
}
