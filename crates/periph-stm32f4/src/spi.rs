//! SPI1–4 in master mode (RM0368 §20), exchanging whole frames with the
//! devices on the bus.
//!
//! Writing DR moves the frame into the shift register when it is free (TXE
//! stays set, BSY rises) or holds it in the transmit buffer (TXE clear).
//! After 8 or 16 SCK periods the frame received from the selected device
//! lands in DR (RXNE), or sets OVR if the previous one was not read. MODF
//! is raised for the classic mistake of a master with software NSS
//! management and SSI low. Not modelled: slave mode, receive-only and
//! bidirectional modes, CRC, TI frame format, I2S, DMA requests.

use simucleo_core::sched::Scheduler;
use simucleo_core::Cycles;

// CR1
const MSTR: u32 = 1 << 2;
const SPE: u32 = 1 << 6;
const LSBFIRST: u32 = 1 << 7;
const SSI: u32 = 1 << 8;
const SSM: u32 = 1 << 9;
const DFF: u32 = 1 << 11;
// CR2
const ERRIE: u32 = 1 << 5;
const RXNEIE: u32 = 1 << 6;
const TXEIE: u32 = 1 << 7;
// SR
pub const RXNE: u32 = 1 << 0;
pub const TXE: u32 = 1 << 1;
pub const MODF: u32 = 1 << 5;
pub const OVR: u32 = 1 << 6;
pub const BSY: u32 = 1 << 7;

/// Devices on an SPI bus: one byte out on MOSI, one byte in from MISO
/// (0xFF when nobody drives it).
pub trait SpiBus {
    fn exchange(&mut self, out: u8) -> u8;
}

/// Nobody listens; MISO floats high.
pub struct NoDevices;

impl SpiBus for NoDevices {
    fn exchange(&mut self, _out: u8) -> u8 {
        0xFF
    }
}

#[derive(Debug, Clone)]
pub struct Spi {
    pub name: &'static str,
    pub irq: u16,
    pub cr1: u32,
    pub cr2: u32,
    pub sr: u32,
    pub crcpr: u32,
    pub i2scfgr: u32,
    pub i2spr: u32,
    /// Last frame received.
    rx: u16,
    /// Frame waiting in the transmit buffer (TXE clear).
    tx_buf: Option<u16>,
    /// Frame in the shift register.
    shift: Option<u16>,
    /// DR was read while OVR was set (the first half of clearing it).
    ovr_dr_read: bool,
    pub gen: u32,
}

impl Spi {
    pub fn new(name: &'static str, irq: u16) -> Self {
        Self {
            name,
            irq,
            cr1: 0,
            cr2: 0,
            sr: TXE,
            crcpr: 7,
            i2scfgr: 0,
            i2spr: 2,
            rx: 0,
            tx_buf: None,
            shift: None,
            ovr_dr_read: false,
            gen: 0,
        }
    }

    pub fn reset(&mut self) {
        let gen = self.gen.wrapping_add(1);
        *self = Self::new(self.name, self.irq);
        self.gen = gen;
    }

    fn running(&self) -> bool {
        self.cr1 & (SPE | MSTR) == SPE | MSTR
    }

    /// One frame in core cycles: 8 or 16 SCK periods of PCLK / 2^(BR+1).
    pub fn frame_cycles(&self, hclk: u32, pclk: u32) -> Cycles {
        let div = 2u64 << ((self.cr1 >> 3) & 7);
        let bits = if self.cr1 & DFF != 0 { 16 } else { 8 };
        (bits * div * hclk as u64)
            .div_ceil(pclk.max(1) as u64)
            .max(1)
    }

    pub fn irq_line(&self) -> bool {
        (self.cr2 & TXEIE != 0 && self.sr & TXE != 0)
            || (self.cr2 & RXNEIE != 0 && self.sr & RXNE != 0)
            || (self.cr2 & ERRIE != 0 && self.sr & (OVR | MODF) != 0)
    }

