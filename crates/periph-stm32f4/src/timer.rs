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
//! polarity, and DMA requests on update and compare events (CCDS).
//! TIM1's advanced-control features (RM0368 §12.3.11–12.3.13): the
//! complementary outputs CH1N–CH3N (CCxNE/CCxNP) with dead-time insertion
//! (BDTR.DTG, its four ranges, tDTS from CR1.CKD), MOE/AOE/OSSR/OSSI with
//! the idle levels CR2.OISx/OISxN, the break (BKIN pin with BKE/BKP, or
//! EGR.BG) that clears MOE and sets BIF, and the preloaded CCxE/CCxNE/OCxM
//! bits (CR2.CCPC) taken over at a COM event (EGR.COMG, COMIF). A dead-time
//! edge lies between counter ticks, so it is scheduled in core cycles.
//! Center-aligned counting (CR1.CMS 1–3, TIM1–TIM5, RM0368 §12.3.2): the
//! counter runs 0 → ARR → 0 (overflow at ARR, underflow at 0, each an
//! update event), CR1.DIR is read-only and shows the direction, PWM 1/2
//! give pulses centred on the underflow (on the overflow for PWM 2), and an
//! output channel's CCxIF is set only counting down (CMS 1), up (CMS 2) or
//! both (CMS 3). The repetition counter (TIM1 RCR, §12.3.3): an update
//! event only every RCR + 1 overflows/underflows — periods in edge-aligned
//! mode, half periods in center-aligned mode; RCR is loaded at each update
//! event (and by UG).
//! Not yet: slave modes other than reset and encoder, BDTR.LOCK and the
//! COM event from TRGI (CCUS).
//! Input capture (direct/indirect TI mapping, edge polarity, prescaler,
//! overcapture) and the reset slave mode take pin edges from the bus.

use simucleo_core::Cycles;

// CR1
const CEN: u32 = 1 << 0;
const UDIS: u32 = 1 << 1;
const URS: u32 = 1 << 2;
const OPM: u32 = 1 << 3;
const DIR: u32 = 1 << 4;
/// CR1.CMS: center-aligned mode selection (bits 6:5).
const CMS_SHIFT: u32 = 5;
const ARPE: u32 = 1 << 7;
// SR / DIER
pub const UIF: u32 = 1 << 0;
const CC_IF: [u32; 4] = [1 << 1, 1 << 2, 1 << 3, 1 << 4];
const CC_OF: [u32; 4] = [1 << 9, 1 << 10, 1 << 11, 1 << 12];
// DIER DMA enables
const UDE: u32 = 1 << 8;
const CC_DE: [u32; 4] = [1 << 9, 1 << 10, 1 << 11, 1 << 12];
// CR1 clock division (tDTS) for the dead-time generator.
const CKD_SHIFT: u32 = 8;
// SR / DIER: TIM1 COM, trigger and break.
pub const COMIF: u32 = 1 << 5;
pub const BIF: u32 = 1 << 7;
const TIF: u32 = 1 << 6;
// EGR
const COMG: u32 = 1 << 5;
const BG: u32 = 1 << 7;
// CR2
const CCPC: u32 = 1 << 0;
const CCDS: u32 = 1 << 3;
/// OISx (bit 8 + 2x) and OISxN (bit 9 + 2x).
const OIS_SHIFT: u32 = 8;
// BDTR
pub const MOE: u32 = 1 << 15;
const AOE: u32 = 1 << 14;
const BKP: u32 = 1 << 13;
const BKE: u32 = 1 << 12;
const OSSR: u32 = 1 << 11;
const OSSI: u32 = 1 << 10;
/// CCER bits preloaded while CR2.CCPC is set: CCxE and CCxNE of CH1–CH3.
const PRE_CCER: u32 = 0x555;
/// CCMR bits preloaded while CR2.CCPC is set: OC1M, OC2M / OC3M.
const PRE_CCMR: [u32; 2] = [0x7070, 0x0070];

/// Dead time in timer kernel clock periods (tCK_INT) for a BDTR.DTG value
/// and CR1.CKD (tDTS = 1, 2 or 4 tCK_INT), RM0368 §12.4.18:
/// DTG[7:5] = 0xx: DTG × tDTS; 10x: (64 + DTG[5:0]) × 2 tDTS;
/// 110: (32 + DTG[4:0]) × 8 tDTS; 111: (32 + DTG[4:0]) × 16 tDTS.
pub fn dead_time_ticks(dtg: u32, ckd: u32) -> u64 {
    let dtg = dtg & 0xFF;
    let tdts: u64 = match ckd & 3 {
        0 => 1,
        1 => 2,
        _ => 4,
    };
    let (n, mult) = if dtg & 0x80 == 0 {
        (dtg, 1)
    } else if dtg & 0xC0 == 0x80 {
        (64 + (dtg & 0x3F), 2)
    } else if dtg & 0xE0 == 0xC0 {
        (32 + (dtg & 0x1F), 8)
    } else {
        (32 + (dtg & 0x1F), 16)
    };
    n as u64 * mult * tdts
}

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

/// TIM1 complementary outputs on pins: (port, pin, alternate function,
/// channel 0–2). CH1N PA7/PB13, CH2N PB0/PB14, CH3N PB1/PB15 (AF1).
pub const PIN_MAP_N: &[(u8, u8, u8, u8)] = &[
    (0, 7, 1, 0),
    (1, 13, 1, 0),
    (1, 0, 1, 1),
    (1, 14, 1, 1),
    (1, 1, 1, 2),
    (1, 15, 1, 2),
];

