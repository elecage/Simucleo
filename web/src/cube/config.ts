// The configuration model of the CubeMX-like tool (M36): pins and their
// signals, GPIO parameters, the clock tree, the peripherals the simulator
// models and their parameters, NVIC. Plain data (JSON-able, stored in the
// project as a .ioc text); every function here is pure and unit tested.
import { computeClock, defaultClock, type ClockConfig, type ClockTree, busClock, timerClock } from "./clock.ts";
import { adcChannel, afNumber, extiIrq, irqsOf, isIoPin, MCU, peripheralOf, pinsFor, portPin, signalSupported } from "./mcu.ts";
import { t } from "../i18n/index.ts";

export type Pull = "none" | "up" | "down";
export type Speed = "low" | "medium" | "high" | "very_high";
export type ExtiEdge = "rising" | "falling" | "both";

export interface PinConfig {
  /** `GPIO_Output`, `GPIO_Input`, `GPIO_Analog`, `GPXTI13`, `USART2_TX`, `TIM2_CH1`, `ADC1_IN0`, `SYS_JTMS-SWDIO`, … */
  signal: string;
  /** User label (`LD2`): `LD2_Pin`, `LD2_GPIO_Port` in main.h. */
  label?: string;
  pull?: Pull;
  speed?: Speed;
  /** Output: open drain instead of push-pull. */
  openDrain?: boolean;
  /** Output level after MX_GPIO_Init. */
  high?: boolean;
  /** EXTI trigger edge. */
  edge?: ExtiEdge;
}

export type WordLength = 8 | 9;
export type Parity = "none" | "even" | "odd";

export interface UartConfig {
  baud: number;
  wordLength: WordLength;
  parity: Parity;
  stopBits: 1 | 2;
  direction: "tx_rx" | "tx" | "rx";
}

export interface I2cConfig {
  /** 100 000 (standard) to 400 000 (fast). */
  speed: number;
  /** Fast mode duty cycle: Tlow/Thigh = 2 or 16/9. */
  duty: "2" | "16_9";
  ownAddress: number;
}

export interface SpiConfig {
  mode: "master" | "slave";
  direction: "2lines" | "tx_only";
  dataSize: 8 | 16;
  /** 2, 4, … 256. */
  prescaler: number;
  cpol: 0 | 1;
  cpha: 0 | 1;
  firstBit: "msb" | "lsb";
}

export type CounterMode = "up" | "down" | "center1" | "center2" | "center3";

export interface TimChannel {
  /** Only PWM generation for now. */
  mode: "pwm";
  pulse: number;
  /** PWM1 (high while CNT < CCR) or PWM2. */
  pwmMode: 1 | 2;
  polarity: "high" | "low";
}

export interface TimConfig {
  prescaler: number;
  period: number;
  counterMode: CounterMode;
  autoReloadPreload: boolean;
  /** TIM1 only: repetition counter. */
  repetition?: number;
  /** Channel 1–4 (index 0–3). */
  channels: (TimChannel | null)[];
}

export interface AdcRank {
  channel: number;
  /** Cycles: 3, 15, 28, 56, 84, 112, 144, 480. */
  sampling: number;
}

export interface AdcConfig {
  resolution: 12 | 10 | 8 | 6;
  scan: boolean;
  continuous: boolean;
  /** Regular conversions in rank order. */
  ranks: AdcRank[];
  eocEachConversion: boolean;
}

export interface NvicEntry {
  enabled: boolean;
  preempt: number;
  sub: number;
}

export interface CubeConfig {
  mcu: typeof MCU.userName;
  projectName: string;
  /** The bundled STM32CubeF4 drivers (pack id, see packs.ts). */
  drivers: string;
  pins: Record<string, PinConfig>;
  clock: ClockConfig;
  sys: { debug: "serial_wire" | "none" };
  usart: Partial<Record<UsartName, UartConfig>>;
  i2c: Partial<Record<I2cName, I2cConfig>>;
  spi: Partial<Record<SpiName, SpiConfig>>;
  tim: Partial<Record<TimName, TimConfig>>;
  adc: Partial<Record<"ADC1", AdcConfig>>;
  /** IRQ name without `_IRQn` → entry. Missing: disabled, priority 0. */
  nvic: Record<string, NvicEntry>;
}

