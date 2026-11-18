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

    /// Run for `cycles` core cycles; returns the stop reason as text.
    pub fn run(&mut self, cycles: u32) -> String {
        format!("{:?}", self.board.run(cycles as u64).stop)
    }

    /// Simulated time in core cycles.
    pub fn now(&self) -> f64 {
        self.board.now() as f64
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
