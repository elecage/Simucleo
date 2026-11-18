//! External interrupt/event controller (RM0368 §10).
//!
//! Lines 0–15 follow GPIO pins: SYSCFG_EXTICRx chooses which port drives
//! each line, and the bus reports every level change of a pin to
//! [`Exti::edge`]. Lines 16+ (PVD, RTC, USB wake-up) have no source yet but
//! keep their register bits and can be triggered from software.

/// Implemented lines (0–22 on the STM32F401).
const LINES: u32 = 0x007F_FFFF;

/// NVIC interrupt of an EXTI line: EXTI0..4 have their own vectors,
/// 5–9 and 10–15 share one each.
pub fn irq_of_line(line: u8) -> Option<u16> {
    Some(match line {
        0..=4 => 6 + line as u16,
        5..=9 => 23,
        10..=15 => 40,
        16 => 1,  // PVD
        17 => 41, // RTC alarm
        18 => 42, // USB OTG FS wake-up
        21 => 2,  // tamper / timestamp
        22 => 3,  // RTC wake-up
        _ => return None,
    })
}

#[derive(Debug, Clone, Default)]
pub struct Exti {
    pub imr: u32,
    pub emr: u32,
    pub rtsr: u32,
    pub ftsr: u32,
    pub swier: u32,
    pub pr: u32,
    /// A line with its event mask set saw an edge: wakes WFE.
    pub event: bool,
}

impl Exti {
    pub fn read(&self, offset: u32) -> u32 {
        match offset {
            0x00 => self.imr,
            0x04 => self.emr,
            0x08 => self.rtsr,
            0x0C => self.ftsr,
            0x10 => self.swier,
            0x14 => self.pr,
            _ => 0,
        }
    }

    pub fn write(&mut self, offset: u32, value: u32, lanes: u32) {
        let merge = |old: u32| ((old & !lanes) | (value & lanes)) & LINES;
        match offset {
            0x00 => self.imr = merge(self.imr),
            0x04 => self.emr = merge(self.emr),
            0x08 => self.rtsr = merge(self.rtsr),
            0x0C => self.ftsr = merge(self.ftsr),
            0x10 => {
                // Writing 1 where the bit was 0 triggers the line.
                let new = merge(self.swier);
                let rising = new & !self.swier;
                self.swier = new;
                self.trigger(rising);
            }
            0x14 => {
                // rc_w1; clearing PR also clears the software trigger.
                let clear = value & lanes & LINES;
                self.pr &= !clear;
                self.swier &= !clear;
            }
            _ => {}
        }
    }

    fn trigger(&mut self, lines: u32) {
        self.pr |= lines & self.imr;
        if lines & self.emr != 0 {
            self.event = true;
        }
    }

    /// The source of `line` changed level.
    pub fn edge(&mut self, line: u8, rising: bool) {
        let bit = 1 << line;
        let armed = if rising { self.rtsr } else { self.ftsr };
        if armed & bit != 0 {
            self.trigger(bit);
        }
    }

    /// NVIC lines currently requesting an interrupt.
    pub fn irqs(&self) -> impl Iterator<Item = u16> + '_ {
        let pending = self.pr & self.imr;
        (0..23u8)
            .filter(move |l| pending & (1 << l) != 0)
            .filter_map(irq_of_line)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edges_follow_trigger_selection_and_mask() {
        let mut e = Exti::default();
        e.write(0x0C, 1 << 13, u32::MAX); // falling edge on line 13
        e.edge(13, false);
        assert_eq!(e.pr, 0, "masked lines do not become pending");
        e.write(0x00, 1 << 13, u32::MAX);
        e.edge(13, true);
        assert_eq!(e.pr, 0, "rising edge not selected");
        e.edge(13, false);
        assert_eq!(e.pr, 1 << 13);
        assert_eq!(e.irqs().collect::<Vec<_>>(), vec![40]);
        e.write(0x14, 1 << 13, u32::MAX);
        assert_eq!(e.pr, 0);
    }

    #[test]
    fn software_trigger_and_events() {
        let mut e = Exti::default();
        e.write(0x00, 1, u32::MAX);
        e.write(0x10, 1, u32::MAX);
        assert_eq!(e.pr, 1);
        assert_eq!(e.irqs().collect::<Vec<_>>(), vec![6]);
        e.write(0x10, 1, u32::MAX); // already 1: no new trigger
        e.write(0x14, 1, u32::MAX);
        assert_eq!((e.pr, e.swier), (0, 0));
        e.write(0x04, 1 << 5, u32::MAX);
        e.write(0x08, 1 << 5, u32::MAX);
        e.edge(5, true);
        assert!(e.event);
        assert_eq!(e.pr, 0, "event only, no interrupt");
    }
}
