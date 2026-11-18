//! DMA1/DMA2 (RM0368 §9): eight streams each, a channel selector per
//! stream routing one peripheral request to it.
//!
//! The controller only keeps registers and stream state; the bus moves the
//! data (through the same register paths the CPU uses, so reading a
//! peripheral's DR has its usual side effects) whenever a stream's request
//! is active. Transfers take no time. Modelled: peripheral-to-memory,
//! memory-to-peripheral and memory-to-memory, increments, data sizes,
//! circular and double-buffer modes, half/complete flags and interrupts,
//! disabling a stream mid-transfer. FIFO mode is treated as direct mode
//! (the peripheral size sets the item; the memory side is a byte stream).
//! Not modelled: bursts, priorities between simultaneous requests beyond
//! stream order, bus errors (an unmapped address gives TEIF).

// SxCR
pub const EN: u32 = 1 << 0;
const DMEIE: u32 = 1 << 1;
const TEIE: u32 = 1 << 2;
const HTIE: u32 = 1 << 3;
const TCIE: u32 = 1 << 4;
const CIRC: u32 = 1 << 8;
const PINC: u32 = 1 << 9;
const MINC: u32 = 1 << 10;
const DBM: u32 = 1 << 18;
const CT: u32 = 1 << 19;
// Stream flags (shifted per stream in LISR/HISR)
pub const FEIF: u32 = 1 << 0;
pub const DMEIF: u32 = 1 << 2;
pub const TEIF: u32 = 1 << 3;
pub const HTIF: u32 = 1 << 4;
pub const TCIF: u32 = 1 << 5;
// SxFCR
const FEIE: u32 = 1 << 7;

/// Bit offset of a stream's flags in LISR/HISR.
const FLAG_SHIFT: [u32; 4] = [0, 6, 16, 22];

/// A peripheral DMA request line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Request {
    UsartTx(u8),
    UsartRx(u8),
    SpiTx(u8),
    SpiRx(u8),
    Adc1,
    /// Timer index in [`crate::timer::TIMERS`], update event.
    TimUp(u8),
    /// Timer index and channel 0–3.
    TimCh(u8, u8),
}

use Request::*;

/// (stream, channel) → request, DMA1 (RM0368 table 28). USART index 0 =
/// USART1, 1 = USART2, 2 = USART6; SPI index 0 = SPI1 …; timer index as
/// in [`crate::timer::TIMERS`] (0 TIM1, 1 TIM2, 2 TIM3, 3 TIM4, 4 TIM5).
const DMA1_MAP: &[(u8, u8, Request)] = &[
    (0, 0, SpiRx(2)),
    (2, 0, SpiRx(2)),
    (3, 0, SpiRx(1)),
    (4, 0, SpiTx(1)),
    (5, 0, SpiTx(2)),
    (7, 0, SpiTx(2)),
    (0, 2, TimCh(3, 0)),
    (3, 2, TimCh(3, 1)),
    (6, 2, TimUp(3)),
    (7, 2, TimCh(3, 2)),
    (1, 3, TimUp(1)),
    (5, 3, TimCh(1, 0)),
    (6, 3, TimCh(1, 1)),
    (7, 3, TimCh(1, 3)),
    (5, 4, UsartRx(1)),
    (6, 4, UsartTx(1)),
    (2, 5, TimUp(2)),
    (4, 5, TimCh(2, 0)),
    (5, 5, TimCh(2, 1)),
    (7, 5, TimCh(2, 2)),
    (2, 5, TimCh(2, 3)),
    (0, 6, TimCh(4, 2)),
    (0, 6, TimUp(4)),
    (1, 6, TimCh(4, 3)),
    (2, 6, TimCh(4, 0)),
    (3, 6, TimCh(4, 3)),
    (4, 6, TimCh(4, 1)),
    (6, 6, TimUp(4)),
];

