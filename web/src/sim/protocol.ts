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
  angle?: number;
  rpm?: number;
  unpowered?: boolean;
  /** Display: 64 rows × 128 pixels, MSB first, base64. */
  screen?: string;
  /** A reading shown on the part (RTC date and time). */
  text?: string;
  /** NeoPixel colours, 0xRRGGBB per LED. */
  leds?: number[];
  lcd?: import("../parts/types").LcdView;
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

export interface RtosTask {
  tcb: number;
  name: string;
  state: "running" | "ready" | "blocked" | "suspended" | "deleted";
  priority: number;
  stackBase: number;
  stackSize: number | null;
  stackFreeMin: number | null;
}

/** Kernel-aware RTOS view (FreeRTOS), per frame. */
export interface RtosFrame {
  snapshot: {
    kernel: string;
    api: string | null;
    schedulerRunning: boolean;
    tick: number;
    current: number | null;
    tasks: RtosTask[];
  };
  /** [time in ms, TCB that runs from then on] */
  switches: [number, number][];
  /** Share of the frame each task ran, by TCB (as a string key). */
  cpu: Record<string, number>;
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
  /** Present when the firmware contains an RTOS (FreeRTOS). */
  rtos: RtosFrame | null;
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
  | { type: "readMemory"; addr: number; len: number }
  | { type: "sdImage"; part: string }
  | { type: "rotate"; part: string; detents: number }
  | { type: "debugFiles" }
  | { type: "breakpoints"; list: BreakpointSpec[] }
  | { type: "step"; kind: "instruction" | "into" | "over" | "out" }
  | { type: "debugState"; frame: number; globalsFile: number }
  | { type: "disassemble"; addr: number | null }
  | { type: "evaluate"; exprs: string[]; frame: number }
  | { type: "sdLoad"; part: string; bytes: ArrayBuffer };

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
  | { type: "memory"; addr: number; bytes: Uint8Array }
  | { type: "sdImage"; part: string; bytes: Uint8Array }
  | { type: "debugFiles"; files: DebugFile[] }
  | { type: "breakpoints"; placed: ({ file: number; line: number } | null)[] }
  | { type: "debugState"; state: DebugState }
  | { type: "disasm"; rows: DisasmRow[] }
  | { type: "watch"; values: WatchValue[] }
  /** Execution paused by the debugger (breakpoint, step done, …). */
  | { type: "paused"; reason: string };

/** A source file of the firmware (DWARF), with the lines that have code. */
export interface DebugFile {
  index: number;
  path: string;
  lines: number[];
}

/** A variable's value (`simucleo_elf::debug::Value`). */
export interface DebugValue {
  name: string;
  type: string;
  value: string;
  children?: DebugValue[];
  addr?: number;
}

export interface DebugFrameInfo {
  pc: number;
  function: string | null;
  file: number | null;
  line: number | null;
  exception: boolean;
}

/** A breakpoint on a source line; with a condition (a C expression) it
 * stops only where the condition is true. */
export interface BreakpointSpec {
  file: number;
  line: number;
  condition?: string;
}

/** A watch expression's value, or why it has none. */
export type WatchValue = DebugValue | { error: string };

/** One disassembled instruction with its source line. */
export interface DisasmRow {
  addr: number;
  bytes: string;
  text: string;
  file: number | null;
  line: number | null;
}

/** Where a paused program is and what it holds. */
export interface DebugState {
  pc: number;
  file?: number | null;
  line?: number | null;
  frames: DebugFrameInfo[];
  locals?: DebugValue[];
  globals?: DebugValue[];
}
