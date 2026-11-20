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
//!
//! Motor windings (M28) are elements too: a resistance in series with the
//! back-EMF (or, behind a chopper driver, a current source), and the motor
//! drivers' outputs are switches to their supply and ground, whose states
//! are part of the cache key like the MCU's pins. The back-EMFs vary
//! continuously, so a cached solution holds the operating point with them
//! at zero and the sensitivity of every node to each of them (the circuit
//! is linear for a given key): the voltage now is `v0 + S·x`, and each
//! winding's current is `a + B·emf`, which the motors integrate with.
//! Visual quantities are integrated over time (in core cycles) between
//! display frames, so a 25 % PWM duty shows as a dimmer LED.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::rc::Rc;

use crate::devices::{
    ds18b20_rom, Aht20, CharLcd, Device, Dht, Ds18b20, Ds3231, Encoder, Hc05, IrRemote, Max7219,
    Mpu6050, NeoPixel, Relay, SdCard, Sonar, Ssd1306,
};

use crate::tier8::{Bmp280, Hc595, Pir, Tm1637, PIR_VMIN};
use crate::tier9::{
    l298n_bridge, BipolarStepper, CoilDrive, Esc, EscState, HallBldc, PhaseBridge, PhaseDrive,
    StepDriver, BLDC_R, STEPPER_COIL_R, STEPPER_RATED,
};

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
/// Resistance of a closed relay contact (with its leads).
const R_CONTACT: f64 = 0.1;
/// LED dynamic resistance once conducting.
const R_LED: f64 = 15.0;
/// No-load speed of the DC motor at full drive (small 3–6 V hobby motor
/// with gearbox).
const MOTOR_MAX_RPM: f64 = 200.0;
/// Absolute maximum current of an I/O pin (datasheet: ±25 mA).
const PIN_MAX: f64 = 0.025;
/// Most voltage changes logged for analog probes between two drains.
const VOLTAGE_LOG_MAX: usize = 1 << 18;
/// On-resistance of a driver output switch (Ω): an L298N's Darlington
/// (about 1 V at 0.4 A), an A4988's DMOS, a 3-phase bridge's MOSFET.
const L298N_R_ON: f64 = 2.5;
const A4988_R_ON: f64 = 0.4;
const BRIDGE_R_ON: f64 = 0.02;
/// How often a probed net that a turning motor's back-EMF moves is
/// sampled when nothing else changes (s).
const EMF_PROBE_INTERVAL: f64 = 20e-6;
/// Most bridge outputs chopped at once whose PWM is averaged exactly for
/// the motors (2^n solutions); more are rounded to on or off.
const MAX_DUTY_LEGS: usize = 3;

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
    /// A relay contact between `a` and `b`, closed while relay `relay`
    /// (an index into the relay states after the device outputs in the
    /// drive key) is in state `when` (true = energised, COM–NO).
    Contact {
        a: usize,
        b: usize,
        relay: usize,
        when: bool,
    },
    /// A floating voltage source `v` from `n` to `p` (battery, adapter),
    /// with internal resistance `r`.
    Battery {
        p: usize,
        n: usize,
        v: f64,
        r: f64,
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
    /// One output of a motor driver (M28): a switch with resistance `r`
    /// from `out` to `hi` (its supply) or to `lo` (its ground), as key
    /// entry `slot` of the legs says (High, Low, Float = both off).
    Leg {
        out: usize,
        hi: usize,
        lo: usize,
        r: f64,
        slot: usize,
    },
    /// A motor winding from `a` to `b` (M28): resistance `r` in series with
    /// the back-EMF `x[input]` (current from `a` to `b` is
    /// `(v_a − v_b − x)/r`), or — when the key puts it in current mode —
    /// a current source of `x[input]` amperes from `a` to `b`.
    Winding {
        a: usize,
        b: usize,
        r: f64,
        input: usize,
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
    /// Display contents: 64 rows × 128 pixels, MSB first, base64.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub screen: Option<String>,
    /// A reading to show on the part (RTC time).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// NeoPixel colours, 0xRRGGBB per LED.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub leds: Vec<u32>,
    /// SD card: moves whenever the contents change (to save them).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<u32>,
    /// Character LCD contents.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lcd: Option<LcdView>,
    /// LED dot-matrix contents (MAX7219 chain).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matrix: Option<MatrixView>,
    /// Relay: COM is on NO (else on NC).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed: Option<bool>,
    /// 74HC595: its shift and storage registers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub register: Option<ShiftView>,
    /// TM1637: the digits it shows.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digits: Option<DigitsView>,
    /// Motors and their drivers (M21).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub motor: Option<MotorView>,
}

/// What a motor or a motor driver shows (M21).
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct MotorView {
    /// Stepper: rotor position in full steps from the drivers' home
    /// position; driver: STEP edges taken.
    pub steps: f64,
    /// Stepper: full steps lost so far.
    pub lost: u64,
    /// Coil currents (stepper: A, B; driver: its two outputs), units of
    /// the rated current, signed.
    pub coils: Vec<f64>,
    /// Lost steps or a jittering rotor just now.
    pub stalled: bool,
    /// Driver: "on", "disabled" (EN high), "sleep", "reset", "no-vmot",
    /// "no-vdd"; ESC: its state ("arming", "armed", …).
    pub state: String,
    /// Driver: microstep resolution (1/n steps).
    pub micro: u32,
    /// ESC: throttle 0–1 and the beeps so far.
    pub throttle: f64,
    pub beeps: u32,
    /// 3-phase bridge (M23): on fraction of each switch over the frame,
    /// INH A–C then INL A–C, and a shoot-through in the frame.
    pub duty: Vec<f64>,
    pub shoot_through: bool,
}

/// What a 74HC595 holds.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct ShiftView {
    /// Shift register, bit n = stage n.
    pub shift: u8,
    /// Storage register (Q0 = bit 0), driven while `enabled`.
    pub latch: u8,
    /// OE is low: Q0–Q7 drive their levels (else high impedance).
    pub enabled: bool,
}

/// What a TM1637 4-digit display shows.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct DigitsView {
    /// Segment byte per digit, left first (bit 0 = a … bit 6 = g, bit 7
    /// = the colon on digit 1).
    pub segments: Vec<u8>,
    /// Pulse width setting 0–7.
    pub brightness: u8,
    pub on: bool,
}

/// What a chain of MAX7219 8×8 matrices shows.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct MatrixView {
    /// 8 rows per module (top first, bit 7 = left column), the module
    /// nearest DIN first.
    pub rows: Vec<u8>,
    /// Intensity setting 0–15 per module.
    pub intensity: Vec<u8>,
}

/// What a character LCD shows.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
pub struct LcdView {
    /// Character codes per row (0–7 are the custom characters).
    pub rows: Vec<Vec<u8>>,
    /// The 8 custom characters, 8 rows of 5 pixels each.
    pub cgram: Vec<u8>,
    pub backlight: bool,
    /// Cursor (row, column), shown as an underline/blinking block.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<(u8, u8)>,
    pub blink: bool,
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
    /// Channels 0–3 = IN1–IN4 (coil driven), 4 = supply present.
    Stepper,
    /// M21 motors and drivers: their state lives in the motor maps.
    Motion,
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
    /// Stepper: coil pattern, electrical phase (half steps), last step (s).
    pattern: u8,
    phase: i32,
    last_step: f64,
    /// Before the last change (a change within 50 µs replaces it: pins
    /// written one after the other are one step).
    prev_phase: i32,
    prev_angle: f64,
    prev_step: f64,
    last_change: f64,
    /// The last change came too fast to follow (reported once it stands).
    stalled: bool,
}

/// The DC operating point for one combination of pin drives.
#[derive(Debug, Clone)]
struct Solution {
    /// Node voltages with every winding's input (back-EMF, current) at 0.
    v: Vec<f64>,
    /// Per winding input j: dv/dx_j of every node (M28).
    sens: Vec<Vec<f64>>,
    /// Nodes some winding input moves.
    sens_node: Vec<bool>,
    /// Winding currents `a + B·x` (A): `a` per winding, `B` row-major.
    /// Rows of current-mode windings are left at zero.
    coef_a: Vec<f64>,
    coef_b: Vec<f64>,
    /// Brightness per (visual, channel); buzzer "on" as 0/1.
    level: Vec<Vec<f64>>,
    over: Vec<bool>,
    /// Level seen by each watched MCU pin; `None` = floating.
    inputs: Vec<Option<bool>>,
    /// Nodes connected to some source (else floating).
    driven: Vec<bool>,
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
    /// Pins whose net voltage is logged whenever the operating point
    /// changes (analog probes), the values last logged and the log.
    voltage_probes: Vec<String>,
    voltage_last: Vec<Option<f64>>,
    voltage_log: Vec<(Cycles, Vec<Option<f64>>)>,
    /// Bus device parts and where their pins are.
    bus_parts: Vec<BusPart>,
    /// Their state (display RAM, clock, …), by part id.
    devices: HashMap<String, Device>,
    spi_parts: Vec<SpiPart>,
    /// Single-wire parts (DHT, NeoPixel) and their data line.
    wire_parts: Vec<WirePart>,
    /// LED matrix drivers, whose CLK and CS edges are watched.
    matrix_parts: Vec<MatrixPart>,
    /// Lines devices pull low on their own: (part id, node).
    dev_outputs: Vec<(String, usize, usize)>,
    /// UART modules (HC-05) and where their pins are.
    uart_parts: Vec<UartPart>,
    /// Relay modules; their contact states follow the device outputs in
    /// the drive key.
    relay_parts: Vec<RelayPart>,
    /// 74HC595 shift registers, TM1637 displays and PIR sensors.
    shift_parts: Vec<ShiftPart>,
    tm_parts: Vec<TmPart>,
    pir_parts: Vec<PirPart>,
    /// NeoPixel parts: (id, DIN, DOUT), for chains.
    pixel_parts: Vec<(String, usize, usize)>,
    /// M21: bipolar steppers, step drivers, L298N modules and ESCs, with
    /// their state by part id.
    stepper_parts: Vec<StepperPart>,
    driver_parts: Vec<DriverPart>,
    bridge_parts: Vec<BridgePart>,
    esc_parts: Vec<EscPart>,
    bldc_parts: Vec<BldcPart>,
    phase_bridges: Vec<PhaseBridgePart>,
    /// What each 3-phase bridge does with its outputs, and its supply.
    phase_out: HashMap<String, ([PhaseDrive; 3], f64)>,
    /// M23: what each 3-phase bridge saw on its inputs (PWM duties,
    /// overlaps).
    phase_state: HashMap<String, PhaseBridge>,
    /// M28: the windings (inputs of the solve), the driver output switches
    /// as they are now (key entries after the relays), which windings a
    /// chopper drives as a current source, the inputs' values now, the MCU
    /// input levels with them, and when they were last brought up to date.
    windings: Vec<WindingInfo>,
    legs: Vec<Drive>,
    winding_cs: Vec<bool>,
    x: Vec<f64>,
    inputs_now: Vec<Option<bool>>,
    inputs_changed: bool,
    x_time: Cycles,
    /// Scratch drive key for the motors' averaged solutions, and the key
    /// and chopped outputs the motors were last given.
    mech: Vec<Drive>,
    mech_last: Vec<Drive>,
    duties_last: Vec<(usize, f64)>,
    /// The winding current coefficients last computed from those.
    net_last: (Vec<f64>, Vec<f64>),
    /// A probed net moves with a turning motor: sample it periodically.
    emf_probe_live: bool,
    steppers: HashMap<String, BipolarStepper>,
    drivers: HashMap<String, DriverState>,
    bridges: HashMap<String, BridgeState>,
    escs: HashMap<String, (Esc, Option<bool>)>,
    /// Re-solves in progress (device outputs that changed on what they saw).
    depth: u32,
    /// Last level each single-wire part saw on its line.
    line_levels: HashMap<String, bool>,
    /// The device addressed on each I2C bus (by SCL pin).
    i2c_active: HashMap<(u8, u8), String>,
    /// Time base: (cycle, seconds at that cycle, Hz).
    clock: (Cycles, f64, f64),
    /// Unix time a newly placed clock chip starts from.
    wall_clock: f64,
}

/// A part with a single data line.
#[derive(Debug, Clone)]
struct WirePart {
    id: String,
    vcc: usize,
    gnd: usize,
    data: usize,
    vmin: f64,
}

/// A UART module (HC-05): its supply, serial lines and mode pin.
#[derive(Debug, Clone)]
struct UartPart {
    id: String,
    vcc: usize,
    gnd: usize,
    rxd: usize,
    txd: usize,
    en: usize,
}

/// A relay module: supply and the input that drives its coil.
#[derive(Debug, Clone)]
struct RelayPart {
    id: String,
    vcc: usize,
    gnd: usize,
    inp: usize,
    active_low: bool,
}

/// Where a UART module's lines go: the MCU pins on the nets of its RXD
/// (the MCU's TX belongs here) and TXD (the MCU's RX).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UartLink {
    pub id: String,
    pub rxd: Vec<(u8, u8)>,
    pub txd: Vec<(u8, u8)>,
}

/// A 74HC595: supply, inputs and the serial output Q7'.
#[derive(Debug, Clone)]
struct ShiftPart {
    id: String,
    vcc: usize,
    gnd: usize,
    ds: usize,
    shcp: usize,
    stcp: usize,
    oe: usize,
    mr: usize,
    q7s: usize,
}

/// A TM1637 display module (10 kΩ pull-ups on CLK and DIO).
#[derive(Debug, Clone)]
struct TmPart {
    id: String,
    vcc: usize,
    gnd: usize,
    clk: usize,
    dio: usize,
}

/// A PIR motion sensor's supply.
#[derive(Debug, Clone)]
struct PirPart {
    id: String,
    vcc: usize,
    gnd: usize,
}

/// Where the current in a stepper coil comes from: output pair `bridge`
/// (0 or 1) of driver part `driver`, `sign` = +1 when the coil's + end is
/// on the bridge's first output.
#[derive(Debug, Clone, PartialEq)]
struct CoilLink {
    driver: String,
    bridge: usize,
    sign: f64,
}

/// A bipolar stepper: its coils (+ end, − end) and what drives them,
/// and its windings' inputs in the solve.
#[derive(Debug, Clone)]
struct StepperPart {
    id: String,
    coils: [(usize, usize); 2],
    links: [Option<CoilLink>; 2],
    inputs: [usize; 2],
}

/// A motor winding in the solve (M28): its ends and resistance.
#[derive(Debug, Clone, Copy)]
struct WindingInfo {
    a: usize,
    b: usize,
    r: f64,
}

/// An A4988 / DRV8825 carrier board.
#[derive(Debug, Clone)]
struct DriverPart {
    id: String,
    step: usize,
    dir: usize,
    en: usize,
    ms: [usize; 3],
    rst: usize,
    slp: usize,
    vmot: usize,
    vdd: usize,
    gnd: usize,
    /// 1A/1B and 2A/2B.
    out: [(usize, usize); 2],
    /// Current limit (Vref pot) as a share of the motor's rated current.
    current: f64,
    /// First of its four output switches (1A, 1B, 2A, 2B) in the legs.
    legs: usize,
}

/// What a step driver is doing.
#[derive(Debug, Clone)]
struct DriverState {
    drv: StepDriver,
    /// Its outputs: target current and drive, per bridge.
    out: [(f64, CoilDrive); 2],
    state: &'static str,
    vmot: f64,
}

/// An L298N dual H-bridge module.
#[derive(Debug, Clone)]
struct BridgePart {
    id: String,
    inp: [usize; 4],
    en: [usize; 2],
    vs: usize,
    gnd: usize,
    v5: usize,
    out: [(usize, usize); 2],
    /// ENA/ENB jumpers on: the bridges are always enabled.
    jumpers: bool,
    /// First of its four output switches (OUT1–OUT4) in the legs.
    legs: usize,
}

/// An L298N's outputs now and averaged over the display frame.
#[derive(Debug, Clone, Default)]
struct BridgeState {
    out: [(f64, CoilDrive); 2],
    acc: [f64; 2],
    since: f64,
    frame_start: f64,
    powered: bool,
}

/// An ESC with its motor: signal, signal ground, battery.
#[derive(Debug, Clone)]
struct EscPart {
    id: String,
    sig: usize,
    gnd: usize,
    bat: usize,
}

/// A BLDC with hall sensors: phases U, V, W (and the bridge output each
/// sits on: part id, output), the halls' supply and outputs.
#[derive(Debug, Clone)]
struct BldcPart {
    id: String,
    phases: [usize; 3],
    links: [Option<(String, usize)>; 3],
    vcc: usize,
    gnd: usize,
    halls: [usize; 3],
    /// Its windings' inputs in the solve (U, V, W to the star point).
    inputs: [usize; 3],
    /// No hall sensors (M28, part `bldc`).
    sensorless: bool,
}

/// A 3-phase bridge module (DRV8302 class): INH/INL per phase.
#[derive(Debug, Clone)]
struct PhaseBridgePart {
    id: String,
    inh: [usize; 3],
    inl: [usize; 3],
    pvdd: usize,
    gnd: usize,
    out: [usize; 3],
    /// First of its three output switches (OUTA–OUTC) in the legs.
    legs: usize,
}

/// Lowest supply of the hall sensors and of the 3-phase bridge.
const HALL_VMIN: f64 = 3.0;
const PHASE_BRIDGE_VMIN: f64 = 6.0;

/// Lowest motor supply of an A4988 (8–35 V) and logic supply (3–5.5 V).
const VMOT_MIN: f64 = 8.0;
const DRIVER_VDD_MIN: f64 = 3.0;

/// Lowest supply of a 74HC595 (2–6 V) and of a TM1637 module.
const HC595_VMIN: f64 = 2.0;
const TM1637_VMIN: f64 = 3.0;

/// Lowest supply of an HC-05 board (3.6–6 V).
const HC05_VMIN: f64 = 3.5;
/// A 5 V relay coil pulls in at 75 % of its rated voltage.
const RELAY_PULL_IN: f64 = 3.75;

/// A MAX7219 chain: its serial lines as nets (bit-banged or SPI).
#[derive(Debug, Clone)]
struct MatrixPart {
    id: String,
    vcc: usize,
    gnd: usize,
    din: usize,
    clk: usize,
    cs: usize,
    /// Driven by the chip: the bit leaving its shift register.
    dout: usize,
    vmin: f64,
}

/// A part on an SPI bus.
#[derive(Debug, Clone)]
struct SpiPart {
    id: String,
    vcc: usize,
    gnd: usize,
    sck: usize,
    mosi: usize,
    miso: Option<usize>,
    cs: usize,
    /// Display data/command select and reset (SSD1306).
    dc: Option<usize>,
    res: Option<usize>,
    vmin: f64,
}

/// A part on an I2C bus.
#[derive(Debug, Clone)]
struct BusPart {
    id: String,
    vcc: usize,
    gnd: usize,
    scl: usize,
    sda: usize,
}

/// Key labels of the 4×4 keypad by row and column.
pub const KEYPAD: [[&str; 4]; 4] = [
    ["1", "2", "3", "A"],
    ["4", "5", "6", "B"],
    ["7", "8", "9", "C"],
    ["*", "0", "#", "D"],
];

/// Segment pins of a 7-segment display, in channel order.
const SEGMENTS: [&str; 8] = ["a", "b", "c", "d", "e", "f", "g", "dp"];

