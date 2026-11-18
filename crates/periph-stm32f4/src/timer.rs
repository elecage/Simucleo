//! General-purpose and advanced-control timers (RM0368 §12–§16).
//!
//! The counter is not ticked: it is computed from the core cycle count
//! (`cnt` is valid at `ref_cycle`, a counter tick boundary) and brought up
//! to date ([`Timer::sync`]) before every register access and at scheduled
//! events. Events are scheduled only for what someone can observe: an
//! update interrupt, a compare-match interrupt, an edge on an enabled
//! output, or a preload that takes effect at the next update. Flags that
//! firmware merely polls (UIF, CCxIF) are computed on access.
//!
//! Modelled: up/down counting, prescaler and auto-reload with preload,
//! one-pulse mode, UG/CCxG, update and compare interrupts, output compare
//! (frozen, active/inactive/toggle on match, force) and PWM modes 1/2 with
//! polarity, BDTR.MOE on TIM1, and DMA requests on update and compare events
//! (CCDS). Not yet: center-aligned counting (counts up), the repetition
//! counter, slave modes other than reset and encoder, and complementary
//! outputs.
//! Input capture (direct/indirect TI mapping, edge polarity, prescaler,
//! overcapture) and the reset slave mode take pin edges from the bus.

use simucleo_core::Cycles;

// CR1
const CEN: u32 = 1 << 0;
const UDIS: u32 = 1 << 1;
const URS: u32 = 1 << 2;
const OPM: u32 = 1 << 3;
const DIR: u32 = 1 << 4;
const ARPE: u32 = 1 << 7;
// SR / DIER
pub const UIF: u32 = 1 << 0;
const CC_IF: [u32; 4] = [1 << 1, 1 << 2, 1 << 3, 1 << 4];
const CC_OF: [u32; 4] = [1 << 9, 1 << 10, 1 << 11, 1 << 12];
// DIER DMA enables
const UDE: u32 = 1 << 8;
const CC_DE: [u32; 4] = [1 << 9, 1 << 10, 1 << 11, 1 << 12];
// CR2
const CCDS: u32 = 1 << 3;
// BDTR
const MOE: u32 = 1 << 15;

/// Static description of a timer instance.
#[derive(Debug, Clone, Copy)]
pub struct TimerInfo {
    pub name: &'static str,
    pub base: u32,
    pub bits32: bool,
    pub channels: u8,
    pub advanced: bool,
    /// Clocked from APB2 (else APB1).
    pub apb2: bool,
    /// Enable bit in RCC.APB1ENR / APB2ENR.
    pub enable_bit: u32,
    pub enable_name: &'static str,
    /// Update interrupt; for TIM1 also the compare interrupt below.
    pub irq_update: u16,
    pub irq_cc: u16,
}

pub const TIMERS: [TimerInfo; 8] = [
    TimerInfo {
        name: "TIM1",
        base: 0x4001_0000,
        bits32: false,
        channels: 4,
        advanced: true,
        apb2: true,
        enable_bit: 0,
        enable_name: "RCC.APB2ENR.TIM1EN",
        irq_update: 25,
        irq_cc: 27,
    },
    TimerInfo {
        name: "TIM2",
        base: 0x4000_0000,
        bits32: true,
        channels: 4,
        advanced: false,
        apb2: false,
        enable_bit: 0,
        enable_name: "RCC.APB1ENR.TIM2EN",
        irq_update: 28,
        irq_cc: 28,
    },
    TimerInfo {
        name: "TIM3",
        base: 0x4000_0400,
        bits32: false,
        channels: 4,
        advanced: false,
        apb2: false,
        enable_bit: 1,
        enable_name: "RCC.APB1ENR.TIM3EN",
        irq_update: 29,
        irq_cc: 29,
    },
    TimerInfo {
        name: "TIM4",
        base: 0x4000_0800,
        bits32: false,
        channels: 4,
        advanced: false,
        apb2: false,
        enable_bit: 2,
        enable_name: "RCC.APB1ENR.TIM4EN",
        irq_update: 30,
        irq_cc: 30,
    },
    TimerInfo {
        name: "TIM5",
        base: 0x4000_0C00,
        bits32: true,
        channels: 4,
        advanced: false,
        apb2: false,
        enable_bit: 3,
        enable_name: "RCC.APB1ENR.TIM5EN",
        irq_update: 50,
        irq_cc: 50,
    },
    TimerInfo {
        name: "TIM9",
        base: 0x4001_4000,
        bits32: false,
        channels: 2,
        advanced: false,
        apb2: true,
        enable_bit: 16,
        enable_name: "RCC.APB2ENR.TIM9EN",
        irq_update: 24,
        irq_cc: 24,
    },
    TimerInfo {
        name: "TIM10",
        base: 0x4001_4400,
        bits32: false,
        channels: 1,
        advanced: false,
        apb2: true,
        enable_bit: 17,
        enable_name: "RCC.APB2ENR.TIM10EN",
        irq_update: 25,
        irq_cc: 25,
    },
    TimerInfo {
        name: "TIM11",
        base: 0x4001_4800,
        bits32: false,
        channels: 1,
        advanced: false,
        apb2: true,
        enable_bit: 18,
        enable_name: "RCC.APB2ENR.TIM11EN",
        irq_update: 26,
        irq_cc: 26,
    },
];