/// DMA2 (RM0368 table 29).
const DMA2_MAP: &[(u8, u8, Request)] = &[
    (0, 0, Adc1),
    (4, 0, Adc1),
    (0, 3, SpiRx(0)),
    (2, 3, SpiRx(0)),
    (3, 3, SpiTx(0)),
    (5, 3, SpiTx(0)),
    (0, 4, SpiRx(3)),
    (1, 4, SpiTx(3)),
    (2, 4, UsartRx(0)),
    (5, 4, UsartRx(0)),
    (7, 4, UsartTx(0)),
    (1, 5, UsartRx(2)),
    (2, 5, UsartRx(2)),
    (3, 5, SpiRx(3)),
    (4, 5, SpiTx(3)),
    (6, 5, UsartTx(2)),
    (7, 5, UsartTx(2)),
    (1, 6, TimCh(0, 0)),
    (2, 6, TimCh(0, 1)),
    (3, 6, TimCh(0, 0)),
    (4, 6, TimCh(0, 3)),
    (5, 6, TimUp(0)),
    (6, 6, TimCh(0, 2)),
];

#[derive(Debug, Clone, Default)]
pub struct Stream {
    pub cr: u32,
    pub ndtr: u32,
    pub par: u32,
    pub m0ar: u32,
    pub m1ar: u32,
    pub fcr: u32,
    /// Items at the start of the block (for HT and circular reload).
    total: u32,
    /// Current peripheral and memory pointers.
    pub pa: u32,
    pub ma: u32,
}

impl Stream {
    pub fn enabled(&self) -> bool {
        self.cr & EN != 0
    }

    pub fn channel(&self) -> u8 {
        ((self.cr >> 25) & 7) as u8
    }

    /// 0 peripheral → memory, 1 memory → peripheral, 2 memory → memory.
    pub fn dir(&self) -> u32 {
        (self.cr >> 6) & 3
    }

    /// Bytes per item (PSIZE).
    pub fn item(&self) -> u32 {
        1 << ((self.cr >> 11) & 3).min(2)
    }

    fn memory_base(&self) -> u32 {
        if self.cr & DBM != 0 && self.cr & CT != 0 {
            self.m1ar
        } else {
            self.m0ar
        }
    }
}

/// One item to move: source and destination addresses and the size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Transfer {
    pub src: u32,
    pub dst: u32,
    pub bytes: u32,
}

#[derive(Debug, Clone)]
pub struct Dma {
    /// 0 = DMA1, 1 = DMA2.
    pub index: u8,
    pub streams: [Stream; 8],
    /// LISR (streams 0–3) and HISR (4–7).
    pub isr: [u32; 2],
}

impl Dma {
    pub fn new(index: u8) -> Self {
        let mut d = Self {
            index,
            streams: Default::default(),
            isr: [0; 2],
        };
        for s in &mut d.streams {
            s.fcr = 0x21;
        }
        d
    }

    pub fn reset(&mut self) {
        *self = Self::new(self.index);
    }

    pub fn irqs(&self) -> [u16; 8] {
        if self.index == 0 {
            [11, 12, 13, 14, 15, 16, 17, 47]
        } else {
            [56, 57, 58, 59, 60, 68, 69, 70]
        }
    }

    /// The requests a stream's channel selects (some channels OR two
    /// requests, e.g. TIM3_CH4/TIM3_UP).
    pub fn requests(&self, stream: usize) -> Vec<Request> {
        let map = if self.index == 0 { DMA1_MAP } else { DMA2_MAP };
        let ch = self.streams[stream].channel();
        map.iter()
            .filter(|&&(s, c, _)| s as usize == stream && c == ch)
            .map(|&(_, _, r)| r)
            .collect()
    }

    pub fn flags(&self, stream: usize) -> u32 {
        (self.isr[stream / 4] >> FLAG_SHIFT[stream % 4]) & 0x3D
    }

    fn set_flags(&mut self, stream: usize, f: u32) {
        self.isr[stream / 4] |= f << FLAG_SHIFT[stream % 4];
    }

