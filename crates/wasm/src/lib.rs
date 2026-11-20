//! WebAssembly entry points. The simulator runs inside a Web Worker; the UI
//! thread receives visual-state snapshots (see `docs/architecture.md`).

use std::collections::{BTreeMap, HashMap};

use serde_json::json;
use wasm_bindgen::prelude::*;

use simucleo_circuit::netlist::{build_netlist, BusCatalog, Circuit};
use simucleo_circuit::sim::parse_mcu_pin;

use simucleo_core::cortexm::exc;
use simucleo_nucleo::{Nucleo, Step, StepEnd, SynthEdge, WireSignal};

pub mod decode;
pub mod scope;
use scope::Scope;

/// An analog probe: the voltage of a net.
#[derive(Debug, Clone)]
struct AnalogProbe {
    /// What it measures: `"PA1"` or `"part.pin"`.
    spec: String,
    /// Channel name, `"V(PA1)"`.
    name: String,
    /// The MCU pin, for a spec that names one.
    mcu: Option<(u8, u8)>,
    /// The circuit puts the pin on a net (else an MCU pin's voltage
    /// follows its logic level).
    on_net: bool,
    /// Voltage as last pushed, and at the start of the display frame.
    v: f64,
    frame_v0: f64,
    /// Samples in this frame (ms, V), capped, and whether some did not fit.
    samples: Vec<(f64, f64)>,
    dense: bool,
}

/// A probe sample waiting to go to the scope in time order.
#[derive(Debug, Clone, Copy)]
enum Pending {
    Edge(usize, bool),
    Volt(usize, f64),
}

/// Level history of one GPIO pin within the current display frame.
#[derive(Debug, Clone, Copy, Default)]
struct PinTrace {
    level: bool,
    driven: bool,
    since_ns: f64,
    high_ns: f64,
}

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[wasm_bindgen]
pub struct Simulator {
    board: Nucleo,
    catalog: BusCatalog,
    /// Why the firmware stopped, once it has.
    stopped: Option<String>,
    pins: BTreeMap<(u8, u8), PinTrace>,
    frame_start_ns: f64,
    /// Probed pins with their level at the start of the frame.
    probes: Vec<((u8, u8), bool)>,
    /// Edges of each probed pin in this frame (ms, level), capped at
    /// `PROBE_EDGES_MAX`, and whether some did not fit.
    probe_edges: Vec<(Vec<(f64, bool)>, bool)>,
    /// Level of each probed pin as last given to the scope.
    probe_level: Vec<bool>,
    /// The byte-level signal (USART, I2C, SPI) each probed pin carries:
    /// its edges are synthesized from the bytes, not read from the GPIO.
    synth: Vec<Option<WireSignal>>,
    /// Time of each probe's last synthesized edge (ns).
    synth_last: Vec<f64>,
    /// Analog probes (net voltages).
    analog: Vec<AnalogProbe>,
    /// Edges and samples not given to the scope yet: synthesized I2C and
    /// SPI bytes are logged when they end, so everything waits
    /// `holdback_ns` to go to the scope in time order.
    pending: Vec<(f64, Pending)>,
    holdback_ns: f64,
    /// Time of the last `feed_scope` (ns).
    fed_ns: f64,
    wire_buf: Vec<SynthEdge>,
    /// Trigger and capture over the probed pins.
    scope: Scope,
    /// The last run stopped because a capture completed with "pause on
    /// trigger" set.
    trigger_paused: bool,
    /// RTOS task running at the start of the frame (TCB address).
    rtos_current: Option<u32>,
    /// The last run stopped at a breakpoint.
    at_breakpoint: bool,
    /// The access that hit a watchpoint in the last run: (address, write).
    watch_hit: Option<(u32, bool)>,
}

/// Most context switches reported per frame.
const SWITCHES_MAX: usize = 4000;

/// Most edges reported per probe and frame; faster signals are marked dense.
const PROBE_EDGES_MAX: usize = 4000;

impl Default for Simulator {
    fn default() -> Self {
        Self::new()
    }
}

