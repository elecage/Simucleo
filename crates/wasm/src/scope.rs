//! Oscilloscope-style trigger and capture over the probed pins.
//!
//! Every level change of a probed pin goes into a bounded ring buffer of
//! that pin (time in ns, new level), at the CPU-cycle resolution the bus
//! timestamps it with. The trigger is checked on the source pin's edges
//! only; once it fires, the window around it (the part before the trigger
//! comes from the rings) is collected edge by edge, at full resolution, and
//! handed over whole when the simulation has passed its end.
//!
//! Analog channels (net voltages, M22) work the same way with samples
//! (time, volts) instead of edges: a voltage is constant between two
//! samples (it only changes when the circuit's operating point does). A
//! level trigger fires when the source's voltage goes through a threshold,
//! re-armed only after it has been beyond the hysteresis band on the
//! other side.

use std::collections::VecDeque;

use serde::Deserialize;

/// Most edges kept per probed pin (the pre-trigger history).
pub const RING_EDGES: usize = 65536;
/// Most edges a capture holds per pin.
pub const CAPTURE_EDGES: usize = 65536;
/// Most samples kept per analog channel (the pre-trigger history).
pub const RING_SAMPLES: usize = 65536;
/// Most samples a capture holds per analog channel.
pub const CAPTURE_SAMPLES: usize = 65536;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Edge {
    Rising,
    Falling,
    Either,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Captures on triggers; the UI free-runs without them.
    Auto,
    /// Captures on every trigger, re-arming after each.
    Normal,
    /// One capture, then stops until armed again.
    Single,
}

/// Pulse-width condition: the pulse (high for a rising trigger, low for a
/// falling one, either for both) is narrower (`lt`) or wider (`gt`) than
/// `ns`. The trigger point is then the pulse's leading edge.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Width {
    pub cmp: Cmp,
    pub ns: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Cmp {
    Lt,
    Gt,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// Source pin, e.g. `"PC7"`.
    pub source: String,
    pub edge: Edge,
    pub mode: Mode,
    /// Captured span (10 divisions of the timebase), in ns.
    pub window_ns: f64,
    /// Share of the window before the trigger (0.1 … 0.9).
    pub pre: f64,
    #[serde(default)]
    pub width: Option<Width>,
    /// Ask the caller to pause when a capture is complete.
    #[serde(default)]
    pub pause: bool,
    /// Threshold (V) of a level trigger on an analog source (default
    /// 1.65 V, half the supply).
    #[serde(default)]
    pub level: Option<f64>,
    /// Hysteresis (V): the voltage must have been this far on the other
    /// side of the threshold before it can trigger again.
    #[serde(default)]
    pub hysteresis: f64,
}

/// One pin of a capture. Times are in ns relative to the trigger.
#[derive(Debug, Clone, PartialEq)]
pub struct Channel {
    pub name: String,
    /// Level at the start of the window (before the first edge).
    pub level0: bool,
    pub edges: Vec<(f64, bool)>,
    /// The edges are complete from here (later than the window's start when
    /// the ring buffer had already dropped older ones)…
    pub from_ns: f64,
    /// … up to here (earlier than its end when the capture was full).
    pub to_ns: f64,
}

/// One analog channel of a capture. Times in ns relative to the trigger.
#[derive(Debug, Clone, PartialEq)]
pub struct AnalogChannel {
    pub name: String,
    /// Voltage at the start of the window (before the first sample).
    pub v0: f64,
    /// (time, volts): the voltage from then until the next sample.
    pub samples: Vec<(f64, f64)>,
    pub from_ns: f64,
    pub to_ns: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Capture {
    pub seq: u32,
    pub source: String,
    /// Absolute time of the trigger, in ns.
    pub trigger_ns: f64,
    /// Window, relative to the trigger.
    pub start_ns: f64,
    pub end_ns: f64,
    pub channels: Vec<Channel>,
    pub analog: Vec<AnalogChannel>,
}

#[derive(Debug, Default)]
struct Ring {
    name: String,
    edges: VecDeque<(f64, bool)>,
    /// Level before the oldest edge kept.
    level0: bool,
    /// Present level.
    level: bool,
    /// Time of the newest edge dropped for room.
    lost_until: Option<f64>,
    /// When the pin began to be watched: nothing is known before.
    since: f64,
}

impl Ring {
    /// Level just before `t`.
    fn level_before(&self, t: f64) -> bool {
        let i = self.edges.partition_point(|e| e.0 < t);
        if i == 0 {
            self.level0
        } else {
            self.edges[i - 1].1
        }
    }
}

/// Samples of one analog channel.
#[derive(Debug, Default)]
struct ARing {
    name: String,
    samples: VecDeque<(f64, f64)>,
    /// Voltage before the oldest sample kept.
    v0: f64,
    /// Present voltage.
    v: f64,
    lost_until: Option<f64>,
    since: f64,
}

impl ARing {
    fn value_before(&self, t: f64) -> f64 {
        let i = self.samples.partition_point(|e| e.0 < t);
        if i == 0 {
            self.v0
        } else {
            self.samples[i - 1].1
        }
    }
}

/// The trigger's source channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Src {
    Digital(usize),
    Analog(usize),
}

