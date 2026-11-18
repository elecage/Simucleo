//! Electrical simulation of the external circuit against the MCU's pins.
//!
//! The circuit is reduced to nets (see [`crate::netlist`]); every
//! component becomes a linear element between nets: resistors, LEDs
//! (piecewise-linear diodes, iterated until each is consistently on or
//! off), resistive loads for buzzers, Norton sources for the supply pins
//! and for each MCU pin's driver (push-pull output, pull-up/down or
//! nothing). A DC nodal solve gives every net voltage and every element
//! current, from which we derive
//! - the logic level each MCU input pin sees (fed back to the GPIO model),
//! - what each part shows (LED brightness, buzzer on/frequency), and
//! - electrical-rule warnings (LED without resistor, pin over-current,
//!   short circuit).
//!
//! The solution only depends on the combination of pin drives, so results
//! are cached: PWM toggling between a few states costs a hash lookup.
//! Visual quantities are integrated over time (in core cycles) between
//! display frames, so a 25 % PWM duty shows as a dimmer LED.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::rc::Rc;

use crate::netlist::{build_netlist, BusCatalog, Circuit, PartCatalog, PartInstance, PinRef, Wire};

/// Simulated time in core clock cycles.
pub type Cycles = u64;

/// Supply voltage of the MCU and its I/O.
pub const VDD: f64 = 3.3;
/// Output driver resistance (gives ~25 mA into a short, the pin's limit).
const R_ON: f64 = 40.0;
/// Internal pull-up/down (RM0368: 30–50 kΩ).
const R_PULL: f64 = 40_000.0;
/// Board supply source resistance.
const R_SUPPLY: f64 = 0.05;
/// Leak to ground on every net so that floating nets stay solvable.
const GMIN: f64 = 1e-9;
/// LED dynamic resistance once conducting.
const R_LED: f64 = 15.0;
/// No-load speed of the DC motor at full drive (small 3–6 V hobby motor
/// with gearbox).
const MOTOR_MAX_RPM: f64 = 200.0;
/// Absolute maximum current of an I/O pin (datasheet: ±25 mA).
const PIN_MAX: f64 = 0.025;

/// How the MCU drives one pin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Drive {
    High,
    Low,
    PullUp,
    PullDown,
    Float,
}

/// Part kind of the Nucleo board.
pub const BOARD_KIND: &str = "nucleo-f401re";

/// Parse an MCU pin name: `"PA5"` → `(0, 5)`.
pub fn parse_mcu_pin(s: &str) -> Option<(u8, u8)> {
    let b = s.as_bytes();
    if b.len() < 3 || b[0] != b'P' || !(b'A'..=b'H').contains(&b[1]) {
        return None;
    }
    let pin: u8 = s[2..].parse().ok()?;
    (pin < 16).then_some((b[1] - b'A', pin))
}

/// Parse a resistance: a number, or text such as `"220"`, `"4.7k"`,
/// `"4k7"`, `"1M"`, `"2M2"`, `"4R7"`, `"10 kΩ"`, `"330 ohm"` (the same
/// notations as the editor's `parseOhms`).
pub fn parse_ohms(v: &serde_json::Value) -> Option<f64> {
    if let Some(x) = v.as_f64() {
        return (x > 0.0 && x.is_finite()).then_some(x);
    }
    let s: String = v.as_str()?.chars().filter(|c| !c.is_whitespace()).collect();
    let lower = s.to_ascii_lowercase();
    let s = if let Some(t) = s.strip_suffix('Ω') {
        t.to_string()
    } else if lower.ends_with("ohms") {
        s[..s.len() - 4].to_string()
    } else if lower.ends_with("ohm") {
        s[..s.len() - 3].to_string()
    } else {
        s
    };
    let mult = |c: char| match c {
        'R' | 'r' => Some(1.0),
        'k' | 'K' => Some(1e3),
        'M' | 'm' => Some(1e6),
        _ => None,
    };
    // 4k7, 2M2, 4R7: the letter stands for the decimal point.
    if let Some((i, c)) = s.char_indices().find(|(_, c)| c.is_ascii_alphabetic()) {
        let m = mult(c)?;
        let (int, frac) = (&s[..i], &s[i + 1..]);
        let r = if frac.is_empty() {
            int.parse::<f64>().ok()? * m
        } else if int.chars().all(|c| c.is_ascii_digit())
            && frac.chars().all(|c| c.is_ascii_digit())
            && !int.is_empty()
        {
            format!("{int}.{frac}").parse::<f64>().ok()? * m
        } else {
            return None;
        };
        return (r > 0.0 && r.is_finite()).then_some(r);
    }
    s.parse::<f64>().ok().filter(|r| *r > 0.0 && r.is_finite())
}

fn led_vf(color: &str) -> f64 {
    match color {
        "red" => 1.9,
        "yellow" | "orange" => 2.0,
        "green" => 2.1,
        "blue" | "white" => 2.9,
        _ => 2.0,
    }
}

#[derive(Debug, Clone)]
enum Element {
    Resistor {
        a: usize,
        b: usize,
        r: f64,
    },
    /// LED from `a` (anode) to `k`; `visual` indexes [`CircuitSim::visuals`].
    Led {
        a: usize,
        k: usize,
        vf: f64,
        imax: f64,
        visual: usize,
        channel: usize,
    },
    /// Resistive load whose voltage the part senses (buzzers).
    Load {
        a: usize,
        b: usize,
        r: f64,
        visual: usize,
    },
    /// Fixed supply.
    Supply {
        n: usize,
        v: f64,
        name: &'static str,
    },
    /// Voltage output `v` (with resistance `r`) from `out` to `gnd`, working
    /// only while the part's supply `vs` − `gnd` is at least `vmin`
    /// (analog temperature sensors).
    Sensor {
        vs: usize,
        out: usize,
        gnd: usize,
        v: f64,
        r: f64,
        vmin: f64,
        visual: usize,
    },
    /// High-impedance input a part reads as a logic level: `a` − `b` above
    /// `threshold` (servo signal, motor driver inputs, supply detection).
    Sense {
        a: usize,
        b: usize,
        threshold: f64,
        visual: usize,
        channel: usize,
    },
}

/// What a part shows, integrated over one display frame.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct PartVisual {
    pub id: String,
    /// LED brightness per colour channel (one for a plain LED, R/G/B for an
    /// RGB LED), 0–1.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub brightness: Vec<f64>,
    /// Some LED channel carried more than its maximum current this frame.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub overcurrent: bool,
    /// Fraction of the frame a buzzer was powered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub on: Option<f64>,
    /// Tone of a passive buzzer (Hz), from the drive's transitions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub freq: Option<f64>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub pressed: bool,
    /// Servo horn or motor shaft angle (degrees).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub angle: Option<f64>,
    /// Motor speed (rev/min, negative = reverse).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rpm: Option<f64>,
    /// The part's supply is too low to work.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unpowered: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum VisualKind {
    Led,
    BuzzerActive,
    BuzzerPassive,
    Switch,
    /// Channels: 0 = signal, 1 = supply present.
    Servo,
    /// Channels: 0 = IA, 1 = IB, 2 = supply present.
    Motor,
    /// Channel 0 = supply present.
    Sensor,
}

