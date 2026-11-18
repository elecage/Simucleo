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
const H = 32;
const X0 = 11; // grid x of header column 1
// Rows in grid steps. Gaps between rows hold the silkscreen labels.
const Y = {
  cn10Outer: 2, cn10Inner: 3, arduinoTop: 6,
  arduinoBottom: H - 6, cn7Inner: H - 3, cn7Outer: H - 2,
};

const sig = (s: string) => SIGNAL_ALIAS[s] ?? s;
const describe = (signal: string) => (NOTES[signal] ? `${signal} · ${NOTES[signal]}` : signal);

type Side = "above" | "below";
/** Silkscreen text printed next to each pin, and on which side of the pin. */
const silk = new Map<string, { text: string; side: Side; signal: string }>();

function morpho(
  name: "CN7" | "CN10",
  rows: [string, string][],
  odd: { y: number; side: Side },
  even: { y: number; side: Side },
): PinDef[] {
  return rows.flatMap(([o, e], i) =>
    ([[2 * i + 1, o, odd], [2 * i + 2, e, even]] as const).map(([n, signal, row]) => {
      const id = `${name}_${n}`;
      silk.set(id, { text: signal, side: row.side, signal });
      return { id, x: X0 + i, y: row.y, signal, label: `${name}-${n} · ${describe(signal)}` };
    }),
  );
}

function arduino(rows: [string, string, string, number][], y: number, side: Side): PinDef[] {
  return rows.map(([id, signal, extra, col]) => {
    const name = id.replace(/_.*/, "");
    silk.set(id, { text: name, side, signal });
    return {
      id,
      x: X0 + col - 1,
      y,
      signal,
      label: [name, signal === id ? "" : describe(signal), extra].filter(Boolean).join(" · "),
    };
  });
}

