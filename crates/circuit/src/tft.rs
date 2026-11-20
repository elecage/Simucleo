//! Colour SPI TFT displays (M35): the Sitronix ST7735S (1.8" 128×160
//! modules) and the Ilitek ILI9341 (2.4"/2.8" 240×320 modules).
//!
//! Both controllers speak the same MIPI DCS command set over a 4-wire
//! serial interface: CSX low selects the chip, SDA is sampled on SCL
//! rising edges MSB first, and D/CX at the eighth bit of each byte says
//! whether it is a command (low) or a parameter / pixel data (high). The
//! model keeps the controller's frame memory (18 bits per pixel, as the
//! chips store it) and the registers that change what the panel shows:
//!
//! - power-on: sleep in, display off, frame memory random, 18-bit pixels,
//!   MADCTL 0, the column / row window the whole memory;
//! - SWRESET (0x01) and the RESX pin: the registers back to their defaults
//!   (the memory keeps its contents); for 5 ms afterwards the chip ignores
//!   commands, and SLPOUT within 120 ms of a reset is ignored as well (the
//!   datasheets' timing, which drivers wait for with delays);
//! - SLPIN / SLPOUT (0x10 / 0x11; 5 ms before the next command after
//!   SLPOUT), DISPOFF / DISPON (0x28 / 0x29), INVOFF / INVON (0x20 /
//!   0x21), IDMOFF / IDMON (0x38 / 0x39, 8 colours), NORON / PTLON;
//! - COLMOD (0x3A): 12-bit (ST7735S), 16-bit RGB565 and 18-bit RGB666
//!   pixels;
//! - MADCTL (0x36): MY / MX mirror the row / column addresses, MV swaps
//!   them (rotation), BGR swaps red and blue on the panel; ML / MH only
//!   change the refresh direction;
//! - CASET / RASET (0x2A / 0x2B) set the window, RAMWR (0x2C) streams
//!   pixels into it from its top-left corner, left to right and top to
//!   bottom, wrapping back to the start when the window is full; the
//!   ILI9341's Write Memory Continue (0x3C) goes on where RAMWR stopped;
//! - reads on the ILI9341's SDO (MISO): RDDID (0x04), RDDST (0x09),
//!   RDDPM (0x0A), RDDMADCTL (0x0B), RDDCOLMOD (0x0C), RDID1–3 (0xDA–
//!   0xDC), Read ID4 (0xD3: 0x00 0x93 0x41) and RAMRD (0x2E), each after
//!   one dummy byte as the datasheet shows;
//! - all other commands (frame rate, power, gamma …) take their
//!   parameters and change nothing visible.
//!
//! The panel itself is mounted on the module in a fixed way: on the
//! ST7735S modules the image of MADCTL 0 is upside down (drivers send
//! MY | MX for "rotation 0"), on the ILI9341 modules it is mirrored
//! left to right (drivers send MX). The 132×162 memory of the ST7735S
//! "green tab" modules has the panel 2 columns and 1 row in. Which colour
//! filter order the panel has (RGB or BGR) depends on the module too.

use std::sync::atomic::{AtomicU64, Ordering};

use crate::devices::Seconds;

/// The controller on a module.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TftModel {
    St7735s,
    Ili9341,
}

/// How the panel's pixels sit relative to the controller's memory, seen
/// from the front with the module's header at the top.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mount {
    Normal,
    MirrorX,
    Rotate180,
}

/// One kind of module: the controller, its memory and how the panel is
/// mounted on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TftConfig {
    pub model: TftModel,
    /// Frame memory size (columns × rows, MADCTL 0).
    pub mem_w: u16,
    pub mem_h: u16,
    /// Visible panel size and where it starts in the memory.
    pub panel_w: u16,
    pub panel_h: u16,
    pub off_x: u16,
    pub off_y: u16,
    pub mount: Mount,
    /// The panel's colour filters are in B, G, R order (MADCTL BGR = 1
    /// shows the colours right).
    pub panel_bgr: bool,
}

impl TftConfig {
    /// A 1.8" ST7735S module. `tab` is the colour of the protective film's
    /// tab the drivers name them by: "black" (128×160 memory, RGB panel),
    /// "red" (128×160, BGR) or "green" (132×162 memory, BGR, the panel 2
    /// columns and 1 row in).
    pub fn st7735(tab: &str) -> Self {
        let base = TftConfig {
            model: TftModel::St7735s,
            mem_w: 128,
            mem_h: 160,
            panel_w: 128,
            panel_h: 160,
            off_x: 0,
            off_y: 0,
            mount: Mount::Rotate180,
            panel_bgr: false,
        };
        match tab {
            "red" => TftConfig {
                panel_bgr: true,
                ..base
            },
            "green" => TftConfig {
                mem_w: 132,
                mem_h: 162,
                off_x: 2,
                off_y: 1,
                panel_bgr: true,
                ..base
            },
            _ => base,
        }
    }

    /// A 2.4"/2.8" ILI9341 module (240×320, BGR panel, mirrored).
    pub fn ili9341() -> Self {
        TftConfig {
            model: TftModel::Ili9341,
            mem_w: 240,
            mem_h: 320,
            panel_w: 240,
            panel_h: 320,
            off_x: 0,
            off_y: 0,
            mount: Mount::MirrorX,
            panel_bgr: true,
        }
    }

    fn name(&self) -> &'static str {
        match self.model {
            TftModel::St7735s => "ST7735S",
            TftModel::Ili9341 => "ILI9341",
        }
    }
}

/// Commands are ignored this long after a reset or SLPOUT (s).
pub const TFT_BUSY: Seconds = 0.005;
/// SLPOUT is ignored this soon after a reset (s).
pub const TFT_RESET_TO_SLPOUT: Seconds = 0.120;

/// Image versions, unique across all displays (and their re-creations),
/// so a viewer can tell any change from "the same picture as before".
static NEXT_VERSION: AtomicU64 = AtomicU64::new(1);

fn next_version() -> u64 {
    NEXT_VERSION.fetch_add(1, Ordering::Relaxed)
}