#[derive(Debug, Clone)]
struct VisualSlot {
    id: String,
    kind: VisualKind,
    channels: usize,
    /// ∫ brightness dt per channel (cycles), or ∫ on dt for buzzers.
    acc: Vec<f64>,
    overcurrent: bool,
    rises: u32,
    /// Times of the first and last rising edge this frame (passive buzzer).
    first_rise: Cycles,
    last_rise: Cycles,
    /// Servo: start of the pulse being measured, last pulse width (cycles).
    pulse_start: Option<Cycles>,
    pulse: Option<Cycles>,
    /// Servo horn / motor shaft angle (°), servo target, motor speed (rpm).
    angle: f64,
    target: f64,
    rpm: f64,
}

/// The DC operating point for one combination of pin drives.
#[derive(Debug, Clone)]
struct Solution {
    v: Vec<f64>,
    /// Brightness per (visual, channel); buzzer "on" as 0/1.
    level: Vec<Vec<f64>>,
    over: Vec<bool>,
    /// Level seen by each watched MCU pin; `None` = floating.
    inputs: Vec<Option<bool>>,
    warnings: Vec<String>,
}

/// The external circuit plus the Nucleo's own LD2 and B1, ready to be
/// simulated against MCU pin drives.
pub struct CircuitSim {
    /// Number of nodes; node 0 is ground.
    nodes: usize,
    elements: Vec<Element>,
    /// MCU pins on nets with something attached: ((port, pin), node).
    mcu: Vec<((u8, u8), usize)>,
    visuals: Vec<VisualSlot>,
    /// Pressed switches (part ids; `"B1"` is the board's user button).
    pressed: BTreeSet<String>,
    circuit: Circuit,
    catalog: BusCatalog,
    signals: HashMap<String, String>,
    cache: HashMap<Vec<Drive>, Rc<Solution>>,
    drives: Option<Vec<Drive>>,
    current: Option<Rc<Solution>>,
    last_time: Cycles,
    frame_start: Cycles,
    pub warnings: BTreeSet<String>,
    /// The warnings about part values (bad resistance), redone on rebuild.
    value_warnings: Vec<String>,
    board_id: String,
    /// Node of each net-attached pin (for probes): canonical pin → node.
    pin_nodes: HashMap<PinRef, usize>,
}

/// Catalog view that hides the board's buses: board pins are canonicalised
/// to their signal names instead.
struct NoBoardBuses<'a>(&'a BusCatalog);

impl PartCatalog for NoBoardBuses<'_> {
    fn internal_buses(&self, kind: &str) -> &[Vec<String>] {
        if kind == BOARD_KIND {
            &[]
        } else {
            self.0.internal_buses(kind)
        }
    }
}

impl CircuitSim {
    /// Build the simulation. `signals` maps the board's pin ids (`"D13"`,
    /// `"CN10_11"`) to signals (`"PA5"`); pin ids missing from it are taken
    /// as signal names. A circuit without a board part gets one, so LD2 and
    /// B1 always exist.
    pub fn new(
        circuit: &Circuit,
        catalog: &BusCatalog,
        signals: &HashMap<String, String>,
        time: Cycles,
    ) -> Self {
        let mut sim = Self {
            nodes: 1,
            elements: Vec::new(),
            mcu: Vec::new(),
            visuals: Vec::new(),
            pressed: BTreeSet::new(),
            circuit: circuit.clone(),
            catalog: catalog.clone(),
            signals: signals.clone(),
            cache: HashMap::new(),
            drives: None,
            current: None,
            last_time: time,
            frame_start: time,
            warnings: BTreeSet::new(),
            value_warnings: Vec::new(),
            board_id: String::new(),
            pin_nodes: HashMap::new(),
        };
        sim.rebuild();
        sim
    }

    /// Restart the time base (the machine was powered up again at `time`).
    pub fn reset_time(&mut self, time: Cycles) {
        self.drives = None;
        self.current = None;
        self.last_time = time;
        self.frame_start = time;
        for slot in &mut self.visuals {
            slot.acc.iter_mut().for_each(|a| *a = 0.0);
            slot.overcurrent = false;
            slot.rises = 0;
        }
    }

    /// Change the part catalog and the board's pin → signal map.
    pub fn set_catalog(&mut self, catalog: &BusCatalog, signals: &HashMap<String, String>) {
        self.catalog = catalog.clone();
        self.signals = signals.clone();
        self.rebuild();
    }

    /// Replace the circuit (hot-plug); switch states of parts that still
    /// exist are kept.
    pub fn set_circuit(&mut self, circuit: &Circuit, time: Cycles) {
        self.integrate(time);
        self.circuit = circuit.clone();
        let ids: BTreeSet<&str> = circuit.parts.iter().map(|p| p.id.as_str()).collect();
        self.pressed
            .retain(|p| p == "B1" || ids.contains(p.as_str()));
        // The frame keeps its start: parts that survive the edit keep what
        // they accumulated since then (see `rebuild`).
        self.rebuild();
    }

    /// Press or release a switch (a `tact-switch` part id, or `"B1"`).
    /// Returns whether anything changed.
    pub fn set_pressed(&mut self, part: &str, pressed: bool, time: Cycles) -> bool {
        let changed = if pressed {
            self.pressed.insert(part.to_string())
        } else {
            self.pressed.remove(part)
        };
        if changed {
            self.integrate(time);
            self.rebuild();
        }
        changed
    }

    /// MCU pins the circuit observes, in the order [`CircuitSim::update`]
    /// expects their drives.
    pub fn mcu_pins(&self) -> Vec<(u8, u8)> {
        self.mcu.iter().map(|(p, _)| *p).collect()
    }

    fn canonical(&self, p: &PinRef) -> PinRef {
        if p.part == self.board_id {
            let sig = self.signals.get(&p.pin).unwrap_or(&p.pin);
            PinRef::new(&self.board_id, sig)
        } else {
            p.clone()
        }
    }

