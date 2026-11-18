//! WebAssembly entry points. The simulator runs inside a Web Worker; the UI
//! thread receives visual-state snapshots (see `docs/architecture.md`).

use std::collections::BTreeMap;

use serde_json::json;
use wasm_bindgen::prelude::*;

use simucleo_circuit::netlist::{build_netlist, BusCatalog, Circuit};
use simucleo_core::bus::{AccessSize, Bus};
use simucleo_core::cortexm::exc;
use simucleo_nucleo::Nucleo;

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
}

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
        self.frame_start_ns = self.board.time_ns();
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
        match self.board.diagnose(&r) {
            Some(d) => {
                let why = d.to_string();
                self.stopped = Some(why.clone());
                why
            }
            None => String::new(),
        }
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
        })
        .to_string()
    }

    /// Read `len` bytes for the memory viewer; unmapped bytes read as 0.
    #[wasm_bindgen(js_name = readMemory)]
    pub fn read_memory(&mut self, addr: u32, len: u32) -> Vec<u8> {
        (0..len)
            .map(|i| {
                self.board
                    .bus
                    .read(addr.wrapping_add(i), AccessSize::Byte)
                    .unwrap_or(0) as u8
            })
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

    /// Read a 32-bit word for the memory viewer.
    #[wasm_bindgen(js_name = readWord)]
    pub fn read_word(&mut self, addr: u32) -> Result<u32, JsError> {
        Ok(self.board.bus.read_u32(addr)?)
    }

    /// Register the internal buses of every part kind, as JSON
    /// (`{ kind: [[pin, ...], ...] }`). Called once when the part library loads.
    #[wasm_bindgen(js_name = setPartCatalog)]
    pub fn set_part_catalog(&mut self, catalog_json: &str) -> Result<(), JsError> {
        self.catalog = serde_json::from_str(catalog_json)?;
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