    fn start(&mut self, now: Cycles, cycles: Cycles, sched: &mut Scheduler<crate::Event>, idx: u8) {
        if self.shift.is_some() || !self.running() {
            return;
        }
        if let Some(f) = self.tx_buf.take() {
            self.shift = Some(f);
            self.sr |= TXE | BSY;
            self.gen = self.gen.wrapping_add(1);
            sched.schedule_at(now + cycles, crate::Event::Spi { idx, gen: self.gen });
        }
    }

    pub fn read(&mut self, offset: u32) -> u32 {
        match offset {
            0x00 => self.cr1,
            0x04 => self.cr2,
            0x08 => {
                let v = self.sr;
                if self.ovr_dr_read {
                    self.sr &= !OVR;
                    self.ovr_dr_read = false;
                }
                v
            }
            0x0C => {
                self.sr &= !RXNE;
                self.ovr_dr_read = self.sr & OVR != 0;
                self.rx as u32
            }
            0x10 => self.crcpr,
            0x1C => self.i2scfgr,
            0x20 => self.i2spr,
            _ => 0,
        }
    }

    pub fn peek(&self, offset: u32) -> u32 {
        match offset {
            0x08 => self.sr,
            0x0C => self.rx as u32,
            _ => self.clone().read(offset),
        }
    }

    /// `cycles` is the frame time (see [`Spi::frame_cycles`]).
    #[allow(clippy::too_many_arguments)]
    pub fn write(
        &mut self,
        offset: u32,
        value: u32,
        lanes: u32,
        now: Cycles,
        cycles: Cycles,
        sched: &mut Scheduler<crate::Event>,
        idx: u8,
    ) {
        let merge = |old: u32| (old & !lanes) | (value & lanes);
        match offset {
            0x00 => {
                let v = merge(self.cr1) & 0xFFFF;
                self.cr1 = v;
                // Master with software NSS held low: mode fault, the
                // peripheral drops out of master mode.
                if v & (MSTR | SSM) == MSTR | SSM && v & SSI == 0 && v & SPE != 0 {
                    self.sr |= MODF;
                    self.cr1 &= !(MSTR | SPE);
                }
                if self.cr1 & SPE == 0 {
                    // Disabling aborts the frame in progress.
                    self.shift = None;
                    self.sr &= !BSY;
                    self.gen = self.gen.wrapping_add(1);
                }
                self.start(now, cycles, sched, idx);
            }
            0x04 => self.cr2 = merge(self.cr2) & 0xF7,
            0x08 => {
                // CRCERR is the only rc_w0 flag.
                if lanes & 0x10 != 0 && value & 0x10 == 0 {
                    self.sr &= !0x10;
                }
            }
            0x0C => {
                let frame =
                    (value & lanes & if self.cr1 & DFF != 0 { 0xFFFF } else { 0xFF }) as u16;
                self.tx_buf = Some(frame);
                self.sr &= !TXE;
                self.start(now, cycles, sched, idx);
            }
            0x10 => self.crcpr = merge(self.crcpr) & 0xFFFF,
            0x1C => self.i2scfgr = merge(self.i2scfgr) & 0x0FBF,
            0x20 => self.i2spr = merge(self.i2spr) & 0x03FF,
            _ => {}
        }
        // Writing CR1 clears MODF (after the SR read the HAL does).
        if offset == 0x00 && self.cr1 & MSTR != 0 {
            self.sr &= !MODF;
        }
    }