const pins: PinDef[] = [
  // On the real board CN7's even column and CN10's odd column face the
  // Arduino headers; those are the columns that duplicate Arduino signals.
  ...morpho("CN10", CN10, { y: Y.cn10Inner, side: "below" }, { y: Y.cn10Outer, side: "above" }),
  ...morpho("CN7", CN7, { y: Y.cn7Outer, side: "below" }, { y: Y.cn7Inner, side: "above" }),
  ...arduino(ARDUINO_TOP, Y.arduinoTop, "below"),
  ...arduino(ARDUINO_BOTTOM, Y.arduinoBottom, "above"),
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

const POWER = new Set(["3V3", "5V", "VDD", "AVDD", "U5V", "E5V", "VIN", "IOREF", "VBAT"]);
/** Pins already used by on-board circuitry (ST-LINK, crystals). */
const BUSY = new Set(["PA2", "PA3", "PA13", "PA14", "PH0", "PH1", "PC14", "PC15"]);
const ONBOARD = new Set(["PA5", "PC13"]);

/** Colour class of a label, so students can tell power, ground and I/O apart. */
function labelClass(signal: string): string {
  const s = sig(signal);
  if (s === "GND") return "lbl gnd";
  if (POWER.has(s)) return "lbl pwr";
  if (s === "NC") return "lbl nc";
  if (s === "RESET" || s === "BOOT0") return "lbl ctl";
  if (BUSY.has(s)) return "lbl busy";
  if (ONBOARD.has(s)) return "lbl onboard";
  return "lbl io";
}

const px = (g: number) => g * PITCH;
const headerSpan = (cols: [number, number], y0: number, rows: number) => ({
  x: px(X0 + cols[0] - 1) - 5,
  y: px(y0) - 5,
  width: px(cols[1] - cols[0]) + 10,
  height: px(rows - 1) + 10,
});

/** Vertical label: reads bottom-to-top, starting 0.6 grid away from the pin. */
function PinLabel({ pin }: { pin: PinDef }) {
  const s = silk.get(pin.id);
  if (!s) return null;
  const x = px(pin.x);
  const y = px(pin.y) + (s.side === "above" ? -5 : 5);
  return (
    <text
      transform={`translate(${x} ${y}) rotate(-90)`}
      textAnchor={s.side === "above" ? "start" : "end"}
      dominantBaseline="central"
      className={labelClass(s.signal)}
    >
      {s.text}
    </text>
  );
}

/** Pin numbers at both ends of a Morpho header, like the real silkscreen. */
function MorphoIndex({ name, oddY, evenY }: { name: string; oddY: number; evenY: number }) {
  const left = px(X0 - 1) + 3;
  const right = px(X0 + 19) - 3;
  return (
    <g className="pin-index">
      <text x={left} y={px(oddY)} textAnchor="end" dominantBaseline="central">1</text>
      <text x={left} y={px(evenY)} textAnchor="end" dominantBaseline="central">2</text>
      <text x={right} y={px(oddY)} dominantBaseline="central">37</text>
      <text x={right} y={px(evenY)} dominantBaseline="central">38</text>
      <text x={px(X0 + 20.5)} y={px((oddY + evenY) / 2)} dominantBaseline="central" className="silk">{name}</text>
    </g>
  );
}

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
      <rect x={px(-0.6)} y={px(12.5)} width={px(4)} height={px(5)} rx={1.5} className="usb" />
      <text x={px(1)} y={px(21)} className="silk">ST-LINK V2-1</text>
      <rect x={px(4)} y={px(6)} width={px(3)} height={px(3)} className="chip" />
      {/* Label colour legend */}
      <g transform={`translate(${px(1)} ${px(23.5)})`} className="legend">
        {[["io", "GPIO"], ["onboard", "보드 내장 (LD2/B1)"], ["busy", "ST-LINK·크리스털 사용"], ["pwr", "전원"], ["gnd", "GND"], ["nc", "NC"]].map(
          ([cls, text], i) => (
            <g key={cls} transform={`translate(0 ${i * 7})`}>
              <rect width={5} height={5} y={-4} className={`swatch-${cls}`} />
              <text x={8} className="silk small">{text}</text>
            </g>
          ),
        )}
      </g>

      {/* Morpho (male, 2×19) */}
      <rect {...headerSpan([1, 19], Y.cn10Outer, 2)} className="morpho" />
      <rect {...headerSpan([1, 19], Y.cn7Inner, 2)} className="morpho" />
      <MorphoIndex name="CN10" oddY={Y.cn10Inner} evenY={Y.cn10Outer} />
      <MorphoIndex name="CN7" oddY={Y.cn7Outer} evenY={Y.cn7Inner} />

      {/* Arduino (female) */}
      <rect {...headerSpan([2, 11], Y.arduinoTop, 1)} className="arduino" />
      <rect {...headerSpan([12, 19], Y.arduinoTop, 1)} className="arduino" />
      <rect {...headerSpan([5, 12], Y.arduinoBottom, 1)} className="arduino" />
      <rect {...headerSpan([14, 19], Y.arduinoBottom, 1)} className="arduino" />
      <text x={px(X0 - 1.5)} y={px(Y.arduinoTop)} dominantBaseline="central" textAnchor="end" className="silk small">CN5</text>
      <text x={px(X0 + 19.5)} y={px(Y.arduinoTop)} dominantBaseline="central" className="silk small">CN9</text>
      <text x={px(X0 + 2.5)} y={px(Y.arduinoBottom)} dominantBaseline="central" textAnchor="end" className="silk small">CN6</text>
      <text x={px(X0 + 19.5)} y={px(Y.arduinoBottom)} dominantBaseline="central" className="silk small">CN8</text>

      {/* MCU and user I/O */}
      <rect x={px(19)} y={px(11.5)} width={px(7)} height={px(7)} className="chip" />
      <text x={px(22.5)} y={px(15.2)} className="silk chip-label">STM32F401RE</text>
      <text x={px(17)} y={px(21.5)} className="silk">NUCLEO-F401RE</text>
      <rect x={px(15.5)} y={px(10)} width={px(1)} height={px(0.6)} className="smd-led" />
      <rect
        x={px(15.5)} y={px(10)} width={px(1)} height={px(0.6)}
        className="smd-led-glow" style={{ opacity: visual.brightness ?? 0 }}
      />
      <text x={px(15.3)} y={px(11.8)} className="silk small">LD2</text>
      <rect x={px(11)} y={px(16)} width={px(2.4)} height={px(2.4)} className="btn-body" />
      <circle cx={px(12.2)} cy={px(17.2)} r={px(0.8)} className="btn-cap blue" />
      <text x={px(11.3)} y={px(19.6)} className="silk small">B1 USER</text>
      <rect x={px(11)} y={px(11)} width={px(2.4)} height={px(2.4)} className="btn-body" />
      <circle cx={px(12.2)} cy={px(12.2)} r={px(0.8)} className="btn-cap" />
      <text x={px(11.3)} y={px(14.6)} className="silk small">B2 RESET</text>

      {pins.map((p) =>
        p.id.startsWith("CN") ? (
          <rect key={p.id} x={px(p.x) - 1.6} y={px(p.y) - 1.6} width={3.2} height={3.2} className="header-pin" />
        ) : (
          <rect key={p.id} x={px(p.x) - 2} y={px(p.y) - 2} width={4} height={4} className="socket" />
        ),
      )}
      {pins.map((p) => (
        <PinLabel key={p.id} pin={p} />
      ))}
    </g>
  ),
};
