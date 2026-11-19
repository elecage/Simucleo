//! Tier 9 parts (M21): motors.
//!
//! - [`BipolarStepper`]: a NEMA17-class two-coil hybrid stepper (200 full
//!   steps per turn). The rotor is integrated in time: the coil currents
//!   make a torque that pulls it towards the electrical angle
//!   `atan2(I_B, I_A)` (one electrical cycle = 4 full steps), against its
//!   inertia, friction and the load. Steps too fast for the rotor, or a load
//!   above the torque, make it fall a whole electrical cycle behind the
//!   field: those are lost steps, counted and reported.
//! - [`StepDriver`]: an A4988 (or DRV8825) step/direction driver: a
//!   translator that moves a microstep index on every STEP rising edge and
//!   regulates the coil currents to its sine/cosine table.
//! - [`l298n_bridge`]: one bridge of an L298N dual H-bridge module (two
//!   inputs and an enable), whose output voltage drives a coil.
//! - [`Esc`]: a hobby ESC with a brushless outrunner: servo-style throttle
//!   pulses, the arming sequence, failsafe and a first-order speed response.
//!
//! The drivers' outputs reach the motor through the nets: a motor coil
//! whose two ends sit on the two outputs of one bridge carries that
//! bridge's current, with the sign of the way round it is wired.

use std::f64::consts::{PI, TAU};

use crate::devices::Seconds;

/// Wrap an angle to (−π, π].
pub fn wrap(a: f64) -> f64 {
    let r = a.rem_euclid(TAU);
    if r > PI {
        r - TAU
    } else {
        r
    }
}

// --------------------------------------------------- bipolar stepper

/// Full steps per revolution (1.8° per step).
pub const FULL_STEPS: f64 = 200.0;
/// Rotor teeth: electrical angle = 50 × mechanical angle, so one
/// electrical cycle (4 full steps) is 7.2°.
const TEETH: f64 = FULL_STEPS / 4.0;
/// One full step (rad, mechanical).
pub const STEP_ANGLE: f64 = TAU / FULL_STEPS;
/// Holding torque with one coil at rated current (N·m): 40 N·cm, a
/// 42 × 40 mm NEMA17.
pub const HOLDING: f64 = 0.40;
/// Detent (cogging) torque without current (N·m).
const DETENT: f64 = 0.02;
/// Rotor inertia (kg·m²): 57 g·cm².
pub const ROTOR_INERTIA: f64 = 57e-7 * 4.0;
/// Viscous damping (N·m per rad/s) and the bearings' own friction (N·m).
const DAMPING: f64 = 2.5e-3;
/// Damping of the rotor swinging about the field (N·m per rad/s): eddy
/// currents and the back-EMF of the swing in the coils. It calms the
/// ringing after each step without braking a rotor that keeps up.
const SWING_DAMPING: f64 = 1.0e-3;
/// Smoothing of the field's speed (s).
const FIELD_TAU: f64 = 2.0e-3;
const FRICTION: f64 = 0.003;
/// Coil inductance × rated current (V·s): how fast a chopper driver can
/// change the current (2.8 mH × 1.5 A, plus margin).
const COIL_LI: f64 = 4.5e-3;
/// Back-EMF per unit of rated current (V per rad/s): it eats into the
/// supply as the motor speeds up, so the current (and the torque) cannot
/// follow fast steps any more.
const BACK_EMF: f64 = 0.12;
/// Coil time constant L/R of a coil on a voltage (L298N) drive.
const COIL_TAU: f64 = 2.0e-3;
/// How fast the current dies away when the bridge lets go (diodes).
const FREEWHEEL_TAU: f64 = 0.2e-3;
/// Integration step (s).
const DT: f64 = 10e-6;
/// Slips closer together than this are one burst (s).
const BURST: Seconds = 0.05;
/// How long a lost step keeps the stall indicator on (s).
const STALL_SHOW: Seconds = 0.3;

/// How the current in one coil is made.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub enum CoilDrive {
    /// Nothing drives it: the current dies away, the rotor turns freely
    /// (only the detent torque holds it).
    #[default]
    Off,
    /// A chopper regulates the current to the target; it can change it no
    /// faster than the supply `vmot` (less the back-EMF) allows.
    Chopper { vmot: f64 },
    /// A voltage across the coil: the current follows the target with the
    /// coil's time constant (PWM on the enable averages out).
    Voltage,
}

/// A NEMA17 hybrid stepper with two coils, A and B.
#[derive(Debug, Clone)]
pub struct BipolarStepper {
    /// Rotor angle (rad, cumulative; positive = clockwise from the front).
    pub theta: f64,
    /// Rotor speed (rad/s).
    pub omega: f64,
    /// Coil currents, in units of the rated current (sign = direction).
    pub current: [f64; 2],
    target: [f64; 2],
    drive: [CoilDrive; 2],
    /// Load torque from the slider (N·m): friction on the shaft (a brake).
    pub load: f64,
    /// Rotor plus what hangs on the shaft (kg·m²).
    pub inertia: f64,
    time: Seconds,
    /// The field's electrical angle as last seen, and the field angle the
    /// rotor is following (unwrapped; it jumps a cycle when a step is lost).
    field_prev: Option<f64>,
    field_ref: f64,
    /// The field's speed (mechanical rad/s, smoothed).
    field_speed: f64,
    /// Full steps lost in bursts that ended (each burst counted by how far
    /// it left the rotor off, either way), and the burst going on: slips
    /// less than [`BURST`] apart, signed (a rotor that swings a cycle past
    /// the field and falls back has lost nothing).
    lost_total: u64,
    burst: i64,
    /// When the last step was lost.
    pub last_slip: Seconds,
    /// A lost step not reported yet.
    pub slipped: bool,
    /// The target field jumped by about 180° (a wrong coil sequence) — the
    /// rotor cannot tell which way to go; not reported yet.
    pub jitter: bool,
    pub last_jitter: Seconds,
    /// The target that stood for a while (pins written one after the
    /// other within microseconds are one change).
    stable_target: [f64; 2],
    last_target_change: Seconds,
    /// The hand angle (prop `turn`, degrees) already applied.
    pub turned: f64,
}

impl Default for BipolarStepper {
    fn default() -> Self {
        Self::new()
    }
}

impl BipolarStepper {
    pub fn new() -> Self {
        Self {
            theta: 0.0,
            omega: 0.0,
            current: [0.0; 2],
            target: [0.0; 2],
            drive: [CoilDrive::Off; 2],
            load: 0.0,
            inertia: ROTOR_INERTIA,
            time: 0.0,
            field_prev: None,
            field_ref: 0.0,
            field_speed: 0.0,
            lost_total: 0,
            burst: 0,
            last_slip: f64::NEG_INFINITY,
            slipped: false,
            jitter: false,
            last_jitter: f64::NEG_INFINITY,
            stable_target: [0.0; 2],
            last_target_change: f64::NEG_INFINITY,
            turned: 0.0,
        }
    }

    /// Restart the clock at `now` (simulated time starts again from 0 s).
    pub fn rebase(&mut self, now: Seconds) {
        self.time = now;
        self.last_slip = f64::NEG_INFINITY;
        self.last_jitter = f64::NEG_INFINITY;
        self.last_target_change = f64::NEG_INFINITY;
    }

    /// Full steps lost so far.
    pub fn lost(&self) -> u64 {
        self.lost_total + self.burst.unsigned_abs()
    }

    /// Rotor position in full steps (cumulative), counted from the
    /// drivers' home position (45°, both coils on: the rotor sits half a
    /// step from where the detents hold it without current).
    pub fn steps(&self) -> f64 {
        self.theta / STEP_ANGLE - 0.5
    }

    /// Shaft angle in degrees, 0–360.
    pub fn degrees(&self) -> f64 {
        self.theta.to_degrees().rem_euclid(360.0)
    }