    /// The frame in the shift register has been clocked out.
    pub fn event(
        &mut self,
        now: Cycles,
        cycles: Cycles,
        sched: &mut Scheduler<crate::Event>,
        idx: u8,
        bus: &mut dyn SpiBus,
    ) {
        let Some(out) = self.shift.take() else {
            return;
        };
        let lsb = self.cr1 & LSBFIRST != 0;
        let byte = |b: u8, bus: &mut dyn SpiBus| -> u8 {
            if lsb {
                bus.exchange(b.reverse_bits()).reverse_bits()
            } else {
                bus.exchange(b)
            }
        };
        let rx = if self.cr1 & DFF != 0 {
            if lsb {
                let lo = byte(out as u8, bus) as u16;
                lo | (byte((out >> 8) as u8, bus) as u16) << 8
            } else {
                let hi = byte((out >> 8) as u8, bus) as u16;
                (hi << 8) | byte(out as u8, bus) as u16
            }
        } else {
            byte(out as u8, bus) as u16
        };
        if self.sr & RXNE != 0 {
            self.sr |= OVR;
        } else {
            self.rx = rx;
            self.sr |= RXNE;
        }
        self.sr &= !BSY;
        self.start(now, cycles, sched, idx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Echo(Vec<u8>);
    impl SpiBus for Echo {
        fn exchange(&mut self, out: u8) -> u8 {
            self.0.push(out);
            !out
        }
    }

    fn run(s: &mut Spi, sched: &mut Scheduler<crate::Event>, bus: &mut Echo) {
        while let Some(at) = sched.next_deadline() {
            sched.advance_to(at);
            while let Some((at, ev)) = sched.pop_due() {
                if let crate::Event::Spi { gen, .. } = ev {
                    if gen == s.gen {
                        s.event(at, 16, sched, 0, bus);
                    }
                }
            }
        }
    }

    #[test]
    fn frame_time_follows_the_prescaler() {
        let mut s = Spi::new("SPI1", 35);
        s.cr1 = MSTR | SPE | (2 << 3); // fPCLK/8
        assert_eq!(s.frame_cycles(84_000_000, 84_000_000), 64);
        assert_eq!(s.frame_cycles(84_000_000, 42_000_000), 128);
        s.cr1 |= DFF;
        assert_eq!(s.frame_cycles(84_000_000, 84_000_000), 128);
    }

    #[test]
    fn transmit_buffer_and_overrun() {
        let mut s = Spi::new("SPI1", 35);
        let mut sched = Scheduler::new();
        let mut bus = Echo(Vec::new());
        s.write(0x00, MSTR | SPE | SSM | SSI, 0xFFFF, 0, 16, &mut sched, 0);
        assert_eq!(s.sr & MODF, 0);
        s.write(0x0C, 0x12, 0xFF, 0, 16, &mut sched, 0);
        assert_eq!(s.sr & (TXE | BSY), TXE | BSY, "straight into the shifter");
        s.write(0x0C, 0x34, 0xFF, 0, 16, &mut sched, 0);
        assert_eq!(s.sr & TXE, 0, "buffered");
        run(&mut s, &mut sched, &mut bus);
        assert_eq!(bus.0, [0x12, 0x34]);
        assert_eq!(
            s.sr & (RXNE | OVR | BSY),
            RXNE | OVR,
            "second frame overran"
        );
        assert_eq!(s.read(0x0C), 0xED);
        s.read(0x08);
        assert_eq!(s.sr & (RXNE | OVR), 0, "DR then SR clears OVR");
    }

    #[test]
    fn software_nss_low_is_a_mode_fault() {
        let mut s = Spi::new("SPI1", 35);
        let mut sched = Scheduler::new();
        s.write(0x00, MSTR | SPE | SSM, 0xFFFF, 0, 16, &mut sched, 0);
        assert_ne!(s.sr & MODF, 0);
        assert_eq!(s.cr1 & (MSTR | SPE), 0);
    }

    #[test]
    fn lsb_first_and_16_bit_frames() {
        let mut s = Spi::new("SPI2", 36);
        let mut sched = Scheduler::new();
        let mut bus = Echo(Vec::new());
        s.write(
            0x00,
            MSTR | SPE | SSM | SSI | DFF,
            0xFFFF,
            0,
            16,
            &mut sched,
            0,
        );
        s.write(0x0C, 0xA001, 0xFFFF, 0, 16, &mut sched, 0);
        run(&mut s, &mut sched, &mut bus);
        assert_eq!(bus.0, [0xA0, 0x01]);
        assert_eq!(s.read(0x0C), 0x5FFE);
        s.write(
            0x00,
            MSTR | SPE | SSM | SSI | LSBFIRST,
            0xFFFF,
            0,
            16,
            &mut sched,
            0,
        );
        s.write(0x0C, 0x01, 0xFF, 0, 16, &mut sched, 0);
        run(&mut s, &mut sched, &mut bus);
        assert_eq!(bus.0[2], 0x80, "bit 0 goes first");
    }
}