/// TIM1 break input BKIN: PA6 and PB12 (AF1).
pub const BKIN_PINS: &[(u8, u8, u8)] = &[(0, 6, 1), (1, 12, 1)];

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
    /// CCER / CCMR bits in effect while CR2.CCPC preloads them (taken
    /// over at a COM event); equal to the registers otherwise.
    ccer_sh: u32,
    ccmr_sh: [u32; 2],
    /// Time of the last `sync` / `write`: the outputs are those at `now`.
    now: Cycles,
    /// OCxREF as last seen, and when it last changed (for dead time).
    ref_prev: [bool; 4],
    ref_at: [Option<Cycles>; 4],
    /// When the references were last looked at.
    track_time: Cycles,
    /// BKIN: routed to a pin in its alternate function, and that pin's level.
    bk_routed: bool,
    bk_level: bool,
    /// Center-aligned mode: counting down now (CR1.DIR reads this).
    cdown: bool,
    /// Repetition down-counter (REP_CNT): an update event when an
    /// overflow/underflow finds it at 0, then it is reloaded from RCR.
    rep: u32,
    /// When the last update event loaded the shadow registers (a PWM
    /// reference that changed since cannot have changed before it).
    uev_at: Cycles,
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
            ccer_sh: 0,
            ccmr_sh: [0; 2],
            now: 0,
            ref_prev: [false; 4],
            ref_at: [None; 4],
            track_time: 0,
            bk_routed: false,
            bk_level: false,
            cdown: false,
            rep: 0,
            uev_at: 0,
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
        self.now = now;
        self.track_time = now;
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

    /// CR1.CMS (0 = edge-aligned). Only TIM1–TIM5 have it.
    fn cms(&self) -> u32 {
        if self.info.channels == 4 {
            (self.cr1 >> CMS_SHIFT) & 3
        } else {
            0
        }
    }

    /// Center-aligned (up/down) counting.
    fn center(&self) -> bool {
        self.cms() != 0
    }

    /// Counting down: CR1.DIR, or the present half of a center-aligned
    /// period.
    fn down(&self) -> bool {
        if self.center() {
            self.cdown
        } else {
            self.cr1 & DIR != 0
        }
    }

    /// An output compare match counting down (`down`) sets CCxIF: always
    /// in edge-aligned mode, per CMS in center-aligned mode.
    fn flags_match(&self, down: bool) -> bool {
        match self.cms() {
            1 => down,
            2 => !down,
            _ => true,
        }
    }

    /// `k` overflows/underflows: the repetition counter counts them down.
    /// Returns how many of them were update events (REP_CNT at 0).
    fn turns(&mut self, k: u64) -> u64 {
        let r = self.rep as u64;
        if k <= r {
            self.rep -= k as u32;
            return 0;
        }
        let n = self.rcr as u64 + 1;
        let after = k - r - 1;
        self.rep = (self.rcr as u64 - after % n) as u32;
        1 + after / n
    }

    /// Ticks from one overflow/underflow to the next (once running).
    fn turn_ticks(&self) -> u64 {
        if self.center() {
            self.arr_act as u64
        } else {
            self.arr_act as u64 + 1
        }
    }

    /// Ticks until the next update event (the repetition counter at 0).
    fn ticks_to_update(&self) -> u64 {
        self.ticks_to_wrap() + self.rep as u64 * self.turn_ticks()
    }

    fn tick(&self) -> Cycles {
        (self.psc_act as u64 + 1) * self.clk_div
    }

    /// Output compare mode of a channel (OCxM), or `None` if the channel is
    /// configured as an input.
    fn oc_mode(&self, ch: usize) -> Option<u32> {
        let r = self.ccmr_eff(ch / 2) >> (8 * (ch % 2));
        (r & 3 == 0).then_some((r >> 4) & 7)
    }

    /// CR2.CCPC: CCxE, CCxNE and OCxM are preloaded (TIM1).
    fn com_preload(&self) -> bool {
        self.info.advanced && self.cr2 & CCPC != 0
    }

    /// CCMRx as in effect (the preloaded OCxM bits until a COM event).
    fn ccmr_eff(&self, i: usize) -> u32 {
        if self.com_preload() {
            (self.ccmr[i] & !PRE_CCMR[i]) | (self.ccmr_sh[i] & PRE_CCMR[i])
        } else {
            self.ccmr[i]
        }
    }

    /// CCER as in effect (the preloaded enable bits until a COM event).
    fn ccer_eff(&self) -> u32 {
        if self.com_preload() {
            (self.ccer & !PRE_CCER) | (self.ccer_sh & PRE_CCER)
        } else {
            self.ccer
        }
    }

    /// COM event: the preloaded bits take effect.
    fn com_event(&mut self) {
        self.ccer_sh = self.ccer;
        self.ccmr_sh = self.ccmr;
        self.sr |= COMIF;
    }

    fn preload(&self, ch: usize) -> bool {
        self.ccmr[ch / 2] >> (8 * (ch % 2)) & (1 << 3) != 0
    }

    /// Ticks until the counter wraps: the next overflow or underflow (an
    /// update event unless the repetition counter is not at 0).
    fn ticks_to_wrap(&self) -> u64 {
        if self.center() {
            // Up to ARR, or down to 0.
            return if self.cdown {
                (self.cnt as u64).max(1)
            } else {
                (self.arr_act as u64).saturating_sub(self.cnt as u64).max(1)
            };
        }
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
        if self.center() {
            // Position in the period: 0 … ARR − 1 counting up, ARR … 2·ARR − 1
            // counting down (CNT = 2·ARR − position). The counter takes v
            // counting up at position v (v < ARR) and counting down at
            // 2·ARR − v (v ≥ 1).
            let a = self.arr_act as u64;
            let period = 2 * a;
            if period == 0 {
                return None;
            }
            let p = self.position();
            let mut best: Option<u64> = None;
            let targets = [((v as u64) < a, v as u64), (v >= 1, period - v as u64)];
            for (ok, t) in targets {
                if ok {
                    let d = (t + period - p) % period;
                    let d = if d == 0 { period } else { d };
                    best = Some(best.map_or(d, |b| b.min(d)));
                }
            }
            return best;
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

    /// Position in a center-aligned period (see `ticks_to_value`).
    fn position(&self) -> u64 {
        let a = self.arr_act as u64;
        let c = (self.cnt as u64).min(a);
        if self.cdown {
            (2 * a - c) % (2 * a).max(1)
        } else {
            c.min(a.saturating_sub(1))
        }
    }

    /// The counter took the value of CCRx: set CCxIF (if `flag`: in
    /// center-aligned mode only in the directions CMS selects) and update
    /// the stateful output-compare references.
    fn compare_match(&mut self, ch: usize, times: u64, flag: bool) {
        let Some(mode) = self.oc_mode(ch) else {
            return;
        };
        if flag {
            self.sr |= CC_IF[ch];
            if self.dier & CC_DE[ch] != 0 && self.cr2 & CCDS == 0 {
                self.dma_req |= 2 << ch;
            }
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
        let flag = self.flags_match(self.down());
        for ch in 0..self.info.channels as usize {
            let v = self.ccr_act[ch] as u64;
            if (lo..=hi).contains(&v) && v <= self.arr_act as u64 {
                self.compare_match(ch, 1, flag);
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
        // AOE: MOE is set again at the update event once the break input
        // is inactive.
        if self.info.advanced && self.bdtr & AOE != 0 && !self.break_active() {
            self.bdtr |= MOE;
        }
    }

    /// The break input is active: BKE set and BKIN (routed to its pin) at
    /// the level BKP selects.
    fn break_active(&self) -> bool {
        self.info.advanced
            && self.bdtr & BKE != 0
            && self.bk_routed
            && self.bk_level == (self.bdtr & BKP != 0)
    }

    /// A break: MOE cleared, BIF set (asynchronously, RM0368 §12.3.12).
    fn apply_break(&mut self) {
        if self.break_active() {
            self.bdtr &= !MOE;
            self.sr |= BIF;
        }
    }

    /// The BKIN pin: whether it is routed (in its alternate function) and
    /// its level, at `now`. Returns whether anything changed.
    pub fn set_break_input(&mut self, routed: bool, level: bool, now: Cycles) -> bool {
        if !self.info.advanced || (self.bk_routed, self.bk_level) == (routed, level) {
            return false;
        }
        self.sync(now);
        self.bk_routed = routed;
        self.bk_level = level;
        self.apply_break();
        self.track();
        true
    }

    /// The dead time in core cycles (BDTR.DTG with tDTS from CR1.CKD).
    pub fn dead_time(&self) -> Cycles {
        dead_time_ticks(self.bdtr, self.cr1 >> CKD_SHIFT) * self.clk_div
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
            self.cdown = false;
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

    /// Bring the counter, flags and outputs up to `now`.
    pub fn sync(&mut self, now: Cycles) {
        self.advance_to(now);
        self.now = now;
        self.track();
    }

    /// Note the time of OCxREF changes since the last look (for dead time).
    /// A PWM reference changed when the counter took its value; anything
    /// else (a forced level, a mode written) changed now.
    fn track(&mut self) {
        if !self.info.advanced {
            return;
        }
        for ch in 0..self.info.channels as usize {
            let r = self.reference(ch);
            if r != self.ref_prev[ch] {
                self.ref_prev[ch] = r;
                let at = self
                    .pwm_edge_time(ch)
                    .filter(|&t| t >= self.track_time && t <= self.now)
                    .unwrap_or(self.now);
                self.ref_at[ch] = Some(at);
            }
        }
        self.track_time = self.now;
    }

    /// When a PWM reference last changed, from the counter.
    fn pwm_edge_time(&self, ch: usize) -> Option<Cycles> {
        if !matches!(self.oc_mode(ch), Some(6 | 7)) || !self.running() {
            return None;
        }
        let (cnt, ccr, arr) = (
            self.cnt as u64,
            self.ccr_act[ch] as u64,
            self.arr_act as u64,
        );
        if self.center() {
            // The reference changes where the counter takes CCRx: counting
            // up (position CCRx) and counting down (2·ARR − CCRx).
            if ccr == 0 || ccr >= arr {
                // Always off or always on: it changed at the update event
                // that loaded this CCRx.
                return Some(self.uev_at);
            }
            let (p, period) = (self.position(), 2 * arr);
            let back = [ccr, period - ccr]
                .map(|e| (p + period - e) % period)
                .into_iter()
                .min()
                .unwrap_or(0);
            // A new CCRx loaded at the update event changes the reference
            // there (from 0 % to a pulse at the underflow, say).
            let at = self.ref_cycle.saturating_sub(back * self.tick());
            return Some(at.max(self.uev_at));
        }
        let back = if self.down() {
            if cnt <= ccr && ccr < arr {
                ccr - cnt
            } else {
                arr.saturating_sub(cnt)
            }
        } else if cnt < ccr {
            cnt
        } else {
            cnt - ccr
        };
        Some(self.ref_cycle.saturating_sub(back * self.tick()))
    }

    /// The next update event does more than set UIF: a DMA request (UDE,
    /// or CCDS with a CCxDE), MOE set again (AOE), or the end of a one-pulse
    /// run (OPM). Such an update must be run, not skipped arithmetically.
    fn update_has_effects(&self) -> bool {
        let dma_on_update =
            self.dier & UDE != 0 || (self.cr2 & CCDS != 0 && self.dier & 0x1E00 != 0);
        // AOE sets MOE again at the next update.
        let aoe = self.info.advanced && self.bdtr & (AOE | MOE) == AOE && !self.break_active();
        dma_on_update || aoe || self.cr1 & OPM != 0
    }

    /// Bring the counter and flags up to `now`.
    fn advance_to(&mut self, now: Cycles) {
        if !self.running()
            || self.gated
            || self.encoder_mode()
            || (self.center() && self.arr_act == 0)
        {
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
            // and then takes its reload value (edge-aligned) or turns round
            // at ARR or 0 (center-aligned).
            if wrap > 1 {
                self.advance_within(wrap - 1);
            }
            self.ref_cycle += tick;
            if self.center() {
                let was_down = self.cdown;
                self.cdown = !was_down;
                self.cnt = if was_down { 0 } else { self.arr_act };
            } else {
                self.cnt = if self.down() { self.arr_act } else { 0 };
            }
            // An overflow/underflow: an update event when the repetition
            // counter is at 0. The update loads the preloaded registers
            // first; the new compare values apply to the counter's value.
            let update = self.turns(1) == 1;
            if update && self.cr1 & UDIS == 0 {
                self.update_event(true);
                self.uev_at = self.ref_cycle;
            }
            // A zero ARR loaded by that update stops a center-aligned
            // counter (as at the entry).
            if self.center() && self.arr_act == 0 {
                self.ref_cycle = now;
                return;
            }
            let flag = self.flags_match(self.down());
            for ch in 0..self.info.channels as usize {
                if self.ccr_act[ch] == self.cnt {
                    self.compare_match(ch, 1, flag);
                }
            }
            if update && self.cr1 & OPM != 0 {
                self.cr1 &= !CEN;
                self.ref_cycle = now;
                return;
            }
            // Whole periods with nothing to reload: skip them arithmetically.
            if self.shadows_settled() {
                let tick = self.tick();
                let (period, turns) = if self.center() {
                    (2 * self.arr_act as u64, 2)
                } else {
                    (self.arr_act as u64 + 1, 1)
                };
                let mut periods = (now - self.ref_cycle) / tick / period;
                // Stop short of an update with side effects (the repetition
                // counter runs out after `rep` more turns): the loop runs it.
                if self.cr1 & UDIS == 0 && self.update_has_effects() {
                    periods = periods.min(self.rep as u64 / turns);
                }
                if periods > 0 {
                    self.ref_cycle += periods * period * tick;
                    if self.turns(periods * turns) > 0 && self.cr1 & UDIS == 0 {
                        self.sr |= UIF;
                    }
                    let a = self.arr_act;
                    for ch in 0..self.info.channels as usize {
                        let v = self.ccr_act[ch];
                        if v > a {
                            continue;
                        }
                        // Matches per period: counting up at v < ARR, down
                        // at v ≥ 1 (center-aligned); once (edge-aligned).
                        let (up, down) = if !self.center() {
                            let d = self.down();
                            ((!d) as u64, d as u64)
                        } else {
                            ((v < a) as u64, (v >= 1) as u64)
                        };
                        let flag = (up > 0 && self.flags_match(false))
                            || (down > 0 && self.flags_match(true));
                        self.compare_match(ch, periods * (up + down), flag);
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

    /// CCxE, CCxP, CCxNE, CCxNP of a channel (as in effect).
    fn cc_bits(&self, ch: usize) -> (bool, bool, bool, bool) {
        let c = self.ccer_eff() >> (4 * ch);
        let n = self.info.advanced && ch < 3;
        (c & 1 != 0, c & 2 != 0, n && c & 4 != 0, n && c & 8 != 0)
    }

    fn moe(&self) -> bool {
        self.bdtr & MOE != 0
    }

    /// The channel's output stage drives a pin from OCxREF (an edge on the
    /// reference shows on a pin).
    fn output_enabled(&self, ch: usize) -> bool {
        let (e, _, ne, _) = self.cc_bits(ch);
        if self.info.advanced {
            self.moe() && (e || ne)
        } else {
            e
        }
    }

    /// Both outputs of a complementary pair are on: dead time is inserted.
    fn complementary(&self, ch: usize) -> bool {
        let (e, _, ne, _) = self.cc_bits(ch);
        self.moe() && e && ne
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

    /// Levels driven on a channel's pins OCx and OCxN (`None`: not driven),
    /// RM0368 table 75.
    fn outputs(&self, ch: usize) -> (Option<bool>, Option<bool>) {
        // An input-capture channel drives nothing (CCxE enables capture).
        if ch >= self.info.channels as usize || self.is_input(ch) {
            return (None, None);
        }
        let (e, p, ne, np) = self.cc_bits(ch);
        if !self.info.advanced {
            return (e.then(|| self.reference(ch) ^ p), None);
        }
        let has_n = ch < 3;
        if !self.moe() {
            // Off: idle levels with OSSI, else not driven.
            if self.bdtr & OSSI != 0 && (e || ne) {
                let ois = |k: u32| self.cr2 & (1 << (OIS_SHIFT + 2 * ch as u32 + k)) != 0;
                return (Some(ois(0)), has_n.then(|| ois(1)));
            }
            return (None, None);
        }
        let r = self.reference(ch);
        let (x, xn) = if e && ne {
            // Dead time: the output that goes active waits for it.
            let waited =
                self.ref_at[ch].is_none_or(|t| self.now.saturating_sub(t) >= self.dead_time());
            (r && waited, !r && waited)
        } else {
            (r, r)
        };
        let ossr = self.bdtr & OSSR != 0;
        let ox = if e {
            Some(x ^ p)
        } else if ossr && ne {
            Some(p)
        } else {
            None
        };
        let oxn = if ne {
            Some(xn ^ np)
        } else if ossr && e && has_n {
            Some(np)
        } else {
            None
        };
        (ox, oxn)
    }

    /// Level driven on a channel's output pin, or `None` if the output is
    /// disabled.
    pub fn output(&self, ch: usize) -> Option<bool> {
        self.outputs(ch).0
    }

    /// Level driven on a channel's complementary output pin (CHxN).
    pub fn output_n(&self, ch: usize) -> Option<bool> {
        self.outputs(ch).1
    }

    /// Core cycle of the next event worth scheduling, if any.
    pub fn next_event(&self) -> Option<Cycles> {
        if self.gated {
            return None;
        }
        // A dead-time edge still to come.
        let dt = self.dead_time();
        let dead = (0..self.info.channels as usize)
            .filter(|&ch| self.info.advanced && self.complementary(ch))
            .filter_map(|ch| self.ref_at[ch].map(|t| t + dt))
            .filter(|&t| t > self.now)
            .min();
        let counter = self.counter_event();
        match (dead, counter) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }

    fn counter_event(&self) -> Option<Cycles> {
        if !self.running()
            || self.gated
            || self.encoder_mode()
            || (self.center() && self.arr_act == 0)
        {
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
        if self.dier & UIF != 0 || !self.shadows_settled() || self.update_has_effects() {
            consider(Some(self.ticks_to_update()));
        }
        // Edge-aligned PWM outputs change at every wrap; center-aligned
        // ones only where the counter takes CCRx.
        if any_pwm && !self.center() {
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

    /// TIM1 break interrupt request line (TIM1_BRK_TIM9).
    pub fn irq_break(&self) -> bool {
        self.sr & self.dier & BIF != 0
    }

    /// TIM1 trigger and commutation interrupt line (TIM1_TRG_COM_TIM11).
    pub fn irq_trg_com(&self) -> bool {
        self.sr & self.dier & (COMIF | TIF) != 0
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
            // DIR shows the direction in center-aligned mode.
            0x00 if self.center() => (self.cr1 & !DIR) | if self.cdown { DIR } else { 0 },
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
                let (was_center, dir) = (self.center(), self.cr1 & DIR);
                self.cr1 = merge(self.cr1) & 0x3FF;
                if self.center() {
                    // DIR is read-only in center-aligned mode.
                    if !was_center {
                        self.cdown = dir != 0;
                    }
                    self.cr1 = (self.cr1 & !DIR) | dir;
                }
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
                    // UG: re-initialise the counter, prescaler and
                    // repetition counter (center-aligned: from 0, up).
                    self.cdown = false;
                    self.cnt = if self.down() { self.arr } else { 0 };
                    self.rep = self.rcr;
                    self.ref_cycle = now;
                    self.uev_at = now;
                    if self.cr1 & UDIS == 0 {
                        self.update_event(self.cr1 & URS == 0);
                    }
                }
                for (ch, flag) in CC_IF.iter().enumerate() {
                    if v & (2 << ch) != 0 {
                        self.sr |= flag;
                    }
                }
                if self.info.advanced {
                    if v & COMG != 0 {
                        self.com_event();
                    }
                    if v & TIF != 0 {
                        self.sr |= TIF;
                    }
                    if v & BG != 0 {
                        // Software break.
                        self.bdtr &= !MOE;
                        self.sr |= BIF;
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
            0x44 if self.info.advanced => self.bdtr = merge(self.bdtr) & 0xFFFF,
            0x48 => self.dcr = merge(self.dcr),
            0x50 => self.or = merge(self.or),
            _ => {}
        }
        if !self.com_preload() {
            self.ccer_sh = self.ccer;
            self.ccmr_sh = self.ccmr;
        }
        // The break input holds MOE low and BIF set while it is active.
        self.apply_break();
        self.now = now;
        self.track();
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

    // ------------------------------------------------ TIM1 advanced (M23)

    fn tim1() -> Timer {
        Timer::new(TIMERS[0])
    }

    /// TIM1 at one tick per cycle: period 100, CH1 PWM1 at `ccr`, both
    /// outputs on, dead time `dtg`, MOE.
    fn tim1_pwm(ccr: u32, dtg: u32, ccer: u32) -> Timer {
        let mut t = tim1();
        t.write(0x2C, 99, u32::MAX, 0);
        t.write(0x34, ccr, u32::MAX, 0);
        t.write(0x18, 6 << 4, u32::MAX, 0);
        t.write(0x20, ccer, u32::MAX, 0);
        t.write(0x44, MOE | dtg, u32::MAX, 0);
        t.write(0x00, CEN, u32::MAX, 0);
        t
    }

    /// Run event by event up to `until`: every change of (CH1, CH1N).
    fn edges(t: &mut Timer, until: Cycles) -> Vec<(Cycles, Option<bool>, Option<bool>)> {
        let mut out = vec![(t.now, t.output(0), t.output_n(0))];
        while let Some(at) = t.next_event().filter(|&a| a <= until) {
            t.sync(at);
            let o = (at, t.output(0), t.output_n(0));
            let last = out.last().unwrap();
            if (last.1, last.2) != (o.1, o.2) {
                out.push(o);
            }
        }
        out
    }

    #[test]
    fn dead_time_generator_decodes_the_four_dtg_ranges_with_ckd() {
        // DTG[7:5] = 0xx: DTG × tDTS.
        assert_eq!(dead_time_ticks(0, 0), 0);
        assert_eq!(dead_time_ticks(42, 0), 42);
        assert_eq!(dead_time_ticks(0x7F, 0), 127);
        // 10x: (64 + DTG[5:0]) × 2.
        assert_eq!(dead_time_ticks(0x80, 0), 128);
        assert_eq!(dead_time_ticks(0xBF, 0), 254);
        // 110: (32 + DTG[4:0]) × 8.
        assert_eq!(dead_time_ticks(0xC0, 0), 256);
        assert_eq!(dead_time_ticks(0xDF, 0), 504);
        // 111: (32 + DTG[4:0]) × 16.
        assert_eq!(dead_time_ticks(0xE0, 0), 512);
        assert_eq!(dead_time_ticks(0xFF, 0), 1008);
        // CKD: tDTS = 2 or 4 tCK_INT.
        assert_eq!(dead_time_ticks(42, 1), 84);
        assert_eq!(dead_time_ticks(0xFF, 2), 4032);
        // In core cycles, through CR1.CKD and the timer clock.
        let mut t = tim1();
        t.write(0x44, 0xC5, u32::MAX, 0);
        t.write(0x00, 1 << CKD_SHIFT, u32::MAX, 0);
        assert_eq!(t.dead_time(), (32 + 5) * 8 * 2);
        t.set_clock(84_000_000, 42_000_000, 0);
        assert_eq!(t.dead_time(), (32 + 5) * 8 * 2 * 2);
    }

    #[test]
    fn complementary_outputs_have_the_dead_time_between_them() {
        // CCR1 = 40 of 100, dead time 10 cycles: CH1 rises 10 after the
        // reference, CH1N 10 after it falls.
        let mut t = tim1_pwm(40, 10, 1 | 4);
        let e = edges(&mut t, 250);
        let s = Some(true);
        let c = Some(false);
        assert_eq!(
            e,
            vec![
                (0, c, c),
                (10, s, c),
                (40, c, c),
                (50, c, s),
                (100, c, c),
                (110, s, c),
                (140, c, c),
                (150, c, s),
                (200, c, c),
                (210, s, c),
                (240, c, c),
                (250, c, s),
            ]
        );
        // No dead time: exact complements, switching at the same cycle.
        let mut t = tim1_pwm(40, 0, 1 | 4);
        let e = edges(&mut t, 150);
        assert_eq!(e, vec![(0, s, c), (40, c, s), (100, s, c), (140, c, s)]);
        // A dead time longer than the pulse swallows it.
        let mut t = tim1_pwm(5, 10, 1 | 4);
        let e = edges(&mut t, 99);
        assert_eq!(e, vec![(0, c, c), (15, c, s)]);
    }

    #[test]
    fn complementary_polarity_inverts_only_chxn() {
        // CC1NP: CH1N active low.
        let mut t = tim1_pwm(40, 10, 1 | 4 | 8);
        let e = edges(&mut t, 99);
        let (s, c) = (Some(true), Some(false));
        assert_eq!(e, vec![(0, c, s), (10, s, s), (40, c, s), (50, c, c)]);
        // CC1P as well: both active low, never both low (on) together.
        let mut t = tim1_pwm(40, 10, 1 | 2 | 4 | 8);
        let e = edges(&mut t, 99);
        assert_eq!(e, vec![(0, s, s), (10, c, s), (40, s, s), (50, s, c)]);
        // CH1N alone (CC1E off): OC1N follows OCxREF, not its complement.
        let mut t = tim1_pwm(40, 10, 4);
        let e = edges(&mut t, 99);
        assert_eq!(e, vec![(0, None, s), (40, None, c)]);
        // ... and with OSSR the disabled CH1 is driven inactive.
        t.write(0x44, MOE | OSSR | 10, u32::MAX, 99);
        assert_eq!(t.output(0), Some(false));
    }

    #[test]
    fn moe_off_drives_the_idle_levels_with_ossi() {
        let mut t = tim1_pwm(40, 10, 1 | 4);
        t.sync(20);
        assert_eq!((t.output(0), t.output_n(0)), (Some(true), Some(false)));
        // MOE off, OSSI off: not driven.
        t.write(0x44, 10, u32::MAX, 20);
        assert_eq!((t.output(0), t.output_n(0)), (None, None));
        // OSSI: the idle levels OIS1 = 0, OIS1N = 1.
        t.write(0x04, 1 << 9, u32::MAX, 20);
        t.write(0x44, OSSI | 10, u32::MAX, 20);
        assert_eq!((t.output(0), t.output_n(0)), (Some(false), Some(true)));
        // OIS1 = 1, OIS1N = 0; a channel with both outputs off stays off.
        t.write(0x04, 1 << 8, u32::MAX, 20);
        assert_eq!((t.output(0), t.output_n(0)), (Some(true), Some(false)));
        assert_eq!((t.output(1), t.output_n(1)), (None, None));
        // No edges are scheduled for idle outputs.
        t.write(0x18, 0, u32::MAX, 20); // CH1 frozen
        assert_eq!(t.next_event(), None);
    }

    #[test]
    fn break_from_bkin_or_bg_clears_moe_and_sets_bif() {
        // BKIN active high, break interrupt on.
        let mut t = tim1_pwm(40, 10, 1 | 4);
        t.write(0x0C, BIF, u32::MAX, 0);
        t.write(0x04, 0, u32::MAX, 0);
        t.write(0x44, MOE | OSSI | BKE | BKP | 10, u32::MAX, 0);
        assert!(t.set_break_input(true, false, 0));
        assert!(t.moe());
        t.sync(20);
        assert_eq!(t.output(0), Some(true));
        assert!(t.set_break_input(true, true, 25));
        assert!(!t.moe());
        assert_ne!(t.sr & BIF, 0);
        assert!(t.irq_break());
        assert_eq!((t.output(0), t.output_n(0)), (Some(false), Some(false)));
        // While the input is active MOE cannot be set and BIF stays.
        t.write(0x44, MOE | OSSI | BKE | BKP | 10, u32::MAX, 30);
        t.write(0x10, 0, u32::MAX, 30);
        assert!(!t.moe());
        assert_ne!(t.sr & BIF, 0);
        // Released: BIF clears, MOE can be set again.
        t.set_break_input(true, false, 40);
        t.write(0x10, 0, u32::MAX, 40);
        assert!(!t.irq_break());
        t.write(0x44, MOE | OSSI | BKE | BKP | 10, u32::MAX, 40);
        assert!(t.moe());
        // BKP = 0: active low.
        t.write(0x44, MOE | BKE | 10, u32::MAX, 41);
        assert!(!t.moe(), "the pin is low: break");
        // Without BKE the pin does nothing, but EGR.BG breaks.
        let mut t = tim1_pwm(40, 10, 1 | 4);
        t.set_break_input(true, true, 0);
        t.write(0x44, MOE | BKP | 10, u32::MAX, 0);
        assert!(t.moe());
        t.write(0x14, BG, u32::MAX, 5);
        assert!(!t.moe());
        assert_ne!(t.sr & BIF, 0);
        assert_eq!((t.output(0), t.output_n(0)), (None, None));
    }

    #[test]
    fn aoe_sets_moe_again_at_the_next_update() {
        let mut t = tim1_pwm(40, 10, 1 | 4);
        t.write(0x44, MOE | AOE | BKE | BKP | 10, u32::MAX, 0);
        t.set_break_input(true, true, 10);
        assert!(!t.moe());
        // Still active at the update: stays off.
        t.sync(100);
        assert!(!t.moe());
        t.set_break_input(true, false, 130);
        assert!(!t.moe(), "not before the update");
        // The outputs are off, but the update at 200 is scheduled: it
        // sets MOE.
        assert_eq!(t.next_event(), Some(200));
        t.sync(200);
        assert!(t.moe());
        // Without AOE it stays off.
        let mut t = tim1_pwm(40, 10, 1 | 4);
        t.write(0x14, BG, u32::MAX, 10);
        t.sync(500);
        assert!(!t.moe());
    }

    #[test]
    fn forced_levels_get_dead_time_too() {
        let mut t = tim1();
        t.write(0x20, 1 | 4, u32::MAX, 0);
        t.write(0x44, MOE | 20, u32::MAX, 0);
        // Force inactive: CH1N on after the dead time.
        t.write(0x18, 4 << 4, u32::MAX, 0);
        assert_eq!((t.output(0), t.output_n(0)), (Some(false), Some(true)));
        t.write(0x18, 5 << 4, u32::MAX, 100);
        assert_eq!((t.output(0), t.output_n(0)), (Some(false), Some(false)));
        // The edge is scheduled though the counter is stopped.
        assert_eq!(t.next_event(), Some(120));
        t.sync(120);
        assert_eq!((t.output(0), t.output_n(0)), (Some(true), Some(false)));
        t.write(0x18, 4 << 4, u32::MAX, 300);
        assert_eq!((t.output(0), t.output_n(0)), (Some(false), Some(false)));
        t.sync(320);
        assert_eq!((t.output(0), t.output_n(0)), (Some(false), Some(true)));
    }

    #[test]
    fn com_event_takes_over_the_preloaded_enables_and_modes() {
        let mut t = tim1();
        t.write(0x44, MOE, u32::MAX, 0);
        t.write(0x18, 5 << 4, u32::MAX, 0); // CH1 forced active
        t.write(0x20, 1, u32::MAX, 0);
        t.write(0x0C, COMIF, u32::MAX, 0);
        assert_eq!(t.output(0), Some(true));
        // CCPC: the next step is written ahead and has no effect yet.
        t.write(0x04, CCPC, u32::MAX, 0);
        t.write(0x18, 4 << 4 | 5 << 12, u32::MAX, 10); // CH1 inactive, CH2 active
        t.write(0x20, 1 << 4 | 1 << 6, u32::MAX, 10); // CH2 and CH2N
        assert_eq!(t.output(0), Some(true));
        assert_eq!(t.output(1), None);
        assert_eq!(t.sr & COMIF, 0);
        // COMG: all at once.
        t.write(0x14, COMG, u32::MAX, 20);
        assert_eq!(t.output(0), None);
        assert_eq!((t.output(1), t.output_n(1)), (Some(true), Some(false)));
        assert_ne!(t.sr & COMIF, 0);
        assert!(t.irq_trg_com());
        // Polarity is not preloaded.
        t.write(0x20, 1 << 4 | 1 << 5 | 1 << 6, u32::MAX, 30);
        assert_eq!(t.output(1), Some(false));
    }

    // ------------------------------------- center-aligned mode, RCR (M28)

    /// TIM3 at one tick per cycle, ARR 8, CH1 PWM `mode` at CCR1 3, in
    /// center-aligned mode `cms`, started at cycle 0.
    fn tim3_center(cms: u32, mode: u32) -> Timer {
        let mut t = tim3();
        t.write(0x2C, 8, u32::MAX, 0);
        t.write(0x18, mode << 4, u32::MAX, 0);
        t.write(0x34, 3, u32::MAX, 0);
        t.write(0x20, 1, u32::MAX, 0);
        t.write(0x00, cms << CMS_SHIFT, u32::MAX, 0);
        t.write(0x14, 1, u32::MAX, 0); // UG
        t.write(0x10, 0, u32::MAX, 0);
        t.write(0x00, CEN | cms << CMS_SHIFT, u32::MAX, 0);
        t
    }

    #[test]
    fn center_aligned_counter_runs_up_and_down_with_dir_read_only() {
        // RM0368 fig. 46 (ARR = 6 there): 0 1 … ARR−1 ARR ARR−1 … 1 0 1 …,
        // overflow at ARR and underflow at 0, each an update event.
        let mut t = tim3_center(1, 6);
        let mut seen = Vec::new();
        for c in 0..=34 {
            t.sync(c);
            seen.push((t.read(0x24), t.read(0x00) & DIR != 0));
        }
        let want: Vec<(u32, bool)> = (0..=34u32)
            .map(|c| {
                let p = c % 16;
                if p < 8 {
                    (p, false)
                } else {
                    (16 - p, true)
                }
            })
            .collect();
        assert_eq!(seen, want);
        // DIR is read-only: writing it changes nothing.
        t.write(0x00, CEN | 1 << CMS_SHIFT | DIR, u32::MAX, 34);
        assert_eq!(t.read(0x00) & DIR, 0, "counting up at 34");
        t.sync(39);
        assert_eq!((t.read(0x24), t.read(0x00) & DIR), (7, 0));
        t.sync(40);
        assert_eq!((t.read(0x24), t.read(0x00) & DIR), (8, DIR));
        // Update flag at the overflow (cycle 8) and the underflow (16).
        let mut t = tim3_center(1, 6);
        t.sync(7);
        assert_eq!(t.sr & UIF, 0);
        t.sync(8);
        assert_ne!(t.sr & UIF, 0, "overflow");
        t.write(0x10, 0, u32::MAX, 8);
        t.sync(15);
        assert_eq!(t.sr & UIF, 0);
        t.sync(16);
        assert_ne!(t.sr & UIF, 0, "underflow");
        // With the update interrupt on (and the PWM output off), both are
        // scheduled.
        t.write(0x20, 0, u32::MAX, 16);
        t.write(0x0C, UIF, u32::MAX, 16);
        assert_eq!(t.next_event(), Some(24));
        t.sync(24);
        assert_eq!(t.next_event(), Some(32));
        // Edge-aligned again: DIR as written.
        t.write(0x00, CEN | DIR, u32::MAX, 24);
        assert_ne!(t.read(0x00) & DIR, 0);
    }

    #[test]
    fn center_aligned_pwm_is_symmetric_about_the_underflow() {
        // PWM 1, CCR 3, ARR 8: active while CNT < 3 counting up and
        // CNT ≤ 3 counting down — 6 ticks centred on the underflow at 16.
        let mut t = tim3_center(1, 6);
        let mut e = vec![(0, t.output(0))];
        while let Some(at) = t.next_event().filter(|&a| a <= 50) {
            t.sync(at);
            if e.last().unwrap().1 != t.output(0) {
                e.push((at, t.output(0)));
            }
        }
        let (h, l) = (Some(true), Some(false));
        assert_eq!(
            e,
            vec![(0, h), (3, l), (13, h), (19, l), (29, h), (35, l), (45, h)]
        );
        // PWM 2: the complement, centred on the overflow.
        let mut t = tim3_center(3, 7);
        let mut e = vec![(0, t.output(0))];
        while let Some(at) = t.next_event().filter(|&a| a <= 40) {
            t.sync(at);
            if e.last().unwrap().1 != t.output(0) {
                e.push((at, t.output(0)));
            }
        }
        assert_eq!(e, vec![(0, l), (3, h), (13, l), (19, h), (29, l), (35, h)]);
        // CCR 0: never active; CCR ≥ ARR: always (PWM 1).
        let mut t = tim3_center(1, 6);
        t.write(0x34, 0, u32::MAX, 0);
        for c in [0, 5, 8, 12, 16, 20] {
            t.sync(c);
            assert_eq!(t.output(0), l, "{c}");
        }
        t.write(0x34, 8, u32::MAX, 20);
        for c in [20, 24, 25, 31, 32, 40] {
            t.sync(c);
            assert_eq!(t.output(0), h, "{c}");
        }
    }

    #[test]
    fn center_aligned_compare_flags_follow_cms() {
        // CCR 3 is passed counting up at 3 and down at 13.
        for (cms, up, down) in [(1, false, true), (2, true, false), (3, true, true)] {
            let mut t = tim3_center(cms, 1); // active on match
            t.write(0x0C, CC_IF[0], u32::MAX, 0);
            t.sync(3);
            assert_eq!(t.sr & CC_IF[0] != 0, up, "CMS {cms} up");
            assert_eq!(t.output(0), Some(true), "the output matches either way");
            t.write(0x10, 0, u32::MAX, 3);
            t.sync(13);
            assert_eq!(t.sr & CC_IF[0] != 0, down, "CMS {cms} down");
            // Whole periods skipped at once flag the same way.
            t.write(0x10, 0, u32::MAX, 13);
            t.write(0x0C, 0, u32::MAX, 13);
            t.sync(13 + 16 * 100);
            assert_eq!(t.sr & CC_IF[0] != 0, up || down, "CMS {cms} periods");
        }
        // CMS 1 with the compare interrupt: the down match at 13 is due.
        let mut t = tim3_center(1, 6);
        t.sync(4);
        t.write(0x0C, CC_IF[0], u32::MAX, 4);
        assert_eq!(t.next_event(), Some(13));
    }

    #[test]
    fn a_late_sync_does_not_skip_an_update_with_side_effects() {
        // ARR 9, RCR 2: the update is at 30. A sync straight to 30 must run
        // it — one-pulse mode stops there, UDE asks for a DMA transfer.
        let mut t = tim1();
        t.write(0x2C, 9, u32::MAX, 0);
        t.write(0x30, 2, u32::MAX, 0);
        t.write(0x14, 1, u32::MAX, 0);
        t.write(0x10, 0, u32::MAX, 0);
        t.write(0x00, CEN | OPM, u32::MAX, 0);
        assert_eq!(t.next_event(), Some(30));
        t.sync(30);
        assert!(!t.running(), "one pulse ends at the update");
        assert_ne!(t.sr & UIF, 0);
        // Not before it: syncing past 20 only leaves it running.
        let mut t = tim1();
        t.write(0x2C, 9, u32::MAX, 0);
        t.write(0x30, 2, u32::MAX, 0);
        t.write(0x14, 1, u32::MAX, 0);
        t.write(0x10, 0, u32::MAX, 0);
        t.write(0x00, CEN | OPM, u32::MAX, 0);
        t.sync(29);
        assert!(t.running());
        t.sync(1_000);
        assert!(!t.running());
        assert_eq!(t.read(0x24), 0);
        // UDE: the request at 30.
        let mut t = tim1();
        t.write(0x2C, 9, u32::MAX, 0);
        t.write(0x30, 2, u32::MAX, 0);
        t.write(0x14, 1, u32::MAX, 0);
        t.write(0x10, 0, u32::MAX, 0);
        t.write(0x0C, UDE, u32::MAX, 0);
        t.dma_req = 0;
        t.write(0x00, CEN, u32::MAX, 0);
        t.sync(29);
        assert_eq!(t.dma_req & 1, 0);
        t.sync(30);
        assert_eq!(t.dma_req & 1, 1, "the update's DMA request");
        // Center-aligned, RCR 3: updates every fourth turn (at 32 with ARR 8).
        let mut t = tim1();
        t.write(0x2C, 8, u32::MAX, 0);
        t.write(0x30, 3, u32::MAX, 0);
        t.write(0x00, 1 << CMS_SHIFT, u32::MAX, 0);
        t.write(0x14, 1, u32::MAX, 0);
        t.write(0x10, 0, u32::MAX, 0);
        t.write(0x00, 1 << CMS_SHIFT | CEN | OPM, u32::MAX, 0);
        t.sync(31);
        assert!(t.running());
        t.sync(32);
        assert!(!t.running(), "stopped at the fourth turn");
    }

    #[test]
    fn a_zero_arr_loaded_at_an_update_stops_a_center_aligned_counter() {
        let mut t = tim3();
        t.write(0x2C, 8, u32::MAX, 0);
        t.write(0x14, 1, u32::MAX, 0);
        t.write(0x10, 0, u32::MAX, 0);
        t.write(0x00, CEN | ARPE | 1 << CMS_SHIFT, u32::MAX, 0);
        t.write(0x2C, 0, u32::MAX, 0); // preloaded: loads at the update
        t.sync(8);
        t.sync(1_000); // no panic, no counting
        assert_eq!(t.next_event(), None);
    }

    #[test]
    fn repetition_counter_spaces_the_update_events() {
        // Edge-aligned, ARR 9 (10 cycles), RCR 2: an update every third
        // overflow — UIF at 30 and 60, not at 10 or 20.
        let mut t = tim1();
        t.write(0x2C, 9, u32::MAX, 0);
        t.write(0x30, 2, u32::MAX, 0);
        t.write(0x14, 1, u32::MAX, 0); // UG loads RCR
        t.write(0x10, 0, u32::MAX, 0);
        t.write(0x0C, UIF, u32::MAX, 0);
        t.write(0x00, CEN, u32::MAX, 0);
        assert_eq!(t.next_event(), Some(30), "the interrupt is due at 30");
        for c in [10, 20, 29] {
            t.sync(c);
            assert_eq!(t.sr & UIF, 0, "{c}");
        }
        t.sync(30);
        assert_ne!(t.sr & UIF, 0);
        t.write(0x10, 0, u32::MAX, 30);
        assert_eq!(t.next_event(), Some(60));
        // Preloaded: a new ARR waits for the update event.
        t.write(0x00, CEN | ARPE, u32::MAX, 30);
        t.write(0x2C, 4, u32::MAX, 31);
        t.sync(55);
        assert_eq!(t.read(0x24), 5, "still ARR 9 at the overflows at 40, 50");
        t.sync(60);
        t.sync(64);
        assert_eq!(t.read(0x24), 4, "ARR 4 from the update at 60");
        // Many periods at once: UIF only if an update came.
        let mut t = tim1();
        t.write(0x2C, 9, u32::MAX, 0);
        t.write(0x30, 99, u32::MAX, 0);
        t.write(0x14, 1, u32::MAX, 0);
        t.write(0x10, 0, u32::MAX, 0);
        t.write(0x00, CEN, u32::MAX, 0);
        t.sync(999);
        assert_eq!(t.sr & UIF, 0, "99 overflows, no update yet");
        t.sync(1000);
        assert_ne!(t.sr & UIF, 0, "the 100th");
        // Center-aligned, RCR 1: every second half period — after UG at
        // the underflows only (16, 32), not the overflows (8, 24).
        let mut t = tim1();
        t.write(0x2C, 8, u32::MAX, 0);
        t.write(0x30, 1, u32::MAX, 0);
        t.write(0x00, 1 << CMS_SHIFT, u32::MAX, 0);
        t.write(0x14, 1, u32::MAX, 0);
        t.write(0x10, 0, u32::MAX, 0);
        t.write(0x0C, UIF, u32::MAX, 0);
        t.write(0x00, CEN | 1 << CMS_SHIFT, u32::MAX, 0);
        let mut ups = Vec::new();
        while let Some(at) = t.next_event().filter(|&a| a <= 70) {
            t.sync(at);
            if t.sr & UIF != 0 {
                ups.push((at, t.read(0x24)));
                t.write(0x10, 0, u32::MAX, at);
            }
        }
        assert_eq!(ups, vec![(16, 0), (32, 0), (48, 0), (64, 0)]);
        // Many center-aligned periods at once (two over/underflows each):
        // ARR 8, RCR 5 — an update every 6 half periods, at 48, 96, …
        let mut t = tim1();
        t.write(0x2C, 8, u32::MAX, 0);
        t.write(0x30, 5, u32::MAX, 0);
        t.write(0x00, 1 << CMS_SHIFT, u32::MAX, 0);
        t.write(0x14, 1, u32::MAX, 0);
        t.write(0x10, 0, u32::MAX, 0);
        t.write(0x00, CEN | 1 << CMS_SHIFT, u32::MAX, 0);
        t.sync(47);
        assert_eq!(t.sr & UIF, 0);
        t.sync(48);
        assert_ne!(t.sr & UIF, 0, "the sixth half period");
        t.write(0x10, 0, u32::MAX, 48);
        t.sync(48 + 48 * 20 - 1);
        t.write(0x10, 0, u32::MAX, 48 + 48 * 20 - 1);
        t.sync(48 + 48 * 20);
        assert_ne!(t.sr & UIF, 0, "twenty updates later");
        // RCR 0 in center-aligned mode: both.
        let mut t = tim1();
        t.write(0x2C, 8, u32::MAX, 0);
        t.write(0x00, CEN | 3 << CMS_SHIFT, u32::MAX, 0);
        t.sync(8);
        assert_ne!(t.sr & UIF, 0);
        // One-pulse mode stops at the update event, after RCR + 1 periods.
        let mut t = tim1();
        t.write(0x2C, 9, u32::MAX, 0);
        t.write(0x30, 2, u32::MAX, 0);
        t.write(0x14, 1, u32::MAX, 0);
        t.write(0x00, CEN | OPM, u32::MAX, 0);
        t.sync(25);
        assert!(t.running(), "not after the first two periods");
        t.sync(100);
        assert!(!t.running());
    }

    #[test]
    fn center_aligned_complementary_outputs_keep_their_dead_time() {
        // TIM1 CH1/CH1N, ARR 100, CCR 40, dead time 10: OC1REF high for
        // [0, 40) and [160, 240) (centred on the underflow at 200).
        let mut t = tim1();
        t.write(0x2C, 100, u32::MAX, 0);
        t.write(0x34, 40, u32::MAX, 0);
        t.write(0x18, 6 << 4, u32::MAX, 0);
        t.write(0x20, 1 | 4, u32::MAX, 0);
        t.write(0x44, MOE | 10, u32::MAX, 0);
        t.write(0x00, CEN | 1 << CMS_SHIFT, u32::MAX, 0);
        let e = edges(&mut t, 450);
        let (s, c) = (Some(true), Some(false));
        assert_eq!(
            e,
            vec![
                (0, c, c),
                (10, s, c),
                (40, c, c),
                (50, c, s),
                (160, c, c),
                (170, s, c),
                (240, c, c),
                (250, c, s),
                (360, c, c),
                (370, s, c),
                (440, c, c),
                (450, c, s),
            ]
        );
        // Looked at late (a register access at 163, after OC1REF rose at
        // 160 counting down): CH1 still turns on at 170.
        let mut t = tim1();
        t.write(0x2C, 100, u32::MAX, 0);
        t.write(0x34, 40, u32::MAX, 0);
        t.write(0x18, 6 << 4, u32::MAX, 0);
        t.write(0x20, 1 | 4, u32::MAX, 0);
        t.write(0x44, MOE | 10, u32::MAX, 0);
        t.write(0x00, CEN | 1 << CMS_SHIFT, u32::MAX, 0);
        t.sync(100);
        t.sync(163);
        assert_eq!((t.output(0), t.output_n(0)), (c, c));
        assert_eq!(t.next_event(), Some(170));
        // A preloaded CCR1 going from 0 to 40 takes effect at the update
        // event (the underflow at 200): OC1REF rises there, CH1N falls
        // there and CH1 waits the dead time — even looked at late.
        let mut t = tim1();
        t.write(0x2C, 100, u32::MAX, 0);
        t.write(0x18, 6 << 4 | 1 << 3, u32::MAX, 0);
        t.write(0x20, 1 | 4, u32::MAX, 0);
        t.write(0x44, MOE | 10, u32::MAX, 0);
        t.write(0x00, CEN | ARPE | 1 << CMS_SHIFT, u32::MAX, 0);
        t.sync(150);
        assert_eq!((t.output(0), t.output_n(0)), (c, s));
        t.write(0x34, 40, u32::MAX, 150);
        assert_eq!(
            (t.output(0), t.output_n(0)),
            (c, s),
            "not before the update"
        );
        t.sync(203);
        assert_eq!((t.output(0), t.output_n(0)), (c, c));
        assert_eq!(t.next_event(), Some(210));
        t.sync(210);
        assert_eq!((t.output(0), t.output_n(0)), (s, c));
    }
}