    /// Interrupt request line of each stream.
    pub fn irq_lines(&self) -> [bool; 8] {
        std::array::from_fn(|i| {
            let s = &self.streams[i];
            let f = self.flags(i);
            (f & TCIF != 0 && s.cr & TCIE != 0)
                || (f & HTIF != 0 && s.cr & HTIE != 0)
                || (f & TEIF != 0 && s.cr & TEIE != 0)
                || (f & DMEIF != 0 && s.cr & DMEIE != 0)
                || (f & FEIF != 0 && s.fcr & FEIE != 0)
        })
    }

    pub fn read(&self, offset: u32) -> u32 {
        match offset {
            0x00 => self.isr[0],
            0x04 => self.isr[1],
            0x08 | 0x0C => 0,
            0x10..=0xCF => {
                let s = &self.streams[((offset - 0x10) / 0x18) as usize];
                match (offset - 0x10) % 0x18 {
                    0x00 => s.cr,
                    0x04 => s.ndtr,
                    0x08 => s.par,
                    0x0C => s.m0ar,
                    0x10 => s.m1ar,
                    // FS: FIFO empty (direct transfers keep nothing).
                    _ => (s.fcr & !0x38) | 0x20,
                }
            }
            _ => 0,
        }
    }

    pub fn write(&mut self, offset: u32, value: u32, lanes: u32) {
        let merge = |old: u32| (old & !lanes) | (value & lanes);
        match offset {
            0x08 | 0x0C => {
                // Write 1 to clear.
                self.isr[((offset - 0x08) / 4) as usize] &= !(value & lanes & 0x0F7D_0F7D);
            }
            0x10..=0xCF => {
                let i = ((offset - 0x10) / 0x18) as usize;
                let s = &mut self.streams[i];
                let reg = (offset - 0x10) % 0x18;
                if reg == 0 {
                    let v = merge(s.cr) & 0x0FEF_FFFF;
                    if s.enabled() {
                        // While enabled only EN (and CT in double buffer
                        // mode) can change.
                        if v & EN == 0 {
                            s.cr &= !EN;
                            if s.ndtr != 0 {
                                // Stopped by software: TCIF signals it.
                                self.set_flags(i, TCIF);
                            }
                        }
                        return;
                    }
                    s.cr = v;
                    if v & EN != 0 {
                        s.total = s.ndtr;
                        s.pa = s.par;
                        s.ma = s.memory_base();
                        if s.ndtr == 0 {
                            s.cr &= !EN;
                        }
                    }
                    return;
                }
                if s.enabled() {
                    // Registers are locked while the stream runs (except
                    // the idle memory address in double buffer mode).
                    if reg == 0x0C && s.cr & CT != 0 {
                        s.m0ar = merge(s.m0ar);
                    } else if reg == 0x10 && s.cr & CT == 0 {
                        s.m1ar = merge(s.m1ar);
                    }
                    return;
                }
                match reg {
                    0x04 => s.ndtr = merge(s.ndtr) & 0xFFFF,
                    0x08 => s.par = merge(s.par),
                    0x0C => s.m0ar = merge(s.m0ar),
                    0x10 => s.m1ar = merge(s.m1ar),
                    0x14 => s.fcr = (merge(s.fcr) & 0x87) | (s.fcr & 0x38),
                    _ => {}
                }
            }
            _ => {}
        }
    }

    /// The next item stream `i` would move.
    pub fn next_transfer(&self, i: usize) -> Transfer {
        let s = &self.streams[i];
        let bytes = s.item();
        match s.dir() {
            0 => Transfer {
                src: s.pa,
                dst: s.ma,
                bytes,
            },
            // Memory to memory: PAR is the source.
            2 => Transfer {
                src: s.pa,
                dst: s.ma,
                bytes,
            },
            _ => Transfer {
                src: s.ma,
                dst: s.pa,
                bytes,
            },
        }
    }

