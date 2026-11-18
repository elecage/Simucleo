/** Messages between the UI thread and the simulation worker. */

export interface PinFrame {
  port: string;
  pin: number;
  level: boolean;
  driven: boolean;
  /** Fraction of the last display frame the pin was high (LED brightness). */
  duty: number;
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
}

export type ToWorker =
  | { type: "load"; name: string; bytes: ArrayBuffer }
  | { type: "run" }
  | { type: "pause" }
  | { type: "reset" }
  | { type: "speed"; value: number } // simulated ms per wall ms; Infinity = as fast as possible
  | { type: "button"; pressed: boolean }
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
