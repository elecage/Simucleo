//! GPIO ports (RM0368 §8).

use simucleo_core::Cycles;

/// A change of a pin's driven level, for the GUI, waveform view and tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PinEvent {
    pub time: Cycles,
    /// Port index: 0 = A, 1 = B, … 7 = H.
    pub port: u8,
    pub pin: u8,
    /// Driven level, or `None` when the pin stops being an output.
    pub level: Option<bool>,
}

/// How the chip drives a pin, as an external circuit sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PinDrive {
    High,
    Low,
    PullUp,
    PullDown,
    Float,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinMode {
    Input,
    Output,
    Alternate,
    Analog,
}

#[derive(Debug, Clone)]
pub struct Gpio {
    pub port: u8,
    pub moder: u32,
    pub otyper: u32,
    pub ospeedr: u32,
    pub pupdr: u32,
    pub odr: u32,
    pub lckr: u32,
    pub afr: [u32; 2],
    /// Levels applied from outside (buttons, external circuit). Bit n = pin n.
    pub external: u16,
    /// Pins with something driving them from outside; others float.
    pub external_driven: u16,
    /// Levels driven by peripherals on alternate-function pins (timer
    /// outputs); only pins in `af_driven` are driven.
    pub af_out: u16,
    pub af_driven: u16,
}

impl Gpio {
    pub fn new(port: u8) -> Self {
        // Reset values: PA13/PA14/PA15 and PB3/PB4 are debug pins.
        let (moder, ospeedr, pupdr) = match port {
            0 => (0xA800_0000, 0x0C00_0000, 0x6400_0000),
            1 => (0x0000_0280, 0x0000_00C0, 0x0000_0100),
            _ => (0, 0, 0),
        };
        Self {
            port,
            moder,
            otyper: 0,
            ospeedr,
            pupdr,
            odr: 0,
            lckr: 0,
            afr: [0; 2],
            external: 0,
            external_driven: 0,
            af_out: 0,
            af_driven: 0,
        }
    }

    /// Alternate function number selected for `pin` (AFRL/AFRH).
    pub fn af(&self, pin: u8) -> u8 {
        ((self.afr[pin as usize / 8] >> (4 * (pin % 8))) & 0xF) as u8
    }

    pub fn mode(&self, pin: u8) -> PinMode {
        match (self.moder >> (2 * pin)) & 3 {
            0 => PinMode::Input,
            1 => PinMode::Output,
            2 => PinMode::Alternate,
            _ => PinMode::Analog,
        }
    }

    /// Level the MCU drives on `pin`: a GPIO output, or a peripheral
    /// output on an alternate-function pin.
    pub fn driven(&self, pin: u8) -> Option<bool> {
        let high = match self.mode(pin) {
            PinMode::Output => self.odr & (1 << pin) != 0,
            PinMode::Alternate if self.af_driven & (1 << pin) != 0 => self.af_out & (1 << pin) != 0,
            _ => return None,
        };
        // Open-drain outputs only drive low.
        if self.otyper & (1 << pin) != 0 && high {
            return None;
        }
        Some(high)
    }

    /// Electrical drive of `pin`: the output driver if it drives, else the
    /// pull resistor (analog pins have none).
    pub fn drive(&self, pin: u8) -> PinDrive {
        match self.driven(pin) {
            Some(true) => PinDrive::High,
            Some(false) => PinDrive::Low,
            None if self.mode(pin) == PinMode::Analog => PinDrive::Float,
            None => match (self.pupdr >> (2 * pin)) & 3 {
                1 => PinDrive::PullUp,
                2 => PinDrive::PullDown,
                _ => PinDrive::Float,
            },
        }
    }

    /// Level seen on the pin (IDR).
    pub fn level(&self, pin: u8) -> bool {
        if let Some(l) = self.driven(pin) {
            return l;
        }
        if self.external_driven & (1 << pin) != 0 {
            return self.external & (1 << pin) != 0;
        }
        // Floating: follow the pull resistor, default low.
        (self.pupdr >> (2 * pin)) & 3 == 1
    }

    /// Levels of all 16 pins (bit n = pin n), as IDR shows them.
    pub fn levels(&self) -> u16 {
        (0..16)
            .filter(|p| self.level(*p))
            .fold(0, |acc, p| acc | (1 << p))
    }

    fn idr(&self) -> u32 {
        self.levels() as u32
    }

    pub fn read(&self, offset: u32) -> u32 {
        match offset {
            0x00 => self.moder,
            0x04 => self.otyper,
            0x08 => self.ospeedr,
            0x0C => self.pupdr,
            0x10 => self.idr(),
            0x14 => self.odr,
            0x18 => 0, // BSRR is write-only
            0x1C => self.lckr,
            0x20 => self.afr[0],
            0x24 => self.afr[1],
            _ => 0,
        }
    }

    /// Register write; returns pin level changes caused by it.
    pub fn write(
        &mut self,
        offset: u32,
        value: u32,
        lanes: u32,
        time: Cycles,
        events: &mut Vec<PinEvent>,
    ) {
        let before: Vec<Option<bool>> = (0..16).map(|p| self.driven(p)).collect();
        let merge = |old: u32| (old & !lanes) | (value & lanes);
        match offset {
            0x00 => self.moder = merge(self.moder),
            0x04 => self.otyper = merge(self.otyper) & 0xFFFF,
            0x08 => self.ospeedr = merge(self.ospeedr),
            0x0C => self.pupdr = merge(self.pupdr),
            0x14 => self.odr = merge(self.odr) & 0xFFFF,
            0x18 => {
                let v = value & lanes;
                let set = v & 0xFFFF;
                let reset = (v >> 16) & !set;
                self.odr = (self.odr | set) & !reset;
            }
            0x1C => self.lckr = merge(self.lckr),
            0x20 => self.afr[0] = merge(self.afr[0]),
            0x24 => self.afr[1] = merge(self.afr[1]),
            _ => {}
        }
        for (pin, old) in before.into_iter().enumerate() {
            let new = self.driven(pin as u8);
            if new != old {
                events.push(PinEvent {
                    time,
                    port: self.port,
                    pin: pin as u8,
                    level: new,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bsrr_and_events() {
        let mut g = Gpio::new(0);
        let mut ev = Vec::new();
        g.write(0x00, 1 << 10, u32::MAX, 0, &mut ev); // PA5 output
        assert_eq!(
            ev,
            vec![PinEvent {
                time: 0,
                port: 0,
                pin: 5,
                level: Some(false)
            }]
        );
        ev.clear();
        g.write(0x18, 1 << 5, u32::MAX, 7, &mut ev);
        assert_eq!(
            ev,
            vec![PinEvent {
                time: 7,
                port: 0,
                pin: 5,
                level: Some(true)
            }]
        );
        assert_eq!(g.read(0x10) & (1 << 5), 1 << 5);
        ev.clear();
        g.write(0x18, (1 << 21) | (1 << 5), u32::MAX, 8, &mut ev); // set wins
        assert!(ev.is_empty());
        g.write(0x18, 1 << 21, u32::MAX, 9, &mut ev);
        assert_eq!(ev[0].level, Some(false));
    }

    #[test]
    fn inputs_follow_pulls_and_external_levels() {
        let mut g = Gpio::new(2);
        assert!(!g.level(13));
        g.pupdr = 1 << 26; // pull-up on PC13
        assert!(g.level(13));
        g.external_driven = 1 << 13;
        g.external = 0;
        assert!(!g.level(13), "button pressed pulls PC13 low");
    }
}