    fn rebuild(&mut self) {
        self.cache.clear();
        self.drives = None;
        self.current = None;
        let parts = self.circuit.parts.clone();
        self.board_id = parts
            .iter()
            .find(|p| p.kind == BOARD_KIND)
            .map_or_else(|| "board".to_string(), |p| p.id.clone());
        let board = self.board_id.clone();
        let bp = |sig: &str| PinRef::new(&board, sig);

        // Wires in canonical form, plus closed switches and the board's
        // own components.
        let mut wires: Vec<Wire> = self
            .circuit
            .wires
            .iter()
            .map(|w| Wire {
                a: self.canonical(&w.a),
                b: self.canonical(&w.b),
            })
            .collect();
        let mut all_parts = parts.clone();
        if !parts.iter().any(|p| p.kind == BOARD_KIND) {
            all_parts.push(PartInstance {
                id: board.clone(),
                kind: BOARD_KIND.into(),
                props: Default::default(),
            });
        }
        // LD2: PA5 → 510 Ω → green LED → GND. B1: 4.7 kΩ pull-up on PC13,
        // button to GND (UM1724).
        let ld2 = PinRef::new("@LD2", "A");
        let ld2r = PinRef::new("@LD2R", "2");
        wires.push(Wire {
            a: bp("PA5"),
            b: PinRef::new("@LD2R", "1"),
        });
        wires.push(Wire {
            a: ld2r.clone(),
            b: ld2.clone(),
        });
        wires.push(Wire {
            a: PinRef::new("@LD2", "K"),
            b: bp("GND"),
        });
        wires.push(Wire {
            a: bp("PC13"),
            b: PinRef::new("@B1R", "1"),
        });
        wires.push(Wire {
            a: PinRef::new("@B1R", "2"),
            b: bp("3V3"),
        });
        if self.pressed.contains("B1") {
            wires.push(Wire {
                a: bp("PC13"),
                b: bp("GND"),
            });
        }
        for p in &parts {
            if p.kind == "tact-switch" && self.pressed.contains(&p.id) {
                wires.push(Wire {
                    a: PinRef::new(&p.id, "1a"),
                    b: PinRef::new(&p.id, "2a"),
                });
            }
        }
        // Every supply and ground pin exists even if nothing is wired.
        for s in ["GND", "3V3", "5V", "IOREF"] {
            wires.push(Wire { a: bp(s), b: bp(s) });
        }
        let aug = Circuit {
            parts: all_parts,
            wires,
        };
        let netlist = build_netlist(&aug, &NoBoardBuses(&self.catalog));

        // Node numbering: ground net first.
        let gnd = netlist.net_of(&bp("GND"));
        let mut node_of_net = vec![0usize; netlist.nets.len()];
        let mut next = 1;
        for (i, slot) in node_of_net.iter_mut().enumerate() {
            if Some(i) != gnd {
                *slot = next;
                next += 1;
            }
        }
        self.pin_nodes.clear();
        for (i, net) in netlist.nets.iter().enumerate() {
            for p in &net.pins {
                self.pin_nodes.insert(p.clone(), node_of_net[i]);
            }
        }
        let mut nodes = next;
        let mut node = |pin: PinRef, map: &mut HashMap<PinRef, usize>| -> usize {
            *map.entry(pin).or_insert_with(|| {
                nodes += 1;
                nodes - 1
            })
        };

        let mut elements = Vec::new();
        let mut visuals = Vec::new();
        let mut bad_values: Vec<String> = Vec::new();
        let mut map = std::mem::take(&mut self.pin_nodes);
        let mut add_visual = |id: &str, kind: VisualKind, channels: usize| {
            visuals.push(VisualSlot {
                id: id.to_string(),
                kind,
                channels,
                acc: vec![0.0; channels],
                overcurrent: false,
                rises: 0,
                first_rise: 0,
                last_rise: 0,
                pulse_start: None,
                pulse: None,
                angle: 90.0,
                target: 90.0,
                rpm: 0.0,
            });
            visuals.len() - 1
        };
        let prop = |p: &PartInstance, k: &str| p.props.get(k).cloned();
        let prop_f64 = |p: &PartInstance, k: &str, d: f64| -> f64 {
            match p.props.get(k) {
                Some(serde_json::Value::Number(n)) => n.as_f64().unwrap_or(d),
                Some(serde_json::Value::String(s)) => s.trim().parse().unwrap_or(d),
                _ => d,
            }
        };
        let prop_str = |p: &PartInstance, k: &str, d: &str| {
            p.props
                .get(k)
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_else(|| d.to_string())
        };

        // Board components.
        let a = node(ld2r.clone(), &mut map);
        let pa5 = node(bp("PA5"), &mut map);
        elements.push(Element::Resistor {
            a: pa5,
            b: a,
            r: 510.0,
        });
        let v = add_visual("LD2", VisualKind::Led, 1);
        let (la, lk) = (
            node(ld2, &mut map),
            node(PinRef::new("@LD2", "K"), &mut map),
        );
        elements.push(Element::Led {
            a: la,
            k: lk,
            vf: 2.1,
            imax: 0.02,
            visual: v,
            channel: 0,
        });
        let (r1, r2) = (
            node(PinRef::new("@B1R", "1"), &mut map),
            node(PinRef::new("@B1R", "2"), &mut map),
        );
        elements.push(Element::Resistor {
            a: r1,
            b: r2,
            r: 4_700.0,
        });
        add_visual("B1", VisualKind::Switch, 0);

        for (sig, v, name) in [
            ("3V3", VDD, "3V3"),
            ("IOREF", VDD, "IOREF"),
            ("5V", 5.0, "5V"),
        ] {
            let n = node(bp(sig), &mut map);
            elements.push(Element::Supply { n, v, name });
        }

        for p in &parts {
            match p.kind.as_str() {
                "led-5mm" => {
                    let color = prop_str(p, "color", "red");
                    let vis = add_visual(&p.id, VisualKind::Led, 1);
                    elements.push(Element::Led {
                        a: node(PinRef::new(&p.id, "A"), &mut map),
                        k: node(PinRef::new(&p.id, "K"), &mut map),
                        vf: led_vf(&color),
                        imax: 0.02,
                        visual: vis,
                        channel: 0,
                    });
                }
                "rgb-led" => {
                    let common = node(PinRef::new(&p.id, "COM"), &mut map);
                    let anode = prop_str(p, "common", "cathode") == "anode";
                    let vis = add_visual(&p.id, VisualKind::Led, 3);
                    for (ch, (pin, vf)) in
                        [("R", 1.9), ("G", 2.9), ("B", 2.9)].into_iter().enumerate()
                    {
                        let n = node(PinRef::new(&p.id, pin), &mut map);
                        let (a, k) = if anode { (common, n) } else { (n, common) };
                        elements.push(Element::Led {
                            a,
                            k,
                            vf,
                            imax: 0.02,
                            visual: vis,
                            channel: ch,
                        });
                    }
                }
                "resistor" => {
                    let a = node(PinRef::new(&p.id, "1"), &mut map);
                    let b = node(PinRef::new(&p.id, "2"), &mut map);
                    match prop(p, "ohms") {
                        None => elements.push(Element::Resistor { a, b, r: 220.0 }),
                        Some(v) => match parse_ohms(&v) {
                            Some(r) => elements.push(Element::Resistor { a, b, r }),
                            // Unknown value: leave it open and say so.
                            None => bad_values.push(format!(
                                "{}: unknown resistance {v} (e.g. 220, 4.7k, 4k7, 1M)",
                                p.id
                            )),
                        },
                    }
                }
                "buzzer-active" | "buzzer-passive" => {
                    let active = p.kind == "buzzer-active";
                    let kind = if active {
                        VisualKind::BuzzerActive
                    } else {
                        VisualKind::BuzzerPassive
                    };
                    let vis = add_visual(&p.id, kind, 1);
                    elements.push(Element::Load {
                        a: node(PinRef::new(&p.id, "+"), &mut map),
                        b: node(PinRef::new(&p.id, "-"), &mut map),
                        r: if active { 330.0 } else { 1_000.0 },
                        visual: vis,
                    });
                }
                "tact-switch" => {
                    add_visual(&p.id, VisualKind::Switch, 0);
                }
                "potentiometer" => {
                    // 1 —[R·pos]— W —[R·(1−pos)]— 2
                    let r = prop(p, "ohms")
                        .as_ref()
                        .and_then(parse_ohms)
                        .unwrap_or(10_000.0);
                    let pos = prop_f64(p, "position", 0.5).clamp(0.0, 1.0);
                    let (a, w, b) = (
                        node(PinRef::new(&p.id, "1"), &mut map),
                        node(PinRef::new(&p.id, "W"), &mut map),
                        node(PinRef::new(&p.id, "2"), &mut map),
                    );
                    elements.push(Element::Resistor {
                        a,
                        b: w,
                        r: (r * pos).max(1.0),
                    });
                    elements.push(Element::Resistor {
                        a: w,
                        b,
                        r: (r * (1.0 - pos)).max(1.0),
                    });
                }
                "ldr" => {
                    // Light-dependent resistor (GL55xx class): 10 kΩ at 10 lux, γ = 0.7.
                    let lux = prop_f64(p, "lux", 300.0).max(0.01);
                    let r = (10_000.0 * (lux / 10.0).powf(-0.7)).clamp(50.0, 2e6);
                    elements.push(Element::Resistor {
                        a: node(PinRef::new(&p.id, "1"), &mut map),
                        b: node(PinRef::new(&p.id, "2"), &mut map),
                        r,
                    });
                }
                "temp-sensor" => {
                    // TMP36: 0.5 V + 10 mV/°C from 2.7 V; LM35: 10 mV/°C, needs 4 V.
                    let t = prop_f64(p, "temp", 25.0);
                    let lm35 = prop_str(p, "model", "TMP36") == "LM35";
                    let (v, vmin) = if lm35 {
                        ((0.01 * t).max(0.0), 4.0)
                    } else {
                        ((0.5 + 0.01 * t).max(0.0), 2.7)
                    };
                    let vis = add_visual(&p.id, VisualKind::Sensor, 1);
                    elements.push(Element::Sensor {
                        vs: node(PinRef::new(&p.id, "VS"), &mut map),
                        out: node(PinRef::new(&p.id, "OUT"), &mut map),
                        gnd: node(PinRef::new(&p.id, "GND"), &mut map),
                        v,
                        r: 50.0,
                        vmin,
                        visual: vis,
                    });
                }
                "servo" => {
                    let vis = add_visual(&p.id, VisualKind::Servo, 2);
                    let gnd = node(PinRef::new(&p.id, "GND"), &mut map);
                    elements.push(Element::Sense {
                        a: node(PinRef::new(&p.id, "SIG"), &mut map),
                        b: gnd,
                        threshold: 1.5,
                        visual: vis,
                        channel: 0,
                    });
                    elements.push(Element::Sense {
                        a: node(PinRef::new(&p.id, "V+"), &mut map),
                        b: gnd,
                        threshold: 3.0,
                        visual: vis,
                        channel: 1,
                    });
                }
                "dc-motor" => {
                    // Motor with an H-bridge driver module (L9110S class).
                    let vis = add_visual(&p.id, VisualKind::Motor, 3);
                    let gnd = node(PinRef::new(&p.id, "GND"), &mut map);
                    for (ch, pin, threshold) in [(0, "IA", 1.5), (1, "IB", 1.5), (2, "VCC", 2.5)] {
                        elements.push(Element::Sense {
                            a: node(PinRef::new(&p.id, pin), &mut map),
                            b: gnd,
                            threshold,
                            visual: vis,
                            channel: ch,
                        });
                    }
                }
                _ => {}
            }
        }

        // MCU pins with anything attached besides themselves.
        let mut mcu: BTreeMap<(u8, u8), usize> = BTreeMap::new();
        for net in &netlist.nets {
            for pin in &net.pins {
                if pin.part != board {
                    continue;
                }
                if let Some(pp) = parse_mcu_pin(&pin.pin) {
                    mcu.insert(pp, map[pin]);
                }
            }
        }
        // Keep what this frame accumulated for parts that still exist.
        for slot in &mut visuals {
            if let Some(old) = self
                .visuals
                .iter()
                .find(|o| o.id == slot.id && o.channels == slot.channels)
            {
                slot.acc = old.acc.clone();
                slot.overcurrent = old.overcurrent;
                slot.rises = old.rises;
                slot.pulse_start = old.pulse_start;
                slot.pulse = old.pulse;
                slot.angle = old.angle;
                slot.target = old.target;
                slot.rpm = old.rpm;
            }
        }
        // Value problems describe the circuit as it is now.
        for w in self.value_warnings.drain(..) {
            self.warnings.remove(&w);
        }
        self.warnings.extend(bad_values.iter().cloned());
        self.value_warnings = bad_values;
        self.pin_nodes = map;
        self.nodes = nodes;
        self.elements = elements;
        self.visuals = visuals;
        self.mcu = mcu.into_iter().collect();
    }

