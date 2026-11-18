import { breadboardHalf } from "./breadboard";
import { led5mm, resistor, tactSwitch } from "./basic";
import { nucleoF401re } from "./nucleo";
import type { PartDef } from "./types";

export const PARTS: PartDef[] = [nucleoF401re, breadboardHalf, led5mm, resistor, tactSwitch];

export const PART_BY_KIND: Record<string, PartDef> = Object.fromEntries(PARTS.map((p) => [p.kind, p]));

/** Internal buses of every part kind, in the shape the Rust core expects. */
export function busCatalog(): Record<string, string[][]> {
  return Object.fromEntries(PARTS.filter((p) => p.buses).map((p) => [p.kind, p.buses!]));
}
