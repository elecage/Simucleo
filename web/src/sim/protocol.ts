/** Messages between the UI thread and the simulation worker. */
import type { DataPlaced, SwvData, SwvSettings } from "../run/swv";
import type { DecoderCfg } from "../run/scopeSettings";
import type { ContentMatch } from "../run/decode";

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
  matrix?: import("../parts/types").MatrixView;
  /** SD card: moves whenever its contents change. */
  generation?: number;
  /** Relay: COM is on NO. */
  closed?: boolean;
  register?: import("../parts/types").ShiftView;
  digits?: import("../parts/types").DigitsView;
  motor?: import("../parts/types").MotorView;
  /** M35: colour TFT display; `pixels` (RGB565 LE) only in a frame where `version` moved (see tftStore). */
  tft?: import("../parts/types").TftView & { pixels?: Uint8Array };
}

/** An HC-05 module and what its phone received this frame (`simucleo_nucleo::BluetoothStatus`). */
export interface BluetoothFrame {
  id: string;
  /** [byte, re-sampled at a mismatched baud rate] */
  received: [number, boolean][];
  powered: boolean;
  connected: boolean;
  atMode: boolean;
  name: string;
  /** The module's UART baud rate (38400 in AT mode). */
  baud: number;
  /** The USART whose TX reaches RXD, and the one TXD reaches. */
  txUsart: string | null;
  rxUsart: string | null;
  /** The baud rate that USART is set to. */
  mcuBaud: number | null;
  /** An MCU TX is wired to the module's TXD. */
  swapped: boolean;
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
  /** The pin carries a USART, I2C or SPI signal: its edges are
   * synthesized from the bytes the peripheral moves (M22). */
  synth?: boolean;
}

/** Voltage changes of an analog probe within one frame (M22). */
export interface AnalogFrame {
  /** "V(PA1)", "V(pot.W)". */
  name: string;
  /** Voltage at the start of the frame. */
  v0: number;
  /** [time in ms, volts]: the voltage from then on. */
  samples: [number, number][];
  dense: boolean;
}

/** An analog channel of a capture; times in ns relative to the trigger. */
export interface CaptureAnalog {
  name: string;
  v0: number;
  samples: [number, number][];
  fromNs: number;
  toNs: number;
}

/** One pin of a triggered capture; times in ns relative to the trigger. */
export interface CaptureChannel {
  name: string;
  /** Level at the start of the window. */
  level0: boolean;
  /** [time in ns from the trigger, level], every edge in the window. */
  edges: [number, boolean][];
  /** The edges are complete from here (after the window's start when the
   * ring buffer had dropped older ones) … */
  fromNs: number;
  /** … up to here (before its end when the capture filled up). */
  toNs: number;
}

/** A window of every probed pin around a trigger (`crates/wasm/src/scope.rs`). */
export interface ScopeCapture {
  seq: number;
  source: string;
  /** Absolute simulated time of the trigger. */
  triggerMs: number;
  /** Window relative to the trigger. */
  startNs: number;
  endNs: number;
  channels: CaptureChannel[];
  /** Analog channels (absent from captures of older simulators). */
  analog?: CaptureAnalog[];
}

export type ScopeState = "off" | "nosource" | "armed" | "collecting" | "stopped";

export interface ScopeFrame {
  state: ScopeState;
  /** A capture completed since the last frame. */
  capture: ScopeCapture | null;
}

/** Oscilloscope trigger settings (see `Simulator.setTrigger`). */
export interface TriggerConfig {
  /** Source pin, e.g. "PC7" (one of the probed pins). */
  source: string;
  edge: "rising" | "falling" | "either";
  mode: "auto" | "normal" | "single";
  /** Captured span: 10 divisions of the timebase. */
  windowNs: number;
  /** Share of the window before the trigger (0.1–0.9). */
  pre: number;
  /** Pulse-width condition: a pulse narrower (lt) or wider (gt) than ns. */
  width?: { cmp: "lt" | "gt"; ns: number };
  /** Pause the simulation once a capture is complete. */
  pause: boolean;
  /** Level trigger on an analog source ("V(…)"): threshold in volts … */
  level?: number;
  /** … and hysteresis in volts. */
  hysteresis?: number;
  /** M26: a content trigger the simulator runs — its decoder (pins, settings) and what to look for. */
  content?: { decoder: DecoderCfg; match: ContentMatch };
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
  /** Analog probes' voltage changes in this frame. */
  analog?: AnalogFrame[];
  /** Trigger state and the capture completed in this frame. */
  scope: ScopeFrame;
  /** Present when the firmware contains an RTOS (FreeRTOS). */
  rtos: RtosFrame | null;
  /** HC-05 modules in the circuit. */
  bluetooth: BluetoothFrame[];
}