const MADCTL_MY: u8 = 0x80;
const MADCTL_MX: u8 = 0x40;
const MADCTL_MV: u8 = 0x20;
const MADCTL_ML: u8 = 0x10;
const MADCTL_BGR: u8 = 0x08;
const MADCTL_MH: u8 = 0x04;

/// What a read command clocks out on SDO.
#[derive(Debug, Clone)]
enum Read {
    None,
    /// Bytes still to come.
    Bytes(Vec<u8>, usize),
    /// RAMRD: the dummy byte (`first`), then three bytes per pixel.
    Ram {
        first: bool,
        sub: u8,
        px: u32,
    },
}

/// One ST7735S / ILI9341 controller and its frame memory.
#[derive(Debug, Clone)]
pub struct Tft {
    pub cfg: TftConfig,
    /// Frame memory, `mem_w × mem_h`, 18 bits per pixel (R6 G6 B6, R in
    /// the high bits).
    mem: Vec<u32>,
    pub sleeping: bool,
    pub display_on: bool,
    pub inverted: bool,
    pub idle: bool,
    pub madctl: u8,
    pub colmod: u8,
    /// Window (logical addresses, inclusive) and the write pointer.
    pub xs: u16,
    pub xe: u16,
    pub ys: u16,
    pub ye: u16,
    col: u16,
    row: u16,
    /// The command whose parameters come next, and those so far.
    cmd: Option<u8>,
    params: Vec<u8>,
    /// RAMWR in progress, the bytes of the pixel being assembled.
    writing: bool,
    pix: [u8; 3],
    pix_n: usize,
    read: Read,
    /// Supply present (the power-on reset happened).
    pub powered: bool,
    /// RESX held low.
    pub in_reset: bool,
    /// Commands before this time are ignored; SLPOUT before `slpout_at`.
    busy_until: Seconds,
    slpout_at: Seconds,
    /// Bit-banged serial interface: last SCL level, the byte so far.
    last_sck: Option<bool>,
    last_cs: Option<bool>,
    shift: u8,
    bits: u8,
    /// Bytes taken so far (commands and data).
    pub bytes: u64,
    /// The picture changed since the last [`Tft::frame_version`].
    dirty: bool,
    version: u64,
    /// Something the firmware got wrong, for the warnings.
    pub warning: Option<String>,
}