/// Timer channel outputs on pins: (port, pin, alternate function, timer
/// index in [`TIMERS`], channel 0–3). STM32F401RE LQFP64, datasheet table 9.
pub const PIN_MAP: &[(u8, u8, u8, u8, u8)] = &[
    // TIM1 (AF1)
    (0, 8, 1, 0, 0),
    (0, 9, 1, 0, 1),
    (0, 10, 1, 0, 2),
    (0, 11, 1, 0, 3),
    // TIM2 (AF1)
    (0, 0, 1, 1, 0),
    (0, 5, 1, 1, 0),
    (0, 15, 1, 1, 0),
    (0, 1, 1, 1, 1),
    (1, 3, 1, 1, 1),
    (0, 2, 1, 1, 2),
    (1, 10, 1, 1, 2),
    (0, 3, 1, 1, 3),
    // TIM3 (AF2)
    (0, 6, 2, 2, 0),
    (1, 4, 2, 2, 0),
    (2, 6, 2, 2, 0),
    (0, 7, 2, 2, 1),
    (1, 5, 2, 2, 1),
    (2, 7, 2, 2, 1),
    (1, 0, 2, 2, 2),
    (2, 8, 2, 2, 2),
    (1, 1, 2, 2, 3),
    (2, 9, 2, 2, 3),
    // TIM4 (AF2)
    (1, 6, 2, 3, 0),
    (1, 7, 2, 3, 1),
    (1, 8, 2, 3, 2),
    (1, 9, 2, 3, 3),
    // TIM5 (AF2)
    (0, 0, 2, 4, 0),
    (0, 1, 2, 4, 1),
    (0, 2, 2, 4, 2),
    (0, 3, 2, 4, 3),
    // TIM9 (AF3)
    (0, 2, 3, 5, 0),
    (0, 3, 3, 5, 1),
    // TIM10, TIM11 (AF3)
    (1, 8, 3, 6, 0),
    (1, 9, 3, 7, 0),
];

#[derive(Debug, Clone)]
pub struct Timer {
    pub info: TimerInfo,
    pub cr1: u32,
    pub cr2: u32,
    pub smcr: u32,
    pub dier: u32,
    pub sr: u32,
    pub ccmr: [u32; 2],
    pub ccer: u32,
    pub psc: u32,
    pub arr: u32,
    pub rcr: u32,
    pub ccr: [u32; 4],
    pub bdtr: u32,
    pub dcr: u32,
    pub or: u32,
    // Shadow (active) registers.
    psc_act: u32,
    arr_act: u32,
    ccr_act: [u32; 4],
    /// Counter value at `ref_cycle`.
    cnt: u32,
    ref_cycle: Cycles,
    /// Core cycles per timer kernel clock cycle (HCLK / TIMxCLK).
    clk_div: u64,
    /// OCxREF of the stateful output-compare modes.
    ocref: [bool; 4],
    /// Bumped whenever the schedule is recomputed; stale events are ignored.
    pub gen: u32,
    /// The bus clock (RCC TIMxEN) is off: the counter and outputs freeze.
    pub gated: bool,
    /// Pending DMA requests: bit 0 update, bits 1–4 capture/compare 1–4.
    pub dma_req: u32,
    /// Input-capture edges counted per channel (for ICxPSC).
    ic_count: [u32; 4],
}