export const USARTS = ["USART1", "USART2", "USART6"] as const;
export const I2CS = ["I2C1", "I2C2", "I2C3"] as const;
export const SPIS = ["SPI1", "SPI2", "SPI3"] as const;
export const TIMS = ["TIM1", "TIM2", "TIM3", "TIM4", "TIM5", "TIM9", "TIM10", "TIM11"] as const;
export type UsartName = (typeof USARTS)[number];
export type I2cName = (typeof I2CS)[number];
export type SpiName = (typeof SPIS)[number];
export type TimName = (typeof TIMS)[number];

/** Channels per timer (TIM9: 2, TIM10/11: 1). */
export const timChannels = (t: string) => (t === "TIM9" ? 2 : t === "TIM10" || t === "TIM11" ? 1 : 4);
/** 32-bit counters. */
export const tim32 = (t: string) => t === "TIM2" || t === "TIM5";

export const defaultUart = (): UartConfig => ({ baud: 115200, wordLength: 8, parity: "none", stopBits: 1, direction: "tx_rx" });
export const defaultI2c = (): I2cConfig => ({ speed: 100000, duty: "2", ownAddress: 0 });
export const defaultSpi = (): SpiConfig => ({ mode: "master", direction: "2lines", dataSize: 8, prescaler: 16, cpol: 0, cpha: 0, firstBit: "msb" });
export const defaultTim = (t: string): TimConfig => ({ prescaler: 0, period: tim32(t) ? 4294967295 : 65535, counterMode: "up", autoReloadPreload: false, ...(t === "TIM1" ? { repetition: 0 } : {}), channels: Array(timChannels(t)).fill(null) });
export const defaultAdc = (): AdcConfig => ({ resolution: 12, scan: false, continuous: false, ranks: [], eocEachConversion: true });
export const defaultChannel = (): TimChannel => ({ mode: "pwm", pulse: 0, pwmMode: 1, polarity: "high" });

/** An empty STM32F401RETx: only SWD and the clock defaults. */
export function emptyConfig(name = "simucleo"): CubeConfig {
  return {
    mcu: MCU.userName,
    projectName: name,
    drivers: "",
    pins: { PA13: { signal: "SYS_JTMS-SWDIO", label: "TMS" }, PA14: { signal: "SYS_JTCK-SWCLK", label: "TCK" } },
    clock: { ...defaultClock(), hse: "off" },
    sys: { debug: "serial_wire" },
    usart: {},
    i2c: {},
    spi: {},
    tim: {},
    adc: {},
    nvic: {},
  };
}

/** The NUCLEO-F401RE board defaults (as CubeMX's board selector): LD2, B1, USART2 on the VCP, HSE bypass on PH0/PH1, SWD (no SWO, no LSE). */
export function nucleoDefaults(name = "simucleo"): CubeConfig {
  const c = emptyConfig(name);
  c.pins = {
    PC13: { signal: "GPXTI13", label: "B1", edge: "falling", pull: "none" },
    PH0: { signal: "RCC_OSC_IN" },
    PH1: { signal: "RCC_OSC_OUT" },
    PA2: { signal: "USART2_TX", label: "USART_TX" },
    PA3: { signal: "USART2_RX", label: "USART_RX" },
    PA5: { signal: "GPIO_Output", label: "LD2", pull: "none", speed: "low", high: false },
    PA13: { signal: "SYS_JTMS-SWDIO", label: "TMS" },
    PA14: { signal: "SYS_JTCK-SWCLK", label: "TCK" },
  };
  c.usart.USART2 = defaultUart();
  c.clock.hse = "bypass";
  c.nvic.EXTI15_10 = { enabled: true, preempt: 0, sub: 0 };
  return c;
}

export const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

// ------------------------------------------------------------------ editing

