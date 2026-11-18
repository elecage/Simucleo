//! Component models.
//!
//! Models live in simulated time (seconds derived from CPU cycles) and expose
//! a small *visual state* that the GUI samples at ~60 Hz. Because MCU signals
//! change far faster than the screen refreshes, models integrate their
//! inputs over each frame instead of sampling them.

/// Integrates a digital signal into an on-time fraction over a frame window.
///
/// Used for LED brightness under PWM, 7-segment multiplexing persistence,
/// and similar "what would the eye see" effects.
#[derive(Debug, Clone)]
pub struct DutyIntegrator {
    level: bool,
    last_change: f64,
    frame_start: f64,
    on_time: f64,
}

impl DutyIntegrator {
    pub fn new(t0: f64) -> Self {
        Self {
            level: false,
            last_change: t0,
            frame_start: t0,
            on_time: 0.0,
        }
    }

    /// Record that the input became `level` at simulated time `t`.
    pub fn set(&mut self, t: f64, level: bool) {
        if self.level {
            self.on_time += t - self.last_change;
        }
        self.level = level;
        self.last_change = t;
    }

    /// Close the frame ending at `t`; returns the on-fraction in `0.0..=1.0`.
    pub fn end_frame(&mut self, t: f64) -> f64 {
        self.set(t, self.level);
        let span = t - self.frame_start;
        let duty = if span > 0.0 {
            (self.on_time / span).clamp(0.0, 1.0)
        } else if self.level {
            1.0
        } else {
            0.0
        };
        self.frame_start = t;
        self.on_time = 0.0;
        duty
    }
}

/// LED electrical parameters.
#[derive(Debug, Clone, Copy)]
pub struct LedParams {
    /// Forward voltage (V).
    pub vf: f64,
    /// Absolute maximum continuous current (A).
    pub max_current: f64,
}

impl LedParams {
    pub const RED_5MM: Self = Self {
        vf: 2.0,
        max_current: 0.020,
    };

    /// Forward current for a drive voltage through a series resistance.
    /// Simple piecewise-linear diode: zero below Vf.
    pub fn current(&self, v_drive: f64, r_series: f64) -> f64 {
        if v_drive <= self.vf {
            0.0
        } else if r_series <= 0.0 {
            f64::INFINITY
        } else {
            (v_drive - self.vf) / r_series
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pwm_25_percent_duty() {
        // 1 kHz PWM at 25 % duty over a 16 ms frame.
        let mut d = DutyIntegrator::new(0.0);
        for k in 0..16 {
            let t = k as f64 * 1e-3;
            d.set(t, true);
            d.set(t + 0.25e-3, false);
        }
        let duty = d.end_frame(16e-3);
        assert!((duty - 0.25).abs() < 1e-9, "duty = {duty}");
    }

    #[test]
    fn steady_level_spans_frames() {
        let mut d = DutyIntegrator::new(0.0);
        d.set(0.0, true);
        assert_eq!(d.end_frame(0.016), 1.0);
        assert_eq!(d.end_frame(0.032), 1.0);
    }

    #[test]
    fn led_needs_a_resistor() {
        let led = LedParams::RED_5MM;
        let i = led.current(3.3, 220.0);
        assert!((i - 0.0059).abs() < 1e-4);
        assert!(led.current(3.3, 0.0) > led.max_current);
        assert_eq!(led.current(1.8, 220.0), 0.0);
    }
}