impl Timer {
    pub fn new(info: TimerInfo) -> Self {
        let arr = if info.bits32 { u32::MAX } else { 0xFFFF };
        Self {
            info,
            cr1: 0,
            cr2: 0,
            smcr: 0,
            dier: 0,
            sr: 0,
            ccmr: [0; 2],
            ccer: 0,
            psc: 0,
            arr,
            rcr: 0,
            ccr: [0; 4],
            bdtr: 0,
            dcr: 0,
            or: 0,
            psc_act: 0,
            arr_act: arr,
            ccr_act: [0; 4],
            cnt: 0,
            ref_cycle: 0,
            clk_div: 1,
            ocref: [false; 4],
            gen: 0,
            gated: false,
            dma_req: 0,
            ic_count: [0; 4],
        }
    }

    /// Peripheral reset, keeping the clock relation.
    pub fn reset(&mut self, now: Cycles) {
        let (clk_div, gen, gated) = (self.clk_div, self.gen + 1, self.gated);
        *self = Self::new(self.info);
        self.clk_div = clk_div;
        self.gen = gen;
        self.gated = gated;
        self.ref_cycle = now;
    }

    fn max(&self) -> u32 {
        if self.info.bits32 {
            u32::MAX
        } else {
            0xFFFF
        }
    }

    pub fn running(&self) -> bool {
        self.cr1 & CEN != 0
    }

    fn down(&self) -> bool {
        self.cr1 & DIR != 0
    }

    fn tick(&self) -> Cycles {
        (self.psc_act as u64 + 1) * self.clk_div
    }

    /// Output compare mode of a channel (OCxM), or `None` if the channel is
    /// configured as an input.
    fn oc_mode(&self, ch: usize) -> Option<u32> {
        let r = self.ccmr[ch / 2] >> (8 * (ch % 2));
        (r & 3 == 0).then_some((r >> 4) & 7)
    }

    fn preload(&self, ch: usize) -> bool {
        self.ccmr[ch / 2] >> (8 * (ch % 2)) & (1 << 3) != 0
    }

    /// Ticks until the counter wraps (the next update event).
    fn ticks_to_wrap(&self) -> u64 {
        if self.down() {
            self.cnt as u64 + 1
        } else if self.cnt <= self.arr_act {
            (self.arr_act - self.cnt) as u64 + 1
        } else {
            (self.max() - self.cnt) as u64 + 1
        }
    }

    /// Ticks until the counter next takes the value `v`.
    fn ticks_to_value(&self, v: u32) -> Option<u64> {
        if v > self.arr_act {
            return None;
        }
        let wrap = self.ticks_to_wrap();
        Some(if self.down() {
            if v < self.cnt {
                (self.cnt - v) as u64
            } else {
                wrap + (self.arr_act - v) as u64
            }
        } else if v > self.cnt {
            (v - self.cnt) as u64
        } else {
            wrap + v as u64
        })
    }

    /// The counter took the value of CCRx: set CCxIF and update the
    /// stateful output-compare references.
    fn compare_match(&mut self, ch: usize, times: u64) {
        let Some(mode) = self.oc_mode(ch) else {
            return;
        };
        self.sr |= CC_IF[ch];
        if self.dier & CC_DE[ch] != 0 && self.cr2 & CCDS == 0 {
            self.dma_req |= 2 << ch;
        }
        match mode {
            1 => self.ocref[ch] = true,
            2 => self.ocref[ch] = false,
            3 => self.ocref[ch] ^= times % 2 == 1,
            _ => {}
        }
    }

    /// Advance `e` ticks without wrapping, flagging the compare values
    /// the counter passes through.
    fn advance_within(&mut self, e: u64) {
        let (lo, hi) = if self.down() {
            (self.cnt as u64 - e, self.cnt as u64 - 1)
        } else {
            (self.cnt as u64 + 1, self.cnt as u64 + e)
        };
        for ch in 0..self.info.channels as usize {
            let v = self.ccr_act[ch] as u64;
            if (lo..=hi).contains(&v) && v <= self.arr_act as u64 {
                self.compare_match(ch, 1);
            }
        }
        self.cnt = if self.down() { lo as u32 } else { hi as u32 };
        self.ref_cycle += e * self.tick();
    }