    /// A step was lost recently (the stall/skip indicator).
    pub fn stalled(&self, now: Seconds) -> bool {
        now - self.last_slip < STALL_SHOW || now - self.last_jitter < STALL_SHOW
    }

    /// New coil targets (units of rated current) and how they are driven,
    /// from `now` on. The rotor is brought up to `now` first.
    pub fn set_drive(&mut self, now: Seconds, target: [f64; 2], drive: [CoilDrive; 2]) {
        self.advance(now);
        if target == self.target && drive == self.drive {
            return;
        }
        // A change right after another one (pins written one by one) is
        // compared with what stood before both.
        if now - self.last_target_change >= 50e-6 {
            self.stable_target = self.on_target();
        }
        self.last_target_change = now;
        self.target = target;
        self.drive = drive;
        let new = self.on_target();
        let (a, b) = (self.stable_target, new);
        if a[0].hypot(a[1]) > 0.1 && b[0].hypot(b[1]) > 0.1 {
            let jump = wrap(b[1].atan2(b[0]) - a[1].atan2(a[0])).abs();
            if jump > 0.75 * PI {
                self.jitter = true;
                self.last_jitter = now;
            }
        }
    }

    /// The target currents of the coils that are driven.
    fn on_target(&self) -> [f64; 2] {
        [0, 1].map(|k| {
            if self.drive[k] == CoilDrive::Off {
                0.0
            } else {
                self.target[k]
            }
        })
    }

    /// Turn the shaft by hand by `degrees`. Energised coils pull it back
    /// to the nearest position the field holds.
    pub fn turn_by_hand(&mut self, now: Seconds, degrees: f64) {
        self.advance(now);
        self.theta += degrees.to_radians();
        self.omega = 0.0;
    }

    /// Integrate the rotor up to `now`.
    pub fn advance(&mut self, now: Seconds) {
        if now <= self.time {
            return;
        }
        let mut left = now - self.time;
        self.time = now;
        while left > 0.0 {
            if self.settled() {
                return;
            }
            let dt = left.min(DT);
            left -= dt;
            self.step(dt);
        }
    }

    /// At rest with the currents where they go: nothing changes any more.
    fn settled(&self) -> bool {
        if self.omega != 0.0 {
            return false;
        }
        for k in 0..2 {
            let want = match self.drive[k] {
                CoilDrive::Off => 0.0,
                _ => self.target[k],
            };
            if (self.current[k] - want).abs() > 1e-9 {
                return false;
            }
        }
        self.torque().abs() <= FRICTION + self.load
    }

    /// Motor torque (coils and detent) at the present state (N·m).
    fn torque(&self) -> f64 {
        let (s, c) = (TEETH * self.theta).sin_cos();
        HOLDING * (-self.current[0] * s + self.current[1] * c)
            - DETENT * (4.0 * TEETH * self.theta).sin()
    }

    fn step(&mut self, dt: f64) {
        // Coil currents.
        for k in 0..2 {
            let i = &mut self.current[k];
            match self.drive[k] {
                CoilDrive::Off => *i *= (-dt / FREEWHEEL_TAU).exp(),
                CoilDrive::Chopper { vmot } => {
                    let rate = (vmot - BACK_EMF * self.omega.abs()).max(0.0) / COIL_LI;
                    *i += (self.target[k] - *i).clamp(-rate * dt, rate * dt);
                }
                CoilDrive::Voltage => *i += (self.target[k] - *i) * (1.0 - (-dt / COIL_TAU).exp()),
            }
            if i.abs() < 1e-12 {
                *i = 0.0;
            }
        }
        // Rotor: torque against friction, the load and the damping.
        let swing = if self.field_prev.is_some() {
            self.omega - self.field_speed
        } else {
            0.0
        };
        let t = self.torque() - DAMPING * self.omega - SWING_DAMPING * swing;
        let stop = FRICTION + self.load;
        if self.omega == 0.0 && t.abs() <= stop {
            // Held by friction.
        } else {
            let dir = if self.omega != 0.0 {
                self.omega.signum()
            } else {
                t.signum()
            };
            let w = self.omega + (t - stop * dir) / self.inertia * dt;
            // Friction stops it; it does not turn it back.
            self.omega = if self.omega != 0.0 && w.signum() != self.omega.signum() {
                0.0
            } else {
                w
            };
            self.theta += self.omega * dt;
        }
        // The field the rotor follows, and lost steps.
        let [a, b] = self.current;
        let elec = TEETH * self.theta;
        if a.hypot(b) > 0.1 {
            let f = b.atan2(a);
            match self.field_prev {
                Some(p) => {
                    let d = wrap(f - p);
                    self.field_ref += d;
                    self.field_speed += (d / TEETH - self.field_speed * dt) / FIELD_TAU;
                }
                // Energised again: the field the rotor is nearest to.
                None => self.field_ref = elec + wrap(f - elec),
            }
            self.field_prev = Some(f);
            let lag = elec - self.field_ref;
            if lag.abs() > PI {
                // The rotor fell (or was pushed) a whole electrical cycle
                // off the field: four full steps lost.
                self.field_ref += TAU * lag.signum();
                if self.time - self.last_slip > BURST {
                    self.lost_total += self.burst.unsigned_abs();
                    self.burst = 0;
                }
                self.burst += 4 * lag.signum() as i64;
                self.slipped = true;
                self.last_slip = self.time;
            }
        } else {
            self.field_prev = None;
            self.field_speed = 0.0;
        }
    }
}

// ------------------------------------------------------ A4988 / DRV8825

/// Microstep index units per electrical cycle (1/32 steps × 4 full steps).
const INDEX_CYCLE: i32 = 128;
/// Index of the home position (45°: both coils at 70.7 %).
const HOME: i32 = 16;

/// The translator and current regulator of an A4988 (or DRV8825) driver.
#[derive(Debug, Clone)]
pub struct StepDriver {
    pub drv8825: bool,
    /// Position in the sine table in 1/32 steps (128 per electrical cycle).
    pub index: i32,
    /// STEP rising edges taken (signed by DIR).
    pub steps: i64,
    /// Microstep resolution of the last step: 1, 2, 4, … (1/div steps).
    pub div: u32,
    last_step: Option<bool>,
    rise: Seconds,
    fall: Seconds,
    /// Something the firmware did wrong, for a warning.
    pub warning: Option<String>,
}

impl StepDriver {
    pub fn new(drv8825: bool) -> Self {
        Self {
            drv8825,
            index: HOME,
            steps: 0,
            div: 1,
            // STEP rests low (the MCU pin floats or is low at reset).
            last_step: Some(false),
            rise: f64::NEG_INFINITY,
            fall: f64::NEG_INFINITY,
            warning: None,
        }
    }