#[derive(Debug)]
enum State {
    /// Waiting for a trigger on an edge later than `after`.
    Armed { after: f64 },
    /// Triggered; the window ends at `end` (absolute ns).
    Collecting { cap: Capture, end: f64 },
    /// Single capture done.
    Stopped,
}

/// What the scope is doing, for the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// No trigger set.
    Off,
    /// The trigger's source pin is not probed.
    NoSource,
    Armed,
    Collecting,
    Stopped,
}

impl Status {
    pub fn name(self) -> &'static str {
        match self {
            Status::Off => "off",
            Status::NoSource => "nosource",
            Status::Armed => "armed",
            Status::Collecting => "collecting",
            Status::Stopped => "stopped",
        }
    }
}

#[derive(Debug)]
pub struct Scope {
    rings: Vec<Ring>,
    analog: Vec<ARing>,
    config: Option<Config>,
    source: Option<Src>,
    /// Level trigger: the source has been below (rising) / above
    /// (falling) the hysteresis band since it last triggered.
    armed_low: bool,
    armed_high: bool,
    state: State,
    /// Latest time seen (edges, or `advance`).
    now: f64,
    seq: u32,
    ready: Option<Capture>,
    pause_hit: bool,
}

impl Default for Scope {
    fn default() -> Self {
        Self::new()
    }
}

impl Scope {
    pub fn new() -> Self {
        Self {
            rings: Vec::new(),
            analog: Vec::new(),
            config: None,
            source: None,
            armed_low: false,
            armed_high: false,
            state: State::Armed { after: f64::MIN },
            now: 0.0,
            seq: 0,
            ready: None,
            pause_hit: false,
        }
    }

    /// The probed pins, in the order `push` numbers them, with their levels
    /// at `now` (ns), when watching them starts. History is dropped and the
    /// trigger re-armed.
    pub fn set_channels(&mut self, pins: Vec<(String, bool)>, now: f64) {
        self.now = self.now.max(now);
        self.rings = pins
            .into_iter()
            .map(|(name, level)| Ring {
                name,
                level0: level,
                level,
                since: now,
                ..Default::default()
            })
            .collect();
        self.resolve_source();
        self.arm();
    }

    /// The analog channels (names, voltages at `now`), numbered for
    /// `push_analog`. Their history is dropped and the trigger re-armed.
    pub fn set_analog(&mut self, channels: Vec<(String, f64)>, now: f64) {
        self.now = self.now.max(now);
        self.analog = channels
            .into_iter()
            .map(|(name, v)| ARing {
                name,
                v0: v,
                v,
                since: now,
                ..Default::default()
            })
            .collect();
        self.resolve_source();
        self.arm();
    }

    /// Set (or clear) the trigger and re-arm.
    pub fn configure(&mut self, config: Option<Config>) {
        self.config = config.map(|mut c| {
            c.pre = c.pre.clamp(0.0, 1.0);
            c.window_ns = c.window_ns.max(1.0);
            c
        });
        self.resolve_source();
        self.ready = None;
        self.arm();
    }

    fn resolve_source(&mut self) {
        self.source = self.config.as_ref().and_then(|c| {
            self.rings
                .iter()
                .position(|r| r.name == c.source)
                .map(Src::Digital)
                .or_else(|| {
                    self.analog
                        .iter()
                        .position(|r| r.name == c.source)
                        .map(Src::Analog)
                })
        });
    }

    /// Wait for the next trigger (after now): Single's "arm" button.
    pub fn arm(&mut self) {
        self.state = State::Armed { after: self.now };
        self.pause_hit = false;
        self.arm_level();
    }

    /// Threshold and hysteresis of the level trigger.
    fn level(&self) -> (f64, f64) {
        let c = self.config.as_ref();
        (
            c.and_then(|c| c.level).unwrap_or(1.65),
            c.map_or(0.0, |c| c.hysteresis.max(0.0)),
        )
    }

    /// Start the level trigger from the source's present voltage: a
    /// crossing needs it to have been on the other side first.
    fn arm_level(&mut self) {
        let Some(Src::Analog(ch)) = self.source else {
            return;
        };
        let v = self.analog[ch].v;
        let (level, h) = self.level();
        self.armed_low = v < level - h;
        self.armed_high = v > level + h;
    }

    /// The machine was reset (time starts again): drop the history and
    /// re-arm, with the pins at `levels` (in channel order).
    pub fn reset(&mut self, levels: &[bool], volts: &[f64]) {
        for (r, &v) in self.analog.iter_mut().zip(volts) {
            r.samples.clear();
            r.v0 = v;
            r.v = v;
            r.lost_until = None;
            r.since = f64::MIN;
        }
        for (r, &l) in self.rings.iter_mut().zip(levels) {
            r.edges.clear();
            r.level0 = l;
            r.level = l;
            r.lost_until = None;
            // Watched from the boot on.
            r.since = f64::MIN;
        }
        self.now = f64::MIN;
        self.ready = None;
        self.arm();
    }

