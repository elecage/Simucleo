//! WebAssembly entry points. The simulator runs inside a Web Worker; the UI
//! thread receives visual-state snapshots (see `docs/architecture.md`).

use wasm_bindgen::prelude::*;

use simucleo_circuit::netlist::{build_netlist, BusCatalog, Circuit};
use simucleo_core::bus::Bus;
use simucleo_core::cpu::CpuBackend;
use simucleo_cpu_armv7m::ArmV7M;
use simucleo_elf::FirmwareImage;
use simucleo_periph_stm32f4::Stm32f401Bus;

#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[wasm_bindgen]
pub struct Simulator {
    bus: Stm32f401Bus,
    cpu: ArmV7M,
    firmware: Option<FirmwareImage>,
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
            bus: Stm32f401Bus::new(),
            cpu: ArmV7M::new(),
            firmware: None,
            catalog: BusCatalog::default(),
        }
    }

    /// Load an uploaded ELF file and reset the core.
    #[wasm_bindgen(js_name = loadElf)]
    pub fn load_elf(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        let fw = FirmwareImage::parse(bytes)?;
        self.bus = Stm32f401Bus::new();
        for seg in &fw.segments {
            self.bus.load(seg.addr, &seg.data)?;
        }
        self.cpu.reset(&mut self.bus, 0)?;
        self.firmware = Some(fw);
        Ok(())
    }

    pub fn pc(&self) -> u32 {
        self.cpu.registers().pc()
    }

    /// Read a 32-bit word for the memory viewer.
    #[wasm_bindgen(js_name = readWord)]
    pub fn read_word(&mut self, addr: u32) -> Result<u32, JsError> {
        Ok(self.bus.read_u32(addr)?)
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
