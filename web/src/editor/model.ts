import { PART_BY_KIND } from "../parts";

export interface PinRef {
  part: string;
  pin: string;
}

export interface PlacedPart {
  id: string;
  kind: string;
  /** Origin in grid steps. */
  x: number;
  y: number;
  props: Record<string, string | number>;
}

export interface WireModel {
  id: string;
  a: PinRef;
  b: PinRef;
  color: string;
}

export interface Project {
  parts: PlacedPart[];
  wires: WireModel[];
}

/** The circuit as the Rust core sees it (`simucleo_circuit::netlist::Circuit`). */
export interface CircuitJson {
  parts: { id: string; kind: string }[];
  wires: { a: PinRef; b: PinRef }[];
}

export const pinKey = (p: PinRef) => `${p.part}:${p.pin}`;

export function pinPosition(part: PlacedPart, pinId: string): { x: number; y: number } | undefined {
  const pin = PART_BY_KIND[part.kind]?.pins.find((p) => p.id === pinId);
  return pin && { x: part.x + pin.x, y: part.y + pin.y };
}

/**
 * Export the project for the simulator.
 *
 * Besides drawn wires, two pins of different parts that sit on the same grid
 * point are connected — that is how a lead "plugs into" a breadboard hole or
 * a jumper lands on a header, just like on a real bench.
 */
export function toCircuit(project: Project): CircuitJson {
  const wires = project.wires.map(({ a, b }) => ({ a, b }));
  const byPoint = new Map<string, PinRef[]>();
  for (const part of project.parts) {
    const def = PART_BY_KIND[part.kind];
    if (!def) continue;
    for (const pin of def.pins) {
      const key = `${part.x + pin.x},${part.y + pin.y}`;
      const list = byPoint.get(key) ?? [];
      list.push({ part: part.id, pin: pin.id });
      byPoint.set(key, list);
    }
  }
  for (const pins of byPoint.values()) {
    for (let i = 1; i < pins.length; i++) {
      if (pins[i].part !== pins[0].part) wires.push({ a: pins[0], b: pins[i] });
    }
  }
  return { parts: project.parts.map(({ id, kind }) => ({ id, kind })), wires };
}

let counter = 0;
export function newId(prefix: string, taken: Set<string>): string {
  let id: string;
  do id = `${prefix}${++counter}`;
  while (taken.has(id));
  return id;
}

export function defaultProject(): Project {
  return {
    parts: [
      { id: "nucleo", kind: "nucleo-f401re", x: 4, y: 2, props: {} },
      { id: "bb1", kind: "breadboard-half", x: 42, y: 4, props: {} },
    ],
    wires: [],
  };
}