impl Tft {
    /// Power-on: the memory holds noise (as on a real panel — what shows
    /// at DISPON if the firmware never clears it), sleep in, display off.
    pub fn new(cfg: TftConfig) -> Self {
        let n = cfg.mem_w as usize * cfg.mem_h as usize;
        let mut seed: u32 = 0x1234_5678 ^ n as u32;
        let mem = (0..n)
            .map(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                seed & 0x3FFFF
            })
            .collect();
        let mut t = Tft {
            cfg,
            mem,
            sleeping: true,
            display_on: false,
            inverted: false,
            idle: false,
            madctl: 0,
            colmod: 0x66,
            xs: 0,
            xe: 0,
            ys: 0,
            ye: 0,
            col: 0,
            row: 0,
            cmd: None,
            params: Vec::new(),
            writing: false,
            pix: [0; 3],
            pix_n: 0,
            read: Read::None,
            powered: false,
            in_reset: false,
            busy_until: 0.0,
            slpout_at: 0.0,
            last_sck: None,
            last_cs: None,
            shift: 0,
            bits: 0,
            bytes: 0,
            dirty: false,
            version: next_version(),
            warning: None,
        };
        t.defaults();
        t
    }

    /// The registers after a hardware or software reset (the memory keeps
    /// what it holds).
    fn defaults(&mut self) {
        self.sleeping = true;
        self.display_on = false;
        self.inverted = false;
        self.idle = false;
        self.madctl = 0;
        self.colmod = match self.cfg.model {
            TftModel::St7735s => 0x06,
            TftModel::Ili9341 => 0x66,
        };
        self.xs = 0;
        self.ys = 0;
        self.xe = self.cfg.mem_w - 1;
        self.ye = self.cfg.mem_h - 1;
        self.col = 0;
        self.row = 0;
        self.cmd = None;
        self.params.clear();
        self.writing = false;
        self.pix_n = 0;
        self.read = Read::None;
        self.dirty = true;
    }

    /// RESX level now (`low` = held in reset) at time `now`: the chip
    /// resets while it is low and starts its reset timing when it rises.
    pub fn reset_pin(&mut self, now: Seconds, low: bool) {
        if low {
            if !self.in_reset {
                self.in_reset = true;
                self.defaults();
            }
        } else if self.in_reset {
            self.in_reset = false;
            self.after_reset(now);
        }
    }

    fn after_reset(&mut self, now: Seconds) {
        self.busy_until = now + TFT_BUSY;
        self.slpout_at = now + TFT_RESET_TO_SLPOUT;
    }

    /// Power came up at `now` (the chip's own power-on reset).
    pub fn power_on(&mut self, now: Seconds) {
        self.powered = true;
        self.after_reset(now);
    }

    /// The panel shows the frame memory: out of reset, awake, display on.
    pub fn lit(&self) -> bool {
        !self.in_reset && !self.sleeping && self.display_on
    }

    /// The image version as of the end of this frame: a new one whenever
    /// anything the panel shows changed.
    pub fn frame_version(&mut self) -> u64 {
        if self.dirty {
            self.dirty = false;
            self.version = next_version();
        }
        self.version
    }

    /// CSX went high: the serial interface starts afresh (a partial byte is
    /// dropped) and a read ends. Commands and RAMWR carry on.
    pub fn deselect(&mut self) {
        self.bits = 0;
        self.shift = 0;
        self.read = Read::None;
    }

    /// The serial lines now (bit-banged GPIO): SDA is taken on each SCL
    /// rising edge while CSX is low, D/CX with the eighth bit.
    pub fn pins(&mut self, now: Seconds, sck: bool, cs: bool, sda: bool, dc: bool) {
        let rose_cs = self.last_cs == Some(false) && cs;
        self.last_cs = Some(cs);
        if rose_cs || cs {
            if rose_cs {
                self.deselect();
            }
            self.last_sck = Some(sck);
            return;
        }
        let rising = self.last_sck == Some(false) && sck;
        self.last_sck = Some(sck);
        if !rising {
            return;
        }
        self.shift = self.shift << 1 | sda as u8;
        self.bits += 1;
        if self.bits == 8 {
            let b = self.shift;
            self.bits = 0;
            self.shift = 0;
            self.byte(now, dc, b);
        }
    }

    /// One byte from the MCU (`dc` = D/CX high: data). Returns what the
    /// chip clocked out on SDO meanwhile (`None`: it drives nothing).
    pub fn byte(&mut self, now: Seconds, dc: bool, b: u8) -> Option<u8> {
        if self.in_reset {
            return None;
        }
        self.bytes += 1;
        if dc {
            if !matches!(self.read, Read::None) {
                return Some(self.read_byte());
            }
            self.data(b);
            None
        } else {
            self.command(now, b);
            None
        }
    }

    fn warn(&mut self, w: String) {
        if self.warning.is_none() {
            self.warning = Some(w);
        }
    }

    fn command(&mut self, now: Seconds, c: u8) {
        self.writing = false;
        self.pix_n = 0;
        self.read = Read::None;
        self.cmd = None;
        self.params.clear();
        if now < self.busy_until {
            self.warn(format!(
                "{}: command 0x{c:02X} ignored — sent {:.1} ms after a reset or SLPOUT; the chip needs 5 ms (wait 120 ms after a reset)",
                self.cfg.name(),
                (now - (self.busy_until - TFT_BUSY)) * 1e3
            ));
            return;
        }
        let ili = self.cfg.model == TftModel::Ili9341;
        let dummy_then = |v: &[u8]| {
            let mut b = vec![0x00];
            b.extend_from_slice(v);
            Read::Bytes(b, 0)
        };
        match c {
            0x01 => {
                self.defaults();
                self.after_reset(now);
            }
            0x10 => {
                self.sleeping = true;
                self.dirty = true;
            }
            0x11 => {
                if now < self.slpout_at {
                    self.warn(format!(
                        "{}: SLPOUT ignored — sent {:.0} ms after a reset; wait 120 ms",
                        self.cfg.name(),
                        (now - (self.slpout_at - TFT_RESET_TO_SLPOUT)) * 1e3
                    ));
                    return;
                }
                if self.sleeping {
                    self.sleeping = false;
                    self.busy_until = now + TFT_BUSY;
                    self.dirty = true;
                }
            }
            0x20 | 0x21 => {
                self.inverted = c == 0x21;
                self.dirty = true;
            }
            0x28 | 0x29 => {
                self.display_on = c == 0x29;
                self.dirty = true;
            }
            0x38 | 0x39 => {
                self.idle = c == 0x39;
                self.dirty = true;
            }
            0x2C => {
                self.writing = true;
                self.col = self.xs;
                self.row = self.ys;
            }
            0x3C if ili => self.writing = true,
            0x2E => {
                self.col = self.xs;
                self.row = self.ys;
                self.read = Read::Ram {
                    first: true,
                    sub: 0,
                    px: 0,
                };
            }
            0x04 => {
                self.read = if ili {
                    dummy_then(&[0x00, 0x00, 0x00])
                } else {
                    dummy_then(&[0x7C, 0x89, 0xF0])
                }
            }
            0x09 => {
                let st = self.status();
                self.read = dummy_then(&st);
            }
            0x0A => self.read = dummy_then(&[self.power_mode()]),
            0x0B => self.read = dummy_then(&[self.madctl]),
            0x0C => self.read = dummy_then(&[self.colmod]),
            0xDA => self.read = dummy_then(&[if ili { 0x00 } else { 0x7C }]),
            0xDB => self.read = dummy_then(&[if ili { 0x00 } else { 0x89 }]),
            0xDC => self.read = dummy_then(&[if ili { 0x00 } else { 0xF0 }]),
            0xD3 if ili => self.read = dummy_then(&[0x00, 0x93, 0x41]),
            _ => self.cmd = Some(c),
        }
    }

    /// RDDPM: booster on, idle, partial, sleep out, normal mode, display on.
    fn power_mode(&self) -> u8 {
        let mut v = 0x08; // normal display mode
        if !self.sleeping {
            v |= 0x80 | 0x10;
        }
        if self.idle {
            v |= 0x40;
        }
        if self.display_on {
            v |= 0x04;
        }
        v
    }

    /// RDDST's four bytes.
    fn status(&self) -> [u8; 4] {
        let m = self.madctl;
        let b0 = (!self.sleeping as u8) << 7 | (m & 0xFC) >> 1;
        let fmt = match self.colmod & 7 {
            3 => 0b011,
            5 => 0b101,
            _ => 0b110,
        };
        let b1 = fmt << 4 | (self.idle as u8) << 3 | (!self.sleeping as u8) << 1 | 1;
        let b2 = (self.inverted as u8) << 5 | (self.display_on as u8) << 2;
        [b0, b1, b2, 0]
    }

    fn read_byte(&mut self) -> u8 {
        match &mut self.read {
            Read::None => 0xFF,
            Read::Bytes(b, i) => {
                let v = b.get(*i).copied().unwrap_or(0x00);
                *i += 1;
                v
            }
            Read::Ram { first: true, .. } => {
                self.read = Read::Ram {
                    first: false,
                    sub: 0,
                    px: 0,
                };
                0x00
            }
            &mut Read::Ram { sub, px, .. } => {
                // Each pixel as three bytes R, G, B (6 bits, left aligned).
                let px = if sub == 0 {
                    self.addr(self.col, self.row).map_or(0, |i| self.mem[i])
                } else {
                    px
                };
                let out = (((px >> (12 - 6 * sub as u32)) & 0x3F) as u8) << 2;
                if sub == 2 {
                    self.advance();
                }
                self.read = Read::Ram {
                    first: false,
                    sub: (sub + 1) % 3,
                    px,
                };
                out
            }
        }
    }

    fn data(&mut self, b: u8) {
        if self.writing {
            self.pixel_byte(b);
            return;
        }
        let Some(cmd) = self.cmd else {
            return;
        };
        self.params.push(b);
        let p = &self.params;
        match (cmd, p.len()) {
            (0x2A, 4) | (0x2B, 4) => {
                let (s, e) = (
                    u16::from_be_bytes([p[0], p[1]]),
                    u16::from_be_bytes([p[2], p[3]]),
                );
                let cols = cmd == 0x2A;
                let (lw, lh) = self.logical_size();
                let limit = if cols { lw } else { lh };
                let name = if cols { "CASET" } else { "RASET" };
                if s > e {
                    self.warn(format!(
                        "{}: {name} start {s} is after its end {e} — the window is unchanged",
                        self.cfg.name()
                    ));
                    return;
                }
                if e >= limit {
                    self.warn(format!(
                        "{}: {name} {s}–{e} goes past the {limit} {} of the memory (MADCTL MV {}) — those pixels are lost",
                        self.cfg.name(),
                        if cols { "columns" } else { "rows" },
                        if self.madctl & MADCTL_MV != 0 { "on" } else { "off" },
                    ));
                }
                if cols {
                    (self.xs, self.xe) = (s, e);
                } else {
                    (self.ys, self.ye) = (s, e);
                }
            }
            (0x36, 1) => {
                let old = self.madctl;
                self.madctl = b;
                if (old ^ b) & MADCTL_BGR != 0 {
                    self.dirty = true;
                }
            }
            (0x3A, 1) => {
                let fmt = b & 7;
                let ok = match self.cfg.model {
                    TftModel::St7735s => matches!(fmt, 3 | 5 | 6),
                    TftModel::Ili9341 => matches!(fmt, 5 | 6),
                };
                if ok {
                    self.colmod = b;
                } else {
                    self.warn(format!(
                        "{}: COLMOD 0x{b:02X} is not a pixel format it has (0x55 = 16-bit, 0x66 = 18-bit{}) — ignored",
                        self.cfg.name(),
                        if self.cfg.model == TftModel::St7735s {
                            ", 0x03 = 12-bit"
                        } else {
                            ""
                        }
                    ));
                }
            }
            _ => {}
        }
    }

    /// Size of the logical address space (columns, rows) under MADCTL.
    fn logical_size(&self) -> (u16, u16) {
        if self.madctl & MADCTL_MV != 0 {
            (self.cfg.mem_h, self.cfg.mem_w)
        } else {
            (self.cfg.mem_w, self.cfg.mem_h)
        }
    }

    /// Memory index of logical address (`c`, `r`) under MADCTL.
    fn addr(&self, c: u16, r: u16) -> Option<usize> {
        let (lw, lh) = self.logical_size();
        if c >= lw || r >= lh {
            return None;
        }
        let m = self.madctl;
        let c = if m & MADCTL_MX != 0 { lw - 1 - c } else { c };
        let r = if m & MADCTL_MY != 0 { lh - 1 - r } else { r };
        let (x, y) = if m & MADCTL_MV != 0 { (r, c) } else { (c, r) };
        Some(y as usize * self.cfg.mem_w as usize + x as usize)
    }

    /// The write pointer moves on: along the row, then to the next row of
    /// the window, back to its start after the last.
    fn advance(&mut self) {
        if self.col >= self.xe {
            self.col = self.xs;
            if self.row >= self.ye {
                self.row = self.ys;
            } else {
                self.row += 1;
            }
        } else {
            self.col += 1;
        }
    }

    fn put(&mut self, v: u32) {
        if let Some(i) = self.addr(self.col, self.row) {
            if self.mem[i] != v {
                self.mem[i] = v;
                self.dirty = true;
            }
        }
        self.advance();
    }

    fn pixel_byte(&mut self, b: u8) {
        self.pix[self.pix_n] = b;
        self.pix_n += 1;
        let six = |v: u8| v as u32 >> 2;
        match self.colmod & 7 {
            5 => {
                if self.pix_n == 2 {
                    self.pix_n = 0;
                    let v = u16::from_be_bytes([self.pix[0], self.pix[1]]) as u32;
                    let (r5, g6, b5) = (v >> 11, v >> 5 & 0x3F, v & 0x1F);
                    // 5-bit red and blue: the MSB doubles as the LSB.
                    let r6 = r5 << 1 | r5 >> 4;
                    let b6 = b5 << 1 | b5 >> 4;
                    self.put(r6 << 12 | g6 << 6 | b6);
                }
            }
            3 => {
                // 12-bit: R1G1 B1R2 G2B2 — two pixels in three bytes.
                if self.pix_n == 3 {
                    self.pix_n = 0;
                    let [a, b, c] = self.pix;
                    let four = |v: u8| (v as u32) << 2 | (v as u32) >> 2;
                    let p1 = four(a >> 4) << 12 | four(a & 15) << 6 | four(b >> 4);
                    let p2 = four(b & 15) << 12 | four(c >> 4) << 6 | four(c & 15);
                    self.put(p1);
                    self.put(p2);
                }
            }
            _ => {
                if self.pix_n == 3 {
                    self.pix_n = 0;
                    let [r, g, b] = self.pix;
                    self.put(six(r) << 12 | six(g) << 6 | six(b));
                }
            }
        }
    }

    /// The pixel in memory at physical column `x`, row `y` (18 bits).
    pub fn mem_at(&self, x: u16, y: u16) -> u32 {
        self.mem[y as usize * self.cfg.mem_w as usize + x as usize]
    }

    /// What the panel shows at screen pixel (`sx`, `sy`) (the module seen
    /// from the front, header at the top) as R, G, B 0–255, before the
    /// backlight: inversion, idle mode and the BGR order applied. Black
    /// while the panel is not lit.
    pub fn screen_rgb(&self, sx: u16, sy: u16) -> [u8; 3] {
        if !self.lit() {
            return [0, 0, 0];
        }
        let c = &self.cfg;
        let (px, py) = match c.mount {
            Mount::Normal => (sx, sy),
            Mount::MirrorX => (c.panel_w - 1 - sx, sy),
            Mount::Rotate180 => (c.panel_w - 1 - sx, c.panel_h - 1 - sy),
        };
        let mut v = self.mem_at(px + c.off_x, py + c.off_y);
        if self.inverted {
            v ^= 0x3FFFF;
        }
        let (mut r, g, mut b) = (v >> 12 & 0x3F, v >> 6 & 0x3F, v & 0x3F);
        if (self.madctl & MADCTL_BGR != 0) != c.panel_bgr {
            std::mem::swap(&mut r, &mut b);
        }
        let ch = |x: u32| {
            if self.idle {
                if x & 0x20 != 0 {
                    255
                } else {
                    0
                }
            } else {
                (x << 2 | x >> 4) as u8
            }
        };
        [ch(r), ch(g), ch(b)]
    }

    /// The panel as RGB565, little-endian, row by row (`panel_w ×
    /// panel_h × 2` bytes): what the page draws. Empty while not lit.
    pub fn screen565(&self) -> Vec<u8> {
        if !self.lit() {
            return Vec::new();
        }
        let (w, h) = (self.cfg.panel_w, self.cfg.panel_h);
        let mut out = Vec::with_capacity(w as usize * h as usize * 2);
        for y in 0..h {
            for x in 0..w {
                let [r, g, b] = self.screen_rgb(x, y);
                let v = (r as u16 >> 3) << 11 | (g as u16 >> 2) << 5 | b as u16 >> 3;
                out.extend_from_slice(&v.to_le_bytes());
            }
        }
        out
    }

    /// MADCTL bits that only change the refresh direction (no effect on the
    /// picture), for completeness of the register view.
    pub fn refresh_bits(&self) -> u8 {
        self.madctl & (MADCTL_ML | MADCTL_MH)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A driver's init: hardware reset, SWRESET, SLPOUT, COLMOD, MADCTL,
    /// DISPON, with the datasheet's waits.
    fn init(t: &mut Tft, colmod: u8, madctl: u8) -> f64 {
        t.reset_pin(0.0, true);
        t.reset_pin(0.001, false);
        let mut now = 0.2;
        t.byte(now, false, 0x01);
        now += 0.15;
        t.byte(now, false, 0x11);
        now += 0.01;
        t.byte(now, false, 0x3A);
        t.byte(now, true, colmod);
        t.byte(now, false, 0x36);
        t.byte(now, true, madctl);
        t.byte(now, false, 0x29);
        now
    }

    fn window(t: &mut Tft, now: f64, x0: u16, y0: u16, x1: u16, y1: u16) {
        t.byte(now, false, 0x2A);
        for b in [x0.to_be_bytes(), x1.to_be_bytes()].concat() {
            t.byte(now, true, b);
        }
        t.byte(now, false, 0x2B);
        for b in [y0.to_be_bytes(), y1.to_be_bytes()].concat() {
            t.byte(now, true, b);
        }
        t.byte(now, false, 0x2C);
    }

    fn fill565(t: &mut Tft, now: f64, n: usize, c: u16) {
        for _ in 0..n {
            t.byte(now, true, (c >> 8) as u8);
            t.byte(now, true, c as u8);
        }
    }

    #[test]
    fn dark_until_slpout_and_dispon() {
        let mut t = Tft::new(TftConfig::st7735("black"));
        t.power_on(0.0);
        assert!(!t.lit());
        assert!(t.screen565().is_empty());
        t.byte(0.2, false, 0x29); // DISPON while asleep
        assert!(!t.lit());
        t.byte(0.3, false, 0x11);
        assert!(t.lit());
        // Never cleared: power-on noise shows.
        let distinct: std::collections::BTreeSet<_> = (0..20).map(|x| t.screen_rgb(x, 0)).collect();
        assert!(distinct.len() > 10);
        t.byte(0.4, false, 0x28);
        assert!(!t.lit());
        t.byte(0.4, false, 0x29);
        t.byte(0.4, false, 0x10);
        assert!(!t.lit());
    }

    #[test]
    fn rgb565_window_fills_and_wraps() {
        let mut t = Tft::new(TftConfig::st7735("black"));
        // MY | MX: the module's "rotation 0", the image upright.
        let now = init(&mut t, 0x05, 0xC0);
        window(&mut t, now, 10, 20, 13, 21); // 4 × 2
        fill565(&mut t, now, 8, 0xF800); // red
        fill565(&mut t, now, 2, 0x001F); // wraps: blue over the first two
        assert_eq!(t.screen_rgb(10, 20), [0, 0, 255]);
        assert_eq!(t.screen_rgb(11, 20), [0, 0, 255]);
        assert_eq!(t.screen_rgb(12, 20), [255, 0, 0]);
        assert_eq!(t.screen_rgb(13, 21), [255, 0, 0]);
        assert_ne!(t.screen_rgb(14, 20), [255, 0, 0]);
        assert_ne!(t.screen_rgb(10, 22), [255, 0, 0]);
        // MADCTL 0: the panel is mounted upside down on the module.
        t.byte(now, false, 0x36);
        t.byte(now, true, 0x00);
        window(&mut t, now, 0, 0, 0, 0);
        fill565(&mut t, now, 1, 0x07E0);
        assert_eq!(t.screen_rgb(127, 159), [0, 255, 0]);
    }

    #[test]
    fn colmod_18_and_12_bit_and_bgr_inversion_idle() {
        let mut t = Tft::new(TftConfig::st7735("red")); // BGR panel
        let now = init(&mut t, 0x06, 0xC8); // 18-bit, MY|MX|BGR
        window(&mut t, now, 0, 0, 1, 0);
        for b in [0xFC, 0x80, 0x00, 0x00, 0x00, 0xFC] {
            t.byte(now, true, b);
        }
        assert_eq!(t.screen_rgb(0, 0), [255, 130, 0]);
        assert_eq!(t.screen_rgb(1, 0), [0, 0, 255]);
        // BGR bit off on a BGR panel: red and blue swap.
        t.byte(now, false, 0x36);
        t.byte(now, true, 0xC0);
        assert_eq!(t.screen_rgb(0, 0), [0, 130, 255]);
        t.byte(now, false, 0x36);
        t.byte(now, true, 0xC8);
        t.byte(now, false, 0x21); // INVON
        assert_eq!(t.screen_rgb(1, 0), [255, 255, 0]);
        t.byte(now, false, 0x20);
        t.byte(now, false, 0x39); // idle: 8 colours
        assert_eq!(t.screen_rgb(0, 0), [255, 255, 0]);
        t.byte(now, false, 0x38);
        // 12-bit: two pixels in three bytes.
        t.byte(now, false, 0x3A);
        t.byte(now, true, 0x03);
        window(&mut t, now, 0, 1, 1, 1);
        for b in [0xF0, 0x00, 0x0F] {
            t.byte(now, true, b);
        }
        assert_eq!(t.screen_rgb(0, 1), [255, 0, 0]);
        assert_eq!(t.screen_rgb(1, 1), [0, 0, 255]);
    }

    #[test]
    fn madctl_mv_rotates_the_address_space() {
        let mut t = Tft::new(TftConfig::ili9341());
        // MV | BGR: landscape, 320 columns.
        let now = init(&mut t, 0x55, 0x28);
        window(&mut t, now, 300, 0, 319, 0);
        fill565(&mut t, now, 20, 0xFFFF);
        assert!(t.warning.is_none(), "{:?}", t.warning);
        // Logical column c → physical row c; mounted mirrored: physical
        // column 0 is the right edge.
        assert_eq!(t.screen_rgb(239, 319), [255, 255, 255]);
        assert_eq!(t.screen_rgb(239, 300), [255, 255, 255]);
        assert_ne!(t.screen_rgb(239, 299), [255, 255, 255]);
        // Past the 240 columns of portrait mode: a warning.
        t.byte(now, false, 0x36);
        t.byte(now, true, 0x48);
        window(&mut t, now, 0, 0, 300, 0);
        assert!(t.warning.take().unwrap().contains("CASET 0–300"));
    }

    #[test]
    fn green_tab_offsets_the_panel_in_its_132x162_memory() {
        let mut t = Tft::new(TftConfig::st7735("green"));
        let now = init(&mut t, 0x05, 0xC8);
        // Drivers add 2 / 1 to their addresses for these panels.
        window(&mut t, now, 2, 1, 2, 1);
        fill565(&mut t, now, 1, 0xF800);
        assert_eq!(t.screen_rgb(0, 0), [255, 0, 0]);
    }

    #[test]
    fn commands_too_soon_after_reset_are_ignored() {
        let mut t = Tft::new(TftConfig::ili9341());
        t.reset_pin(0.0, true);
        t.reset_pin(0.001, false);
        t.byte(0.003, false, 0x11);
        assert!(t.sleeping);
        assert!(t.warning.take().unwrap().contains("5 ms"));
        t.byte(0.05, false, 0x11); // within 120 ms
        assert!(t.sleeping);
        assert!(t.warning.take().unwrap().contains("120 ms"));
        t.byte(0.2, false, 0x11);
        assert!(!t.sleeping);
        t.byte(0.201, false, 0x29); // within 5 ms of SLPOUT
        assert!(!t.display_on);
        t.byte(0.21, false, 0x29);
        assert!(t.lit());
        // RESX low: back to sleep, display off.
        t.reset_pin(0.3, true);
        assert!(!t.lit());
        assert_eq!(t.byte(0.3, false, 0x11), None);
    }

    #[test]
    fn ili9341_reads_ids_status_and_memory() {
        let mut t = Tft::new(TftConfig::ili9341());
        let now = init(&mut t, 0x55, 0x48);
        let read = |t: &mut Tft, cmd: u8, n: usize| -> Vec<u8> {
            t.byte(now, false, cmd);
            (0..n).map(|_| t.byte(now, true, 0).unwrap()).collect()
        };
        assert_eq!(read(&mut t, 0xD3, 4), [0x00, 0x00, 0x93, 0x41]);
        assert_eq!(read(&mut t, 0x0A, 2), [0x00, 0x9C]);
        assert_eq!(read(&mut t, 0x0B, 2), [0x00, 0x48]);
        assert_eq!(read(&mut t, 0x0C, 2), [0x00, 0x55]);
        window(&mut t, now, 5, 5, 6, 5);
        fill565(&mut t, now, 2, 0xF81F);
        window(&mut t, now, 5, 5, 6, 5);
        t.byte(now, false, 0x2E);
        let px: Vec<u8> = (0..7).map(|_| t.byte(now, true, 0).unwrap()).collect();
        assert_eq!(px, [0x00, 0xFC, 0x00, 0xFC, 0xFC, 0x00, 0xFC]);
        // Nothing to read: SDO is not driven.
        t.byte(now, false, 0x00);
        assert_eq!(t.byte(now, true, 0), None);
    }

    #[test]
    fn bit_banged_bytes_take_dc_at_the_eighth_bit() {
        let mut t = Tft::new(TftConfig::st7735("black"));
        t.power_on(0.0);
        let send = |t: &mut Tft, dc: bool, b: u8| {
            for i in (0..8).rev() {
                let bit = b >> i & 1 != 0;
                t.pins(1.0, false, false, bit, dc);
                t.pins(1.0, true, false, bit, dc);
            }
        };
        t.pins(1.0, false, true, false, false);
        send(&mut t, false, 0x11);
        send(&mut t, false, 0x29);
        assert!(!t.lit()); // within 5 ms of SLPOUT (same instant)
        let mut t2 = Tft::new(TftConfig::st7735("black"));
        t2.power_on(0.0);
        t2.pins(1.0, false, true, false, false);
        send(&mut t2, false, 0x11);
        assert!(!t2.sleeping);
        // A partial byte is dropped when CS goes high.
        t2.pins(1.0, false, false, true, false);
        t2.pins(1.0, true, false, true, false);
        t2.pins(1.0, true, true, true, false);
        assert_eq!(t2.bytes, 1);
    }

    #[test]
    fn versions_move_only_with_changes() {
        let mut t = Tft::new(TftConfig::st7735("black"));
        let now = init(&mut t, 0x05, 0xC0);
        let v1 = t.frame_version();
        assert_eq!(t.frame_version(), v1);
        window(&mut t, now, 0, 0, 0, 0);
        fill565(&mut t, now, 1, 0x1234);
        let v2 = t.frame_version();
        assert_ne!(v2, v1);
        // The same pixel again: no change.
        window(&mut t, now, 0, 0, 0, 0);
        fill565(&mut t, now, 1, 0x1234);
        assert_eq!(t.frame_version(), v2);
    }
}