    /// Update event: flag it and load the shadow registers.
    fn update_event(&mut self, set_flag: bool) {
        if set_flag {
            self.sr |= UIF;
        }
        if self.dier & UDE != 0 {
            self.dma_req |= 1;
        }
        // CCDS: capture/compare DMA requests go out on the update event.
        if self.cr2 & CCDS != 0 {
            for (ch, de) in CC_DE.iter().enumerate().take(self.info.channels as usize) {
                if self.dier & de != 0 {
                    self.dma_req |= 2 << ch;
                }
            }
        }
        self.psc_act = self.psc;
        self.arr_act = self.arr;
        for ch in 0..4 {
            if self.preload(ch) {
                self.ccr_act[ch] = self.ccr[ch];
            }
        }
    }

    fn shadows_settled(&self) -> bool {
        self.psc_act == self.psc
            && self.arr_act == self.arr
            && (0..4).all(|ch| !self.preload(ch) || self.ccr_act[ch] == self.ccr[ch])
    }

    /// Capture/compare selection of a channel (CCxS): 0 output, 1 input
    /// from its own pin (TIx), 2 from the neighbour's (TI2 for IC1, …), 3 TRC.
    fn ccs(&self, ch: usize) -> u32 {
        (self.ccmr[ch / 2] >> (8 * (ch % 2))) & 3
    }

    /// A channel configured as an input.
    pub fn is_input(&self, ch: usize) -> bool {
        self.ccs(ch) != 0
    }

    /// An edge on the timer input pin of channel `ti` (TI1 = 0, …) at
    /// `now`: input capture on the channels listening to it, and the slave
    /// controller's reset mode on TI1FP1/TI2FP2.
    /// `other` is the level of the other input of the TI1/TI2 pair, for
    /// encoder mode.
    pub fn input_edge(&mut self, ti: usize, rising: bool, now: Cycles, other: Option<bool>) {
        if self.gated {
            return;
        }
        self.sync(now);
        // Encoder modes (SMS = 001 TI1 edges, 010 TI2 edges, 011 both):
        // count up or down by the other input's level (RM0368 table 54).
        let sms = self.smcr & 7;
        if (1..=3).contains(&sms) && ti < 2 && self.running() && sms & (1 << ti) != 0 {
            let pol = |ch: usize| self.ccer & (2 << (4 * ch)) != 0;
            let me = rising ^ pol(ti);
            if let Some(o) = other {
                let o = o ^ pol(ti ^ 1);
                let up = if ti == 0 { me != o } else { me == o };
                if up {
                    self.cr1 &= !DIR;
                    if self.cnt >= self.arr_act {
                        self.cnt = 0;
                        self.update_event(self.cr1 & UDIS == 0);
                    } else {
                        self.cnt += 1;
                    }
                } else {
                    self.cr1 |= DIR;
                    if self.cnt == 0 {
                        self.cnt = self.arr_act;
                        self.update_event(self.cr1 & UDIS == 0);
                    } else {
                        self.cnt -= 1;
                    }
                }
            }
        }
        // Edge selection of a channel: CCxP/CCxNP = 00 rising, 01 falling,
        // 11 both.
        let wants =
            |ccer: u32, ch: usize| match ((ccer >> (4 * ch + 1)) & 1, (ccer >> (4 * ch + 3)) & 1) {
                (0, 0) => rising,
                (1, 0) => !rising,
                (1, 1) => true,
                _ => rising,
            };
        for ch in 0..self.info.channels as usize {
            let src = match self.ccs(ch) {
                1 => ch,
                2 => ch ^ 1,
                _ => continue,
            };
            if src != ti || self.ccer & (1 << (4 * ch)) == 0 || !wants(self.ccer, ch) {
                continue;
            }
            // ICxPSC: capture every 1, 2, 4 or 8 edges.
            let psc = (self.ccmr[ch / 2] >> (8 * (ch % 2) + 2)) & 3;
            self.ic_count[ch] = self.ic_count[ch].wrapping_add(1);
            if !self.ic_count[ch].is_multiple_of(1 << psc) {
                continue;
            }
            if self.sr & CC_IF[ch] != 0 {
                self.sr |= CC_OF[ch];
            }
            self.ccr[ch] = self.cnt;
            self.ccr_act[ch] = self.cnt;
            self.sr |= CC_IF[ch];
            if self.dier & CC_DE[ch] != 0 {
                self.dma_req |= 2 << ch;
            }
        }
        // Slave mode controller, reset mode (SMS = 100) triggered by
        // TI1FP1 (TS = 101) or TI2FP2 (TS = 110): the counter restarts.
        let sms = self.smcr & 7;
        let ts = (self.smcr >> 4) & 7;
        let trigger = match (ts, ti) {
            (5, 0) => wants(self.ccer, 0),
            (6, 1) => wants(self.ccer, 1),
            _ => false,
        };
        if sms == 4 && trigger && self.running() {
            self.cnt = if self.down() { self.arr_act } else { 0 };
            self.ref_cycle = now;
            self.update_event(self.cr1 & URS == 0);
        }
    }