/// High level on the I2C lines (0.7 · VDD).
const I2C_HIGH: f64 = 0.7 * VDD;
/// Lowest supply a bus module works from.
const MODULE_VMIN: f64 = 2.0;
/// 2026-01-01 00:00:00 UTC, until the UI gives the real time.
const DEFAULT_WALL_CLOCK: f64 = 1_767_225_600.0;

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
            voltage_probes: Vec::new(),
            voltage_last: Vec::new(),
            voltage_log: Vec::new(),
            bus_parts: Vec::new(),
            spi_parts: Vec::new(),
            wire_parts: Vec::new(),
            matrix_parts: Vec::new(),
            dev_outputs: Vec::new(),
            uart_parts: Vec::new(),
            relay_parts: Vec::new(),
            shift_parts: Vec::new(),
            tm_parts: Vec::new(),
            pir_parts: Vec::new(),
            pixel_parts: Vec::new(),
            stepper_parts: Vec::new(),
            driver_parts: Vec::new(),
            bridge_parts: Vec::new(),
            esc_parts: Vec::new(),
            bldc_parts: Vec::new(),
            phase_bridges: Vec::new(),
            phase_out: HashMap::new(),
            windings: Vec::new(),
            legs: Vec::new(),
            winding_cs: Vec::new(),
            x: Vec::new(),
            inputs_now: Vec::new(),
            inputs_changed: false,
            x_time: time,
            mech: Vec::new(),
            mech_last: Vec::new(),
            duties_last: Vec::new(),
            net_last: (Vec::new(), Vec::new()),
            emf_probe_live: false,
            phase_state: HashMap::new(),
            steppers: HashMap::new(),
            drivers: HashMap::new(),
            bridges: HashMap::new(),
            escs: HashMap::new(),
            depth: 0,
            line_levels: HashMap::new(),
            devices: HashMap::new(),
            i2c_active: HashMap::new(),
            clock: (time, 0.0, 16e6),
            wall_clock: DEFAULT_WALL_CLOCK,
        };
        sim.rebuild();
        sim
    }

    /// Restart the time base (the machine was powered up again at `time`).
    pub fn reset_time(&mut self, time: Cycles) {
        // Clock chips run on their backup battery across the power cycle;
        // simulated time starts again from 0 s.
        let elapsed = self.seconds_at(self.last_time);
        for d in self.devices.values_mut() {
            match d {
                Device::Rtc(r) => r.epoch_at_zero += elapsed,
                Device::Oled(o) => **o = Ssd1306::new(o.address),
                Device::Aht(a) => *a = Aht20::new(a.temp, a.humidity),
                Device::Sd(sd) => sd.power_cycle(),
                Device::Dht(d) => *d = Dht::new(d.dht22, d.temp, d.humidity),
                Device::Pixels(n) => *n = NeoPixel::new(n.leds.len()),
                Device::Encoder(e) => e.rebase(elapsed),
                Device::Lcd(l) => **l = CharLcd::new(l.address),
                Device::Sonar(x) => *x = Sonar::new(x.distance_cm),
                Device::Thermo(x) => {
                    let rom = x.rom;
                    *x = Ds18b20::new(x.temp, 0);
                    x.rom = rom;
                }
                Device::Imu(m) => {
                    let mut fresh = Mpu6050::new(m.address);
                    (fresh.roll, fresh.pitch) = (m.roll, m.pitch);
                    (fresh.gyro, fresh.temp) = (m.gyro, m.temp);
                    **m = fresh;
                }
                Device::Matrix(m) => *m = Max7219::new(m.count),
                Device::Ir(r) => *r = IrRemote::default(),
                // Powered up again: EN is looked at afresh.
                Device::Bluetooth(b) => {
                    b.powered = false;
                    b.to_phone.clear();
                    b.to_mcu.clear();
                }
                Device::Relay(r) => *r = Relay::default(),
                Device::Shift(x) => *x = Hc595::default(),
                Device::Tm(x) => **x = Tm1637::new(),
                Device::Pir(x) => *x = Pir::new(x.retrigger, x.delay, x.warmup),
                Device::Baro(x) => **x = Bmp280::new(x.address, x.temp, x.pressure),
                // The shaft stays where it is; the clock starts again.
                Device::Bldc(x) => x.rebase(0.0),
            }
        }
        self.i2c_active.clear();
        // Simulated time starts again from 0 s: the motors keep where their
        // shafts are; the drivers start from home, the ESCs from scratch.
        for m in self.steppers.values_mut() {
            m.rebase(0.0);
        }
        for d in self.drivers.values_mut() {
            d.drv = StepDriver::new(d.drv.drv8825);
        }
        for b in self.bridges.values_mut() {
            *b = BridgeState::default();
        }
        for b in self.phase_state.values_mut() {
            *b = PhaseBridge::new(0.0);
        }
        for (e, last) in self.escs.values_mut() {
            e.rebase(0.0);
            *last = None;
        }
        self.clock = (time, 0.0, self.clock.2);
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
            .retain(|p| p == "B1" || ids.contains(p.split(':').next().unwrap_or(p)));
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
            // A remote button ("ir:OK") sends its code to the receiver.
            if let Some((id, key)) = part.split_once(':') {
                self.remote_button(id, key, pressed, time);
            }
            self.integrate(time);
            self.rebuild();
        }
        changed
    }

    /// Press or release button `key` of the remote that belongs to IR
    /// receiver `id`; a powered receiver puts the NEC frames on its output.
    fn remote_button(&mut self, id: &str, key: &str, pressed: bool, time: Cycles) {
        let now = self.seconds_at(time);
        let powered = self
            .wire_parts
            .iter()
            .any(|w| w.id == id && self.node_voltage(w.vcc) - self.node_voltage(w.gnd) >= w.vmin);
        let Some(Device::Ir(r)) = self.devices.get_mut(id) else {
            return;
        };
        match (pressed, IrRemote::command(key)) {
            (true, Some(cmd)) if powered => {
                r.advance(now);
                r.press(now, cmd);
            }
            (false, _) => r.release(),
            _ => {}
        }
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
            // Rotary encoder push button: SW to GND.
            if p.kind == "rotary-encoder" && self.pressed.contains(&p.id) {
                wires.push(Wire {
                    a: PinRef::new(&p.id, "SW"),
                    b: PinRef::new(&p.id, "GND"),
                });
            }
            // Joystick: the stick pressed down closes SW to GND.
            if p.kind == "joystick" && p.props.get("sw").is_some_and(truthy) {
                wires.push(Wire {
                    a: PinRef::new(&p.id, "SW"),
                    b: PinRef::new(&p.id, "GND"),
                });
            }
            // Keypad: a pressed key joins its row and column ("kp:5").
            if p.kind == "keypad-4x4" {
                for (r, row) in KEYPAD.iter().enumerate() {
                    for (c, key) in row.iter().enumerate() {
                        if self.pressed.contains(&format!("{}:{key}", p.id)) {
                            wires.push(Wire {
                                a: PinRef::new(&p.id, format!("R{}", r + 1)),
                                b: PinRef::new(&p.id, format!("C{}", c + 1)),
                            });
                        }
                    }
                }
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
        let mut bus_parts = Vec::new();
        let mut spi_parts = Vec::new();
        let mut wire_parts = Vec::new();
        let mut matrix_parts = Vec::new();
        let mut dev_outputs = Vec::new();
        let mut uart_parts = Vec::new();
        let mut relay_parts = Vec::new();
        let mut shift_parts = Vec::new();
        let mut tm_parts = Vec::new();
        let mut pir_parts = Vec::new();
        let mut pixel_parts = Vec::new();
        let mut stepper_parts: Vec<StepperPart> = Vec::new();
        let mut driver_parts: Vec<DriverPart> = Vec::new();
        let mut bridge_parts: Vec<BridgePart> = Vec::new();
        let mut esc_parts: Vec<EscPart> = Vec::new();
        let mut bldc_parts: Vec<BldcPart> = Vec::new();
        let mut phase_bridges: Vec<PhaseBridgePart> = Vec::new();
        // M28: windings and driver output switches, numbered as they come.
        let mut windings: Vec<WindingInfo> = Vec::new();
        let mut n_legs = 0usize;
        let now_s = self.seconds_at(self.last_time);
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
                angle: if kind == VisualKind::Stepper {
                    0.0
                } else {
                    90.0
                },
                target: 90.0,
                rpm: 0.0,
                pattern: 0,
                phase: 0,
                last_step: f64::NEG_INFINITY,
                prev_phase: 0,
                prev_angle: 0.0,
                prev_step: f64::NEG_INFINITY,
                last_change: f64::NEG_INFINITY,
                stalled: false,
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
                "seven-segment" | "seven-segment-4" => {
                    // Segment LEDs between the segment pins and the digit
                    // commons (cathodes or anodes).
                    let anode = prop_str(p, "common", "cathode") == "anode";
                    let vf = led_vf(&prop_str(p, "color", "red"));
                    let digits = if p.kind == "seven-segment-4" { 4 } else { 1 };
                    let vis = add_visual(&p.id, VisualKind::Led, 8 * digits);
                    for d in 0..digits {
                        let com_pin = if digits == 1 {
                            "COM".to_string()
                        } else {
                            format!("D{}", d + 1)
                        };
                        let com = node(PinRef::new(&p.id, com_pin.as_str()), &mut map);
                        for (s, seg) in SEGMENTS.iter().enumerate() {
                            let n = node(PinRef::new(&p.id, *seg), &mut map);
                            let (a, k) = if anode { (com, n) } else { (n, com) };
                            elements.push(Element::Led {
                                a,
                                k,
                                vf,
                                imax: 0.02,
                                visual: vis,
                                channel: d * 8 + s,
                            });
                        }
                    }
                }
                "stepper-28byj48" => {
                    // 28BYJ-48 (5 V) on a ULN2003 driver board: an IN pin
                    // high energises its coil.
                    let vis = add_visual(&p.id, VisualKind::Stepper, 5);
                    let pin = |n: &str| PinRef::new(&p.id, n);
                    let gnd = node(pin("GND"), &mut map);
                    for i in 0..4 {
                        elements.push(Element::Sense {
                            a: node(pin(&format!("IN{}", i + 1)), &mut map),
                            b: gnd,
                            threshold: 1.6,
                            visual: vis,
                            channel: i,
                        });
                    }
                    elements.push(Element::Sense {
                        a: node(pin("VCC"), &mut map),
                        b: gnd,
                        threshold: 4.0,
                        visual: vis,
                        channel: 4,
                    });
                }
                "thermistor" => {
                    // NTC: R = R25 · exp(B (1/T − 1/298.15 K)).
                    let r25 = prop(p, "ohms")
                        .as_ref()
                        .and_then(parse_ohms)
                        .unwrap_or(10_000.0);
                    let beta = prop_f64(p, "beta", 3950.0);
                    let t = prop_f64(p, "temp", 25.0) + 273.15;
                    let r = (r25 * (beta * (1.0 / t - 1.0 / 298.15)).exp()).clamp(10.0, 1e8);
                    elements.push(Element::Resistor {
                        a: node(PinRef::new(&p.id, "1"), &mut map),
                        b: node(PinRef::new(&p.id, "2"), &mut map),
                        r,
                    });
                }
                "keypad-4x4" => {
                    // Rows and columns exist as nets even with nothing pressed.
                    for i in 1..=4 {
                        node(PinRef::new(&p.id, format!("R{i}")), &mut map);
                        node(PinRef::new(&p.id, format!("C{i}")), &mut map);
                    }
                }
                "rotary-encoder" => {
                    // KY-040: 10 kΩ pull-ups from + to CLK, DT and SW; the
                    // contacts close CLK and DT to GND.
                    let vis = add_visual(&p.id, VisualKind::Sensor, 1);
                    let pin = |n: &str| PinRef::new(&p.id, n);
                    let (vcc, gnd) = (node(pin("+"), &mut map), node(pin("GND"), &mut map));
                    elements.push(Element::Sense {
                        a: vcc,
                        b: gnd,
                        threshold: 2.0,
                        visual: vis,
                        channel: 0,
                    });
                    for (i, name) in ["CLK", "DT", "SW"].into_iter().enumerate() {
                        let n = node(pin(name), &mut map);
                        elements.push(Element::Resistor {
                            a: vcc,
                            b: n,
                            r: 10_000.0,
                        });
                        if i < 2 {
                            dev_outputs.push((p.id.clone(), n, i));
                        }
                    }
                    if !matches!(self.devices.get(&p.id), Some(Device::Encoder(_))) {
                        self.devices
                            .insert(p.id.clone(), Device::Encoder(Encoder::default()));
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
                "dht" => {
                    // 3-pin module: sensor plus a 10 kΩ pull-up on DATA.
                    let vis = add_visual(&p.id, VisualKind::Sensor, 1);
                    let pin = |n: &str| PinRef::new(&p.id, n);
                    let (vcc, gnd) = (node(pin("VCC"), &mut map), node(pin("GND"), &mut map));
                    let data = node(pin("DATA"), &mut map);
                    elements.push(Element::Sense {
                        a: vcc,
                        b: gnd,
                        threshold: 3.0,
                        visual: vis,
                        channel: 0,
                    });
                    elements.push(Element::Resistor {
                        a: vcc,
                        b: data,
                        r: 10_000.0,
                    });
                    wire_parts.push(WirePart {
                        id: p.id.clone(),
                        vcc,
                        gnd,
                        data,
                        vmin: 3.0,
                    });
                    dev_outputs.push((p.id.clone(), data, 0));
                    let dht22 = prop_str(p, "model", "DHT22") != "DHT11";
                    let (t, h) = (prop_f64(p, "temp", 25.0), prop_f64(p, "humidity", 50.0));
                    match self.devices.get_mut(&p.id) {
                        Some(Device::Dht(d)) if d.dht22 == dht22 => {
                            d.temp = t;
                            d.humidity = h;
                        }
                        _ => {
                            self.devices
                                .insert(p.id.clone(), Device::Dht(Dht::new(dht22, t, h)));
                        }
                    }
                }
                "hc-sr04" => {
                    let vis = add_visual(&p.id, VisualKind::Sensor, 1);
                    let pin = |n: &str| PinRef::new(&p.id, n);
                    let (vcc, gnd) = (node(pin("VCC"), &mut map), node(pin("GND"), &mut map));
                    let (trig, echo) = (node(pin("TRIG"), &mut map), node(pin("ECHO"), &mut map));
                    elements.push(Element::Sense {
                        a: vcc,
                        b: gnd,
                        threshold: 3.0,
                        visual: vis,
                        channel: 0,
                    });
                    wire_parts.push(WirePart {
                        id: p.id.clone(),
                        vcc,
                        gnd,
                        data: trig,
                        vmin: 3.0,
                    });
                    dev_outputs.push((p.id.clone(), echo, 0));
                    let d = prop_f64(p, "distance", 50.0);
                    match self.devices.get_mut(&p.id) {
                        Some(Device::Sonar(x)) => x.distance_cm = d,
                        _ => {
                            self.devices
                                .insert(p.id.clone(), Device::Sonar(Sonar::new(d)));
                        }
                    }
                }
                "ds18b20" => {
                    // TO-92 sensor on a module with a 4.7 kΩ pull-up on DQ.
                    let vis = add_visual(&p.id, VisualKind::Sensor, 1);
                    let pin = |n: &str| PinRef::new(&p.id, n);
                    let (vcc, gnd) = (node(pin("VDD"), &mut map), node(pin("GND"), &mut map));
                    let dq = node(pin("DQ"), &mut map);
                    elements.push(Element::Sense {
                        a: vcc,
                        b: gnd,
                        threshold: 3.0,
                        visual: vis,
                        channel: 0,
                    });
                    elements.push(Element::Resistor {
                        a: vcc,
                        b: dq,
                        r: 4_700.0,
                    });
                    wire_parts.push(WirePart {
                        id: p.id.clone(),
                        vcc,
                        gnd,
                        data: dq,
                        vmin: 3.0,
                    });
                    dev_outputs.push((p.id.clone(), dq, 0));
                    let t = prop_f64(p, "temp", 25.0);
                    // The 48-bit serial: the `serial` prop (hex), else one
                    // derived from the part id, stable across sessions, so
                    // every sensor on a shared line has its own ROM code.
                    let serial = prop_str(p, "serial", "")
                        .trim()
                        .trim_start_matches("0x")
                        .trim_start_matches("0X")
                        .replace(['-', ' ', ':'], "");
                    let serial = u64::from_str_radix(&serial, 16).ok().unwrap_or_else(|| {
                        p.id.bytes().fold(0x5EED_u64, |a, b| {
                            a.wrapping_mul(131).wrapping_add(b as u64)
                        })
                    }) & 0xFFFF_FFFF_FFFF;
                    let rom = ds18b20_rom(serial);
                    match self.devices.get_mut(&p.id) {
                        Some(Device::Thermo(x)) => {
                            x.temp = t;
                            x.rom = rom;
                        }
                        _ => {
                            self.devices
                                .insert(p.id.clone(), Device::Thermo(Ds18b20::new(t, serial)));
                        }
                    }
                }
                "hc05" => {
                    // HC-05 on a ZS-040 board: regulator for 3.6–6 V, 3.3 V
                    // logic. TXD idles high, STATE is high while a phone is
                    // connected, EN (KEY) has a pull-down.
                    let vis = add_visual(&p.id, VisualKind::Sensor, 1);
                    let pin = |n: &str| PinRef::new(&p.id, n);
                    let (vcc, gnd) = (node(pin("VCC"), &mut map), node(pin("GND"), &mut map));
                    let (txd, rxd) = (node(pin("TXD"), &mut map), node(pin("RXD"), &mut map));
                    let (state, en) = (node(pin("STATE"), &mut map), node(pin("EN"), &mut map));
                    elements.push(Element::Sense {
                        a: vcc,
                        b: gnd,
                        threshold: HC05_VMIN,
                        visual: vis,
                        channel: 0,
                    });
                    elements.push(Element::Resistor {
                        a: en,
                        b: gnd,
                        r: 100_000.0,
                    });
                    dev_outputs.push((p.id.clone(), state, 0));
                    dev_outputs.push((p.id.clone(), txd, 1));
                    uart_parts.push(UartPart {
                        id: p.id.clone(),
                        vcc,
                        gnd,
                        rxd,
                        txd,
                        en,
                    });
                    let baud = prop_f64(p, "baud", 9600.0).clamp(1200.0, 1_382_400.0) as u32;
                    match self.devices.get_mut(&p.id) {
                        Some(Device::Bluetooth(b)) => {
                            // The prop changed (an AT+UART setting stays
                            // otherwise).
                            if b.prop_baud != baud {
                                b.baud = baud;
                                b.prop_baud = baud;
                            }
                        }
                        _ => {
                            self.devices
                                .insert(p.id.clone(), Device::Bluetooth(Box::new(Hc05::new(baud))));
                        }
                    }
                }
                "relay" => {
                    // 1-channel 5 V relay module (SRD-05VDC-SL-C, driver
                    // transistor, flyback diode, LED). Active-low boards pull
                    // IN up to VCC; active-high ones pull it down.
                    let vis = add_visual(&p.id, VisualKind::Sensor, 1);
                    let pin = |n: &str| PinRef::new(&p.id, n);
                    let (vcc, gnd) = (node(pin("VCC"), &mut map), node(pin("GND"), &mut map));
                    let inp = node(pin("IN"), &mut map);
                    let (com, no, nc) = (
                        node(pin("COM"), &mut map),
                        node(pin("NO"), &mut map),
                        node(pin("NC"), &mut map),
                    );
                    elements.push(Element::Sense {
                        a: vcc,
                        b: gnd,
                        threshold: RELAY_PULL_IN,
                        visual: vis,
                        channel: 0,
                    });
                    let active_low = prop_str(p, "trigger", "low") != "high";
                    let (a, b) = if active_low { (vcc, inp) } else { (inp, gnd) };
                    elements.push(Element::Resistor { a, b, r: 10_000.0 });
                    let k = relay_parts.len();
                    elements.push(Element::Contact {
                        a: com,
                        b: no,
                        relay: k,
                        when: true,
                    });
                    elements.push(Element::Contact {
                        a: com,
                        b: nc,
                        relay: k,
                        when: false,
                    });
                    relay_parts.push(RelayPart {
                        id: p.id.clone(),
                        vcc,
                        gnd,
                        inp,
                        active_low,
                    });
                    if !matches!(self.devices.get(&p.id), Some(Device::Relay(_))) {
                        self.devices
                            .insert(p.id.clone(), Device::Relay(Relay::default()));
                    }
                }
                "neopixel" | "neopixel-ring" | "neopixel-strip" | "neopixel-matrix" => {
                    let vis = add_visual(&p.id, VisualKind::Sensor, 1);
                    let pin = |n: &str| PinRef::new(&p.id, n);
                    let (vcc, gnd) = (node(pin("VCC"), &mut map), node(pin("GND"), &mut map));
                    let din = node(pin("DIN"), &mut map);
                    elements.push(Element::Sense {
                        a: vcc,
                        b: gnd,
                        threshold: 3.5,
                        visual: vis,
                        channel: 0,
                    });
                    wire_parts.push(WirePart {
                        id: p.id.clone(),
                        vcc,
                        gnd,
                        data: din,
                        vmin: 3.5,
                    });
                    // What goes past its own LEDs leaves on DOUT.
                    pixel_parts.push((p.id.clone(), din, node(pin("DOUT"), &mut map)));
                    let count = prop_f64(p, "count", 8.0).clamp(1.0, 256.0) as usize;
                    let keep = matches!(self.devices.get(&p.id), Some(Device::Pixels(n)) if n.leds.len() == count);
                    if !keep {
                        self.devices
                            .insert(p.id.clone(), Device::Pixels(NeoPixel::new(count)));
                    }
                }
                "ir-receiver" => {
                    // VS1838B module: open-collector output with a 10 kΩ
                    // pull-up, low while a carrier burst arrives.
                    let vis = add_visual(&p.id, VisualKind::Sensor, 1);
                    let pin = |n: &str| PinRef::new(&p.id, n);
                    let (vcc, gnd) = (node(pin("VCC"), &mut map), node(pin("GND"), &mut map));
                    let out = node(pin("OUT"), &mut map);
                    elements.push(Element::Sense {
                        a: vcc,
                        b: gnd,
                        threshold: 2.5,
                        visual: vis,
                        channel: 0,
                    });
                    elements.push(Element::Resistor {
                        a: vcc,
                        b: out,
                        r: 10_000.0,
                    });
                    wire_parts.push(WirePart {
                        id: p.id.clone(),
                        vcc,
                        gnd,
                        data: out,
                        vmin: 2.5,
                    });
                    dev_outputs.push((p.id.clone(), out, 0));
                    if !matches!(self.devices.get(&p.id), Some(Device::Ir(_))) {
                        self.devices
                            .insert(p.id.clone(), Device::Ir(IrRemote::default()));
                    }
                }
                "battery" => {
                    // A DC supply that floats: a 12 V adapter, a LiPo pack.
                    let v = prop_f64(p, "voltage", 12.0).clamp(0.0, 60.0);
                    elements.push(Element::Battery {
                        p: node(PinRef::new(&p.id, "+"), &mut map),
                        n: node(PinRef::new(&p.id, "-"), &mut map),
                        v,
                        r: R_SUPPLY,
                    });
                }
                "stepper-nema17" => {
                    // Bipolar stepper: two coils, driven through the nets by
                    // a driver module (see `link_steppers`).
                    add_visual(&p.id, VisualKind::Motion, 0);
                    let pin = |n: &str| PinRef::new(&p.id, n);
                    let coils = [
                        (node(pin("A+"), &mut map), node(pin("A-"), &mut map)),
                        (node(pin("B+"), &mut map), node(pin("B-"), &mut map)),
                    ];
                    let inputs = [windings.len(), windings.len() + 1];
                    for (k, &(a, b)) in coils.iter().enumerate() {
                        windings.push(WindingInfo {
                            a,
                            b,
                            r: STEPPER_COIL_R,
                        });
                        elements.push(Element::Winding {
                            a,
                            b,
                            r: STEPPER_COIL_R,
                            input: inputs[k],
                        });
                    }
                    stepper_parts.push(StepperPart {
                        id: p.id.clone(),
                        coils,
                        links: [None, None],
                        inputs,
                    });
                    let load = prop_f64(p, "load", 0.0).clamp(0.0, 100.0) / 100.0;
                    let inertia = prop_f64(p, "inertia", 0.0).clamp(0.0, 5000.0) * 1e-7;
                    let turn = prop_f64(p, "turn", 0.0);
                    let m = self.steppers.entry(p.id.clone()).or_insert_with(|| {
                        let mut m = BipolarStepper::new();
                        m.rebase(now_s);
                        m.turned = turn;
                        m
                    });
                    m.advance(now_s);
                    m.load = load;
                    m.inertia = crate::tier9::ROTOR_INERTIA + inertia;
                    if turn != m.turned {
                        m.turn_by_hand(now_s, turn - m.turned);
                        m.turned = turn;
                    }
                }
                "a4988" => {
                    // Pololu-style carrier: MS1–MS3 and EN pulled down
                    // (100 kΩ), SLEEP pulled up (10 kΩ to VDD), RESET floats.
                    add_visual(&p.id, VisualKind::Motion, 0);
                    let pin = |n: &str| PinRef::new(&p.id, n);
                    let gnd = node(pin("GND"), &mut map);
                    let vdd = node(pin("VDD"), &mut map);
                    let ms = [
                        node(pin("MS1"), &mut map),
                        node(pin("MS2"), &mut map),
                        node(pin("MS3"), &mut map),
                    ];
                    let en = node(pin("EN"), &mut map);
                    for n in ms.into_iter().chain([en]) {
                        elements.push(Element::Resistor {
                            a: n,
                            b: gnd,
                            r: 100_000.0,
                        });
                    }
                    let slp = node(pin("SLP"), &mut map);
                    elements.push(Element::Resistor {
                        a: vdd,
                        b: slp,
                        r: 10_000.0,
                    });
                    let drv8825 = prop_str(p, "model", "A4988") == "DRV8825";
                    let vmot = node(pin("VMOT"), &mut map);
                    let out = [
                        (node(pin("1A"), &mut map), node(pin("1B"), &mut map)),
                        (node(pin("2A"), &mut map), node(pin("2B"), &mut map)),
                    ];
                    // Output switches 1A, 1B, 2A, 2B (VMOT or GND).
                    let legs = n_legs;
                    for (i, o) in [out[0].0, out[0].1, out[1].0, out[1].1]
                        .into_iter()
                        .enumerate()
                    {
                        elements.push(Element::Leg {
                            out: o,
                            hi: vmot,
                            lo: gnd,
                            r: A4988_R_ON,
                            slot: legs + i,
                        });
                    }
                    n_legs += 4;
                    driver_parts.push(DriverPart {
                        id: p.id.clone(),
                        step: node(pin("STEP"), &mut map),
                        dir: node(pin("DIR"), &mut map),
                        en,
                        ms,
                        rst: node(pin("RST"), &mut map),
                        slp,
                        vmot,
                        vdd,
                        gnd,
                        out,
                        current: prop_f64(p, "current", 100.0).clamp(10.0, 100.0) / 100.0,
                        legs,
                    });
                    match self.drivers.get_mut(&p.id) {
                        Some(d) if d.drv.drv8825 == drv8825 => {}
                        _ => {
                            self.drivers.insert(
                                p.id.clone(),
                                DriverState {
                                    drv: StepDriver::new(drv8825),
                                    out: [(0.0, CoilDrive::Off); 2],
                                    state: "no-vmot",
                                    vmot: 0.0,
                                },
                            );
                        }
                    }
                }
                "l298n" => {
                    // Dual H-bridge module; the inputs have no pull resistors.
                    add_visual(&p.id, VisualKind::Motion, 0);
                    let pin = |n: &str| PinRef::new(&p.id, n);
                    let vs = node(pin("12V"), &mut map);
                    let gnd = node(pin("GND"), &mut map);
                    let out = [
                        (node(pin("OUT1"), &mut map), node(pin("OUT2"), &mut map)),
                        (node(pin("OUT3"), &mut map), node(pin("OUT4"), &mut map)),
                    ];
                    // Output switches OUT1–OUT4 (12V or GND).
                    let legs = n_legs;
                    for (i, o) in [out[0].0, out[0].1, out[1].0, out[1].1]
                        .into_iter()
                        .enumerate()
                    {
                        elements.push(Element::Leg {
                            out: o,
                            hi: vs,
                            lo: gnd,
                            r: L298N_R_ON,
                            slot: legs + i,
                        });
                    }
                    n_legs += 4;
                    bridge_parts.push(BridgePart {
                        id: p.id.clone(),
                        inp: [
                            node(pin("IN1"), &mut map),
                            node(pin("IN2"), &mut map),
                            node(pin("IN3"), &mut map),
                            node(pin("IN4"), &mut map),
                        ],
                        en: [node(pin("ENA"), &mut map), node(pin("ENB"), &mut map)],
                        vs,
                        gnd,
                        v5: node(pin("5V"), &mut map),
                        out,
                        jumpers: prop_str(p, "jumpers", "on") != "off",
                        legs,
                    });
                    self.bridges
                        .entry(p.id.clone())
                        .or_insert_with(|| BridgeState {
                            since: now_s,
                            frame_start: now_s,
                            ..Default::default()
                        });
                }
                "esc-bldc" => {
                    // ESC (BLHeli class) with a brushless outrunner and a
                    // propeller; the signal cable's GND is the battery's −.
                    add_visual(&p.id, VisualKind::Motion, 0);
                    let pin = |n: &str| PinRef::new(&p.id, n);
                    esc_parts.push(EscPart {
                        id: p.id.clone(),
                        sig: node(pin("SIG"), &mut map),
                        gnd: node(pin("GND"), &mut map),
                        bat: node(pin("BAT+"), &mut map),
                    });
                    let kv = prop_f64(p, "kv", 1000.0).clamp(100.0, 5000.0);
                    let load = prop_f64(p, "load", 0.0).clamp(0.0, 100.0) / 100.0;
                    let (e, _) = self.escs.entry(p.id.clone()).or_insert_with(|| {
                        let mut e = Esc::new(kv);
                        e.rebase(now_s);
                        (e, None)
                    });
                    e.advance(now_s);
                    e.kv = kv;
                    e.load = load;
                }
                "bldc-hall" | "bldc" => {
                    // 3-phase BLDC (star) with three open-collector hall
                    // sensors (device outputs 0–2: A, B, C); "bldc" (M28)
                    // is the same motor without them (sensorless).
                    add_visual(&p.id, VisualKind::Motion, 0);
                    let pin = |n: &str| PinRef::new(&p.id, n);
                    let sensorless = p.kind == "bldc";
                    let mut halls = [0; 3];
                    let (mut vcc, mut gnd) = (0, 0);
                    if !sensorless {
                        halls = [
                            node(pin("HA"), &mut map),
                            node(pin("HB"), &mut map),
                            node(pin("HC"), &mut map),
                        ];
                        for (i, &h) in halls.iter().enumerate() {
                            dev_outputs.push((p.id.clone(), h, i));
                        }
                        vcc = node(pin("VCC"), &mut map);
                        gnd = node(pin("GND"), &mut map);
                    }
                    let phases = [
                        node(pin("U"), &mut map),
                        node(pin("V"), &mut map),
                        node(pin("W"), &mut map),
                    ];
                    // The windings meet at the star point inside the motor.
                    let star = node(pin("@star"), &mut map);
                    let inputs = [0, 1, 2].map(|k| windings.len() + k);
                    for (k, &ph) in phases.iter().enumerate() {
                        windings.push(WindingInfo {
                            a: ph,
                            b: star,
                            r: BLDC_R,
                        });
                        elements.push(Element::Winding {
                            a: ph,
                            b: star,
                            r: BLDC_R,
                            input: inputs[k],
                        });
                    }
                    bldc_parts.push(BldcPart {
                        id: p.id.clone(),
                        phases,
                        links: [None, None, None],
                        vcc,
                        gnd,
                        halls,
                        inputs,
                        sensorless,
                    });
                    let load = prop_f64(p, "load", 0.0).clamp(0.0, 100.0) / 100.0;
                    match self.devices.get_mut(&p.id) {
                        Some(Device::Bldc(b)) if b.sensorless == sensorless => {
                            b.advance(now_s);
                            b.load = load;
                        }
                        _ => {
                            let mut b = HallBldc::new();
                            b.rebase(now_s);
                            b.load = load;
                            b.sensorless = sensorless;
                            self.devices.insert(p.id.clone(), Device::Bldc(Box::new(b)));
                        }
                    }
                }
                "bridge-3ph" => {
                    // INH/INL inputs pulled down on the module (100 kΩ).
                    add_visual(&p.id, VisualKind::Motion, 0);
                    let pin = |n: &str| PinRef::new(&p.id, n);
                    let gnd = node(pin("GND"), &mut map);
                    let mut inh = [0; 3];
                    let mut inl = [0; 3];
                    let mut out = [0; 3];
                    for (k, ph) in ["A", "B", "C"].iter().enumerate() {
                        inh[k] = node(pin(&format!("INH{ph}")), &mut map);
                        inl[k] = node(pin(&format!("INL{ph}")), &mut map);
                        out[k] = node(pin(&format!("OUT{ph}")), &mut map);
                        for n in [inh[k], inl[k]] {
                            elements.push(Element::Resistor {
                                a: n,
                                b: gnd,
                                r: 100_000.0,
                            });
                        }
                    }
                    self.phase_state
                        .entry(p.id.clone())
                        .or_insert_with(|| PhaseBridge::new(now_s));
                    let pvdd = node(pin("PVDD"), &mut map);
                    // Output switches OUTA–OUTC (PVDD or GND).
                    let legs = n_legs;
                    for (k, &o) in out.iter().enumerate() {
                        elements.push(Element::Leg {
                            out: o,
                            hi: pvdd,
                            lo: gnd,
                            r: BRIDGE_R_ON,
                            slot: legs + k,
                        });
                    }
                    n_legs += 3;
                    phase_bridges.push(PhaseBridgePart {
                        id: p.id.clone(),
                        inh,
                        inl,
                        pvdd,
                        gnd,
                        out,
                        legs,
                    });
                }
                "joystick" => {
                    // KY-023: two 10 kΩ pots between GND and +5V, wipers on
                    // VRx and VRy; the push switch closes SW to GND (no
                    // pull-up on the module).
                    let vis = add_visual(&p.id, VisualKind::Sensor, 1);
                    let pin = |n: &str| PinRef::new(&p.id, n);
                    let (vcc, gnd) = (node(pin("+5V"), &mut map), node(pin("GND"), &mut map));
                    elements.push(Element::Sense {
                        a: vcc,
                        b: gnd,
                        threshold: 1.0,
                        visual: vis,
                        channel: 0,
                    });
                    node(pin("SW"), &mut map);
                    for (axis, wiper) in [("x", "VRx"), ("y", "VRy")] {
                        let pos = prop_f64(p, axis, 0.5).clamp(0.0, 1.0);
                        let w = node(pin(wiper), &mut map);
                        elements.push(Element::Resistor {
                            a: gnd,
                            b: w,
                            r: (10_000.0 * pos).max(1.0),
                        });
                        elements.push(Element::Resistor {
                            a: w,
                            b: vcc,
                            r: (10_000.0 * (1.0 - pos)).max(1.0),
                        });
                    }
                }
                "hc595" => {
                    // 74HC595 in DIP-16: Q0–Q7 and Q7' are push-pull
                    // outputs of the chip (device outputs 0–7 and 8).
                    let vis = add_visual(&p.id, VisualKind::Sensor, 1);
                    let pin = |n: &str| PinRef::new(&p.id, n);
                    let (vcc, gnd) = (node(pin("VCC"), &mut map), node(pin("GND"), &mut map));
                    elements.push(Element::Sense {
                        a: vcc,
                        b: gnd,
                        threshold: HC595_VMIN,
                        visual: vis,
                        channel: 0,
                    });
                    for i in 0..8 {
                        let q = node(pin(&format!("Q{i}")), &mut map);
                        dev_outputs.push((p.id.clone(), q, i));
                    }
                    let q7s = node(pin("Q7S"), &mut map);
                    dev_outputs.push((p.id.clone(), q7s, 8));
                    shift_parts.push(ShiftPart {
                        id: p.id.clone(),
                        vcc,
                        gnd,
                        ds: node(pin("DS"), &mut map),
                        shcp: node(pin("SHCP"), &mut map),
                        stcp: node(pin("STCP"), &mut map),
                        oe: node(pin("OE"), &mut map),
                        mr: node(pin("MR"), &mut map),
                        q7s,
                    });
                    if !matches!(self.devices.get(&p.id), Some(Device::Shift(_))) {
                        self.devices
                            .insert(p.id.clone(), Device::Shift(Hc595::default()));
                    }
                }
                "tm1637" => {
                    // 4-digit module: 10 kΩ pull-ups on CLK and DIO; the
                    // chip pulls DIO low for each ACK.
                    let vis = add_visual(&p.id, VisualKind::Sensor, 1);
                    let pin = |n: &str| PinRef::new(&p.id, n);
                    let (vcc, gnd) = (node(pin("VCC"), &mut map), node(pin("GND"), &mut map));
                    let (clk, dio) = (node(pin("CLK"), &mut map), node(pin("DIO"), &mut map));
                    elements.push(Element::Sense {
                        a: vcc,
                        b: gnd,
                        threshold: TM1637_VMIN,
                        visual: vis,
                        channel: 0,
                    });
                    for line in [clk, dio] {
                        elements.push(Element::Resistor {
                            a: vcc,
                            b: line,
                            r: 10_000.0,
                        });
                    }
                    dev_outputs.push((p.id.clone(), dio, 0));
                    tm_parts.push(TmPart {
                        id: p.id.clone(),
                        vcc,
                        gnd,
                        clk,
                        dio,
                    });
                    if !matches!(self.devices.get(&p.id), Some(Device::Tm(_))) {
                        self.devices
                            .insert(p.id.clone(), Device::Tm(Box::new(Tm1637::new())));
                    }
                }
                "pir" => {
                    // HC-SR501: regulator for 4.5–20 V, OUT a 3.3 V output.
                    let vis = add_visual(&p.id, VisualKind::Sensor, 1);
                    let pin = |n: &str| PinRef::new(&p.id, n);
                    let (vcc, gnd) = (node(pin("VCC"), &mut map), node(pin("GND"), &mut map));
                    elements.push(Element::Sense {
                        a: vcc,
                        b: gnd,
                        threshold: PIR_VMIN,
                        visual: vis,
                        channel: 0,
                    });
                    dev_outputs.push((p.id.clone(), node(pin("OUT"), &mut map), 0));
                    pir_parts.push(PirPart {
                        id: p.id.clone(),
                        vcc,
                        gnd,
                    });
                    let retrigger = prop_str(p, "mode", "H") != "L";
                    let delay = prop_f64(p, "delay", 3.0).clamp(0.3, 300.0);
                    let warmup = prop_f64(p, "warmup", 3.0).clamp(0.0, 60.0);
                    let motion = p.props.get("motion").is_some_and(truthy);
                    match self.devices.get_mut(&p.id) {
                        Some(Device::Pir(x)) => x.configure(now_s, retrigger, delay, warmup),
                        _ => {
                            self.devices.insert(
                                p.id.clone(),
                                Device::Pir(Pir::new(retrigger, delay, warmup)),
                            );
                        }
                    }
                    if let Some(Device::Pir(x)) = self.devices.get_mut(&p.id) {
                        x.set_motion(now_s, motion);
                    }
                }
                "max7219" => {
                    // FC-16 module(s): DIN, CLK, CS (LOAD); taken from
                    // hardware SPI bytes or from bit-banged CLK edges.
                    let vis = add_visual(&p.id, VisualKind::Sensor, 1);
                    let pin = |n: &str| PinRef::new(&p.id, n);
                    let (vcc, gnd) = (node(pin("VCC"), &mut map), node(pin("GND"), &mut map));
                    let (din, clk, cs) = (
                        node(pin("DIN"), &mut map),
                        node(pin("CLK"), &mut map),
                        node(pin("CS"), &mut map),
                    );
                    // DOUT is a push-pull output: a further module on it
                    // shifts in what leaves this one (bit-banged chains
                    // work through the nets; SPI bytes are forwarded, see
                    // `spi`).
                    let dout = node(pin("DOUT"), &mut map);
                    dev_outputs.push((p.id.clone(), dout, 0));
                    elements.push(Element::Sense {
                        a: vcc,
                        b: gnd,
                        threshold: 3.0,
                        visual: vis,
                        channel: 0,
                    });
                    spi_parts.push(SpiPart {
                        id: p.id.clone(),
                        vcc,
                        gnd,
                        sck: clk,
                        mosi: din,
                        miso: None,
                        cs,
                        dc: None,
                        res: None,
                        vmin: 3.0,
                    });
                    matrix_parts.push(MatrixPart {
                        id: p.id.clone(),
                        vcc,
                        gnd,
                        din,
                        clk,
                        cs,
                        dout,
                        vmin: 3.0,
                    });
                    let count = prop_f64(p, "count", 1.0).clamp(1.0, 4.0) as usize;
                    let keep = matches!(self.devices.get(&p.id), Some(Device::Matrix(m)) if m.count == count);
                    if !keep {
                        self.devices
                            .insert(p.id.clone(), Device::Matrix(Max7219::new(count)));
                    }
                }
                "oled-ssd1306-spi" | "sd-card" => {
                    let vis = add_visual(&p.id, VisualKind::Sensor, 1);
                    let pin = |n: &str| PinRef::new(&p.id, n);
                    let oled = p.kind == "oled-ssd1306-spi";
                    let (vcc, gnd) = (node(pin("VCC"), &mut map), node(pin("GND"), &mut map));
                    let (sck, mosi) = if oled { ("D0", "D1") } else { ("SCK", "MOSI") };
                    // SD modules regulate 5 V down and need at least 3 V.
                    let vmin = if oled { MODULE_VMIN } else { 3.0 };
                    elements.push(Element::Sense {
                        a: vcc,
                        b: gnd,
                        threshold: vmin,
                        visual: vis,
                        channel: 0,
                    });
                    spi_parts.push(SpiPart {
                        id: p.id.clone(),
                        vcc,
                        gnd,
                        sck: node(pin(sck), &mut map),
                        mosi: node(pin(mosi), &mut map),
                        miso: (!oled).then(|| node(pin("MISO"), &mut map)),
                        cs: node(pin("CS"), &mut map),
                        dc: oled.then(|| node(pin("DC"), &mut map)),
                        res: oled.then(|| node(pin("RES"), &mut map)),
                        vmin,
                    });
                    let size = prop_f64(p, "size", 32.0).clamp(1.0, 2048.0) as u32;
                    let keep = match self.devices.get(&p.id) {
                        Some(Device::Oled(_)) => oled,
                        Some(Device::Sd(sd)) => !oled && sd.nominal_mb == size,
                        _ => false,
                    };
                    if !keep {
                        let fresh = if oled {
                            Device::Oled(Box::new(Ssd1306::new(0x3C)))
                        } else {
                            Device::Sd(Box::new(SdCard::new(size)))
                        };
                        self.devices.insert(p.id.clone(), fresh);
                    }
                }
                "oled-ssd1306" | "rtc-ds3231" | "aht20" | "lcd-i2c" | "mpu6050" | "bmp280" => {
                    // Breakout module: the chip plus 4.7 kΩ pull-ups from
                    // its VCC to SCL and SDA.
                    let vis = add_visual(&p.id, VisualKind::Sensor, 1);
                    let pin = |n: &str| PinRef::new(&p.id, n);
                    let (vcc, gnd) = (node(pin("VCC"), &mut map), node(pin("GND"), &mut map));
                    let (scl, sda) = (node(pin("SCL"), &mut map), node(pin("SDA"), &mut map));
                    elements.push(Element::Sense {
                        a: vcc,
                        b: gnd,
                        threshold: MODULE_VMIN,
                        visual: vis,
                        channel: 0,
                    });
                    for line in [scl, sda] {
                        elements.push(Element::Resistor {
                            a: vcc,
                            b: line,
                            r: 4_700.0,
                        });
                    }
                    bus_parts.push(BusPart {
                        id: p.id.clone(),
                        vcc,
                        gnd,
                        scl,
                        sda,
                    });
                    let temp = prop_f64(p, "temp", 25.0);
                    let fresh = match p.kind.as_str() {
                        "oled-ssd1306" => {
                            let addr = if prop_str(p, "address", "0x3C") == "0x3D" {
                                0x3D
                            } else {
                                0x3C
                            };
                            Device::Oled(Box::new(Ssd1306::new(addr)))
                        }
                        "rtc-ds3231" => Device::Rtc(Ds3231::new(self.wall_clock - now_s)),
                        "lcd-i2c" => {
                            let addr = u8::from_str_radix(
                                prop_str(p, "address", "0x27").trim_start_matches("0x"),
                                16,
                            )
                            .unwrap_or(0x27);
                            Device::Lcd(Box::new(CharLcd::new(addr)))
                        }
                        "mpu6050" => {
                            // AD0 high: 0x69.
                            let addr = if prop_str(p, "address", "0x68") == "0x69" {
                                0x69
                            } else {
                                0x68
                            };
                            Device::Imu(Box::new(Mpu6050::new(addr)))
                        }
                        "bmp280" => {
                            // SDO high: 0x77.
                            let addr = if prop_str(p, "address", "0x76") == "0x77" {
                                0x77
                            } else {
                                0x76
                            };
                            Device::Baro(Box::new(Bmp280::new(addr, temp, 101_325.0)))
                        }
                        _ => Device::Aht(Aht20::new(temp, prop_f64(p, "humidity", 50.0))),
                    };
                    let keep = self.devices.get(&p.id).is_some_and(|d| {
                        std::mem::discriminant(d) == std::mem::discriminant(&fresh)
                            && d.address() == fresh.address()
                    });
                    if !keep {
                        self.devices.insert(p.id.clone(), fresh);
                    }
                    // Inputs from the inspector.
                    match self.devices.get_mut(&p.id) {
                        Some(Device::Rtc(r)) => r.temp = temp,
                        Some(Device::Aht(a)) => {
                            a.temp = temp;
                            a.humidity = prop_f64(p, "humidity", 50.0).clamp(0.0, 100.0);
                        }
                        Some(Device::Imu(m)) => {
                            m.temp = temp;
                            m.roll = prop_f64(p, "roll", 0.0);
                            m.pitch = prop_f64(p, "pitch", 0.0);
                            m.gyro = ["gx", "gy", "gz"].map(|k| prop_f64(p, k, 0.0));
                            // A shake: acceleration on top of gravity (g).
                            m.extra = ["ax", "ay", "az"].map(|k| prop_f64(p, k, 0.0));
                        }
                        Some(Device::Baro(b)) => {
                            b.temp = temp;
                            b.pressure = prop_f64(p, "pressure", 1013.25) * 100.0;
                        }
                        _ => {}
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
                slot.pattern = old.pattern;
                slot.phase = old.phase;
                slot.last_step = old.last_step;
                slot.prev_phase = old.prev_phase;
                slot.prev_angle = old.prev_angle;
                slot.prev_step = old.prev_step;
                slot.last_change = old.last_change;
            }
        }
        // Value problems describe the circuit as it is now.
        for w in self.value_warnings.drain(..) {
            self.warnings.remove(&w);
        }
        self.warnings.extend(bad_values.iter().cloned());
        self.value_warnings = bad_values;
        self.pin_nodes = map;
        // Parts that were removed take their state with them.
        let encoders: Vec<&str> = parts
            .iter()
            .filter(|p| p.kind == "rotary-encoder")
            .map(|p| p.id.as_str())
            .collect();
        let ids: BTreeSet<&str> = bus_parts
            .iter()
            .map(|b: &BusPart| b.id.as_str())
            .chain(spi_parts.iter().map(|b: &SpiPart| b.id.as_str()))
            .chain(wire_parts.iter().map(|b: &WirePart| b.id.as_str()))
            .chain(uart_parts.iter().map(|b: &UartPart| b.id.as_str()))
            .chain(relay_parts.iter().map(|b: &RelayPart| b.id.as_str()))
            .chain(shift_parts.iter().map(|b: &ShiftPart| b.id.as_str()))
            .chain(tm_parts.iter().map(|b: &TmPart| b.id.as_str()))
            .chain(pir_parts.iter().map(|b: &PirPart| b.id.as_str()))
            .chain(bldc_parts.iter().map(|b: &BldcPart| b.id.as_str()))
            .chain(encoders)
            .collect();
        self.devices.retain(|id, _| ids.contains(id.as_str()));
        // A transfer in progress continues if its device is still on the
        // bus (a switch was pressed or a sensor value changed meanwhile).
        let on_bus = |id: &str| bus_parts.iter().any(|b: &BusPart| b.id == id);
        self.i2c_active.retain(|_, id| on_bus(id));
        self.bus_parts = bus_parts;
        self.spi_parts = spi_parts;
        self.line_levels
            .retain(|id, _| wire_parts.iter().any(|w| &w.id == id));
        self.wire_parts = wire_parts;
        self.matrix_parts = matrix_parts;
        self.dev_outputs = dev_outputs;
        self.uart_parts = uart_parts;
        self.relay_parts = relay_parts;
        self.shift_parts = shift_parts;
        self.tm_parts = tm_parts;
        self.pir_parts = pir_parts;
        self.pixel_parts = pixel_parts;
        // Motors: which driver outputs each coil sits across.
        let mut link_warnings = link_steppers(&mut stepper_parts, &driver_parts, &bridge_parts);
        link_warnings.extend(link_bldcs(&mut bldc_parts, &phase_bridges));
        self.warnings.extend(link_warnings.iter().cloned());
        self.value_warnings.extend(link_warnings);
        let ids: Vec<String> = stepper_parts.iter().map(|m| m.id.clone()).collect();
        self.steppers.retain(|id, _| ids.contains(id));
        let ids: Vec<String> = driver_parts.iter().map(|m| m.id.clone()).collect();
        self.drivers.retain(|id, _| ids.contains(id));
        let ids: Vec<String> = bridge_parts.iter().map(|m| m.id.clone()).collect();
        self.bridges.retain(|id, _| ids.contains(id));
        let ids: Vec<String> = esc_parts.iter().map(|m| m.id.clone()).collect();
        self.escs.retain(|id, _| ids.contains(id));
        self.stepper_parts = stepper_parts;
        self.driver_parts = driver_parts;
        self.bridge_parts = bridge_parts;
        self.esc_parts = esc_parts;
        self.phase_out
            .retain(|id, _| phase_bridges.iter().any(|b| &b.id == id));
        self.phase_state
            .retain(|id, _| phase_bridges.iter().any(|b| &b.id == id));
        self.bldc_parts = bldc_parts;
        self.phase_bridges = phase_bridges;
        // The switches start off; the windings on their back-EMF.
        self.legs = vec![Drive::Float; n_legs];
        self.winding_cs = vec![false; windings.len()];
        self.x = vec![0.0; windings.len()];
        self.windings = windings;
        self.emf_probe_live = false;
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
        // Motor windings: the same operating point once more with each
        // node's sensitivity to the windings' inputs (M28).
        let sens = if self.windings.is_empty() {
            Vec::new()
        } else {
            let (v2, sens) = self.nodal_sens(drives, &on);
            v = v2;
            sens
        };

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
                Element::Battery { p, n, v: vb, r } => {
                    let cur = (vb - (v[p] - v[n])) / r;
                    // A short pulls the terminals together; a stalled
                    // motor draws amperes but leaves the voltage.
                    if cur > 5.0 && v[p] - v[n] < 0.5 * vb {
                        warnings.push(format!(
                            "short circuit: the {vb:.0} V supply's + is connected to its − (or to a lower voltage)"
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
            // Five-volt tolerant (FT) pins take up to 5.5 V; the analog-capable
            // and oscillator pins only VDD + 0.3 V (STM32F401 datasheet).
            let tolerant = !matches!(
                (port, pin),
                (0, 0..=7) | (1, 0..=1) | (2, 0..=5) | (2, 14..=15) | (7, _)
            );
            let max = if tolerant { 5.5 } else { 4.0 };
            if v[node] > max && node != 0 {
                warnings.push(if tolerant {
                    format!("{name}: {:.1} V applied — more than the 5.5 V a 5 V-tolerant pin takes", v[node])
                } else {
                    format!(
                        "{name}: {:.1} V applied — this pin is not 5 V tolerant (maximum VDD + 0.3 V)",
                        v[node]
                    )
                });
            }
            inputs.push(comp[node].then_some(v[node] > VDD / 2.0));
        }
        // Which nodes the windings' inputs move, and the winding currents
        // a + B·x (rows of back-EMF windings; a current source's current
        // is its input).
        let tiny = |x: f64| x.abs() < 1e-9;
        let sens_node: Vec<bool> = (0..self.nodes)
            .map(|k| sens.iter().any(|c| !tiny(c[k])))
            .collect();
        let nw = self.windings.len();
        let mut coef_a = vec![0.0; nw];
        let mut coef_b = vec![0.0; nw * nw];
        for (j, w) in self.windings.iter().enumerate() {
            if self.current_mode(drives, j) {
                continue;
            }
            coef_a[j] = (v[w.a] - v[w.b]) / w.r;
            for (k, c) in sens.iter().enumerate() {
                let own = if k == j { 1.0 } else { 0.0 };
                coef_b[j * nw + k] = (c[w.a] - c[w.b] - own) / w.r;
            }
        }
        Solution {
            v,
            sens,
            sens_node,
            coef_a,
            coef_b,
            level,
            over,
            inputs,
            driven: comp,
            warnings,
        }
    }

    /// Whether relay `k` has COM on NO in this drive key.
    fn contact(&self, drives: &[Drive], k: usize) -> bool {
        drives.get(self.mcu.len() + self.dev_outputs.len() + k) == Some(&Drive::High)
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
                Element::Battery { p, n, .. } => union(&mut parent, p, n),
                Element::Led { a, k, .. } if on[i] => union(&mut parent, a, k),
                Element::Sensor { out, gnd, .. } if on[i] => union(&mut parent, out, gnd),
                Element::Contact { a, b, relay, when } if self.contact(drives, relay) == when => {
                    union(&mut parent, a, b)
                }
                Element::Leg {
                    out, hi, lo, slot, ..
                } => match self.leg(drives, slot) {
                    Drive::High => union(&mut parent, out, hi),
                    Drive::Low => union(&mut parent, out, lo),
                    _ => {}
                },
                Element::Winding { a, b, input, .. } if !self.current_mode(drives, input) => {
                    union(&mut parent, a, b)
                }
                _ => {}
            }
        }
        let mut sourced = vec![false; n];
        sourced[find(&mut parent, 0)] = true;
        for e in &self.elements {
            if let Element::Supply { n, .. } | Element::Battery { p: n, .. } = *e {
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
        for (j, (_, node, _)) in self.dev_outputs.iter().enumerate() {
            if drives
                .get(self.mcu.len() + j)
                .is_some_and(|&d| drive_source(d).is_some())
            {
                let r = find(&mut parent, *node);
                sourced[r] = true;
            }
        }
        (0..n).map(|x| sourced[find(&mut parent, x)]).collect()
    }

    /// Linear nodal analysis with the LEDs in the given states.
    fn nodal(&self, drives: &[Drive], on: &[bool]) -> Vec<f64> {
        let n = self.nodes;
        let m = n - 1;
        let (mut g, rhs) = self.stamp(drives, on);
        let mut cols = vec![rhs];
        let x = gauss_cols(&mut g, &mut cols, m).swap_remove(0);
        let mut v = vec![0.0; n];
        v[1..].copy_from_slice(&x);
        v
    }

    /// The operating point and each node's sensitivity to every winding
    /// input (unit back-EMF, or unit current in current mode), from one
    /// factorisation.
    fn nodal_sens(&self, drives: &[Drive], on: &[bool]) -> (Vec<f64>, Vec<Vec<f64>>) {
        let n = self.nodes;
        let m = n - 1;
        let (mut g, rhs) = self.stamp(drives, on);
        let mut cols = vec![rhs];
        for (j, w) in self.windings.iter().enumerate() {
            let mut c = vec![0.0; m];
            let (ia, ib) = if self.current_mode(drives, j) {
                (-1.0, 1.0)
            } else {
                (1.0 / w.r, -1.0 / w.r)
            };
            if w.a > 0 {
                c[w.a - 1] += ia;
            }
            if w.b > 0 {
                c[w.b - 1] += ib;
            }
            cols.push(c);
        }
        let xs = gauss_cols(&mut g, &mut cols, m);
        let mut out = xs.into_iter().map(|x| {
            let mut v = vec![0.0; n];
            v[1..].copy_from_slice(&x);
            v
        });
        let v = out.next().unwrap_or_default();
        (v, out.collect())
    }

    /// The conductance matrix (nodes 1..n) and source vector.
    fn stamp(&self, drives: &[Drive], on: &[bool]) -> (Vec<f64>, Vec<f64>) {
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
                Element::Battery { p, n, v, r } => {
                    // Norton: v/r from n into p, with r across.
                    let c = 1.0 / r;
                    stamp(&mut g, p, n, c);
                    if p > 0 {
                        rhs[p - 1] += v * c;
                    }
                    if n > 0 {
                        rhs[n - 1] -= v * c;
                    }
                }
                Element::Contact { a, b, relay, when } if self.contact(drives, relay) == when => {
                    stamp(&mut g, a, b, 1.0 / R_CONTACT)
                }
                Element::Leg {
                    out,
                    hi,
                    lo,
                    r,
                    slot,
                } => match self.leg(drives, slot) {
                    Drive::High => stamp(&mut g, out, hi, 1.0 / r),
                    Drive::Low => stamp(&mut g, out, lo, 1.0 / r),
                    _ => {}
                },
                // The back-EMF itself is an input (zero here).
                Element::Winding { a, b, r, input } if !self.current_mode(drives, input) => {
                    stamp(&mut g, a, b, 1.0 / r)
                }
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
        for (j, (_, node, _)) in self.dev_outputs.iter().enumerate() {
            if let Some((v, r)) = drives
                .get(self.mcu.len() + j)
                .and_then(|&d| drive_source(d))
            {
                source(&mut g, &mut rhs, *node, v, r);
            }
        }
        (g, rhs)
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
        let first = self.current.is_none();
        self.inputs_changed = false;
        self.update_inner(time, drives);
        self.current.as_ref()?;
        (first || self.inputs_changed).then(|| self.inputs_now.clone())
    }

    /// The solution for a drive key, from the cache or solved now.
    fn solution_for(&mut self, key: &[Drive]) -> Rc<Solution> {
        if let Some(s) = self.cache.get(key) {
            return s.clone();
        }
        let s = Rc::new(self.solve(key));
        for w in &s.warnings {
            self.warnings.insert(w.clone());
        }
        if self.cache.len() > 4096 {
            self.cache.clear();
        }
        self.cache.insert(key.to_vec(), s.clone());
        s
    }

    /// What the devices drive and where the relay contacts are, after the
    /// MCU's pins in the drive key.
    fn device_key(&mut self, now_s: f64) -> Vec<Drive> {
        let mut key = Vec::new();
        for (id, _, idx) in &self.dev_outputs {
            let out = self.devices.get_mut(id).and_then(|d| {
                d.advance(now_s);
                d.drive(*idx)
            });
            key.push(match out {
                Some(false) => Drive::Low,
                Some(true) => Drive::High,
                None => Drive::Float,
            });
        }
        // Then where each relay's contacts are.
        for part in &self.relay_parts {
            let closed = match self.devices.get_mut(&part.id) {
                Some(Device::Relay(r)) => {
                    r.advance(now_s);
                    r.closed
                }
                _ => false,
            };
            key.push(if closed { Drive::High } else { Drive::Low });
        }
        // Then the motor drivers' output switches, and which windings a
        // chopper drives as a current source (M28).
        key.extend_from_slice(&self.legs);
        key.extend(
            self.winding_cs
                .iter()
                .map(|&cs| if cs { Drive::High } else { Drive::Low }),
        );
        key
    }

    /// Index in the drive key of the first output switch.
    fn leg_base(&self) -> usize {
        self.mcu.len() + self.dev_outputs.len() + self.relay_parts.len()
    }

    /// The state of output switch `slot` in this drive key.
    fn leg(&self, drives: &[Drive], slot: usize) -> Drive {
        drives
            .get(self.leg_base() + slot)
            .copied()
            .unwrap_or(Drive::Float)
    }

    /// Winding `j` is a current source (a chopper's regulated current) in
    /// this drive key.
    fn current_mode(&self, drives: &[Drive], j: usize) -> bool {
        drives.get(self.leg_base() + self.legs.len() + j) == Some(&Drive::High)
    }

    fn update_inner(&mut self, time: Cycles, drives: &[Drive]) {
        // Devices that drive a line on their own schedule (DHT) come after
        // the MCU's pins in the drive list, so they are part of the cache key.
        let now_s = self.seconds_at(time);
        let mcu = drives.len();
        // The MCU's pins as they were: a 3-phase bridge input may have
        // stopped switching (its outputs then change by themselves).
        let same_pins = self
            .drives
            .as_ref()
            .is_some_and(|d| d.len() >= mcu && d[..mcu] == *drives);
        let phases_due = same_pins && self.phase_bridges_due(now_s);
        if !same_pins {
            self.predict_phase_legs(drives, now_s);
        }
        let mut key = drives.to_vec();
        key.extend(self.device_key(now_s));
        let drives = &key[..];
        if self.drives.as_deref() == Some(drives) {
            if phases_due {
                self.apply_motor_networks(now_s);
            }
            self.refresh_windings(time, now_s, true);
            return;
        }
        self.integrate(time);
        let sol = self.solution_for(drives);
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
            // Stepper: follow the coil pattern half step by half step.
            if slot.kind == VisualKind::Stepper {
                let lv = &sol.level[i];
                let pattern = (0..4).fold(0u8, |a, c| a | ((lv[c] > 0.5) as u8) << c);
                let powered = lv[4] > 0.5;
                if pattern != slot.pattern {
                    slot.pattern = pattern;
                    let now_s = self.clock.1 + (time as f64 - self.clock.0 as f64) / self.clock.2;
                    // Pins written one after the other: the intermediate
                    // pattern lasted microseconds and moved nothing.
                    if now_s - slot.last_change < 50e-6 {
                        slot.stalled = false;
                        slot.phase = slot.prev_phase;
                        slot.angle = slot.prev_angle;
                        slot.last_step = slot.prev_step;
                    }
                    if std::mem::take(&mut slot.stalled) {
                        self.warnings.insert(format!(
                            "{}: steps faster than the motor can follow (< 0.8 ms per half step) — it stalls",
                            slot.id
                        ));
                    }
                    slot.prev_phase = slot.phase;
                    slot.prev_angle = slot.angle;
                    slot.prev_step = slot.last_step;
                    slot.last_change = now_s;
                    // Half-step sequence A, AB, B, BC, C, CD, D, DA.
                    const SEQ: [u8; 8] = [
                        0b0001, 0b0011, 0b0010, 0b0110, 0b0100, 0b1100, 0b1000, 0b1001,
                    ];
                    if let (Some(ph), true) = (SEQ.iter().position(|&p| p == pattern), powered) {
                        let delta = (ph as i32 - slot.phase).rem_euclid(8);
                        let delta = if delta > 4 { delta - 8 } else { delta };
                        if (1..=2).contains(&delta.abs()) {
                            // About 1 ms per half step is as fast as the rotor follows.
                            if now_s - slot.last_step < 0.0008 * delta.abs() as f64 {
                                slot.stalled = true;
                            } else {
                                slot.angle =
                                    (slot.angle + delta as f64 * 360.0 / 4096.0).rem_euclid(360.0);
                            }
                            slot.last_step = now_s;
                        }
                        slot.phase = ph as i32;
                    }
                }
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
        // A display held in reset forgets everything.
        for part in &self.spi_parts {
            if let (Some(res), Some(Device::Oled(o))) = (part.res, self.devices.get_mut(&part.id)) {
                if sol.v[res] < 0.3 * VDD {
                    **o = Ssd1306::new(o.address);
                }
            }
        }
        self.drives = Some(drives.to_vec());
        self.observe_lines(now_s, &sol);
        self.observe_matrices(&sol);
        self.observe_relays(now_s, &sol);
        self.observe_shift_registers(&sol);
        self.observe_tm1637(now_s, &sol);
        self.observe_pirs(now_s, &sol);
        self.observe_motors(now_s, &sol);
        // A module that powered up or down, a register that latched, a
        // chip that acknowledged: its outputs differ from what was solved
        // with, so solve again with them (the MCU sees the result now).
        let powered = self.observe_uart_parts(&sol);
        if (powered || self.device_key(now_s) != key[mcu..]) && self.depth < 8 {
            self.depth += 1;
            self.update_inner(time, &key[..mcu]);
            self.depth -= 1;
        } else {
            // Settled: the motors get the currents this circuit gives them,
            // and the voltages and inputs that their back-EMF moves follow.
            self.apply_motor_networks(now_s);
            self.refresh_windings(time, now_s, true);
        }
    }

    /// The windings' inputs (back-EMF, a chopper's current) at `time`, and
    /// what they move: the probed voltages and (`inputs`) the MCU's input
    /// levels.
    fn refresh_windings(&mut self, time: Cycles, now_s: f64, inputs: bool) {
        let Some(sol) = self.current.clone() else {
            return;
        };
        if !self.windings.is_empty() {
            for part in &self.stepper_parts {
                if let Some(m) = self.steppers.get_mut(&part.id) {
                    // (A chopper's current ramps between updates.)
                    m.advance(now_s);
                    let e = m.emf_at(now_s);
                    for k in 0..2 {
                        let j = part.inputs[k];
                        self.x[j] = if self.winding_cs[j] {
                            m.current[k] * STEPPER_RATED
                        } else {
                            e[k]
                        };
                    }
                }
            }
            for part in &self.bldc_parts {
                if let Some(Device::Bldc(b)) = self.devices.get(&part.id) {
                    let e = b.emf_at(now_s);
                    for k in 0..3 {
                        self.x[part.inputs[k]] = e[k];
                    }
                }
            }
            self.x_time = time;
        }
        if inputs {
            let mut changed = self.inputs_now.len() != sol.inputs.len();
            self.inputs_now.resize(sol.inputs.len(), None);
            for (i, (now, &solved)) in self.inputs_now.iter_mut().zip(&sol.inputs).enumerate() {
                let node = self.mcu[i].1;
                let level = if sol.sens_node[node] && sol.driven[node] {
                    let mut v = sol.v[node];
                    for (c, x) in sol.sens.iter().zip(&self.x) {
                        v += c[node] * x;
                    }
                    Some(v > VDD / 2.0)
                } else {
                    solved
                };
                if *now != level {
                    *now = level;
                    changed = true;
                }
            }
            self.inputs_changed |= changed;
        }
        if !self.voltage_probes.is_empty() {
            self.log_voltages(time);
            let moving = self.x.iter().any(|x| x.abs() > 1e-6);
            self.emf_probe_live = moving
                && self.voltage_probes.iter().any(|n| {
                    self.pin_nodes
                        .get(&self.canonical(&self.probe_pin(n)))
                        .is_some_and(|&node| sol.sens_node[node])
                });
        } else {
            self.emf_probe_live = false;
        }
    }

    /// Bring the windings' inputs up to `time` without a new solve (before
    /// the ADC samples a pin).
    pub fn refresh(&mut self, time: Cycles) {
        if !self.windings.is_empty() {
            let now_s = self.seconds_at(time);
            self.refresh_windings(time, now_s, false);
        }
    }

    /// A node's voltage in a solution with the windings' inputs as now.
    fn v_eff(&self, sol: &Solution, node: usize) -> f64 {
        let mut v = sol.v[node];
        if sol.sens_node.get(node) == Some(&true) {
            for (c, x) in sol.sens.iter().zip(&self.x) {
                v += c[node] * x;
            }
        }
        v
    }

    /// The 3-phase bridges' outputs from what their inputs did: the
    /// switches as they are now (the output switches of the solve) and,
    /// PWM averaged, what the motors get (`phase_out`).
    fn drive_phases(&mut self, now: f64) {
        for part in &self.phase_bridges {
            let Some(st) = self.phase_state.get(&part.id) else {
                continue;
            };
            let powered = st.supply >= PHASE_BRIDGE_VMIN;
            let out = if powered {
                st.drive(now)
            } else {
                [PhaseDrive::Float; 3]
            };
            for k in 0..3 {
                self.legs[part.legs + k] = match st.leg(k, now) {
                    Some(true) if powered => Drive::High,
                    Some(false) if powered => Drive::Low,
                    _ => Drive::Float,
                };
            }
            self.phase_out.insert(part.id.clone(), (out, st.supply));
        }
    }

    /// The 3-phase bridges' output switches for new MCU pin drives, before
    /// solving: an input on an MCU pin driven high or low is at that level
    /// (else it is left as it was). Saves solving twice at every PWM edge;
    /// if this is wrong, the bridge's outputs change once the inputs are
    /// seen and the circuit is solved again.
    fn predict_phase_legs(&mut self, drives: &[Drive], now: f64) {
        let level = |node: usize| {
            let i = self.mcu.iter().position(|&(_, n)| n == node)?;
            match drives.get(i) {
                Some(Drive::High) => Some(true),
                Some(Drive::Low) => Some(false),
                _ => None,
            }
        };
        for part in &self.phase_bridges {
            let Some(st) = self.phase_state.get(&part.id) else {
                continue;
            };
            if st.supply < PHASE_BRIDGE_VMIN {
                continue;
            }
            for k in 0..3 {
                if let (Some(h), Some(l)) = (level(part.inh[k]), level(part.inl[k])) {
                    self.legs[part.legs + k] = match st.leg_for(k, h, l, now) {
                        Some(true) => Drive::High,
                        Some(false) => Drive::Low,
                        None => Drive::Float,
                    };
                }
            }
        }
    }

    /// A bridge input stopped switching (no edge for a PWM period): the
    /// phase follows its static level from now on. Returns whether one did.
    fn phase_bridges_due(&mut self, now: f64) -> bool {
        let due = self
            .phase_state
            .values()
            .any(|st| st.next_change().is_some_and(|t| t <= now + 1e-9));
        if !due {
            return false;
        }
        for st in self.phase_state.values_mut() {
            let levels = st.levels();
            st.inputs(now, levels);
        }
        self.drive_phases(now);
        true
    }

    /// Hand each motor the currents the circuit gives its windings (M28):
    /// `a + B·emf` from the solution of the present key, with each chopping
    /// 3-phase bridge output averaged over its PWM (the solutions with it
    /// on and off, weighted by the duty). Coils behind an A4988 that is on
    /// keep the driver's regulated current.
    fn apply_motor_networks(&mut self, now: f64) {
        let nw = self.windings.len();
        if nw == 0 {
            return;
        }
        let mut mech = std::mem::take(&mut self.mech);
        mech.clear();
        match &self.drives {
            Some(key) => mech.extend_from_slice(key),
            None => return,
        }
        let base = self.leg_base();
        let mut duties: Vec<(usize, f64)> = Vec::new();
        for part in &self.phase_bridges {
            let Some((out, _)) = self.phase_out.get(&part.id) else {
                continue;
            };
            for (k, o) in out.iter().enumerate() {
                let i = base + part.legs + k;
                mech[i] = match *o {
                    PhaseDrive::High => Drive::High,
                    PhaseDrive::Low => Drive::Low,
                    PhaseDrive::Float => Drive::Float,
                    PhaseDrive::Duty(d) => {
                        let f = d as f64 / 1000.0;
                        if duties.len() < MAX_DUTY_LEGS {
                            duties.push((i, f));
                        }
                        if f >= 0.5 {
                            Drive::High
                        } else {
                            Drive::Low
                        }
                    }
                };
            }
        }
        // Nothing new for the motors: the same key but for MCU pins whose
        // nets the windings do not reach (the network is reciprocal: a
        // pin the back-EMF does not move cannot move a winding current) —
        // say a PWM edge on a bridge input.
        if duties == self.duties_last && mech.len() == self.mech_last.len() {
            let sol = self.current.clone();
            let n_mcu = self.mcu.len();
            let same = mech
                .iter()
                .zip(&self.mech_last)
                .enumerate()
                .all(|(i, (x, y))| {
                    x == y
                        || (i < n_mcu && sol.as_ref().is_some_and(|s| !s.sens_node[self.mcu[i].1]))
                });
            if !same {
                self.mech_last.clear();
            }
        } else {
            self.mech_last.clear();
        }
        if self.mech_last.is_empty() || self.net_last.0.len() != nw {
            self.mech_last.clone_from(&mech);
            self.duties_last.clone_from(&duties);
            let mut a = vec![0.0; nw];
            let mut b = vec![0.0; nw * nw];
            for combo in 0..1usize << duties.len() {
                let mut w = 1.0;
                for (bit, &(i, f)) in duties.iter().enumerate() {
                    let on = combo >> bit & 1 == 1;
                    w *= if on { f } else { 1.0 - f };
                    mech[i] = if on { Drive::High } else { Drive::Low };
                }
                if w <= 0.0 {
                    continue;
                }
                let sol = self.solution_for(&mech);
                for (acc, c) in a.iter_mut().zip(&sol.coef_a) {
                    *acc += w * c;
                }
                for (acc, c) in b.iter_mut().zip(&sol.coef_b) {
                    *acc += w * c;
                }
            }
            self.net_last = (a, b);
        }
        let (a, b) = std::mem::take(&mut self.net_last);
        let pwm = !duties.is_empty();
        for part in &self.stepper_parts {
            let Some(m) = self.steppers.get_mut(&part.id) else {
                continue;
            };
            let mut target = [0.0; 2];
            let mut drive = [CoilDrive::Off; 2];
            for k in 0..2 {
                let j = part.inputs[k];
                // Behind a chopper that is on: its regulated current.
                let link = part.links[k].as_ref();
                let chopper = link.and_then(|l| {
                    self.drivers
                        .get(&l.driver)
                        .map(|d| (l.sign * d.out[l.bridge].0, d.out[l.bridge].1))
                });
                if let Some((t, d @ CoilDrive::Chopper { .. })) = chopper {
                    target[k] = t;
                    drive[k] = d;
                    continue;
                }
                // Else what the circuit gives the coil. An open coil lets
                // its current die away through the diodes, except on an
                // L298N whose enable is off (slow decay, so a PWM on the
                // enable averages, as in M21).
                let own = [part.inputs[0], part.inputs[1]];
                let bb = [b[j * nw + own[0]], b[j * nw + own[1]]];
                let open = b[j * nw + j].abs() < 1e-6;
                let l298n_on = link.is_some_and(|l| {
                    self.bridges
                        .get(&l.driver)
                        .is_some_and(|br| br.out[l.bridge].1 != CoilDrive::Off)
                });
                let tau = if open && !l298n_on {
                    crate::tier9::FREEWHEEL_TAU
                } else {
                    crate::tier9::COIL_TAU
                };
                target[k] = a[j] / STEPPER_RATED;
                drive[k] = CoilDrive::Network {
                    b: bb.map(|x| x / STEPPER_RATED),
                    tau,
                };
            }
            m.set_drive(now, target, drive);
        }
        for part in &self.bldc_parts {
            let Some(Device::Bldc(m)) = self.devices.get_mut(&part.id) else {
                continue;
            };
            let ins = part.inputs;
            let na: [f64; 3] = std::array::from_fn(|k| a[ins[k]]);
            let nb: [[f64; 3]; 3] =
                std::array::from_fn(|k| std::array::from_fn(|j| b[ins[k] * nw + ins[j]]));
            m.set_network(now, na, nb, pwm);
        }
        self.net_last = (a, b);
        self.mech = mech;
    }

    /// Relay coils follow their input; the contacts follow the coil after
    /// the mechanical delay (see [`Relay`]).
    fn observe_relays(&mut self, now: f64, sol: &Solution) {
        for part in &self.relay_parts {
            let supply = sol.v[part.vcc] - sol.v[part.gnd];
            let vin = sol.v[part.inp] - sol.v[part.gnd];
            let drive = if part.active_low {
                vin < 1.5
            } else {
                vin > 2.0
            };
            if supply > 1.0 && supply < RELAY_PULL_IN && drive {
                self.warnings.insert(format!(
                    "{}: VCC is {supply:.1} V — the 5 V relay coil needs at least {RELAY_PULL_IN} V to pull in (connect VCC to 5V)",
                    part.id
                ));
            }
            if let Some(Device::Relay(r)) = self.devices.get_mut(&part.id) {
                r.set_coil(now, supply >= RELAY_PULL_IN && drive);
            }
        }
    }

    /// 74HC595s watch SHCP and STCP: bit-banged bits shift in on SHCP
    /// rising edges, the outputs take them on STCP rising edges.
    fn observe_shift_registers(&mut self, sol: &Solution) {
        let high = |n: usize| sol.v[n] > VDD / 2.0;
        // Every chip samples DS as it was before this edge (a chip chained
        // on Q7' takes the bit that left the one before it).
        for part in &self.shift_parts {
            let Some(Device::Shift(x)) = self.devices.get_mut(&part.id) else {
                continue;
            };
            let powered = sol.v[part.vcc] - sol.v[part.gnd] >= HC595_VMIN;
            if !powered {
                *x = Hc595::default();
                continue;
            }
            x.powered = true;
            let (oe_float, mr_float) = (!sol.driven[part.oe], !sol.driven[part.mr]);
            if oe_float {
                self.warnings.insert(format!(
                    "{}: OE is not connected — the outputs are off (high impedance); tie OE to GND to enable them",
                    part.id
                ));
            }
            if mr_float {
                self.warnings.insert(format!(
                    "{}: MR is not connected — the register stays cleared; tie MR to VCC (it is active low)",
                    part.id
                ));
            }
            x.enabled = !oe_float && !high(part.oe);
            let mr = !mr_float && high(part.mr);
            x.pins(high(part.shcp), high(part.stcp), high(part.ds), mr);
        }
    }

    /// TM1637 modules watch CLK and DIO; their warnings are the firmware's.
    fn observe_tm1637(&mut self, now: f64, sol: &Solution) {
        for part in &self.tm_parts {
            let Some(Device::Tm(x)) = self.devices.get_mut(&part.id) else {
                continue;
            };
            if sol.v[part.vcc] - sol.v[part.gnd] < TM1637_VMIN {
                if x.bytes > 0 || x.ack {
                    **x = Tm1637::new();
                }
                continue;
            }
            let high = |n: usize| sol.v[n] > VDD / 2.0;
            x.pins(now, high(part.clk), high(part.dio));
            if let Some(w) = x.warning.take() {
                self.warnings.insert(format!("{}: {w}", part.id));
            }
        }
    }

    /// PIR sensors notice their supply (the warm-up starts at power-up).
    fn observe_pirs(&mut self, now: f64, sol: &Solution) {
        for part in &self.pir_parts {
            let supply = sol.v[part.vcc] - sol.v[part.gnd];
            if supply > 1.0 && supply < PIR_VMIN {
                self.warnings.insert(format!(
                    "{}: VCC is {supply:.1} V — the HC-SR501 needs 4.5–20 V (connect VCC to 5V); it detects nothing",
                    part.id
                ));
            }
            if let Some(Device::Pir(x)) = self.devices.get_mut(&part.id) {
                x.power(now, supply >= PIR_VMIN);
            }
        }
    }

    /// M21: step drivers and L298N bridges take their inputs, the steppers
    /// get the currents of the outputs their coils sit on, ESCs watch
    /// their signal and battery.
    fn observe_motors(&mut self, now: f64, sol: &Solution) {
        let v = |n: usize| sol.v[n];
        for part in &self.driver_parts {
            let Some(d) = self.drivers.get_mut(&part.id) else {
                continue;
            };
            let id = &part.id;
            let name = d.drv.name();
            let rel = |n: usize| v(n) - v(part.gnd);
            let vdd = rel(part.vdd);
            let vmot = rel(part.vmot);
            d.vmot = vmot;
            // The DRV8825 makes its logic supply from VMOT.
            let logic = if d.drv.drv8825 {
                vmot >= VMOT_MIN
            } else {
                vdd >= DRIVER_VDD_MIN
            };
            let vih = if d.drv.drv8825 { 2.2 } else { 0.7 * vdd };
            let high = |n: usize| rel(n) > vih;
            let step_v = rel(part.step);
            if logic && !d.drv.drv8825 && step_v > 0.3 * vdd && step_v < vih {
                self.warnings.insert(format!(
                    "{id}: STEP at {step_v:.1} V is not a valid high — with VDD at {vdd:.1} V the {name} needs {vih:.1} V (power VDD from 3V3 when the MCU's outputs are 3.3 V)"
                ));
            }
            let rst_float = !sol.driven[part.rst];
            if rst_float && logic {
                self.warnings.insert(format!(
                    "{id}: RST is not connected — it floats and holds the {name} in reset (no steps); connect RST to SLP (or to VDD)"
                ));
            }
            let reset = rst_float || !high(part.rst);
            let asleep = !high(part.slp);
            let active = logic && !reset && !asleep;
            if !logic {
                d.drv.home();
            }
            let ms = part.ms.map(high);
            let stepped = d.drv.pins(now, high(part.step), high(part.dir), ms, active);
            if let Some(w) = d.drv.warning.take() {
                self.warnings.insert(format!("{id}: {w}"));
            }
            if reset {
                d.drv.home();
            }
            let disabled = high(part.en);
            let powered = vmot >= VMOT_MIN;
            if stepped && !powered {
                self.warnings.insert(format!(
                    "{id}: VMOT is {vmot:.1} V — the {name} needs an 8–35 V motor supply on VMOT (connect a 12 V supply's + to VMOT and its − to GND); the motor does not move"
                ));
            }
            if vmot > if d.drv.drv8825 { 45.0 } else { 35.0 } {
                self.warnings.insert(format!(
                    "{id}: VMOT is {vmot:.1} V, more than the {name}'s maximum"
                ));
            }
            d.state = if !logic {
                if d.drv.drv8825 {
                    "no-vmot"
                } else {
                    "no-vdd"
                }
            } else if reset {
                "reset"
            } else if asleep {
                "sleep"
            } else if disabled {
                "disabled"
            } else if !powered {
                "no-vmot"
            } else {
                "on"
            };
            d.out = if d.state == "on" {
                let c = d.drv.currents();
                [0, 1].map(|k| (c[k] * part.current, CoilDrive::Chopper { vmot }))
            } else {
                [(0.0, CoilDrive::Off); 2]
            };
            // The outputs: each bridge drives its coil one way, VMOT on one
            // side and GND on the other (the chopper's PWM is not modelled;
            // the coil is a current source of the regulated current).
            for k in 0..2 {
                let (a, b) = if d.state != "on" {
                    (Drive::Float, Drive::Float)
                } else if d.out[k].0 >= 0.0 {
                    (Drive::High, Drive::Low)
                } else {
                    (Drive::Low, Drive::High)
                };
                self.legs[part.legs + 2 * k] = a;
                self.legs[part.legs + 2 * k + 1] = b;
            }
        }
        for part in &self.bridge_parts {
            let Some(b) = self.bridges.get_mut(&part.id) else {
                continue;
            };
            let rel = |n: usize| v(n) - v(part.gnd);
            let vs = rel(part.vs);
            // The on-board 78M05 makes 5 V from 7 V up; else 5V is an input.
            b.powered = vs >= 7.0 || rel(part.v5) >= 4.5;
            let high = |n: usize| rel(n) > 2.3;
            let mut out = [(0.0, CoilDrive::Off); 2];
            for (k, o) in out.iter_mut().enumerate() {
                if part.jumpers && self.mcu.iter().any(|&(_, n)| n == part.en[k]) {
                    self.warnings.insert(format!(
                        "{}: the {} jumper is on, so the {} pin is ignored (the bridge is always enabled) — set jumpers off to use it for PWM",
                        part.id,
                        ["ENA", "ENB"][k],
                        ["ENA", "ENB"][k]
                    ));
                }
                let en = part.jumpers || high(part.en[k]);
                let (in1, in2) = (high(part.inp[2 * k]), high(part.inp[2 * k + 1]));
                if b.powered {
                    *o = l298n_bridge(in1, in2, en, vs);
                }
                // The output switches: each output to 12V or GND by its
                // input while enabled, both off otherwise.
                let on = b.powered && en && vs >= 4.5;
                let leg = |x: bool| match (on, x) {
                    (false, _) => Drive::Float,
                    (true, true) => Drive::High,
                    (true, false) => Drive::Low,
                };
                self.legs[part.legs + 2 * k] = leg(in1);
                self.legs[part.legs + 2 * k + 1] = leg(in2);
            }
            // Averaged for the display.
            for k in 0..2 {
                b.acc[k] += b.out[k].0 * (now - b.since).max(0.0);
            }
            b.since = now;
            b.out = out;
        }
        // A coil behind an A4988 that is on is a current source (its
        // regulated current); every other winding is R + back-EMF. The
        // motors themselves are driven once the circuit has settled
        // (`apply_motor_networks`).
        for part in &self.stepper_parts {
            for k in 0..2 {
                let chopper = part.links[k].as_ref().is_some_and(|l| {
                    self.drivers
                        .get(&l.driver)
                        .is_some_and(|d| matches!(d.out[l.bridge].1, CoilDrive::Chopper { .. }))
                });
                self.winding_cs[part.inputs[k]] = chopper;
            }
            if let Some(m) = self.steppers.get_mut(&part.id) {
                stepper_warnings(&part.id, m, &mut self.warnings);
            }
        }
        for part in &self.phase_bridges {
            let rel = |n: usize| v(n) - v(part.gnd);
            let high = |n: usize| rel(n) > 2.0;
            let Some(st) = self.phase_state.get_mut(&part.id) else {
                continue;
            };
            st.supply = rel(part.pvdd);
            let levels = std::array::from_fn(|k| (high(part.inh[k]), high(part.inl[k])));
            let shoot = st.inputs(now, levels);
            shoot_through_warnings(&part.id, shoot, &mut self.warnings);
        }
        for part in &self.bldc_parts {
            if let Some(Device::Bldc(b)) = self.devices.get_mut(&part.id) {
                b.powered = v(part.vcc) - v(part.gnd) >= HALL_VMIN;
            }
        }
        self.drive_phases(now);
        for part in &self.bldc_parts {
            let Some(Device::Bldc(b)) = self.devices.get_mut(&part.id) else {
                continue;
            };
            hall_pull_ups(part, b, now, sol, &self.mcu, &mut self.warnings);
            bldc_warnings(&part.id, b, &mut self.warnings);
        }
        for part in &self.esc_parts {
            let Some((e, last)) = self.escs.get_mut(&part.id) else {
                continue;
            };
            e.power(now, v(part.bat) - v(part.gnd));
            let high = v(part.sig) - v(part.gnd) > 1.5;
            if last.is_some() && *last != Some(high) {
                e.edge(now, high);
            }
            *last = Some(high);
            if let Some(w) = e.warning.take() {
                self.warnings.insert(format!("{}: {w}", part.id));
            }
        }
    }

    /// NeoPixels pass what went past their own LEDs to the part on their
    /// DOUT, down the chain.
    fn forward_pixels(&mut self, id: &str) {
        let mut queue = vec![id.to_string()];
        let mut seen: BTreeSet<String> = queue.iter().cloned().collect();
        while let Some(id) = queue.pop() {
            let bits = match self.devices.get_mut(&id) {
                Some(Device::Pixels(n)) if !n.spill.is_empty() => std::mem::take(&mut n.spill),
                _ => continue,
            };
            let Some(&(_, _, dout)) = self.pixel_parts.iter().find(|p| p.0 == id) else {
                continue;
            };
            let next: Vec<String> = self
                .pixel_parts
                .iter()
                .filter(|p| p.1 == dout && !seen.contains(&p.0))
                .map(|p| p.0.clone())
                .collect();
            for next in next {
                let powered = self.wire_parts.iter().any(|w| {
                    w.id == next && self.node_voltage(w.vcc) - self.node_voltage(w.gnd) >= w.vmin
                });
                if let (true, Some(Device::Pixels(m))) = (powered, self.devices.get_mut(&next)) {
                    m.receive(bits.clone());
                    seen.insert(next.clone());
                    queue.push(next);
                }
            }
        }
    }

    /// UART modules notice their supply (and, at power-up, EN). Returns
    /// whether one powered up or down.
    fn observe_uart_parts(&mut self, sol: &Solution) -> bool {
        let mut changed = false;
        for part in &self.uart_parts {
            let on = sol.v[part.vcc] - sol.v[part.gnd] >= HC05_VMIN;
            let en = sol.v[part.en] - sol.v[part.gnd] > 2.0;
            if let Some(Device::Bluetooth(b)) = self.devices.get_mut(&part.id) {
                changed |= b.powered != on;
                b.power(on, en);
            }
        }
        changed
    }

    /// Where each UART module's RXD and TXD go (MCU pins on those nets).
    pub fn uart_links(&self) -> Vec<UartLink> {
        let on = |node: usize| -> Vec<(u8, u8)> {
            self.mcu
                .iter()
                .filter(|&&(_, n)| n == node)
                .map(|&(p, _)| p)
                .collect()
        };
        self.uart_parts
            .iter()
            .map(|u| UartLink {
                id: u.id.clone(),
                rxd: on(u.rxd),
                txd: on(u.txd),
            })
            .collect()
    }

    /// Contact changes of relay `id` so far (bounces included).
    pub fn relay_clicks(&self, id: &str) -> u32 {
        match self.devices.get(id) {
            Some(Device::Relay(r)) => r.clicks,
            _ => 0,
        }
    }

    /// The HC-05 module of part `id`.
    pub fn hc05(&mut self, id: &str) -> Option<&mut Hc05> {
        match self.devices.get_mut(id) {
            Some(Device::Bluetooth(b)) => Some(b),
            _ => None,
        }
    }

    /// Close the display frame at `time`; `seconds` is its simulated length.
    pub fn end_frame(&mut self, time: Cycles, seconds: f64) -> Vec<PartVisual> {
        self.integrate(time);
        self.refresh(time);
        let mut spilled = Vec::new();
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
                VisualKind::Stepper => {
                    if std::mem::take(&mut slot.stalled) {
                        self.warnings.insert(format!(
                            "{}: steps faster than the motor can follow (< 0.8 ms per half step) — it stalls",
                            slot.id
                        ));
                    }
                    v.unpowered = avg.get(4).copied().unwrap_or(0.0) < 0.5;
                    v.brightness = avg[..4].to_vec();
                    v.angle = Some(slot.angle);
                }
                VisualKind::Motion => {
                    let now = self.clock.1 + (time as f64 - self.clock.0 as f64) / self.clock.2;
                    if let Some(m) = self.steppers.get_mut(&slot.id) {
                        m.advance(now);
                        stepper_warnings(&slot.id, m, &mut self.warnings);
                        // Speed over the frame (prev_angle holds the rotor
                        // angle at the last frame).
                        if seconds > 0.0 && span > 0.0 {
                            slot.rpm =
                                (m.theta - slot.prev_angle) / std::f64::consts::TAU / seconds
                                    * 60.0;
                        }
                        slot.prev_angle = m.theta;
                        v.angle = Some(m.degrees());
                        v.rpm = Some(slot.rpm);
                        v.motor = Some(MotorView {
                            steps: (m.steps() * 100.0).round() / 100.0,
                            lost: m.lost(),
                            coils: m.current.to_vec(),
                            stalled: m.stalled(now),
                            ..Default::default()
                        });
                    } else if let Some(d) = self.drivers.get(&slot.id) {
                        v.unpowered = matches!(d.state, "no-vmot" | "no-vdd");
                        v.text = Some(format!("1/{}", d.drv.div));
                        v.motor = Some(MotorView {
                            steps: d.drv.steps as f64,
                            coils: d.out.iter().map(|o| o.0).collect(),
                            state: d.state.into(),
                            micro: d.drv.div,
                            ..Default::default()
                        });
                    } else if let Some(b) = self.bridges.get_mut(&slot.id) {
                        for k in 0..2 {
                            b.acc[k] += b.out[k].0 * (now - b.since).max(0.0);
                        }
                        b.since = now;
                        let len = now - b.frame_start;
                        let coils = (0..2)
                            .map(|k| {
                                if len > 0.0 {
                                    b.acc[k] / len
                                } else {
                                    b.out[k].0
                                }
                            })
                            .collect();
                        b.acc = [0.0; 2];
                        b.frame_start = now;
                        v.unpowered = !b.powered;
                        v.motor = Some(MotorView {
                            coils,
                            state: if b.powered { "on" } else { "no-power" }.into(),
                            ..Default::default()
                        });
                    } else if let Some(Device::Bldc(b)) = self.devices.get_mut(&slot.id) {
                        b.advance(now);
                        bldc_warnings(&slot.id, b, &mut self.warnings);
                        let part = self.bldc_parts.iter().find(|p| p.id == slot.id);
                        if let (Some(part), Some(sol)) = (part, &cur) {
                            hall_pull_ups(part, b, now, sol, &self.mcu, &mut self.warnings);
                        }
                        v.angle = Some(b.degrees());
                        v.rpm = Some(b.rpm());
                        let on = b.powered || b.sensorless;
                        v.unpowered = !on;
                        let h = b.hall();
                        if !b.sensorless {
                            v.text = Some(format!("{}{}{}", h & 1, h >> 1 & 1, h >> 2 & 1));
                        }
                        v.motor = Some(MotorView {
                            coils: b.current.iter().map(|i| i / 6.0).collect(),
                            stalled: b.stalled,
                            state: if on { "on" } else { "off" }.into(),
                            ..Default::default()
                        });
                    } else if let Some((out, supply)) = self.phase_out.get(&slot.id) {
                        v.unpowered = *supply < PHASE_BRIDGE_VMIN;
                        let (duty, shoot) = match self.phase_state.get_mut(&slot.id) {
                            Some(st) => {
                                let levels = st.levels();
                                let sh = st.inputs(now, levels);
                                shoot_through_warnings(&slot.id, sh, &mut self.warnings);
                                st.end_frame(now)
                            }
                            None => (Vec::new(), false),
                        };
                        v.motor = Some(MotorView {
                            coils: out
                                .iter()
                                .map(|d| match d {
                                    PhaseDrive::High => 1.0,
                                    PhaseDrive::Low => -1.0,
                                    PhaseDrive::Float => 0.0,
                                    // Chopped: the switched (high) side.
                                    PhaseDrive::Duty(_) => 1.0,
                                })
                                .collect(),
                            state: if v.unpowered { "no-power" } else { "on" }.into(),
                            duty,
                            shoot_through: shoot,
                            ..Default::default()
                        });
                    } else if let Some((e, _)) = self.escs.get_mut(&slot.id) {
                        e.advance(now);
                        if let Some(w) = e.warning.take() {
                            self.warnings.insert(format!("{}: {w}", slot.id));
                        }
                        v.angle = Some(e.angle);
                        v.rpm = Some(e.rpm);
                        v.unpowered = e.state == EscState::Off;
                        v.motor = Some(MotorView {
                            state: e.state.name().into(),
                            throttle: e.throttle,
                            beeps: e.beeps,
                            stalled: e.state == EscState::Armed
                                && e.throttle > 0.05
                                && e.load >= 0.95,
                            ..Default::default()
                        });
                    }
                }
                VisualKind::Sensor => {
                    v.unpowered = avg.first().copied().unwrap_or(0.0) < 0.5;
                    let powered_now = cur
                        .as_ref()
                        .is_some_and(|s| s.level[i].first() > Some(&0.5));
                    match self.devices.get_mut(&slot.id) {
                        Some(Device::Oled(o)) => {
                            // Without power the controller forgets everything.
                            if !powered_now {
                                **o = Ssd1306::new(o.address);
                            }
                            if o.lit() {
                                v.screen = Some(crate::devices::base64(&o.screen()));
                            }
                        }
                        Some(Device::Rtc(r)) => {
                            let t =
                                self.clock.1 + (time as f64 - self.clock.0 as f64) / self.clock.2;
                            v.text = Some(r.display(t));
                        }
                        Some(Device::Aht(a)) if !powered_now => *a = Aht20::new(a.temp, a.humidity),
                        Some(Device::Imu(m)) if !powered_now && !m.asleep() => {
                            let mut fresh = Mpu6050::new(m.address);
                            (fresh.roll, fresh.pitch) = (m.roll, m.pitch);
                            (fresh.gyro, fresh.temp) = (m.gyro, m.temp);
                            **m = fresh;
                        }
                        Some(Device::Matrix(m)) => {
                            v.matrix = Some(MatrixView {
                                rows: (0..m.count).flat_map(|i| m.rows(i)).collect(),
                                intensity: (0..m.count).map(|i| m.intensity(i)).collect(),
                            });
                        }
                        Some(Device::Ir(r)) => {
                            v.text = r.last.map(|(cmd, repeat)| {
                                format!("0x{cmd:02X}{}", if repeat { " ⟳" } else { "" })
                            });
                            v.on = Some(if r.low || r.next().is_some() {
                                1.0
                            } else {
                                0.0
                            });
                        }
                        Some(Device::Lcd(l)) => {
                            if !powered_now {
                                **l = CharLcd::new(l.address);
                            }
                            v.lcd = Some(LcdView {
                                rows: l.rows(),
                                cgram: l.cgram.to_vec(),
                                backlight: powered_now && l.backlight(),
                                cursor: l.cursor_at(),
                                blink: l.blink,
                            });
                        }
                        Some(Device::Thermo(d)) => v.text = Some(d.rom_text()),
                        Some(Device::Relay(r)) => {
                            // The module's LED shows the coil.
                            v.on = Some(if r.coil && powered_now { 1.0 } else { 0.0 });
                            v.closed = Some(r.closed);
                        }
                        Some(Device::Bluetooth(b)) => {
                            v.text = Some(
                                if !b.powered {
                                    "off"
                                } else if b.at_mode {
                                    "at"
                                } else if b.connected {
                                    "connected"
                                } else {
                                    "waiting"
                                }
                                .into(),
                            );
                        }
                        Some(Device::Encoder(e)) => {
                            v.angle = Some((e.position.rem_euclid(20) * 18) as f64)
                        }
                        Some(Device::Pixels(n)) => {
                            if powered_now {
                                n.settle(
                                    self.clock.1
                                        + (time as f64 - self.clock.0 as f64) / self.clock.2,
                                );
                            } else {
                                *n = NeoPixel::new(n.leds.len());
                            }
                            if !n.spill.is_empty() {
                                spilled.push(slot.id.clone());
                            }
                            v.leds = n.leds.clone();
                        }
                        Some(Device::Shift(x)) => {
                            v.register = Some(ShiftView {
                                shift: x.shift,
                                latch: x.latch,
                                enabled: x.enabled,
                            });
                        }
                        Some(Device::Tm(x)) => {
                            v.digits = Some(DigitsView {
                                segments: x.ram[..4].to_vec(),
                                brightness: x.brightness(),
                                on: powered_now && x.on(),
                            });
                        }
                        Some(Device::Pir(x)) => {
                            let t =
                                self.clock.1 + (time as f64 - self.clock.0 as f64) / self.clock.2;
                            x.advance(t);
                            v.on = Some(if x.out { 1.0 } else { 0.0 });
                            v.text = Some(
                                if !x.powered() {
                                    "off"
                                } else if x.out {
                                    "high"
                                } else if x.warming(t) {
                                    "warmup"
                                } else if x.blocked(t) {
                                    "block"
                                } else {
                                    "ready"
                                }
                                .into(),
                            );
                        }
                        Some(Device::Baro(b)) => {
                            // Without its supply it forgets everything but
                            // its address and what it measures.
                            if !powered_now {
                                **b = Bmp280::new(b.address, b.temp, b.pressure);
                            }
                            v.text = Some(
                                match b.ctrl_meas & 3 {
                                    0 => "sleep",
                                    3 => "normal",
                                    _ => "forced",
                                }
                                .into(),
                            );
                        }
                        Some(Device::Sd(sd)) => {
                            if !powered_now {
                                sd.power_cycle();
                            }
                            // The activity LED.
                            let busy = sd.reads + sd.writes > 0;
                            v.on = Some(if busy { 1.0 } else { 0.0 });
                            sd.reads = 0;
                            sd.writes = 0;
                            v.generation = Some(sd.generation);
                        }
                        _ => {}
                    }
                }
            }
            slot.acc.iter_mut().for_each(|a| *a = 0.0);
            // The next frame starts in the present operating point.
            slot.overcurrent = cur.as_ref().is_some_and(|s| s.over[i]);
            slot.rises = 0;
            out.push(v);
        }
        self.frame_start = time;
        if !spilled.is_empty() {
            for id in spilled {
                self.forward_pixels(&id);
            }
            // The chained parts show what they took now, not next frame.
            for v in &mut out {
                if let Some(Device::Pixels(n)) = self.devices.get(&v.id) {
                    v.leds = n.leds.clone();
                }
            }
        }
        out
    }

    /// Single-wire devices watch their data line: a DHT notices the host's
    /// start signal, a NeoPixel chain decodes pulses.
    fn observe_lines(&mut self, now: f64, sol: &Solution) {
        let mut latched = Vec::new();
        for part in &self.wire_parts {
            let powered = sol.v[part.vcc] - sol.v[part.gnd] >= part.vmin;
            let high = sol.v[part.data] > VDD / 2.0;
            let last = self.line_levels.insert(part.id.clone(), high);
            // The first level seen is a state, not an edge.
            if last.is_none() || last == Some(high) || !powered {
                continue;
            }
            match self.devices.get_mut(&part.id) {
                Some(Device::Dht(d)) => {
                    d.observe(now, high);
                    if let Some(w) = d.short_start.take() {
                        let need = if d.dht22 {
                            "1 ms (DHT22)"
                        } else {
                            "18 ms (DHT11)"
                        };
                        self.warnings.insert(format!(
                            "{}: start signal held low {:.2} ms — the sensor needs at least {need}",
                            part.id,
                            w * 1e3
                        ));
                    }
                }
                Some(Device::Sonar(x)) => {
                    x.trig(now, high);
                    if let Some(w) = x.short_trigger.take() {
                        self.warnings.insert(format!(
                            "{}: TRIG pulse of {:.1} µs is shorter than the 10 µs the sensor needs",
                            part.id,
                            w * 1e6
                        ));
                    }
                }
                Some(Device::Thermo(d)) => {
                    // Its own pulls are not the host's slots.
                    if !d.pulling {
                        d.observe(now, high);
                    }
                }
                Some(Device::Pixels(n)) => {
                    n.edge(now, high);
                    if let Some(w) = n.bad_pulse.take() {
                        self.warnings.insert(format!(
                            "{}: a {w:.2} µs high pulse is neither a 0 (0.4 µs) nor a 1 (0.8 µs) — check the timer period and duty values",
                            part.id
                        ));
                    }
                    if !n.spill.is_empty() {
                        latched.push(part.id.clone());
                    }
                }
                _ => {}
            }
        }
        for id in latched {
            self.forward_pixels(&id);
        }
    }

    /// LED matrix drivers watch CLK and CS: bit-banged frames shift in on
    /// CLK rising edges, and every frame (SPI too) is taken when CS rises.
    fn observe_matrices(&mut self, sol: &Solution) {
        for part in &self.matrix_parts {
            let Some(Device::Matrix(m)) = self.devices.get_mut(&part.id) else {
                continue;
            };
            if sol.v[part.vcc] - sol.v[part.gnd] < part.vmin {
                if m.latches > 0 || m.regs != [[0; 16]; 4] {
                    *m = Max7219::new(m.count);
                }
                continue;
            }
            let high = |n: usize| sol.v[n] > VDD / 2.0;
            m.pins(high(part.clk), high(part.cs), high(part.din));
        }
    }

    /// When a device next changes a line by itself (a DHT's reply), in
    /// core cycles.
    pub fn next_event(&self) -> Option<Cycles> {
        let (c, s, hz) = self.clock;
        self.dev_outputs
            .iter()
            .map(|(id, _, _)| id)
            .chain(self.relay_parts.iter().map(|r| &r.id))
            .filter_map(|id| self.devices.get(id).and_then(|d| d.next_change()))
            .chain(self.phase_state.values().filter_map(|b| b.next_change()))
            .map(|t| c + ((t - s) * hz).ceil().max(0.0) as Cycles)
            // A probed net that a turning motor's back-EMF moves.
            .chain(
                self.emf_probe_live
                    .then(|| self.x_time + (EMF_PROBE_INTERVAL * hz).ceil() as Cycles),
            )
            .min()
    }

    /// Turn a rotary encoder by `detents` (negative: counter-clockwise),
    /// from `time` on. Returns whether the part exists.
    pub fn rotate(&mut self, part: &str, detents: i32, time: Cycles) -> bool {
        let now = self.seconds_at(time);
        match self.devices.get_mut(part) {
            Some(Device::Encoder(e)) => {
                e.rotate(now, detents);
                true
            }
            _ => false,
        }
    }

    /// The time base: `cycle` is `seconds` of simulated time and the core
    /// runs at `hz` from there.
    pub fn set_clock(&mut self, cycle: Cycles, seconds: f64, hz: f64) {
        self.clock = (cycle, seconds, hz.max(1.0));
    }

    /// The real time (Unix seconds) clock chips placed from now on start at.
    pub fn set_wall_clock(&mut self, unix: f64) {
        self.wall_clock = unix;
    }

    fn seconds_at(&self, t: Cycles) -> f64 {
        let (c, s, hz) = self.clock;
        s + (t as f64 - c as f64) / hz
    }

    /// A node's voltage now: the operating point with the windings'
    /// back-EMF as last brought up to date.
    fn node_voltage(&self, node: usize) -> f64 {
        self.current.as_ref().map_or(0.0, |s| self.v_eff(s, node))
    }

    fn mcu_node(&self, pin: (u8, u8)) -> Option<usize> {
        self.mcu.iter().find(|(p, _)| *p == pin).map(|&(_, n)| n)
    }

    /// I2C START (or repeated START) with `addr` on the bus whose lines are
    /// the MCU pins `scl` and `sda`. Returns whether a device acknowledged.
    pub fn i2c_start(
        &mut self,
        time: Cycles,
        scl: (u8, u8),
        sda: (u8, u8),
        addr: u8,
        read: bool,
    ) -> bool {
        self.i2c_active.remove(&scl);
        let (Some(cn), Some(dn)) = (self.mcu_node(scl), self.mcu_node(sda)) else {
            return false;
        };
        let name = |(port, pin): (u8, u8)| format!("P{}{}", (b'A' + port) as char, pin);
        for (line, n) in [(scl, cn), (sda, dn)] {
            if self.node_voltage(n) < I2C_HIGH {
                let which = if line == scl { "SCL" } else { "SDA" };
                self.warnings.insert(format!(
                    "I2C {which} ({}) is not pulled up: the line stays low (power the module or add a pull-up resistor)",
                    name(line)
                ));
                return false;
            }
        }
        if self
            .bus_parts
            .iter()
            .any(|b| b.scl == dn && b.sda == cn && b.scl != b.sda)
        {
            self.warnings.insert(format!(
                "I2C: SCL and SDA are swapped on a module ({} / {})",
                name(scl),
                name(sda)
            ));
        }
        let now = self.seconds_at(time);
        let target = self
            .bus_parts
            .iter()
            .filter(|b| b.scl == cn && b.sda == dn)
            .filter(|b| self.node_voltage(b.vcc) - self.node_voltage(b.gnd) >= MODULE_VMIN)
            .map(|b| b.id.clone())
            .find(|id| self.devices.get(id).is_some_and(|d| d.address() == addr));
        let Some(id) = target else {
            return false;
        };
        if let Some(d) = self.devices.get_mut(&id) {
            if let Some(i) = d.i2c() {
                i.start(read, now);
            }
        }
        self.i2c_active.insert(scl, id);
        true
    }

    fn i2c_device(&mut self, scl: (u8, u8)) -> Option<&mut Device> {
        let id = self.i2c_active.get(&scl)?;
        self.devices.get_mut(id)
    }

    /// A byte from the controller to the addressed device; returns the ACK.
    pub fn i2c_write(&mut self, time: Cycles, scl: (u8, u8), byte: u8) -> bool {
        let now = self.seconds_at(time);
        self.i2c_device(scl)
            .and_then(|d| d.i2c())
            .is_some_and(|d| d.write(byte, now))
    }

    /// A byte from the addressed device (0xFF: nobody drives SDA).
    pub fn i2c_read(&mut self, time: Cycles, scl: (u8, u8)) -> u8 {
        let now = self.seconds_at(time);
        self.i2c_device(scl)
            .and_then(|d| d.i2c())
            .map_or(0xFF, |d| d.read(now))
    }

    /// STOP: the transfer ends.
    pub fn i2c_stop(&mut self, time: Cycles, scl: (u8, u8)) {
        let now = self.seconds_at(time);
        if let Some(d) = self.i2c_device(scl).and_then(|d| d.i2c()) {
            d.stop(now);
        }
        // What the transfer did wrong (a BMP280 read in sleep mode).
        if let Some(id) = self.i2c_active.remove(&scl) {
            if let Some(Device::Baro(b)) = self.devices.get_mut(&id) {
                if let Some(w) = b.warning.take() {
                    self.warnings.insert(format!("{id}: {w}"));
                }
            }
        }
    }

    /// One byte on the SPI bus whose SCK and MOSI are the MCU pins `sck` and
    /// `mosi`: every powered device selected by a low CS takes it; the
    /// byte the one on `miso` returns comes back (0xFF: nobody drives it).
    pub fn spi(
        &mut self,
        time: Cycles,
        sck: (u8, u8),
        mosi: (u8, u8),
        miso: Option<(u8, u8)>,
        out: u8,
    ) -> u8 {
        let (Some(kn), Some(mn)) = (self.mcu_node(sck), self.mcu_node(mosi)) else {
            return 0xFF;
        };
        let miso_n = miso.and_then(|p| self.mcu_node(p));
        let name = |(port, pin): (u8, u8)| format!("P{}{}", (b'A' + port) as char, pin);
        let mut reply = 0xFF;
        let mut drivers = Vec::new();
        // Bits that left a matrix on DOUT during this byte, by part.
        let mut overflow = Vec::new();
        for i in 0..self.spi_parts.len() {
            let part = self.spi_parts[i].clone();
            if part.sck == mn && part.mosi == kn {
                self.warnings.insert(format!(
                    "SPI: SCK and MOSI are swapped on {} ({} / {})",
                    part.id,
                    name(sck),
                    name(mosi)
                ));
            }
            if part.sck != kn || part.mosi != mn {
                continue;
            }
            let v = |n: usize| self.node_voltage(n);
            if v(part.vcc) - v(part.gnd) < part.vmin || v(part.cs) >= 0.3 * VDD {
                continue;
            }
            let dc_high = part.dc.is_some_and(|n| v(n) >= 0.5 * VDD);
            match self.devices.get_mut(&part.id) {
                Some(Device::Oled(o)) => {
                    if dc_high {
                        o.data(out);
                    } else {
                        o.command(out);
                    }
                }
                Some(Device::Matrix(m)) => overflow.push((part.id.clone(), m.byte(out))),
                Some(Device::Sd(sd)) => {
                    let r = sd.exchange(out);
                    match (part.miso, miso_n) {
                        (Some(a), Some(b)) if a == b => {
                            reply &= r;
                            drivers.push(part.id.clone());
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        if drivers.len() > 1 {
            self.warnings.insert(format!(
                "SPI: {} are selected at once and both drive MISO",
                drivers.join(" and ")
            ));
        }
        self.forward_matrix_chain(kn, overflow);
        self.spi_shift_registers(kn, mn, out);
        // A 74HC595 whose STCP is on SCK latched: its outputs changed with
        // no pin edge, so solve again with the MCU's pins as they are.
        if let Some(d) = self.drives.clone() {
            let mcu = self.mcu.len();
            self.update_inner(time, &d[..mcu]);
        }
        reply
    }

    /// Hardware SPI into 74HC595s: SCK on SHCP, MOSI on DS (they have no
    /// chip select: every byte goes in). What leaves Q7' goes on, as a
    /// byte, into a chip whose DS is on that Q7' and whose SHCP is SCK.
    fn spi_shift_registers(&mut self, sck: usize, mosi: usize, out: u8) {
        let v = |s: &Self, n: usize| s.node_voltage(n);
        let mut queue: Vec<(usize, u8)> = Vec::new();
        let mut fed = BTreeSet::new();
        for (i, part) in self.shift_parts.iter().enumerate() {
            if part.shcp == sck && part.ds == mosi {
                queue.push((i, out));
            }
        }
        while let Some((i, byte)) = queue.pop() {
            if !fed.insert(i) {
                continue;
            }
            let part = self.shift_parts[i].clone();
            let powered = v(self, part.vcc) - v(self, part.gnd) >= HC595_VMIN;
            let mr = v(self, part.mr) > VDD / 2.0;
            let Some(Device::Shift(x)) = self.devices.get_mut(&part.id) else {
                continue;
            };
            if !powered || !mr {
                continue;
            }
            // STCP on SCK too: each clock edge also latches.
            let spill = if part.stcp == sck {
                x.byte_latching(byte)
            } else {
                x.byte(byte)
            };
            for (j, next) in self.shift_parts.iter().enumerate() {
                if next.ds == part.q7s && next.shcp == sck && !fed.contains(&j) {
                    queue.push((j, spill));
                }
            }
        }
    }

    /// Hardware SPI moves whole bytes without clock edges on the nets, so a
    /// MAX7219 whose DIN is another one's DOUT (and whose CLK is the same
    /// SCK) gets, as one byte, the eight bits that left the module before
    /// it during this byte — and passes its own overflow on down the chain.
    fn forward_matrix_chain(&mut self, sck: usize, mut queue: Vec<(String, u8)>) {
        // Each module once per byte, whatever loops the wiring has.
        let mut fed: BTreeSet<String> = queue.iter().map(|(id, _)| id.clone()).collect();
        while let Some((id, byte)) = queue.pop() {
            let Some(from) = self.matrix_parts.iter().find(|m| m.id == id) else {
                continue;
            };
            let dout = from.dout;
            let next: Vec<MatrixPart> = self
                .matrix_parts
                .iter()
                .filter(|m| m.din == dout && m.clk == sck && !fed.contains(&m.id))
                .cloned()
                .collect();
            for m in next {
                let v = |n: usize| self.node_voltage(n);
                if v(m.vcc) - v(m.gnd) < m.vmin || v(m.cs) >= 0.3 * VDD {
                    continue;
                }
                if let Some(Device::Matrix(d)) = self.devices.get_mut(&m.id) {
                    queue.push((m.id.clone(), d.byte(byte)));
                    fed.insert(m.id);
                }
            }
        }
    }

    /// The SD card in part `id` as a disk image.
    pub fn sd_image(&self, id: &str) -> Option<Vec<u8>> {
        match self.devices.get(id) {
            Some(Device::Sd(sd)) => Some(sd.image()),
            _ => None,
        }
    }

    /// The SD card in part `id` as just its blocks in use
    /// ([`SdCard::sparse`]): what the UI keeps between sessions.
    pub fn sd_snapshot(&self, id: &str) -> Option<Vec<u8>> {
        match self.devices.get(id) {
            Some(Device::Sd(sd)) => Some(sd.sparse()),
            _ => None,
        }
    }

    /// Put back what [`CircuitSim::sd_snapshot`] gave.
    pub fn sd_restore(&mut self, id: &str, snapshot: &[u8]) -> bool {
        match self.devices.get_mut(id) {
            Some(Device::Sd(sd)) => sd.load_sparse(snapshot),
            _ => false,
        }
    }

    /// Erase the SD card in part `id` (all zeros, no file system).
    pub fn sd_wipe(&mut self, id: &str) -> bool {
        match self.devices.get_mut(id) {
            Some(Device::Sd(sd)) => {
                sd.wipe();
                true
            }
            _ => false,
        }
    }

    /// Put a disk image into the SD card of part `id`.
    pub fn sd_load(&mut self, id: &str, image: &[u8]) -> bool {
        match self.devices.get_mut(id) {
            Some(Device::Sd(sd)) => {
                sd.load_image(image);
                true
            }
            _ => false,
        }
    }

    /// Voltage on an MCU pin (port 0 = A) from the present operating point,
    /// if the circuit connects anything to it (for the ADC).
    pub fn mcu_voltage(&self, port: u8, pin: u8) -> Option<f64> {
        let &(_, node) = self.mcu.iter().find(|(p, _)| *p == (port, pin))?;
        Some(self.node_voltage(node))
    }

    /// The pin an analog probe names: `"PA1"` (an MCU pin) or
    /// `"part.pin"` (`"pot.W"`).
    pub fn probe_pin(&self, name: &str) -> PinRef {
        match name.split_once('.') {
            Some((part, pin)) => PinRef::new(part, pin),
            None => PinRef::new(&self.board_id, name),
        }
    }

    /// Log the voltages of these pins (see [`CircuitSim::probe_pin`])
    /// whenever the operating point changes; the present values are logged
    /// at `time` at once. An empty list stops logging.
    pub fn set_voltage_probes(&mut self, names: &[String], time: Cycles) {
        self.voltage_probes = names.to_vec();
        self.voltage_last.clear();
        self.voltage_log.clear();
        if !self.windings.is_empty() {
            // Logs, and notes whether a probe moves with a motor.
            let now_s = self.seconds_at(time);
            self.refresh_windings(time, now_s, false);
        } else if !self.voltage_probes.is_empty() {
            self.log_voltages(time);
        }
    }

    /// Voltages of the probed pins (`None`: the pin is on no net).
    pub fn probe_voltages(&self) -> Vec<Option<f64>> {
        // Resolved each time: the board's id comes with the circuit.
        self.voltage_probes
            .iter()
            .map(|n| self.voltage(&self.probe_pin(n)))
            .collect()
    }

    fn log_voltages(&mut self, time: Cycles) {
        let v = self.probe_voltages();
        if v == self.voltage_last || self.voltage_log.len() >= VOLTAGE_LOG_MAX {
            return;
        }
        self.voltage_last.clone_from(&v);
        self.voltage_log.push((time, v));
    }

    /// The voltages logged since the last call: (time, one per probe) at
    /// each change of the operating point that changed one of them.
    pub fn take_voltage_log(&mut self) -> Vec<(Cycles, Vec<Option<f64>>)> {
        std::mem::take(&mut self.voltage_log)
    }

    /// Voltage of the net a pin is on (for probes), from the present
    /// operating point.
    pub fn voltage(&self, pin: &PinRef) -> Option<f64> {
        let node = *self.pin_nodes.get(&self.canonical(pin))?;
        Some(self.node_voltage(node))
    }
}

/// A prop that means "on": `true`, a non-zero number, or "1"/"true".
/// Hall lines the sensor lets go of must be pulled up (open collector):
/// warn about one that floats for a while (every pin floats for a moment
/// after reset, until the firmware sets it up).
fn hall_pull_ups(
    part: &BldcPart,
    b: &mut HallBldc,
    now: f64,
    sol: &Solution,
    mcu: &[((u8, u8), usize)],
    warnings: &mut BTreeSet<String>,
) {
    if part.sensorless {
        return;
    }
    for (k, &h) in part.halls.iter().enumerate() {
        let floats = b.powered
            && b.hall_output(k).is_none()
            && !sol.driven[h]
            && mcu.iter().any(|&(_, n)| n == h);
        let since = &mut b.float_since[k];
        if !floats {
            *since = None;
        } else if now - *since.get_or_insert(now) > 0.1 {
            warnings.insert(format!(
                "{}: hall output H{} floats when high — the sensors are open collector: enable the pin's pull-up (GPIO_PULLUP) or add 10 kΩ to 3V3",
                part.id,
                ["A", "B", "C"][k]
            ));
        }
    }
}

/// Shoot-through on the phases of a 3-phase bridge.
fn shoot_through_warnings(id: &str, shoot: [bool; 3], warnings: &mut BTreeSet<String>) {
    for (k, _) in shoot.iter().enumerate().filter(|(_, s)| **s) {
        let ph = ["A", "B", "C"][k];
        warnings.insert(format!(
            "{id}: 데드타임 없이 상·하단이 동시에 켜짐(관통 전류) — INH{ph} and INL{ph} were on together (or one turned on less than {:.0} ns after the other turned off): shoot-through shorts the supply; insert dead time (TIM1 BDTR.DTG) and check the CHxN polarity",
            crate::tier9::SWITCH_OFF_TIME * 1e9
        ));
    }
}

/// Report a BLDC that stalled since the last look.
fn bldc_warnings(id: &str, b: &mut HallBldc, warnings: &mut BTreeSet<String>) {
    if !std::mem::take(&mut b.stall_new) {
        return;
    }
    if b.sensorless {
        warnings.insert(format!(
            "{id}: the motor has current but does not turn — the commutation is not in step with the rotor (sensorless: align, then ramp up slowly enough before following the back-EMF zero crossings), or the load is more than its torque"
        ));
    } else {
        warnings.insert(format!(
            "{id}: the motor has current but does not turn — the commutation does not match the hall sensors (check the table and which hall and phase goes where), or the load is more than its torque"
        ));
    }
}

/// Which 3-phase bridge output each BLDC phase sits on. Returns wiring
/// warnings.
fn link_bldcs(motors: &mut [BldcPart], bridges: &[PhaseBridgePart]) -> Vec<String> {
    let mut warnings = Vec::new();
    for m in motors {
        for k in 0..3 {
            m.links[k] = bridges.iter().find_map(|b| {
                b.out
                    .iter()
                    .position(|&o| o == m.phases[k])
                    .map(|o| (b.id.clone(), o))
            });
        }
        let linked = m.links.iter().filter(|l| l.is_some()).count();
        if linked > 0 && linked < 3 {
            warnings.push(format!(
                "{}: only {linked} of the phases U, V, W go to a bridge output — connect all three (OUTA, OUTB, OUTC)",
                m.id
            ));
        }
    }
    warnings
}

/// Report what a stepper did wrong since the last look.
fn stepper_warnings(id: &str, m: &mut BipolarStepper, warnings: &mut BTreeSet<String>) {
    if std::mem::take(&mut m.slipped) {
        warnings.insert(format!(
            "{id}: lost steps — the rotor fell a whole cycle behind the field (stepping faster than it can follow from rest: ramp the step rate up; or the load is more than its torque)"
        ));
    }
    if std::mem::take(&mut m.jitter) {
        warnings.insert(format!(
            "{id}: the coil field jumped by 180° from one step to the next — the rotor cannot tell which way to turn and jitters (check the step sequence and which pins drive which coil)"
        ));
    }
}

/// A driver's output pair: (part id, bridge, (first, second) node, pin names).
type OutputPair<'a> = (&'a str, usize, (usize, usize), [&'a str; 2]);

/// Find, for every coil of every bipolar stepper, the driver output pair
/// its two ends sit on (through the nets). Returns wiring warnings.
fn link_steppers(
    motors: &mut [StepperPart],
    drivers: &[DriverPart],
    bridges: &[BridgePart],
) -> Vec<String> {
    let pairs: Vec<OutputPair> = drivers
        .iter()
        .flat_map(|d| {
            [(0, ["1A", "1B"]), (1, ["2A", "2B"])]
                .map(|(k, names)| (d.id.as_str(), k, d.out[k], names))
        })
        .chain(bridges.iter().flat_map(|b| {
            [(0, ["OUT1", "OUT2"]), (1, ["OUT3", "OUT4"])]
                .map(|(k, names)| (b.id.as_str(), k, b.out[k], names))
        }))
        .collect();
    let mut warnings = Vec::new();
    for m in motors {
        for (k, coil) in ["A", "B"].iter().enumerate() {
            let (plus, minus) = m.coils[k];
            m.links[k] = pairs.iter().find_map(|&(id, bridge, (o1, o2), _)| {
                let sign = if (o1, o2) == (plus, minus) {
                    1.0
                } else if (o1, o2) == (minus, plus) {
                    -1.0
                } else {
                    return None;
                };
                Some(CoilLink {
                    driver: id.to_string(),
                    bridge,
                    sign,
                })
            });
            if m.links[k].is_some() || plus == minus {
                continue;
            }
            // One end on a driver output but the other elsewhere.
            let touched: Vec<String> = pairs
                .iter()
                .flat_map(|&(id, _, (o1, o2), names)| {
                    [(o1, names[0]), (o2, names[1])]
                        .into_iter()
                        .filter(|&(o, _)| o == plus || o == minus)
                        .map(move |(_, n)| format!("{id}.{n}"))
                })
                .collect();
            // One end through something else (a sense resistor) is fine
            // since the coils are in the solve (M28); both ends on outputs
            // of different pairs is a wiring mistake.
            if touched.len() >= 2 {
                warnings.push(format!(
                    "{}: coil {coil} ({coil}+/{coil}−) is not across one output pair (it is on {}) — put both ends of a coil on 1A/1B or 2A/2B (OUT1/OUT2 or OUT3/OUT4)",
                    m.id,
                    touched.join(", ")
                ));
            }
        }
    }
    warnings
}

fn truthy(v: &serde_json::Value) -> bool {
    match v {
        serde_json::Value::Bool(b) => *b,
        serde_json::Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0),
        serde_json::Value::String(s) => matches!(s.trim(), "1" | "true" | "on"),
        _ => false,
    }
}

/// Norton equivalent (voltage, resistance) of a pin drive.
/// The inputs of `sol` if they differ from those of `old`.
fn drive_source(d: Drive) -> Option<(f64, f64)> {
    match d {
        Drive::High => Some((VDD, R_ON)),
        Drive::Low => Some((0.0, R_ON)),
        Drive::PullUp => Some((VDD, R_PULL)),
        Drive::PullDown => Some((0.0, R_PULL)),
        Drive::Float => None,
    }
}

/// Solve `a x = b` (n×n, row-major) for each right-hand side `b` in
/// `bs` by Gaussian elimination with partial pivoting. The matrix is
/// diagonally dominant thanks to GMIN.
fn gauss_cols(a: &mut [f64], bs: &mut [Vec<f64>], n: usize) -> Vec<Vec<f64>> {
    for col in 0..n {
        let piv = (col..n)
            .max_by(|&i, &j| a[i * n + col].abs().total_cmp(&a[j * n + col].abs()))
            .unwrap();
        if piv != col {
            for k in 0..n {
                a.swap(piv * n + k, col * n + k);
            }
            for b in bs.iter_mut() {
                b.swap(piv, col);
            }
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
            for b in bs.iter_mut() {
                b[row] -= f * b[col];
            }
        }
    }
    bs.iter()
        .map(|b| {
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
        })
        .collect()
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
    fn voltage_probes_log_each_change_of_the_operating_point() {
        // D7 → 220 Ω → LED → GND, probed at the resistor's far end and at
        // the MCU pin; a third probe names a pin on no net.
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
        let hi = drives(&s, |p| {
            if p == (0, 8) {
                Drive::High
            } else {
                Drive::Float
            }
        });
        let lo = drives(&s, |p| {
            if p == (0, 8) {
                Drive::Low
            } else {
                Drive::Float
            }
        });
        s.update(0, &lo);
        s.set_voltage_probes(&["led1.A".into(), "PA8".into(), "PC3".into()], 10);
        // PWM: two changes per period; repeating a drive state logs nothing.
        for k in 1..=3 {
            s.update(k * 100, &hi);
            s.update(k * 100 + 25, &lo);
            s.update(k * 100 + 50, &lo);
        }
        let log = s.take_voltage_log();
        assert_eq!(log.len(), 7, "{log:?}");
        assert_eq!(log[0].0, 10);
        assert_eq!(log[1].0, 100);
        assert_eq!(log[2].0, 125);
        let (a_hi, pin_hi) = (log[1].1[0].unwrap(), log[1].1[1].unwrap());
        // The LED's forward voltage on its anode, the driver's drop on the pin.
        assert!((1.6..2.4).contains(&a_hi), "{a_hi}");
        assert!(pin_hi > 3.0 && pin_hi < VDD, "{pin_hi}");
        assert!(log[2].1[0].unwrap() < 0.1);
        assert_eq!(log[1].1[2], None, "PC3 is on no net");
        assert!(s.take_voltage_log().is_empty());
        s.set_voltage_probes(&[], 1000);
        s.update(1100, &hi);
        assert!(s.take_voltage_log().is_empty());
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

    /// Let devices act on their own (relays, sensors) up to `until`.
    fn run_to(s: &mut CircuitSim, until: Cycles, d: &[Drive]) {
        while let Some(t) = s.next_event().filter(|&t| t <= until) {
            s.update(t, d);
        }
        s.update(until, d);
    }

    #[test]
    fn relay_contacts_switch_a_separately_powered_led() {
        // 5 V → COM; NO → 330 Ω → red LED; NC → 330 Ω → green LED; IN on D7.
        for trigger in ["low", "high"] {
            let mut s = sim(
                vec![
                    part("k1", "relay", &[("trigger", trigger)]),
                    part("rn", "resistor", &[("ohms", "330")]),
                    part("rc", "resistor", &[("ohms", "330")]),
                    part("on", "led-5mm", &[("color", "red")]),
                    part("off", "led-5mm", &[("color", "green")]),
                ],
                vec![
                    wire(("mcu", "5V"), ("k1", "VCC")),
                    wire(("k1", "GND"), ("mcu", "GND")),
                    wire(("mcu", "D7"), ("k1", "IN")),
                    wire(("mcu", "5V"), ("k1", "COM")),
                    wire(("k1", "NO"), ("rn", "1")),
                    wire(("rn", "2"), ("on", "A")),
                    wire(("k1", "NC"), ("rc", "1")),
                    wire(("rc", "2"), ("off", "A")),
                    wire(("on", "K"), ("mcu", "GND")),
                    wire(("off", "K"), ("mcu", "GND")),
                ],
            );
            let level = |high: bool| {
                drives(&s, |p| match (p, high) {
                    ((0, 8), true) => Drive::High,
                    ((0, 8), false) => Drive::Low,
                    _ => Drive::Float,
                })
            };
            let (idle, energise) = if trigger == "low" {
                (level(true), level(false))
            } else {
                (level(false), level(true))
            };
            let ms = |m: f64| (m * 16_000.0) as Cycles; // 16 MHz
            run_to(&mut s, ms(1.0), &idle);
            s.end_frame(ms(1.0), 0.001);
            run_to(&mut s, ms(5.0), &idle);
            let v = s.end_frame(ms(5.0), 0.004);
            assert!(visual(&v, "off").brightness[0] > 0.9, "{trigger}: NC lit");
            assert_eq!(visual(&v, "on").brightness[0], 0.0, "{trigger}");
            assert_eq!(visual(&v, "k1").on, Some(0.0), "coil LED off");
            assert_eq!(visual(&v, "k1").closed, Some(false));
            // Energise: the contacts move ~10 ms later.
            run_to(&mut s, ms(9.0), &energise);
            let v = s.end_frame(ms(9.0), 0.004);
            assert_eq!(visual(&v, "k1").on, Some(1.0), "{trigger}: coil LED on");
            assert_eq!(
                visual(&v, "k1").closed,
                Some(false),
                "{trigger}: not yet moved"
            );
            assert_eq!(visual(&v, "on").brightness[0], 0.0);
            run_to(&mut s, ms(22.0), &energise);
            s.end_frame(ms(22.0), 0.013);
            run_to(&mut s, ms(30.0), &energise);
            let v = s.end_frame(ms(30.0), 0.008);
            assert_eq!(visual(&v, "k1").closed, Some(true), "{trigger}: COM on NO");
            assert!(visual(&v, "on").brightness[0] > 0.9, "{trigger}: NO lit");
            assert_eq!(visual(&v, "off").brightness[0], 0.0, "{trigger}");
            // (5 − 1.9) / 345 Ω ≈ 9 mA through the contact, from 5 V.
            let i = (s.voltage(&PinRef::new("rn", "1")).unwrap()
                - s.voltage(&PinRef::new("on", "A")).unwrap())
                / 330.0;
            assert!((i - 0.009).abs() < 0.001, "{i}");
            // Released: back to NC after the release time.
            s.update(ms(30.0), &idle);
            run_to(&mut s, ms(40.0), &idle);
            s.end_frame(ms(40.0), 0.01);
            assert!(s.relay_clicks("k1") >= 5, "the contacts bounced");
            run_to(&mut s, ms(50.0), &idle);
            let v = s.end_frame(ms(50.0), 0.01);
            assert!(visual(&v, "off").brightness[0] > 0.9, "{trigger}: NC again");
            assert!(s.warnings.is_empty(), "{:?}", s.warnings);
        }
    }

    #[test]
    fn relay_on_3v3_does_not_pull_in_and_warns() {
        let mut s = sim(
            vec![part("k1", "relay", &[])],
            vec![
                wire(("mcu", "3V3"), ("k1", "VCC")),
                wire(("k1", "GND"), ("mcu", "GND")),
                wire(("mcu", "D7"), ("k1", "IN")),
            ],
        );
        let low = drives(&s, |p| {
            if p == (0, 8) {
                Drive::Low
            } else {
                Drive::Float
            }
        });
        run_to(&mut s, 800_000, &low);
        let v = s.end_frame(800_000, 0.05);
        assert_eq!(visual(&v, "k1").closed, Some(false));
        assert!(visual(&v, "k1").unpowered);
        assert!(
            s.warnings
                .iter()
                .any(|w| w.contains("k1") && w.contains("3.75")),
            "{:?}",
            s.warnings
        );
    }

    #[test]
    fn hc05_drives_state_and_txd_and_finds_its_uart_pins() {
        let mut s = sim(
            vec![part("bt", "hc05", &[("baud", "9600")])],
            vec![
                wire(("mcu", "5V"), ("bt", "VCC")),
                wire(("bt", "GND"), ("mcu", "GND")),
                wire(("mcu", "PA9"), ("bt", "RXD")),
                wire(("mcu", "PA10"), ("bt", "TXD")),
                wire(("mcu", "PA8"), ("bt", "STATE")),
            ],
        );
        let d = drives(&s, |_| Drive::Float);
        s.update(0, &d);
        assert_eq!(
            s.uart_links(),
            vec![UartLink {
                id: "bt".into(),
                rxd: vec![(0, 9)],
                txd: vec![(0, 10)],
            }]
        );
        let level = |s: &CircuitSim, pin: &str| s.voltage(&PinRef::new("mcu", pin)).unwrap();
        assert!(level(&s, "PA10") > 3.0, "TXD idles high");
        assert!(level(&s, "PA8") < 0.5, "no phone: STATE low");
        let b = s.hc05("bt").unwrap();
        assert!(b.powered && !b.at_mode);
        assert_eq!(b.uart_baud(), 9600);
        b.connected = true;
        s.update(10, &d);
        assert!(level(&s, "PA8") > 3.0, "connected: STATE high");
        let v = s.end_frame(20, 0.0);
        assert_eq!(visual(&v, "bt").text.as_deref(), Some("connected"));
    }

    #[test]
    fn hc05_with_en_high_at_power_up_answers_at_commands_at_38400() {
        let mut s = sim(
            vec![part("bt", "hc05", &[])],
            vec![
                wire(("mcu", "5V"), ("bt", "VCC")),
                wire(("bt", "GND"), ("mcu", "GND")),
                wire(("mcu", "3V3"), ("bt", "EN")),
            ],
        );
        let d = drives(&s, |_| Drive::Float);
        s.update(0, &d);
        let b = s.hc05("bt").unwrap();
        assert!(b.at_mode);
        assert_eq!(b.uart_baud(), 38_400);
        for &c in b"AT\r\nAT+NAME?\r\nAT+UART=115200,0,0\r\nAT+FOO\r\n" {
            b.from_mcu(c, false);
        }
        let reply: Vec<u8> = b.to_mcu.drain(..).collect();
        assert_eq!(
            String::from_utf8(reply).unwrap(),
            "OK\r\n+NAME:HC-05\r\nOK\r\nOK\r\nERROR:(0)\r\n"
        );
        assert_eq!(b.baud, 115_200);
        assert!(!b.from_phone(b"x"), "no phone link in AT mode");
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

    #[test]
    fn i2c_reaches_a_powered_module_with_pull_ups() {
        let wiring = |sda: &'static str| {
            vec![
                wire(("aht", "VCC"), ("mcu", "3V3")),
                wire(("aht", "GND"), ("mcu", "GND")),
                wire(("aht", "SCL"), ("mcu", "PB8")),
                wire(("aht", "SDA"), ("mcu", sda)),
                wire(("oled", "VCC"), ("mcu", "3V3")),
                wire(("oled", "GND"), ("mcu", "GND")),
                wire(("oled", "SCL"), ("mcu", "PB8")),
                wire(("oled", "SDA"), ("mcu", sda)),
            ]
        };
        let parts = || {
            vec![
                part("aht", "aht20", &[("temp", "30"), ("humidity", "60")]),
                part("oled", "oled-ssd1306", &[]),
            ]
        };
        let (scl, sda) = ((1, 8), (1, 9));
        let mut s = sim(parts(), wiring("PB9"));
        s.set_clock(0, 0.0, 1e6);
        let float = drives(&s, |_| Drive::Float);
        s.update(0, &float);
        assert!(s.i2c_start(0, scl, sda, 0x38, false), "AHT20 acks");
        assert!(s.i2c_write(0, scl, 0xAC));
        s.i2c_write(0, scl, 0x33);
        s.i2c_write(0, scl, 0x00);
        s.i2c_stop(0, scl);
        assert!(!s.i2c_start(10, scl, sda, 0x50, false), "nobody at 0x50");
        // 100 ms later the measurement is ready.
        assert!(s.i2c_start(100_000, scl, sda, 0x38, true));
        let d: Vec<u8> = (0..6).map(|_| s.i2c_read(100_000, scl)).collect();
        s.i2c_stop(100_000, scl);
        assert_eq!(d[0] & 0x80, 0);
        let t = (((d[3] as u32 & 0xF) << 16) | (d[4] as u32) << 8 | d[5] as u32) as f64
            / 1_048_576.0
            * 200.0
            - 50.0;
        assert!((t - 30.0).abs() < 0.01);

        // Draw on the OLED and see it in the frame.
        assert!(s.i2c_start(0, scl, sda, 0x3C, false));
        for b in [0x00, 0x8D, 0x14, 0xAF, 0x20, 0x00, 0xA1, 0xC8] {
            s.i2c_write(0, scl, b);
        }
        s.i2c_stop(0, scl);
        s.i2c_start(0, scl, sda, 0x3C, false);
        s.i2c_write(0, scl, 0x40);
        s.i2c_write(0, scl, 0xFF);
        s.i2c_stop(0, scl);
        let v = s.end_frame(200_000, 0.2);
        let screen = visual(&v, "oled").screen.clone().expect("display on");
        assert!(screen.starts_with("gA")); // first pixel (0x80…) lit
        assert!(s.warnings.is_empty(), "{:?}", s.warnings);

        // Unpowered modules: their pull-ups do nothing, the bus stays low.
        let mut s = sim(
            parts(),
            wiring("PB9")
                .into_iter()
                .filter(|w| w.b.pin != "3V3")
                .collect(),
        );
        s.update(0, &drives(&s, |_| Drive::Float));
        assert!(!s.i2c_start(0, scl, sda, 0x38, false));
        assert!(
            s.warnings.iter().any(|w| w.contains("not pulled up")),
            "{:?}",
            s.warnings
        );
    }

    #[test]
    fn rtc_keeps_time_across_power_cycles() {
        let mut s = sim(
            vec![part("rtc", "rtc-ds3231", &[])],
            vec![
                wire(("rtc", "VCC"), ("mcu", "3V3")),
                wire(("rtc", "GND"), ("mcu", "GND")),
                wire(("rtc", "SCL"), ("mcu", "PB8")),
                wire(("rtc", "SDA"), ("mcu", "PB9")),
            ],
        );
        s.set_clock(0, 0.0, 1e6);
        s.update(0, &drives(&s, |_| Drive::Float));
        let v = s.end_frame(5_000_000, 5.0);
        assert_eq!(
            visual(&v, "rtc").text.as_deref(),
            Some("2026-01-01 00:00:05")
        );
        s.reset_time(0);
        s.set_clock(0, 0.0, 1e6);
        s.update(0, &drives(&s, |_| Drive::Float));
        let v = s.end_frame(2_000_000, 2.0);
        assert_eq!(
            visual(&v, "rtc").text.as_deref(),
            Some("2026-01-01 00:00:07")
        );
    }

    #[test]
    fn i2c_transfer_survives_an_unrelated_rebuild() {
        let mut s = sim(
            vec![part("aht", "aht20", &[]), part("sw", "tact-switch", &[])],
            vec![
                wire(("aht", "VCC"), ("mcu", "3V3")),
                wire(("aht", "GND"), ("mcu", "GND")),
                wire(("aht", "SCL"), ("mcu", "PB8")),
                wire(("aht", "SDA"), ("mcu", "PB9")),
            ],
        );
        let (scl, sda) = ((1, 8), (1, 9));
        s.update(0, &drives(&s, |_| Drive::Float));
        assert!(s.i2c_start(0, scl, sda, 0x38, false));
        assert!(s.i2c_write(0, scl, 0xAC));
        // B1 pressed mid-transfer: the circuit is rebuilt.
        s.set_pressed("B1", true, 10);
        s.update(10, &drives(&s, |_| Drive::Float));
        assert!(s.i2c_write(10, scl, 0x33), "still addressed");
    }

    #[test]
    fn mpu6050_on_i2c_follows_the_tilt_inputs() {
        let wires = vec![
            wire(("imu", "VCC"), ("mcu", "3V3")),
            wire(("imu", "GND"), ("mcu", "GND")),
            wire(("imu", "SCL"), ("mcu", "PB8")),
            wire(("imu", "SDA"), ("mcu", "PB9")),
        ];
        let imu = |roll: &str| part("imu", "mpu6050", &[("address", "0x69"), ("roll", roll)]);
        let mut s = sim(vec![imu("0")], wires.clone());
        let (scl, sda) = ((1, 8), (1, 9));
        s.update(0, &drives(&s, |_| Drive::Float));
        assert!(!s.i2c_start(0, scl, sda, 0x68, false), "AD0 high: 0x69");
        assert!(s.i2c_start(0, scl, sda, 0x69, false));
        s.i2c_write(0, scl, 0x6B);
        s.i2c_write(0, scl, 0x00);
        s.i2c_stop(0, scl);
        let read_ay = |s: &mut CircuitSim| {
            s.i2c_start(0, scl, sda, 0x69, false);
            s.i2c_write(0, scl, 0x3D);
            s.i2c_start(0, scl, sda, 0x69, true);
            let v = i16::from_be_bytes([s.i2c_read(0, scl), s.i2c_read(0, scl)]);
            s.i2c_stop(0, scl);
            v
        };
        assert_eq!(read_ay(&mut s), 0);
        // The slider moves: the chip stays awake, Y sees sin(roll).
        s.set_circuit(
            &Circuit {
                parts: vec![part("mcu", BOARD_KIND, &[]), imu("-30")],
                wires: wires.clone(),
            },
            0,
        );
        s.update(0, &drives(&s, |_| Drive::Float));
        assert_eq!(read_ay(&mut s), -8192);
        // A shake from the UI: extra acceleration (g) on top of gravity.
        s.set_circuit(
            &Circuit {
                parts: vec![
                    part("mcu", BOARD_KIND, &[]),
                    part(
                        "imu",
                        "mpu6050",
                        &[("address", "0x69"), ("roll", "-30"), ("ay", "0.75")],
                    ),
                ],
                wires,
            },
            0,
        );
        s.update(0, &drives(&s, |_| Drive::Float));
        assert_eq!(read_ay(&mut s), -8192 + 12288);
    }

    #[test]
    fn max7219_takes_spi_bytes_and_bit_banged_frames() {
        let mut s = sim(
            vec![part("mx", "max7219", &[("count", "2")])],
            vec![
                wire(("mx", "VCC"), ("mcu", "5V")),
                wire(("mx", "GND"), ("mcu", "GND")),
                wire(("mx", "CLK"), ("mcu", "PA5")),
                wire(("mx", "DIN"), ("mcu", "PA7")),
                wire(("mx", "CS"), ("mcu", "PB6")),
            ],
        );
        let (sck, mosi, cs) = ((0, 5), (0, 7), (1, 6));
        let set = |s: &mut CircuitSim, t: Cycles, clk: bool, din: bool, cs_high: bool| {
            let d = drives(s, |p| {
                let high = if p == sck {
                    clk
                } else if p == mosi {
                    din
                } else if p == cs {
                    cs_high
                } else {
                    return Drive::Float;
                };
                if high {
                    Drive::High
                } else {
                    Drive::Low
                }
            });
            s.update(t, &d);
        };
        // Hardware SPI: the clock and data pins are the peripheral's, CS
        // a GPIO.
        let spi_frames = |s: &mut CircuitSim, t: &mut Cycles, frames: [u16; 2]| {
            set(s, *t, false, false, false);
            for f in frames {
                s.spi(*t, sck, mosi, None, (f >> 8) as u8);
                s.spi(*t, sck, mosi, None, f as u8);
            }
            *t += 10;
            set(s, *t, false, false, true);
            *t += 10;
        };
        let mut t = 0;
        set(&mut s, t, false, false, true);
        for f in [
            [0x0C01, 0x0C01],
            [0x0B07, 0x0B07],
            [0x0A0F, 0x0A04],
            [0x0118, 0x0181],
        ] {
            spi_frames(&mut s, &mut t, f);
        }
        let v = s.end_frame(t, 0.01);
        let m = visual(&v, "mx").matrix.clone().unwrap();
        assert_eq!(m.rows.len(), 16);
        assert_eq!(
            (m.rows[0], m.rows[8]),
            (0x81, 0x18),
            "first frame → far module"
        );
        assert_eq!(m.intensity, [4, 15]);
        // Bit-banged: the same pins as GPIO outputs.
        for f in [0x0842u16, 0x0000] {
            for i in (0..16).rev() {
                let b = f >> i & 1 != 0;
                set(&mut s, t, false, b, false);
                set(&mut s, t + 1, true, b, false);
                t += 2;
            }
        }
        set(&mut s, t, false, false, true);
        let v = s.end_frame(t + 10, 0.01);
        let m = visual(&v, "mx").matrix.clone().unwrap();
        assert_eq!((m.rows[7], m.rows[15]), (0, 0x42));
        assert!(s.warnings.is_empty(), "{:?}", s.warnings);
    }

    #[test]
    fn separate_max7219_parts_chain_dout_to_din() {
        // Two parts: A on the MCU, B's DIN on A's DOUT, CLK and CS shared.
        let mut s = sim(
            vec![
                part("a", "max7219", &[("count", "1")]),
                part("b", "max7219", &[("count", "1")]),
            ],
            vec![
                wire(("a", "VCC"), ("mcu", "5V")),
                wire(("a", "GND"), ("mcu", "GND")),
                wire(("b", "VCC"), ("mcu", "5V")),
                wire(("b", "GND"), ("mcu", "GND")),
                wire(("a", "CLK"), ("mcu", "PA5")),
                wire(("a", "DIN"), ("mcu", "PA7")),
                wire(("a", "CS"), ("mcu", "PB6")),
                wire(("a", "DOUT"), ("b", "DIN")),
                wire(("b", "CLK"), ("a", "CLK")),
                wire(("b", "CS"), ("a", "CS")),
            ],
        );
        let (sck, mosi, cs) = ((0, 5), (0, 7), (1, 6));
        let set = |s: &mut CircuitSim, t: Cycles, clk: bool, din: bool, cs_high: bool| {
            let d = drives(s, |p| {
                let high = if p == sck {
                    clk
                } else if p == mosi {
                    din
                } else if p == cs {
                    cs_high
                } else {
                    return Drive::Float;
                };
                if high {
                    Drive::High
                } else {
                    Drive::Low
                }
            });
            s.update(t, &d);
        };
        let rows = |s: &mut CircuitSim, t: Cycles, id: &str| {
            let v = s.end_frame(t, 0.01);
            let m = visual(&v, id).matrix.clone().unwrap();
            (m.rows, m.intensity)
        };
        // Hardware SPI: frames for B first, then A's.
        let mut t = 0;
        set(&mut s, t, false, false, true);
        for f in [
            [0x0C01, 0x0C01],
            [0x0B07, 0x0B07],
            [0x0A02, 0x0A09],
            [0x0181, 0x0118],
        ] {
            set(&mut s, t, false, false, false);
            for w in f {
                s.spi(t, sck, mosi, None, (w >> 8) as u8);
                s.spi(t, sck, mosi, None, w as u8);
            }
            t += 10;
            set(&mut s, t, false, false, true);
            t += 10;
        }
        let (ra, ia) = rows(&mut s, t, "a");
        let (rb, ib) = rows(&mut s, t, "b");
        assert_eq!((ra[0], ia[0]), (0x18, 9), "A keeps the last frame");
        assert_eq!((rb[0], ib[0]), (0x81, 2), "B gets the one pushed through A");
        assert_eq!(ra.len(), 8);

        // Bit-banged: B samples A's DOUT on the shared CLK.
        for f in [0x0842u16, 0x0824] {
            for i in (0..16).rev() {
                let b = f >> i & 1 != 0;
                set(&mut s, t, false, b, false);
                set(&mut s, t + 1, true, b, false);
                t += 2;
            }
        }
        set(&mut s, t, false, false, false);
        set(&mut s, t + 1, false, false, true);
        t += 10;
        assert_eq!(rows(&mut s, t, "a").0[7], 0x24);
        assert_eq!(rows(&mut s, t, "b").0[7], 0x42);
        assert!(s.warnings.is_empty(), "{:?}", s.warnings);

        // `count` still chains inside a part: B with two modules.
        let mut s2 = sim(
            vec![
                part("a", "max7219", &[]),
                part("b", "max7219", &[("count", "2")]),
            ],
            vec![
                wire(("a", "VCC"), ("mcu", "5V")),
                wire(("a", "GND"), ("mcu", "GND")),
                wire(("b", "VCC"), ("mcu", "5V")),
                wire(("b", "GND"), ("mcu", "GND")),
                wire(("a", "CLK"), ("mcu", "PA5")),
                wire(("a", "DIN"), ("mcu", "PA7")),
                wire(("a", "CS"), ("mcu", "PB6")),
                wire(("a", "DOUT"), ("b", "DIN")),
                wire(("b", "CLK"), ("a", "CLK")),
                wire(("b", "CS"), ("a", "CS")),
            ],
        );
        set(&mut s2, 0, false, false, true);
        set(&mut s2, 1, false, false, false);
        for w in [0x0C01u16, 0x0C01, 0x0C01] {
            s2.spi(2, sck, mosi, None, (w >> 8) as u8);
            s2.spi(2, sck, mosi, None, w as u8);
        }
        set(&mut s2, 3, false, false, true);
        set(&mut s2, 4, false, false, false);
        for w in [0x0133u16, 0x0122, 0x0111] {
            s2.spi(5, sck, mosi, None, (w >> 8) as u8);
            s2.spi(5, sck, mosi, None, w as u8);
        }
        set(&mut s2, 6, false, false, true);
        set(&mut s2, 7, false, false, false);
        for w in [0x0B07u16, 0x0B07, 0x0B07] {
            s2.spi(8, sck, mosi, None, (w >> 8) as u8);
            s2.spi(8, sck, mosi, None, w as u8);
        }
        set(&mut s2, 9, false, false, true);
        let (rb, _) = rows(&mut s2, 20, "b");
        assert_eq!((rb[0], rb[8]), (0x22, 0x33), "far module of B: first frame");
        assert_eq!(rows(&mut s2, 20, "a").0[0], 0x11);
    }

    #[test]
    fn ir_receiver_output_carries_the_remote_frames() {
        let mut s = sim(
            vec![part("ir", "ir-receiver", &[])],
            vec![
                wire(("ir", "VCC"), ("mcu", "3V3")),
                wire(("ir", "GND"), ("mcu", "GND")),
                wire(("ir", "OUT"), ("mcu", "PA10")),
            ],
        );
        s.set_clock(0, 0.0, 1e6);
        let float = drives(&s, |_| Drive::Float);
        let level = |s: &CircuitSim, inputs: &[Option<bool>]| {
            let i = s.mcu_pins().iter().position(|&p| p == (0, 10)).unwrap();
            inputs[i]
        };
        let inputs = s.update(0, &float).unwrap();
        assert_eq!(level(&s, &inputs), Some(true), "idle high (pull-up)");
        assert_eq!(s.next_event(), None);
        s.set_pressed("ir:5", true, 1000);
        // Follow the output's changes: 9 ms low, 4.5 ms high, …
        let mut changes = Vec::new();
        while let Some(t) = s.next_event() {
            if t > 1000 + 90_000 {
                break;
            }
            if let Some(i) = s.update(t, &float) {
                changes.push((t - 1000, level(&s, &i)));
            }
        }
        assert_eq!(changes[0], (0, Some(false)));
        assert_eq!(changes[1], (9000, Some(true)));
        assert_eq!(changes[2], (13_500, Some(false)));
        assert_eq!(changes.len(), 68);
        s.set_pressed("ir:5", false, 100_000);
        let v = s.end_frame(100_000, 0.1);
        assert_eq!(visual(&v, "ir").text.as_deref(), Some("0x40"));
        assert_eq!(s.next_event(), None, "released before the repeat");
    }

    // ------------------------------------------------------------- M19

    /// Drives the listed MCU pins (`Some(level)` push-pull, `None` released
    /// open-drain), the rest float.
    fn pins(s: &mut CircuitSim, t: Cycles, levels: &[((u8, u8), Option<bool>)]) {
        let d = drives(s, |p| match levels.iter().find(|(q, _)| *q == p) {
            Some((_, Some(true))) => Drive::High,
            Some((_, Some(false))) => Drive::Low,
            _ => Drive::Float,
        });
        s.update(t, &d);
    }

    /// Eight LEDs (with 330 Ω each) on Q0–Q7 of `sr`, named `{sr}l0`….
    fn led_bar(sr: &str, parts: &mut Vec<PartInstance>, wires: &mut Vec<Wire>) {
        for i in 0..8 {
            let (r, l) = (format!("{sr}r{i}"), format!("{sr}l{i}"));
            parts.push(part(&r, "resistor", &[("ohms", "330")]));
            parts.push(part(&l, "led-5mm", &[("color", "red")]));
            wires.push(wire((sr, &format!("Q{i}")), (&r, "1")));
            wires.push(wire((&r, "2"), (&l, "A")));
            wires.push(wire((&l, "K"), ("mcu", "GND")));
        }
    }

    fn lit(v: &[PartVisual], sr: &str) -> u8 {
        (0..8).fold(0, |a, i| {
            let b = visual(v, &format!("{sr}l{i}")).brightness[0];
            a | ((b > 0.5) as u8) << i
        })
    }

    fn hc595_circuit(oe: Option<&str>) -> CircuitSim {
        let mut parts = vec![part("sa", "hc595", &[]), part("sb", "hc595", &[])];
        let mut wires = Vec::new();
        for sr in ["sa", "sb"] {
            wires.push(wire((sr, "VCC"), ("mcu", "3V3")));
            wires.push(wire((sr, "GND"), ("mcu", "GND")));
            wires.push(wire((sr, "MR"), ("mcu", "3V3")));
            wires.push(wire((sr, "SHCP"), ("mcu", "PA5")));
            wires.push(wire((sr, "STCP"), ("mcu", "PB6")));
            if let Some(oe) = oe {
                wires.push(wire((sr, "OE"), ("mcu", oe)));
            }
            led_bar(sr, &mut parts, &mut wires);
        }
        wires.push(wire(("sa", "DS"), ("mcu", "PA7")));
        // Cascade: sb's DS on sa's Q7'.
        wires.push(wire(("sa", "Q7S"), ("sb", "DS")));
        sim(parts, wires)
    }

    const SCK: (u8, u8) = (0, 5);
    const MOSI: (u8, u8) = (0, 7);
    const LATCH: (u8, u8) = (1, 6);

    #[test]
    fn hc595_bit_banged_chain_lights_leds_through_resistors() {
        let mut s = hc595_circuit(Some("GND"));
        let mut t = 0;
        let put = |s: &mut CircuitSim, t: &mut Cycles, clk, ds, st| {
            pins(
                s,
                *t,
                &[(SCK, Some(clk)), (MOSI, Some(ds)), (LATCH, Some(st))],
            );
            *t += 10;
        };
        put(&mut s, &mut t, false, false, false);
        // 16 bits, MSB first: 0x81 for the far chip, then 0x3C for the near.
        for w in [0x81u8, 0x3C] {
            for i in (0..8).rev() {
                let b = w >> i & 1 != 0;
                put(&mut s, &mut t, false, b, false);
                put(&mut s, &mut t, true, b, false);
            }
        }
        put(&mut s, &mut t, false, false, false);
        let v = s.end_frame(t, 0.01);
        assert_eq!((lit(&v, "sa"), lit(&v, "sb")), (0, 0), "not latched yet");
        put(&mut s, &mut t, false, false, true);
        // The outputs stay lit while the MCU does nothing more.
        let v = s.end_frame(t + 100_000, 0.01);
        let v2 = s.end_frame(t + 200_000, 0.01);
        assert_eq!((lit(&v2, "sa"), lit(&v2, "sb")), (0x3C, 0x81));
        let reg = visual(&v, "sa").register.clone().unwrap();
        assert_eq!((reg.shift, reg.latch, reg.enabled), (0x3C, 0x3C, true));
        assert!(s.warnings.is_empty(), "{:?}", s.warnings);
    }

    #[test]
    fn hc595_takes_hardware_spi_bytes_down_the_chain() {
        let mut s = hc595_circuit(Some("PA8"));
        // OE on a GPIO: low enables.
        let idle = |s: &mut CircuitSim, t, st, oe| {
            pins(
                s,
                t,
                &[
                    (SCK, Some(false)),
                    (MOSI, Some(false)),
                    (LATCH, Some(st)),
                    ((0, 8), Some(oe)),
                ],
            );
        };
        idle(&mut s, 0, false, false);
        s.spi(10, SCK, MOSI, None, 0x0F);
        s.spi(20, SCK, MOSI, None, 0xA5);
        idle(&mut s, 30, true, false);
        let v = s.end_frame(1000, 0.01);
        assert_eq!((lit(&v, "sa"), lit(&v, "sb")), (0xA5, 0x0F));
        // OE high: every LED goes dark, the register keeps its contents.
        idle(&mut s, 3000, true, true);
        s.end_frame(3001, 0.01);
        let v = s.end_frame(4000, 0.01);
        assert_eq!((lit(&v, "sa"), lit(&v, "sb")), (0, 0));
        assert_eq!(visual(&v, "sb").register.clone().unwrap().latch, 0x0F);
        assert!(s.warnings.is_empty(), "{:?}", s.warnings);
    }

    #[test]
    fn hc595_with_stcp_on_sck_latches_hardware_spi_bytes() {
        // One chip, SHCP and STCP both on SCK: no separate latch pin.
        let mut parts = vec![part("sa", "hc595", &[])];
        let mut wires = vec![
            wire(("sa", "VCC"), ("mcu", "3V3")),
            wire(("sa", "GND"), ("mcu", "GND")),
            wire(("sa", "MR"), ("mcu", "3V3")),
            wire(("sa", "OE"), ("mcu", "GND")),
            wire(("sa", "SHCP"), ("mcu", "PA5")),
            wire(("sa", "STCP"), ("mcu", "PA5")),
            wire(("sa", "DS"), ("mcu", "PA7")),
        ];
        led_bar("sa", &mut parts, &mut wires);
        let mut s = sim(parts, wires);
        pins(&mut s, 0, &[(SCK, Some(false)), (MOSI, Some(false))]);
        s.spi(10, SCK, MOSI, None, 0xF0);
        s.spi(20, SCK, MOSI, None, 0x0F);
        let v = s.end_frame(1000, 0.01);
        // The outputs are one clock behind the shift register.
        assert_eq!(visual(&v, "sa").register.clone().unwrap().shift, 0x0F);
        assert_eq!(lit(&v, "sa"), 0x07);
    }

    #[test]
    fn hc595_with_oe_floating_warns_and_keeps_the_outputs_off() {
        let mut s = hc595_circuit(None);
        pins(
            &mut s,
            0,
            &[
                (SCK, Some(false)),
                (MOSI, Some(false)),
                (LATCH, Some(false)),
            ],
        );
        s.spi(10, SCK, MOSI, None, 0xFF);
        pins(
            &mut s,
            20,
            &[(SCK, Some(false)), (MOSI, Some(false)), (LATCH, Some(true))],
        );
        s.end_frame(21, 0.01);
        let v = s.end_frame(1000, 0.01);
        assert_eq!(lit(&v, "sa"), 0);
        assert!(
            s.warnings
                .iter()
                .any(|w| w.contains("sa: OE is not connected")),
            "{:?}",
            s.warnings
        );
    }

    #[test]
    fn tm1637_acks_on_dio_and_shows_the_digits() {
        let mut s = sim(
            vec![part("tm", "tm1637", &[])],
            vec![
                wire(("tm", "VCC"), ("mcu", "3V3")),
                wire(("tm", "GND"), ("mcu", "GND")),
                wire(("tm", "CLK"), ("mcu", "PA10")),
                wire(("tm", "DIO"), ("mcu", "PB3")),
            ],
        );
        s.set_clock(0, 0.0, 1e9); // one cycle per ns
        let (clk, dio) = ((0u8, 10u8), (1u8, 3u8));
        let mut t = 0;
        // Open drain: low or released (the module pulls up).
        let mut put = |s: &mut CircuitSim, c: bool, d: bool| -> Option<bool> {
            t += 5_000;
            let d = s.update(
                t,
                &drives(s, |p| match p {
                    p if p == clk && !c => Drive::Low,
                    p if p == dio && !d => Drive::Low,
                    _ => Drive::Float,
                }),
            );
            let _ = d;
            s.mcu_voltage(1, 3).map(|v| v > VDD / 2.0)
        };
        let mut acks = Vec::new();
        let mut transfer = |s: &mut CircuitSim, bytes: &[u8], acks: &mut Vec<bool>| {
            put(s, true, true);
            put(s, true, false);
            for &b in bytes {
                for i in 0..8 {
                    put(s, false, b >> i & 1 != 0);
                    put(s, true, b >> i & 1 != 0);
                }
                // Released for the ACK: the chip holds DIO low.
                acks.push(put(s, false, true) == Some(false));
                put(s, true, true);
                put(s, false, false);
            }
            put(s, true, false);
            put(s, true, true);
        };
        transfer(&mut s, &[0x40], &mut acks);
        transfer(&mut s, &[0xC0, 0x3F, 0x86, 0x5B, 0x4F], &mut acks);
        transfer(&mut s, &[0x8F], &mut acks);
        assert_eq!(acks, [true; 7]);
        let v = s.end_frame(1_000_000_000, 0.01);
        let d = visual(&v, "tm").digits.clone().unwrap();
        assert_eq!(d.segments, [0x3F, 0x86, 0x5B, 0x4F]);
        assert_eq!((d.brightness, d.on), (7, true));
        assert!(s.warnings.is_empty(), "{:?}", s.warnings);
    }

    fn pir_sim(supply: &str, props: &[(&str, &str)]) -> CircuitSim {
        let mut s = sim(
            vec![part("pir", "pir", props)],
            vec![
                wire(("pir", "VCC"), ("mcu", supply)),
                wire(("pir", "GND"), ("mcu", "GND")),
                wire(("pir", "OUT"), ("mcu", "PA8")),
            ],
        );
        s.set_clock(0, 0.0, 1000.0); // one cycle per ms
        s
    }

    fn set_props(s: &mut CircuitSim, id: &str, props: &[(&str, &str)], t: Cycles) {
        let mut c = s.circuit.clone();
        let p = c.parts.iter_mut().find(|p| p.id == id).unwrap();
        for (k, v) in props {
            p.props
                .insert(k.to_string(), serde_json::Value::String(v.to_string()));
        }
        s.set_circuit(&c, t);
    }

    #[test]
    fn pir_output_follows_motion_after_the_warm_up() {
        let mut s = pir_sim("5V", &[("delay", "2"), ("warmup", "1")]);
        let input = |s: &CircuitSim| s.mcu_voltage(0, 8).unwrap() > VDD / 2.0;
        let d = drives(&s, |_| Drive::Float);
        s.update(0, &d);
        set_props(&mut s, "pir", &[("motion", "1")], 500);
        run_to(&mut s, 900, &d);
        assert!(!input(&s), "warming up");
        run_to(&mut s, 1000, &d);
        assert!(input(&s), "OUT high at 3.3 V");
        assert!((s.mcu_voltage(0, 8).unwrap() - VDD).abs() < 0.05);
        set_props(&mut s, "pir", &[("motion", "0")], 1500);
        run_to(&mut s, 3400, &d);
        assert!(input(&s), "retrigger: 2 s after the motion ended");
        run_to(&mut s, 3600, &d);
        assert!(!input(&s));
        let v = s.end_frame(3700, 0.01);
        assert_eq!(visual(&v, "pir").text.as_deref(), Some("block"));
        assert!(s.warnings.is_empty(), "{:?}", s.warnings);
    }

    #[test]
    fn pir_on_3v3_warns_and_detects_nothing() {
        let mut s = pir_sim("3V3", &[("warmup", "0"), ("motion", "1")]);
        let d = drives(&s, |_| Drive::PullDown);
        run_to(&mut s, 2000, &d);
        assert!(s.mcu_voltage(0, 8).unwrap() < 0.5);
        assert!(
            s.warnings.iter().any(|w| w.contains("4.5–20 V")),
            "{:?}",
            s.warnings
        );
    }

    #[test]
    fn joystick_pots_divide_the_supply_and_the_switch_pulls_sw_low() {
        let mk = |props: &[(&str, &str)]| {
            sim(
                vec![part("js", "joystick", props)],
                vec![
                    wire(("js", "+5V"), ("mcu", "3V3")),
                    wire(("js", "GND"), ("mcu", "GND")),
                    wire(("js", "VRx"), ("mcu", "PA0")),
                    wire(("js", "VRy"), ("mcu", "PA1")),
                    wire(("js", "SW"), ("mcu", "PA8")),
                ],
            )
        };
        let mut s = mk(&[("x", "0.25"), ("y", "1")]);
        let d = drives(&s, |p| {
            if p == (0, 8) {
                Drive::PullUp
            } else {
                Drive::Float
            }
        });
        let inputs = s.update(0, &d).unwrap();
        assert!((s.mcu_voltage(0, 0).unwrap() - 0.825).abs() < 0.01);
        assert!((s.mcu_voltage(0, 1).unwrap() - VDD).abs() < 0.01);
        let sw = s.mcu_pins().iter().position(|&p| p == (0, 8)).unwrap();
        assert_eq!(inputs[sw], Some(true));
        let mut s = mk(&[("sw", "1")]);
        let inputs = s.update(0, &d).unwrap();
        assert_eq!(inputs[sw], Some(false), "pressed: SW to GND");
        assert!((s.mcu_voltage(0, 0).unwrap() - VDD / 2.0).abs() < 0.01);
    }

    #[test]
    fn bmp280_forgets_its_settings_without_supply() {
        // VCC from a GPIO, so the test can cut it.
        let mut s = sim(
            vec![part("baro", "bmp280", &[])],
            vec![
                wire(("baro", "VCC"), ("mcu", "PA0")),
                wire(("baro", "GND"), ("mcu", "GND")),
                wire(("baro", "SCL"), ("mcu", "PB8")),
                wire(("baro", "SDA"), ("mcu", "PB9")),
            ],
        );
        let vcc = (0, 0);
        let (scl, sda) = ((1, 8), (1, 9));
        let ctrl = |s: &mut CircuitSim| match s.devices.get("baro") {
            Some(Device::Baro(b)) => b.ctrl_meas,
            _ => panic!("no BMP280"),
        };
        pins(&mut s, 0, &[(vcc, Some(true))]);
        s.end_frame(10, 0.01);
        assert!(s.i2c_start(20, scl, sda, 0x76, false));
        s.i2c_write(20, scl, 0xF4);
        s.i2c_write(20, scl, 0x27); // normal mode
        s.i2c_stop(20, scl);
        s.end_frame(30, 0.01);
        assert_eq!(ctrl(&mut s), 0x27);
        // Power off for a frame, then on again: back to sleep.
        pins(&mut s, 40, &[(vcc, Some(false))]);
        s.end_frame(50, 0.01);
        pins(&mut s, 60, &[(vcc, Some(true))]);
        s.end_frame(70, 0.01);
        assert_eq!(ctrl(&mut s), 0);
    }

    #[test]
    fn bmp280_answers_on_its_sdo_address() {
        let mut s = sim(
            vec![part(
                "baro",
                "bmp280",
                &[("address", "0x77"), ("pressure", "900")],
            )],
            vec![
                wire(("baro", "VCC"), ("mcu", "3V3")),
                wire(("baro", "GND"), ("mcu", "GND")),
                wire(("baro", "SCL"), ("mcu", "PB8")),
                wire(("baro", "SDA"), ("mcu", "PB9")),
            ],
        );
        settle(&mut s);
        let (scl, sda) = ((1, 8), (1, 9));
        assert!(!s.i2c_start(0, scl, sda, 0x76, false));
        assert!(s.i2c_start(0, scl, sda, 0x77, false));
        s.i2c_write(0, scl, 0xD0);
        assert!(s.i2c_start(0, scl, sda, 0x77, true));
        assert_eq!(s.i2c_read(0, scl), 0x58);
        s.i2c_stop(0, scl);
        match s.devices.get("baro") {
            Some(Device::Baro(b)) => assert_eq!(b.pressure, 90_000.0),
            _ => panic!("no BMP280"),
        }
        // Reading the data in sleep mode warns.
        s.i2c_start(0, scl, sda, 0x77, false);
        s.i2c_write(0, scl, 0xF7);
        s.i2c_start(0, scl, sda, 0x77, true);
        assert_eq!(s.i2c_read(0, scl), 0x80);
        s.i2c_stop(0, scl);
        assert!(
            s.warnings
                .iter()
                .any(|w| w.contains("baro: BMP280: data read before")),
            "{:?}",
            s.warnings
        );
    }

    #[test]
    fn neopixel_bits_past_a_strip_go_to_the_part_on_its_dout() {
        let mut s = sim(
            vec![
                part("strip", "neopixel-strip", &[("count", "2")]),
                part("ring", "neopixel-ring", &[("count", "3")]),
            ],
            vec![
                wire(("strip", "VCC"), ("mcu", "5V")),
                wire(("strip", "GND"), ("mcu", "GND")),
                wire(("strip", "DIN"), ("mcu", "PA8")),
                wire(("ring", "VCC"), ("mcu", "5V")),
                wire(("ring", "GND"), ("mcu", "GND")),
                wire(("strip", "DOUT"), ("ring", "DIN")),
            ],
        );
        s.set_clock(0, 0.0, 1e9);
        let mut t = 1_000;
        let level = |s: &mut CircuitSim, t: Cycles, h: bool| {
            let d = drives(s, |_| if h { Drive::High } else { Drive::Low });
            s.update(t, &d);
        };
        level(&mut s, 0, false);
        // Five LEDs' worth of GRB: two for the strip, three for the ring.
        let colours = [0x00FF00u32, 0x0000FF, 0xFF0000, 0x101010, 0x0000AA];
        for c in colours {
            for i in (0..24).rev() {
                let one = c >> i & 1 != 0;
                level(&mut s, t, true);
                level(&mut s, t + if one { 800 } else { 400 }, false);
                t += 1250;
            }
        }
        let v = s.end_frame(t + 100_000, 0.01);
        assert_eq!(visual(&v, "strip").leds, [0xFF0000, 0x0000FF]);
        assert_eq!(visual(&v, "ring").leds, [0x00FF00, 0x101010, 0x0000AA]);
        assert!(s.warnings.is_empty(), "{:?}", s.warnings);
    }

    // ------------------------------------------------------------ M21

    const MHZ: f64 = 16e6;

    fn at(t: f64) -> Cycles {
        (t * MHZ) as Cycles
    }

    /// An A4988 on PA0 (STEP), PA1 (DIR), PA4 (EN) with RST on SLP, VDD
    /// from 3V3, a 12 V supply on VMOT and a NEMA17 on its outputs
    /// (`swap_a`: coil A the other way round; `vmot`: wire the supply).
    fn a4988_sim(swap_a: bool, vmot: bool, props: &[(&str, &str)]) -> CircuitSim {
        let (ap, am) = if swap_a { ("A-", "A+") } else { ("A+", "A-") };
        let mut wires = vec![
            wire(("mcu", "PA0"), ("drv", "STEP")),
            wire(("mcu", "PA1"), ("drv", "DIR")),
            wire(("mcu", "PA4"), ("drv", "EN")),
            wire(("drv", "RST"), ("drv", "SLP")),
            wire(("mcu", "3V3"), ("drv", "VDD")),
            wire(("mcu", "GND"), ("drv", "GND")),
            wire(("bat", "-"), ("mcu", "GND")),
            wire(("drv", "1A"), ("mot", ap)),
            wire(("drv", "1B"), ("mot", am)),
            wire(("drv", "2A"), ("mot", "B+")),
            wire(("drv", "2B"), ("mot", "B-")),
        ];
        if vmot {
            wires.push(wire(("bat", "+"), ("drv", "VMOT")));
        }
        sim(
            vec![
                part("drv", "a4988", props),
                part("mot", "stepper-nema17", &[]),
                part("bat", "battery", &[("voltage", "12")]),
            ],
            wires,
        )
    }

    /// `n` STEP pulses (2 µs high) every `period` s from `t`; DIR, EN as given.
    fn step_pulses(s: &mut CircuitSim, t: &mut f64, n: u32, period: f64, dir: bool, en: bool) {
        for _ in 0..n {
            let lv = |step: bool| {
                [
                    ((0, 0), Some(step)),
                    ((0, 1), Some(dir)),
                    ((0, 4), Some(en)),
                ]
            };
            pins(s, at(*t), &lv(true));
            pins(s, at(*t + 2e-6), &lv(false));
            *t += period;
        }
    }

    fn motor(s: &mut CircuitSim, t: f64, id: &str) -> PartVisual {
        visual(&s.end_frame(at(t), 0.02), id).clone()
    }

    #[test]
    fn a4988_steps_the_nema17_through_the_nets() {
        let mut s = a4988_sim(false, true, &[]);
        let mut t = 0.01;
        step_pulses(&mut s, &mut t, 1, 0.01, true, false);
        t += 0.2;
        let start = motor(&mut s, t, "mot").motor.unwrap().steps;
        // 100 full steps (MS pins pulled low) at 400 steps/s.
        step_pulses(&mut s, &mut t, 100, 1.0 / 400.0, true, false);
        t += 0.2;
        let mv = motor(&mut s, t, "mot").motor.unwrap();
        assert!(
            (mv.steps - start - 100.0).abs() < 0.05,
            "{}",
            mv.steps - start
        );
        assert_eq!(mv.lost, 0);
        let d = motor(&mut s, t, "drv").motor.unwrap();
        assert_eq!(d.state, "on");
        assert_eq!(d.micro, 1);
        assert_eq!(d.steps, 101.0);
        // Both coils at 70.7 % on the full-step (45°) positions.
        assert!((mv.coils[0].abs() - 0.707).abs() < 0.01, "{:?}", mv.coils);
        // DIR low: back.
        step_pulses(&mut s, &mut t, 40, 1.0 / 400.0, false, false);
        t += 0.2;
        assert!((motor(&mut s, t, "mot").motor.unwrap().steps - start - 60.0).abs() < 0.05);
        assert!(s.warnings.is_empty(), "{:?}", s.warnings);
    }

    #[test]
    fn a_swapped_coil_turns_the_stepper_the_other_way() {
        let mut s = a4988_sim(true, true, &[]);
        let mut t = 0.01;
        step_pulses(&mut s, &mut t, 1, 0.01, true, false);
        t += 0.2;
        let start = motor(&mut s, t, "mot").motor.unwrap().steps;
        step_pulses(&mut s, &mut t, 100, 1.0 / 400.0, true, false);
        t += 0.2;
        assert!((motor(&mut s, t, "mot").motor.unwrap().steps - start - -100.0).abs() < 0.05);
    }

    #[test]
    fn a4988_without_vmot_or_with_en_high_does_not_move_it() {
        let mut s = a4988_sim(false, false, &[]);
        let mut t = 0.01;
        step_pulses(&mut s, &mut t, 50, 1.0 / 400.0, true, false);
        t += 0.2;
        assert!(motor(&mut s, t, "mot").motor.unwrap().steps.abs() < 0.6);
        assert_eq!(motor(&mut s, t, "drv").motor.unwrap().state, "no-vmot");
        assert!(
            s.warnings.iter().any(|w| w.starts_with("drv: VMOT is")),
            "{:?}",
            s.warnings
        );
        // EN high: the outputs are off, the shaft turns freely by hand.
        let mut s = a4988_sim(false, true, &[]);
        let mut t = 0.01;
        step_pulses(&mut s, &mut t, 50, 1.0 / 400.0, true, true);
        t += 0.2;
        let d = motor(&mut s, t, "drv").motor.unwrap();
        assert_eq!(d.state, "disabled");
        assert_eq!(d.coils, [0.0, 0.0]);
        assert!(motor(&mut s, t, "mot").motor.unwrap().steps.abs() < 0.6);
        set_props(&mut s, "mot", &[("turn", "36")], at(t));
        t += 0.3;
        assert!((motor(&mut s, t, "mot").motor.unwrap().steps - 20.0).abs() < 0.6);
        // Enabled again it holds: a turn by hand springs back.
        let lv = [
            ((0, 0), Some(false)),
            ((0, 1), Some(true)),
            ((0, 4), Some(false)),
        ];
        pins(&mut s, at(t), &lv);
        t += 0.3;
        let held = motor(&mut s, t, "mot").motor.unwrap().steps;
        set_props(&mut s, "mot", &[("turn", "37.8")], at(t));
        t += 0.3;
        assert!((motor(&mut s, t, "mot").motor.unwrap().steps - held).abs() < 0.05);
    }

    #[test]
    fn a4988_microsteps_reset_and_short_pulses() {
        // MS1 and MS2 high: eighth steps. 80 pulses = 10 full steps.
        let mut s = a4988_sim(false, true, &[]);
        let mut c = s.circuit.clone();
        c.wires.push(wire(("mcu", "3V3"), ("drv", "MS1")));
        c.wires.push(wire(("mcu", "3V3"), ("drv", "MS2")));
        s.set_circuit(&c, 0);
        let mut t = 0.01;
        step_pulses(&mut s, &mut t, 1, 0.01, true, false);
        t += 0.2;
        let start = motor(&mut s, t, "mot").motor.unwrap().steps;
        step_pulses(&mut s, &mut t, 80, 1.0 / 3200.0, true, false);
        t += 0.2;
        assert!((motor(&mut s, t, "mot").motor.unwrap().steps - start - 10.0).abs() < 0.05);
        assert_eq!(motor(&mut s, t, "drv").text.as_deref(), Some("1/8"));
        assert!(s.warnings.is_empty(), "{:?}", s.warnings);
        // A 0.5 µs STEP pulse.
        let lv = |step| {
            [
                ((0, 0), Some(step)),
                ((0, 1), Some(true)),
                ((0, 4), Some(false)),
            ]
        };
        pins(&mut s, at(t), &lv(true));
        pins(&mut s, at(t) + 8, &lv(false));
        assert!(
            s.warnings
                .iter()
                .any(|w| w.contains("STEP pulse only 0.50 µs")),
            "{:?}",
            s.warnings
        );
        // RST not connected: it floats, the driver stays in reset.
        let mut s = a4988_sim(false, true, &[]);
        let mut c = s.circuit.clone();
        c.wires.retain(|w| w.a.pin != "RST");
        s.set_circuit(&c, 0);
        let mut t = 0.01;
        step_pulses(&mut s, &mut t, 20, 1.0 / 400.0, true, false);
        t += 0.2;
        assert_eq!(motor(&mut s, t, "drv").motor.unwrap().state, "reset");
        assert!(motor(&mut s, t, "mot").motor.unwrap().steps.abs() < 0.6);
        assert!(
            s.warnings
                .iter()
                .any(|w| w.contains("RST is not connected")),
            "{:?}",
            s.warnings
        );
    }

    #[test]
    fn coil_across_two_bridges_warns_and_drv8825_has_32nd_steps() {
        let mut s = a4988_sim(false, true, &[("model", "DRV8825")]);
        let mut c = s.circuit.clone();
        for w in &mut c.wires {
            if w.a.pin == "1B" {
                w.b.pin = "B+".into();
            } else if w.a.pin == "2A" {
                w.b.pin = "A-".into();
            }
        }
        s.set_circuit(&c, 0);
        assert!(
            s.warnings
                .iter()
                .any(|w| w.starts_with("mot: coil A") && w.contains("drv.1A")),
            "{:?}",
            s.warnings
        );
        // DRV8825, M0–M2 high: 1/32.
        let mut s = a4988_sim(false, true, &[("model", "DRV8825")]);
        let mut c = s.circuit.clone();
        for ms in ["MS1", "MS2", "MS3"] {
            c.wires.push(wire(("mcu", "3V3"), ("drv", ms)));
        }
        s.set_circuit(&c, 0);
        let mut t = 0.01;
        step_pulses(&mut s, &mut t, 1, 0.01, true, false);
        t += 0.2;
        let start = motor(&mut s, t, "mot").motor.unwrap().steps;
        step_pulses(&mut s, &mut t, 320, 1.0 / 6400.0, true, false);
        t += 0.2;
        assert!((motor(&mut s, t, "mot").motor.unwrap().steps - start - 10.0).abs() < 0.05);
        assert_eq!(motor(&mut s, t, "drv").motor.unwrap().micro, 32);
        assert!(s.warnings.is_empty(), "{:?}", s.warnings);
    }

    #[test]
    fn stepping_too_fast_loses_steps_with_a_warning() {
        let mut s = a4988_sim(false, true, &[]);
        let mut t = 0.01;
        step_pulses(&mut s, &mut t, 1, 0.01, true, false);
        t += 0.2;
        step_pulses(&mut s, &mut t, 400, 1.0 / 2000.0, true, false);
        let m = motor(&mut s, t, "mot").motor.unwrap();
        assert!(m.lost > 0 && m.stalled, "{m:?}");
        assert!(
            s.warnings.iter().any(|w| w.starts_with("mot: lost steps")),
            "{:?}",
            s.warnings
        );
    }

    /// An L298N on PA0, PA1, PA4, PA6 (IN1–IN4), ENA/ENB on PB0/PB1 (or
    /// jumpers), 12 V on 12V, a NEMA17 on OUT1–OUT4.
    fn l298n_sim(jumpers: &str) -> CircuitSim {
        sim(
            vec![
                part("br", "l298n", &[("jumpers", jumpers)]),
                part("mot", "stepper-nema17", &[]),
                part("bat", "battery", &[("voltage", "12")]),
            ],
            vec![
                wire(("mcu", "PA0"), ("br", "IN1")),
                wire(("mcu", "PA1"), ("br", "IN2")),
                wire(("mcu", "PA4"), ("br", "IN3")),
                wire(("mcu", "PA6"), ("br", "IN4")),
                wire(("mcu", "PB0"), ("br", "ENA")),
                wire(("mcu", "PB1"), ("br", "ENB")),
                wire(("bat", "+"), ("br", "12V")),
                wire(("bat", "-"), ("br", "GND")),
                wire(("br", "GND"), ("mcu", "GND")),
                wire(("br", "OUT1"), ("mot", "A+")),
                wire(("br", "OUT2"), ("mot", "A-")),
                wire(("br", "OUT3"), ("mot", "B+")),
                wire(("br", "OUT4"), ("mot", "B-")),
            ],
        )
    }

    const IN_PINS: [(u8, u8); 4] = [(0, 0), (0, 1), (0, 4), (0, 6)];

    /// IN1–IN4 from the bits of `pattern`, ENA/ENB as given.
    fn coils(s: &mut CircuitSim, t: f64, pattern: u8, en: [bool; 2]) {
        let mut lv: Vec<((u8, u8), Option<bool>)> = IN_PINS
            .iter()
            .enumerate()
            .map(|(i, &p)| (p, Some(pattern >> i & 1 != 0)))
            .collect();
        lv.push(((1, 0), Some(en[0])));
        lv.push(((1, 1), Some(en[1])));
        pins(s, at(t), &lv);
    }

    #[test]
    fn l298n_half_steps_turn_the_stepper_and_a_wrong_order_jitters() {
        // Half steps A+, A+B+, B+, A−B+, A−, A−B−, B−, A+B− (IN1 = bit 0).
        const HALF: [u8; 8] = [
            0b0001, 0b0101, 0b0100, 0b0110, 0b0010, 0b1010, 0b1000, 0b1001,
        ];
        let mut s = l298n_sim("off");
        let mut t = 0.01;
        coils(&mut s, t, HALF[0], [true; 2]);
        t += 0.2;
        let start = motor(&mut s, t, "mot").motor.unwrap().steps;
        for k in 1..=80 {
            coils(&mut s, t, HALF[k % 8], [true; 2]);
            t += 0.004;
        }
        t += 0.2;
        let m = motor(&mut s, t, "mot").motor.unwrap();
        assert!(
            (m.steps - start - 40.0).abs() < 0.05,
            "80 half steps: {}",
            m.steps - start
        );
        assert_eq!(m.lost, 0);
        assert!(s.warnings.is_empty(), "{:?}", s.warnings);
        // 50 % PWM on ENA/ENB: the coil current averages to about half.
        for _ in 0..200 {
            coils(&mut s, t, HALF[0], [true; 2]);
            coils(&mut s, t + 0.0001, HALF[0], [false; 2]);
            t += 0.0002;
        }
        let m = motor(&mut s, t, "mot").motor.unwrap();
        assert!((m.coils[0] - 0.5).abs() < 0.1, "{:?}", m.coils);
        // IN1, IN2, IN3, IN4 one after the other (A+, A−, B+, B−): the field
        // jumps 180° and the rotor jitters.
        let wrong = [0b0001, 0b0010, 0b0100, 0b1000];
        let start = motor(&mut s, t, "mot").motor.unwrap().steps;
        for k in 0..40 {
            coils(&mut s, t, wrong[k % 4], [true; 2]);
            t += 0.01;
        }
        let m = motor(&mut s, t, "mot").motor.unwrap();
        assert!((m.steps - start).abs() < 20.0, "{}", m.steps - start);
        assert!(
            s.warnings.iter().any(|w| w.contains("jumped by 180°")),
            "{:?}",
            s.warnings
        );
    }

    #[test]
    fn l298n_jumpers_enable_the_bridges_and_ignore_ena() {
        let mut s = l298n_sim("on");
        coils(&mut s, 0.01, 0b0001, [false; 2]);
        let m = motor(&mut s, 0.3, "mot").motor.unwrap();
        assert!((m.coils[0] - 1.0).abs() < 0.01, "{:?}", m.coils);
        assert!(
            s.warnings.iter().any(|w| w.contains("ENA jumper is on")),
            "{:?}",
            s.warnings
        );
    }

    fn esc_sim(volts: &str) -> CircuitSim {
        sim(
            vec![
                part("esc", "esc-bldc", &[("kv", "1000")]),
                part("bat", "battery", &[("voltage", volts)]),
            ],
            vec![
                wire(("mcu", "PA0"), ("esc", "SIG")),
                wire(("esc", "GND"), ("mcu", "GND")),
                wire(("bat", "+"), ("esc", "BAT+")),
                wire(("bat", "-"), ("esc", "GND")),
            ],
        )
    }

    fn servo_pulses(s: &mut CircuitSim, t: &mut f64, secs: f64, us: f64) {
        let end = *t + secs;
        while *t < end {
            pins(s, at(*t), &[((0, 0), Some(true))]);
            pins(s, at(*t + us * 1e-6), &[((0, 0), Some(false))]);
            *t += 0.02;
        }
    }

    #[test]
    fn esc_arms_on_minimum_throttle_and_spins_up() {
        let mut s = esc_sim("11.1");
        let mut t = 0.01;
        servo_pulses(&mut s, &mut t, 0.5, 1000.0);
        assert_eq!(motor(&mut s, t, "esc").motor.unwrap().state, "arming");
        servo_pulses(&mut s, &mut t, 0.7, 1000.0);
        let v = motor(&mut s, t, "esc");
        assert_eq!(v.motor.as_ref().unwrap().state, "armed");
        assert_eq!(v.motor.unwrap().beeps, 2);
        servo_pulses(&mut s, &mut t, 2.5, 1600.0);
        let v = motor(&mut s, t, "esc");
        assert!((v.rpm.unwrap() - 0.6 * 11100.0).abs() < 50.0, "{:?}", v.rpm);
        assert!(s.warnings.is_empty(), "{:?}", s.warnings);
        // Signal lost.
        t += 0.6;
        assert_eq!(motor(&mut s, t, "esc").motor.unwrap().state, "failsafe");
        assert!(s.warnings.iter().any(|w| w.contains("failsafe")));
        // Without a battery (here: 3 V) it is off.
        let mut s = esc_sim("3");
        let mut t = 0.01;
        servo_pulses(&mut s, &mut t, 1.5, 1000.0);
        let v = motor(&mut s, t, "esc");
        assert!(v.unpowered);
        assert_eq!(v.motor.unwrap().state, "off");
    }

    /// A BLDC on a 3-phase bridge: INHA/INLA/INHB/INLB/INHC/INLC on
    /// PB0–PB5, halls A/B/C on PA8/PA9/PA10 (pull-ups from the MCU), 12 V.
    fn bldc_sim() -> CircuitSim {
        let mut wires = vec![
            wire(("bat", "+"), ("br", "PVDD")),
            wire(("bat", "-"), ("mcu", "GND")),
            wire(("br", "GND"), ("mcu", "GND")),
            wire(("mot", "GND"), ("mcu", "GND")),
            wire(("mcu", "5V"), ("mot", "VCC")),
            wire(("br", "OUTA"), ("mot", "U")),
            wire(("br", "OUTB"), ("mot", "V")),
            wire(("br", "OUTC"), ("mot", "W")),
            wire(("mot", "HA"), ("mcu", "PA8")),
            wire(("mot", "HB"), ("mcu", "PA9")),
            wire(("mot", "HC"), ("mcu", "PA10")),
        ];
        for (i, n) in ["INHA", "INLA", "INHB", "INLB", "INHC", "INLC"]
            .iter()
            .enumerate()
        {
            wires.push(wire(("mcu", &format!("PB{i}")), ("br", n)));
        }
        sim(
            vec![
                part("br", "bridge-3ph", &[]),
                part("mot", "bldc-hall", &[]),
                part("bat", "battery", &[("voltage", "12")]),
            ],
            wires,
        )
    }

    /// Run a six-step controller against the circuit for `secs`: on every
    /// circuit event it reads the halls and drives the bridge from the
    /// table; `pull_up`: the hall pins have their pull-ups.
    fn commutate(s: &mut CircuitSim, t: &mut f64, secs: f64, swap_ab: bool, pull_up: bool) {
        use crate::tier9::COMMUTATION;
        let end = *t + secs;
        let mut now = at(*t);
        let hall = |s: &CircuitSim, pin: u8| s.mcu_voltage(0, pin).is_some_and(|v| v > VDD / 2.0);
        let code_of = |s: &CircuitSim| {
            let (a, b, c) = (hall(s, 8), hall(s, 9), hall(s, 10));
            let (a, b) = if swap_ab { (b, a) } else { (a, b) };
            a as u8 | (b as u8) << 1 | (c as u8) << 2
        };
        let mut last: Option<Vec<Drive>> = None;
        loop {
            // The halls as they are now (an edge may be due), then the
            // bridge from the table, until they agree.
            let last = last.get_or_insert_with(|| {
                drives(s, |p| match p {
                    (0, 8..=10) if pull_up => Drive::PullUp,
                    _ => Drive::Float,
                })
            });
            s.update(now, last);
            for _ in 0..3 {
                let code = code_of(s);
                let mut on = [false; 6];
                if let Some(&(_, (h, l))) = COMMUTATION.iter().find(|x| x.0 == code) {
                    on[2 * h] = true;
                    on[2 * l + 1] = true;
                }
                let d = drives(s, |p| match p {
                    (1, i @ 0..=5) => {
                        if on[i as usize] {
                            Drive::High
                        } else {
                            Drive::Low
                        }
                    }
                    (0, 8..=10) if pull_up => Drive::PullUp,
                    _ => Drive::Float,
                });
                s.update(now, &d);
                *last = d;
                if code_of(s) == code {
                    break;
                }
            }
            // The next hall edge, or a look every millisecond; a few µs of
            // interrupt latency.
            let next = s
                .next_event()
                .map_or(now + at(1e-3), |e| e + 50)
                .min(now + at(1e-3));
            if next > at(end) {
                break;
            }
            now = next.max(now + 1);
        }
        *t = end;
    }

    #[test]
    fn bldc_on_a_3_phase_bridge_follows_its_hall_sensors() {
        let mut s = bldc_sim();
        let mut t = 0.01;
        commutate(&mut s, &mut t, 1.0, false, true);
        let v = motor(&mut s, t, "mot");
        let rpm = v.rpm.unwrap();
        assert!(rpm > 3000.0 && rpm < 3600.0, "{rpm}");
        assert!(!v.motor.unwrap().stalled);
        assert_eq!(v.text.as_deref().map(str::len), Some(3));
        let br = motor(&mut s, t, "br").motor.unwrap();
        assert_eq!(
            br.coils.iter().filter(|c| c.abs() > 0.5).count(),
            2,
            "{:?}",
            br.coils
        );
        assert!(s.warnings.is_empty(), "{:?}", s.warnings);
    }

    #[test]
    fn bldc_with_halls_mixed_up_stalls_and_without_pull_ups_warns() {
        let mut s = bldc_sim();
        let mut t = 0.01;
        commutate(&mut s, &mut t, 1.0, true, true);
        let v = motor(&mut s, t, "mot");
        assert!(v.rpm.unwrap().abs() < 300.0, "{:?}", v.rpm);
        assert!(v.motor.unwrap().stalled);
        assert!(
            s.warnings.iter().any(|w| w.contains("does not turn")),
            "{:?}",
            s.warnings
        );
        let mut s = bldc_sim();
        let mut t = 0.01;
        commutate(&mut s, &mut t, 0.05, false, false);
        motor(&mut s, t, "mot");
        motor(&mut s, t + 0.2, "mot");
        assert!(
            s.warnings.iter().any(|w| w.contains("floats when high")),
            "{:?}",
            s.warnings
        );
        // Both switches of a phase on: shoot-through.
        let d = drives(&s, |p| match p {
            (1, 0) | (1, 1) => Drive::High,
            _ => Drive::Float,
        });
        s.update(at(0.2), &d);
        assert!(
            !s.warnings.iter().any(|w| w.contains("shoot-through")),
            "not for an overlap of no time yet"
        );
        // A millisecond later: the display frame sees it still on.
        let br = motor(&mut s, 0.201, "br").motor.unwrap();
        assert!(br.shoot_through);
        assert!(
            s.warnings.iter().any(|w| w.contains("shoot-through")),
            "{:?}",
            s.warnings
        );
    }

    // ------------------------------------------------- M23: PWM on the bridge

    /// Six-step with PWM, as TIM1 does it: the phase to the supply chops
    /// at `duty` of a `period` with its low side the complement (`dead`
    /// time between them; `invert_low`: the low side's polarity wrong),
    /// the phase to ground on. The table is read at each period start.
    fn commutate_pwm(
        s: &mut CircuitSim,
        t: &mut f64,
        secs: f64,
        duty: f64,
        dead: f64,
        invert_low: bool,
    ) {
        use crate::tier9::COMMUTATION;
        let period = 50e-6;
        let hall = |s: &CircuitSim, pin: u8| s.mcu_voltage(0, pin).is_some_and(|v| v > VDD / 2.0);
        let end = *t + secs;
        let mut start = *t;
        while start < end {
            let code = hall(s, 8) as u8 | (hall(s, 9) as u8) << 1 | (hall(s, 10) as u8) << 2;
            let (h, l) = COMMUTATION
                .iter()
                .find(|x| x.0 == code)
                .map_or((9, 9), |x| x.1);
            // (time, high-side on, its low side on) through one period.
            let on = duty * period;
            let steps = [
                (0.0, false, false),
                (dead, true, false),
                (on, false, false),
                (on + dead, false, true),
            ];
            for (dt, hi, lo) in steps {
                let lo = lo ^ invert_low;
                let d = drives(s, |p| match p {
                    (1, i @ 0..=5) => {
                        let (ph, low) = (i as usize / 2, i % 2 == 1);
                        let level = if ph == h {
                            if low {
                                lo
                            } else {
                                hi
                            }
                        } else {
                            ph == l && low
                        };
                        if level {
                            Drive::High
                        } else {
                            Drive::Low
                        }
                    }
                    (0, 8..=10) => Drive::PullUp,
                    _ => Drive::Float,
                });
                s.update(at(start + dt), &d);
            }
            start += period;
        }
        *t = end;
    }

    #[test]
    fn bridge_averages_pwm_so_the_bldc_speed_follows_the_duty() {
        let rpm_at = |duty: f64| {
            let mut s = bldc_sim();
            let mut t = 0.01;
            commutate_pwm(&mut s, &mut t, 0.6, duty, 500e-9, false);
            let frame = s.end_frame(at(t), 0.6);
            let v = visual(&frame, "mot").clone();
            let br = visual(&frame, "br").motor.clone().unwrap();
            assert!(s.warnings.is_empty(), "{:?}", s.warnings);
            assert!(!br.shoot_through);
            (v.rpm.unwrap(), br)
        };
        let (slow, _) = rpm_at(0.25);
        let (half, br) = rpm_at(0.5);
        let (fast, _) = rpm_at(0.9);
        assert!(
            slow > 300.0 && slow < half && half < fast,
            "{slow} {half} {fast}"
        );
        // Speed about proportional to the duty (no-load 3300 rpm at 12 V).
        assert!((half - 0.5 * 3300.0).abs() < 400.0, "{half}");
        assert!((fast - 0.9 * 3300.0).abs() < 400.0, "{fast}");
        // The duty bars: each high side chops at 50 % for a third of the
        // time and its low side the rest of those periods; each low side is
        // also on for a third.
        assert_eq!(br.duty.len(), 6);
        for k in 0..3 {
            assert!(br.duty[k] > 0.0 && br.duty[k] < 0.5, "{:?}", br.duty);
            assert!(br.duty[3 + k] > br.duty[k], "{:?}", br.duty);
        }
    }

    #[test]
    fn a_chopping_phase_in_its_dead_time_stays_on_the_low_diode() {
        let mut s = bldc_sim();
        let mut t = 0.01;
        commutate_pwm(&mut s, &mut t, 0.1, 0.5, 500e-9, false);
        let k = s.phase_out["br"]
            .0
            .iter()
            .position(|d| matches!(d, PhaseDrive::Duty(_)))
            .expect("a chopping phase");
        // Both of its switches off, as in the dead time after the high
        // side: the motor current goes on through the low side's diode, so
        // the output is at ground (not floating at the star point).
        let mut d = s.drives.clone().unwrap()[..s.mcu.len()].to_vec();
        let pins = s.mcu_pins();
        for (i, p) in pins.iter().enumerate() {
            if *p == (1, 2 * k as u8) || *p == (1, 2 * k as u8 + 1) {
                d[i] = Drive::Low;
            }
        }
        s.update(at(t) + 2, &d);
        let out = ["br.OUTA", "br.OUTB", "br.OUTC"][k];
        assert_eq!(s.legs[k], Drive::Low);
        assert!(probe(&s, out).abs() < 0.5, "{}", probe(&s, out));
    }

    #[test]
    fn overlapping_switches_warn_of_shoot_through_and_dead_time_does_not() {
        // No dead time: the low side turns on as the high side turns off —
        // faster than the switch turns off.
        let mut s = bldc_sim();
        let mut t = 0.01;
        commutate_pwm(&mut s, &mut t, 0.02, 0.5, 0.0, false);
        let shoot = |s: &CircuitSim| s.warnings.iter().any(|w| w.contains("관통 전류"));
        assert!(shoot(&s), "{:?}", s.warnings);
        let br = motor(&mut s, t, "br").motor.unwrap();
        assert!(br.shoot_through);
        // 100 ns is shorter than the switch's turn-off time too.
        let mut s = bldc_sim();
        let mut t = 0.01;
        commutate_pwm(&mut s, &mut t, 0.02, 0.5, 100e-9, false);
        assert!(shoot(&s));
        // The low side's polarity inverted: on together with the high side.
        let mut s = bldc_sim();
        let mut t = 0.01;
        commutate_pwm(&mut s, &mut t, 0.02, 0.5, 500e-9, true);
        assert!(shoot(&s), "{:?}", s.warnings);
        // 500 ns of dead time: fine, and the frame says so.
        let mut s = bldc_sim();
        let mut t = 0.01;
        commutate_pwm(&mut s, &mut t, 0.05, 0.5, 500e-9, false);
        assert!(!shoot(&s), "{:?}", s.warnings);
        assert!(!motor(&mut s, t, "br").motor.unwrap().shoot_through);
    }

    #[test]
    fn a_bridge_whose_pwm_stops_lets_the_motor_coast() {
        let mut s = bldc_sim();
        let mut t = 0.01;
        commutate_pwm(&mut s, &mut t, 0.3, 0.6, 500e-9, false);
        let before = motor(&mut s, t, "mot").rpm.unwrap();
        assert!(before > 1000.0, "{before}");
        // Every input low (a break): one wake-up a PWM period later
        // finds the phases static — no more current.
        let d = drives(&s, |p| match p {
            (0, 8..=10) => Drive::PullUp,
            (1, 0..=5) => Drive::Low,
            _ => Drive::Float,
        });
        s.update(at(t), &d);
        let wake = s.next_event().expect("a wake-up for the stopped PWM");
        assert!(wake <= at(t + 60e-6), "{wake}");
        s.update(wake, &d);
        let v = motor(&mut s, t + 0.2, "mot");
        assert!(v.motor.unwrap().coils.iter().all(|c| c.abs() < 1e-9));
        let after = v.rpm.unwrap();
        assert!(
            after > 0.0 && after < before,
            "coasting down: {before} → {after}"
        );
    }

    #[test]
    fn a_bridge_whose_pwm_stops_wakes_the_simulation_to_let_go() {
        // Only a bridge: nothing else would look at it again.
        let mut s = sim(
            vec![
                part("br", "bridge-3ph", &[]),
                part("bat", "battery", &[("voltage", "12")]),
            ],
            vec![
                wire(("bat", "+"), ("br", "PVDD")),
                wire(("bat", "-"), ("mcu", "GND")),
                wire(("br", "GND"), ("mcu", "GND")),
                wire(("mcu", "PB0"), ("br", "INHA")),
            ],
        );
        let level = |s: &CircuitSim, on: bool| {
            drives(s, |p| match p {
                (1, 0) if on => Drive::High,
                (1, 0) => Drive::Low,
                _ => Drive::Float,
            })
        };
        let mut t = 0.01;
        for _ in 0..4 {
            let on = level(&s, true);
            s.update(at(t), &on);
            let off = level(&s, false);
            s.update(at(t + 15e-6), &off);
            t += 50e-6;
        }
        let duty = |s: &CircuitSim| match s.phase_out["br"].0[0] {
            PhaseDrive::Duty(d) => d,
            d => panic!("{d:?}"),
        };
        assert!((299..=301).contains(&duty(&s)), "{}", duty(&s));
        // No more edges: a wake-up just after the next one is overdue.
        let wake = s.next_event().expect("a wake-up for the stopped PWM");
        assert!(wake > at(t) && wake <= at(t + 20e-6), "{wake} vs {}", at(t));
        assert!((299..=301).contains(&duty(&s)));
        let off = level(&s, false);
        s.update(wake, &off);
        assert_eq!(s.phase_out["br"].0[0], PhaseDrive::Float);
        assert_eq!(s.next_event(), None);
    }

    // ------------------------------------- M28: windings in the nodal solve

    fn probe(s: &CircuitSim, name: &str) -> f64 {
        s.voltage(&s.probe_pin(name)).unwrap()
    }

    #[test]
    fn driver_outputs_show_their_voltage_and_the_mcu_reads_it() {
        // L298N, jumpers on, IN1 high: OUT1 at 12 V less one switch's drop
        // at the coil's current, OUT2 at one switch's drop above ground.
        let mut s = l298n_sim("off");
        let mut c = s.circuit.clone();
        // OUT1 through a 10 k / 4.7 k divider to PA7.
        c.parts.push(part("r1", "resistor", &[("ohms", "10k")]));
        c.parts.push(part("r2", "resistor", &[("ohms", "4.7k")]));
        c.wires.push(wire(("br", "OUT1"), ("r1", "1")));
        c.wires.push(wire(("r1", "2"), ("mcu", "PA7")));
        c.wires.push(wire(("mcu", "PA7"), ("r2", "1")));
        c.wires.push(wire(("r2", "2"), ("mcu", "GND")));
        s.set_circuit(&c, 0);
        coils(&mut s, 0.01, 0b0001, [true; 2]);
        let i = 12.0 / (STEPPER_COIL_R + 2.0 * L298N_R_ON);
        assert!((probe(&s, "br.OUT1") - (12.0 - i * L298N_R_ON)).abs() < 0.05);
        assert!((probe(&s, "br.OUT2") - i * L298N_R_ON).abs() < 0.05);
        assert!((probe(&s, "mot.A+") - probe(&s, "br.OUT1")).abs() < 1e-9);
        let pa7 = s.mcu_pins().iter().position(|&p| p == (0, 7)).unwrap();
        let level = |s: &mut CircuitSim, pattern: u8, t: f64| {
            let mut lv: Vec<((u8, u8), Option<bool>)> = IN_PINS
                .iter()
                .enumerate()
                .map(|(i, &p)| (p, Some(pattern >> i & 1 != 0)))
                .collect();
            lv.push(((1, 0), Some(true)));
            lv.push(((1, 1), Some(true)));
            let d = drives(s, |p| match lv.iter().find(|(q, _)| *q == p) {
                Some((_, Some(true))) => Drive::High,
                Some((_, Some(false))) => Drive::Low,
                _ => Drive::Float,
            });
            s.update(at(t), &d);
            s.inputs_now[pa7]
        };
        assert_eq!(level(&mut s, 0b0001, 0.02), Some(true), "OUT1 high");
        // IN1 low, IN2 high: OUT1 low, the coil the other way.
        assert_eq!(level(&mut s, 0b0010, 0.03), Some(false));
        assert!(probe(&s, "br.OUT1") < 1.5, "{}", probe(&s, "br.OUT1"));
        assert!(probe(&s, "br.OUT2") > 10.5);
        // An analog probe logs each change.
        s.set_voltage_probes(&["br.OUT1".to_string()], at(0.03));
        level(&mut s, 0b0001, 0.04);
        let log = s.take_voltage_log();
        assert_eq!(log.len(), 2, "{log:?}");
        assert!(log[0].1[0].unwrap() < 1.5 && log[1].1[0].unwrap() > 10.5);
        // A 3-phase bridge: OUTA high, OUTB low, OUTC off.
        let mut s = bldc_sim();
        let d = drives(&s, |p| match p {
            (1, 0) | (1, 3) => Drive::High,
            (1, _) => Drive::Low,
            (0, 8..=10) => Drive::PullUp,
            _ => Drive::Float,
        });
        s.update(at(0.01), &d);
        // Standing: the stall current through two phases, two switches and
        // the supply's own resistance.
        let i = 12.0 / (2.0 * BLDC_R + 2.0 * BRIDGE_R_ON + R_SUPPLY);
        let (a, b, c) = (
            probe(&s, "br.OUTA"),
            probe(&s, "br.OUTB"),
            probe(&s, "br.OUTC"),
        );
        assert!(
            (a - (12.0 - i * (R_SUPPLY + BRIDGE_R_ON))).abs() < 1e-3,
            "{a}"
        );
        assert!((b - i * BRIDGE_R_ON).abs() < 1e-3, "{b}");
        // OUTC floats at the star point, half way.
        assert!((c - (a + b) / 2.0).abs() < 1e-3, "{c}");
        assert!(
            !s.warnings.iter().any(|w| w.contains("short")),
            "{:?}",
            s.warnings
        );
    }

    #[test]
    fn a_series_resistor_limits_the_coil_current() {
        // Coil A through 25 Ω: 12 V over 25 + 25 + 2 × 2.5 Ω.
        let mut s = l298n_sim("off");
        let mut c = s.circuit.clone();
        c.parts.push(part("rs", "resistor", &[("ohms", "25")]));
        for w in &mut c.wires {
            if w.b.pin == "A+" {
                w.b = PinRef::new("rs", "1");
            }
        }
        c.wires.push(wire(("rs", "2"), ("mot", "A+")));
        s.set_circuit(&c, 0);
        coils(&mut s, 0.01, 0b0101, [true; 2]);
        let m = motor(&mut s, 0.3, "mot").motor.unwrap();
        let with_r = 12.0 / (2.0 * STEPPER_COIL_R + 2.0 * L298N_R_ON) / STEPPER_RATED;
        assert!(
            (m.coils[0] - with_r).abs() < 0.02,
            "{:?} vs {with_r}",
            m.coils
        );
        assert!((m.coils[1] - 1.0).abs() < 0.02, "{:?}", m.coils);
        // The drop across it shows: I × 25 Ω.
        let drop = probe(&s, "rs.1") - probe(&s, "rs.2");
        assert!(
            (drop - with_r * STEPPER_RATED * 25.0).abs() < 0.05,
            "{drop}"
        );
        // No wiring warning: one end through a resistor is a circuit.
        assert!(s.warnings.is_empty(), "{:?}", s.warnings);
        // And it still steps (half steps, slowly: less torque).
        const HALF: [u8; 8] = [
            0b0001, 0b0101, 0b0100, 0b0110, 0b0010, 0b1010, 0b1000, 0b1001,
        ];
        let mut t = 0.3;
        let start = motor(&mut s, t, "mot").motor.unwrap().steps;
        for k in 1..=40 {
            coils(&mut s, t, HALF[(k + 1) % 8], [true; 2]);
            t += 0.01;
        }
        t += 0.2;
        let m = motor(&mut s, t, "mot").motor.unwrap();
        assert!((m.steps - start - 20.0).abs() < 0.1, "{}", m.steps - start);
        // Stepping again and let go (both enables low): the open coils
        // show their back-EMF across them as the rotor turns on.
        for k in 0..12 {
            coils(&mut s, t, HALF[(k + 3) % 8], [true; 2]);
            t += 0.004;
        }
        coils(&mut s, t, HALF[7], [false; 2]);
        let (e, w) = {
            let m = &s.steppers["mot"];
            (m.emf_at(s.seconds_at(at(t))), m.omega)
        };
        assert!(w.abs() > 1.0, "{w}");
        for (k, (p, n)) in [("mot.A+", "mot.A-"), ("mot.B+", "mot.B-")]
            .iter()
            .enumerate()
        {
            let across = probe(&s, p) - probe(&s, n);
            assert!(
                (across - e[k]).abs() < 1e-3 + 0.01 * e[k].abs(),
                "{across} vs {e:?}"
            );
        }
        assert!(e[0].abs().max(e[1].abs()) > 0.05, "{e:?}");
        // Without the resistor (the plain L298N) the coil gets 1.0.
        let mut s = l298n_sim("off");
        coils(&mut s, 0.01, 0b0101, [true; 2]);
        let m = motor(&mut s, 0.3, "mot").motor.unwrap();
        assert!((m.coils[0] - 1.0).abs() < 0.02, "{:?}", m.coils);
    }

    #[test]
    fn a_floating_phase_shows_the_back_emf_on_top_of_the_star_point() {
        let mut s = bldc_sim();
        let mut t = 0.01;
        commutate(&mut s, &mut t, 0.5, false, true);
        assert!(motor(&mut s, t, "mot").rpm.unwrap() > 2500.0);
        // Look at it between hall edges: one phase high, one low, one off.
        let mut seen = 0;
        let mut signs = BTreeSet::new();
        for _ in 0..200 {
            t += 0.37e-3;
            let d = s.drives.clone().unwrap()[..s.mcu.len()].to_vec();
            s.update(at(t), &d);
            let st = &s.phase_out["br"].0;
            let Some(w) = st.iter().position(|d| *d == PhaseDrive::Float) else {
                continue;
            };
            let Some(Device::Bldc(b)) = s.devices.get("mot") else {
                panic!()
            };
            let e = b.emf_at(s.seconds_at(at(t)));
            let names = ["br.OUTA", "br.OUTB", "br.OUTC"];
            let (u, v) = ((w + 1) % 3, (w + 2) % 3);
            // V(W) − mean of the driven two = e_W − (e_U + e_V)/2.
            let mid = (probe(&s, names[u]) + probe(&s, names[v])) / 2.0;
            let got = probe(&s, names[w]) - mid;
            let want = e[w] - (e[u] + e[v]) / 2.0;
            assert!((got - want).abs() < 0.05, "{got} vs {want}");
            signs.insert(got > 0.0);
            seen += 1;
        }
        assert!(seen > 100);
        assert_eq!(signs.len(), 2, "it crosses zero");
        // Let go: every phase floats, a virtual neutral (3 × 10 kΩ) shows
        // each phase's back-EMF.
        let mut c = s.circuit.clone();
        for (k, ph) in ["U", "V", "W"].iter().enumerate() {
            let id = format!("rn{k}");
            c.parts.push(part(&id, "resistor", &[("ohms", "10k")]));
            c.wires.push(wire(("mot", ph), (&id, "1")));
            c.wires.push(wire((&id, "2"), ("rn0", "2")));
        }
        s.set_circuit(&c, at(t));
        let off = drives(&s, |p| match p {
            (0, 8..=10) => Drive::PullUp,
            (1, _) => Drive::Low,
            _ => Drive::Float,
        });
        s.update(at(t), &off);
        t += 1e-3;
        s.update(at(t), &off);
        s.set_voltage_probes(&["mot.U".into(), "rn0.2".into()], at(t));
        let Some(Device::Bldc(b)) = s.devices.get("mot") else {
            panic!()
        };
        let e = b.emf_at(s.seconds_at(at(t)));
        let u = probe(&s, "mot.U") - probe(&s, "rn0.2");
        assert!(e[0].abs() > 0.5, "{e:?}");
        assert!((u - e[0]).abs() < 0.01 * e[0].abs() + 1e-3, "{u} vs {e:?}");
        // While it coasts the probe is sampled without anything changing:
        // every 20 µs (the halls change only every few hundred µs).
        let step = (EMF_PROBE_INTERVAL * MHZ) as Cycles + 1;
        let mut now = at(t);
        for _ in 0..20 {
            let next = s.next_event().expect("a sample of the moving probe");
            assert!(next > now && next <= now + step, "{next} after {now}");
            s.update(next, &off);
            now = next;
        }
        let log = s.take_voltage_log();
        assert!(
            log.len() >= 20 && log[0].1[0] != log[1].1[0],
            "{}",
            log.len()
        );
    }

    #[test]
    fn a4988_outputs_drive_each_coil_one_way_at_the_regulated_current() {
        let mut s = a4988_sim(false, true, &[]);
        let mut t = 0.01;
        step_pulses(&mut s, &mut t, 1, 0.01, true, false);
        t += 0.2;
        // One full step from home (45°) to 135°: coil 1 at −70.7 %, coil 2
        // at +70.7 %.
        let m = motor(&mut s, t, "mot").motor.unwrap();
        assert!(m.coils[0] < -0.6 && m.coils[1] > 0.6, "{:?}", m.coils);
        let (i1, i2) = (-m.coils[0] * STEPPER_RATED, m.coils[1] * STEPPER_RATED);
        let vmot = probe(&s, "drv.VMOT");
        assert!(vmot > 11.9);
        // Coil 1 driven backwards: 1A to GND, 1B to VMOT, each through
        // the switch's resistance at the regulated current.
        let (a1, b1) = (probe(&s, "drv.1A"), probe(&s, "drv.1B"));
        assert!((a1 - i1 * A4988_R_ON).abs() < 1e-3, "{a1}");
        assert!((b1 - (vmot - i1 * A4988_R_ON)).abs() < 1e-3, "{b1} {vmot}");
        // Coil 2 forwards: 2A to VMOT, 2B to GND.
        let (a2, b2) = (probe(&s, "drv.2A"), probe(&s, "drv.2B"));
        assert!((a2 - (vmot - i2 * A4988_R_ON)).abs() < 1e-3, "{a2}");
        assert!((b2 - i2 * A4988_R_ON).abs() < 1e-3, "{b2}");
        // Two more steps (315°): both turned round.
        step_pulses(&mut s, &mut t, 2, 0.01, true, false);
        t += 0.2;
        let m = motor(&mut s, t, "mot").motor.unwrap();
        assert!(m.coils[0] > 0.6 && m.coils[1] < -0.6, "{:?}", m.coils);
        assert!(probe(&s, "drv.1A") > 11.5 && probe(&s, "drv.1B") < 0.5);
        assert!(probe(&s, "drv.2A") < 0.5 && probe(&s, "drv.2B") > 11.5);
        // Disabled: the outputs let go.
        step_pulses(&mut s, &mut t, 1, 0.01, true, true);
        t += 0.2;
        motor(&mut s, t, "mot");
        assert!((probe(&s, "drv.1A") - probe(&s, "drv.1B")).abs() < 1e-3);
    }

    /// A sensorless BLDC on a 3-phase bridge (INH/INL on PB0–PB5), each
    /// phase through 10 k / 2.2 k to PA1, PA4, PC1, and a virtual neutral
    /// (10 k from each of those) on PC0.
    fn sensorless_sim() -> CircuitSim {
        let mut parts = vec![
            part("br", "bridge-3ph", &[]),
            part("mot", "bldc", &[]),
            part("bat", "battery", &[("voltage", "12")]),
        ];
        let mut wires = vec![
            wire(("bat", "+"), ("br", "PVDD")),
            wire(("bat", "-"), ("mcu", "GND")),
            wire(("br", "GND"), ("mcu", "GND")),
        ];
        for (i, n) in ["INHA", "INLA", "INHB", "INLB", "INHC", "INLC"]
            .iter()
            .enumerate()
        {
            wires.push(wire(("mcu", &format!("PB{i}")), ("br", n)));
        }
        for (out, ph, pin) in [
            ("OUTA", "U", "PA1"),
            ("OUTB", "V", "PA4"),
            ("OUTC", "W", "PC1"),
        ] {
            let (a, b, n) = (format!("{ph}1"), format!("{ph}2"), format!("{ph}n"));
            parts.push(part(&a, "resistor", &[("ohms", "10k")]));
            parts.push(part(&b, "resistor", &[("ohms", "2.2k")]));
            parts.push(part(&n, "resistor", &[("ohms", "10k")]));
            wires.push(wire(("br", out), ("mot", ph)));
            wires.push(wire(("br", out), (&a, "1")));
            wires.push(wire((&a, "2"), (&b, "1")));
            wires.push(wire((&b, "2"), ("mcu", "GND")));
            wires.push(wire((&a, "2"), ("mcu", pin)));
            wires.push(wire((&a, "2"), (&n, "1")));
            wires.push(wire((&n, "2"), ("mcu", "PC0")));
        }
        sim(parts, wires)
    }

    /// The firmware's sensorless six-step (`hal-bldc-sensorless`) in Rust:
    /// 20 kHz PWM on the high side (`duty`), the floating phase and the
    /// neutral read at the middle of the on-time, a commutation half a step
    /// after each zero crossing; aligned and ramped open loop first.
    /// Returns (commutations, crossings) in closed loop and, for each
    /// crossing, the floating phase's back-EMF over its amplitude then.
    fn sensorless_run(s: &mut CircuitSim, secs: f64, duty: f64) -> (u32, u32, Vec<f64>) {
        const HIGH: [usize; 6] = [0, 1, 1, 2, 2, 0];
        const LOW: [usize; 6] = [2, 2, 0, 0, 1, 1];
        const FLOAT: [usize; 6] = [1, 0, 2, 1, 0, 2];
        const RISING: [bool; 6] = [true, false, true, false, true, false];
        const SENSE: [(u8, u8); 3] = [(0, 1), (0, 4), (2, 1)];
        let period = 50e-6;
        let (mut step, mut comm_at, mut step_len) = (0usize, 0.0, 0.02);
        let mut ramp = 0.02;
        let mut due: Option<f64> = None;
        let mut zc_seen = false;
        let (mut comms, mut zcs, mut emf_at_zc) = (0, 0, Vec::new());
        let mut t = 0.0;
        let align = 0.5;
        let mut closed = false;
        while t < secs {
            // The bridge for this period: on for duty × period, the low
            // side the complement, 500 ns of dead time between them.
            let dead = 500e-9;
            let phases = [
                (0.0, false, false),
                (dead, true, false),
                (duty * period, false, false),
                (duty * period + dead, false, true),
            ];
            for (dt, on, comp) in phases {
                let d = drives(s, |p| match p {
                    (1, i @ 0..=5) => {
                        let (ph, low) = (i as usize / 2, i % 2 == 1);
                        let level = if ph == HIGH[step] {
                            if low {
                                comp
                            } else {
                                on
                            }
                        } else {
                            ph == LOW[step] && low
                        };
                        if level {
                            Drive::High
                        } else {
                            Drive::Low
                        }
                    }
                    _ => Drive::Float,
                });
                s.update(at(t + dt), &d);
                if !on {
                    continue;
                }
                // Middle of the on-time: sample.
                let ts = t + duty * period / 2.0;
                s.refresh(at(ts));
                let v = |p: (u8, u8)| s.mcu_voltage(p.0, p.1).unwrap();
                let diff = v(SENSE[FLOAT[step]]) - v((2, 0));
                let since = ts - comm_at;
                if closed && !zc_seen && since > step_len / 4.0 && (diff > 0.0) == RISING[step] {
                    zc_seen = true;
                    zcs += 1;
                    due = Some(ts + since);
                    let Some(Device::Bldc(b)) = s.devices.get("mot") else {
                        panic!()
                    };
                    let e = b.emf_at(s.seconds_at(at(ts)));
                    let amp = e.iter().map(|x| x.abs()).fold(0.0, f64::max);
                    emf_at_zc.push(e[FLOAT[step]] / amp);
                }
            }
            t += period;
            if t < align {
                continue;
            }
            let next = due.get_or_insert(t + ramp);
            if t >= *next {
                step = (step + 1) % 6;
                step_len = (3.0 * step_len + (t - comm_at)) / 4.0;
                comm_at = t;
                zc_seen = false;
                due = None;
                if closed {
                    comms += 1;
                } else {
                    ramp *= 31.0 / 32.0;
                    closed = ramp <= 0.004;
                }
            }
        }
        (comms, zcs, emf_at_zc)
    }

    #[test]
    fn sensorless_bldc_runs_on_its_back_emf_zero_crossings() {
        let mut s = sensorless_sim();
        let (comms, zcs, emf) = sensorless_run(&mut s, 2.5, 0.5);
        let v = motor(&mut s, 2.5, "mot");
        let rpm = v.rpm.unwrap();
        // Half the supply: about half the no-load speed.
        assert!(rpm > 1300.0 && rpm < 1900.0, "{rpm}");
        assert!(comms > 300, "{comms}");
        // Every commutation came from a crossing.
        assert!(zcs + 2 >= comms, "{zcs} crossings, {comms} commutations");
        // After the hand-over from the ramp (the rotor lags the open-loop
        // field then), each crossing is found within a sample of the real
        // one: the floating phase's back-EMF is then near zero.
        let worst = emf[5..].iter().map(|e| e.abs()).fold(0.0, f64::max);
        assert!(worst < 0.1, "{worst}");
        assert!(s.warnings.is_empty(), "{:?}", s.warnings);
        // No sensorless part: the hall motor's halls are not needed.
        assert!(motor(&mut s, 2.5, "mot").text.is_none());
    }
}
