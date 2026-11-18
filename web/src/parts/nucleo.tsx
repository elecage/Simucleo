import { PITCH, type PartDef, type PinDef } from "./types";

/*
 * Nucleo-64 (MB1136) with STM32F401RE, pin assignment from UM1724.
 *
 * Drawn landscape with the ST-LINK on the left, so the board's right edge
 * (CN10 + Arduino CN5/CN9) is on top and its left edge (CN7 + Arduino
 * CN6/CN8) is at the bottom. Pin 1 of every header is on the ST-LINK side.
 *
 * Every pin carries a `signal`; pins sharing a signal (Arduino D13 and
 * Morpho CN10-11 are both PA5, all GND pins, …) are bused together.
 */

/** Notes shown in tooltips for pins with on-board functions. */
const NOTES: Record<string, string> = {
  PA5: "LD2",
  PC13: "B1 USER",
  PA2: "USART2_TX → ST-LINK VCP",
  PA3: "USART2_RX → ST-LINK VCP",
  PA13: "SWDIO (ST-LINK)",
  PA14: "SWCLK (ST-LINK)",
  PH0: "OSC_IN (ST-LINK MCO)",
  PH1: "OSC_OUT",
  PC14: "OSC32_IN (LSE)",
  PC15: "OSC32_OUT (LSE)",
  PB8: "I2C1_SCL",
  PB9: "I2C1_SDA",
};

/** Electrical nets the Nucleo ties together on the PCB. */
const SIGNAL_ALIAS: Record<string, string> = {
  AGND: "GND",
  AVDD: "3V3",
  VDD: "3V3",
  U5V: "5V",
};

// CN7: [odd, even] for pins 1/2 … 37/38.
const CN7: [string, string][] = [
  ["PC10", "PC11"], ["PC12", "PD2"], ["VDD", "E5V"], ["BOOT0", "GND"], ["NC", "NC"],
  ["NC", "IOREF"], ["PA13", "RESET"], ["PA14", "3V3"], ["PA15", "5V"], ["GND", "GND"],
  ["PB7", "GND"], ["PC13", "VIN"], ["PC14", "NC"], ["PC15", "PA0"], ["PH0", "PA1"],
  ["PH1", "PA4"], ["VBAT", "PB0"], ["PC2", "PC1"], ["PC3", "PC0"],
];

// CN10: [odd, even]. CN10-18 is PB11 on other Nucleo-64 boards, but the
// STM32F401RE LQFP64 has VCAP1 there, so it is not connected.
const CN10: [string, string][] = [
  ["PC9", "PC8"], ["PB8", "PC6"], ["PB9", "PC5"], ["AVDD", "U5V"], ["GND", "NC"],
  ["PA5", "PA12"], ["PA6", "PA11"], ["PA7", "PB12"], ["PB6", "NC"], ["PC7", "GND"],
  ["PA9", "PB2"], ["PA8", "PB1"], ["PB10", "PB15"], ["PB4", "PB14"], ["PB5", "PB13"],
  ["PB3", "AGND"], ["PA10", "PC4"], ["PA2", "NC"], ["PA3", "NC"],
];

// Arduino Uno R3 headers: [id, signal, extra label]. Position = column (1–19)
// shared with the Morpho header next to it.
const ARDUINO_TOP: [string, string, string, number][] = [
  ["D15", "PB8", "SCL", 2], ["D14", "PB9", "SDA", 3], ["AREF", "AVDD", "", 4], ["GND_D", "GND", "", 5],
  ["D13", "PA5", "SCK", 6], ["D12", "PA6", "MISO", 7], ["D11", "PA7", "MOSI / PWM", 8],
  ["D10", "PB6", "CS / PWM", 9], ["D9", "PC7", "PWM", 10], ["D8", "PA9", "", 11],
  ["D7", "PA8", "", 12], ["D6", "PB10", "PWM", 13], ["D5", "PB4", "PWM", 14], ["D4", "PB5", "", 15],
  ["D3", "PB3", "PWM", 16], ["D2", "PA10", "", 17], ["D1", "PA2", "TX", 18], ["D0", "PA3", "RX", 19],
];
const ARDUINO_BOTTOM: [string, string, string, number][] = [
  ["NC_A", "NC", "", 5], ["IOREF", "IOREF", "", 6], ["RESET", "RESET", "", 7], ["3V3", "3V3", "", 8],
  ["5V", "5V", "", 9], ["GND_P1", "GND", "", 10], ["GND_P2", "GND", "", 11], ["VIN", "VIN", "", 12],
  ["A0", "PA0", "", 14], ["A1", "PA1", "", 15], ["A2", "PA4", "", 16],
  ["A3", "PB0", "", 17], ["A4", "PC1", "", 18], ["A5", "PC0", "", 19],
];

const W = 34;
const H = 27;
const X0 = 11; // grid x of header column 1
const Y = { cn10Outer: 1, cn10Inner: 2, arduinoTop: 4, arduinoBottom: H - 4, cn7Inner: H - 2, cn7Outer: H - 1 };

const sig = (s: string) => SIGNAL_ALIAS[s] ?? s;
const describe = (signal: string) => (NOTES[signal] ? `${signal} · ${NOTES[signal]}` : signal);

function morpho(name: "CN7" | "CN10", rows: [string, string][], oddY: number, evenY: number): PinDef[] {
  return rows.flatMap(([odd, even], i) => [
    { id: `${name}_${2 * i + 1}`, x: X0 + i, y: oddY, signal: odd, label: `${name}-${2 * i + 1} · ${describe(odd)}` },
    { id: `${name}_${2 * i + 2}`, x: X0 + i, y: evenY, signal: even, label: `${name}-${2 * i + 2} · ${describe(even)}` },
  ]);
}