/** Peripherals that have pins (USART/I2C/SPI/TIM channel/ADC input). */
function enablePeripheral(c: CubeConfig, p: string) {
  if ((USARTS as readonly string[]).includes(p)) c.usart[p as UsartName] ??= defaultUart();
  else if ((I2CS as readonly string[]).includes(p)) c.i2c[p as I2cName] ??= defaultI2c();
  else if ((SPIS as readonly string[]).includes(p)) c.spi[p as SpiName] ??= defaultSpi();
  else if ((TIMS as readonly string[]).includes(p)) c.tim[p as TimName] ??= defaultTim(p);
  else if (p === "ADC1") c.adc.ADC1 ??= defaultAdc();
}

/**
 * Set a pin's signal as clicking it in CubeMX does: the peripheral it belongs
 * to is enabled with its defaults, a TIM channel gets PWM generation and an
 * ADC input a rank. `null` frees the pin. Returns a new config.
 */
export function assignPin(c0: CubeConfig, pin: string, signal: string | null, label?: string): CubeConfig {
  const c = clone(c0);
  const old = c.pins[pin];
  if (old) releaseSignal(c, pin, old.signal);
  if (!signal) {
    delete c.pins[pin];
    return c;
  }
  const pc: PinConfig = { signal };
  if (label !== undefined ? label : old?.label) pc.label = label !== undefined ? label : old!.label;
  if (signal === "GPIO_Output") Object.assign(pc, { pull: "none", speed: "low", high: false });
  else if (signal === "GPIO_Input") pc.pull = "none";
  else if (/^GPXTI/.test(signal)) Object.assign(pc, { pull: "none", edge: "rising" });
  if (!pc.label) delete pc.label;
  c.pins[pin] = pc;
  const p = peripheralOf(signal);
  if (p) {
    enablePeripheral(c, p);
    const ch = /^TIM\d+_CH([1-4])$/.exec(signal);
    if (ch) {
      const t = c.tim[p as TimName]!;
      const i = Number(ch[1]) - 1;
      if (i < t.channels.length) t.channels[i] ??= defaultChannel();
    }
    const adc = /^ADC1_IN(\d+)$/.exec(signal);
    if (adc) {
      const a = c.adc.ADC1!;
      if (!a.ranks.some((r) => r.channel === Number(adc[1]))) a.ranks.push({ channel: Number(adc[1]), sampling: 3 });
      if (a.ranks.length > 1) a.scan = true;
    }
  }
  return c;
}

/** Undo what a signal set up when its pin is given another one. */
function releaseSignal(c: CubeConfig, pin: string, signal: string) {
  const p = peripheralOf(signal);
  if (!p) return;
  const others = Object.entries(c.pins).filter(([q, v]) => q !== pin && peripheralOf(v.signal) === p);
  const ch = /^TIM\d+_CH([1-4])$/.exec(signal);
  if (ch && c.tim[p as TimName] && !others.some(([, v]) => v.signal === signal)) c.tim[p as TimName]!.channels[Number(ch[1]) - 1] = null;
  const adc = /^ADC1_IN(\d+)$/.exec(signal);
  if (adc && c.adc.ADC1) c.adc.ADC1.ranks = c.adc.ADC1.ranks.filter((r) => r.channel !== Number(adc[1]));
  // The last pin of a peripheral with no pins of its own left: off. Timers stay
  // (a timer without channels is a time base).
  if (!others.length && !/^TIM/.test(p)) disablePeripheral(c, p);
}

export function disablePeripheral(c: CubeConfig, p: string) {
  delete (c.usart as Record<string, unknown>)[p];
  delete (c.i2c as Record<string, unknown>)[p];
  delete (c.spi as Record<string, unknown>)[p];
  delete (c.tim as Record<string, unknown>)[p];
  delete (c.adc as Record<string, unknown>)[p];
  for (const irq of irqsOf(p)) if (!usedIrqs(c).includes(irq)) delete c.nvic[irq];
}

/** Enabled peripherals, in CubeMX's init order. */
export function peripherals(c: CubeConfig): string[] {
  return [
    ...USARTS.filter((u) => c.usart[u]),
    ...I2CS.filter((u) => c.i2c[u]),
    ...SPIS.filter((u) => c.spi[u]),
    ...TIMS.filter((u) => c.tim[u]),
    ...(c.adc.ADC1 ? ["ADC1"] : []),
  ];
}

