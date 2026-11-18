import type { JSX } from "react";

/** Grid pitch in canvas units. One unit = 0.1 inch (2.54 mm), the breadboard pitch. */
export const PITCH = 10;

export interface PinDef {
  id: string;
  /** Position relative to the part origin, in grid steps (multiples of PITCH). */
  x: number;
  y: number;
  /** Shown on hover, e.g. "D13 / PA5". */
  label?: string;
  /**
   * Board-level signal. Pins of one part with the same signal are joined
   * internally (e.g. Arduino D13 and Morpho CN10-11 are both PA5).
   */
  signal?: string;
}

export interface PartDef {
  kind: string;
  name: string;
  category: "board" | "basic" | "input" | "output" | "actuator" | "display" | "sensor" | "module";
  /** Size in grid steps. */
  w: number;
  h: number;
  pins: PinDef[];
  /** Pins that are always connected inside the part (breadboard rows, GND pins, …). */
  buses?: string[][];
  props?: Record<string, string | number>;
  /** Renders the body. Pin markers are drawn by the editor. */
  render: (props: Record<string, string | number>, visual: VisualState) => JSX.Element;
}

/** Per-part state sampled from the simulator at ~60 Hz. */
export interface VisualState {
  brightness?: number;
  angle?: number;
  pressed?: boolean;
  burnt?: boolean;
}