#[wasm_bindgen]
impl Simulator {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            board: Nucleo::new(),
            catalog: BusCatalog::default(),
            stopped: None,
            pins: BTreeMap::new(),
            frame_start_ns: 0.0,
            probes: Vec::new(),
            probe_edges: Vec::new(),
            probe_level: Vec::new(),
            synth: Vec::new(),
            synth_last: Vec::new(),
            analog: Vec::new(),
            pending: Vec::new(),
            holdback_ns: 0.0,
            fed_ns: 0.0,
            wire_buf: Vec::new(),
            scope: Scope::new(),
            trigger_paused: false,
            rtos_current: None,
            at_breakpoint: false,
            watch_hit: None,
        }
    }

    /// Load an uploaded ELF file and reset the core.
    #[wasm_bindgen(js_name = loadElf)]
    pub fn load_elf(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        self.board.load_elf(bytes)?;
        self.after_reset();
        Ok(())
    }

    /// Press the reset button (B2).
    pub fn reset(&mut self) -> Result<(), JsError> {
        self.board.reset()?;
        self.after_reset();
        Ok(())
    }

    fn after_reset(&mut self) {
        self.stopped = None;
        self.pins.clear();
        self.board.take_pin_events();
        self.board.bus.level_events.clear();
        // Loading firmware builds a new bus: keep probing the same pins.
        self.apply_probe_mask();
        self.board.bus.take_wire_events();
        self.frame_start_ns = self.board.time_ns();
        self.fed_ns = self.frame_start_ns;
        for (pin, level) in &mut self.probes {
            *level = self.board.pin((b'A' + pin.0) as char, pin.1);
        }
        for e in &mut self.probe_edges {
            *e = (Vec::new(), false);
        }
        let levels: Vec<bool> = self.probes.iter().map(|p| p.1).collect();
        self.probe_level = levels.clone();
        self.synth = vec![None; self.probes.len()];
        self.synth_last = vec![f64::MIN; self.probes.len()];
        self.pending.clear();
        self.holdback_ns = 0.0;
        let specs: Vec<String> = self.analog.iter().map(|a| a.spec.clone()).collect();
        self.board.set_voltage_probes(&specs);
        self.board.take_voltage_log();
        self.read_analog();
        let volts: Vec<f64> = self.analog.iter().map(|a| a.v).collect();
        self.scope.reset(&levels, &volts);
        self.trigger_paused = false;
        // Start a fresh display frame for the parts as well.
        self.board.circuit_frame(0.0);
        self.board.take_task_switches();
        self.rtos_current = None;
    }

    /// Whether the firmware has stopped (see [`Simulator::run_for_ms`]).
    pub fn stopped(&self) -> bool {
        self.stopped.is_some()
    }

    pub fn pc(&self) -> u32 {
        self.board.cpu.registers().pc()
    }

    /// Run for a simulated duration. Returns `""` while the firmware is
    /// running normally, otherwise an explanation of why it stopped.
    #[wasm_bindgen(js_name = runForMs)]
    pub fn run_for_ms(&mut self, ms: f64) -> String {
        if let Some(why) = &self.stopped {
            return why.clone();
        }
        self.trigger_paused = false;
        let end = self.board.time_ns() + ms * 1e6;
        loop {
            let now = self.board.time_ns();
            // With "pause on trigger", short steps: the run stops soon after
            // the capture's end.
            let mut ns = end - now;
            if self.scope.watching_for_pause() {
                // (The scope is `holdback_ns` behind.)
                ns = ns.min(self.scope.step_ns(now - self.holdback_ns));
            }
            let r = self.board.run_for_ns_debug(ns);
            self.feed_scope();
            self.at_breakpoint = matches!(
                r.stop,
                simucleo_core::cpu::StopReason::Breakpoint(_)
                    | simucleo_core::cpu::StopReason::Watchpoint { .. }
            );
            self.watch_hit = match r.stop {
                simucleo_core::cpu::StopReason::Watchpoint { addr, write } => Some((addr, write)),
                _ => None,
            };
            if let Some(d) = self.board.diagnose(&r) {
                let why = d.to_string();
                self.stopped = Some(why.clone());
                return why;
            }
            if self.scope.take_pause_hit() {
                self.trigger_paused = true;
                break;
            }
            let t = self.board.time_ns();
            if self.at_breakpoint || t >= end || t <= now {
                break;
            }
        }
        String::new()
    }

    /// Probe the digital pins and the MCU pins of the analog probes.
    fn apply_probe_mask(&mut self) {
        let mut mask = [0u16; 8];
        let pins = self.probes.iter().map(|p| p.0);
        for (port, pin) in pins.chain(self.analog.iter().filter_map(|a| a.mcu)) {
            mask[port as usize] |= 1 << pin;
        }
        self.board.bus.probe_mask = mask;
        self.board.bus.sync_wire_logging();
    }

    /// Present voltages of the analog probes (an MCU pin on no net: its
    /// drive's voltage).
    fn read_analog(&mut self) {
        let volts = self.board.probe_voltages();
        for (a, v) in self.analog.iter_mut().zip(volts) {
            a.on_net = v.is_some();
            a.v = match (v, a.mcu) {
                (Some(v), _) => v,
                (None, Some((port, pin))) => self.board.bus.pin_voltage(port, pin),
                (None, None) => 0.0,
            };
            a.frame_v0 = a.v;
        }
    }

    /// Nanoseconds at a fractional core cycle.
    fn ns_at_cycle(&self, c: f64) -> f64 {
        let whole = c.max(0.0).floor();
        self.board.ns_at(whole as u64) + (c - whole) * 1e9 / self.board.clock_hz().max(1) as f64
    }

    /// Move the probed pins' level changes, the synthesized edges of the
    /// byte-level peripherals and the analog probes' voltages from the bus
    /// to this frame's lists and to the trigger, in time order.
    fn feed_scope(&mut self) {
        let now = self.board.time_ns();
        // Pins newly routed to (or released by) a USART, I2C or SPI.
        for (i, &((port, pin), _)) in self.probes.iter().enumerate() {
            let sig = self.board.bus.wire_signal(port, pin);
            if sig.is_some() != self.synth[i].is_some() {
                let level = match sig {
                    Some(s) => s.idle().unwrap_or(self.probe_level[i]),
                    None => self.board.pin((b'A' + port) as char, pin),
                };
                let t = self.fed_ns.max(self.synth_last[i]);
                self.pending.push((t, Pending::Edge(i, level)));
                self.synth_last[i] = t;
            }
            self.synth[i] = sig;
        }
        let events = std::mem::take(&mut self.board.bus.level_events);
        for e in &events {
            let t = self.board.ns_at(e.time);
            let level = e.level == Some(true);
            if let Some(ch) = self.probes.iter().position(|p| p.0 == (e.port, e.pin)) {
                if self.synth[ch].is_none() {
                    self.pending.push((t, Pending::Edge(ch, level)));
                }
            }
            for (k, a) in self.analog.iter().enumerate() {
                if a.mcu == Some((e.port, e.pin)) && !a.on_net {
                    let v = if level {
                        simucleo_circuit::sim::VDD
                    } else {
                        0.0
                    };
                    self.pending.push((t, Pending::Volt(k, v)));
                }
            }
        }
        // Keep the allocation.
        self.board.bus.level_events = events;
        self.board.bus.level_events.clear();
        // Bytes the peripherals moved, drawn bit by bit.
        let wire = self.board.bus.take_wire_events();
        let ns_per_cycle = 1e9 / self.board.clock_hz().max(1) as f64;
        let mut buf = std::mem::take(&mut self.wire_buf);
        for ev in &wire {
            self.holdback_ns = self.holdback_ns.max(ev.latency() * ns_per_cycle);
            buf.clear();
            ev.edges(&mut buf);
            for e in &buf {
                let Some(ch) = self.probes.iter().position(|p| p.0 == e.pin) else {
                    continue;
                };
                if self.synth[ch].is_none() {
                    continue;
                }
                // In time order per pin, even where two transfers overlap.
                let t = self.ns_at_cycle(e.time).max(self.synth_last[ch]);
                self.synth_last[ch] = t;
                self.pending.push((t, Pending::Edge(ch, e.level)));
            }
        }
        self.wire_buf = buf;
        // Voltages, at each change of the circuit's operating point.
        if !self.analog.is_empty() {
            for (cycle, volts) in self.board.take_voltage_log() {
                let t = self.board.ns_at(cycle);
                for (k, v) in volts.into_iter().enumerate() {
                    if let Some(a) = self.analog.get_mut(k) {
                        a.on_net = v.is_some();
                        if let Some(v) = v {
                            self.pending.push((t, Pending::Volt(k, v)));
                        }
                    }
                }
            }
        }
        self.fed_ns = now;
        self.flush_pending(now - self.holdback_ns);
    }

    /// Give the scope and the frame's lists what is pending up to `until`
    /// (ns), and tell it time has passed that far (no further than now).
    fn flush_pending(&mut self, until: f64) {
        if self.pending.is_empty() {
            self.scope.advance(until.min(self.fed_ns));
            return;
        }
        // (Stable: what happened at the same time keeps its order.)
        self.pending.sort_by(|a, b| a.0.total_cmp(&b.0));
        let n = self.pending.partition_point(|p| p.0 <= until);
        for (t, p) in self.pending.drain(..n) {
            match p {
                Pending::Edge(ch, level) => {
                    if self.probe_level.get(ch) == Some(&level) {
                        continue;
                    }
                    self.probe_level[ch] = level;
                    self.scope.push(ch, t, level);
                    if let Some((edges, dense)) = self.probe_edges.get_mut(ch) {
                        if edges.len() >= PROBE_EDGES_MAX {
                            *dense = true;
                        } else {
                            edges.push((t / 1e6, level));
                        }
                    }
                }
                Pending::Volt(k, v) => {
                    let Some(a) = self.analog.get_mut(k) else {
                        continue;
                    };
                    if a.v == v {
                        continue;
                    }
                    a.v = v;
                    self.scope.push_analog(k, t, v);
                    if a.samples.len() >= PROBE_EDGES_MAX {
                        a.dense = true;
                    } else {
                        a.samples.push((t / 1e6, v));
                    }
                }
            }
        }
        self.scope.advance(until.min(self.fed_ns));
    }

    /// The last `runForMs` paused because a capture completed with "pause
    /// on trigger" set.
    #[wasm_bindgen(js_name = triggerPaused)]
    pub fn trigger_paused(&self) -> bool {
        self.trigger_paused
    }

    /// Set the oscilloscope trigger from JSON `{source, edge, mode,
    /// windowNs, pre, width?: {cmp, ns}, pause, level?, hysteresis?}` (the
    /// source a probed pin or an analog channel `"V(…)"`, which triggers
    /// on its voltage going through `level` volts; `edge`: `"rising"`,
    /// `"falling"`, `"either"`; `mode`: `"auto"`, `"normal"`, `"single"`;
    /// `cmp`: `"lt"`, `"gt"`), or clear it with `""`. Re-arms.
    #[wasm_bindgen(js_name = setTrigger)]
    pub fn set_trigger(&mut self, json: &str) -> Result<(), JsError> {
        let config = if json.is_empty() {
            None
        } else {
            Some(serde_json::from_str(json)?)
        };
        self.scope.configure(config);
        Ok(())
    }

    /// Wait for the next trigger (Single mode's re-arm).
    #[wasm_bindgen(js_name = armTrigger)]
    pub fn arm_trigger(&mut self) {
        self.scope.arm();
    }

    /// The last `runForMs` stopped at a breakpoint or watchpoint (the
    /// caller pauses).
    #[wasm_bindgen(js_name = atBreakpoint)]
    pub fn at_breakpoint(&self) -> bool {
        self.at_breakpoint
    }

    /// Why the last `runForMs` paused: `"breakpoint"`, or
    /// `"watchpoint"` with the access (`"watchpoint write 0x20000010"`).
    #[wasm_bindgen(js_name = pauseReason)]
    pub fn pause_reason(&self) -> String {
        match self.watch_hit {
            Some((addr, write)) => {
                format!(
                    "watchpoint {} 0x{addr:08x}",
                    if write { "write" } else { "read" }
                )
            }
            None => "breakpoint".into(),
        }
    }

    /// Set the data watchpoints from JSON `[{expr, kind}]` (`kind`:
    /// `"write"`, `"read"` or `"access"`), each expression naming memory
    /// as seen from frame `frame`. Returns `[{addr, len} | {error}]`.
    #[wasm_bindgen(js_name = setWatchpoints)]
    pub fn set_watchpoints(&mut self, json: &str, frame: usize) -> Result<String, JsError> {
        use simucleo_core::cpu::{WatchKind, Watchpoint};
        #[derive(serde::Deserialize)]
        struct W {
            expr: String,
            kind: String,
        }
        let list: Vec<W> = serde_json::from_str(json)?;
        let mut set = Vec::new();
        let out: Vec<serde_json::Value> = list
            .iter()
            .map(|w| match self.board.address_of(&w.expr, frame) {
                Ok((addr, len)) => {
                    let kind = match w.kind.as_str() {
                        "read" => WatchKind::Read,
                        "access" => WatchKind::Access,
                        _ => WatchKind::Write,
                    };
                    set.push(Watchpoint { addr, len, kind });
                    serde_json::json!({ "addr": addr, "len": len })
                }
                Err(e) => serde_json::json!({ "error": e }),
            })
            .collect();
        self.board.set_watchpoints(&set);
        Ok(serde_json::to_string(&out)?)
    }

    /// Source files with code, as JSON `[{index, path, lines: [n, …]}]`
    /// (`[]` without debug information).
    #[wasm_bindgen(js_name = debugFiles)]
    pub fn debug_files(&self) -> String {
        let Some(info) = self.board.debug_info() else {
            return "[]".into();
        };
        let files: Vec<serde_json::Value> = info
            .files
            .iter()
            .enumerate()
            .filter_map(|(i, path)| {
                let lines = info.lines_with_code(i as u32);
                (!lines.is_empty())
                    .then(|| serde_json::json!({"index": i, "path": path, "lines": lines}))
            })
            .collect();
        serde_json::to_string(&files).unwrap_or_default()
    }

    /// Set the breakpoints from JSON `[{file, line, condition?}]` (a
    /// breakpoint with a condition, a C expression, stops only where it is
    /// true). Returns where each one landed, `[{file, line} | null]` (the
    /// next line with code).
    #[wasm_bindgen(js_name = setBreakpoints)]
    pub fn set_breakpoints(&mut self, json: &str) -> Result<String, JsError> {
        #[derive(serde::Deserialize)]
        struct Bp {
            file: u32,
            line: u32,
            #[serde(default)]
            condition: Option<String>,
        }
        let bps: Vec<Bp> = serde_json::from_str(json)?;
        let Some(info) = self.board.debug_info() else {
            return Ok("[]".into());
        };
        let mut addrs = Vec::new();
        let placed: Vec<serde_json::Value> = bps
            .iter()
            .map(|b| match info.breakpoint_addresses(b.file, b.line) {
                Some((line, a)) => {
                    addrs.extend(a.into_iter().map(|a| (a, b.condition.clone())));
                    serde_json::json!({"file": b.file, "line": line})
                }
                None => serde_json::Value::Null,
            })
            .collect();
        self.board.set_conditional_breakpoints(&addrs);
        Ok(serde_json::to_string(&placed)?)
    }

    /// Step: `"instruction"`, `"into"`, `"over"` or `"out"`. Returns
    /// `"done"`, `"breakpoint"`, `"limit"` or why the firmware stopped.
    pub fn step(&mut self, kind: &str) -> String {
        if let Some(why) = &self.stopped {
            return why.clone();
        }
        let kind = match kind {
            "into" => Step::Into,
            "over" => Step::Over,
            "out" => Step::Out,
            _ => Step::Instruction,
        };
        match self.board.step(kind) {
            StepEnd::Done => "done".into(),
            StepEnd::Breakpoint => "breakpoint".into(),
            StepEnd::Watchpoint { addr, write } => {
                format!(
                    "watchpoint {} 0x{addr:08x}",
                    if write { "write" } else { "read" }
                )
            }
            StepEnd::Limit => "limit".into(),
            StepEnd::Stopped(stop) => {
                let r = simucleo_core::cpu::RunResult { cycles: 0, stop };
                match self.board.diagnose(&r) {
                    Some(d) => {
                        let why = d.to_string();
                        self.stopped = Some(why.clone());
                        why
                    }
                    None => "done".into(),
                }
            }
        }
    }

    /// Look at FreeRTOS task `tcb`'s call stack in `debugState`, locals,
    /// evaluation and setting variables (−1: the code the CPU is running).
    #[wasm_bindgen(js_name = selectTask)]
    pub fn select_task(&mut self, tcb: f64) {
        self.board.select_task((tcb >= 0.0).then_some(tcb as u32));
    }

    /// Evaluate a C expression in call-stack frame `frame`: JSON
    /// `{name, type, value, children}` or `{error}`.
    pub fn evaluate(&self, expr: &str, frame: usize) -> String {
        match self.board.evaluate(expr, frame) {
            Ok(v) => serde_json::to_string(&v).unwrap_or_default(),
            Err(e) => serde_json::json!({ "error": e }).to_string(),
        }
    }

    /// Set a variable (or member, element, `*pointer`) seen from frame
    /// `frame` to the value of the expression `value`. Returns its new value
    /// as JSON, or `{error}`.
    #[wasm_bindgen(js_name = setVariable)]
    pub fn set_variable(&mut self, target: &str, value: &str, frame: usize) -> String {
        match self.board.set_variable(target, value, frame) {
            Ok(v) => serde_json::to_string(&v).unwrap_or_default(),
            Err(e) => serde_json::json!({ "error": e }).to_string(),
        }
    }

    /// Machine code around `addr` (default: the pc) as JSON
    /// `[{addr, bytes, text, file, line}]`.
    pub fn disassemble(&self, addr: Option<u32>, before: usize, after: usize) -> String {
        let addr = addr.unwrap_or_else(|| self.board.cpu.registers().pc());
        let rows: Vec<serde_json::Value> = self
            .board
            .disassemble_around(addr, before, after)
            .into_iter()
            .map(|(i, loc)| serde_json::json!({"addr": i.addr, "bytes": i.bytes, "text": i.text, "file": loc.map(|l| l.0), "line": loc.map(|l| l.1)}))
            .collect();
        serde_json::to_string(&rows).unwrap_or_default()
    }

    /// Where the program is and what it holds, as JSON: `{ pc, file,
    /// line, frames: [{pc, function, file, line, exception}], locals,
    /// globals }`; locals are those of call-stack frame `frame`, globals
    /// those declared in file `globals_file` (−1: none).
    #[wasm_bindgen(js_name = debugState)]
    pub fn debug_state(&self, frame: usize, globals_file: i32) -> String {
        let pc = self.board.cpu.registers().pc();
        let Some(info) = self.board.debug_info() else {
            return serde_json::json!({"pc": pc, "frames": []}).to_string();
        };
        let loc = info.location(pc);
        let frames = self.board.viewed_stack();
        let locals = self.board.locals(frame);
        let globals = if globals_file >= 0 {
            self.board.globals(&[globals_file as u32])
        } else {
            Vec::new()
        };
        serde_json::json!({
            "pc": pc,
            "file": loc.map(|l| l.0),
            "line": loc.map(|l| l.1),
            "frames": frames,
            "locals": locals,
            "globals": globals,
        })
        .to_string()
    }

    /// Snapshot for one display frame, as JSON:
    /// `{ timeMs, clockHz, pins: [{port, pin, level, driven, duty}], regs,
    ///    pc, function, exception, stopped, warnings }`.
    /// `duty` is the fraction of the frame the pin was high, which is what
    /// the eye sees on an LED driven by PWM or fast toggling.
    pub fn frame(&mut self) -> String {
        let now = self.board.time_ns();
        let events = self.board.take_pin_events();
        for e in events {
            let t = self.board.ns_at(e.time);
            let p = self.pins.entry((e.port, e.pin)).or_insert(PinTrace {
                since_ns: self.frame_start_ns,
                ..Default::default()
            });
            if p.level {
                p.high_ns += t - p.since_ns;
            }
            p.level = e.level.unwrap_or(false);
            p.driven = e.level.is_some();
            p.since_ns = t;
        }
        // Probes: level changes of the probed pins within the frame.
        self.feed_scope();
        let mut probes = Vec::new();
        for ((((pin, level0), (edges, dense)), &level), synth) in self
            .probes
            .iter_mut()
            .zip(&mut self.probe_edges)
            .zip(&self.probe_level)
            .zip(&self.synth)
        {
            probes.push(json!({
                "name": format!("P{}{}", (b'A' + pin.0) as char, pin.1),
                "level0": *level0,
                "edges": std::mem::take(edges),
                "dense": std::mem::take(dense),
                "synth": synth.is_some(),
            }));
            *level0 = level;
        }
        let mut analog = Vec::new();
        for a in &mut self.analog {
            analog.push(json!({
                "name": a.name,
                "v0": a.frame_v0,
                "samples": std::mem::take(&mut a.samples),
                "dense": std::mem::take(&mut a.dense),
            }));
            a.frame_v0 = a.v;
        }
        let capture = self.scope.take_capture().map(|c| {
            let channels: Vec<_> = c
                .channels
                .into_iter()
                .map(|ch| {
                    json!({
                        "name": ch.name,
                        "level0": ch.level0,
                        "edges": ch.edges,
                        "fromNs": ch.from_ns,
                        "toNs": ch.to_ns,
                    })
                })
                .collect();
            let analog: Vec<_> = c
                .analog
                .into_iter()
                .map(|a| {
                    json!({
                        "name": a.name,
                        "v0": a.v0,
                        "samples": a.samples,
                        "fromNs": a.from_ns,
                        "toNs": a.to_ns,
                    })
                })
                .collect();
            json!({
                "seq": c.seq,
                "source": c.source,
                "triggerMs": c.trigger_ns / 1e6,
                "startNs": c.start_ns,
                "endNs": c.end_ns,
                "channels": channels,
                "analog": analog,
            })
        });
        let scope = json!({ "state": self.scope.status().name(), "capture": capture });

        let span = (now - self.frame_start_ns).max(1e-9);
        let mut pins = Vec::new();
        for (&(port, pin), p) in self.pins.iter_mut() {
            if p.level {
                p.high_ns += now - p.since_ns;
            }
            p.since_ns = now;
            let duty = (p.high_ns / span).clamp(0.0, 1.0);
            p.high_ns = 0.0;
            pins.push(json!({ "port": (b'A' + port) as char, "pin": pin, "level": p.level, "driven": p.driven, "duty": duty }));
        }
        let parts = self.board.circuit_frame(span / 1e9);

        // RTOS: task list, context switches and CPU share in this frame.
        let switches = self.board.take_task_switches();
        let rtos = self.board.rtos_snapshot().map(|snap| {
            let mut cpu: BTreeMap<u32, f64> = BTreeMap::new();
            let mut cur = self.rtos_current;
            let mut since = self.frame_start_ns;
            let mut list = Vec::new();
            for &(cycle, tcb) in &switches {
                let t = self.board.ns_at(cycle);
                if let Some(c) = cur {
                    *cpu.entry(c).or_default() += t - since;
                }
                cur = Some(tcb);
                since = t;
                if list.len() < SWITCHES_MAX {
                    list.push(json!([t / 1e6, tcb]));
                }
            }
            if let Some(c) = cur.or(snap.current) {
                *cpu.entry(c).or_default() += now - since;
            }
            self.rtos_current = snap.current;
            let cpu: BTreeMap<String, f64> = cpu
                .into_iter()
                .map(|(k, v)| (k.to_string(), (v / span).clamp(0.0, 1.0)))
                .collect();
            json!({ "snapshot": snap, "switches": list, "cpu": cpu, "dense": switches.len() > SWITCHES_MAX })
        });
        self.frame_start_ns = now;

        let regs = self.board.cpu.registers();
        let warnings: Vec<String> = self
            .board
            .bus
            .warnings
            .iter()
            .map(|w| w.to_string())
            .collect();
        json!({
            "timeMs": now / 1e6,
            "clockHz": self.board.clock_hz(),
            "pins": pins,
            "regs": regs.r,
            "xpsr": regs.xpsr,
            "msp": regs.msp,
            "psp": regs.psp,
            "pc": regs.pc(),
            "function": self.board.symbol_at(regs.pc()),
            "exception": if regs.ipsr() != 0 { Some(exc::name(regs.ipsr())) } else { None },
            "stopped": self.stopped,
            "warnings": warnings,
            "parts": parts,
            "circuitWarnings": self.board.circuit_warnings(),
            "probes": probes,
            "analog": analog,
            "scope": scope,
            "rtos": rtos,
            "bluetooth": self.board.bluetooth(),
        })
        .to_string()
    }

    /// Read `len` bytes for the memory viewer, without side effects on the
    /// simulated peripherals; unmapped bytes read as 0.
    #[wasm_bindgen(js_name = readMemory)]
    pub fn read_memory(&self, addr: u32, len: u32) -> Vec<u8> {
        (0..len)
            .map(|i| self.board.peek_byte(addr.wrapping_add(i)).unwrap_or(0))
            .collect()
    }

    /// Name of the function containing `addr`, for the register view.
    #[wasm_bindgen(js_name = symbolAt)]
    pub fn symbol_at(&self, addr: u32) -> Option<String> {
        self.board.symbol_at(addr).map(str::to_string)
    }

    /// Simulated time in milliseconds.
    #[wasm_bindgen(js_name = timeMs)]
    pub fn time_ms(&self) -> f64 {
        self.board.time_ns() / 1e6
    }

    /// Current core clock in Hz.
    #[wasm_bindgen(js_name = clockHz)]
    pub fn clock_hz(&self) -> u32 {
        self.board.clock_hz()
    }

    /// Text received by the ST-LINK virtual COM port since the last call.
    #[wasm_bindgen(js_name = takeConsole)]
    pub fn take_console(&mut self) -> String {
        let bytes: Vec<u8> = self.board.take_console().iter().map(|b| b.byte).collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    /// Type into the virtual COM port.
    #[wasm_bindgen(js_name = consoleSend)]
    pub fn console_send(&mut self, text: &str) {
        self.board.console_send(text.as_bytes());
    }

    /// The phone of HC-05 part `id` sends `text`. Returns whether it went
    /// out (the module is powered, in data mode and connected).
    #[wasm_bindgen(js_name = bluetoothSend)]
    pub fn bluetooth_send(&mut self, id: &str, text: &str) -> bool {
        self.board.bluetooth_send(id, text.as_bytes())
    }

    /// Connect or disconnect the phone of HC-05 part `id`.
    #[wasm_bindgen(js_name = bluetoothConnect)]
    pub fn bluetooth_connect(&mut self, id: &str, on: bool) {
        self.board.bluetooth_connect(id, on);
    }

    /// Press or release the blue user button B1.
    #[wasm_bindgen(js_name = setUserButton)]
    pub fn set_user_button(&mut self, pressed: bool) {
        self.board.set_user_button(pressed);
    }

    /// Level of a GPIO pin, e.g. `pin("A", 5)`.
    pub fn pin(&self, port: &str, pin: u8) -> bool {
        port.chars().next().is_some_and(|p| self.board.pin(p, pin))
    }

    /// Read a 32-bit word without side effects (unmapped bytes read as 0).
    #[wasm_bindgen(js_name = readWord)]
    pub fn read_word(&self, addr: u32) -> u32 {
        (0..4).fold(0, |acc, i| {
            acc | (self.board.peek_byte(addr.wrapping_add(i)).unwrap_or(0) as u32) << (8 * i)
        })
    }

    /// Register the internal buses of every part kind, as JSON
    /// (`{ kind: [[pin, ...], ...] }`). Called once when the part library loads.
    #[wasm_bindgen(js_name = setPartCatalog)]
    pub fn set_part_catalog(&mut self, catalog_json: &str) -> Result<(), JsError> {
        self.catalog = serde_json::from_str(catalog_json)?;
        Ok(())
    }

    /// Wire the simulated board to a circuit (hot-plug allowed while
    /// running): the circuit as for [`Simulator::set_circuit`], the part
    /// catalog (`{ kind: [[pin, ...], ...] }`) and the board's pin → signal
    /// map (`{ "D13": "PA5", ... }`).
    #[wasm_bindgen(js_name = setWiring)]
    pub fn set_wiring(
        &mut self,
        circuit_json: &str,
        catalog_json: &str,
        signals_json: &str,
    ) -> Result<(), JsError> {
        let circuit: Circuit = serde_json::from_str(circuit_json)?;
        let catalog: BusCatalog = serde_json::from_str(catalog_json)?;
        let signals: HashMap<String, String> = serde_json::from_str(signals_json)?;
        self.board.set_circuit(&circuit, &catalog, &signals);
        Ok(())
    }

    /// The date and time (seconds since 1970, in the time zone the clock
    /// should show) that RTC modules placed from now on start at.
    #[wasm_bindgen(js_name = setWallClock)]
    pub fn set_wall_clock(&mut self, seconds: f64) {
        self.board.set_wall_clock(seconds);
    }

    /// The SD card of part `id` as a disk image (empty if there is none).
    #[wasm_bindgen(js_name = sdImage)]
    pub fn sd_image(&self, id: &str) -> Vec<u8> {
        self.board.sd_image(id).unwrap_or_default()
    }

    /// The SD card of part `id` as just its blocks in use (small enough to
    /// keep in IndexedDB; empty if there is no such card).
    #[wasm_bindgen(js_name = sdSnapshot)]
    pub fn sd_snapshot(&self, id: &str) -> Vec<u8> {
        self.board.sd_snapshot(id).unwrap_or_default()
    }

    /// Put back what `sdSnapshot` gave.
    #[wasm_bindgen(js_name = sdRestore)]
    pub fn sd_restore(&mut self, id: &str, snapshot: &[u8]) -> bool {
        self.board.sd_restore(id, snapshot)
    }

    /// Erase the SD card of part `id`.
    #[wasm_bindgen(js_name = sdWipe)]
    pub fn sd_wipe(&mut self, id: &str) -> bool {
        self.board.sd_wipe(id)
    }

    /// Insert a disk image into the SD card of part `id`.
    #[wasm_bindgen(js_name = sdLoad)]
    pub fn sd_load(&mut self, id: &str, image: &[u8]) -> bool {
        self.board.sd_load(id, image)
    }

    /// Turn a rotary encoder part by `detents` (negative: counter-clockwise).
    pub fn rotate(&mut self, part: &str, detents: i32) {
        self.board.rotate(part, detents);
    }

    /// Press or release a switch: a `tact-switch` part id or `"B1"`.
    pub fn press(&mut self, part: &str, pressed: bool) {
        self.board.press(part, pressed);
    }

    /// Choose the pins whose level changes each frame reports, as JSON
    /// (`["PA5", "PC13"]`).
    #[wasm_bindgen(js_name = setProbes)]
    pub fn set_probes(&mut self, pins_json: &str) -> Result<(), JsError> {
        let names: Vec<String> = serde_json::from_str(pins_json)?;
        // Edges of the pins probed so far go to their lists first.
        self.feed_scope();
        self.flush_pending(f64::INFINITY);
        let now = self.board.time_ns();
        let old: Vec<((u8, u8), Option<WireSignal>, bool)> = self
            .probes
            .iter()
            .zip(&self.synth)
            .zip(&self.probe_level)
            .map(|((p, s), l)| (p.0, *s, *l))
            .collect();
        let mut mask = [0u16; 8];
        self.probes.clear();
        self.synth.clear();
        self.probe_level.clear();
        for (port, pin) in names.iter().filter_map(|n| parse_mcu_pin(n)) {
            if mask[port as usize] & (1 << pin) != 0 {
                continue;
            }
            mask[port as usize] |= 1 << pin;
            // A pin probed before keeps its (maybe synthesized) level.
            let (synth, level) = match old.iter().find(|o| o.0 == (port, pin)) {
                Some(&(_, s, l)) => (s, l),
                None => {
                    let s = self.board.bus.wire_signal(port, pin);
                    let real = self.board.pin((b'A' + port) as char, pin);
                    (s, s.and_then(|s| s.idle()).unwrap_or(real))
                }
            };
            self.probes.push(((port, pin), level));
            self.synth.push(synth);
            self.probe_level.push(level);
        }
        self.synth_last = vec![now; self.probes.len()];
        self.apply_probe_mask();
        self.holdback_ns = 0.0;
        self.probe_edges = vec![(Vec::new(), false); self.probes.len()];
        self.scope.set_channels(
            self.probes
                .iter()
                .map(|&((port, pin), level)| (format!("P{}{pin}", (b'A' + port) as char), level))
                .collect(),
            now,
        );
        Ok(())
    }

    /// Choose the analog probes, as JSON (`["PA1", "pot.W"]`: an MCU pin or
    /// a part's pin); their channels are named `"V(PA1)"`, `"V(pot.W)"`.
    /// Each frame reports their voltage changes (`analog`), and captures
    /// hold them around the trigger.
    #[wasm_bindgen(js_name = setAnalogProbes)]
    pub fn set_analog_probes(&mut self, specs_json: &str) -> Result<(), JsError> {
        let mut specs: Vec<String> = serde_json::from_str(specs_json)?;
        specs.dedup();
        self.feed_scope();
        self.flush_pending(f64::INFINITY);
        self.analog = specs
            .iter()
            .map(|spec| AnalogProbe {
                spec: spec.clone(),
                name: format!("V({spec})"),
                mcu: parse_mcu_pin(spec),
                on_net: false,
                v: 0.0,
                frame_v0: 0.0,
                samples: Vec::new(),
                dense: false,
            })
            .collect();
        self.board.set_voltage_probes(&specs);
        self.board.take_voltage_log();
        self.read_analog();
        self.apply_probe_mask();
        self.scope.set_analog(
            self.analog.iter().map(|a| (a.name.clone(), a.v)).collect(),
            self.board.time_ns(),
        );
        Ok(())
    }

    /// Replace the external circuit (hot-plug allowed while running).
    /// Returns the extracted netlist as JSON.
    #[wasm_bindgen(js_name = setCircuit)]
    pub fn set_circuit(&mut self, circuit_json: &str) -> Result<String, JsError> {
        let circuit: Circuit = serde_json::from_str(circuit_json)?;
        let netlist = build_netlist(&circuit, &self.catalog);
        Ok(serde_json::to_string(&netlist)?)
    }
}