/** The IRQs this configuration can enable (by its peripherals and EXTI pins). */
export function usedIrqs(c: CubeConfig): string[] {
  const out = new Set<string>();
  for (const [pin, v] of Object.entries(c.pins)) if (/^GPXTI/.test(v.signal)) out.add(extiIrq(portPin(pin).pin));
  for (const p of peripherals(c)) for (const i of irqsOf(p)) out.add(i);
  return [...out];
}

// ------------------------------------------------------------------ labels

/** The C name of a label: `LD2 [Green Led]` → `LD2`, `my led` → `my_led`. */
export function labelMacro(label: string): string {
  const base = label.replace(/\s*\[.*$/, "").trim().replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(base) ? `_${base}` : base;
}

// ------------------------------------------------------------------ checks

export interface Issue {
  severity: "error" | "warning";
  /** What it is about: a pin, a peripheral, "RCC". */
  where: string;
  message: string;
}

/** Signals a peripheral needs in a mode, for "pin missing" checks. */
function requiredSignals(c: CubeConfig, p: string): string[] {
  if (c.usart[p as UsartName]) {
    const d = c.usart[p as UsartName]!.direction;
    return d === "tx" ? [`${p}_TX`] : d === "rx" ? [`${p}_RX`] : [`${p}_TX`, `${p}_RX`];
  }
  if (c.i2c[p as I2cName]) return [`${p}_SCL`, `${p}_SDA`];
  if (c.spi[p as SpiName]) return c.spi[p as SpiName]!.direction === "tx_only" ? [`${p}_SCK`, `${p}_MOSI`] : [`${p}_SCK`, `${p}_MISO`, `${p}_MOSI`];
  return [];
}

const SAMPLING = [3, 15, 28, 56, 84, 112, 144, 480];
const SPI_PRESCALERS = [2, 4, 8, 16, 32, 64, 128, 256];

/** Everything wrong with a configuration (CubeMX's red and yellow marks), in Korean. */
export function validate(c: CubeConfig, tree: ClockTree = computeClock(c.clock)): Issue[] {
  const out: Issue[] = [];
  const err = (where: string, message: string) => out.push({ severity: "error", where, message });
  const warn = (where: string, message: string) => out.push({ severity: "warning", where, message });

  // Pins: real I/O, a signal that pin has, each signal once.
  const bySignal = new Map<string, string[]>();
  const labels = new Map<string, string>();
  for (const [pin, v] of Object.entries(c.pins)) {
    if (!isIoPin(pin)) {
      err(pin, t("{pin}: STM32F401RETx(LQFP64)에 없는 핀입니다.", { pin }));
      continue;
    }
    const s = v.signal;
    const generic = /^GPIO_(Input|Output|Analog)$/.test(s);
    const exti = /^GPXTI(\d+)$/.exec(s);
    const adc = /^ADC1_IN(\d+)$/.exec(s);
    if (exti && Number(exti[1]) !== portPin(pin).pin) err(pin, t("{pin}: EXTI 줄 {line}은(는) {pin}에 없습니다(핀 번호와 같은 줄만 됨).", { pin, line: exti[1] }));
    else if (adc && adcChannel(pin) !== Number(adc[1])) err(pin, t("{pin}: {signal}은(는) 이 핀에 없습니다{why}.", { pin, signal: s, why: adcChannel(pin) === null ? t("(아날로그 입력이 없는 핀)") : t("(이 핀은 ADC1_IN{ch})", { ch: adcChannel(pin) ?? "" }) }));
    else if (!generic && !exti && !adc && afNumber(pin, s) === null && !isFixedSignal(pin, s)) err(pin, t("{pin}: {signal}은(는) 이 핀의 대체 기능(AF)에 없습니다.", { pin, signal: s }));
    else if (!signalSupported(s)) warn(pin, t("{pin}: {signal}의 코드는 아직 만들지 않습니다(설정만 저장).", { pin, signal: s }));
    if (!generic) bySignal.set(s, [...(bySignal.get(s) ?? []), pin]);
    if (v.label) {
      const m = labelMacro(v.label);
      if (!/^[A-Za-z_]\w*$/.test(m)) err(pin, t("{pin}: 라벨 '{label}'은(는) C 이름으로 쓸 수 없습니다.", { pin, label: v.label }));
      else if (labels.has(m)) err(pin, t("{pin}: 라벨 '{label}'을(를) {other}도 씁니다.", { pin, label: m, other: labels.get(m) ?? "" }));
      else labels.set(m, pin);
    }
  }
  for (const [s, pins] of bySignal) if (pins.length > 1) err(pins.join(", "), t("{signal}을(를) 두 핀({pins})에 두었습니다. 신호 하나는 한 핀에만.", { signal: s, pins: pins.join(", ") }));
  // EXTI lines are shared by all ports: PA0 and PB0 cannot both be EXTI0.
  const extiLines = new Map<number, string[]>();
  for (const [pin, v] of Object.entries(c.pins)) if (/^GPXTI/.test(v.signal)) extiLines.set(portPin(pin).pin, [...(extiLines.get(portPin(pin).pin) ?? []), pin]);
  for (const [line, pins] of extiLines) if (pins.length > 1) err(pins.join(", "), t("EXTI 줄 {line}을(를) {pins}가 함께 쓸 수 없습니다(포트마다 줄 하나).", { line, pins: pins.join(", ") }));
  if (c.sys.debug === "serial_wire") {
    for (const [pin, s] of [["PA13", "SYS_JTMS-SWDIO"], ["PA14", "SYS_JTCK-SWCLK"]])
      if (c.pins[pin]?.signal !== s) warn(pin, t("{pin}을(를) 다른 용도로 쓰면 SWD 디버깅(ST-LINK)이 끊깁니다.", { pin }));
  }
  if (c.pins.PA2 && c.pins.PA2.signal !== "USART2_TX") warn("PA2", t("PA2는 ST-LINK 가상 COM(USART2_TX)에 이어져 있습니다. 콘솔이 나오지 않습니다."));
  if (c.pins.PA3 && c.pins.PA3.signal !== "USART2_RX") warn("PA3", t("PA3은 ST-LINK 가상 COM(USART2_RX)에 이어져 있습니다."));

  // Peripherals: their pins, parameters, clocks.
  for (const p of peripherals(c)) {
    for (const s of requiredSignals(c, p)) if (!bySignal.has(s)) err(p, t("{periph}: {signal} 핀이 정해지지 않았습니다.", { periph: p, signal: s }));
  }
  for (const u of USARTS) {
    const v = c.usart[u];
    if (!v) continue;
    if (!(v.baud >= 300 && v.baud <= 10_500_000)) err(u, t("{periph}: 보레이트 {baud}은(는) 쓸 수 없습니다.", { periph: u, baud: v.baud }));
    else {
      const f = busClock(tree, u);
      const div = f / (16 * v.baud);
      if (div < 1) err(u, t("{periph}: {baud} bps는 이 버스 클럭({mhz} MHz)으로 낼 수 없습니다.", { periph: u, baud: v.baud, mhz: (f / 1e6).toFixed(1) }));
      else {
        const real = f / (16 * (Math.round(div * 16) / 16));
        const e = Math.abs(real - v.baud) / v.baud;
        if (e > 0.02) warn(u, t("{periph}: 실제 보레이트 {baud} bps, 오차 {err}%.", { periph: u, baud: Math.round(real), err: (e * 100).toFixed(1) }));
      }
    }
    if (v.wordLength === 8 && v.parity !== "none") warn(u, t("{periph}: 8비트에 패리티를 켜면 데이터는 7비트입니다(CubeMX의 Word Length는 패리티를 포함).", { periph: u }));
  }
  for (const i of I2CS) {
    const v = c.i2c[i];
    if (!v) continue;
    if (!(v.speed > 0 && v.speed <= 400000)) err(i, t("{periph}: 속도 {hz} Hz: 1–400000이어야 합니다.", { periph: i, hz: v.speed }));
    if (tree.pclk1 < (v.speed > 100000 ? 4_000_000 : 2_000_000)) err(i, t("{periph}: APB1({mhz} MHz)이 너무 느립니다(표준 2 MHz, 빠른 4 MHz 이상).", { periph: i, mhz: (tree.pclk1 / 1e6).toFixed(1) }));
    if (v.ownAddress < 0 || v.ownAddress > 0x7f) err(i, t("{periph}: 자기 주소는 0–127이어야 합니다.", { periph: i }));
  }
  for (const s of SPIS) {
    const v = c.spi[s];
    if (!v) continue;
    if (!SPI_PRESCALERS.includes(v.prescaler)) err(s, t("{periph}: 분주 {div}: 2–256의 2의 거듭제곱이어야 합니다.", { periph: s, div: v.prescaler }));
    if (busClock(tree, s) / v.prescaler > 42_000_000) err(s, t("{periph}: SCK {mhz} MHz: 최대 42 MHz입니다.", { periph: s, mhz: (busClock(tree, s) / v.prescaler / 1e6).toFixed(1) }));
  }
  for (const tm of TIMS) {
    const v = c.tim[tm];
    if (!v) continue;
    const max = tim32(tm) ? 4294967295 : 65535;
    if (!(Number.isInteger(v.prescaler) && v.prescaler >= 0 && v.prescaler <= 65535)) err(tm, t("{periph}: 분주(Prescaler) {div}: 0–65535여야 합니다.", { periph: tm, div: v.prescaler }));
    if (!(Number.isInteger(v.period) && v.period >= 0 && v.period <= max)) err(tm, t("{periph}: 주기(Period) {period}: 0–{max}이어야 합니다.", { periph: tm, period: v.period, max }));
    if ((tm === "TIM9" || tm === "TIM10" || tm === "TIM11") && v.counterMode !== "up") err(tm, t("{periph}: 이 타이머는 위로 세기만 됩니다.", { periph: tm }));
    v.channels.forEach((ch, i) => {
      if (!ch) return;
      if (ch.pulse > v.period + 1) warn(tm, t("{periph} CH{ch}: 펄스 {pulse}가 주기 {period}보다 커서 늘 켜져 있습니다.", { periph: tm, ch: i + 1, pulse: ch.pulse, period: v.period }));
      if (!Object.values(c.pins).some((p) => p.signal === `${tm}_CH${i + 1}`)) err(tm, t("{periph} CH{ch}: PWM 출력 핀이 정해지지 않았습니다.", { periph: tm, ch: i + 1 }));
    });
  }
  const adc = c.adc.ADC1;
  if (adc) {
    if (!adc.ranks.length) err("ADC1", t("ADC1: 변환할 채널이 없습니다. ADC1_INx 핀을 정하세요."));
    if (adc.ranks.length > 1 && !adc.scan) err("ADC1", t("ADC1: 채널이 둘 이상이면 스캔 모드를 켜야 합니다."));
    if (adc.ranks.length > 16) err("ADC1", t("ADC1: 일반 변환은 16개까지입니다."));
    for (const r of adc.ranks) {
      if (!SAMPLING.includes(r.sampling)) err("ADC1", t("ADC1 IN{ch}: 샘플링 {cycles} 사이클은 고를 수 없습니다.", { ch: r.channel, cycles: r.sampling }));
      const pin = Object.entries(c.pins).find(([, v]) => v.signal === `ADC1_IN${r.channel}`);
      if (!pin) err("ADC1", t("ADC1: IN{ch}을(를) 변환하는데 그 핀이 ADC1_IN{ch}로 설정되지 않았습니다.", { ch: r.channel }));
    }
    const adcClk = tree.pclk2 / 4;
    if (adcClk > 36_000_000) err("ADC1", t("ADC1: ADC 클럭 {mhz} MHz(PCLK2 ÷ 4): 최대 36 MHz입니다.", { mhz: (adcClk / 1e6).toFixed(1) }));
  }
  for (const [irq, n] of Object.entries(c.nvic)) {
    if (!n.enabled) continue;
    if (!usedIrqs(c).includes(irq)) warn(irq, t("NVIC {irq}_IRQn: 켜져 있지만 이 설정에서 쓰는 주변장치가 없습니다(코드를 만들지 않음).", { irq }));
    if (n.preempt < 0 || n.preempt > 15) err(irq, t("NVIC {irq}_IRQn: 선점 우선순위 {prio}: 0–15여야 합니다.", { irq, prio: n.preempt }));
    if (n.sub !== 0) err(irq, t("NVIC {irq}_IRQn: 우선순위 그룹 4에서는 서브 우선순위가 0뿐입니다.", { irq }));
  }
  for (const i of tree.issues) out.push({ severity: i.severity, where: "RCC", message: i.message });
  if ((c.clock.hse !== "off") !== (c.pins.PH0?.signal === "RCC_OSC_IN")) {
    if (c.clock.hse !== "off") err("PH0", t("HSE를 켰는데 PH0이 RCC_OSC_IN이 아닙니다."));
    else warn("PH0", t("PH0이 RCC_OSC_IN인데 HSE가 꺼져 있습니다."));
  }
  void timerClock;
  return out;
}

export const isFixedSignal = (pin: string, s: string) =>
  (pin === "PH0" && s === "RCC_OSC_IN") || (pin === "PH1" && s === "RCC_OSC_OUT") || (pin === "PC14" && s === "RCC_OSC32_IN") || (pin === "PC15" && s === "RCC_OSC32_OUT");

export const hasErrors = (issues: Issue[]) => issues.some((i) => i.severity === "error");

/** The PWM frequency and duty of a timer channel (for the form). */
export function pwmInfo(c: CubeConfig, t: TimName, ch: number, tree = computeClock(c.clock)): { hz: number; duty: number } | null {
  const v = c.tim[t];
  const chan = v?.channels[ch];
  if (!v || !chan) return null;
  const center = v.counterMode.startsWith("center");
  const hz = timerClock(tree, t) / (v.prescaler + 1) / ((v.period + 1) * (center ? 2 : 1));
  const duty = Math.min(1, chan.pulse / (v.period + 1));
  return { hz, duty: chan.pwmMode === 1 ? duty : 1 - duty };
}

// ------------------------------------------------------------------ whole peripherals

/** Where a peripheral's pins go when it is switched on from its form (the Nucleo's usual ones first). */
export const DEFAULT_PINS: Record<string, [string, string][]> = {
  USART1: [["USART1_TX", "PA9"], ["USART1_RX", "PA10"]],
  USART2: [["USART2_TX", "PA2"], ["USART2_RX", "PA3"]],
  USART6: [["USART6_TX", "PC6"], ["USART6_RX", "PC7"]],
  I2C1: [["I2C1_SCL", "PB8"], ["I2C1_SDA", "PB9"]],
  I2C2: [["I2C2_SCL", "PB10"], ["I2C2_SDA", "PB3"]],
  I2C3: [["I2C3_SCL", "PA8"], ["I2C3_SDA", "PC9"]],
  SPI1: [["SPI1_SCK", "PA5"], ["SPI1_MISO", "PA6"], ["SPI1_MOSI", "PA7"]],
  SPI2: [["SPI2_SCK", "PB13"], ["SPI2_MISO", "PB14"], ["SPI2_MOSI", "PB15"]],
  SPI3: [["SPI3_SCK", "PC10"], ["SPI3_MISO", "PC11"], ["SPI3_MOSI", "PC12"]],
};

/**
 * Switch a peripheral on as its form's checkbox does: USART/I2C/SPI get their
 * pins (the usual one when free, else the first free pin with the signal); a
 * timer starts as a time base; ADC1 needs its input pins chosen afterwards.
 */
export function enablePeripheralWithPins(c0: CubeConfig, p: string): CubeConfig {
  let c = clone(c0);
  enablePeripheral(c, p);
  for (const [signal, usual] of DEFAULT_PINS[p] ?? []) {
    if (Object.values(c.pins).some((v) => v.signal === signal)) continue;
    const free = (pin: string) => !c.pins[pin];
    const pin = free(usual) ? usual : (pinsFor(signal).find(free) ?? usual);
    c = assignPin(c, pin, signal, c.pins[pin]?.label);
  }
  return c;
}

/** Switch a peripheral off and free its pins. */
export function disablePeripheralWithPins(c0: CubeConfig, p: string): CubeConfig {
  const c = clone(c0);
  for (const [pin, v] of Object.entries(c.pins)) if (peripheralOf(v.signal) === p) delete c.pins[pin];
  disablePeripheral(c, p);
  return c;
}
