// STM32CubeMX .ioc files (M36): a Java properties file of `key=value` lines
// (`Mcu.Pin0=PA5`, `PA5.Signal=GPIO_Output`, `RCC.PLLN=336`, `NVIC.USART2_IRQn=
// true\:0\:0\:…`). Read into the configuration model for the subset the
// tool supports, with Korean warnings for what it leaves out (never an
// error for an unknown key), and written back in CubeMX's form, sorted, so
// that CubeMX/CubeIDE opens it. Pure; round trips are unit tested.
import { computeClock, type ClockConfig } from "./clock.ts";
import {
  defaultAdc,
  defaultChannel,
  defaultI2c,
  defaultSpi,
  defaultTim,
  defaultUart,
  emptyConfig,
  I2CS,
  peripherals,
  SPIS,
  TIMS,
  USARTS,
  usedIrqs,
  type CubeConfig,
  type PinConfig,
  type TimName,
} from "./config.ts";
import { adcChannel, iocPinName, MCU, pinFromIoc, PACKAGE_PINS } from "./mcu.ts";
import { DEFAULT_PACK, PACKS } from "./packs.ts";
import { t } from "../i18n/index.ts";

// ------------------------------------------------------------------ properties

function unescape(s: string): string {
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c: string) => (c.length === 5 ? String.fromCharCode(parseInt(c.slice(1), 16)) : c === "n" ? "\n" : c === "t" ? "\t" : c));
}
const escapeKey = (s: string) => s.replace(/([ :=#!\\])/g, "\\$1");
const escapeValue = (s: string) => s.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/^ /, "\\ ").replace(/#/g, "\\#");

/** Parse properties text: keys and values unescaped, later keys win. */
export function parseProperties(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].replace(/^\s+/, "");
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    // A line ending in an odd number of backslashes continues.
    while (/(^|[^\\])(\\\\)*\\$/.test(line) && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i].replace(/^\s+/, "");
    let k = 0;
    while (k < line.length && line[k] !== "=" && line[k] !== ":") k += line[k] === "\\" ? 2 : 1;
    const key = unescape(line.slice(0, k).trimEnd());
    const value = unescape(line.slice(k + 1).replace(/^\s+/, ""));
    out.set(key, value);
  }
  return out;
}

export function writeProperties(m: Map<string, string>, comment = "MicroXplorer Configuration settings - do not modify"): string {
  const keys = [...m.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `#${comment}\n` + keys.map((k) => `${escapeKey(k)}=${escapeValue(m.get(k)!)}`).join("\n") + "\n";
}

// ------------------------------------------------------------------ read

export interface IocResult {
  config: CubeConfig;
  /** What was left out or changed, in Korean. */
  warnings: string[];
}

/** Keys the tool reads or rewrites itself (not reported as unsupported). */
const META = /^(File|KeepUserPlacement|Mcu|MxCube|MxDb|ProjectManager|board|boardIOC|isbadioc|SH|VP_SYS_VS_Systick|NVIC|RCC|PWR|SYS|GPIO|CAD|PinOutPanel)\b/;

const enumTail = (v: string | undefined, prefix: RegExp) => v?.replace(prefix, "");

/** CubeMX's RCC defaults for the F401 (what an .ioc leaves out). */
const RCC_DEFAULTS = { PLLM: 16, PLLN: 192, PLLP: 2, PLLQ: 4 };

export function parseIoc(text: string): IocResult {
  const p = parseProperties(text);
  const warnings: string[] = [];
  const get = (k: string) => p.get(k);
  const num = (k: string, d: number) => {
    const v = get(k);
    if (v === undefined) return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const c = emptyConfig(get("ProjectManager.ProjectName") || "simucleo");
  c.pins = {};
  const user = get("Mcu.UserName") ?? get("ProjectManager.DeviceId");
  if (!user) warnings.push(t(".ioc에 MCU 이름(Mcu.UserName)이 없습니다. STM32F401RETx로 읽습니다."));
  else if (user !== MCU.userName) warnings.push(t("이 .ioc는 {mcu}용입니다. 이 도구는 {ours}(Nucleo-F401RE)만 지원해서 같은 이름의 핀만 옮깁니다.", { mcu: user, ours: MCU.userName }));

  const fw = get("ProjectManager.FirmwarePackage");
  const pack = PACKS.find((x) => fw && x.firmwarePackage === fw);
  c.drivers = pack?.id ?? DEFAULT_PACK.id;
  if (fw && !pack) warnings.push(t("펌웨어 패키지 '{fw}'은(는) 들어 있지 않아 {pack}을(를) 씁니다.", { fw, pack: DEFAULT_PACK.label }));

  // Shared signals (SH.S_TIM2_CH1_ETR.0=TIM2_CH1,PWM Generation1 CH1).
  const shared = new Map<string, string>();
  for (const [k, v] of p) {
    const m = /^SH\.([^.]+)\.0$/.exec(k);
    if (m) shared.set(m[1], v);
  }

  // Pins.
  const pinNames = [...p.entries()].filter(([k]) => /^Mcu\.Pin\d+$/.test(k)).map(([, v]) => v);
  const ipSeen = new Set<string>();
  for (const name of pinNames) {
    if (/^VP_/.test(name)) {
      const sig = get(`${name}.Signal`) ?? "";
      const vt = /^(TIM\d+)_VS_ClockSourceINT$/.exec(sig);
      if (vt && (TIMS as readonly string[]).includes(vt[1])) c.tim[vt[1] as TimName] ??= defaultTim(vt[1]);
      else if (sig !== "SYS_VS_Systick") warnings.push(t("가상 핀 {name}({signal})은(는) 지원하지 않아 건너뜁니다.", { name, signal: sig || "?" }));
      continue;
    }
    const pin = pinFromIoc(name);
    if (!pin) {
      warnings.push(t("핀 '{name}'은(는) STM32F401RETx(LQFP64)에 없어 건너뜁니다.", { name }));
      continue;
    }
    let signal = get(`${name}.Signal`) ?? "";
    const label = get(`${name}.GPIO_Label`);
    if (!signal) continue;
    // S_TIM2_CH1_ETR / S_TIM3_CH1: a timer channel; its mode is in SH.
    const st = /^S_(TIM\d+)_(CH[1-4])(?:_ETR)?$/.exec(signal);
    if (st) {
      signal = `${st[1]}_${st[2]}`;
      const mode = shared.get(get(`${name}.Signal`)!) ?? "";
      const timName = st[1] as TimName;
      if (!(TIMS as readonly string[]).includes(timName)) {
        warnings.push(t("{pin}: {tim}은(는) 지원하지 않는 타이머입니다.", { pin, tim: st[1] }));
        continue;
      }
      if (!/PWM Generation/.test(mode)) {
        warnings.push(t("{pin}: {signal}의 모드 '{mode}'은(는) 아직 지원하지 않습니다(PWM 출력만). 핀만 남기지 않습니다.", { pin, signal, mode: mode.split(",")[1] ?? "?" }));
        continue;
      }
    }
    const adc = /^ADCx?(\d?)_IN(\d+)$/.exec(signal);
    if (adc) {
      if (adc[1] && adc[1] !== "1") {
        warnings.push(t("{pin}: {signal}: ADC1만 있습니다.", { pin, signal }));
        continue;
      }
      signal = `ADC1_IN${adc[2]}`;
    }
    if (/^(SYS_JTMS-SWDIO|SYS_JTCK-SWCLK)$/.test(signal) && get(`${name}.Mode`) && !/Serial_Wire|Trace/.test(get(`${name}.Mode`)!)) {
      warnings.push(t("{pin}: 디버그 모드 '{mode}'은(는) SWD로 읽습니다.", { pin, mode: String(get(`${name}.Mode`)) }));
    }
    const pc: PinConfig = { signal };
    if (label) pc.label = label;
    const pull = get(`${name}.GPIO_PuPd`);
    if (pull === "GPIO_PULLUP") pc.pull = "up";
    else if (pull === "GPIO_PULLDOWN") pc.pull = "down";
    else if (/^GPIO_(Input|Output)$|^GPXTI/.test(signal)) pc.pull = "none";
    const speed = enumTail(get(`${name}.GPIO_Speed`), /^GPIO_SPEED_FREQ_/)?.toLowerCase();
    if (speed && ["low", "medium", "high", "very_high"].includes(speed)) pc.speed = speed as PinConfig["speed"];
    else if (signal === "GPIO_Output") pc.speed = "low";
    if (signal === "GPIO_Output") {
      pc.high = get(`${name}.PinState`) === "GPIO_PIN_SET";
      if (get(`${name}.GPIO_ModeDefaultOutputPP`) === "GPIO_MODE_OUTPUT_OD") pc.openDrain = true;
    }
    if (/^GPXTI/.test(signal)) {
      const e = get(`${name}.GPIO_ModeDefaultEXTI`) ?? "GPIO_MODE_IT_RISING";
      pc.edge = /RISING_FALLING/.test(e) ? "both" : /FALLING/.test(e) ? "falling" : "rising";
      if (/_EVT_/.test(e)) warnings.push(t("{pin}: 이벤트 모드({mode})는 인터럽트로 읽습니다.", { pin, mode: e }));
    }
    // Pins whose peripheral the tool does not have (OTG, RTC, I2S, …).
    const peri = /^([A-Z]+\d*)_/.exec(signal)?.[1];
    const known = /^(GPIO_|GPXTI|ADC1_IN|USART[126]_|I2C[123]_|SPI[123]_|TIM(1|2|3|4|5|9|10|11)_CH|SYS_|RCC_OSC)/.test(signal);
    if (!known) {
      warnings.push(t("{pin}: 신호 {signal}은(는) 지원하지 않아 건너뜁니다.", { pin, signal }));
      if (peri) ipSeen.add(peri);
      continue;
    }
    if (/^(USART|I2C|SPI)\d_/.test(signal) && !/_(TX|RX|SCL|SDA|SCK|MISO|MOSI)$/.test(signal)) {
      warnings.push(t("{pin}: {signal}(흐름 제어·NSS·SMBA 등)은 아직 지원하지 않아 건너뜁니다.", { pin, signal }));
      continue;
    }
    c.pins[pin] = pc;
    if (pin === "PH0" && signal === "RCC_OSC_IN") {
      const mode = get(`${name}.Mode`) ?? "HSE-External-Clock-Source";
      c.clock.hse = /Oscillator/.test(mode) ? "crystal" : "bypass";
    }
  }
  if (!c.pins.PH0) c.clock.hse = "off";

  // Peripherals listed as IPs.
  const ips = [...p.entries()].filter(([k]) => /^Mcu\.IP\d+$/.test(k)).map(([, v]) => v);
  for (const ip of ips) {
    if ((USARTS as readonly string[]).includes(ip)) {
      const mode = get(`${ip}.VirtualMode`) ?? "VM_ASYNC";
      if (mode !== "VM_ASYNC") warnings.push(t("{periph}: {mode} 모드는 지원하지 않아 비동기(UART)로 읽습니다.", { periph: ip, mode }));
      const u = defaultUart();
      u.baud = num(`${ip}.BaudRate`, 115200);
      u.wordLength = /9B/.test(get(`${ip}.WordLength`) ?? "") ? 9 : 8;
      const par = get(`${ip}.Parity`) ?? "";
      u.parity = /EVEN/.test(par) ? "even" : /ODD/.test(par) ? "odd" : "none";
      u.stopBits = /STOPBITS_2/.test(get(`${ip}.StopBits`) ?? "") ? 2 : 1;
      const dir = get(`${ip}.Mode`) ?? "";
      u.direction = /MODE_TX$/.test(dir) ? "tx" : /MODE_RX$/.test(dir) ? "rx" : "tx_rx";
      c.usart[ip as (typeof USARTS)[number]] = u;
    } else if ((I2CS as readonly string[]).includes(ip)) {
      const i = defaultI2c();
      const fast = get(`${ip}.I2C_Mode`) === "I2C_Fast";
      i.speed = num(`${ip}.ClockSpeed`, fast ? 400000 : 100000);
      i.duty = /16_9/.test(get(`${ip}.DutyCycle`) ?? "") ? "16_9" : "2";
      i.ownAddress = num(`${ip}.OwnAddress1`, 0) >> 1;
      c.i2c[ip as (typeof I2CS)[number]] = i;
    } else if ((SPIS as readonly string[]).includes(ip)) {
      const s = defaultSpi();
      const vt = get(`${ip}.VirtualType`) ?? get(`${ip}.Mode`) ?? "VM_MASTER";
      s.mode = /SLAVE/.test(vt) ? "slave" : "master";
      const pinMode = [...p.entries()].find(([k, v]) => k.endsWith(".Signal") && v.startsWith(`${ip}_`))?.[0].replace(/\.Signal$/, "");
      if (pinMode && /Transmit_Only/.test(get(`${pinMode}.Mode`) ?? "")) s.direction = "tx_only";
      s.dataSize = /16BIT/.test(get(`${ip}.DataSize`) ?? "") ? 16 : 8;
      s.prescaler = Number(/_(\d+)$/.exec(get(`${ip}.BaudRatePrescaler`) ?? "")?.[1] ?? 2);
      s.cpol = /HIGH/.test(get(`${ip}.CLKPolarity`) ?? "") ? 1 : 0;
      s.cpha = /2EDGE/.test(get(`${ip}.CLKPhase`) ?? "") ? 1 : 0;
      s.firstBit = /LSB/.test(get(`${ip}.FirstBit`) ?? "") ? "lsb" : "msb";
      c.spi[ip as (typeof SPIS)[number]] = s;
    } else if ((TIMS as readonly string[]).includes(ip)) {
      const t = c.tim[ip as TimName] ?? defaultTim(ip);
      t.prescaler = num(`${ip}.Prescaler`, 0);
      t.period = num(`${ip}.Period`, t.period);
      const cm = get(`${ip}.CounterMode`) ?? "";
      t.counterMode = /CENTERALIGNED1/.test(cm) ? "center1" : /CENTERALIGNED2/.test(cm) ? "center2" : /CENTERALIGNED3/.test(cm) ? "center3" : /DOWN/.test(cm) ? "down" : "up";
      t.autoReloadPreload = /ENABLE/.test(get(`${ip}.AutoReloadPreload`) ?? "");
      if (ip === "TIM1") t.repetition = num(`${ip}.RepetitionCounter`, 0);
      for (let ch = 1; ch <= t.channels.length; ch++) {
        const key = `PWM Generation${ch} CH${ch}`;
        const pinned = Object.values(c.pins).some((v) => v.signal === `${ip}_CH${ch}`);
        if (!pinned) continue;
        const x = defaultChannel();
        x.pulse = num(`${ip}.Pulse-${key}`, 0);
        x.pwmMode = /PWM2/.test(get(`${ip}.OCMode_PWM-${key}`) ?? "") ? 2 : 1;
        x.polarity = /LOW/.test(get(`${ip}.OCPolarity_${ch}`) ?? get(`${ip}.OCPolarity-${key}`) ?? "") ? "low" : "high";
        t.channels[ch - 1] = x;
      }
      c.tim[ip as TimName] = t;
    } else if (ip === "ADC1") {
      const a = defaultAdc();
      a.resolution = Number(/_(\d+)B$/.exec(get("ADC1.Resolution") ?? "")?.[1] ?? 12) as 12;
      a.scan = get("ADC1.ScanConvMode") === "ENABLE";
      a.continuous = get("ADC1.ContinuousConvMode") === "ENABLE";
      a.eocEachConversion = get("ADC1.EOCSelection") !== "ADC_EOC_SEQ_CONV";
      const ranks: { rank: number; channel: number; sampling: number }[] = [];
      for (const [k, v] of p) {
        const m = /^ADC1\.Channel-(\d+)#ChannelRegularConversion$/.exec(k);
        if (!m) continue;
        const ch = /ADC_CHANNEL_(\d+)$/.exec(v);
        if (!ch) {
          warnings.push(t("ADC1: 채널 {ch}(내부 온도·VREFINT 등)은 아직 지원하지 않아 건너뜁니다.", { ch: v }));
          continue;
        }
        ranks.push({
          rank: num(`ADC1.Rank-${m[1]}#ChannelRegularConversion`, Number(m[1]) + 1),
          channel: Number(ch[1]),
          sampling: Number(/_(\d+)CYCLES$/.exec(get(`ADC1.SamplingTime-${m[1]}#ChannelRegularConversion`) ?? "")?.[1] ?? 3),
        });
      }
      ranks.sort((x, y) => x.rank - y.rank);
      a.ranks = ranks.map(({ channel, sampling }) => ({ channel, sampling }));
      // Inputs with a pin but no rank listed: CubeMX ranks them in pin order.
      for (const [, v] of Object.entries(c.pins)) {
        const m = /^ADC1_IN(\d+)$/.exec(v.signal);
        if (m && !a.ranks.some((r) => r.channel === Number(m[1]))) a.ranks.push({ channel: Number(m[1]), sampling: 3 });
      }
      c.adc.ADC1 = a;
    } else if (!/^(NVIC|RCC|SYS|GPIO)$/.test(ip)) {
      ipSeen.add(ip);
    }
  }
  for (const ip of ipSeen) warnings.push(t("{periph}: 이 주변장치는 아직 지원하지 않아 설정을 건너뜁니다.", { periph: ip }));

  // A peripheral with pins but not in the IP list (hand-written .ioc): enable it.
  for (const v of Object.values(c.pins)) {
    const m = /^(USART[126]|I2C[123]|SPI[123]|TIM\d+|ADC1)_/.exec(v.signal);
    if (!m) continue;
    const ip = m[1];
    if ((USARTS as readonly string[]).includes(ip)) c.usart[ip as (typeof USARTS)[number]] ??= defaultUart();
    else if ((I2CS as readonly string[]).includes(ip)) c.i2c[ip as (typeof I2CS)[number]] ??= defaultI2c();
    else if ((SPIS as readonly string[]).includes(ip)) c.spi[ip as (typeof SPIS)[number]] ??= defaultSpi();
    else if ((TIMS as readonly string[]).includes(ip)) {
      const t = (c.tim[ip as TimName] ??= defaultTim(ip));
      const ch = Number(/_CH(\d)$/.exec(v.signal)?.[1] ?? 0);
      if (ch && !t.channels[ch - 1]) t.channels[ch - 1] = defaultChannel();
    } else if (ip === "ADC1" && !c.adc.ADC1) {
      const a = defaultAdc();
      for (const q of Object.values(c.pins)) {
        const n = /^ADC1_IN(\d+)$/.exec(q.signal);
        if (n) a.ranks.push({ channel: Number(n[1]), sampling: 3 });
      }
      a.scan = a.ranks.length > 1;
      c.adc.ADC1 = a;
    }
  }

  // SYS.
  c.sys.debug = c.pins.PA13?.signal === "SYS_JTMS-SWDIO" ? "serial_wire" : "none";

  // RCC.
  const k: ClockConfig = c.clock;
  k.pllM = num("RCC.PLLM", RCC_DEFAULTS.PLLM);
  k.pllN = num("RCC.PLLN", RCC_DEFAULTS.PLLN);
  k.pllP = Number(/DIV(\d)$/.exec(get("RCC.PLLP") ?? "")?.[1] ?? RCC_DEFAULTS.PLLP);
  k.pllQ = num("RCC.PLLQ", RCC_DEFAULTS.PLLQ);
  k.pllSource = /HSE/.test(get("RCC.PLLSourceVirtual") ?? "") ? "HSE" : "HSI";
  const sys = get("RCC.SYSCLKSource") ?? "RCC_SYSCLKSOURCE_HSI";
  k.sysclk = /PLL/.test(sys) ? "PLL" : /HSE/.test(sys) ? "HSE" : "HSI";
  k.pllOn = k.sysclk === "PLL" || get("RCC.PLLState") === "RCC_PLL_ON";
  k.ahbDiv = Number(/DIV(\d+)$/.exec(get("RCC.AHBCLKDivider") ?? "")?.[1] ?? 1);
  k.apb1Div = Number(/DIV(\d+)$/.exec(get("RCC.APB1CLKDivider") ?? "")?.[1] ?? 1);
  k.apb2Div = Number(/DIV(\d+)$/.exec(get("RCC.APB2CLKDivider") ?? "")?.[1] ?? 1);
  k.vos = /SCALE3/.test(get("PWR.PowerRegulatorVoltageScale") ?? "") ? 3 : 2;
  const lat = /FLASH_LATENCY_(\d)/.exec(get("RCC.FLatency-AdvancedSettings") ?? "");
  k.latency = lat ? Number(lat[1]) : null;
  k.usb48 = false;
  const hse = num("RCC.HSE_VALUE", 8000000);
  if (hse !== 8000000) warnings.push(t("HSE {mhz} MHz: Nucleo-F401RE의 HSE는 ST-LINK의 8 MHz라 8 MHz로 읽습니다.", { mhz: hse / 1e6 }));

  // NVIC: enabled:preempt:sub:…
  for (const [key, v] of p) {
    const m = /^NVIC\.(\w+)_IRQn$/.exec(key);
    if (!m) continue;
    const [en, pre, sub] = v.split(":");
    const irq = m[1];
    if (irq === "SysTick") {
      c.nvic.SysTick = { enabled: true, preempt: Number(pre) || 0, sub: Number(sub) || 0 };
      continue;
    }
    if (/^(NonMaskableInt|HardFault|MemoryManagement|BusFault|UsageFault|SVCall|DebugMonitor|PendSV)$/.test(irq)) continue;
    if (!usedIrqs(c).includes(irq)) {
      if (en === "true") warnings.push(t("NVIC {irq}_IRQn: 이 도구가 쓰지 않는 인터럽트라 건너뜁니다.", { irq }));
      continue;
    }
    c.nvic[irq] = { enabled: en === "true", preempt: Number(pre) || 0, sub: Number(sub) || 0 };
  }
  if (get("NVIC.PriorityGroup") && get("NVIC.PriorityGroup") !== "NVIC_PRIORITYGROUP_4") warnings.push(t("NVIC 우선순위 그룹 {group}은(는) 그룹 4로 읽습니다.", { group: String(get("NVIC.PriorityGroup")) }));
  if (c.nvic.SysTick && c.nvic.SysTick.preempt === 15 && c.nvic.SysTick.sub === 0) delete c.nvic.SysTick;

  // Keys of peripherals the tool does not know (DMA, RTC, FREERTOS, …).
  const unknown = new Map<string, number>();
  for (const key of p.keys()) {
    if (META.test(key)) continue;
    const prefix = key.split(".")[0];
    if (/^(USART[126]|I2C[123]|SPI[123]|TIM(1|2|3|4|5|9|10|11)|ADC1)$/.test(prefix)) continue;
    if (pinFromIoc(prefix) || /^VP_/.test(prefix) || /^P[A-H]\d+/.test(prefix)) continue;
    unknown.set(prefix, (unknown.get(prefix) ?? 0) + 1);
  }
  for (const [prefix, n] of unknown) if (![...ipSeen].some((ip) => ip.toUpperCase() === prefix.toUpperCase())) warnings.push(t("{periph}: 지원하지 않는 설정 {n}개를 건너뜁니다.", { periph: prefix, n }));
  return { config: c, warnings };
}

// ------------------------------------------------------------------ write

const hz = (n: number) => String(Math.round(n));

/** The .ioc of a configuration (CubeMX 6 layout, keys sorted). */
export function exportIoc(c: CubeConfig, opts: { cubeMxVersion?: string } = {}): string {
  const m = new Map<string, string>();
  const set = (k: string, v: string | number | boolean) => m.set(k, String(v));
  const pack = PACKS.find((x) => x.id === c.drivers) ?? DEFAULT_PACK;
  const ps = peripherals(c);
  const ips = [...ps, "NVIC", "RCC", "SYS"].sort();
  ips.forEach((ip, i) => set(`Mcu.IP${i}`, ip));
  set("Mcu.IPNb", ips.length);

  // Pins in package order, then virtual pins.
  const pins: string[] = [];
  for (const pp of PACKAGE_PINS) if (c.pins[pp.name]) pins.push(pp.name);
  const virtual: string[] = [];
  for (const t of TIMS) if (c.tim[t]) virtual.push(`VP_${t}_VS_ClockSourceINT`);
  virtual.push("VP_SYS_VS_Systick");
  [...pins.map(iocPinName), ...virtual].forEach((n, i) => set(`Mcu.Pin${i}`, n));
  set("Mcu.PinsNb", pins.length + virtual.length);

  for (const pin of pins) {
    const v = c.pins[pin];
    const n = iocPinName(pin);
    const params: string[] = [];
    let signal = v.signal;
    const tch = /^(TIM\d+)_(CH[1-4])$/.exec(signal);
    if (tch) {
      signal = `S_${signal}${tch[2] === "CH1" && (tch[1] === "TIM2") ? "_ETR" : ""}`;
      const ch = tch[2].slice(2);
      set(`SH.${signal}.0`, `${v.signal},PWM Generation${ch} CH${ch}`);
      set(`SH.${signal}.ConfNb`, 1);
    }
    const adc = /^ADC1_IN(\d+)$/.exec(signal);
    if (adc) {
      signal = `ADCx_IN${adc[1]}`;
      set(`SH.${signal}.0`, `ADC1_IN${adc[1]},IN${adc[1]}`);
      set(`SH.${signal}.ConfNb`, 1);
    }
    const exti = /^GPXTI(\d+)$/.exec(signal);
    if (exti) {
      set(`SH.${signal}.0`, `GPIO_EXTI${exti[1]}`);
      set(`SH.${signal}.ConfNb`, 1);
    }
    set(`${n}.Signal`, signal);
    set(`${n}.Locked`, true);
    if (v.label) {
      set(`${n}.GPIO_Label`, v.label);
      params.push("GPIO_Label");
    }
    if (/^GPIO_(Input|Output)$|^GPXTI/.test(v.signal) && v.pull && v.pull !== "none") {
      set(`${n}.GPIO_PuPd`, v.pull === "up" ? "GPIO_PULLUP" : "GPIO_PULLDOWN");
      params.push("GPIO_PuPd");
    } else if (/^(USART|SPI|I2C|TIM)/.test(v.signal) && v.pull && v.pull !== "none") {
      set(`${n}.GPIO_PuPd`, v.pull === "up" ? "GPIO_PULLUP" : "GPIO_PULLDOWN");
      params.push("GPIO_PuPd");
    }
    if (v.speed && (v.signal === "GPIO_Output" || /^(USART|SPI|I2C|TIM)/.test(v.signal))) {
      set(`${n}.GPIO_Speed`, `GPIO_SPEED_FREQ_${v.speed.toUpperCase()}`);
      params.push("GPIO_Speed");
    }
    if (v.signal === "GPIO_Output") {
      if (v.high) {
        set(`${n}.PinState`, "GPIO_PIN_SET");
        params.push("PinState");
      }
      if (v.openDrain) {
        set(`${n}.GPIO_ModeDefaultOutputPP`, "GPIO_MODE_OUTPUT_OD");
        params.push("GPIO_ModeDefaultOutputPP");
      }
    }
    if (exti) {
      set(`${n}.GPIO_ModeDefaultEXTI`, v.edge === "both" ? "GPIO_MODE_IT_RISING_FALLING" : v.edge === "falling" ? "GPIO_MODE_IT_FALLING" : "GPIO_MODE_IT_RISING");
      params.push("GPIO_ModeDefaultEXTI");
    }
    if (params.length) set(`${n}.GPIOParameters`, params.join(","));
    // Pin modes CubeMX writes for peripherals.
    const mode = /^USART/.test(v.signal)
      ? "Asynchronous"
      : /^I2C/.test(v.signal)
        ? "I2C"
        : /^SPI(\d)/.test(v.signal)
          ? c.spi[v.signal.slice(0, 4) as (typeof SPIS)[number]]?.direction === "tx_only"
            ? `Transmit_Only_${c.spi[v.signal.slice(0, 4) as (typeof SPIS)[number]]?.mode === "slave" ? "Slave" : "Master"}`
            : `Full_Duplex_${c.spi[v.signal.slice(0, 4) as (typeof SPIS)[number]]?.mode === "slave" ? "Slave" : "Master"}`
          : /^SYS_JT/.test(v.signal)
            ? "Serial_Wire"
            : v.signal === "RCC_OSC_IN" || v.signal === "RCC_OSC_OUT"
              ? c.clock.hse === "crystal"
                ? "HSE-External-Oscillator"
                : "HSE-External-Clock-Source"
              : /^RCC_OSC32/.test(v.signal)
                ? "LSE-External-Oscillator"
                : adc
                  ? `IN${adc[1]}`
                  : null;
    if (mode) set(`${n}.Mode`, mode);
  }
  for (const t of TIMS) {
    if (!c.tim[t]) continue;
    set(`VP_${t}_VS_ClockSourceINT.Mode`, "Internal");
    set(`VP_${t}_VS_ClockSourceINT.Signal`, `${t}_VS_ClockSourceINT`);
  }
  set("VP_SYS_VS_Systick.Mode", "SysTick");
  set("VP_SYS_VS_Systick.Signal", "SYS_VS_Systick");

  // Peripheral parameters.
  for (const u of USARTS) {
    const v = c.usart[u];
    if (!v) continue;
    set(`${u}.BaudRate`, v.baud);
    set(`${u}.WordLength`, `WORDLENGTH_${v.wordLength}B`);
    set(`${u}.Parity`, `PARITY_${v.parity.toUpperCase()}`);
    set(`${u}.StopBits`, `STOPBITS_${v.stopBits}`);
    set(`${u}.Mode`, v.direction === "tx" ? "MODE_TX" : v.direction === "rx" ? "MODE_RX" : "MODE_TX_RX");
    set(`${u}.VirtualMode`, "VM_ASYNC");
    set(`${u}.IPParameters`, "VirtualMode,BaudRate,WordLength,Parity,StopBits,Mode");
  }
  for (const i of I2CS) {
    const v = c.i2c[i];
    if (!v) continue;
    set(`${i}.I2C_Mode`, v.speed > 100000 ? "I2C_Fast" : "I2C_Standard");
    set(`${i}.ClockSpeed`, v.speed);
    set(`${i}.DutyCycle`, `I2C_DUTYCYCLE_${v.duty}`);
    set(`${i}.OwnAddress1`, v.ownAddress << 1);
    set(`${i}.IPParameters`, "I2C_Mode,ClockSpeed,DutyCycle,OwnAddress1");
  }
  const tree = computeClock(c.clock);
  for (const s of SPIS) {
    const v = c.spi[s];
    if (!v) continue;
    set(`${s}.Mode`, v.mode === "slave" ? "SPI_MODE_SLAVE" : "SPI_MODE_MASTER");
    set(`${s}.VirtualType`, v.mode === "slave" ? "VM_SLAVE" : "VM_MASTER");
    set(`${s}.Direction`, "SPI_DIRECTION_2LINES");
    set(`${s}.DataSize`, `SPI_DATASIZE_${v.dataSize}BIT`);
    set(`${s}.BaudRatePrescaler`, `SPI_BAUDRATEPRESCALER_${v.prescaler}`);
    set(`${s}.CLKPolarity`, v.cpol ? "SPI_POLARITY_HIGH" : "SPI_POLARITY_LOW");
    set(`${s}.CLKPhase`, v.cpha ? "SPI_PHASE_2EDGE" : "SPI_PHASE_1EDGE");
    set(`${s}.FirstBit`, `SPI_FIRSTBIT_${v.firstBit.toUpperCase()}`);
    const f = (s === "SPI1" ? tree.pclk2 : tree.pclk1) / v.prescaler;
    set(`${s}.CalculateBaudRate`, `${+(f / 1e6).toFixed(3)} MBits/s`);
    set(`${s}.IPParameters`, "VirtualType,Mode,Direction,DataSize,BaudRatePrescaler,CLKPolarity,CLKPhase,FirstBit,CalculateBaudRate");
  }
  for (const t of TIMS) {
    const v = c.tim[t];
    if (!v) continue;
    const params = ["Prescaler", "Period", "CounterMode", "AutoReloadPreload"];
    set(`${t}.Prescaler`, v.prescaler);
    set(`${t}.Period`, v.period);
    set(`${t}.CounterMode`, { up: "TIM_COUNTERMODE_UP", down: "TIM_COUNTERMODE_DOWN", center1: "TIM_COUNTERMODE_CENTERALIGNED1", center2: "TIM_COUNTERMODE_CENTERALIGNED2", center3: "TIM_COUNTERMODE_CENTERALIGNED3" }[v.counterMode]);
    set(`${t}.AutoReloadPreload`, v.autoReloadPreload ? "TIM_AUTORELOAD_PRELOAD_ENABLE" : "TIM_AUTORELOAD_PRELOAD_DISABLE");
    if (t === "TIM1") {
      set(`${t}.RepetitionCounter`, v.repetition ?? 0);
      params.push("RepetitionCounter");
    }
    v.channels.forEach((ch, i) => {
      if (!ch) return;
      const key = `PWM Generation${i + 1} CH${i + 1}`;
      set(`${t}.Channel-${key}`, `TIM_CHANNEL_${i + 1}`);
      set(`${t}.Pulse-${key}`, ch.pulse);
      set(`${t}.OCMode_PWM-${key}`, `TIM_OCMODE_PWM${ch.pwmMode}`);
      set(`${t}.OCPolarity_${i + 1}`, `TIM_OCPOLARITY_${ch.polarity.toUpperCase()}`);
      params.push(`Channel-${key}`, `Pulse-${key}`, `OCMode_PWM-${key}`, `OCPolarity_${i + 1}`);
    });
    set(`${t}.IPParameters`, params.join(","));
  }
  const a = c.adc.ADC1;
  if (a) {
    const params = ["Resolution", "ScanConvMode", "ContinuousConvMode", "EOCSelection", "NbrOfConversion", "NbrOfConversionFlag", "master"];
    set("ADC1.Resolution", `ADC_RESOLUTION_${a.resolution}B`);
    set("ADC1.ScanConvMode", a.scan ? "ENABLE" : "DISABLE");
    set("ADC1.ContinuousConvMode", a.continuous ? "ENABLE" : "DISABLE");
    set("ADC1.EOCSelection", a.eocEachConversion ? "ADC_EOC_SINGLE_CONV" : "ADC_EOC_SEQ_CONV");
    set("ADC1.NbrOfConversion", Math.max(1, a.ranks.length));
    set("ADC1.NbrOfConversionFlag", 1);
    set("ADC1.master", 1);
    a.ranks.forEach((r, i) => {
      set(`ADC1.Channel-${i}#ChannelRegularConversion`, `ADC_CHANNEL_${r.channel}`);
      set(`ADC1.Rank-${i}#ChannelRegularConversion`, i + 1);
      set(`ADC1.SamplingTime-${i}#ChannelRegularConversion`, `ADC_SAMPLETIME_${r.sampling}CYCLES`);
      params.push(`Rank-${i}#ChannelRegularConversion`, `Channel-${i}#ChannelRegularConversion`, `SamplingTime-${i}#ChannelRegularConversion`);
    });
    set("ADC1.IPParameters", params.join(","));
  }

  // NVIC (system handlers as CubeMX lists them).
  set("NVIC.PriorityGroup", "NVIC_PRIORITYGROUP_4");
  set("NVIC.ForceEnableDMAVector", true);
  for (const s of ["NonMaskableInt", "HardFault", "MemoryManagement", "BusFault", "UsageFault"]) set(`NVIC.${s}_IRQn`, "true:0:0:false:false:true:false:false:false");
  for (const s of ["SVCall", "DebugMonitor", "PendSV"]) set(`NVIC.${s}_IRQn`, "true:0:0:false:false:true:false:false:false");
  set("NVIC.SysTick_IRQn", `true:${c.nvic.SysTick?.preempt ?? 15}:${c.nvic.SysTick?.sub ?? 0}:false:false:true:false:true:false`);
  for (const irq of usedIrqs(c)) {
    const n = c.nvic[irq];
    if (!n) continue;
    set(`NVIC.${irq}_IRQn`, `${n.enabled}:${n.preempt}:${n.sub}:false:false:true:true:true:true`);
  }

  // RCC (with the frequencies CubeMX shows).
  const k = c.clock;
  set("RCC.PLLM", k.pllM);
  set("RCC.PLLN", k.pllN);
  set("RCC.PLLP", `RCC_PLLP_DIV${k.pllP}`);
  set("RCC.PLLQ", k.pllQ);
  set("RCC.PLLSourceVirtual", `RCC_PLLSOURCE_${k.pllSource}`);
  set("RCC.SYSCLKSource", k.sysclk === "PLL" ? "RCC_SYSCLKSOURCE_PLLCLK" : `RCC_SYSCLKSOURCE_${k.sysclk}`);
  if (k.pllOn && k.sysclk !== "PLL") set("RCC.PLLState", "RCC_PLL_ON");
  set("RCC.AHBCLKDivider", `RCC_SYSCLK_DIV${k.ahbDiv}`);
  set("RCC.APB1CLKDivider", `RCC_HCLK_DIV${k.apb1Div}`);
  set("RCC.APB2CLKDivider", `RCC_HCLK_DIV${k.apb2Div}`);
  if (k.latency !== null) set("RCC.FLatency-AdvancedSettings", `FLASH_LATENCY_${k.latency}`);
  set("RCC.HSE_VALUE", 8000000);
  set("RCC.HSI_VALUE", 16000000);
  set("RCC.LSE_VALUE", 32768);
  set("RCC.LSI_VALUE", 32000);
  set("RCC.SYSCLKFreq_VALUE", hz(tree.sysclk));
  set("RCC.HCLKFreq_Value", hz(tree.hclk));
  set("RCC.AHBFreq_Value", hz(tree.hclk));
  set("RCC.CortexFreq_Value", hz(tree.hclk));
  set("RCC.FCLKCortexFreq_Value", hz(tree.hclk));
  set("RCC.APB1Freq_Value", hz(tree.pclk1));
  set("RCC.APB2Freq_Value", hz(tree.pclk2));
  set("RCC.APB1TimFreq_Value", hz(tree.tim1));
  set("RCC.APB2TimFreq_Value", hz(tree.tim2));
  set("RCC.PLLCLKFreq_Value", hz(tree.pllP));
  set("RCC.PLLQCLKFreq_Value", hz(tree.pllQ));
  set("RCC.VCOInputFreq_Value", hz(tree.vcoIn));
  set("RCC.VCOOutputFreq_Value", hz(tree.vcoOut));
  set("RCC.FamilyName", "M");
  const rccParams = [...m.keys()].filter((x) => x.startsWith("RCC.") && x !== "RCC.IPParameters").map((x) => x.slice(4)).sort();
  set("RCC.IPParameters", rccParams.join(","));
  if (k.vos === 3) {
    set("PWR.PowerRegulatorVoltageScale", "PWR_REGULATOR_VOLTAGE_SCALE3");
    set("PWR.IPParameters", "PowerRegulatorVoltageScale");
  }

  // MCU and project.
  set("File.Version", 6);
  set("KeepUserPlacement", false);
  set("Mcu.CPN", MCU.cpn);
  set("Mcu.Family", MCU.family);
  set("Mcu.Name", MCU.name);
  set("Mcu.Package", MCU.package);
  set("Mcu.ThirdPartyNb", 0);
  set("Mcu.UserConstants", "");
  set("Mcu.UserName", MCU.userName);
  set("MxCube.Version", opts.cubeMxVersion ?? "6.12.0");
  set("MxDb.Version", "DB.6.0.120");
  set("ProjectManager.AskForMigrate", true);
  set("ProjectManager.BackupPrevious", false);
  set("ProjectManager.CompilerOptimize", 6);
  set("ProjectManager.ComputerToolchain", false);
  set("ProjectManager.CoupleFile", false);
  set("ProjectManager.CustomerFirmwarePackage", "");
  set("ProjectManager.DefaultFWLocation", true);
  set("ProjectManager.DeletePrevious", true);
  set("ProjectManager.DeviceId", MCU.userName);
  set("ProjectManager.FirmwarePackage", pack.firmwarePackage);
  set("ProjectManager.FreePins", false);
  set("ProjectManager.HalAssertFull", false);
  set("ProjectManager.HeapSize", "0x200");
  set("ProjectManager.KeepUserCode", true);
  set("ProjectManager.LastFirmware", true);
  set("ProjectManager.LibraryCopy", 1);
  set("ProjectManager.MainLocation", "Core/Src");
  set("ProjectManager.NoMain", false);
  set("ProjectManager.PreviousToolchain", "");
  set("ProjectManager.ProjectBuild", false);
  set("ProjectManager.ProjectFileName", `${c.projectName}.ioc`);
  set("ProjectManager.ProjectName", c.projectName);
  set("ProjectManager.ProjectStructure", "");
  set("ProjectManager.RegisterCallBack", "");
  set("ProjectManager.StackSize", "0x400");
  set("ProjectManager.TargetToolchain", "STM32CubeIDE");
  set("ProjectManager.ToolChainLocation", "");
  set("ProjectManager.UAScriptAfterPath", "");
  set("ProjectManager.UAScriptBeforePath", "");
  set("ProjectManager.UnderRoot", true);
  const fl = [`1-SystemClock_Config-RCC-false-HAL-false`, `2-MX_GPIO_Init-GPIO-false-HAL-true`, ...ps.map((p, i) => `${i + 3}-${/^USART/.test(p) ? `MX_${p}_UART_Init` : `MX_${p}_Init`}-${p}-false-HAL-true`)];
  set("ProjectManager.functionlistsort", fl.join(","));
  set("board", MCU.board);
  set("boardIOC", true);
  set("isbadioc", false);
  return writeProperties(m);
}

/** Pins of the config whose ADC channel is wrong for the pin (for tests). */
export const adcOk = (pin: string, ch: number) => adcChannel(pin) === ch;
