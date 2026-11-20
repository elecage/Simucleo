// "배선 대조" (M36): the configured pins against the circuit on the canvas.
// The app hands over, for every MCU pin, the parts wired to it (through a
// resistor too: an LED behind its series resistor counts as on the pin);
// this says where they disagree — a part on a pin that is not configured,
// an LED on an input, a button on an output, a potentiometer on a pin that
// is not analog. Pure; unit tested.
import type { CubeConfig } from "./config.ts";
import { adcChannel, isIoPin } from "./mcu.ts";
import { t } from "../i18n/index.ts";

export interface WiredPart {
  /** Part id on the canvas (`led1`). */
  part: string;
  kind: string;
  /** The part's pin on that net (`A`). */
  pin: string;
  /** Display name (`LED`). */
  name: string;
}

/** MCU pin (`PB3`) → the parts on its net. */
export type WiredPins = Record<string, WiredPart[]>;

type Role = "output" | "input" | "analog" | "pwm";

const ROLE: Record<string, Role> = {
  "led-5mm": "output",
  "rgb-led": "output",
  relay: "output",
  "seven-segment": "output",
  servo: "pwm",
  "esc-bldc": "pwm",
  "tact-switch": "input",
  pir: "input",
  "ir-receiver": "input",
  potentiometer: "analog",
  ldr: "analog",
  thermistor: "analog",
  "temp-sensor": "analog",
  joystick: "analog",
};

/** Pins the Nucleo board itself uses (on-board parts, not on the canvas). */
const BOARD_ONLY = new Set(["PA13", "PA14", "PH0", "PH1", "PC14", "PC15"]);

export interface WiringIssue {
  pin: string;
  message: string;
}

const what = (w: WiredPart[]) => w.map((p) => `${p.name}(${p.part}.${p.pin})`).join(", ");

export function wiringCheck(c: CubeConfig, wired: WiredPins): WiringIssue[] {
  const out: WiringIssue[] = [];
  for (const [pin, parts0] of Object.entries(wired).sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))) {
    if (!isIoPin(pin) || BOARD_ONLY.has(pin)) continue;
    const parts = parts0.filter((p) => p.kind !== "resistor" && !p.kind.startsWith("breadboard"));
    if (!parts.length) continue;
    const s = c.pins[pin]?.signal;
    if (!s) {
      out.push({ pin, message: t("{pin}에 {parts}이(가) 이어져 있는데 {pin}은(는) 설정되지 않았습니다(리셋 상태: 아날로그 입력).", { pin, parts: what(parts) }) });
      continue;
    }
    for (const p of parts) {
      const role = ROLE[p.kind];
      if (!role) continue;
      const output = s === "GPIO_Output" || /^TIM\d+_CH\d$/.test(s);
      const input = s === "GPIO_Input" || /^GPXTI\d+$/.test(s);
      const analog = /^ADC1_IN\d+$/.test(s) || s === "GPIO_Analog";
      if (role === "output" && !output) out.push({ pin, message: t("{pin}의 {part}을(를) 켜려면 GPIO_Output(또는 TIM PWM)이어야 하는데 {signal}입니다.", { pin, part: what([p]), signal: s }) });
      else if (role === "pwm" && !/^TIM\d+_CH\d$/.test(s) && s !== "GPIO_Output") out.push({ pin, message: t("{pin}의 {part}에는 PWM 펄스가 필요한데 {signal}입니다(TIMx_CHy로).", { pin, part: what([p]), signal: s }) });
      else if (role === "input" && !input) out.push({ pin, message: t("{pin}의 {part}을(를) 읽으려면 GPIO_Input 또는 GPXTI{n}(인터럽트)여야 하는데 {signal}입니다.", { pin, part: what([p]), n: pin.slice(2), signal: s }) });
      else if (role === "analog" && !/^ADC1_IN\d+$/.test(s))
        out.push({
          pin,
          message:
            adcChannel(pin) === null
              ? t("{pin}의 {part}은(는) 아날로그 값인데 {pin}에는 ADC 입력이 없습니다. A0–A5 같은 ADC 핀으로 옮기세요.", { pin, part: what([p]) })
              : t("{pin}의 {part}을(를) 읽으려면 ADC1_IN{ch}이어야 하는데 {signal}입니다.", { pin, part: what([p]), ch: String(adcChannel(pin)), signal: s }),
        });
      else if (analog && role !== "analog") out.push({ pin, message: t("{pin}은(는) 아날로그인데 {part}이(가) 이어져 있습니다.", { pin, part: what([p]) }) });
    }
  }
  return out;
}