/// The displays wired into a [`crate::sim::CircuitSim`]: hardware SPI
/// bytes, bit-banged GPIO, RESET, the backlight and what reaches the page.
#[cfg(test)]
mod sim_tests {
    use std::collections::HashMap;

    use crate::netlist::{BusCatalog, Circuit, PartInstance, PinRef, Wire};
    use crate::sim::{CircuitSim, Cycles, Drive, TftView, BOARD_KIND};

    /// 16 MHz: the circuit's clock until the board sets one.
    const MS: Cycles = 16_000;

    fn sim(kind: &str, props: &[(&str, &str)], wires: &[(&str, &str)]) -> CircuitSim {
        let parts = vec![
            PartInstance {
                id: "mcu".into(),
                kind: BOARD_KIND.into(),
                props: Default::default(),
            },
            PartInstance {
                id: "tft".into(),
                kind: kind.into(),
                props: props
                    .iter()
                    .map(|(k, v)| (k.to_string(), serde_json::Value::String(v.to_string())))
                    .collect(),
            },
        ];
        let wires = wires
            .iter()
            .map(|(pin, mcu)| Wire {
                a: PinRef::new("tft", *pin),
                b: PinRef::new("mcu", *mcu),
            })
            .collect();
        CircuitSim::new(
            &Circuit { parts, wires },
            &BusCatalog::default(),
            &HashMap::new(),
            0,
        )
    }

