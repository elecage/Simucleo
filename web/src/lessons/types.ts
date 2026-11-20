// Guided exercises (M16): the lesson file format. Lessons live in
// web/lessons/*.json and are bundled with the site; docs/lessons.md
// documents every field for teachers who write their own.

/** A project as in a `.simucleo.json` file (only parts and wires are used). */
export interface InlineProject {
  parts: { id: string; kind: string; x: number; y: number; props?: Record<string, string | number> }[];
  wires: {
    id?: string;
    a: { part: string; pin: string };
    b: { part: string; pin: string };
    color?: string;
    points?: { x: number; y: number }[];
  }[];
}

/** Where the lesson starts. */
export type LessonStart =
  /** The board and an empty breadboard ("새로"). */
  | "empty"
  /** A bundled example project, by file name (`hal-button-exti.simucleo.json`). */
  | { example: string }
  /** A project written into the lesson. */
  | { project: InlineProject };

/** The firmware to run: a bundled example ELF, or one the student builds. */
export type LessonFirmware = { example: string } | "upload";

// ----------------------------------------------------------------- checks

interface CheckBase {
  /** What the checklist shows (Korean). A default is made from the check. */
  label?: string;
  /** Shown when the check fails, instead of the automatic hint. */
  hint?: string;
}

// Wiring checks: evaluated live from the netlist as the student wires.

/** At least `count` (default 1) parts of `kind` are in the circuit. */
export interface PartCheck extends CheckBase {
  type: "part";
  kind: string;
  count?: number;
}

/**
 * Pin `pin` of some part of `kind` is on the same net as `to`: an MCU signal
 * (`PA5`), `GND`, `3V3`, `5V` or `VIN`.
 */
export interface ConnectedCheck extends CheckBase {
  type: "connected";
  kind: string;
  pin: string;
  to: string;
}

/**
 * Between `from` and `to` (signals, as above) there is a series chain of
 * exactly the parts in `through`, in any order: `resistor`, `led-5mm`,
 * `tact-switch` (across the switch), `potentiometer` (end to end), or a
 * channel of an RGB LED (`rgb-led:R`). LEDs must point from `from` to `to`
 * (anode toward `from`).
 */
export interface SeriesCheck extends CheckBase {
  type: "series";
  from: string;
  to: string;
  through: string[];
}

/** No electrical-rule warning is shown (LED without resistor, short, …). */
export interface NoWarningsCheck extends CheckBase {
  type: "noWarnings";
}

// Behaviour checks: evaluated over a run of the firmware ("채점").

/** Pin `pin` toggles with a period of `ms` ± `tolerance` (default 0.05). */
export interface PeriodCheck extends CheckBase {
  type: "period";
  pin: string;
  ms: number;
  tolerance?: number;
}

/**
 * Some LED of `kind` was brighter than `above` at some moment and darker
 * than `below` at another (either may be left out). `channel`: 0 R, 1 G,
 * 2 B for an RGB LED.
 */
export interface BrightnessCheck extends CheckBase {
  type: "brightness";
  kind: string;
  channel?: number;
  above?: number;
  below?: number;
}

/** The virtual COM port printed text matching `pattern` at least `count` times. */
export interface ConsoleCheck extends CheckBase {
  type: "console";
  pattern: string;
  flags?: string;
  count?: number;
}

/**
 * The numbers captured by the first group of `pattern` in the console
 * output spread over at least `minSpread` (max − min).
 */
export interface ConsoleValuesCheck extends CheckBase {
  type: "consoleValues";
  pattern: string;
  minSpread: number;
}

/**
 * The PWM duty of `pin` (0–1, averaged over at least 16 ms of simulated
 * time, see `dutyWindows`) was between `min` and `max`: at some moment (`mode: "some"`, the default) or the
 * whole time (`"always"`).
 */
export interface DutyCheck extends CheckBase {
  type: "duty";
  pin: string;
  min: number;
  max: number;
  mode?: "some" | "always";
}