    /// Side effects of a register read: reading CCRx of an input channel
    /// clears CCxIF.
    pub fn after_read(&mut self, offset: u32) {
        if let 0x34..=0x40 = offset {
            let ch = ((offset - 0x34) / 4) as usize;
            if ch < self.info.channels as usize && self.is_input(ch) {
                self.sr &= !CC_IF[ch];
            }
        }
    }

    /// The counter is clocked by encoder edges, not by time.
    fn encoder_mode(&self) -> bool {
        (1..=3).contains(&(self.smcr & 7))
    }

    /// Bring the counter and flags up to `now`.
    pub fn sync(&mut self, now: Cycles) {
        if !self.running() || self.gated || self.encoder_mode() {
            self.ref_cycle = now;
            return;
        }
        loop {
            let tick = self.tick();
            let e = (now.saturating_sub(self.ref_cycle)) / tick;
            if e == 0 {
                return;
            }
            let wrap = self.ticks_to_wrap();
            if e < wrap {
                self.advance_within(e);
                return;
            }
            // Run up to the wrap: the counter passes every remaining value
            // and then takes its reload value.
            if wrap > 1 {
                self.advance_within(wrap - 1);
            }
            self.ref_cycle += tick;
            self.cnt = if self.down() { self.arr_act } else { 0 };
            // The update loads the preloaded registers first; the new
            // compare values apply to the counter's first value.
            if self.cr1 & UDIS == 0 {
                self.update_event(true);
            }
            for ch in 0..self.info.channels as usize {
                if self.ccr_act[ch] == self.cnt {
                    self.compare_match(ch, 1);
                }
            }
            if self.cr1 & OPM != 0 {
                self.cr1 &= !CEN;
                self.ref_cycle = now;
                return;
            }
            // Whole periods with nothing to reload: skip them arithmetically.
            if self.shadows_settled() {
                let tick = self.tick();
                let period = self.arr_act as u64 + 1;
                let periods = (now - self.ref_cycle) / tick / period;
                if periods > 0 {
                    self.ref_cycle += periods * period * tick;
                    if self.cr1 & UDIS == 0 {
                        self.sr |= UIF;
                    }
                    for ch in 0..self.info.channels as usize {
                        if self.ccr_act[ch] <= self.arr_act {
                            self.compare_match(ch, periods);
                        }
                    }
                }
            }
        }
    }

    /// Re-derive the tick length after a clock change (call `sync` first).
    pub fn set_clock(&mut self, hclk: u32, timclk: u32, now: Cycles) {
        self.sync(now);
        self.clk_div = (hclk as u64 / timclk.max(1) as u64).max(1);
    }

    fn output_enabled(&self, ch: usize) -> bool {
        self.ccer & (1 << (4 * ch)) != 0 && (!self.info.advanced || self.bdtr & MOE != 0)
    }

    /// OCxREF of a channel at the current counter value.
    fn reference(&self, ch: usize) -> bool {
        let ccr = self.ccr_act[ch];
        match self.oc_mode(ch) {
            Some(4) => false,
            Some(5) => true,
            Some(m @ (6 | 7)) => {
                let active = if self.down() {
                    self.cnt <= ccr
                } else {
                    self.cnt < ccr
                };
                active == (m == 6)
            }
            Some(_) => self.ocref[ch],
            None => false,
        }
    }

    /// Level driven on a channel's output pin, or `None` if the output is
    /// disabled.
    pub fn output(&self, ch: usize) -> Option<bool> {
        // An input-capture channel drives nothing (CCxE enables capture).
        if ch >= self.info.channels as usize || !self.output_enabled(ch) || self.is_input(ch) {
            return None;
        }
        let polarity = self.ccer & (2 << (4 * ch)) != 0;
        Some(self.reference(ch) ^ polarity)
    }

