//! ITM and DWT trace (what SWO carries to STM32CubeIDE's SWV views).
//!
//! On the chip the ITM and the DWT turn software writes, data accesses,
//! exceptions and periodic PC samples into packets that leave through the
//! SWO pin; the debugger decodes them. Here the packets are kept as
//! [`TraceEvent`]s (and a PC histogram) for the host to drain, timestamped
//! with the processor cycle counter.
//!
//! The registers are the ones in the Armv7-M architecture (ITM: stimulus
//! ports, TER, TPR, TCR, LAR; DWT: CTRL's PCSAMPLENA/EXCTRCENA/POSTPRESET/
//! CYCTAP and four comparators). They live in the debug power domain: a
//! system reset (`CortexM::reset`) keeps them, as it keeps the debugger's
//! configuration on the chip.

use std::collections::HashMap;

use crate::Cycles;

/// DEMCR.TRCENA: the ITM and DWT work only while it is set.
pub const DEMCR_TRCENA: u32 = 1 << 24;
/// ITM TCR.ITMENA.
pub const TCR_ITMENA: u32 = 1 << 0;
/// DWT CTRL bits.
pub const DWT_CYCCNTENA: u32 = 1 << 0;
pub const DWT_CYCTAP: u32 = 1 << 9;
pub const DWT_PCSAMPLENA: u32 = 1 << 12;
pub const DWT_EXCTRCENA: u32 = 1 << 16;

/// The most events kept between two drains (older ones are dropped and
/// counted in [`Trace::dropped`], as an SWO FIFO overflows).
pub const MAX_EVENTS: usize = 200_000;

/// What happened to an exception (the exception trace packet's function).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExcKind {
    /// The handler started.
    Enter,
    /// The handler finished.
    Exit,
    /// Execution went back to an exception (or Thread mode, 0) it had
    /// preempted.
    Return,
}

/// One trace packet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TraceEvent {
    /// Software wrote `value` (`size` bytes: 1, 2 or 4) to stimulus port
    /// `port`.
    Itm {
        cycle: Cycles,
        port: u8,
        size: u8,
        value: u32,
    },
    /// A DWT comparator matched a data access: the value read or written
    /// (`size` bytes), its address and the PC of the instruction.
    Data {
        cycle: Cycles,
        comparator: u8,
        addr: u32,
        value: u32,
        size: u8,
        write: bool,
        pc: u32,
    },
    /// Exception trace.
    Exception {
        cycle: Cycles,
        number: u16,
        kind: ExcKind,
    },
}

/// A DWT comparator (COMP, MASK, FUNCTION).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Comparator {
    pub comp: u32,
    pub mask: u32,
    pub function: u32,
}

impl Comparator {
    /// Whether an access of `len` bytes at `addr` matches, given its
    /// direction: FUNCTION 0b0001–0b0011 (PC and/or data value on read or
    /// write), 0b1100 (data value on read), 0b1101 (on write), 0b1110/0b1111
    /// (data value and PC on read or write).
    pub fn matches(&self, addr: u32, len: u32, write: bool) -> bool {
        let dir = match self.function & 0xF {
            0b0001..=0b0011 | 0b1110 | 0b1111 => true,
            0b1100 => !write,
            0b1101 => write,
            _ => return false,
        };
        if !dir {
            return false;
        }
        let ignore = if self.mask >= 32 {
            u32::MAX
        } else {
            (1u32 << self.mask) - 1
        };
        // Any byte of the access inside the masked range.
        let lo = self.comp & !ignore;
        let hi = lo | ignore;
        addr <= hi && lo <= addr.wrapping_add(len - 1)
    }
}