    /// The MCU drives `high` pins high, `low` ones low, the rest float.
    fn set(s: &mut CircuitSim, t: Cycles, high: &[(u8, u8)], low: &[(u8, u8)]) {
        let d: Vec<Drive> = s
            .mcu_pins()
            .into_iter()
            .map(|p| {
                if high.contains(&p) {
                    Drive::High
                } else if low.contains(&p) {
                    Drive::Low
                } else {
                    Drive::Float
                }
            })
            .collect();
        s.update(t, &d);
    }

    const SCK: (u8, u8) = (0, 5);
    const MOSI: (u8, u8) = (0, 7);
    const CS: (u8, u8) = (1, 6);
    const DC: (u8, u8) = (0, 9);
    const RES: (u8, u8) = (2, 7);
    const LED: (u8, u8) = (0, 8);

    const ST7735_WIRES: &[(&str, &str)] = &[
        ("VCC", "5V"),
        ("GND", "GND"),
        ("SCK", "PA5"),
        ("SDA", "PA7"),
        ("CS", "PB6"),
        ("A0", "PA9"),
        ("RESET", "PC7"),
        ("LED", "PA8"),
    ];

    fn view(s: &mut CircuitSim, t: Cycles) -> TftView {
        let v = s.end_frame(t, t as f64 / 16e6);
        v.into_iter()
            .find(|v| v.id == "tft")
            .unwrap()
            .tft
            .expect("tft view")
    }