    /// Core cycle of the next event worth scheduling, if any.
    pub fn next_event(&self) -> Option<Cycles> {
        if !self.running() || self.gated || self.encoder_mode() {
            return None;
        }
        let mut ticks: Option<u64> = None;
        let mut consider = |t: Option<u64>| {
            if let Some(t) = t {
                ticks = Some(ticks.map_or(t, |x: u64| x.min(t)));
            }
        };
        let any_pwm = (0..self.info.channels as usize)
            .any(|ch| self.output_enabled(ch) && matches!(self.oc_mode(ch), Some(6 | 7)));
        let dma_on_update =
            self.dier & UDE != 0 || (self.cr2 & CCDS != 0 && self.dier & 0x1E00 != 0);
        if self.dier & UIF != 0
            || dma_on_update
            || !self.shadows_settled()
            || self.cr1 & OPM != 0
            || any_pwm
        {
            consider(Some(self.ticks_to_wrap()));
        }
        for ch in 0..self.info.channels as usize {
            let Some(mode) = self.oc_mode(ch) else {
                continue;
            };
            let visible = self.output_enabled(ch) && matches!(mode, 1 | 2 | 3 | 6 | 7);
            if self.dier & (CC_IF[ch] | CC_DE[ch]) != 0 || visible {
                consider(self.ticks_to_value(self.ccr_act[ch]));
            }
        }
        ticks.map(|t| self.ref_cycle + t * self.tick())
    }

    /// Update interrupt request line.
    pub fn irq_update(&self) -> bool {
        self.sr & self.dier & UIF != 0
    }

    /// Capture/compare interrupt request line.
    pub fn irq_cc(&self) -> bool {
        self.sr & self.dier & 0x1E != 0
    }

    /// Any interrupt request (timers with a single vector).
    pub fn irq_any(&self) -> bool {
        self.sr & self.dier & 0x5F != 0
    }

    /// Register read (after `sync`).
    pub fn read(&self, offset: u32) -> u32 {
        match offset {
            0x00 => self.cr1,
            0x04 => self.cr2,
            0x08 => self.smcr,
            0x0C => self.dier,
            0x10 => self.sr,
            0x14 => 0,
            0x18 => self.ccmr[0],
            0x1C => self.ccmr[1],
            0x20 => self.ccer,
            0x24 => self.cnt,
            0x28 => self.psc,
            0x2C => self.arr,
            0x30 if self.info.advanced => self.rcr,
            0x34..=0x40 => {
                let ch = ((offset - 0x34) / 4) as usize;
                if ch < self.info.channels as usize {
                    self.ccr[ch]
                } else {
                    0
                }
            }
            0x44 if self.info.advanced => self.bdtr,
            0x48 => self.dcr,
            0x50 => self.or,
            _ => 0,
        }
    }

    /// Register write (after `sync`). The caller recomputes outputs and
    /// the schedule afterwards.
    pub fn write(&mut self, offset: u32, value: u32, lanes: u32, now: Cycles) {
        let merge = |old: u32| (old & !lanes) | (value & lanes);
        let max = self.max();
        match offset {
            0x00 => {
                let was = self.running();
                self.cr1 = merge(self.cr1) & 0x3FF;
                if !was && self.running() {
                    self.ref_cycle = now;
                }
                if self.cr1 & ARPE == 0 {
                    self.arr_act = self.arr;
                }
            }
            0x04 => self.cr2 = merge(self.cr2),
            0x08 => self.smcr = merge(self.smcr),
            0x0C => self.dier = merge(self.dier),
            0x10 => {
                // rc_w0: writing 0 clears, 1 keeps.
                self.sr &= value | !lanes;
            }
            0x14 => {
                let v = value & lanes;
                if v & 1 != 0 {
                    // UG: re-initialise the counter and prescaler.
                    self.cnt = if self.down() { self.arr } else { 0 };
                    self.ref_cycle = now;
                    if self.cr1 & UDIS == 0 {
                        self.update_event(self.cr1 & URS == 0);
                    }
                }
                for (ch, flag) in CC_IF.iter().enumerate() {
                    if v & (2 << ch) != 0 {
                        self.sr |= flag;
                    }
                }
            }
            0x18 | 0x1C => {
                let i = ((offset - 0x18) / 4) as usize;
                self.ccmr[i] = merge(self.ccmr[i]);
                self.load_unbuffered_ccr();
            }
            0x20 => self.ccer = merge(self.ccer),
            0x24 => {
                self.cnt = merge(self.cnt) & max;
                self.ref_cycle = now;
            }
            0x28 => self.psc = merge(self.psc) & 0xFFFF,
            0x2C => {
                self.arr = merge(self.arr) & max;
                if self.cr1 & ARPE == 0 {
                    self.arr_act = self.arr;
                }
            }
            0x30 if self.info.advanced => self.rcr = merge(self.rcr) & 0xFF,
            0x34..=0x40 => {
                let ch = ((offset - 0x34) / 4) as usize;
                if ch < self.info.channels as usize {
                    self.ccr[ch] = merge(self.ccr[ch]) & max;
                    self.load_unbuffered_ccr();
                }
            }
            0x44 if self.info.advanced => self.bdtr = merge(self.bdtr),
            0x48 => self.dcr = merge(self.dcr),
            0x50 => self.or = merge(self.or),
            _ => {}
        }
    }