    pub fn name(&self) -> &'static str {
        if self.drv8825 {
            "DRV8825"
        } else {
            "A4988"
        }
    }

    /// Shortest STEP high or low time (A4988: 1 µs, DRV8825: 1.9 µs).
    pub fn min_pulse(&self) -> Seconds {
        if self.drv8825 {
            1.9e-6
        } else {
            1.0e-6
        }
    }

    /// The microstep resolution the MS1–MS3 (M0–M2) pins select.
    pub fn resolution(&self, ms: [bool; 3]) -> u32 {
        let [a, b, c] = ms;
        if self.drv8825 {
            match (a, b, c) {
                (false, false, false) => 1,
                (true, false, false) => 2,
                (false, true, false) => 4,
                (true, true, false) => 8,
                (false, false, true) => 16,
                _ => 32,
            }
        } else {
            match (a, b, c) {
                (false, false, false) => 1,
                (true, false, false) => 2,
                (false, true, false) => 4,
                (true, true, false) => 8,
                (true, true, true) => 16,
                // Not in the A4988's table: taken as sixteenth steps.
                _ => 16,
            }
        }
    }

    /// Translator back to the home position (RESET low, power-up).
    pub fn home(&mut self) {
        self.index = HOME;
    }

    /// Coil currents for the present index (units of the set current):
    /// coil 1 (1A/1B) gets the cosine, coil 2 (2A/2B) the sine.
    pub fn currents(&self) -> [f64; 2] {
        let a = self.index as f64 * TAU / INDEX_CYCLE as f64;
        [a.cos(), a.sin()]
    }

    /// The STEP input at `now` with DIR and the MS pins as they are; a
    /// rising edge moves one microstep when `active` (awake, out of
    /// reset). Returns whether the index moved.
    pub fn pins(
        &mut self,
        now: Seconds,
        step: bool,
        dir: bool,
        ms: [bool; 3],
        active: bool,
    ) -> bool {
        let last = self.last_step.replace(step);
        let Some(last) = last else {
            return false;
        };
        if last == step {
            return false;
        }
        let min = self.min_pulse();
        let name = self.name();
        if step {
            let low = now - self.fall;
            if low < min && self.warning.is_none() {
                self.warning = Some(format!(
                    "{name}: STEP low for only {:.2} µs — it needs at least {:.1} µs between pulses",
                    low * 1e6,
                    min * 1e6
                ));
            }
            self.rise = now;
            if !active {
                return false;
            }
            let div = self.resolution(ms);
            self.div = div;
            let size = INDEX_CYCLE / 4 / div as i32;
            let mut i = self.index + if dir { size } else { -size };
            if div == 1 {
                // Full steps sit on the 45° positions.
                i = (((i - HOME) as f64 / 32.0).round() as i32) * 32 + HOME;
            }
            self.index = i.rem_euclid(INDEX_CYCLE);
            self.steps += if dir { 1 } else { -1 };
            true
        } else {
            let high = now - self.rise;
            if high < min && self.warning.is_none() {
                self.warning = Some(format!(
                    "{name}: STEP pulse only {:.2} µs high — it needs at least {:.1} µs (add a delay before setting STEP low)",
                    high * 1e6,
                    min * 1e6
                ));
            }
            self.fall = now;
            false
        }
    }
}

// --------------------------------------------------------------- L298N

/// One bridge of an L298N: the coil current target (units of a 12 V
/// motor's rated current) and how it is driven, from IN1, IN2 and EN and
/// the motor supply `vs`. IN1 = IN2 shorts the coil (brake: the target
/// is 0); EN low lets it go — the current dies away with the coil's time
/// constant too (taken as recirculating, so a PWM on EN averages to its
/// duty). Without a supply the bridge does nothing.
pub fn l298n_bridge(in1: bool, in2: bool, en: bool, vs: f64) -> (f64, CoilDrive) {
    if vs < 4.5 {
        return (0.0, CoilDrive::Off);
    }
    if !en {
        return (0.0, CoilDrive::Voltage);
    }
    // About 2 V lost in the bridge's two Darlington transistors.
    let amp = ((vs - 2.0) / 10.0).clamp(0.0, 1.2);
    let t = match (in1, in2) {
        (true, false) => amp,
        (false, true) => -amp,
        _ => 0.0,
    };
    (t, CoilDrive::Voltage)
}

// ----------------------------------------------------------------- ESC

/// What the ESC is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EscState {
    /// No battery.
    Off,
    /// Powered, waiting for a throttle signal.
    Waiting,
    /// Minimum throttle seen, counting the second it needs.
    Arming,
    /// Throttle above minimum before arming: it refuses to arm.
    ThrottleHigh,
    Armed,
    /// The signal went away while armed: stopped, needs arming again.
    Failsafe,
}

impl EscState {
    pub fn name(self) -> &'static str {
        match self {
            EscState::Off => "off",
            EscState::Waiting => "waiting",
            EscState::Arming => "arming",
            EscState::ThrottleHigh => "throttle-high",
            EscState::Armed => "armed",
            EscState::Failsafe => "failsafe",
        }
    }
}

/// Lowest battery voltage the ESC runs from (2S LiPo).
pub const ESC_VMIN: f64 = 6.0;
/// Time at minimum throttle the ESC needs before it arms.
pub const ARM_TIME: Seconds = 1.0;
/// No pulse for this long: failsafe.
pub const FAILSAFE: Seconds = 0.5;
/// Pulses at or below this width count as minimum throttle (s).
const THROTTLE_MIN: Seconds = 1.05e-3;
/// Time constant of the motor and propeller speeding up / slowing down.
const ESC_TAU: Seconds = 0.25;

/// A hobby ESC (BLHeli class) with a brushless outrunner and a propeller.
#[derive(Debug, Clone)]
pub struct Esc {
    /// Motor KV (rpm per volt, no load).
    pub kv: f64,
    /// Brake/load slider 0–1: the share of the no-load speed it takes.
    pub load: f64,
    pub state: EscState,
    /// Battery voltage as last seen.
    pub vbat: f64,
    /// Throttle 0–1 the motor runs at.
    pub throttle: f64,
    /// Last valid pulse width (s).
    pub pulse: Option<Seconds>,
    rise: Option<Seconds>,
    last_pulse: Seconds,
    low_since: Option<Seconds>,
    pub rpm: f64,
    /// Propeller angle (degrees).
    pub angle: f64,
    time: Seconds,
    /// Beeps so far (power-up tones, the armed beep).
    pub beeps: u32,
    pub last_beep: Seconds,
    /// Something to warn about, not reported yet.
    pub warning: Option<String>,
}

impl Esc {
    pub fn new(kv: f64) -> Self {
        Self {
            kv,
            load: 0.0,
            state: EscState::Off,
            vbat: 0.0,
            throttle: 0.0,
            pulse: None,
            rise: None,
            last_pulse: f64::NEG_INFINITY,
            low_since: None,
            rpm: 0.0,
            angle: 0.0,
            time: 0.0,
            beeps: 0,
            last_beep: f64::NEG_INFINITY,
            warning: None,
        }
    }

    fn beep(&mut self, now: Seconds) {
        self.beeps += 1;
        self.last_beep = now;
    }

    /// The battery at `now`.
    pub fn power(&mut self, now: Seconds, vbat: f64) {
        self.advance(now);
        self.vbat = vbat;
        let on = vbat >= ESC_VMIN;
        if on && self.state == EscState::Off {
            // Power-up tones, then it waits for minimum throttle.
            self.state = EscState::Waiting;
            self.low_since = None;
            self.rise = None;
            self.throttle = 0.0;
            self.beep(now);
        } else if !on && self.state != EscState::Off {
            self.state = EscState::Off;
            self.throttle = 0.0;
            self.pulse = None;
        }
    }

    /// The signal wire changed to `high` at `now`.
    pub fn edge(&mut self, now: Seconds, high: bool) {
        self.advance(now);
        if self.state == EscState::Off {
            return;
        }
        if high {
            self.rise = Some(now);
            return;
        }
        let Some(r) = self.rise.take() else {
            return;
        };
        let w = now - r;
        if !(0.8e-3..=2.2e-3).contains(&w) {
            if w > 50e-6 {
                self.warning.get_or_insert(format!(
                    "ESC: a {:.2} ms pulse is not a throttle signal — it takes 1–2 ms pulses (50–400 Hz)",
                    w * 1e3
                ));
            }
            return;
        }
        self.pulse = Some(w);
        self.last_pulse = now;
        let low = w <= THROTTLE_MIN;
        match self.state {
            EscState::Armed => {
                self.throttle = ((w - 1e-3) / 1e-3).clamp(0.0, 1.0);
            }
            _ if low => {
                if self.low_since.is_none() {
                    self.low_since = Some(now);
                    self.state = EscState::Arming;
                }
            }
            _ => {
                self.low_since = None;
                if self.state != EscState::ThrottleHigh {
                    self.warning.get_or_insert(format!(
                        "ESC: throttle at {:.0} % before arming — it only arms after at least 1 s at minimum throttle (1000 µs)",
                        ((w - 1e-3) / 1e-3 * 100.0).clamp(0.0, 100.0)
                    ));
                }
                self.state = EscState::ThrottleHigh;
            }
        }
        self.advance(now);
    }