/// ITM and DWT trace state.
#[derive(Debug, Clone, Default)]
pub struct Trace {
    /// ITM trace enable register: bit n lets stimulus port n through.
    pub ter: u32,
    pub tpr: u32,
    pub tcr: u32,
    pub comparators: [Comparator; 4],
    /// Packets since the last drain.
    pub events: Vec<TraceEvent>,
    /// Packets dropped because nobody drained them in time.
    pub dropped: u64,
    /// PC samples since the last drain: PC → count. Samples taken while the
    /// core sleeps (WFI/WFE) are counted in `sleep_samples`.
    pub pc_samples: HashMap<u32, u64>,
    pub sleep_samples: u64,
    /// The PC the CPU is executing (set by the CPU before each instruction;
    /// `None` while it sleeps), for PC sampling.
    pub pc: Option<u32>,
    /// Cycle of the next PC sample.
    next_sample: Cycles,
}

impl Trace {
    fn push(&mut self, e: TraceEvent) {
        if self.events.len() >= MAX_EVENTS {
            self.dropped += 1;
        } else {
            self.events.push(e);
        }
    }

    /// Whether stimulus port `port` passes writes on (TRCENA, ITMENA, TER).
    pub fn port_enabled(&self, demcr: u32, port: u32) -> bool {
        demcr & DEMCR_TRCENA != 0
            && self.tcr & TCR_ITMENA != 0
            && self.ter & (1 << (port & 31)) != 0
    }

    /// A write to stimulus port `port`.
    pub fn itm_write(&mut self, demcr: u32, cycle: Cycles, port: u32, size: u8, value: u32) {
        if self.port_enabled(demcr, port) {
            self.push(TraceEvent::Itm {
                cycle,
                port: port as u8,
                size,
                value,
            });
        }
    }

    /// Whether any comparator traces data accesses (the CPU asks before
    /// reporting each one).
    pub fn data_active(&self, demcr: u32) -> bool {
        demcr & DEMCR_TRCENA != 0 && self.comparators.iter().any(|c| c.function & 0xF != 0)
    }

    /// A data access by the instruction at `pc`.
    #[allow(clippy::too_many_arguments)]
    pub fn data_access(
        &mut self,
        demcr: u32,
        cycle: Cycles,
        addr: u32,
        size: u8,
        value: u32,
        write: bool,
        pc: u32,
    ) {
        if demcr & DEMCR_TRCENA == 0 {
            return;
        }
        for i in 0..self.comparators.len() {
            if self.comparators[i].matches(addr, size as u32, write) {
                self.push(TraceEvent::Data {
                    cycle,
                    comparator: i as u8,
                    addr,
                    value,
                    size,
                    write,
                    pc,
                });
            }
        }
    }

    /// Exception trace (DWT CTRL.EXCTRCENA).
    pub fn exception(
        &mut self,
        demcr: u32,
        dwt_ctrl: u32,
        cycle: Cycles,
        number: u16,
        kind: ExcKind,
    ) {
        if demcr & DEMCR_TRCENA != 0 && dwt_ctrl & DWT_EXCTRCENA != 0 {
            self.push(TraceEvent::Exception {
                cycle,
                number,
                kind,
            });
        }
    }

    /// Processor cycles between PC samples: (POSTPRESET + 1) taps of
    /// CYCCNT bit 6 or bit 10 (CYCTAP), as on the chip.
    pub fn sample_period(dwt_ctrl: u32) -> Cycles {
        let tap: Cycles = if dwt_ctrl & DWT_CYCTAP != 0 { 1024 } else { 64 };
        (((dwt_ctrl >> 1) & 0xF) as Cycles + 1) * tap
    }

    /// Time moved from `from` to `to`: take the PC samples due in between.
    pub fn advance(&mut self, demcr: u32, dwt_ctrl: u32, from: Cycles, to: Cycles) {
        let on = demcr & DEMCR_TRCENA != 0
            && dwt_ctrl & DWT_PCSAMPLENA != 0
            && dwt_ctrl & DWT_CYCCNTENA != 0;
        if !on {
            self.next_sample = 0;
            return;
        }
        let period = Self::sample_period(dwt_ctrl);
        if self.next_sample <= from {
            self.next_sample = from + period;
        }
        if to < self.next_sample {
            return;
        }
        let n = (to - self.next_sample) / period + 1;
        self.next_sample += n * period;
        match self.pc {
            Some(pc) => *self.pc_samples.entry(pc).or_insert(0) += n,
            None => self.sleep_samples += n,
        }
    }

