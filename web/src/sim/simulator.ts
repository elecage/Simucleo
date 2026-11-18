// Thin wrapper over the WASM core. Built by `npm run wasm`.
import init, { Simulator, version } from "../wasm/pkg/simucleo_wasm.js";
import { busCatalog } from "../parts";
import type { CircuitJson, PinRef } from "../editor/model";

export interface Netlist {
  nets: { pins: PinRef[] }[];
}

export interface SimHandle {
  version: string;
  setCircuit(c: CircuitJson): Netlist;
  loadElf(bytes: Uint8Array): void;
  pc(): number;
}

export async function createSimulator(): Promise<SimHandle> {
  await init();
  const sim = new Simulator();
  sim.setPartCatalog(JSON.stringify(busCatalog()));
  return {
    version: version(),
    setCircuit: (c) => JSON.parse(sim.setCircuit(JSON.stringify(c))) as Netlist,
    loadElf: (bytes) => sim.loadElf(bytes),
    pc: () => sim.pc(),
  };
}