    pub fn status(&self) -> Status {
        if self.config.is_none() {
            return Status::Off;
        }
        if self.source.is_none() {
            return Status::NoSource;
        }
        match self.state {
            State::Armed { .. } => Status::Armed,
            State::Collecting { .. } => Status::Collecting,
            State::Stopped => Status::Stopped,
        }
    }

    /// Whether a pause on trigger is pending: the run should go in steps
    /// short enough to stop soon after the capture.
    pub fn watching_for_pause(&self) -> bool {
        self.config.as_ref().is_some_and(|c| c.pause)
            && matches!(self.status(), Status::Armed | Status::Collecting)
    }

    /// Run-step length while `watching_for_pause`, in ns: up to the
    /// window's end while collecting.
    pub fn step_ns(&self, now: f64) -> f64 {
        let w = self.config.as_ref().map_or(1e6, |c| c.window_ns);
        match &self.state {
            State::Collecting { end, .. } => (end - now).max(1.0),
            _ => w.clamp(20e3, 1e6),
        }
    }

    /// A capture completed with "pause on trigger" set (cleared on read).
    pub fn take_pause_hit(&mut self) -> bool {
        std::mem::take(&mut self.pause_hit)
    }

    /// The latest completed capture, once.
    pub fn take_capture(&mut self) -> Option<Capture> {
        self.ready.take()
    }

    /// Pin `ch` changed to `level` at `t` (ns). Edges come in time order.
    pub fn push(&mut self, ch: usize, t: f64, level: bool) {
        let Some(ring) = self.rings.get_mut(ch) else {
            return;
        };
        if ring.level == level {
            return;
        }
        ring.level = level;
        if ring.edges.len() >= RING_EDGES {
            if let Some((lt, ll)) = ring.edges.pop_front() {
                ring.level0 = ll;
                ring.lost_until = Some(lt);
            }
        }
        ring.edges.push_back((t, level));
        self.now = self.now.max(t);

        if let State::Collecting { end, .. } = self.state {
            if t > end {
                self.finish();
            }
        }
        if let State::Collecting { cap, .. } = &mut self.state {
            let c = &mut cap.channels[ch];
            let rel = t - cap.trigger_ns;
            if c.to_ns >= rel {
                if c.edges.len() < CAPTURE_EDGES {
                    c.edges.push((rel, level));
                } else {
                    // Full: what follows is not known.
                    c.to_ns = rel;
                }
            }
            return;
        }
        if let State::Armed { after } = self.state {
            if Some(Src::Digital(ch)) == self.source && t >= after {
                if let Some(t0) = self.trigger_at(ch, level) {
                    self.start(t0);
                }
            }
        }
    }

    /// Analog channel `ch` changed to `v` volts at `t` (ns), in time order.
    pub fn push_analog(&mut self, ch: usize, t: f64, v: f64) {
        if self.analog.get(ch).is_none_or(|r| r.v == v) {
            return;
        }
        // A capture this sample is past ends first, so the trigger re-arms
        // from the voltage before it (the sample may be the next crossing).
        if let State::Collecting { end, .. } = self.state {
            if t > end {
                self.finish();
            }
        }
        let ring = &mut self.analog[ch];
        ring.v = v;
        if ring.samples.len() >= RING_SAMPLES {
            if let Some((lt, lv)) = ring.samples.pop_front() {
                ring.v0 = lv;
                ring.lost_until = Some(lt);
            }
        }
        ring.samples.push_back((t, v));
        self.now = self.now.max(t);

        if let State::Collecting { cap, .. } = &mut self.state {
            let c = &mut cap.analog[ch];
            let rel = t - cap.trigger_ns;
            if c.to_ns >= rel {
                if c.samples.len() < CAPTURE_SAMPLES {
                    c.samples.push((rel, v));
                } else {
                    c.to_ns = rel;
                }
            }
            return;
        }
        if Some(Src::Analog(ch)) != self.source {
            return;
        }
        let State::Armed { after } = self.state else {
            return;
        };
        let Some(edge) = self.config.as_ref().map(|c| c.edge) else {
            return;
        };
        let (level, h) = self.level();
        let rising = self.armed_low && v >= level;
        let falling = self.armed_high && v <= level;
        let fire = t >= after
            && match edge {
                Edge::Rising => rising,
                Edge::Falling => falling,
                Edge::Either => rising || falling,
            };
        if v < level - h {
            self.armed_low = true;
        }
        if v > level + h {
            self.armed_high = true;
        }
        if fire {
            self.armed_low = false;
            self.armed_high = false;
            self.start(t);
        }
    }

    /// Time has reached `now` (ns) with no further edge.
    pub fn advance(&mut self, now: f64) {
        self.now = self.now.max(now);
        if let State::Collecting { end, .. } = self.state {
            if self.now >= end {
                self.finish();
            }
        }
    }