    fn load_unbuffered_ccr(&mut self) {
        for ch in 0..4 {
            if !self.preload(ch) {
                self.ccr_act[ch] = self.ccr[ch];
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tim3() -> Timer {
        Timer::new(TIMERS[2])
    }

    #[test]
    fn counts_and_flags_update_lazily() {
        let mut t = tim3();
        t.write(0x28, 9, u32::MAX, 0); // PSC = 9: one tick per 10 cycles
        t.write(0x2C, 99, u32::MAX, 0); // period 100 ticks = 1000 cycles
        t.write(0x14, 1, u32::MAX, 0); // UG loads PSC
        t.write(0x10, 0, u32::MAX, 0); // clear UIF
        t.write(0x00, CEN, u32::MAX, 0);
        t.sync(555);
        assert_eq!(t.read(0x24), 55);
        assert_eq!(t.sr & UIF, 0);
        t.sync(1_000);
        assert_eq!(t.read(0x24), 0);
        assert_eq!(t.sr & UIF, UIF);
        t.sync(123_456);
        assert_eq!(t.read(0x24), 45);
        // Nothing observable: no events.
        assert_eq!(t.next_event(), None);
        t.write(0x0C, UIF, u32::MAX, 123_456);
        assert_eq!(t.next_event(), Some(124_000));
    }

    #[test]
    fn pwm_edges_follow_ccr() {
        let mut t = tim3();
        t.write(0x2C, 9, u32::MAX, 0); // period 10 cycles
        t.write(0x18, 6 << 4 | 1 << 3, u32::MAX, 0); // CH1 PWM1, preload
        t.write(0x34, 3, u32::MAX, 0);
        t.write(0x14, 1, u32::MAX, 0);
        t.write(0x20, 1, u32::MAX, 0); // CC1E
        t.write(0x00, CEN, u32::MAX, 0);
        assert_eq!(t.output(0), Some(true));
        assert_eq!(t.next_event(), Some(3));
        t.sync(3);
        assert_eq!(t.output(0), Some(false));
        assert_eq!(t.next_event(), Some(10));
        // A new duty takes effect at the next update.
        t.write(0x34, 7, u32::MAX, 3);
        t.sync(10);
        assert_eq!(t.output(0), Some(true));
        assert_eq!(t.next_event(), Some(17));
        // Inverted polarity.
        t.write(0x20, 3, u32::MAX, 10);
        assert_eq!(t.output(0), Some(false));
    }

    #[test]
    fn toggle_mode_and_one_pulse() {
        let mut t = tim3();
        t.write(0x2C, 4, u32::MAX, 0);
        t.write(0x18, 3 << 4, u32::MAX, 0); // toggle on match
        t.write(0x34, 2, u32::MAX, 0);
        t.write(0x20, 1, u32::MAX, 0);
        t.write(0x00, CEN, u32::MAX, 0);
        t.sync(2);
        assert_eq!(t.output(0), Some(true));
        t.sync(7);
        assert_eq!(t.output(0), Some(false));
        t.sync(7 + 5 * 3);
        assert_eq!(t.output(0), Some(true), "three more toggles");
        // One-pulse: stops at the update.
        let mut t = tim3();
        t.write(0x2C, 4, u32::MAX, 0);
        t.write(0x00, CEN | OPM, u32::MAX, 0);
        t.sync(100);
        assert!(!t.running());
        assert_eq!(t.read(0x24), 0);
    }

    #[test]
    fn down_counting() {
        let mut t = tim3();
        t.write(0x2C, 9, u32::MAX, 0);
        t.write(0x00, DIR, u32::MAX, 0);
        t.write(0x14, 1, u32::MAX, 0); // UG: counter = ARR
        t.write(0x10, 0, u32::MAX, 0);
        t.write(0x00, CEN | DIR, u32::MAX, 0);
        t.sync(4);
        assert_eq!(t.read(0x24), 5);
        t.sync(10);
        assert_eq!(t.read(0x24), 9);
        assert_eq!(t.sr & UIF, UIF);
    }

    #[test]
    fn clock_gating_freezes_the_counter() {
        let mut t = tim3();
        t.write(0x2C, 99, u32::MAX, 0);
        t.write(0x0C, UIF, u32::MAX, 0);
        t.write(0x00, CEN, u32::MAX, 0);
        t.sync(30);
        t.gated = true;
        assert_eq!(t.next_event(), None);
        t.sync(1_000);
        assert_eq!(t.read(0x24), 30, "frozen while the clock is off");
        t.gated = false;
        assert_eq!(t.next_event(), Some(1_070), "resumes from where it stopped");
    }

    #[test]
    fn tim1_needs_moe() {
        let mut t = Timer::new(TIMERS[0]);
        t.write(0x18, 5 << 4, u32::MAX, 0); // force active
        t.write(0x20, 1, u32::MAX, 0);
        assert_eq!(t.output(0), None);
        t.write(0x44, MOE, u32::MAX, 0);
        assert_eq!(t.output(0), Some(true));
    }

    #[test]
    fn input_capture_and_pwm_input_mode() {
        let mut t = tim3();
        // IC1 on TI1 rising, IC2 on TI1 falling (indirect), reset on TI1FP1.
        t.write(0x18, 1 | 2 << 8, 0xFFFF, 0);
        t.write(0x20, 1 | (1 << 4) | (1 << 5), 0xFFFF, 0);
        t.write(0x08, 4 | 5 << 4, 0xFFFF, 0);
        t.write(0x00, 1, 0xFFFF, 0); // CEN, 1 tick per cycle
        t.input_edge(0, true, 100, None); // period start: counter reset
        t.input_edge(0, false, 130, None); // 30 high
        t.input_edge(0, true, 200, None); // period 100
        assert_eq!(t.read(0x34), 100, "period");
        assert_eq!(t.read(0x38), 30, "high time");
        assert_ne!(t.sr & (CC_IF[0] | CC_IF[1]), 0);
        t.after_read(0x34);
        assert_eq!(t.sr & CC_IF[0], 0, "reading CCR1 clears CC1IF");
        assert_ne!(
            t.sr & CC_OF[0],
            0,
            "CC1 captured twice before the flag was cleared"
        );
    }

    #[test]
    fn encoder_mode_counts_quadrature_both_ways() {
        let mut t = tim3();
        t.write(0x18, 1 | 1 << 8, 0xFFFF, 0); // CC1S = CC2S = TI
        t.write(0x08, 3, 0xFFFF, 0); // encoder mode 3
        t.write(0x2C, 99, 0xFFFF, 0);
        t.write(0x00, 1, 0xFFFF, 0);
        // Clockwise, A leads: (A, B) 11 → 01 → 00 → 10 → 11.
        let (mut a, mut b) = (true, true);
        let mut step = |t: &mut Timer, ti: usize| {
            if ti == 0 {
                a = !a;
                t.input_edge(0, a, 0, Some(b));
            } else {
                b = !b;
                t.input_edge(1, b, 0, Some(a));
            }
        };
        for ti in [0, 1, 0, 1] {
            step(&mut t, ti);
        }
        assert_eq!(t.read(0x24), 4);
        assert_eq!(t.read(0x00) & DIR, 0);
        // Counter-clockwise: B leads; three detents back past zero.
        for ti in [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0] {
            step(&mut t, ti);
        }
        assert_eq!(t.read(0x24), 92); // 4 − 12, wrapped at ARR 99
        assert_ne!(t.read(0x00) & DIR, 0);
        assert_ne!(t.sr & UIF, 0, "underflow is an update event");
    }
}
