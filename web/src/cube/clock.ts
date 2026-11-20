// The clock tree of the STM32F401 (RM0368 §6, DS10086 §6.3) for the
// configuration tool (M36): sources, PLL, bus prescalers, the frequencies
// they give and the limits CubeMX checks. Pure; unit tested.

export const HSI_HZ = 16_000_000;
/** The Nucleo's HSE: the ST-LINK's 8 MHz MCO on PH0 (no crystal fitted at X3). */
export const HSE_HZ = 8_000_000;

export type HseMode = "off" | "bypass" | "crystal";
export type SysclkSource = "HSI" | "HSE" | "PLL";
export type PllSource = "HSI" | "HSE";

export interface ClockConfig {
  hse: HseMode;
  pllOn: boolean;
  pllSource: PllSource;
  pllM: number;
  pllN: number;
  /** 2, 4, 6 or 8. */
  pllP: number;
  pllQ: number;
  sysclk: SysclkSource;
  /** 1, 2, 4, … 512. */
  ahbDiv: number;
  /** 1, 2, 4, 8, 16. */
  apb1Div: number;
  apb2Div: number;
  /** Voltage scale (PWR_REGULATOR_VOLTAGE_SCALE2/3). */
  vos: 2 | 3;
  /** Flash wait states; null: the least the HCLK needs. */
  latency: number | null;
  /** Check that PLLQ gives the 48 MHz USB OTG FS needs. */
  usb48: boolean;
}

export const AHB_DIVS = [1, 2, 4, 8, 16, 64, 128, 256, 512];
export const APB_DIVS = [1, 2, 4, 8, 16];
export const PLLP_VALUES = [2, 4, 6, 8];

/** CubeMX's Nucleo-F401RE default: HSI 16 MHz → PLL → 84 MHz, APB1 42 MHz. */
export function defaultClock(): ClockConfig {
  return { hse: "bypass", pllOn: true, pllSource: "HSI", pllM: 16, pllN: 336, pllP: 4, pllQ: 7, sysclk: "PLL", ahbDiv: 1, apb1Div: 2, apb2Div: 1, vos: 2, latency: null, usb48: false };
}

export interface ClockIssue {
  /** Which box of the tree it is about (for highlighting). */
  node: "hse" | "vcoIn" | "vcoOut" | "pllP" | "pllQ" | "pllN" | "pllM" | "sysclk" | "hclk" | "apb1" | "apb2" | "latency" | "usb";
  severity: "error" | "warning";
  message: string;
}

export interface ClockTree {
  hsi: number;
  hse: number;
  pllIn: number;
  vcoIn: number;
  vcoOut: number;
  pllP: number;
  pllQ: number;
  sysclk: number;
  hclk: number;
  pclk1: number;
  pclk2: number;
  /** Timer clocks: PCLK × 2 when the APB prescaler is not 1. */
  tim1: number;
  tim2: number;
  /** The Cortex system timer (HCLK; HAL's SysTick runs from it). */
  cortex: number;
  /** Flash wait states used (given or computed). */
  latency: number;
  /** The least wait states this HCLK needs at 2.7–3.6 V. */
  minLatency: number;
  issues: ClockIssue[];
}

export const MAX_SYSCLK = 84_000_000;
export const MAX_APB1 = 42_000_000;
export const MAX_APB2 = 84_000_000;
/** VCO input 0.95–2.1 MHz (2 MHz recommended), output 192–432 MHz. */
export const VCO_IN: [number, number] = [950_000, 2_100_000];
export const VCO_OUT: [number, number] = [192_000_000, 432_000_000];

/** Wait states for HCLK at VDD 2.7–3.6 V (RM0368 table 5): 30 MHz per step. */
export const latencyFor = (hclk: number) => Math.max(0, Math.ceil(hclk / 30_000_000) - 1);

const mhz = (hz: number) => `${+(hz / 1e6).toFixed(3)} MHz`;