    /// Bring the state and the motor up to `now`.
    pub fn advance(&mut self, now: Seconds) {
        if now < self.time {
            return;
        }
        // Signal lost during this interval: up to the deadline the motor
        // still runs on the old throttle, after it on none.
        let deadline = self.last_pulse + FAILSAFE;
        if matches!(self.state, EscState::Armed | EscState::Arming)
            && self.time < deadline
            && now > deadline
        {
            self.advance(deadline);
        }
        let dt = now - self.time;
        self.time = now;
        match self.state {
            EscState::Arming => {
                if let Some(t) = self.low_since {
                    if now - t >= ARM_TIME {
                        self.state = EscState::Armed;
                        self.throttle = 0.0;
                        self.beep(now);
                    }
                }
            }
            EscState::Armed => {}
            _ => self.throttle = 0.0,
        }
        if matches!(self.state, EscState::Armed | EscState::Arming)
            && now > self.last_pulse + FAILSAFE
        {
            if self.state == EscState::Armed {
                self.warning.get_or_insert(
                    "ESC: no throttle signal for 0.5 s — failsafe: the motor stops and the ESC has to be armed again".into(),
                );
            }
            self.state = EscState::Failsafe;
            self.throttle = 0.0;
            self.low_since = None;
        }
        let target = if self.state == EscState::Armed {
            self.throttle * self.kv * self.vbat * (1.0 - self.load.clamp(0.0, 1.0))
        } else {
            0.0
        };
        // The angle with the average speed over the interval.
        let old = self.rpm;
        self.rpm = target + (old - target) * (-dt / ESC_TAU).exp();
        self.angle = (self.angle + (old + self.rpm) / 2.0 / 60.0 * 360.0 * dt).rem_euclid(360.0);
    }

    /// Restart the clock (the machine was reset; the battery stays).
    pub fn rebase(&mut self, now: Seconds) {
        let kv = self.kv;
        let load = self.load;
        *self = Esc::new(kv);
        self.load = load;
        self.time = now;
    }
}

// ------------------------------------------------- BLDC with hall sensors

/// Pole pairs of the hall BLDC (electrical angle = 4 × mechanical).
pub const BLDC_POLE_PAIRS: f64 = 4.0;
/// Back-EMF constant per phase (V per mechanical rad/s) = torque constant.
const BLDC_KE: f64 = 0.02;
/// Phase resistance (Ω) and rotor inertia (kg·m²).
const BLDC_R: f64 = 1.0;
const BLDC_J: f64 = 5e-5;
/// Bearing friction (N·m) and viscous drag (N·m per rad/s).
const BLDC_FRICTION: f64 = 0.002;
const BLDC_DRAG: f64 = 2e-5;
/// Powered but slower than this on average (rad/s) over
/// [`BLDC_STALL_TIME`]: stalled.
const BLDC_STALL_SPEED: f64 = 20.0;
const BLDC_STALL_TIME: Seconds = 0.3;
/// Hall sensor hysteresis (electrical rad): a sensor switches 2° past
/// its threshold, so a rotor sitting on an edge does not chatter.
const HALL_HYST: f64 = 2.0 * PI / 180.0;
/// Look ahead for the next hall edge at most this far (s).
const HALL_HORIZON: Seconds = 0.02;
/// ... and this far while a phase is chopped by PWM.
const PWM_HORIZON: Seconds = 0.25e-3;
/// Look ahead at most this often when the drive keeps changing (a PWM
/// bridge settling after a commutation); the hall edges are still found
/// when the motor is brought up to date.
const PREDICT_MIN_INTERVAL: Seconds = 50e-6;

/// What a 3-phase bridge does with one phase.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PhaseDrive {
    /// Both switches off: the phase floats.
    #[default]
    Float,
    /// High-side switch on: the phase at the supply.
    High,
    /// Low-side switch on: the phase at ground.
    Low,
    /// Switched by PWM faster than the motor follows: the phase at this
    /// fraction (‰) of the supply on average (M23).
    Duty(u16),
}

impl PhaseDrive {
    /// The phase's average voltage as a fraction of the supply, if driven.
    pub fn fraction(self) -> Option<f64> {
        match self {
            PhaseDrive::Float => None,
            PhaseDrive::High => Some(1.0),
            PhaseDrive::Low => Some(0.0),
            PhaseDrive::Duty(d) => Some(d as f64 / 1000.0),
        }
    }
}

/// Slowest PWM a bridge input is averaged at (period, s): a switch that
/// turns on again within this is chopping, slower is commutation.
pub const PWM_MAX_PERIOD: Seconds = 0.5e-3;
/// How long a MOSFET of the bridge takes to turn off: the other switch of
/// the phase turning on sooner shorts the supply (shoot-through).
pub const SWITCH_OFF_TIME: Seconds = 150e-9;

/// The duty of one switch input, measured period by period.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct PwmMeter {
    pub level: bool,
    last_edge: Seconds,
    rise: Option<Seconds>,
    pub fall: Option<Seconds>,
    /// Period and on fraction of the last whole period.
    period: Option<Seconds>,
    duty: f64,
}

impl PwmMeter {
    /// The input is `level` at `now`.
    pub fn set(&mut self, now: Seconds, level: bool) {
        if level == self.level {
            return;
        }
        if level {
            self.period = None;
            if let Some(r) = self.rise {
                let p = now - r;
                if p > 0.0 && p <= PWM_MAX_PERIOD {
                    let high = self.fall.filter(|&f| f > r).map_or(p, |f| f - r);
                    self.period = Some(p);
                    self.duty = (high / p).clamp(0.0, 1.0);
                }
            }
            self.rise = Some(now);
        } else {
            self.fall = Some(now);
        }
        self.level = level;
        self.last_edge = now;
    }

    /// Still switching: an edge within the last period.
    pub fn live(&self, now: Seconds) -> bool {
        self.period
            .is_some_and(|p| now - self.last_edge <= p * 1.05 + 1e-7)
    }

    /// The on fraction now: over the last period while switching, else
    /// the level.
    pub fn duty(&self, now: Seconds) -> f64 {
        if self.live(now) {
            self.duty
        } else if self.level {
            1.0
        } else {
            0.0
        }
    }

    /// When it counts as static if no edge comes (just past `live`).
    pub fn stale_at(&self) -> Option<Seconds> {
        self.period.map(|p| self.last_edge + p * 1.05 + 2e-7)
    }
}

/// What a 3-phase bridge module sees on its inputs (M23): a duty meter
/// per switch, overlaps of the two switches of a phase, and the on time
/// of each switch over the display frame.
#[derive(Debug, Clone, Default)]
pub struct PhaseBridge {
    /// Per phase: INH, INL.
    pub meters: [[PwmMeter; 2]; 3],
    /// Since when both switches of a phase are on.
    both: [Option<Seconds>; 3],
    /// Shoot-through seen in this frame.
    pub shoot: bool,
    /// On time per switch in this frame, and since when.
    acc: [[f64; 2]; 3],
    since: Seconds,
    frame_start: Seconds,
    pub supply: f64,
}

impl PhaseBridge {
    pub fn new(now: Seconds) -> Self {
        Self {
            since: now,
            frame_start: now,
            ..Default::default()
        }
    }

