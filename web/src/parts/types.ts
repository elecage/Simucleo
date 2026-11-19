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
  /** Choices offered in the inspector for a property (else free text). */
  propOptions?: Record<string, string[]>;
  /** Live numeric inputs (knob, light, temperature): sliders in the inspector. */
  ranges?: Record<string, { min: number; max: number; step: number; label: string; unit: string; log?: boolean }>;
  /** Shown in the part library and inspector. */
  description?: string;
  /**
   * Things on the part a student operates with the mouse or a finger (a
   * knob, a lamp to move, a sensor to touch), by the name used in the
   * drawing's `data-drag` attribute. They change the same props as the
   * inspector sliders.
   */
  controls?: Record<string, PartControl>;
  /** Renders the body. Pin markers are drawn by the editor. */
  render: (props: Record<string, string | number>, visual: VisualState) => JSX.Element;
}

/** Prop values a control writes. */
export type PropValues = Record<string, number>;

/** Where the pointer is during a control gesture. */
export interface ControlPointer {
  /** In the part's own coordinates (canvas units, origin at the part origin). */
  x: number;
  y: number;
  /** On screen (px): for gestures measured in screen distance. */
  clientX: number;
  clientY: number;
  /** `performance.now()`. */
  t: number;
}

/** One press-drag-release on a control. Every method may return prop values to write. */
export interface ControlSession {
  /** Written as the gesture starts. */
  set?: PropValues;
  move?(p: ControlPointer): PropValues | void;
  release?(p: ControlPointer): PropValues | void;
  /**
   * Called about 10 times a second from the press on, and after the release
   * too, until it reports `done` (a sensor warmed by a finger cools down
   * again). `props` are the part's current values.
   */
  tick?(t: number, held: boolean, props: Record<string, string | number>): { set?: PropValues; done?: boolean };
  /** Handed to the next session on the same control while this one still ticks. */
  carry?: unknown;
}

export interface PartControl {
  /** What to do, shown while the pointer is over it (Korean). */
  hint: string;
  start(p: ControlPointer, props: Record<string, string | number>, carry?: unknown): ControlSession;
  /** The mouse wheel over the control (`deltaY` in pixels). */
  wheel?(deltaY: number, props: Record<string, string | number>): PropValues | void;
  /** Dragging further than a few pixels moves the part instead: a press
   * and hold operates it, a drag moves it (sensors touched with a finger). */
  holdOnly?: boolean;
}

/** Per-part state sampled from the simulator at ~60 Hz. */
export interface VisualState {
  /** LED brightness, 0–1 (first channel). */
  brightness?: number;
  /** Brightness per colour channel (RGB LED: R, G, B). */
  channels?: number[];
  /** Current above the LED's maximum this frame. */
  overcurrent?: boolean;
  /** Fraction of the frame a buzzer was powered. */
  on?: number;
  /** Passive buzzer tone in Hz. */
  freq?: number;
  /** Servo horn / motor shaft angle (degrees). */
  angle?: number;
  /** Motor speed (rev/min). */
  rpm?: number;
  /** The part's supply is too low. */
  unpowered?: boolean;
  /** Display contents: 64 rows × 128 pixels, MSB first, base64. */
  screen?: string;
  /** A reading shown on the part (RTC date and time). */
  text?: string;
  /** NeoPixel colours, 0xRRGGBB per LED. */
  leds?: number[];
  /** Character LCD contents. */
  lcd?: LcdView;
  /** LED dot-matrix contents (MAX7219 chain). */
  matrix?: MatrixView;
  /** Relay: COM is on NO (else on NC). */
  closed?: boolean;
  /** 74HC595 registers. */
  register?: ShiftView;
  /** TM1637 digits. */
  digits?: DigitsView;
  /** The control (`data-drag`) being operated now. */
  control?: string;
  /** The pressable element held down now (`data-action`). */
  action?: string;
  pressed?: boolean;
  burnt?: boolean;
}

/** What a character LCD shows (`simucleo_circuit::sim::LcdView`). */
export interface LcdView {
  /** Character codes per row (0–7 are the custom characters). */
  rows: number[][];
  /** 8 custom characters × 8 rows of 5 pixels. */
  cgram: number[];
  backlight: boolean;
  cursor?: [number, number];
  blink: boolean;
}

/** What a 74HC595 holds (`simucleo_circuit::sim::ShiftView`). */
export interface ShiftView {
  /** Shift register, bit n = stage n. */
  shift: number;
  /** Storage register on Q0–Q7 (bit n = Qn). */
  latch: number;
  /** OE is low: the outputs drive (else high impedance). */
  enabled: boolean;
}

/** What a TM1637 shows (`simucleo_circuit::sim::DigitsView`). */
export interface DigitsView {
  /** Segment byte per digit, left first (bit 0 = a … bit 6 = g; digit 1's bit 7 = colon). */
  segments: number[];
  /** Pulse width 0–7. */
  brightness: number;
  on: boolean;
}

/** What a MAX7219 chain shows (`simucleo_circuit::sim::MatrixView`). */
export interface MatrixView {
  /** 8 rows per module (top first, bit 7 = left column), the module nearest DIN first. */
  rows: number[];
  /** Intensity 0–15 per module. */
  intensity: number[];
}