    /// Node voltages and currents for a set of drives.
    fn solve(&self, drives: &[Drive]) -> Solution {
        let n = self.nodes;
        // Per-LED on/off state, iterated to consistency.
        let leds: Vec<usize> = (0..self.elements.len())
            .filter(|&i| {
                matches!(
                    self.elements[i],
                    Element::Led { .. } | Element::Sensor { .. }
                )
            })
            .collect();
        // Sensors start powered; LEDs start off.
        let mut on: Vec<bool> = self
            .elements
            .iter()
            .map(|e| matches!(e, Element::Sensor { .. }))
            .collect();
        let mut v = vec![0.0; n];
        for _ in 0..32 {
            v = self.nodal(drives, &on);
            let mut changed = false;
            for &i in &leds {
                let now = match self.elements[i] {
                    Element::Led { a, k, vf, .. } => {
                        let vd = v[a] - v[k];
                        if on[i] {
                            vd - vf > -1e-9
                        } else {
                            vd > vf + 1e-6
                        }
                    }
                    Element::Sensor { vs, gnd, vmin, .. } => v[vs] - v[gnd] >= vmin - 1e-6,
                    _ => on[i],
                };
                if now != on[i] {
                    on[i] = now;
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }

        let mut warnings = Vec::new();
        let mut level: Vec<Vec<f64>> = self.visuals.iter().map(|s| vec![0.0; s.channels]).collect();
        let mut over = vec![false; self.visuals.len()];
        for (i, e) in self.elements.iter().enumerate() {
            match *e {
                Element::Led {
                    a,
                    k,
                    vf,
                    imax,
                    visual,
                    channel,
                } if on[i] => {
                    let cur = ((v[a] - v[k] - vf) / R_LED).max(0.0);
                    // Perceived brightness: a 5 mm LED looks fully lit from
                    // about 2 mA; below that, roughly with √I.
                    level[visual][channel] = (cur / 0.002).sqrt().min(1.0);
                    if cur > imax {
                        over[visual] = true;
                        warnings.push(format!(
                            "{}: {:.0} mA exceeds the LED's {:.0} mA — add a series resistor",
                            self.visuals[visual].id,
                            cur * 1e3,
                            imax * 1e3
                        ));
                    }
                }
                Element::Load { a, b, visual, .. } => {
                    level[visual][0] = if v[a] - v[b] > 2.0 { 1.0 } else { 0.0 };
                }
                Element::Sense {
                    a,
                    b,
                    threshold,
                    visual,
                    channel,
                } => {
                    level[visual][channel] = if v[a] - v[b] > threshold { 1.0 } else { 0.0 };
                }
                Element::Sensor {
                    vs,
                    gnd,
                    vmin,
                    visual,
                    ..
                } => {
                    level[visual][0] = if on[i] { 1.0 } else { 0.0 };
                    let supply = v[vs] - v[gnd];
                    if !on[i] && supply > 0.5 {
                        warnings.push(format!(
                            "{}: supply {supply:.1} V is below the sensor's {vmin:.1} V minimum — no output",
                            self.visuals[visual].id
                        ));
                    }
                }
                Element::Supply { n, v: vs, name } => {
                    let cur = (vs - v[n]) / R_SUPPLY;
                    if cur > 0.5 {
                        warnings.push(format!(
                            "short circuit: {name} is connected straight to a lower voltage (GND?)"
                        ));
                    }
                }
                _ => {}
            }
        }

        // MCU pins: logic level and over-current.
        let comp = self.components(drives, &on);
        let mut inputs = Vec::with_capacity(self.mcu.len());
        for (i, &((port, pin), node)) in self.mcu.iter().enumerate() {
            let name = format!("P{}{}", (b'A' + port) as char, pin);
            if let Some((vs, _)) = drive_source(drives[i]) {
                if matches!(drives[i], Drive::High | Drive::Low) {
                    let cur = (vs - v[node]) / R_ON;
                    if cur.abs() > PIN_MAX {
                        warnings.push(format!(
                            "{name}: output {} sources {:.0} mA, more than the pin's 25 mA (short or missing resistor?)",
                            if drives[i] == Drive::High { "high" } else { "low" },
                            cur.abs() * 1e3
                        ));
                    }
                }
            }
            if v[node] > 4.0 && node != 0 {
                warnings.push(format!(
                    "{name}: {:.1} V applied — the pin's maximum is VDD + 0.3 V for analog pins",
                    v[node]
                ));
            }
            inputs.push(comp[node].then_some(v[node] > VDD / 2.0));
        }
        Solution {
            v,
            level,
            over,
            inputs,
            warnings,
        }
    }

    /// Nodes connected to some source through conducting elements.
    fn components(&self, drives: &[Drive], on: &[bool]) -> Vec<bool> {
        let n = self.nodes;
        let mut parent: Vec<usize> = (0..n).collect();
        fn find(p: &mut [usize], x: usize) -> usize {
            let mut r = x;
            while p[r] != r {
                r = p[r];
            }
            p[x] = r;
            r
        }
        let union = |p: &mut Vec<usize>, a: usize, b: usize| {
            let (ra, rb) = (find(p, a), find(p, b));
            if ra != rb {
                p[ra.max(rb)] = ra.min(rb);
            }
        };
        for (i, e) in self.elements.iter().enumerate() {
            match *e {
                Element::Resistor { a, b, .. } | Element::Load { a, b, .. } => {
                    union(&mut parent, a, b)
                }
                Element::Led { a, k, .. } if on[i] => union(&mut parent, a, k),
                Element::Sensor { out, gnd, .. } if on[i] => union(&mut parent, out, gnd),
                _ => {}
            }
        }
        let mut sourced = vec![false; n];
        sourced[find(&mut parent, 0)] = true;
        for e in &self.elements {
            if let Element::Supply { n, .. } = *e {
                let r = find(&mut parent, n);
                sourced[r] = true;
            }
        }
        for (i, &(_, node)) in self.mcu.iter().enumerate() {
            if drive_source(drives[i]).is_some() {
                let r = find(&mut parent, node);
                sourced[r] = true;
            }
        }
        (0..n).map(|x| sourced[find(&mut parent, x)]).collect()
    }

    /// Linear nodal analysis with the LEDs in the given states.
    fn nodal(&self, drives: &[Drive], on: &[bool]) -> Vec<f64> {
        let n = self.nodes;
        let m = n - 1; // unknowns: nodes 1..n
        let mut g = vec![0.0; m * m];
        let mut rhs = vec![0.0; m];
        let stamp = |g: &mut [f64], a: usize, b: usize, cond: f64| {
            if a > 0 {
                g[(a - 1) * m + (a - 1)] += cond;
            }
            if b > 0 {
                g[(b - 1) * m + (b - 1)] += cond;
            }
            if a > 0 && b > 0 {
                g[(a - 1) * m + (b - 1)] -= cond;
                g[(b - 1) * m + (a - 1)] -= cond;
            }
        };
        let source = |g: &mut [f64], rhs: &mut [f64], node: usize, v: f64, r: f64| {
            if node > 0 {
                g[(node - 1) * m + (node - 1)] += 1.0 / r;
                rhs[node - 1] += v / r;
            }
        };
        for i in 1..n {
            g[(i - 1) * m + (i - 1)] += GMIN;
        }
        for (i, e) in self.elements.iter().enumerate() {
            match *e {
                Element::Resistor { a, b, r } | Element::Load { a, b, r, .. } => {
                    stamp(&mut g, a, b, 1.0 / r)
                }
                Element::Led { a, k, vf, .. } if on[i] => {
                    let c = 1.0 / R_LED;
                    stamp(&mut g, a, k, c);
                    if a > 0 {
                        rhs[a - 1] += vf * c;
                    }
                    if k > 0 {
                        rhs[k - 1] -= vf * c;
                    }
                }
                Element::Supply { n, v, .. } => source(&mut g, &mut rhs, n, v, R_SUPPLY),
                Element::Sensor { out, gnd, v, r, .. } if on[i] => {
                    // Norton source v/r from gnd into out, with r across.
                    let c = 1.0 / r;
                    stamp(&mut g, out, gnd, c);
                    if out > 0 {
                        rhs[out - 1] += v * c;
                    }
                    if gnd > 0 {
                        rhs[gnd - 1] -= v * c;
                    }
                }
                _ => {}
            }
        }
        for (i, &(_, node)) in self.mcu.iter().enumerate() {
            if let Some((v, r)) = drive_source(drives[i]) {
                source(&mut g, &mut rhs, node, v, r);
            }
        }
        let x = gauss(&mut g, &mut rhs, m);
        let mut v = vec![0.0; n];
        v[1..].copy_from_slice(&x);
        v
    }

    /// Accumulate the current solution's visual levels up to `time`.
    fn integrate(&mut self, time: Cycles) {
        if let Some(sol) = &self.current {
            let dt = time.saturating_sub(self.last_time) as f64;
            for (slot, lv) in self.visuals.iter_mut().zip(&sol.level) {
                for (acc, l) in slot.acc.iter_mut().zip(lv) {
                    *acc += l * dt;
                }
            }
        }
        self.last_time = self.last_time.max(time);
    }

    /// The MCU's drives changed (or this is the first call). Returns the
    /// input level of every pin of [`CircuitSim::mcu_pins`] if any of them
    /// may have changed.
    pub fn update(&mut self, time: Cycles, drives: &[Drive]) -> Option<Vec<Option<bool>>> {
        if self.drives.as_deref() == Some(drives) {
            return None;
        }
        self.integrate(time);
        let sol = match self.cache.get(drives) {
            Some(s) => s.clone(),
            None => {
                let s = Rc::new(self.solve(drives));
                for w in &s.warnings {
                    self.warnings.insert(w.clone());
                }
                if self.cache.len() > 4096 {
                    self.cache.clear();
                }
                self.cache.insert(drives.to_vec(), s.clone());
                s
            }
        };
        let old = self.current.replace(sol.clone());
        for (i, slot) in self.visuals.iter_mut().enumerate() {
            if sol.over[i] {
                slot.overcurrent = true;
            }
            let was = old
                .as_ref()
                .is_some_and(|o| o.level[i].first() > Some(&0.5));
            if slot.kind == VisualKind::BuzzerPassive && !was && sol.level[i].first() > Some(&0.5) {
                if slot.rises == 0 {
                    slot.first_rise = time;
                }
                slot.last_rise = time;
                slot.rises += 1;
            }
            // Servo: measure the width of each signal pulse.
            if slot.kind == VisualKind::Servo {
                let now = sol.level[i].first() > Some(&0.5);
                if !was && now {
                    slot.pulse_start = Some(time);
                } else if was && !now {
                    if let Some(start) = slot.pulse_start.take() {
                        slot.pulse = Some(time - start);
                    }
                }
            }
        }
        self.drives = Some(drives.to_vec());
        let changed = old.is_none_or(|o| o.inputs != sol.inputs);
        changed.then(|| sol.inputs.clone())
    }

    /// Close the display frame at `time`; `seconds` is its simulated length.
    pub fn end_frame(&mut self, time: Cycles, seconds: f64) -> Vec<PartVisual> {
        self.integrate(time);
        let span = time.saturating_sub(self.frame_start) as f64;
        let cur = self.current.clone();
        let mut out = Vec::new();
        for (i, slot) in self.visuals.iter_mut().enumerate() {
            // Without elapsed time, show the present state.
            let now: Vec<f64> = cur
                .as_ref()
                .map_or(vec![0.0; slot.channels], |s| s.level[i].clone());
            let avg: Vec<f64> = if span > 0.0 {
                slot.acc
                    .iter()
                    .map(|a| (a / span).clamp(0.0, 1.0))
                    .collect()
            } else {
                now
            };
            let mut v = PartVisual {
                id: slot.id.clone(),
                ..Default::default()
            };
            match slot.kind {
                VisualKind::Led => {
                    v.brightness = avg;
                    v.overcurrent = slot.overcurrent;
                }
                VisualKind::BuzzerActive => v.on = avg.first().copied(),
                VisualKind::BuzzerPassive => {
                    v.on = avg.first().copied();
                    // Periods between the first and last rising edge.
                    let between = slot.last_rise.saturating_sub(slot.first_rise) as f64;
                    if seconds > 0.0 && span > 0.0 && slot.rises > 1 && between > 0.0 {
                        v.freq = Some((slot.rises - 1) as f64 / (between * seconds / span));
                    }
                }
                VisualKind::Switch => v.pressed = self.pressed.contains(&slot.id),
                VisualKind::Servo => {
                    let powered = avg.get(1).copied().unwrap_or(0.0) > 0.5;
                    // Pulse width → angle: 0.5 ms = 0°, 1.5 ms = 90°, 2.5 ms = 180°.
                    if let (Some(p), true) = (slot.pulse, seconds > 0.0 && span > 0.0) {
                        let width = p as f64 * seconds / span;
                        if (0.0003..0.003).contains(&width) {
                            slot.target = ((width - 0.0005) / 0.002 * 180.0).clamp(0.0, 180.0);
                        }
                    }
                    if powered {
                        // About 0.1 s per 60° (SG90 class).
                        let step = 600.0 * seconds;
                        slot.angle += (slot.target - slot.angle).clamp(-step, step);
                    }
                    v.angle = Some(slot.angle);
                    v.unpowered = !powered;
                }
                VisualKind::Motor => {
                    let powered = avg.get(2).copied().unwrap_or(0.0) > 0.5;
                    let duty = avg[0] - avg[1];
                    let target = if powered { duty * MOTOR_MAX_RPM } else { 0.0 };
                    // First-order response, time constant 0.15 s.
                    slot.rpm = target + (slot.rpm - target) * (-seconds / 0.15).exp();
                    slot.angle = (slot.angle + slot.rpm / 60.0 * 360.0 * seconds).rem_euclid(360.0);
                    v.rpm = Some(slot.rpm);
                    v.angle = Some(slot.angle);
                    v.unpowered = !powered;
                }
                VisualKind::Sensor => v.unpowered = avg.first().copied().unwrap_or(0.0) < 0.5,
            }
            slot.acc.iter_mut().for_each(|a| *a = 0.0);
            // The next frame starts in the present operating point.
            slot.overcurrent = cur.as_ref().is_some_and(|s| s.over[i]);
            slot.rises = 0;
            out.push(v);
        }
        self.frame_start = time;
        out
    }

    /// Voltage on an MCU pin (port 0 = A) from the present operating point,
    /// if the circuit connects anything to it (for the ADC).
    pub fn mcu_voltage(&self, port: u8, pin: u8) -> Option<f64> {
        let &(_, node) = self.mcu.iter().find(|(p, _)| *p == (port, pin))?;
        Some(self.current.as_ref().map_or(0.0, |s| s.v[node]))
    }

    /// Voltage of the net a pin is on (for probes), from the present
    /// operating point.
    pub fn voltage(&self, pin: &PinRef) -> Option<f64> {
        let node = *self.pin_nodes.get(&self.canonical(pin))?;
        Some(self.current.as_ref().map_or(0.0, |s| s.v[node]))
    }
}

/// Norton equivalent (voltage, resistance) of a pin drive.
fn drive_source(d: Drive) -> Option<(f64, f64)> {
    match d {
        Drive::High => Some((VDD, R_ON)),
        Drive::Low => Some((0.0, R_ON)),
        Drive::PullUp => Some((VDD, R_PULL)),
        Drive::PullDown => Some((0.0, R_PULL)),
        Drive::Float => None,
    }
}

/// Solve `a x = b` (n×n, row-major) by Gaussian elimination with partial
/// pivoting. The matrix is diagonally dominant thanks to GMIN.
fn gauss(a: &mut [f64], b: &mut [f64], n: usize) -> Vec<f64> {
    for col in 0..n {
        let piv = (col..n)
            .max_by(|&i, &j| a[i * n + col].abs().total_cmp(&a[j * n + col].abs()))
            .unwrap();
        if piv != col {
            for k in 0..n {
                a.swap(piv * n + k, col * n + k);
            }
            b.swap(piv, col);
        }
        let d = a[col * n + col];
        if d.abs() < 1e-30 {
            continue;
        }
        for row in col + 1..n {
            let f = a[row * n + col] / d;
            if f == 0.0 {
                continue;
            }
            for k in col..n {
                a[row * n + k] -= f * a[col * n + k];
            }
            b[row] -= f * b[col];
        }
    }
    let mut x = vec![0.0; n];
    for row in (0..n).rev() {
        let mut s = b[row];
        for k in row + 1..n {
            s -= a[row * n + k] * x[k];
        }
        let d = a[row * n + row];
        x[row] = if d.abs() < 1e-30 { 0.0 } else { s / d };
    }
    x
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::netlist::PartInstance;

    fn part(id: &str, kind: &str, props: &[(&str, &str)]) -> PartInstance {
        PartInstance {
            id: id.into(),
            kind: kind.into(),
            props: props
                .iter()
                .map(|(k, v)| (k.to_string(), serde_json::Value::String(v.to_string())))
                .collect(),
        }
    }

    fn wire(a: (&str, &str), b: (&str, &str)) -> Wire {
        Wire {
            a: PinRef::new(a.0, a.1),
            b: PinRef::new(b.0, b.1),
        }
    }

    fn sim(parts: Vec<PartInstance>, wires: Vec<Wire>) -> CircuitSim {
        let mut parts = parts;
        parts.insert(0, part("mcu", BOARD_KIND, &[]));
        let mut signals = HashMap::new();
        signals.insert("D7".to_string(), "PA8".to_string());
        signals.insert("GND_1".to_string(), "GND".to_string());
        CircuitSim::new(
            &Circuit { parts, wires },
            &BusCatalog::default(),
            &signals,
            0,
        )
    }

    fn drives(s: &CircuitSim, f: impl Fn((u8, u8)) -> Drive) -> Vec<Drive> {
        s.mcu_pins().into_iter().map(f).collect()
    }

    fn visual<'a>(v: &'a [PartVisual], id: &str) -> &'a PartVisual {
        v.iter().find(|x| x.id == id).unwrap()
    }

