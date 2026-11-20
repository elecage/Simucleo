// The MCU the configuration tool (M36) knows: STM32F401RETx in LQFP64. Its
// package pins, the alternate functions of each I/O pin (datasheet DS10086,
// table 9 "Alternate function mapping", only the peripherals the simulator
// models), the ADC1 inputs and the names CubeMX writes into a .ioc file.
// Pure data and lookups; unit tested in test/m36.test.ts.
import { nucleoHeaders } from "../parts/nucleo-pins.ts";

export const MCU = {
  userName: "STM32F401RETx",
  name: "STM32F401R(D-E)Tx",
  cpn: "STM32F401RET6",
  family: "STM32F4",
  package: "LQFP64",
  board: "NUCLEO-F401RE",
} as const;

export type PinKind = "io" | "power" | "reset" | "boot";

export interface PackagePin {
  /** Package pin number, 1–64 (counter-clockwise from the dot). */
  number: number;
  /** Port pin (`PA5`) or the power/control name (`VDD`, `NRST`). */
  name: string;
  kind: PinKind;
}

const PACKAGE: string[] = [
  "VBAT", "PC13", "PC14", "PC15", "PH0", "PH1", "NRST", "PC0", "PC1", "PC2", "PC3", "VSSA", "VDDA", "PA0", "PA1", "PA2",
  "PA3", "VSS", "VDD", "PA4", "PA5", "PA6", "PA7", "PC4", "PC5", "PB0", "PB1", "PB2", "PB10", "VCAP1", "VSS", "VDD",
  "PB12", "PB13", "PB14", "PB15", "PC6", "PC7", "PC8", "PC9", "PA8", "PA9", "PA10", "PA11", "PA12", "PA13", "VSS", "VDD",
  "PA14", "PA15", "PC10", "PC11", "PC12", "PD2", "PB3", "PB4", "PB5", "PB6", "PB7", "BOOT0", "PB8", "PB9", "VSS", "VDD",
];

export const PACKAGE_PINS: PackagePin[] = PACKAGE.map((name, i) => ({
  number: i + 1,
  name,
  kind: /^P[A-H]\d+$/.test(name) ? "io" : name === "NRST" ? "reset" : name === "BOOT0" ? "boot" : "power",
}));

/** The I/O pins in package order. */
export const IO_PINS = PACKAGE_PINS.filter((p) => p.kind === "io").map((p) => p.name);

export const isIoPin = (p: string) => IO_PINS.includes(p);

/** `PA5` → { port: "A", pin: 5 }. */
export function portPin(p: string): { port: string; pin: number } {
  const m = /^P([A-H])(\d+)$/.exec(p);
  if (!m) throw new Error(`not a port pin: ${p}`);
  return { port: m[1], pin: Number(m[2]) };
}

/** The pin names CubeMX uses in a .ioc (`PC13-ANTI_TAMP`, `PH0 - OSC_IN`). */
const IOC_NAME: Record<string, string> = {
  PC13: "PC13-ANTI_TAMP",
  PC14: "PC14-OSC32_IN",
  PC15: "PC15-OSC32_OUT",
  PH0: "PH0 - OSC_IN",
  PH1: "PH1 - OSC_OUT",
  PA0: "PA0-WKUP",
};
export const iocPinName = (p: string) => IOC_NAME[p] ?? p;
/** `PC13-ANTI_TAMP` → `PC13`; null for virtual pins (`VP_SYS_VS_Systick`). */
export function pinFromIoc(name: string): string | null {
  const m = /^(P[A-H]\d+)(\b|-|\s)/.exec(name.trim());
  return m && isIoPin(m[1]) ? m[1] : null;
}

// ------------------------------------------------------------------ AF

/** One alternate function: AF number and signal (`USART2_TX`). */
export interface AltFunction {
  af: number;
  signal: string;
}

/**
 * Alternate functions per pin (DS10086 table 9) for the peripherals the
 * simulator models: TIM1–5, TIM9–11, I2C1–3, SPI1–3, USART1/2/6, plus SYS
 * (debug) and RCC (MCO) on AF0. OTG, SDIO, I2S and EVENTOUT are left out.
 */