export function computeClock(c: ClockConfig): ClockTree {
  const issues: ClockIssue[] = [];
  const hse = c.hse === "off" ? 0 : HSE_HZ;
  const pllIn = c.pllSource === "HSE" ? hse : HSI_HZ;
  const vcoIn = c.pllM > 0 ? pllIn / c.pllM : 0;
  const vcoOut = vcoIn * c.pllN;
  const pllP = c.pllP > 0 ? vcoOut / c.pllP : 0;
  const pllQ = c.pllQ > 0 ? vcoOut / c.pllQ : 0;
  const sysclk = c.sysclk === "HSI" ? HSI_HZ : c.sysclk === "HSE" ? hse : c.pllOn ? pllP : 0;
  const hclk = sysclk / c.ahbDiv;
  const pclk1 = hclk / c.apb1Div;
  const pclk2 = hclk / c.apb2Div;
  const minLatency = latencyFor(hclk);
  const latency = c.latency ?? minLatency;

  const pllUsed = c.pllOn;
  if ((c.sysclk === "HSE" || (pllUsed && c.pllSource === "HSE")) && c.hse === "off")
    issues.push({ node: "hse", severity: "error", message: "HSE를 쓰는데 HSE가 꺼져 있습니다. RCC에서 HSE를 바이패스(BYPASS Clock Source)로 켜세요." });
  if (c.hse === "crystal")
    issues.push({ node: "hse", severity: "warning", message: "Nucleo-F401RE에는 HSE 크리스털(X3)이 없습니다. 크리스털로 설정하면 HSE가 준비되지 않아 Error_Handler()로 갑니다. ST-LINK의 8 MHz를 쓰려면 바이패스로 하세요." });
  if (c.sysclk === "PLL" && !c.pllOn) issues.push({ node: "sysclk", severity: "error", message: "SYSCLK을 PLL에서 받는데 PLL이 꺼져 있습니다." });
  if (pllUsed) {
    if (c.pllM < 2 || c.pllM > 63) issues.push({ node: "pllM", severity: "error", message: `PLLM ${c.pllM}: 2–63이어야 합니다.` });
    if (c.pllN < 50 || c.pllN > 432) issues.push({ node: "pllN", severity: "error", message: `PLLN ${c.pllN}: 50–432이어야 합니다.` });
    if (!PLLP_VALUES.includes(c.pllP)) issues.push({ node: "pllP", severity: "error", message: `PLLP ${c.pllP}: 2, 4, 6, 8 중 하나여야 합니다.` });
    if (c.pllQ < 2 || c.pllQ > 15) issues.push({ node: "pllQ", severity: "error", message: `PLLQ ${c.pllQ}: 2–15여야 합니다.` });
    if (vcoIn < VCO_IN[0] || vcoIn > VCO_IN[1])
      issues.push({ node: "vcoIn", severity: "error", message: `PLL 입력(VCO 입력) ${mhz(vcoIn)}: 0.95–2.1 MHz여야 합니다(2 MHz 권장). PLLM을 바꾸세요.` });
    if (vcoOut < VCO_OUT[0] || vcoOut > VCO_OUT[1])
      issues.push({ node: "vcoOut", severity: "error", message: `VCO 출력 ${mhz(vcoOut)}: 192–432 MHz여야 합니다. PLLN을 바꾸세요.` });
    if (c.usb48 && Math.abs(pllQ - 48_000_000) > 1)
      issues.push({ node: "usb", severity: "error", message: `USB용 48 MHz(PLLQ 출력)가 ${mhz(pllQ)}입니다. PLLQ를 바꾸세요(예: VCO 336 MHz ÷ 7).` });
    else if (pllQ > 48_000_000 + 1)
      issues.push({ node: "pllQ", severity: "warning", message: `PLLQ 출력 ${mhz(pllQ)}이 48 MHz를 넘습니다(USB·SDIO가 쓰면 안 됨).` });
  }
  if (sysclk > MAX_SYSCLK) issues.push({ node: "sysclk", severity: "error", message: `SYSCLK ${mhz(sysclk)}: STM32F401은 최대 84 MHz입니다.` });
  if (hclk > MAX_SYSCLK) issues.push({ node: "hclk", severity: "error", message: `HCLK ${mhz(hclk)}: 최대 84 MHz입니다.` });
  if (c.vos === 3 && hclk > 60_000_000) issues.push({ node: "hclk", severity: "error", message: `전압 스케일 3에서는 HCLK가 60 MHz까지입니다(지금 ${mhz(hclk)}). 스케일 2로 하세요.` });
  if (pclk1 > MAX_APB1) issues.push({ node: "apb1", severity: "error", message: `APB1 ${mhz(pclk1)}: 최대 42 MHz입니다. APB1 분주를 키우세요.` });
  if (pclk2 > MAX_APB2) issues.push({ node: "apb2", severity: "error", message: `APB2 ${mhz(pclk2)}: 최대 84 MHz입니다.` });
  if (latency < minLatency)
    issues.push({ node: "latency", severity: "error", message: `플래시 대기 ${latency}: HCLK ${mhz(hclk)}에는 ${minLatency} 이상이 필요합니다.` });
  if (latency > 7) issues.push({ node: "latency", severity: "error", message: `플래시 대기 ${latency}: 0–7이어야 합니다.` });

  return {
    hsi: HSI_HZ,
    hse,
    pllIn,
    vcoIn,
    vcoOut,
    pllP,
    pllQ,
    sysclk,
    hclk,
    pclk1,
    pclk2,
    tim1: c.apb1Div === 1 ? pclk1 : pclk1 * 2,
    tim2: c.apb2Div === 1 ? pclk2 : pclk2 * 2,
    cortex: hclk,
    latency,
    minLatency,
    issues,
  };
}

/** The timer clock of a TIM (TIM2–5 on APB1, TIM1 and TIM9–11 on APB2). */
export const timerClock = (t: ClockTree, tim: string) => (/^TIM(2|3|4|5)$/.test(tim) ? t.tim1 : t.tim2);
/** The bus clock of a peripheral (USART2, I2C, SPI2/3, TIM2–5 on APB1). */
export const busClock = (t: ClockTree, p: string) => (/^(USART2|I2C\d|SPI[23]|TIM[2-5])$/.test(p) ? t.pclk1 : t.pclk2);