    #[test]
    fn led_with_resistor_lights_and_dims_with_pwm() {
        // D7 → 220 Ω → LED → GND
        let mut s = sim(
            vec![
                part("r1", "resistor", &[("ohms", "220")]),
                part("led1", "led-5mm", &[("color", "red")]),
            ],
            vec![
                wire(("mcu", "D7"), ("r1", "1")),
                wire(("r1", "2"), ("led1", "A")),
                wire(("led1", "K"), ("mcu", "GND_1")),
            ],
        );
        assert!(s.mcu_pins().contains(&(0, 8)));
        let hi = drives(&s, |p| {
            if p == (0, 8) {
                Drive::High
            } else {
                Drive::Float
            }
        });
        let lo = drives(&s, |_| Drive::Float);
        s.update(0, &lo);
        s.end_frame(0, 0.0);
        // 25 % duty over a frame of 1000 cycles.
        for k in 0..10 {
            s.update(k * 100, &hi);
            s.update(k * 100 + 25, &lo);
        }
        let v = s.end_frame(1000, 1e-3);
        let b = visual(&v, "led1").brightness[0];
        // (3.3 − 1.9) / (40 + 220 + 15) = 5.1 mA: fully lit, × 25 %.
        assert!((b - 0.25).abs() < 0.01, "{b}");
        assert!(!visual(&v, "led1").overcurrent);
        assert!(s.warnings.is_empty(), "{:?}", s.warnings);
        assert_eq!(visual(&v, "LD2").brightness, vec![0.0]);
    }