const AF: Record<string, [number, string][]> = {
  PA0: [[1, "TIM2_CH1"], [2, "TIM5_CH1"], [7, "USART2_CTS"]],
  PA1: [[1, "TIM2_CH2"], [2, "TIM5_CH2"], [7, "USART2_RTS"]],
  PA2: [[1, "TIM2_CH3"], [2, "TIM5_CH3"], [3, "TIM9_CH1"], [7, "USART2_TX"]],
  PA3: [[1, "TIM2_CH4"], [2, "TIM5_CH4"], [3, "TIM9_CH2"], [7, "USART2_RX"]],
  PA4: [[5, "SPI1_NSS"], [6, "SPI3_NSS"], [7, "USART2_CK"]],
  PA5: [[1, "TIM2_CH1"], [5, "SPI1_SCK"]],
  PA6: [[1, "TIM1_BKIN"], [2, "TIM3_CH1"], [5, "SPI1_MISO"]],
  PA7: [[1, "TIM1_CH1N"], [2, "TIM3_CH2"], [5, "SPI1_MOSI"]],
  PA8: [[0, "RCC_MCO_1"], [1, "TIM1_CH1"], [4, "I2C3_SCL"], [7, "USART1_CK"]],
  PA9: [[1, "TIM1_CH2"], [7, "USART1_TX"]],
  PA10: [[1, "TIM1_CH3"], [7, "USART1_RX"]],
  PA11: [[1, "TIM1_CH4"], [7, "USART1_CTS"], [8, "USART6_TX"]],
  PA12: [[1, "TIM1_ETR"], [7, "USART1_RTS"], [8, "USART6_RX"]],
  PA13: [[0, "SYS_JTMS-SWDIO"]],
  PA14: [[0, "SYS_JTCK-SWCLK"]],
  PA15: [[0, "SYS_JTDI"], [1, "TIM2_CH1"], [5, "SPI1_NSS"], [6, "SPI3_NSS"]],
  PB0: [[1, "TIM1_CH2N"], [2, "TIM3_CH3"]],
  PB1: [[1, "TIM1_CH3N"], [2, "TIM3_CH4"]],
  PB2: [],
  PB3: [[0, "SYS_JTDO-SWO"], [1, "TIM2_CH2"], [5, "SPI1_SCK"], [6, "SPI3_SCK"], [9, "I2C2_SDA"]],
  PB4: [[0, "SYS_JTRST"], [2, "TIM3_CH1"], [5, "SPI1_MISO"], [6, "SPI3_MISO"], [9, "I2C3_SDA"]],
  PB5: [[2, "TIM3_CH2"], [4, "I2C1_SMBA"], [5, "SPI1_MOSI"], [6, "SPI3_MOSI"]],
  PB6: [[2, "TIM4_CH1"], [4, "I2C1_SCL"], [7, "USART1_TX"]],
  PB7: [[2, "TIM4_CH2"], [4, "I2C1_SDA"], [7, "USART1_RX"]],
  PB8: [[2, "TIM4_CH3"], [3, "TIM10_CH1"], [4, "I2C1_SCL"]],
  PB9: [[2, "TIM4_CH4"], [3, "TIM11_CH1"], [4, "I2C1_SDA"], [5, "SPI2_NSS"]],
  PB10: [[1, "TIM2_CH3"], [4, "I2C2_SCL"], [5, "SPI2_SCK"]],
  PB12: [[1, "TIM1_BKIN"], [4, "I2C2_SMBA"], [5, "SPI2_NSS"]],
  PB13: [[1, "TIM1_CH1N"], [5, "SPI2_SCK"]],
  PB14: [[1, "TIM1_CH2N"], [5, "SPI2_MISO"]],
  PB15: [[1, "TIM1_CH3N"], [5, "SPI2_MOSI"]],
  PC0: [],
  PC1: [],
  PC2: [[5, "SPI2_MISO"]],
  PC3: [[5, "SPI2_MOSI"]],
  PC4: [],
  PC5: [],
  PC6: [[2, "TIM3_CH1"], [8, "USART6_TX"]],
  PC7: [[2, "TIM3_CH2"], [8, "USART6_RX"]],
  PC8: [[2, "TIM3_CH3"], [8, "USART6_CK"]],
  PC9: [[0, "RCC_MCO_2"], [2, "TIM3_CH4"], [4, "I2C3_SDA"]],
  PC10: [[6, "SPI3_SCK"]],
  PC11: [[6, "SPI3_MISO"]],
  PC12: [[6, "SPI3_MOSI"]],
  PC13: [],
  PC14: [],
  PC15: [],
  PD2: [[2, "TIM3_ETR"]],
  PH0: [],
  PH1: [],
};

export function altFunctions(pin: string): AltFunction[] {
  return (AF[pin] ?? []).map(([af, signal]) => ({ af, signal }));
}

/** The AF number of `signal` on `pin`, or null when that pin cannot carry it. */
export function afNumber(pin: string, signal: string): number | null {
  return (AF[pin] ?? []).find(([, s]) => s === signal)?.[0] ?? null;
}

/** The pins that can carry `signal` (AF or ADC input). */
export function pinsFor(signal: string): string[] {
  return IO_PINS.filter((p) => afNumber(p, signal) !== null || adcChannel(p) !== null && signal === `ADC1_IN${adcChannel(p)}`);
}

/** The HAL macro of an AF: 7, USART2_TX → `GPIO_AF7_USART2`. */
export function afMacro(af: number, signal: string): string {
  return `GPIO_AF${af}_${signal.split("_")[0]}`;
}

// ------------------------------------------------------------------ ADC

const ADC_IN: Record<string, number> = {
  PA0: 0, PA1: 1, PA2: 2, PA3: 3, PA4: 4, PA5: 5, PA6: 6, PA7: 7, PB0: 8, PB1: 9,
  PC0: 10, PC1: 11, PC2: 12, PC3: 13, PC4: 14, PC5: 15,
};
export const adcChannel = (pin: string): number | null => ADC_IN[pin] ?? null;
export const adcPin = (ch: number): string | null => Object.keys(ADC_IN).find((p) => ADC_IN[p] === ch) ?? null;