    /// The inputs (INH, INL) of each phase at `now`. Returns the phases
    /// where both switches were on at once for a while: together for
    /// longer than nothing, or one turned on before the other could turn
    /// off.
    pub fn inputs(&mut self, now: Seconds, levels: [(bool, bool); 3]) -> [bool; 3] {
        let dt = (now - self.since).max(0.0);
        for (acc, m) in self.acc.iter_mut().zip(&self.meters) {
            for s in 0..2 {
                if m[s].level {
                    acc[s] += dt;
                }
            }
        }
        self.since = self.since.max(now);
        let mut shoot = [false; 3];
        for k in 0..3 {
            let (h, l) = levels[k];
            let [mh, ml] = self.meters[k];
            // The last time each switch turned off, counting this moment.
            let off = |m: &PwmMeter, on: bool| if m.level && !on { Some(now) } else { m.fall };
            let soon = |f: Option<Seconds>| f.is_some_and(|f| now - f < SWITCH_OFF_TIME);
            let early =
                (l && !ml.level && soon(off(&mh, h))) || (h && !mh.level && soon(off(&ml, l)));
            let long = match (h && l, self.both[k]) {
                (true, None) => {
                    self.both[k] = Some(now);
                    false
                }
                (true, Some(s)) => now > s,
                (false, s) => {
                    self.both[k] = None;
                    s.is_some_and(|s| now > s)
                }
            };
            shoot[k] = early || long;
            self.shoot |= shoot[k];
            self.meters[k][0].set(now, h);
            self.meters[k][1].set(now, l);
        }
        shoot
    }

    /// What each phase does at `now`: the switches' duties averaged,
    /// static levels as they are. Both switches on: the module turns the
    /// phase off.
    pub fn drive(&self, now: Seconds) -> [PhaseDrive; 3] {
        std::array::from_fn(|k| {
            let [mh, ml] = &self.meters[k];
            if !mh.live(now) && !ml.live(now) {
                return match (mh.level, ml.level) {
                    (true, false) => PhaseDrive::High,
                    (false, true) => PhaseDrive::Low,
                    _ => PhaseDrive::Float,
                };
            }
            let (h, l) = (mh.duty(now), ml.duty(now));
            if h + l <= 0.0 || (h >= 1.0 && l >= 1.0) {
                return PhaseDrive::Float;
            }
            // Between the switch's on times the current goes on through
            // the other switch's diode: high side chopping averages to its
            // duty, low side chopping to 1 − its duty.
            let f = if l <= 0.0 {
                h
            } else if h <= 0.0 {
                1.0 - l
            } else {
                h / (h + l)
            };
            PhaseDrive::Duty((f * 1000.0).round() as u16)
        })
    }

    /// When a switching input next counts as static, after the last look.
    pub fn next_change(&self) -> Option<Seconds> {
        self.meters
            .iter()
            .flatten()
            .filter_map(|m| m.stale_at())
            .filter(|&t| t > self.since)
            .reduce(f64::min)
    }

    /// The inputs as last seen.
    pub fn levels(&self) -> [(bool, bool); 3] {
        self.meters.map(|[h, l]| (h.level, l.level))
    }

    /// The frame up to `now` (after [`PhaseBridge::inputs`] at `now`): on
    /// fraction of each switch (INH A–C, then INL A–C), and whether there
    /// was a shoot-through; starts the next frame.
    pub fn end_frame(&mut self, now: Seconds) -> (Vec<f64>, bool) {
        let len = now - self.frame_start;
        let mut out = vec![0.0; 6];
        for k in 0..3 {
            for s in 0..2 {
                out[3 * s + k] = if len > 0.0 {
                    (self.acc[k][s] / len).clamp(0.0, 1.0)
                } else {
                    self.meters[k][s].level as u8 as f64
                };
            }
        }
        self.acc = [[0.0; 2]; 3];
        self.frame_start = now;
        (out, std::mem::take(&mut self.shoot))
    }
}

/// The shape of phase k's back-EMF (and torque) at electrical angle `e`:
/// U peaks at 0°, V at 120°, W at 240°.
fn phase_shape(e: f64, k: usize) -> f64 {
    (e - k as f64 * TAU / 3.0).cos()
}

/// Hall code (bit 0 = A, 1 = B, 2 = C) at electrical angle `e`: A is high
/// from 0° to 180°, B from 120° to 300°, C from 240° to 60°.
pub fn hall_code(e: f64) -> u8 {
    let d = e.to_degrees().rem_euclid(360.0);
    let a = d < 180.0;
    let b = (120.0..300.0).contains(&d);
    let c = !(60.0..240.0).contains(&d);
    a as u8 | (b as u8) << 1 | (c as u8) << 2
}

/// The commutation that turns the motor forward for each hall code:
/// (phase to the supply, phase to ground), phases 0 = U, 1 = V, 2 = W.
pub const COMMUTATION: [(u8, (usize, usize)); 6] = [
    (0b101, (0, 2)),
    (0b001, (1, 2)),
    (0b011, (1, 0)),
    (0b010, (2, 0)),
    (0b110, (2, 1)),
    (0b100, (0, 1)),
];

/// A small 3-phase BLDC (42BLY class, 4 pole pairs) with three hall
/// sensors, driven six-step by a bridge.
#[derive(Debug, Clone)]
pub struct HallBldc {
    /// Rotor angle (mechanical rad, cumulative) and speed (rad/s).
    pub theta: f64,
    pub omega: f64,
    /// What the bridge does with U, V and W, and its supply.
    pub drive: [PhaseDrive; 3],
    pub supply: f64,
    /// Phase currents (A, into the motor).
    pub current: [f64; 3],
    /// Load torque from the slider (N·m).
    pub load: f64,
    /// The hall sensors have their supply.
    pub powered: bool,
    time: Seconds,
    /// Start of the stall watch window: time and rotor angle.
    stuck_since: Option<(Seconds, f64)>,
    /// Stalled now; a stall not reported yet.
    pub stalled: bool,
    pub stall_new: bool,
    /// When a hall output next changes by itself (if the drive stays).
    pub next_hall: Option<Seconds>,
    /// Hall edges so far, and the three sensors now (bit 0 = A).
    pub hall_edges: u64,
    halls: u8,
    /// Since when each hall line floats while released (no pull-up).
    pub float_since: [Option<Seconds>; 3],
    /// When the halls were last looked ahead.
    predicted_at: Seconds,
}

impl Default for HallBldc {
    fn default() -> Self {
        Self::new()
    }
}

impl HallBldc {
    pub fn new() -> Self {
        Self {
            theta: 0.3,
            omega: 0.0,
            drive: [PhaseDrive::Float; 3],
            supply: 0.0,
            current: [0.0; 3],
            load: 0.0,
            powered: false,
            time: 0.0,
            stuck_since: None,
            stalled: false,
            stall_new: false,
            next_hall: None,
            hall_edges: 0,
            halls: hall_code(0.3 * BLDC_POLE_PAIRS),
            float_since: [None; 3],
            predicted_at: f64::NEG_INFINITY,
        }
    }

    pub fn rebase(&mut self, now: Seconds) {
        self.time = now;
        self.float_since = [None; 3];
        self.stuck_since = None;
        self.next_hall = None;
        self.predicted_at = f64::NEG_INFINITY;
    }

    /// Electrical angle.
    pub fn electrical(&self) -> f64 {
        BLDC_POLE_PAIRS * self.theta
    }

    pub fn hall(&self) -> u8 {
        self.halls
    }

    /// The sensors after a move, with hysteresis: sensor k is high while
    /// sin(e − 120°·k) is clearly above 0, low while clearly below.
    fn update_halls(&mut self) {
        let e = self.electrical();
        for k in 0..3 {
            let s = (e - k as f64 * TAU / 3.0).sin();
            if s > HALL_HYST.sin() {
                self.halls |= 1 << k;
            } else if s < -HALL_HYST.sin() {
                self.halls &= !(1 << k);
            }
        }
    }

    /// Hall output `k` (0 = A): open collector, so low (`Some(false)`) or
    /// let go (`None`), and nothing without supply.
    pub fn hall_output(&self, k: usize) -> Option<bool> {
        (self.powered && self.hall() >> k & 1 == 0).then_some(false)
    }

    /// Shaft angle in degrees, 0–360.
    pub fn degrees(&self) -> f64 {
        self.theta.to_degrees().rem_euclid(360.0)
    }

