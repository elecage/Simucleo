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
            let row = if self.com_reverse { 63 - y } else { y };
            let line = (row + self.start_line as usize) % 64;
            for x in 0..128usize {
                let seg = if self.seg_remap { 127 - x } else { x };
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
        if self.time_written {
            // The 12/24 h bit lives in the hours register.
            let mode = self.regs[2] & 0x40;
            self.apply_time(now);
            self.regs[2] = (self.regs[2] & !0x40) | mode;
            self.time_written = false;
        }
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
        }
    }

    /// Protocol state back to power-up; the contents stay.
    pub fn power_cycle(&mut self) {
        let mut fresh = Self::new(1);
        fresh.blocks = self.blocks;
        fresh.nominal_mb = self.nominal_mb;
        fresh.data = std::mem::take(&mut self.data);
        fresh.dirty = self.dirty;
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

/// A bus device part's state, kept across circuit edits.
#[derive(Debug, Clone)]
pub enum Device {
    Oled(Box<Ssd1306>),
    Rtc(Ds3231),
    Aht(Aht20),
    Sd(Box<SdCard>),
}

impl Device {
    /// The I2C side of the device, if it has one.
    pub fn i2c(&mut self) -> Option<&mut dyn I2cDevice> {
        match self {
            Device::Oled(d) => Some(d.as_mut()),
            Device::Rtc(d) => Some(d),
            Device::Aht(d) => Some(d),
            Device::Sd(_) => None,
        }
    }

    pub fn address(&self) -> u8 {
        match self {
            Device::Oled(d) => d.address,
            Device::Rtc(_) => 0x68,
            Device::Aht(_) => 0x38,
            Device::Sd(_) => 0,
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
        // With remap and COM reversed, RAM (page 0, col 0, bit 0) is the
        // bottom-right pixel.
        assert_eq!(screen[63 * 16 + 15] & 0x01, 0x01);
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
}
