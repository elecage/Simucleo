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
  /** Renders the body. Pin markers are drawn by the editor. */
  render: (props: Record<string, string | number>, visual: VisualState) => JSX.Element;
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