    /// Does the newest edge of `ch` (now at `level`) trigger? Where.
    fn trigger_at(&self, ch: usize, level: bool) -> Option<f64> {
        let c = self.config.as_ref()?;
        let ring = &self.rings[ch];
        let &(t, _) = ring.edges.back()?;
        let matches = |rising: bool| match c.edge {
            Edge::Rising => rising,
            Edge::Falling => !rising,
            Edge::Either => true,
        };
        match c.width {
            None => matches(level).then_some(t),
            Some(w) => {
                // This edge ends a pulse that started with the edge before.
                let n = ring.edges.len();
                if n < 2 {
                    return None;
                }
                let lead = ring.edges[n - 2];
                if !matches(lead.1) {
                    return None;
                }
                let width = t - lead.0;
                let ok = match w.cmp {
                    Cmp::Lt => width < w.ns,
                    Cmp::Gt => width > w.ns,
                };
                ok.then_some(lead.0)
            }
        }
    }

    fn start(&mut self, t0: f64) {
        let Some(c) = &self.config else {
            return;
        };
        let start = t0 - c.pre * c.window_ns;
        let end = t0 + (1.0 - c.pre) * c.window_ns;
        let channels = self
            .rings
            .iter()
            .map(|r| {
                // Complete from the window's start, unless the ring dropped
                // edges after it or the pin was not watched yet.
                let from = r.lost_until.map_or(start, |l| l.max(start)).max(r.since);
                // The ring is in time order: only the window's edges.
                let lo = r.edges.partition_point(|e| e.0 < start);
                let hi = r.edges.partition_point(|e| e.0 <= end);
                let mut edges: Vec<(f64, bool)> =
                    r.edges.range(lo..hi).map(|&(t, l)| (t - t0, l)).collect();
                let mut to_ns = end - t0;
                if edges.len() > CAPTURE_EDGES {
                    to_ns = edges[CAPTURE_EDGES].0;
                    edges.truncate(CAPTURE_EDGES);
                }
                Channel {
                    name: r.name.clone(),
                    level0: r.level_before(start),
                    edges,
                    from_ns: from - t0,
                    to_ns,
                }
            })
            .collect();
        let analog = self
            .analog
            .iter()
            .map(|r| {
                let from = r.lost_until.map_or(start, |l| l.max(start)).max(r.since);
                let lo = r.samples.partition_point(|e| e.0 < start);
                let hi = r.samples.partition_point(|e| e.0 <= end);
                let mut samples: Vec<(f64, f64)> =
                    r.samples.range(lo..hi).map(|&(t, v)| (t - t0, v)).collect();
                let mut to_ns = end - t0;
                if samples.len() > CAPTURE_SAMPLES {
                    to_ns = samples[CAPTURE_SAMPLES].0;
                    samples.truncate(CAPTURE_SAMPLES);
                }
                AnalogChannel {
                    name: r.name.clone(),
                    v0: r.value_before(start),
                    samples,
                    from_ns: from - t0,
                    to_ns,
                }
            })
            .collect();
        self.seq += 1;
        self.state = State::Collecting {
            cap: Capture {
                seq: self.seq,
                source: c.source.clone(),
                trigger_ns: t0,
                start_ns: start - t0,
                end_ns: end - t0,
                channels,
                analog,
            },
            end,
        };
        // A pulse-width trigger fires at the pulse's end, maybe past the
        // window already.
        if self.now >= end {
            self.finish();
        }
    }