    /// Everything since the last drain.
    pub fn drain(&mut self) -> (Vec<TraceEvent>, HashMap<u32, u64>, u64, u64) {
        (
            std::mem::take(&mut self.events),
            std::mem::take(&mut self.pc_samples),
            std::mem::take(&mut self.sleep_samples),
            std::mem::take(&mut self.dropped),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn itm_needs_trcena_itmena_and_ter() {
        let mut t = Trace::default();
        t.itm_write(0, 1, 0, 1, b'A' as u32);
        t.tcr = TCR_ITMENA;
        t.ter = 1;
        t.itm_write(0, 2, 0, 1, b'B' as u32);
        assert!(t.events.is_empty(), "TRCENA clear");
        t.itm_write(DEMCR_TRCENA, 3, 1, 1, b'C' as u32);
        assert!(t.events.is_empty(), "port 1 not in TER");
        t.itm_write(DEMCR_TRCENA, 4, 0, 1, b'D' as u32);
        assert_eq!(
            t.events,
            vec![TraceEvent::Itm {
                cycle: 4,
                port: 0,
                size: 1,
                value: b'D' as u32
            }]
        );
    }

    #[test]
    fn comparator_masks_and_directions() {
        let c = Comparator {
            comp: 0x2000_0010,
            mask: 0,
            function: 0b1101,
        };
        assert!(c.matches(0x2000_0010, 4, true));
        assert!(!c.matches(0x2000_0010, 4, false), "write only");
        assert!(c.matches(0x2000_000E, 4, true), "overlapping word");
        assert!(!c.matches(0x2000_0014, 4, true));
        let m = Comparator {
            comp: 0x2000_0013,
            mask: 3,
            function: 0b0010,
        };
        assert!(m.matches(0x2000_0010, 1, false));
        assert!(m.matches(0x2000_0017, 1, true));
        assert!(!m.matches(0x2000_0018, 1, true));
    }

    #[test]
    fn pc_samples_every_period_including_sleep() {
        let mut t = Trace::default();
        // POSTPRESET 1, CYCTAP 0: every 2 × 64 cycles.
        let ctrl = DWT_CYCCNTENA | DWT_PCSAMPLENA | (1 << 1);
        assert_eq!(Trace::sample_period(ctrl), 128);
        t.pc = Some(0x800_0100);
        t.advance(DEMCR_TRCENA, ctrl, 0, 127);
        assert!(t.pc_samples.is_empty());
        t.advance(DEMCR_TRCENA, ctrl, 127, 128 * 10);
        assert_eq!(t.pc_samples[&0x800_0100], 10);
        t.pc = None;
        t.advance(DEMCR_TRCENA, ctrl, 1280, 1280 + 128 * 5);
        assert_eq!(t.sleep_samples, 5);
        // Off: nothing.
        t.advance(DEMCR_TRCENA, ctrl & !DWT_PCSAMPLENA, 2000, 10_000);
        assert_eq!(t.sleep_samples, 5);
    }

    #[test]
    fn a_full_buffer_drops_and_counts() {
        let mut t = Trace {
            ter: 1,
            tcr: TCR_ITMENA,
            ..Default::default()
        };
        for i in 0..MAX_EVENTS + 3 {
            t.itm_write(DEMCR_TRCENA, i as Cycles, 0, 1, 0);
        }
        let (e, _, _, dropped) = t.drain();
        assert_eq!(e.len(), MAX_EVENTS);
        assert_eq!(dropped, 3);
    }
}