    #[test]
    fn led_without_resistor_is_flagged() {
        let mut s = sim(
            vec![part("led1", "led-5mm", &[("color", "red")])],
            vec![
                wire(("mcu", "D7"), ("led1", "A")),
                wire(("led1", "K"), ("mcu", "GND")),
            ],
        );
        let hi = drives(&s, |p| {
            if p == (0, 8) {
                Drive::High
            } else {
                Drive::Float
            }
        });
        s.update(0, &hi);
        let v = s.end_frame(100, 1e-6);
        assert!(visual(&v, "led1").overcurrent);
        // Still lit, no change in drives: still flagged in later frames.
        let v = s.end_frame(200, 1e-6);
        assert!(visual(&v, "led1").overcurrent);
        assert!(
            s.warnings.iter().any(|w| w.starts_with("led1:")),
            "{:?}",
            s.warnings
        );
    }

    #[test]
    fn button_with_pull_up_reads_low_when_pressed() {
        // D7 (PA8, internal pull-up) — switch — GND
        let mut s = sim(
            vec![part("sw1", "tact-switch", &[])],
            vec![
                wire(("mcu", "D7"), ("sw1", "1a")),
                wire(("sw1", "2a"), ("mcu", "GND")),
            ],
        );
        let idx = s.mcu_pins().iter().position(|p| *p == (0, 8)).unwrap();
        let d = drives(&s, |p| {
            if p == (0, 8) {
                Drive::PullUp
            } else {
                Drive::Float
            }
        });
        assert_eq!(s.update(0, &d).unwrap()[idx], Some(true));
        assert!(s.set_pressed("sw1", true, 10));
        assert_eq!(s.update(10, &d).unwrap()[idx], Some(false));
        // Without a pull the input floats while released.
        s.set_pressed("sw1", false, 20);
        let f = drives(&s, |_| Drive::Float);
        assert_eq!(s.update(20, &f).unwrap()[idx], None);
    }