export type ToWorker =
  | { type: "load"; name: string; bytes: ArrayBuffer }
  | { type: "run" }
  /** Pause; `reason` (default "pause") is what the `paused` message says. */
  | { type: "pause"; reason?: string }
  /** `epoch` (optional) is carried by every frame from then on, so a caller
   * can tell frames after its reset from the ones already on the way. */
  | { type: "reset"; epoch?: number }
  | { type: "speed"; value: number } // simulated ms per wall ms; Infinity = as fast as possible
  | { type: "speedCap"; value: number } // upper bound on speed (Infinity: none)
  | { type: "press"; part: string; pressed: boolean } // a tact-switch part id, or "B1"
  | { type: "wiring"; circuit: string; catalog: string; signals: string } // JSON
  | { type: "probes"; pins: string[] }
  /** Analog probes: "PA1" or "part.pin". */
  | { type: "analogProbes"; specs: string[] }
  /** Set the oscilloscope trigger (null: none) and arm it. */
  | { type: "trigger"; config: TriggerConfig | null; gen: number }
  /** Wait for the next trigger (Single). */
  | { type: "armTrigger"; gen: number }
  | { type: "console"; text: string }
  | { type: "bluetooth"; part: string; text: string }
  | { type: "bluetoothConnect"; part: string; on: boolean }
  | { type: "readMemory"; addr: number; len: number }
  | { type: "sdImage"; part: string }
  | { type: "rotate"; part: string; detents: number }
  | { type: "debugFiles" }
  | { type: "breakpoints"; list: BreakpointSpec[] }
  | { type: "step"; kind: "instruction" | "into" | "over" | "out" }
  | { type: "debugState"; frame: number; globalsFile: number }
  | { type: "disassemble"; addr: number | null }
  | { type: "evaluate"; exprs: string[]; frame: number }
  | { type: "setVariable"; target: string; value: string; frame: number }
  | { type: "watchpoints"; list: WatchpointSpec[]; frame: number }
  /** SWV: start the trace with these settings, or stop it (null). */
  | { type: "swv"; settings: SwvSettings | null }
  | { type: "selectTask"; tcb: number | null }
  | { type: "sdLoad"; part: string; bytes: ArrayBuffer }
  | { type: "sdSnapshot"; part: string }
  | { type: "sdRestore"; part: string; bytes: ArrayBuffer }
  | { type: "sdWipe"; part: string }
  /** M31: frames to the page at most `hz` times a second, in batches (null: each frame as it is made). */
  | { type: "uiRate"; hz: number | null }
  /** M31: the page has drawn the last batch. */
  | { type: "ack" };

/** One frame as the worker hands it to the page. */
export interface FrameMsg {
  frame: SimFrame;
  /** Text the virtual COM port received since the last frame. */
  console: string;
  running: boolean;
  /** The `epoch` of the last reset that asked for one (0 before). */
  epoch: number;
  /** The `gen` of the last trigger setting or arming made before this frame. */
  triggerGen: number;
  /** SWV trace since the last frame (while the trace is on). */
  swv?: SwvData;
}

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
      /** Share of the worker's own time spent simulating, over the last 1.5 s (M31). */
      work: number;
      /** The `epoch` of the last reset that asked for one (0 before). */
      epoch: number;
      /** See `FrameMsg.triggerGen`. */
      triggerGen: number;
      swv?: SwvData;
    }
  /** M31: the frames made since the last batch, oldest first (performance mode). */
  | { type: "frames"; frames: FrameMsg[]; speed: number; work: number }
  | { type: "memory"; addr: number; bytes: Uint8Array }
  | { type: "sdImage"; part: string; bytes: Uint8Array }
  | { type: "sdSnapshot"; part: string; bytes: Uint8Array }
  | { type: "debugFiles"; files: DebugFile[] }
  | { type: "breakpoints"; placed: ({ file: number; line: number } | null)[] }
  | { type: "debugState"; state: DebugState }
  | { type: "disasm"; rows: DisasmRow[] }
  | { type: "watch"; values: WatchValue[] }
  /** The outcome of setting a variable (its new value, or why not). */
  | { type: "assigned"; target: string; result: WatchValue }
  /** Where each watchpoint landed in memory, or why it could not be set. */
  | { type: "watchpoints"; placed: WatchpointPlaced[] }
  /** Where each SWV data trace expression landed (after `swv` and after each firmware load). */
  | { type: "swvPlaced"; placed: DataPlaced[] }
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

/** A data watchpoint on the memory an expression names. */
export interface WatchpointSpec {
  expr: string;
  kind: "write" | "read" | "access";
}

export type WatchpointPlaced = { addr: number; len: number } | { error: string };

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
