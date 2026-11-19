//! WebAssembly entry points. The simulator runs inside a Web Worker; the UI
//! thread receives visual-state snapshots (see `docs/architecture.md`).

use std::collections::{BTreeMap, HashMap};

use serde_json::json;
use wasm_bindgen::prelude::*;

use simucleo_circuit::netlist::{build_netlist, BusCatalog, Circuit};
use simucleo_circuit::sim::parse_mcu_pin;

use simucleo_core::cortexm::exc;
use simucleo_nucleo::{Nucleo, Step, StepEnd};

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
    /// RTOS task running at the start of the frame (TCB address).
    rtos_current: Option<u32>,
    /// The last run stopped at a breakpoint.
    at_breakpoint: bool,
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
            rtos_current: None,
            at_breakpoint: false,
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
        let mut mask = [0u16; 8];
        for ((port, pin), _) in &self.probes {
            mask[*port as usize] |= 1 << pin;
        }
        self.board.bus.probe_mask = mask;
        self.frame_start_ns = self.board.time_ns();
        for (pin, level) in &mut self.probes {
            *level = self.board.pin((b'A' + pin.0) as char, pin.1);
        }
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
        let r = self.board.run_for_ns(ms * 1e6);
        self.at_breakpoint = matches!(r.stop, simucleo_core::cpu::StopReason::Breakpoint(_));
        match self.board.diagnose(&r) {
            Some(d) => {
                let why = d.to_string();
                self.stopped = Some(why.clone());
                why
            }
            None => String::new(),
        }
    }

    /// The last `runForMs` stopped at a breakpoint (the caller pauses).
    #[wasm_bindgen(js_name = atBreakpoint)]
    pub fn at_breakpoint(&self) -> bool {
        self.at_breakpoint
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

    /// Set the breakpoints from JSON `[{file, line}]`. Returns where each
    /// one landed, `[{file, line} | null]` (the next line with code).
    #[wasm_bindgen(js_name = setBreakpoints)]
    pub fn set_breakpoints(&mut self, json: &str) -> Result<String, JsError> {
        #[derive(serde::Deserialize)]
        struct Bp {
            file: u32,
            line: u32,
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
                    addrs.extend(a);
                    serde_json::json!({"file": b.file, "line": line})
                }
                None => serde_json::Value::Null,
            })
            .collect();
        self.board.set_breakpoints(&addrs);
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
        let frames = self.board.call_stack();
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
        let level_events = std::mem::take(&mut self.board.bus.level_events);
        let mut probes = Vec::new();
        for (pin, level0) in &mut self.probes {
            let mut edges = Vec::new();
            let mut dense = false;
            for e in level_events.iter().filter(|e| (e.port, e.pin) == *pin) {
                if edges.len() >= PROBE_EDGES_MAX {
                    dense = true;
                    continue;
                }
                edges.push(json!([
                    self.board.ns_at(e.time) / 1e6,
                    e.level == Some(true)
                ]));
            }
            probes.push(json!({
                "name": format!("P{}{}", (b'A' + pin.0) as char, pin.1),
                "level0": *level0,
                "edges": edges,
                "dense": dense,
            }));
            *level0 = self.board.pin((b'A' + pin.0) as char, pin.1);
        }

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
            "rtos": rtos,
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
        let mut mask = [0u16; 8];
        self.probes.clear();
        for (port, pin) in names.iter().filter_map(|n| parse_mcu_pin(n)) {
            mask[port as usize] |= 1 << pin;
            let level = self.board.pin((b'A' + port) as char, pin);
            self.probes.push(((port, pin), level));
        }
        self.board.bus.probe_mask = mask;
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