    #[test]
    fn board_b1_and_ld2() {
        let mut s = CircuitSim::new(
            &Circuit::default(),
            &BusCatalog::default(),
            &HashMap::new(),
            0,
        );
        let pins = s.mcu_pins();
        assert_eq!(pins, vec![(0, 5), (2, 13)]);
        let d = vec![Drive::High, Drive::Float];
        assert_eq!(s.update(0, &d), Some(vec![Some(true), Some(true)]));
        s.set_pressed("B1", true, 0);
        assert_eq!(s.update(0, &d), Some(vec![Some(true), Some(false)]));
        let v = s.end_frame(1, 1e-6);
        assert!(visual(&v, "LD2").brightness[0] > 0.3);
        assert!(visual(&v, "B1").pressed);
    }

    #[test]
    fn output_short_and_supply_short_warn() {
        let mut s = sim(
            vec![],
            vec![
                wire(("mcu", "D7"), ("mcu", "GND")),
                wire(("mcu", "3V3"), ("mcu", "GND_1")),
            ],
        );
        let d = drives(&s, |p| {
            if p == (0, 8) {
                Drive::High
            } else {
                Drive::Float
            }
        });
        s.update(0, &d);
        assert!(
            s.warnings.iter().any(|w| w.starts_with("PA8: output high")),
            "{:?}",
            s.warnings
        );
        assert!(
            s.warnings
                .iter()
                .any(|w| w.starts_with("short circuit: 3V3")),
            "{:?}",
            s.warnings
        );
    }

    #[test]
    fn passive_buzzer_frequency_and_rgb() {
        let mut s = sim(
            vec![
                part("bz", "buzzer-passive", &[]),
                part("rgb", "rgb-led", &[]),
                part("rr", "resistor", &[("ohms", "330")]),
            ],
            vec![
                wire(("mcu", "D7"), ("bz", "+")),
                wire(("bz", "-"), ("mcu", "GND")),
                wire(("mcu", "PB4"), ("rr", "1")),
                wire(("rr", "2"), ("rgb", "G")),
                wire(("rgb", "COM"), ("mcu", "GND")),
            ],
        );
        let tone = |high: bool| {
            drives(&s, |p| match p {
                (0, 8) => {
                    if high {
                        Drive::High
                    } else {
                        Drive::Low
                    }
                }
                (1, 4) => Drive::High,
                _ => Drive::Float,
            })
        };
        let (h, l) = (tone(true), tone(false));
        for k in 0..100u64 {
            s.update(k * 10, &h);
            s.update(k * 10 + 5, &l);
        }
        // 100 periods in 1 ms of "simulated time".
        let v = s.end_frame(1000, 1e-3);
        let bz = visual(&v, "bz");
        assert!(
            (bz.freq.unwrap() - 100_000.0).abs() < 2_000.0,
            "{:?}",
            bz.freq
        );
        let rgb = &visual(&v, "rgb").brightness;
        assert_eq!(rgb[0], 0.0);
        assert!(rgb[1] > 0.1 && rgb[2] == 0.0, "{rgb:?}");
    }

    #[test]
    fn rewiring_mid_frame_keeps_the_average() {
        // D7 → 220 Ω → LED → GND, on for the first half of a frame. Editing
        // the project (same circuit) halfway must not change the result.
        let parts = vec![
            part("mcu", BOARD_KIND, &[]),
            part("r1", "resistor", &[("ohms", "220")]),
            part("led1", "led-5mm", &[]),
        ];
        let wires = vec![
            wire(("mcu", "D7"), ("r1", "1")),
            wire(("r1", "2"), ("led1", "A")),
            wire(("led1", "K"), ("mcu", "GND")),
        ];
        let mut s = sim(parts[1..].to_vec(), wires.clone());
        let on = drives(&s, |p| {
            if p == (0, 8) {
                Drive::High
            } else {
                Drive::Float
            }
        });
        let off = drives(&s, |_| Drive::Float);
        s.end_frame(0, 0.0);
        s.update(0, &on);
        s.set_circuit(&Circuit { parts, wires }, 500);
        s.update(500, &off);
        let v = s.end_frame(1000, 1e-3);
        let b = visual(&v, "led1").brightness[0];
        assert!((b - 0.5).abs() < 0.01, "{b}");
    }