    /// Account for one item moved (`ok`: no bus error).
    pub fn advance(&mut self, i: usize, ok: bool) {
        if !ok {
            self.streams[i].cr &= !EN;
            self.set_flags(i, TEIF);
            return;
        }
        let s = &mut self.streams[i];
        let bytes = s.item();
        if s.cr & PINC != 0 {
            s.pa = s.pa.wrapping_add(bytes);
        }
        if s.cr & MINC != 0 {
            s.ma = s.ma.wrapping_add(bytes);
        }
        s.ndtr -= 1;
        let mut flags = 0;
        if s.ndtr == s.total / 2 && s.total > 1 {
            flags |= HTIF;
        }
        if s.ndtr == 0 {
            flags |= TCIF;
            if s.cr & (CIRC | DBM) != 0 {
                s.ndtr = s.total;
                if s.cr & DBM != 0 {
                    s.cr ^= CT;
                }
                s.pa = s.par;
                s.ma = s.memory_base();
            } else {
                s.cr &= !EN;
            }
        }
        self.set_flags(i, flags);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const W: u32 = u32::MAX;

    fn stream_reg(i: u32, r: u32) -> u32 {
        0x10 + 0x18 * i + r
    }

    #[test]
    fn memory_to_peripheral_with_half_and_complete_flags() {
        let mut d = Dma::new(0);
        // DMA1 stream 6 channel 4 = USART2_TX.
        d.write(stream_reg(6, 0x04), 4, W);
        d.write(stream_reg(6, 0x08), 0x4000_4404, W);
        d.write(stream_reg(6, 0x0C), 0x2000_0100, W);
        let cr = (4 << 25) | MINC | (1 << 6) | TCIE | EN;
        d.write(stream_reg(6, 0x00), cr, W);
        assert_eq!(d.requests(6), [UsartTx(1)]);
        let mut seen = Vec::new();
        while d.streams[6].enabled() {
            let t = d.next_transfer(6);
            seen.push((t.src, t.dst));
            d.advance(6, true);
        }
        assert_eq!(seen[3], (0x2000_0103, 0x4000_4404));
        assert_eq!(d.flags(6) & (HTIF | TCIF), HTIF | TCIF);
        assert!(d.irq_lines()[6]);
        // Clear through HIFCR (stream 6 = shift 16).
        d.write(0x0C, (TCIF | HTIF) << 16, W);
        assert_eq!(d.flags(6), 0);
        assert!(!d.irq_lines()[6]);
    }

    #[test]
    fn circular_and_double_buffer_reload() {
        let mut d = Dma::new(1);
        d.write(stream_reg(0, 0x04), 2, W);
        d.write(stream_reg(0, 0x08), 0x4001_204C, W);
        d.write(stream_reg(0, 0x0C), 0x2000_0000, W);
        d.write(stream_reg(0, 0x10), 0x2000_1000, W);
        // ADC1, 16-bit items, double buffer.
        d.write(
            stream_reg(0, 0x00),
            (1 << 11) | (1 << 13) | MINC | DBM | EN,
            W,
        );
        assert_eq!(d.requests(0), [Adc1]);
        let dsts: Vec<u32> = (0..6)
            .map(|_| {
                let t = d.next_transfer(0);
                d.advance(0, true);
                t.dst
            })
            .collect();
        assert_eq!(
            dsts,
            [
                0x2000_0000,
                0x2000_0002,
                0x2000_1000,
                0x2000_1002,
                0x2000_0000,
                0x2000_0002
            ]
        );
        assert!(d.streams[0].enabled());
        // Software disable mid-block sets TCIF.
        d.write(0x08, W, W);
        d.advance(0, true);
        d.write(stream_reg(0, 0x00), 0, W);
        assert!(!d.streams[0].enabled());
        assert_ne!(d.flags(0) & TCIF, 0);
    }
}