/** A servo's `angle` or a motor's `rpm` moved over at least `minSpread`. */
export interface MotionCheck extends CheckBase {
  type: "motion";
  kind: string;
  field: "angle" | "rpm";
  minSpread: number;
}

/**
 * A display of `kind` shows something: an OLED at least `minPixels` lit
 * pixels (default 20), a character LCD text matching `text` (default: any).
 */
export interface DisplayCheck extends CheckBase {
  type: "display";
  kind: string;
  minPixels?: number;
  text?: string;
}

/** The firmware ran the whole time (no Error_Handler, HardFault, …). */
export interface RunningCheck extends CheckBase {
  type: "running";
}

export type WiringCheck = PartCheck | ConnectedCheck | SeriesCheck | NoWarningsCheck;
export type BehaviourCheck =
  | PeriodCheck
  | BrightnessCheck
  | ConsoleCheck
  | ConsoleValuesCheck
  | DutyCheck
  | MotionCheck
  | DisplayCheck
  | RunningCheck;
export type Check = WiringCheck | BehaviourCheck;

export const WIRING_TYPES = ["part", "connected", "series", "noWarnings"] as const;
export const BEHAVIOUR_TYPES = [
  "period",
  "brightness",
  "console",
  "consoleValues",
  "duty",
  "motion",
  "display",
  "running",
] as const;

export const isWiring = (c: Check): c is WiringCheck => (WIRING_TYPES as readonly string[]).includes(c.type);

// ---------------------------------------------------------------- grading

/** Something the grader does to the circuit during a run. */
export type Stimulus =
  /** Press a switch (`B1`, or the first part of a kind such as `tact-switch`) for `ms` (default 100). */
  | { at: number; press: string; ms?: number }
  /** Set a property of the first part of `kind` (a knob's `position`, …). */
  | { at: number; set: { kind: string; prop: string; value: number | string } }
  /**
   * Type a line (M32): into the virtual COM port (`to` left out or
   * `"console"`), or from the phone of the first part of kind `to` (`hc05`).
   * A line end (CR LF) is added.
   */
  | { at: number; send: string; to?: string }
  /** Connect the phone to the first part of kind `connect` (`hc05`) (M32). */
  | { at: number; connect: string };

export interface GradeSettings {
  /** Simulated time to run, in ms (default: long enough for every check). */
  ms?: number;
  stimuli?: Stimulus[];
}

export interface LessonStep {
  title: string;
  /** Markdown: **bold**, `code`, lists, ``` code blocks. A list of lines is joined. */
  text: string | string[];
  /** A short concept box ("개념"), Markdown (M32). */
  theory?: string | string[];
  /** Shown folded ("힌트"), Markdown (M32). */
  hint?: string | string[];
  checks: Check[];
}

export interface Lesson {
  id: string;
  /** Position in the list (easy to hard). */
  order: number;
  title: string;
  /** 입문, 초급, 중급, … */
  level: string;
  goal: string;
  /** The group the list shows the lesson in ("A. 기초 (GPIO·시간)") (M32). */
  track?: string;
  /** Estimated time in minutes (M32). */
  minutes?: number;
  /** Learning goals, one per item (M32). */
  objectives?: string[];
  /** What to know or have done first, Markdown (M32). */
  prereq?: string | string[];
  /** "흔한 실수": one Markdown item each (M32). */
  mistakes?: string[];
  /** "도전 과제" for fast students: one Markdown item each (M32). */
  challenges?: string[];
  start: LessonStart;
  firmware?: LessonFirmware;
  grade?: GradeSettings;
  steps: LessonStep[];
}

/** The outcome of one check. */
export interface CheckResult {
  pass: boolean;
  /** Why it failed, in Korean. */
  hint?: string;
  /** What was measured ("주기 1002 ms"), shown in either case. */
  detail?: string;
}