    #[test]
    fn unknown_resistance_warns_until_fixed() {
        let wires = vec![wire(("mcu", "D7"), ("r1", "1"))];
        let mut s = sim(
            vec![part("r1", "resistor", &[("ohms", "abc")])],
            wires.clone(),
        );
        assert!(
            s.warnings
                .iter()
                .any(|w| w.starts_with("r1: unknown resistance")),
            "{:?}",
            s.warnings
        );
        let mut parts = vec![
            part("mcu", BOARD_KIND, &[]),
            part("r1", "resistor", &[("ohms", "4k7")]),
        ];
        s.set_circuit(
            &Circuit {
                parts: parts.clone(),
                wires: wires.clone(),
            },
            0,
        );
        assert!(s.warnings.is_empty(), "{:?}", s.warnings);
        parts[1] = part("r1", "resistor", &[("ohms", "")]);
        s.set_circuit(&Circuit { parts, wires }, 0);
        assert_eq!(s.warnings.len(), 1);
    }

    fn part_num(id: &str, kind: &str, props: &[(&str, f64)]) -> PartInstance {
        PartInstance {
            id: id.into(),
            kind: kind.into(),
            props: props
                .iter()
                .map(|(k, v)| (k.to_string(), serde_json::json!(v)))
                .collect(),
        }
    }

    fn settle(s: &mut CircuitSim) {
        let d = drives(s, |_| Drive::Float);
        s.update(0, &d);
    }

    #[test]
    fn potentiometer_divides_the_supply() {
        // 3V3 — pot — GND, wiper on A0 (PA0).
        let mut s = sim(
            vec![part_num("pot", "potentiometer", &[("position", 0.25)])],
            vec![
                wire(("mcu", "3V3"), ("pot", "2")),
                wire(("pot", "1"), ("mcu", "GND")),
                wire(("pot", "W"), ("mcu", "PA0")),
            ],
        );
        settle(&mut s);
        let v = s.mcu_voltage(0, 0).unwrap();
        assert!((v - 0.25 * VDD).abs() < 0.01, "{v}");
    }

    #[test]
    fn ldr_divider_follows_light() {
        // 3V3 — 10k — A1 — LDR — GND
        let make = |lux: f64| {
            let mut s = sim(
                vec![
                    part("r", "resistor", &[("ohms", "10k")]),
                    part_num("ldr", "ldr", &[("lux", lux)]),
                ],
                vec![
                    wire(("mcu", "3V3"), ("r", "1")),
                    wire(("r", "2"), ("mcu", "PA1")),
                    wire(("ldr", "1"), ("mcu", "PA1")),
                    wire(("ldr", "2"), ("mcu", "GND")),
                ],
            );
            settle(&mut s);
            s.mcu_voltage(0, 1).unwrap()
        };
        let (dark, bright) = (make(1.0), make(1000.0));
        // 1 lux ≈ 50 kΩ, 1000 lux ≈ 400 Ω against 10 kΩ.
        assert!(dark > 2.6 && bright < 0.2, "dark {dark}, bright {bright}");
    }

    #[test]
    fn temperature_sensor_needs_its_supply() {
        let make = |supply: &str, model: &str| {
            let mut p = part_num("t", "temp-sensor", &[("temp", 30.0)]);
            p.props.insert("model".into(), model.into());
            let mut s = sim(
                vec![p],
                vec![
                    wire(("mcu", supply), ("t", "VS")),
                    wire(("t", "GND"), ("mcu", "GND")),
                    wire(("t", "OUT"), ("mcu", "PA4")),
                ],
            );
            settle(&mut s);
            (s.mcu_voltage(0, 4).unwrap(), s.warnings.clone())
        };
        let (v, w) = make("3V3", "TMP36");
        assert!((v - 0.8).abs() < 0.01 && w.is_empty(), "{v} {w:?}");
        let (v, _) = make("5V", "LM35");
        assert!((v - 0.3).abs() < 0.01, "{v}");
        let (v, w) = make("3V3", "LM35");
        assert!(v < 0.01, "LM35 needs 4 V: {v}");
        assert!(w.iter().any(|w| w.starts_with("t: supply 3.3 V")), "{w:?}");
    }

    #[test]
    fn servo_follows_pulse_width_and_motor_follows_duty() {
        let mut s = sim(
            vec![part("sv", "servo", &[]), part("m", "dc-motor", &[])],
            vec![
                wire(("mcu", "5V"), ("sv", "V+")),
                wire(("sv", "GND"), ("mcu", "GND")),
                wire(("mcu", "PC7"), ("sv", "SIG")),
                wire(("mcu", "5V"), ("m", "VCC")),
                wire(("m", "GND"), ("mcu", "GND")),
                wire(("mcu", "PB4"), ("m", "IA")),
                wire(("mcu", "PB5"), ("m", "IB")),
            ],
        );
        let pins = s.mcu_pins();
        let at = |sig: bool, ia: bool| {
            pins.iter()
                .map(|&p| match p {
                    (2, 7) => {
                        if sig {
                            Drive::High
                        } else {
                            Drive::Low
                        }
                    }
                    (1, 4) => {
                        if ia {
                            Drive::High
                        } else {
                            Drive::Low
                        }
                    }
                    (1, 5) => Drive::Low,
                    _ => Drive::Float,
                })
                .collect::<Vec<_>>()
        };
        // 1 kHz cycles per "second" = 1000 cycles: 20 ms frames, pulses
        // of 2.0 ms (→ 135°) every 20 ms; IA at 50 % duty.
        let cps = 1000.0; // cycles per second in this test
        let mut t = 0u64;
        s.end_frame(0, 0.0);
        let mut angle = 0.0;
        for frame in 0..50 {
            for k in 0..20u64 {
                let base = t + k;
                s.update(base, &at(k < 2, k % 2 == 0));
            }
            t += 20;
            let v = s.end_frame(t, 20.0 / cps);
            let sv = visual(&v, "sv");
            angle = sv.angle.unwrap();
            assert!(!sv.unpowered);
            if frame == 49 {
                let m = visual(&v, "m");
                let rpm = m.rpm.unwrap();
                assert!((rpm - 0.5 * MOTOR_MAX_RPM).abs() < 5.0, "{rpm}");
            }
        }
        assert!((angle - 135.0).abs() < 1.0, "{angle}");
    }

    #[test]
    fn ohms_parse() {
        assert_eq!(parse_ohms(&"4.7k".into()), Some(4700.0));
        assert_eq!(parse_ohms(&"1M".into()), Some(1e6));
        assert_eq!(parse_ohms(&"4k7".into()), Some(4700.0));
        assert_eq!(parse_ohms(&"2M2".into()), Some(2.2e6));
        assert_eq!(parse_ohms(&"4R7".into()), Some(4.7));
        assert_eq!(parse_ohms(&"10 kΩ".into()), Some(10_000.0));
        assert_eq!(parse_ohms(&"330ohm".into()), Some(330.0));
        assert_eq!(parse_ohms(&"abc".into()), None);
        assert_eq!(parse_ohms(&"0".into()), None);
        assert_eq!(parse_ohms(&serde_json::json!(330)), Some(330.0));
        assert_eq!(parse_mcu_pin("PC13"), Some((2, 13)));
        assert_eq!(parse_mcu_pin("PB16"), None);
    }
}