// ------------------------------------------------------------------ signals

/** Special pins: what they do on the Nucleo, and the signal CubeMX puts there. */
export const FIXED_SIGNALS: Record<string, string[]> = {
  PH0: ["RCC_OSC_IN"],
  PH1: ["RCC_OSC_OUT"],
  PC14: ["RCC_OSC32_IN"],
  PC15: ["RCC_OSC32_OUT"],
};

export type SignalKind = "gpio" | "exti" | "analog" | "af" | "adc" | "sys" | "rcc";

export interface SignalChoice {
  signal: string;
  kind: SignalKind;
  /** The peripheral it belongs to (`USART2`), for AF/ADC signals. */
  peripheral?: string;
  /** Not something the code generator can set up yet. */
  unsupported?: boolean;
}

/** Signals whose code the generator writes (others can be shown but not generated). */
export function signalSupported(signal: string): boolean {
  return (
    /^GPIO_(Input|Output|Analog)$/.test(signal) ||
    /^GPXTI\d+$/.test(signal) ||
    /^ADC1_IN\d+$/.test(signal) ||
    /^USART[126]_(TX|RX)$/.test(signal) ||
    /^I2C[123]_(SCL|SDA)$/.test(signal) ||
    /^SPI[123]_(SCK|MISO|MOSI)$/.test(signal) ||
    /^TIM(1|2|3|4|5|9|10|11)_CH[1-4]$/.test(signal) ||
    /^SYS_JT(MS-SWDIO|CK-SWCLK)$/.test(signal) ||
    /^RCC_OSC(32)?_(IN|OUT)$/.test(signal)
  );
}

export const peripheralOf = (signal: string): string | undefined => {
  if (/^ADC1_IN/.test(signal)) return "ADC1";
  const m = /^(USART\d|I2C\d|SPI\d|TIM\d+)_/.exec(signal);
  return m?.[1];
};

/** Everything a pin can be set to, as the pin menu lists it. */
export function signalChoices(pin: string): SignalChoice[] {
  const { pin: n } = portPin(pin);
  const out: SignalChoice[] = [
    { signal: "GPIO_Input", kind: "gpio" },
    { signal: "GPIO_Output", kind: "gpio" },
    { signal: "GPIO_Analog", kind: "analog" },
    { signal: `GPXTI${n}`, kind: "exti" },
  ];
  const ch = adcChannel(pin);
  if (ch !== null) out.push({ signal: `ADC1_IN${ch}`, kind: "adc", peripheral: "ADC1" });
  for (const a of altFunctions(pin)) {
    const kind: SignalKind = a.signal.startsWith("SYS_") ? "sys" : a.signal.startsWith("RCC_") ? "rcc" : "af";
    out.push({ signal: a.signal, kind, peripheral: peripheralOf(a.signal), unsupported: !signalSupported(a.signal) || undefined });
  }
  for (const s of FIXED_SIGNALS[pin] ?? []) out.push({ signal: s, kind: "rcc" });
  return out;
}

/** The board's header names for a pin (`PA5` → `D13 · CN10-11`). */
export function boardNames(pin: string): string[] {
  return nucleoHeaders(pin);
}

/** What the Nucleo board itself connects to a pin. */
export const ONBOARD: Record<string, string> = {
  PA5: "LD2 (초록 LED)",
  PC13: "B1 (파란 버튼)",
  PA2: "USART2_TX → ST-LINK 가상 COM",
  PA3: "USART2_RX → ST-LINK 가상 COM",
  PA13: "SWDIO (ST-LINK)",
  PA14: "SWCLK (ST-LINK)",
  PH0: "ST-LINK MCO 8 MHz (HSE 바이패스)",
  PH1: "OSC_OUT",
  PC14: "LSE 32.768 kHz (X2)",
  PC15: "LSE 32.768 kHz (X2)",
};

// ------------------------------------------------------------------ IRQs

/** The IRQ names (IRQn without the suffix) a peripheral uses. */
export function irqsOf(peripheral: string): string[] {
  switch (peripheral) {
    case "TIM1":
      return ["TIM1_UP_TIM10"];
    case "TIM9":
      return ["TIM1_BRK_TIM9"];
    case "TIM10":
      return ["TIM1_UP_TIM10"];
    case "TIM11":
      return ["TIM1_TRG_COM_TIM11"];
    case "ADC1":
      return ["ADC"];
    default:
      if (/^I2C\d$/.test(peripheral)) return [`${peripheral}_EV`, `${peripheral}_ER`];
      return [peripheral];
  }
}

/** The EXTI IRQ of a line: 0–4 own one, 5–9 and 10–15 share. */
export const extiIrq = (line: number) => (line <= 4 ? `EXTI${line}` : line <= 9 ? "EXTI9_5" : "EXTI15_10");