function arduino(rows: [string, string, string, number][], y: number): PinDef[] {
  return rows.map(([id, signal, extra, col]) => ({
    id,
    x: X0 + col - 1,
    y,
    signal,
    label: [id.replace(/_.*/, ""), signal === id ? "" : describe(signal), extra].filter(Boolean).join(" · "),
  }));
}

const pins: PinDef[] = [
  // On the real board CN7's even column and CN10's odd column face the
  // Arduino headers; those are the columns that duplicate Arduino signals.
  ...morpho("CN10", CN10, Y.cn10Inner, Y.cn10Outer),
  ...morpho("CN7", CN7, Y.cn7Outer, Y.cn7Inner),
  ...arduino(ARDUINO_TOP, Y.arduinoTop),
  ...arduino(ARDUINO_BOTTOM, Y.arduinoBottom),
];

// Bus every pin that shares a (normalised) signal; NC pins stay isolated.
const bySignal = new Map<string, string[]>();
for (const p of pins) {
  const s = sig(p.signal!);
  if (s === "NC") continue;
  bySignal.set(s, [...(bySignal.get(s) ?? []), p.id]);
}
const buses = [...bySignal.values()].filter((ids) => ids.length > 1);

/** MCU/board signal of a Nucleo pin id, e.g. `D13` → `PA5`, `CN7_8` → `GND`. */
export function nucleoSignal(pinId: string): string | undefined {
  const p = pins.find((q) => q.id === pinId);
  return p && sig(p.signal!);
}

const px = (g: number) => g * PITCH;
const headerSpan = (cols: [number, number], y0: number, rows: number) => ({
  x: px(X0 + cols[0] - 1) - 5,
  y: px(y0) - 5,
  width: px(cols[1] - cols[0]) + 10,
  height: px(rows - 1) + 10,
});

export const nucleoF401re: PartDef = {
  kind: "nucleo-f401re",
  name: "Nucleo-F401RE",
  category: "board",
  w: W,
  h: H,
  pins,
  buses,
  render: (_props, visual) => (
    <g>
      <rect width={px(W)} height={px(H)} rx={6} className="pcb" />
      {/* ST-LINK section */}
      <rect x={px(0.3)} y={px(0.3)} width={px(8.4)} height={px(H - 0.6)} rx={4} className="stlink-area" />
      <rect x={px(-0.6)} y={px(10.5)} width={px(4)} height={px(5)} rx={1.5} className="usb" />
      <text x={px(1)} y={px(19)} className="silk">ST-LINK V2-1</text>
      <rect x={px(4)} y={px(4)} width={px(3)} height={px(3)} className="chip" />

      {/* Morpho (male, 2×19) */}
      <rect {...headerSpan([1, 19], Y.cn10Outer, 2)} className="morpho" />
      <rect {...headerSpan([1, 19], Y.cn7Inner, 2)} className="morpho" />
      <text x={px(X0 + 19)} y={px(1.8)} className="silk">CN10</text>
      <text x={px(X0 + 19)} y={px(H - 1.2)} className="silk">CN7</text>

      {/* Arduino (female) */}
      <rect {...headerSpan([2, 11], Y.arduinoTop, 1)} className="arduino" />
      <rect {...headerSpan([12, 19], Y.arduinoTop, 1)} className="arduino" />
      <rect {...headerSpan([5, 12], Y.arduinoBottom, 1)} className="arduino" />
      <rect {...headerSpan([14, 19], Y.arduinoBottom, 1)} className="arduino" />
      <text x={px(X0 + 1)} y={px(5.6)} className="silk small">CN5</text>
      <text x={px(X0 + 11)} y={px(5.6)} className="silk small">CN9</text>
      <text x={px(X0 + 4)} y={px(H - 5.3)} className="silk small">CN6</text>
      <text x={px(X0 + 13)} y={px(H - 5.3)} className="silk small">CN8</text>

      {/* MCU and user I/O */}
      <rect x={px(18)} y={px(10)} width={px(7)} height={px(7)} className="chip" />
      <text x={px(21.5)} y={px(13.7)} className="silk chip-label">STM32F401RE</text>
      <text x={px(15)} y={px(20.5)} className="silk">NUCLEO-F401RE</text>
      <rect x={px(15.5)} y={px(7)} width={px(1)} height={px(0.6)} className="smd-led" />
      <rect
        x={px(15.5)} y={px(7)} width={px(1)} height={px(0.6)}
        className="smd-led-glow" style={{ opacity: visual.brightness ?? 0 }}
      />
      <text x={px(15.3)} y={px(8.8)} className="silk small">LD2</text>
      <rect x={px(11)} y={px(14)} width={px(2.4)} height={px(2.4)} className="btn-body" />
      <circle cx={px(12.2)} cy={px(15.2)} r={px(0.8)} className="btn-cap blue" />
      <text x={px(11.3)} y={px(17.6)} className="silk small">B1</text>
      <rect x={px(11)} y={px(9)} width={px(2.4)} height={px(2.4)} className="btn-body" />
      <circle cx={px(12.2)} cy={px(10.2)} r={px(0.8)} className="btn-cap" />
      <text x={px(11.3)} y={px(12.6)} className="silk small">B2 RESET</text>

      {pins.map((p) => {
        const female = !p.id.startsWith("CN");
        return female ? (
          <rect key={p.id} x={px(p.x) - 2} y={px(p.y) - 2} width={4} height={4} className="socket" />
        ) : (
          <rect key={p.id} x={px(p.x) - 1.6} y={px(p.y) - 1.6} width={3.2} height={3.2} className="header-pin" />
        );
      })}
    </g>
  ),
};