    fn finish(&mut self) {
        let State::Collecting { cap, end } = std::mem::replace(&mut self.state, State::Stopped)
        else {
            return;
        };
        self.ready = Some(cap);
        let c = self.config.as_ref();
        if c.is_some_and(|c| c.pause) {
            self.pause_hit = true;
        }
        if c.is_some_and(|c| c.mode != Mode::Single) {
            self.state = State::Armed { after: end };
            self.arm_level();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// CPU clock of the tests' timestamps (ns per cycle = 1e9 / 84 MHz).
    const NS_PER_CYCLE: f64 = 1e9 / 84e6;

    fn config(edge: Edge, mode: Mode, window_ns: f64, pre: f64) -> Config {
        Config {
            source: "PA0".into(),
            edge,
            mode,
            window_ns,
            pre,
            width: None,
            pause: false,
            level: None,
            hysteresis: 0.0,
        }
    }

    fn scope(c: Config) -> Scope {
        let mut s = Scope::new();
        s.set_channels(vec![("PA0".into(), false), ("PA1".into(), false)], f64::MIN);
        s.configure(Some(c));
        s
    }

    /// A square wave on channel 0: high for `high` ns every `period` ns,
    /// starting at `t0`, `n` periods; then time moves on to the end.
    fn square(s: &mut Scope, t0: f64, period: f64, high: f64, n: usize) {
        for i in 0..n {
            let t = t0 + i as f64 * period;
            s.push(0, t, true);
            s.push(0, t + high, false);
        }
        s.advance(t0 + n as f64 * period);
    }

    #[test]
    fn rising_edge_triggers_at_the_edge() {
        let mut s = scope(config(Edge::Rising, Mode::Single, 1000.0, 0.5));
        s.push(0, 100.0, true);
        s.push(0, 300.0, false);
        s.advance(2000.0);
        let c = s.take_capture().expect("captured");
        assert_eq!(c.trigger_ns, 100.0);
        assert_eq!(c.channels[0].edges, vec![(0.0, true), (200.0, false)]);
        assert!(!c.channels[0].level0);
    }

    #[test]
    fn falling_edge_triggers_at_the_falling_edge() {
        let mut s = scope(config(Edge::Falling, Mode::Single, 1000.0, 0.5));
        s.push(0, 100.0, true);
        s.push(0, 300.0, false);
        s.advance(2000.0);
        let c = s.take_capture().expect("captured");
        assert_eq!(c.trigger_ns, 300.0);
        assert_eq!(c.channels[0].edges, vec![(-200.0, true), (0.0, false)]);
    }

    #[test]
    fn either_edge_triggers_on_the_first() {
        let mut s = scope(config(Edge::Either, Mode::Single, 100.0, 0.5));
        s.push(0, 100.0, true);
        s.push(0, 300.0, false);
        s.advance(2000.0);
        assert_eq!(s.take_capture().unwrap().trigger_ns, 100.0);
    }

    #[test]
    fn pre_trigger_edges_are_in_the_capture() {
        // 1 µs period: with 30% of a 10 µs window before the trigger, 3 µs
        // of history (3 periods) show.
        let mut s = scope(config(Edge::Rising, Mode::Single, 10_000.0, 0.3));
        // Arm after the first few edges, as if the trigger was set late.
        square(&mut s, 0.0, 1000.0, 250.0, 6);
        s.configure(Some(config(Edge::Rising, Mode::Single, 10_000.0, 0.3)));
        square(&mut s, 6000.0, 1000.0, 250.0, 20);
        let c = s.take_capture().expect("captured");
        assert_eq!(c.trigger_ns, 6000.0);
        assert_eq!(c.start_ns, -3000.0);
        let ch = &c.channels[0];
        let pre: Vec<_> = ch.edges.iter().filter(|e| e.0 < 0.0).collect();
        // Edges at -3000 (rise) … -750 (fall): 3 rises and 3 falls.
        assert_eq!(pre.len(), 6, "{pre:?}");
        assert_eq!(ch.edges[0], (-3000.0, true));
        assert_eq!(ch.from_ns, -3000.0);
        // And the 7 µs after it (the rise at its very end included).
        assert_eq!(*ch.edges.last().unwrap(), (7000.0, true));
        assert_eq!(ch.to_ns, 7000.0);
    }

    #[test]
    fn other_channels_are_captured_too() {
        let mut s = scope(config(Edge::Rising, Mode::Single, 1000.0, 0.5));
        s.push(1, 50.0, true);
        s.push(0, 1000.0, true);
        s.push(1, 1100.0, false);
        s.push(1, 1700.0, true); // after the window
        s.advance(2000.0);
        let c = s.take_capture().unwrap();
        assert!(c.channels[1].level0);
        assert_eq!(c.channels[1].edges, vec![(100.0, false)]);
    }

    #[test]
    fn single_stops_after_one_capture() {
        let mut s = scope(config(Edge::Rising, Mode::Single, 1000.0, 0.5));
        square(&mut s, 0.0, 10_000.0, 1000.0, 5);
        let c = s.take_capture().unwrap();
        assert_eq!(c.trigger_ns, 0.0);
        assert_eq!(s.status(), Status::Stopped);
        square(&mut s, 50_000.0, 10_000.0, 1000.0, 5);
        assert!(s.take_capture().is_none(), "no capture while stopped");
        // Armed again, it waits for an edge after now.
        s.arm();
        assert_eq!(s.status(), Status::Armed);
        square(&mut s, 100_000.0, 10_000.0, 1000.0, 1);
        assert_eq!(s.take_capture().unwrap().trigger_ns, 100_000.0);
    }

    #[test]
    fn normal_rearms_after_each_capture() {
        let mut s = scope(config(Edge::Rising, Mode::Normal, 1000.0, 0.5));
        let mut seen = Vec::new();
        for i in 0..5 {
            square(&mut s, i as f64 * 10_000.0, 10_000.0, 1000.0, 1);
            seen.push(s.take_capture().expect("captured each period").trigger_ns);
            assert_eq!(s.status(), Status::Armed);
        }
        assert_eq!(seen, vec![0.0, 10_000.0, 20_000.0, 30_000.0, 40_000.0]);
    }

    #[test]
    fn normal_waits_for_the_window_to_end_before_rearming() {
        // Window 3 µs after the trigger; edges every 1 µs: the next trigger
        // is the first rising edge after the window.
        let mut s = scope(config(Edge::Rising, Mode::Normal, 4000.0, 0.25));
        let mut triggers = Vec::new();
        for i in 0..10 {
            let t = i as f64 * 1000.0;
            s.push(0, t, true);
            s.push(0, t + 500.0, false);
            if let Some(c) = s.take_capture() {
                triggers.push(c.trigger_ns);
            }
        }
        assert_eq!(triggers, vec![0.0, 4000.0]);
    }

    #[test]
    fn short_pulse_in_a_long_period_is_captured_exactly() {
        // 2 µs pulse every 20 ms, timestamps on 84 MHz cycles, captured at
        // 1 µs/div (10 µs window).
        let mut s = scope(config(Edge::Rising, Mode::Single, 10_000.0, 0.2));
        let rise_cycle = 84_000u64 * 7 + 13; // somewhere in the 8th ms
        let width_cycles = 168u64; // 2 µs
        for k in 0..3u64 {
            let r = (rise_cycle + k * 84 * 20_000) as f64 * NS_PER_CYCLE;
            s.push(0, r, true);
            s.push(0, r + width_cycles as f64 * NS_PER_CYCLE, false);
        }
        s.advance(1e8);
        let c = s.take_capture().unwrap();
        let e = &c.channels[0].edges;
        assert_eq!(e.len(), 2);
        assert_eq!(e[0], (0.0, true));
        let width = e[1].0 - e[0].0;
        assert!(
            (width - 2000.0).abs() < NS_PER_CYCLE,
            "width {width} ns, not 2 µs"
        );
        assert!(!e[1].1);
    }

    #[test]
    fn pulse_width_trigger_picks_the_narrow_pulse() {
        let mut c = config(Edge::Rising, Mode::Single, 10_000.0, 0.5);
        c.width = Some(Width {
            cmp: Cmp::Lt,
            ns: 1000.0,
        });
        let mut s = scope(c);
        // Wide pulses of 5 µs, one 300 ns pulse among them.
        s.push(0, 0.0, true);
        s.push(0, 5000.0, false);
        s.push(0, 20_000.0, true);
        s.push(0, 25_000.0, false);
        s.push(0, 40_000.0, true);
        s.push(0, 40_300.0, false);
        s.push(0, 60_000.0, true);
        s.advance(100_000.0);
        let cap = s.take_capture().expect("captured");
        assert_eq!(cap.trigger_ns, 40_000.0);
        assert_eq!(cap.channels[0].edges, vec![(0.0, true), (300.0, false)]);
    }

    #[test]
    fn pulse_wider_than_the_post_window_still_completes() {
        let mut c = config(Edge::Rising, Mode::Single, 1000.0, 0.5);
        c.width = Some(Width {
            cmp: Cmp::Gt,
            ns: 2000.0,
        });
        let mut s = scope(c);
        s.push(0, 0.0, true);
        s.push(0, 1000.0, false); // 1 µs: too narrow
        s.push(0, 10_000.0, true);
        s.push(0, 15_000.0, false); // 5 µs: decided at its end
        let cap = s.take_capture().expect("captured at once");
        assert_eq!(cap.trigger_ns, 10_000.0);
        assert_eq!(cap.channels[0].edges, vec![(0.0, true)]);
    }

    #[test]
    fn history_before_probing_is_not_reported() {
        // Probing starts at 1 ms into the run; the trigger comes 100 ns
        // later with half of a 10 µs window before it.
        let mut s = Scope::new();
        s.set_channels(vec![("PA0".into(), false), ("PA1".into(), true)], 1e6);
        s.configure(Some(config(Edge::Rising, Mode::Single, 10_000.0, 0.5)));
        s.push(0, 1e6 + 100.0, true);
        s.advance(1e6 + 20_000.0);
        let cap = s.take_capture().unwrap();
        assert_eq!(cap.start_ns, -5000.0);
        for ch in &cap.channels {
            assert_eq!(ch.from_ns, -100.0, "{}", ch.name);
        }
    }

    #[test]
    fn captures_only_visit_their_window() {
        // Many short Normal captures after a fast signal filled the ring of
        // another pin: they should cost about as much as with an almost
        // empty ring, not grow with the whole history.
        fn run(history: usize) -> std::time::Duration {
            let mut s = scope(config(Edge::Rising, Mode::Normal, 100.0, 0.5));
            s.configure(None);
            for i in 0..history {
                s.push(1, i as f64 * 10.0, i % 2 == 0);
            }
            s.configure(Some(config(Edge::Rising, Mode::Normal, 100.0, 0.5)));
            let t0 = RING_EDGES as f64 * 10.0;
            let started = std::time::Instant::now();
            let mut n = 0;
            for i in 0..20_000 {
                let t = t0 + i as f64 * 1000.0;
                s.push(0, t, true);
                s.push(0, t + 500.0, false);
                n += s.take_capture().is_some() as u32;
            }
            assert!(n > 19_000, "{n} captures");
            started.elapsed()
        }
        let small = (0..3).map(|_| run(16)).min().unwrap();
        let full = (0..3).map(|_| run(RING_EDGES)).min().unwrap();
        assert!(
            full < small * 3 + std::time::Duration::from_millis(5),
            "{full:?} vs {small:?}"
        );
    }

    #[test]
    fn ring_overflow_marks_the_lost_history() {
        // 100 k edges of a fast signal before the trigger, a window larger
        // than the ring holds.
        let mut s = scope(config(Edge::Falling, Mode::Single, 1e9, 0.9));
        s.configure(None);
        let n = RING_EDGES + 34_464; // 100 k edges
        for i in 0..n {
            s.push(1, i as f64 * 10.0, i % 2 == 0);
        }
        let mut c = config(Edge::Rising, Mode::Single, 1e9, 0.9);
        c.source = "PA0".into();
        s.configure(Some(c));
        s.push(0, n as f64 * 10.0, true);
        s.advance(2e9);
        let cap = s.take_capture().unwrap();
        let ch = &cap.channels[1];
        assert_eq!(ch.edges.len(), RING_EDGES);
        // The kept edges are the newest; data before them is reported lost.
        let lost = (n - RING_EDGES - 1) as f64 * 10.0 - cap.trigger_ns;
        assert_eq!(ch.from_ns, lost);
        assert!(ch.from_ns > cap.start_ns);
        assert_eq!(ch.edges[0].0, lost + 10.0);
        // The level before the first kept edge is right.
        assert_eq!(ch.level0, !ch.edges[0].1);
    }

    #[test]
    fn capture_overflow_cuts_the_channel() {
        let mut s = scope(config(Edge::Rising, Mode::Single, 1e9, 0.0));
        s.push(0, 0.0, true);
        let n = CAPTURE_EDGES + 1000;
        for i in 0..n {
            s.push(1, 1.0 + i as f64 * 10.0, i % 2 == 0);
        }
        s.advance(2e9);
        let cap = s.take_capture().unwrap();
        let ch = &cap.channels[1];
        assert_eq!(ch.edges.len(), CAPTURE_EDGES);
        assert_eq!(ch.to_ns, 1.0 + CAPTURE_EDGES as f64 * 10.0);
        assert!(ch.to_ns < cap.end_ns);
        assert_eq!(cap.channels[0].to_ns, cap.end_ns);
    }

    #[test]
    fn unprobed_source_never_triggers() {
        let mut c = config(Edge::Rising, Mode::Normal, 1000.0, 0.5);
        c.source = "PB3".into();
        let mut s = scope(c);
        assert_eq!(s.status(), Status::NoSource);
        square(&mut s, 0.0, 1000.0, 500.0, 10);
        assert!(s.take_capture().is_none());
    }

    #[test]
    fn pause_hit_after_the_capture() {
        let mut c = config(Edge::Rising, Mode::Normal, 1000.0, 0.5);
        c.pause = true;
        let mut s = scope(c);
        assert!(s.watching_for_pause());
        s.push(0, 100.0, true);
        assert!(!s.take_pause_hit(), "not before the window's end");
        assert_eq!(s.step_ns(200.0), 400.0);
        s.advance(600.0);
        assert!(s.take_pause_hit());
        assert!(!s.take_pause_hit());
    }

    #[test]
    fn reset_drops_history_and_rearms() {
        let mut s = scope(config(Edge::Rising, Mode::Single, 1000.0, 0.5));
        square(&mut s, 0.0, 10_000.0, 1000.0, 2);
        assert!(s.take_capture().is_some());
        s.reset(&[false, false], &[]);
        assert_eq!(s.status(), Status::Armed);
        // Time starts again from 0.
        square(&mut s, 10.0, 10_000.0, 1000.0, 1);
        let c = s.take_capture().unwrap();
        assert_eq!(c.trigger_ns, 10.0);
        assert_eq!(c.channels[0].edges[0], (0.0, true));
    }

    fn analog_scope(edge: Edge, mode: Mode, level: f64, hysteresis: f64) -> Scope {
        let mut s = Scope::new();
        s.set_channels(vec![("PA0".into(), false)], f64::MIN);
        s.set_analog(vec![("V(pot.W)".into(), 0.0)], f64::MIN);
        let mut c = config(edge, mode, 1000.0, 0.5);
        c.source = "V(pot.W)".into();
        c.level = Some(level);
        c.hysteresis = hysteresis;
        s.configure(Some(c));
        s
    }

    #[test]
    fn level_trigger_fires_rising_through_the_threshold() {
        let mut s = analog_scope(Edge::Rising, Mode::Single, 1.5, 0.0);
        assert_eq!(s.status(), Status::Armed);
        s.push_analog(0, 100.0, 1.0);
        s.push_analog(0, 200.0, 1.4);
        s.push(0, 250.0, true); // digital edges do not trigger it
        assert_eq!(s.status(), Status::Armed);
        s.push_analog(0, 300.0, 2.0);
        assert_eq!(s.status(), Status::Collecting);
        s.push_analog(0, 600.0, 3.0);
        s.push_analog(0, 900.0, 0.5); // after the window
        let c = s.take_capture().expect("captured");
        assert_eq!(c.trigger_ns, 300.0);
        assert_eq!(c.source, "V(pot.W)");
        let a = &c.analog[0];
        // Pre-trigger samples are in the capture (window from -500 ns).
        assert_eq!(a.v0, 0.0);
        assert_eq!(
            a.samples,
            vec![(-200.0, 1.0), (-100.0, 1.4), (0.0, 2.0), (300.0, 3.0)]
        );
        assert_eq!(a.from_ns, -500.0);
        assert_eq!(a.to_ns, 500.0);
        // The digital channel is captured with it.
        assert_eq!(c.channels[0].edges, vec![(-50.0, true)]);
    }

    #[test]
    fn level_trigger_rearms_from_the_voltage_before_the_next_crossing() {
        // Normal mode, 100 ns window: up at 100, down at 120 (inside the
        // capture), up again at 200, past its end — a second capture.
        let mut s = Scope::new();
        s.set_channels(vec![("PA0".into(), false)], f64::MIN);
        s.set_analog(vec![("V(pot.W)".into(), 0.0)], f64::MIN);
        let mut c = config(Edge::Rising, Mode::Normal, 100.0, 0.5);
        c.source = "V(pot.W)".into();
        c.level = Some(1.5);
        s.configure(Some(c));
        s.push_analog(0, 100.0, 3.0);
        s.push_analog(0, 120.0, 0.0);
        s.push_analog(0, 200.0, 3.0);
        assert_eq!(s.take_capture().map(|c| c.trigger_ns), Some(100.0));
        assert_eq!(s.status(), Status::Collecting);
        s.advance(400.0);
        assert_eq!(s.take_capture().map(|c| c.trigger_ns), Some(200.0));
    }

    #[test]
    fn level_trigger_falling_ignores_rising_crossings() {
        let mut s = analog_scope(Edge::Falling, Mode::Single, 1.5, 0.0);
        s.push_analog(0, 100.0, 2.0); // rising through: no trigger
        assert_eq!(s.status(), Status::Armed);
        s.push_analog(0, 200.0, 1.0);
        s.advance(2000.0);
        assert_eq!(s.take_capture().unwrap().trigger_ns, 200.0);
    }

    #[test]
    fn level_trigger_needs_the_source_below_the_hysteresis_band() {
        // Noise around 1.5 V within ±0.2 V re-triggers without hysteresis…
        let noisy = |h: f64| {
            let mut s = analog_scope(Edge::Rising, Mode::Normal, 1.5, h);
            s.push_analog(0, 10.0, 1.0);
            let mut triggers = Vec::new();
            for i in 0..20 {
                let t = 2000.0 * (i + 1) as f64;
                s.push_analog(0, t, 1.6);
                s.push_analog(0, t + 1000.0, 1.4);
                s.advance(t + 1999.0);
                if let Some(c) = s.take_capture() {
                    triggers.push(c.trigger_ns);
                }
            }
            triggers
        };
        assert_eq!(noisy(0.0).len(), 20);
        // … but only once with 0.2 V of hysteresis: 1.4 V is not below 1.3 V.
        assert_eq!(noisy(0.2), vec![2000.0]);
    }

    #[test]
    fn level_trigger_starting_above_waits_for_a_dip() {
        let mut s = Scope::new();
        s.set_analog(vec![("V(PA1)".into(), 3.0)], 0.0);
        let mut c = config(Edge::Rising, Mode::Single, 100.0, 0.5);
        c.source = "V(PA1)".into();
        c.level = Some(1.0);
        s.configure(Some(c));
        s.push_analog(0, 10.0, 2.5); // still above
        s.advance(1000.0);
        assert!(s.take_capture().is_none());
        s.push_analog(0, 1100.0, 0.2);
        s.push_analog(0, 1200.0, 2.0);
        s.advance(2000.0);
        let cap = s.take_capture().unwrap();
        assert_eq!(cap.trigger_ns, 1200.0);
        // History before probing started (at 0) is not claimed.
        assert_eq!(cap.analog[0].v0, 0.2);
    }

    #[test]
    fn digital_trigger_captures_the_analog_channels() {
        let mut s = scope(config(Edge::Rising, Mode::Single, 1000.0, 0.5));
        s.set_analog(vec![("V(PA0)".into(), 0.0)], f64::MIN);
        s.push_analog(0, 50.0, 3.3);
        s.push(0, 100.0, true);
        s.push_analog(0, 200.0, 0.0);
        s.advance(1000.0);
        let c = s.take_capture().unwrap();
        assert_eq!(c.analog[0].samples, vec![(-50.0, 3.3), (100.0, 0.0)]);
    }

    #[test]
    fn analog_ring_is_bounded() {
        let mut s = analog_scope(Edge::Rising, Mode::Single, 100.0, 0.0);
        let n = RING_SAMPLES + 100;
        for i in 0..n {
            s.push_analog(0, i as f64, (i % 7) as f64 / 10.0);
        }
        assert_eq!(s.analog[0].samples.len(), RING_SAMPLES);
        assert!(s.analog[0].lost_until.is_some());
    }
}