    /// RGB565 of screen pixel (x, y) from the bytes the page gets.
    fn px(bytes: &[u8], w: usize, x: usize, y: usize) -> u16 {
        u16::from_le_bytes([bytes[2 * (y * w + x)], bytes[2 * (y * w + x) + 1]])
    }

    /// Hardware SPI bytes with D/CX (`dc`) on a GPIO, CS low.
    fn send(s: &mut CircuitSim, t: &mut Cycles, dc: bool, bytes: &[u8]) {
        if dc {
            set(s, *t, &[RES, LED, DC], &[CS]);
        } else {
            set(s, *t, &[RES, LED], &[CS, DC]);
        }
        for &b in bytes {
            s.spi(*t, SCK, MOSI, None, b);
            *t += 10;
        }
    }

    #[test]
    fn st7735_on_hardware_spi_shows_a_window_after_its_init() {
        let mut s = sim("tft-st7735", &[], ST7735_WIRES);
        let mut t: Cycles = 0;
        // Hardware reset, CS low, the backlight on.
        set(&mut s, t, &[CS, LED], &[RES]);
        t += MS;
        set(&mut s, t, &[CS, RES, LED], &[]);
        t += 150 * MS;
        assert!(!view(&mut s, t).lit);
        send(&mut s, &mut t, false, &[0x11]); // SLPOUT
        t += 10 * MS;
        for (cmd, args) in [
            (0x3A, &[0x05][..]),
            (0x36, &[0xC0]),
            (0x2A, &[0, 0, 0, 127]),
            (0x2B, &[0, 0, 0, 159]),
            (0x29, &[]),
        ] {
            send(&mut s, &mut t, false, &[cmd]);
            send(&mut s, &mut t, true, args);
        }
        assert!(s.warnings.is_empty(), "{:?}", s.warnings);
        let v = view(&mut s, t);
        assert!(v.lit && v.backlight > 0.99, "{v:?}");
        assert_eq!((v.width, v.height, v.colmod), (128, 160, 0x05));
        // A red window 4..=7 × 10..=11, wrapping: 10 pixels, the last two
        // green over its first two.
        send(&mut s, &mut t, false, &[0x2A]);
        send(&mut s, &mut t, true, &[0, 4, 0, 7]);
        send(&mut s, &mut t, false, &[0x2B]);
        send(&mut s, &mut t, true, &[0, 10, 0, 11]);
        send(&mut s, &mut t, false, &[0x2C]);
        for c in [0xF800u16; 8].into_iter().chain([0x07E0; 2]) {
            send(&mut s, &mut t, true, &c.to_be_bytes());
        }
        let v2 = view(&mut s, t);
        assert_ne!(v2.version, v.version);
        let bytes = s.tft_pixels("tft").unwrap();
        assert_eq!(bytes.len(), 128 * 160 * 2);
        assert_eq!(px(&bytes, 128, 4, 10), 0x07E0);
        assert_eq!(px(&bytes, 128, 6, 10), 0xF800);
        assert_eq!(px(&bytes, 128, 7, 11), 0xF800);
        assert_ne!(px(&bytes, 128, 8, 11), 0xF800);
        // Nothing changed: the same version (the page fetches nothing).
        t += 10;
        assert_eq!(view(&mut s, t).version, v2.version);

        // The backlight follows the LED pin's duty.
        set(&mut s, t, &[RES], &[CS, LED]);
        t += 1000;
        let off = view(&mut s, t);
        set(&mut s, t + 1000, &[RES, LED], &[CS]);
        t += 2000;
        let half = view(&mut s, t);
        assert!(off.backlight < 0.01, "{off:?}");
        assert!((half.backlight - 0.5).abs() < 0.01, "{half:?}");

        // RESET low: the registers go back to sleep in, display off.
        set(&mut s, t, &[LED], &[CS, RES]);
        let v = view(&mut s, t + 10);
        assert!(!v.lit && v.sleeping && !v.display_on);
        assert!(s.tft_pixels("tft").unwrap().is_empty());
    }

