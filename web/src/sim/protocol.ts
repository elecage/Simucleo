/** Messages between the UI thread and the simulation worker. */

export interface PinFrame {
  port: string;
  pin: number;
  level: boolean;
  driven: boolean;
  /** Fraction of the last display frame the pin was high (LED brightness). */
  duty: number;
}

/** What a part of the circuit shows (`simucleo_circuit::sim::PartVisual`). */
export interface PartFrame {
  id: string;
  brightness?: number[];
  overcurrent?: boolean;
  on?: number;
  freq?: number;
  pressed?: boolean;
}

/** Level changes of a probed pin within one frame. */
export interface ProbeFrame {
  name: string;
  /** Level at the start of the frame. */
  level0: boolean;
  /** [time in ms, level] */
  edges: [number, boolean][];
  /** Too many edges to report: the signal is faster than the display. */
  dense: boolean;
}

/** One display frame produced by `Simulator.frame()`. */
export interface SimFrame {
  timeMs: number;
  clockHz: number;
  pins: PinFrame[];
  regs: number[];
  xpsr: number;
  msp: number;
  psp: number;
  pc: number;
  function: string | null;
  exception: string | null;
  stopped: string | null;
  warnings: string[];
  parts: PartFrame[];
  /** Electrical-rule violations (LED without resistor, …). */
  circuitWarnings: string[];
  probes: ProbeFrame[];
}

export type ToWorker =
  | { type: "load"; name: string; bytes: ArrayBuffer }
  | { type: "run" }
  | { type: "pause" }
  | { type: "reset" }
  | { type: "speed"; value: number } // simulated ms per wall ms; Infinity = as fast as possible
  | { type: "press"; part: string; pressed: boolean } // a tact-switch part id, or "B1"
  | { type: "wiring"; circuit: string; catalog: string; signals: string } // JSON
  | { type: "probes"; pins: string[] }
  | { type: "console"; text: string }
  | { type: "readMemory"; addr: number; len: number };

export type FromWorker =
  | { type: "ready"; version: string }
  | { type: "loaded"; name: string; error?: string }
  | {
      type: "frame";
      frame: SimFrame;
      /** Text the virtual COM port received since the last frame. */
      console: string;
      running: boolean;
      /** Achieved simulated-time / wall-time ratio. */
      speed: number;
    }
  | { type: "memory"; addr: number; bytes: Uint8Array };