    pub fn rpm(&self) -> f64 {
        self.omega / TAU * 60.0
    }

    /// New bridge state from `now` on.
    pub fn set_drive(&mut self, now: Seconds, drive: [PhaseDrive; 3], supply: f64) {
        if drive == self.drive && (supply - self.supply).abs() <= 0.05 {
            // Nothing new (a PWM edge the bridge averages away).
            self.advance_if_due(now);
            return;
        }
        self.advance(now);
        {
            self.drive = drive;
            self.supply = supply;
            let soon = self.predicted_at + PREDICT_MIN_INTERVAL;
            if self.time < soon {
                // Changed again just after a look ahead: look again then.
                self.next_hall = Some(self.next_hall.map_or(soon, |n| n.min(soon)));
            } else {
                self.predict();
            }
        }
    }

    /// Bring it up to date only if a hall output may have changed by
    /// `now`: the next hall edge is due (or it is moving without a look
    /// ahead). Calls at every PWM edge then cost nothing.
    pub fn advance_if_due(&mut self, now: Seconds) {
        let quiet = match self.next_hall {
            Some(t) => now < t - 1e-9,
            None => self.omega == 0.0 && self.idle(),
        };
        if !quiet {
            self.advance(now);
        }
    }

    /// Integrate up to `now`.
    pub fn advance(&mut self, now: Seconds) {
        // A look ahead that is due (within a nanosecond: the wake-up time
        // went through core cycles) is redone, or it would wake us again
        // and again at the same moment.
        let due = |n: &Option<Seconds>| n.is_some_and(|t| t <= now + 1e-9);
        if now <= self.time {
            if due(&self.next_hall) {
                self.predict();
            }
            return;
        }
        let mut left = now - self.time;
        self.time = now;
        let before = self.hall();
        let mut crossed = false;
        while left > 0.0 {
            if self.omega == 0.0 && self.idle() {
                // Standing and nothing can drive it: no current either.
                self.current = [0.0; 3];
                break;
            }
            let dt = left.min(DT);
            left -= dt;
            let h = self.hall();
            self.step(dt);
            if self.hall() != h {
                self.hall_edges += 1;
                crossed = true;
            }
        }
        // Stall watch: current flowing, but over a while the shaft got
        // hardly anywhere (it may rock back and forth).
        let driven = self.current.iter().any(|i| i.abs() > 0.5);
        if driven {
            let (t0, a0) = *self.stuck_since.get_or_insert((now, self.theta));
            if now - t0 >= BLDC_STALL_TIME {
                let stuck = (self.theta - a0).abs() < BLDC_STALL_SPEED * (now - t0);
                if stuck && !self.stalled {
                    self.stall_new = true;
                }
                self.stalled = stuck;
                self.stuck_since = Some((now, self.theta));
            }
        } else {
            self.stuck_since = None;
            self.stalled = false;
        }
        if crossed || self.hall() != before || due(&self.next_hall) {
            self.predict();
        }
    }

    /// No current can flow (fewer than two phases driven, or no supply).
    fn idle(&self) -> bool {
        let mut driven = self.drive.iter().filter_map(|d| d.fraction());
        let Some(first) = driven.next() else {
            return true;
        };
        let differ = driven.any(|f| (f - first).abs() > 1e-9);
        !differ || self.supply <= 0.0
    }

    /// Phase currents for the drive at the present speed and angle: the
    /// driven phases form a star; a floating phase carries nothing.
    fn currents(&self) -> [f64; 3] {
        let e = self.electrical();
        let mut cur = [0.0; 3];
        if self.idle() {
            return cur;
        }
        let emf = |k: usize| BLDC_KE * self.omega * phase_shape(e, k);
        let volts = |k: usize| self.drive[k].fraction().map(|f| f * self.supply);
        let driven: Vec<usize> = (0..3).filter(|&k| volts(k).is_some()).collect();
        let star = driven
            .iter()
            .map(|&k| volts(k).unwrap() - emf(k))
            .sum::<f64>()
            / driven.len() as f64;
        for &k in &driven {
            cur[k] = (volts(k).unwrap() - emf(k) - star) / BLDC_R;
        }
        cur
    }

    fn step(&mut self, dt: f64) {
        self.current = self.currents();
        let e = self.electrical();
        let motor: f64 = (0..3)
            .map(|k| BLDC_KE * self.current[k] * phase_shape(e, k))
            .sum();
        let t = motor - BLDC_DRAG * self.omega;
        let stop = BLDC_FRICTION + self.load;
        if self.omega == 0.0 && t.abs() <= stop {
            return;
        }
        let dir = if self.omega != 0.0 {
            self.omega.signum()
        } else {
            t.signum()
        };
        let w = self.omega + (t - stop * dir) / BLDC_J * dt;
        self.omega = if self.omega != 0.0 && w.signum() != self.omega.signum() {
            0.0
        } else {
            w
        };
        self.theta += self.omega * dt;
        self.update_halls();
    }

