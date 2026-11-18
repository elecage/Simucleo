//! WebAssembly entry points. The simulator runs inside a Web Worker; the UI
//! thread receives visual-state snapshots (see `docs/architecture.md`).

use wasm_bindgen::prelude::*;

use simucleo_circuit::netlist::{build_netlist, BusCatalog, Circuit};
use simucleo_core::bus::Bus;
use simucleo_nucleo::Nucleo;

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[wasm_bindgen]
pub struct Simulator {
    board: Nucleo,
    catalog: BusCatalog,
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
        }
    }

    /// Load an uploaded ELF file and reset the core.
    #[wasm_bindgen(js_name = loadElf)]
    pub fn load_elf(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        Ok(self.board.load_elf(bytes)?)
    }

    pub fn pc(&self) -> u32 {
        self.board.cpu.registers().pc()
    }

    /// Run for a simulated duration. Returns `""` while the firmware is
    /// running normally, otherwise an explanation of why it stopped.
    #[wasm_bindgen(js_name = runForMs)]
    pub fn run_for_ms(&mut self, ms: f64) -> String {
        let r = self.board.run_for_ns(ms * 1e6);
        match self.board.diagnose(&r) {
            Some(d) => d.to_string(),
            None => String::new(),
        }
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