    #[test]
    fn ili9341_bit_banged_and_read_back_over_sdo() {
        let wires: &[(&str, &str)] = &[
            ("VCC", "3V3"),
            ("GND", "GND"),
            ("SCK", "PA5"),
            ("SDI", "PA7"),
            ("SDO", "PA6"),
            ("CS", "PB6"),
            ("DC", "PA9"),
            ("RESET", "PC7"),
            ("LED", "3V3"),
        ];
        let mut s = sim("tft-ili9341", &[], wires);
        let mut t: Cycles = 0;
        set(&mut s, t, &[CS, RES], &[SCK]);
        t += 200 * MS;
        // GPIO: SCK and MOSI toggled by the firmware, MSB first.
        let bang = |s: &mut CircuitSim, t: &mut Cycles, dc: bool, bytes: &[u8]| {
            for &b in bytes {
                for i in (0..8).rev() {
                    let mut hi = vec![RES];
                    let mut lo = vec![CS];
                    if dc {
                        hi.push(DC)
                    } else {
                        lo.push(DC)
                    }
                    if b >> i & 1 != 0 {
                        hi.push(MOSI)
                    } else {
                        lo.push(MOSI)
                    }
                    set(s, *t, &hi, &[lo.as_slice(), &[SCK]].concat());
                    set(s, *t + 1, &[hi.as_slice(), &[SCK]].concat(), &lo);
                    *t += 2;
                }
            }
        };
        bang(&mut s, &mut t, false, &[0x11]);
        t += 10 * MS;
        bang(&mut s, &mut t, false, &[0x3A]);
        bang(&mut s, &mut t, true, &[0x55]);
        bang(&mut s, &mut t, false, &[0x36]);
        bang(&mut s, &mut t, true, &[0x48]);
        bang(&mut s, &mut t, false, &[0x29, 0x2A]);
        bang(&mut s, &mut t, true, &[0, 0, 0, 0]);
        bang(&mut s, &mut t, false, &[0x2B]);
        bang(&mut s, &mut t, true, &[0, 0, 0, 0]);
        bang(&mut s, &mut t, false, &[0x2C]);
        bang(&mut s, &mut t, true, &[0x00, 0x1F]);
        assert!(s.warnings.is_empty(), "{:?}", s.warnings);
        let v = view(&mut s, t);
        assert!(v.lit && v.backlight > 0.99, "{v:?}");
        assert_eq!((v.width, v.height, v.madctl), (240, 320, 0x48));
        let bytes = s.tft_pixels("tft").unwrap();
        assert_eq!(px(&bytes, 240, 0, 0), 0x001F); // blue, top left

        // Hardware SPI read of ID4 on SDO (MISO = PA6).
        set(&mut s, t, &[RES], &[CS, DC]);
        s.spi(t, SCK, MOSI, Some((0, 6)), 0xD3);
        set(&mut s, t + 1, &[RES, DC], &[CS]);
        let id: Vec<u8> = (0..4)
            .map(|_| s.spi(t + 2, SCK, MOSI, Some((0, 6)), 0x00))
            .collect();
        assert_eq!(id, [0x00, 0x00, 0x93, 0x41]);
    }

    #[test]
    fn unconnected_reset_and_backlight_are_reported_and_dark() {
        let wires: Vec<(&str, &str)> = ST7735_WIRES
            .iter()
            .copied()
            .filter(|(p, _)| *p != "RESET" && *p != "LED")
            .collect();
        let mut s = sim("tft-st7735", &[("tab", "green")], &wires);
        set(&mut s, 0, &[], &[CS]);
        let v = view(&mut s, 10 * MS);
        assert!(!v.lit && v.backlight == 0.0);
        let w: Vec<&String> = s.warnings.iter().collect();
        assert!(
            w.iter().any(|w| w.contains("RESET is not connected")),
            "{w:?}"
        );
        assert!(w.iter().any(|w| w.contains("LED (backlight)")), "{w:?}");
        // Without VCC nothing works (and nothing is reported as lit).
        let wires: Vec<(&str, &str)> = ST7735_WIRES
            .iter()
            .copied()
            .filter(|(p, _)| *p != "VCC")
            .collect();
        let mut s = sim("tft-st7735", &[], &wires);
        set(&mut s, 0, &[RES, LED], &[CS]);
        let v = s.end_frame(10, 1e-6);
        assert!(v.iter().find(|v| v.id == "tft").unwrap().unpowered);
    }
}