    /// When the halls next change if the drive stays as it is: run a copy
    /// ahead.
    fn predict(&mut self) {
        self.next_hall = None;
        self.predicted_at = self.time;
        if self.omega == 0.0 && self.idle() {
            return;
        }
        let mut probe = self.clone();
        let h = probe.hall();
        let mut t = 0.0;
        // A chopping bridge brings the motor up to date every PWM edge,
        // which finds the hall edge then: only look a little ahead.
        let horizon = if self.drive.iter().any(|d| matches!(d, PhaseDrive::Duty(_))) {
            PWM_HORIZON
        } else {
            HALL_HORIZON
        };
        while t < horizon {
            probe.step(DT);
            t += DT;
            if probe.hall() != h {
                self.next_hall = Some(self.time + t);
                return;
            }
            if probe.omega == 0.0 && probe.idle() {
                return;
            }
        }
        // Not yet: look again then.
        self.next_hall = Some(self.time + horizon);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drive the motor through the A4988 table: `steps` steps at `div`
    /// microsteps, `rate` microsteps per second (or a ramp from `rate.0`
    /// to `rate.1` in full steps per second²).
    fn run_driver(
        m: &mut BipolarStepper,
        d: &mut StepDriver,
        t: &mut f64,
        steps: u32,
        rate: impl Fn(u32) -> f64,
        dir: bool,
        ms: [bool; 3],
    ) {
        for k in 0..steps {
            let period = 1.0 / rate(k);
            d.pins(*t, true, dir, ms, true);
            m.set_drive(*t, d.currents(), [CoilDrive::Chopper { vmot: 12.0 }; 2]);
            d.pins(*t + 2e-6, false, dir, ms, true);
            *t += period;
        }
        m.set_drive(*t, d.currents(), [CoilDrive::Chopper { vmot: 12.0 }; 2]);
    }

    fn energised() -> (BipolarStepper, StepDriver, f64) {
        let mut m = BipolarStepper::new();
        let mut d = StepDriver::new(false);
        d.pins(0.0, false, true, [false; 3], true);
        m.set_drive(0.0, d.currents(), [CoilDrive::Chopper { vmot: 12.0 }; 2]);
        m.advance(0.1);
        (m, d, 0.1)
    }

    #[test]
    fn rotor_settles_on_the_field_angle() {
        let (m, _, _) = energised();
        // Home: 45°, both coils at 70.7 % → half a full step.
        assert!(m.steps().abs() < 0.01, "{}", m.steps());
        assert_eq!(m.lost(), 0);
    }

    #[test]
    fn slow_full_steps_turn_one_revolution_exactly() {
        let (mut m, mut d, mut t) = energised();
        let start = m.steps();
        run_driver(&mut m, &mut d, &mut t, 200, |_| 200.0, true, [false; 3]);
        t += 0.1;
        m.advance(t);
        assert!(
            (m.steps() - start - 200.0).abs() < 0.05,
            "{}",
            m.steps() - start
        );
        assert_eq!(m.lost(), 0);
        // Back the other way.
        run_driver(&mut m, &mut d, &mut t, 50, |_| 200.0, false, [false; 3]);
        m.advance(t + 0.1);
        assert!(
            (m.steps() - start - 150.0).abs() < 0.05,
            "{}",
            m.steps() - start
        );
    }

    #[test]
    fn microsteps_divide_the_full_step() {
        let (mut m, mut d, mut t) = energised();
        let start = m.steps();
        // 1/16: MS1–MS3 high, 16 microsteps per full step.
        run_driver(&mut m, &mut d, &mut t, 8, |_| 2000.0, true, [true; 3]);
        m.advance(t + 0.1);
        assert_eq!(d.div, 16);
        assert!(
            (m.steps() - start - 0.5).abs() < 0.03,
            "{}",
            m.steps() - start
        );
        // DRV8825: M2 alone is 1/16, all three 1/32.
        let d2 = StepDriver::new(true);
        assert_eq!(d2.resolution([false, false, true]), 16);
        assert_eq!(d2.resolution([true, true, true]), 32);
        assert_eq!(StepDriver::new(false).resolution([true, true, false]), 8);
    }

    #[test]
    fn too_fast_from_standstill_loses_steps_but_a_ramp_gets_there() {
        // 1500 full steps/s (450 rpm) straight away: the rotor cannot
        // catch up (pull-in is about 1100 steps/s) and slips.
        let (mut m, mut d, mut t) = energised();
        run_driver(&mut m, &mut d, &mut t, 400, |_| 1500.0, true, [false; 3]);
        m.advance(t + 0.1);
        assert!(m.lost() > 100 && m.slipped, "lost {}", m.lost());
        // 1800 steps/s after a ramp from 100 steps/s at 4000 steps/s², and
        // the same ramp down at the end: every step arrives.
        let (mut m, mut d, mut t) = energised();
        let start = m.steps();
        let n = 2000;
        let ramp = |k: u32| {
            let v = |s: u32| (100.0f64 * 100.0 + 2.0 * 4000.0 * s as f64).sqrt();
            v(k).min(v(n - k)).min(1800.0)
        };
        run_driver(&mut m, &mut d, &mut t, n, ramp, true, [false; 3]);
        m.advance(t + 0.2);
        assert_eq!(m.lost(), 0, "a ramp keeps it in step");
        assert!(
            (m.steps() - start - n as f64).abs() < 0.1,
            "{}",
            m.steps() - start
        );
    }

    #[test]
    fn a_load_above_the_torque_stalls_it() {
        let (mut m, mut d, mut t) = energised();
        m.load = 0.5; // 50 N·cm against 40 N·cm
        let start = m.steps();
        run_driver(&mut m, &mut d, &mut t, 100, |_| 100.0, true, [false; 3]);
        m.advance(t + 0.1);
        assert!(m.steps() - start < 10.0, "{}", m.steps() - start);
        assert!(m.lost() > 50, "{}", m.lost());
    }

    #[test]
    fn turned_by_hand_it_springs_back_when_held_and_stays_when_free() {
        let (mut m, _, t) = energised();
        let start = m.steps();
        // Held: 2 full steps (half an electrical cycle less a bit) → back.
        m.turn_by_hand(t, 1.7 * 1.8);
        m.advance(t + 0.2);
        assert!((m.steps() - start).abs() < 0.05, "{}", m.steps() - start);
        // Free (driver off): it stays where it was put, on a detent.
        m.set_drive(t + 0.2, [0.0; 2], [CoilDrive::Off; 2]);
        m.advance(t + 0.3);
        m.turn_by_hand(t + 0.3, 30.0 * 1.8);
        m.advance(t + 0.6);
        assert!(
            (m.steps() - start - 30.0).abs() < 0.6,
            "{}",
            m.steps() - start
        );
        assert!(m.omega == 0.0);
    }

    #[test]
    fn swapped_coil_ends_reverse_and_wave_sequences_are_jittery() {
        // L298N full steps A+, B+, A−, B−: forward; with coil A reversed the
        // same sequence turns backward.
        for sign in [1.0, -1.0] {
            let mut m = BipolarStepper::new();
            let seq = [[1.0, 0.0], [0.0, 1.0], [-1.0, 0.0], [0.0, -1.0]];
            let mut t = 0.0;
            // Start where that field holds the rotor (A− is 2 steps on).
            m.theta = if sign > 0.0 { 0.0 } else { 2.0 * STEP_ANGLE };
            m.set_drive(0.0, [sign, 0.0], [CoilDrive::Voltage; 2]);
            m.advance(0.1);
            t += 0.1;
            let start = m.steps();
            for k in 1..=40 {
                let s = seq[k % 4];
                m.set_drive(t, [sign * s[0], s[1]], [CoilDrive::Voltage; 2]);
                t += 0.01;
            }
            m.advance(t + 0.1);
            let moved = m.steps() - start;
            assert!((moved - sign * 40.0).abs() < 0.2, "{sign}: {moved}");
            assert!(!m.jitter);
        }
        // A wrong order (A+, A−, B+, B−) jumps the field 180°: jitter.
        let mut m = BipolarStepper::new();
        let seq = [[1.0, 0.0], [-1.0, 0.0], [0.0, 1.0], [0.0, -1.0]];
        let mut t = 0.0;
        let start = m.steps();
        for k in 0..40 {
            m.set_drive(t, seq[k % 4], [CoilDrive::Voltage; 2]);
            t += 0.01;
        }
        m.advance(t);
        assert!(m.jitter);
        // It stumbles back and forth instead of 40 steps one way.
        assert!(
            (m.steps() - start).abs() < 20.0,
            "does not turn: {}",
            m.steps() - start
        );
    }

    #[test]
    fn step_pulses_shorter_than_the_minimum_warn() {
        let mut d = StepDriver::new(false);
        d.pins(0.0, false, true, [false; 3], true);
        d.pins(1e-3, true, true, [false; 3], true);
        d.pins(1e-3 + 1.5e-6, false, true, [false; 3], true);
        assert!(d.warning.is_none());
        let mut d = StepDriver::new(true);
        d.pins(0.0, false, true, [false; 3], true);
        d.pins(1e-3, true, true, [false; 3], true);
        d.pins(1e-3 + 1.5e-6, false, true, [false; 3], true);
        assert!(
            d.warning.as_deref().unwrap().contains("1.9 µs"),
            "{:?}",
            d.warning
        );
        // Asleep or in reset: the step is not taken.
        let mut d = StepDriver::new(false);
        d.pins(0.0, false, true, [false; 3], true);
        assert!(!d.pins(1e-3, true, true, [false; 3], false));
        assert_eq!(d.steps, 0);
    }

    #[test]
    fn l298n_bridge_outputs() {
        assert_eq!(
            l298n_bridge(true, false, true, 12.0),
            (1.0, CoilDrive::Voltage)
        );
        assert_eq!(
            l298n_bridge(false, true, true, 12.0),
            (-1.0, CoilDrive::Voltage)
        );
        assert_eq!(
            l298n_bridge(true, true, true, 12.0),
            (0.0, CoilDrive::Voltage)
        );
        assert_eq!(
            l298n_bridge(true, false, false, 12.0),
            (0.0, CoilDrive::Voltage)
        );
        assert_eq!(l298n_bridge(true, false, true, 3.0).1, CoilDrive::Off);
    }

    /// Servo pulses of `us` µs at 50 Hz from `t` for `secs`.
    fn pulses(e: &mut Esc, t: &mut f64, secs: f64, us: f64) {
        let end = *t + secs;
        while *t < end {
            e.edge(*t, true);
            e.edge(*t + us * 1e-6, false);
            *t += 0.02;
        }
        e.advance(*t);
    }

    #[test]
    fn esc_arms_after_a_second_at_minimum_and_follows_the_throttle() {
        let mut e = Esc::new(1000.0);
        let mut t = 0.0;
        e.power(t, 11.1);
        assert_eq!(e.state, EscState::Waiting);
        pulses(&mut e, &mut t, 0.5, 1000.0);
        assert_eq!(e.state, EscState::Arming);
        // Throttle before it armed is ignored.
        pulses(&mut e, &mut t, 0.6, 1000.0);
        assert_eq!(e.state, EscState::Armed);
        assert_eq!(e.beeps, 2);
        pulses(&mut e, &mut t, 2.0, 1500.0);
        assert!((e.throttle - 0.5).abs() < 1e-9);
        // 50 % × 1000 KV × 11.1 V after 8 time constants.
        assert!((e.rpm - 5550.0).abs() < 10.0, "{}", e.rpm);
        // First-order: one time constant after a step to 100 % it is 63 %
        // of the way.
        let before = e.rpm;
        pulses(&mut e, &mut t, 0.24, 2000.0);
        let frac = (e.rpm - before) / (11100.0 - before);
        assert!((0.55..0.7).contains(&frac), "{frac}");
        assert!(e.warning.is_none(), "{:?}", e.warning);
    }

    #[test]
    fn esc_with_throttle_up_does_not_arm_and_signal_loss_is_failsafe() {
        let mut e = Esc::new(1000.0);
        let mut t = 0.0;
        e.power(t, 11.1);
        pulses(&mut e, &mut t, 2.0, 1500.0);
        assert_eq!(e.state, EscState::ThrottleHigh);
        assert!(e.rpm.abs() < 1e-9);
        assert!(e.warning.take().unwrap().contains("before arming"));
        pulses(&mut e, &mut t, 1.2, 1000.0);
        assert_eq!(e.state, EscState::Armed);
        pulses(&mut e, &mut t, 1.0, 1800.0);
        assert!(e.rpm > 5000.0);
        // The signal stops.
        e.advance(t + 0.4);
        assert_eq!(e.state, EscState::Armed);
        e.advance(t + 0.6);
        assert_eq!(e.state, EscState::Failsafe);
        assert!(e.warning.take().unwrap().contains("failsafe"));
        e.advance(t + 3.0);
        assert!(e.rpm < 10.0);
        // Coming back at 1800 µs does not start it: arm again first.
        t += 3.0;
        pulses(&mut e, &mut t, 1.0, 1800.0);
        assert_ne!(e.state, EscState::Armed);
        assert!(e.rpm < 10.0);
        // Without a battery it is off.
        e.power(t, 3.0);
        assert_eq!(e.state, EscState::Off);
    }

    /// Six-step commutation from the halls, as firmware would do it on
    /// every hall edge; `map` turns the code read into the code used.
    fn run_bldc(m: &mut HallBldc, secs: f64, map: impl Fn(u8) -> u8, reverse: bool) {
        let mut t = m.time;
        let end = t + secs;
        m.powered = true;
        while t < end {
            let code = map(m.hall());
            let mut drive = [PhaseDrive::Float; 3];
            if let Some(&(_, (h, l))) = COMMUTATION.iter().find(|c| c.0 == code) {
                let (h, l) = if reverse { (l, h) } else { (h, l) };
                drive[h] = PhaseDrive::High;
                drive[l] = PhaseDrive::Low;
            }
            m.set_drive(t, drive, 12.0);
            // Until the next hall edge (plus a few µs of interrupt latency).
            t = m.next_hall.map_or(t + 1e-3, |n| n + 3e-6).min(end);
            m.advance(t);
        }
    }

    #[test]
    fn hall_codes_step_through_the_six_sectors() {
        let codes: Vec<u8> = (0..6)
            .map(|s| hall_code((30.0 + 60.0 * s as f64).to_radians()))
            .collect();
        assert_eq!(codes, [0b101, 0b001, 0b011, 0b010, 0b110, 0b100]);
        // The table drives the pair with the most forward torque.
        for (s, &code) in codes.iter().enumerate() {
            let e = (30.0 + 60.0 * s as f64).to_radians();
            let (h, l) = COMMUTATION.iter().find(|c| c.0 == code).unwrap().1;
            let best = (0..3)
                .flat_map(|a| (0..3).map(move |b| (a, b)))
                .filter(|(a, b)| a != b)
                .max_by(|x, y| {
                    let f = |(a, b): (usize, usize)| phase_shape(e, a) - phase_shape(e, b);
                    f(*x).partial_cmp(&f(*y)).unwrap()
                })
                .unwrap();
            assert_eq!((h, l), best, "sector {s}");
        }
    }

    #[test]
    fn six_step_commutation_spins_the_bldc_up_and_a_wrong_table_stalls_it() {
        let mut m = HallBldc::new();
        run_bldc(&mut m, 1.0, |c| c, false);
        assert!(m.rpm() > 3000.0 && m.rpm() < 3600.0, "{}", m.rpm());
        assert!(!m.stalled);
        assert!(m.hall_edges > 1000);
        // The other way round: swap the high and low sides.
        let mut m = HallBldc::new();
        run_bldc(&mut m, 1.0, |c| c, true);
        assert!(m.rpm() < -3000.0, "{}", m.rpm());
        // Halls A and B swapped: torque the wrong way in four sectors of
        // six — it rocks on an edge and stalls.
        let swap = |c: u8| c & 0b100 | (c & 1) << 1 | (c >> 1) & 1;
        let mut m = HallBldc::new();
        run_bldc(&mut m, 1.0, swap, false);
        assert!(m.rpm().abs() < 200.0, "{}", m.rpm());
        assert!(m.stalled && m.stall_new);
        // A brake on the shaft slows it down.
        let mut m = HallBldc::new();
        m.load = 0.05;
        run_bldc(&mut m, 1.0, |c| c, false);
        assert!(m.rpm() > 500.0 && m.rpm() < 2500.0, "{}", m.rpm());
    }

    #[test]
    fn esc_signal_loss_splits_the_interval_at_the_deadline() {
        // Full throttle, then the pulses stop: the result after 0.6 s must
        // not depend on how often the ESC is brought up to date.
        let run = |step: f64| {
            let mut e = Esc::new(1000.0);
            let mut t = 0.0;
            e.power(t, 11.1);
            pulses(&mut e, &mut t, 1.2, 1000.0);
            pulses(&mut e, &mut t, 1.0, 2000.0);
            let end = t + 0.6;
            while t < end - 1e-12 {
                t = (t + step).min(end);
                e.advance(t);
            }
            assert_eq!(e.state, EscState::Failsafe);
            e.rpm
        };
        let (coarse, fine) = (run(0.6), run(0.001));
        assert!((coarse - fine).abs() < 0.01 * fine, "{coarse} vs {fine}");
    }

    #[test]
    fn bldc_currents_stop_when_the_bridge_lets_go() {
        // Rotor held by the brake while two phases are driven, then every
        // phase floats: no current is left over, and it is not stalled.
        let mut m = HallBldc::new();
        m.powered = true;
        m.load = 1.0;
        m.set_drive(
            0.0,
            [PhaseDrive::High, PhaseDrive::Low, PhaseDrive::Float],
            12.0,
        );
        m.advance(0.5);
        assert!(m.current.iter().any(|i| i.abs() > 0.5), "{:?}", m.current);
        m.set_drive(0.5, [PhaseDrive::Float; 3], 12.0);
        m.advance(1.0);
        m.advance(1.5);
        assert_eq!(m.current, [0.0; 3]);
        assert!(!m.stalled);
    }

    #[test]
    fn hall_outputs_are_open_collector() {
        let mut m = HallBldc::new();
        assert_eq!(m.hall_output(0), None, "unpowered: nothing");
        m.powered = true;
        let code = m.hall();
        for k in 0..3 {
            let low = code >> k & 1 == 0;
            assert_eq!(m.hall_output(k), low.then_some(false));
        }
    }
}
