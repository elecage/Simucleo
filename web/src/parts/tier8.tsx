// Tier 8 parts (M19): 74HC595 shift register, TM1637 4-digit display,
// KY-023 joystick, HC-SR501 PIR motion sensor and BMP280 barometer. Their
// models live in `simucleo_circuit::tier8` (and the joystick's pots in the
// nodal solve, like the potentiometer).
import { fingerTouch, joystickStick, personDrag, waveControl } from "./controls";
import { Fingertip } from "./feedback";
import { Digit } from "./more";
import { PITCH, type PartDef } from "./types";
import { t } from "../i18n";

const P = PITCH;

const NoPower = ({ x, y }: { x: number; y: number }) => (
  <text x={x} y={y} textAnchor="middle" className="silk small unpowered" data-unpowered="1">
    {t("전원 부족")}
  </text>
);

const hex2 = (v: number) => v.toString(16).padStart(2, "0");

// ------------------------------------------------------------ 74HC595

/** DIP-16 pins: top row left to right (pins 16…9), bottom row (pins 1…8). */
const SR_TOP = ["VCC", "Q0", "DS", "OE", "STCP", "SHCP", "MR", "Q7S"];
const SR_BOTTOM = ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "GND"];
const SR_LABEL: Record<string, string> = {
  VCC: "VCC (16, 2–6 V)",
  DS: t("DS / SER (14, 직렬 데이터 입력)"),
  OE: t("OE (13, Low면 출력 켜짐)"),
  STCP: t("STCP / RCLK (12, 상승 에지에 출력 래치)"),
  SHCP: t("SHCP / SRCLK (11, 상승 에지에 한 칸 시프트)"),
  MR: t("MR (10, Low면 시프트 레지스터 지움)"),
  Q7S: t("Q7' (9, 직렬 출력 → 다음 595의 DS)"),
  GND: "GND (8)",
};
const SR_SHORT: Record<string, string> = { Q7S: "Q7'", SHCP: "SH", STCP: "ST" };

export const hc595: PartDef = {
  kind: "hc595",
  name: t("시프트 레지스터 (74HC595)"),
  category: "module",
  description:
    t("8비트 직렬 입력·병렬 출력 시프트 레지스터(DIP-16). SHCP(SRCLK)가 올라갈 때마다 DS의 비트가 Q0으로 들어오고 나머지는 한 칸씩 밀려 7번째 단은 Q7'으로 나옵니다. STCP(RCLK)가 올라가는 순간 시프트 레지스터가 출력 Q0–Q7에 한꺼번에 옮겨집니다 — 그 전까지 출력은 그대로입니다. OE를 High로 하면 Q0–Q7이 끊깁니다(하이 임피던스): 보통 GND에 연결. MR을 Low로 하면 시프트 레지스터가 지워집니다: 보통 VCC에 연결. Q7'을 다음 595의 DS에, SHCP·STCP를 같이 연결하면 16, 24…개의 출력으로 늘어납니다. GPIO 비트뱅잉도, 하드웨어 SPI(D13 SCK → SHCP, D11 MOSI → DS, GPIO → STCP, MSB 먼저 보내면 비트 n이 Qn)도 됩니다. 출력에는 LED마다 저항(330 Ω 등)을 다세요. 출력 High는 3.3 V로 계산합니다."),
  w: 8,
  h: 3,
  pins: [
    ...SR_TOP.map((id, i) => ({ id, x: i, y: 0, label: SR_LABEL[id] ?? id })),
    ...SR_BOTTOM.map((id, i) => ({ id, x: i, y: 3, label: SR_LABEL[id] ?? t("{id} (병렬 출력)", { id }) })),
  ],
  render: (_props, visual) => {
    const reg = visual.register;
    const latch = reg?.latch ?? 0;
    const enabled = reg?.enabled ?? false;
    return (
      <g data-latch={hex2(latch)} data-shift={hex2(reg?.shift ?? 0)} data-enabled={enabled ? "1" : "0"}>
        <rect x={-0.45 * P} y={0.45 * P} width={7.9 * P} height={2.1 * P} rx={1} className="dip-body" />
        <path d={`M ${-0.45 * P} ${1.15 * P} a ${0.35 * P} ${0.35 * P} 0 0 1 0 ${0.7 * P}`} className="dip-notch" />
        {SR_TOP.map((n, i) => (
          <text key={n} x={i * P} y={1.05 * P} textAnchor="middle" className="silk chip-label">
            {SR_SHORT[n] ?? n}
          </text>
        ))}
        {SR_BOTTOM.map((n, i) => (
          <text key={n} x={i * P} y={2.35 * P} textAnchor="middle" className="silk chip-label">
            {n}
          </text>
        ))}
        <text x={3.5 * P} y={1.75 * P} textAnchor="middle" className="silk chip-label">
          74HC595
        </text>
        {/* The storage register on Q0–Q7, as the outputs show it. */}
        {Array.from({ length: 8 }, (_, i) => {
          const on = (latch >> i) & 1;
          return (
            <g key={i}>
              <rect
                x={(i - 0.3) * P}
                y={-1.6 * P}
                width={0.6 * P}
                height={0.6 * P}
                className={on && enabled ? "sr-bit on" : on ? "sr-bit off-z" : "sr-bit"}
                data-q={i}
              />
              <text x={i * P} y={-1.8 * P} textAnchor="middle" className="silk tiny">
                Q{i}
              </text>
            </g>
          );
        })}
        {reg && !enabled && (
          <text x={3.5 * P} y={-2.6 * P} textAnchor="middle" className="silk small unpowered">
            {t("출력 꺼짐 (OE High)")}
          </text>
        )}
        {visual.unpowered && <NoPower x={3.5 * P} y={4.4 * P} />}
      </g>
    );
  },
};

// ------------------------------------------------------------- TM1637

const TM_PINS = ["CLK", "DIO", "VCC", "GND"];

export const tm1637: PartDef = {
  kind: "tm1637",
  name: t("4자리 7세그먼트 (TM1637)"),
  category: "display",
  description:
    t("TM1637 구동 칩이 붙은 4자리 7세그먼트 모듈(가운데 콜론). 핀 두 개(CLK, DIO)로 쓰지만 I2C가 아닙니다: 시작은 CLK가 High일 때 DIO를 내리고, 끝은 CLK가 High일 때 DIO를 올립니다. 바이트는 LSB부터, CLK 상승 에지마다 한 비트씩 읽히고, 8번째 비트 뒤 칩이 한 클럭 동안 DIO를 Low로 당겨 응답(ACK)합니다 — DIO는 오픈 드레인으로 놓아 두어야 읽을 수 있습니다(모듈에 10 kΩ 풀업). 명령: 0x40 데이터(주소 자동 증가) / 0x44 고정 주소, 0xC0–0xC3 자리 주소 뒤에 세그먼트 바이트(비트 0 = a … 비트 6 = g, 둘째 자리의 비트 7 = 콜론), 0x88 | 밝기(0–7) 표시 켜기, 0x80 끄기. CLK는 250 kHz 이하(반주기 2 µs 이상). VCC는 3.3–5 V."),
  w: 19,
  h: 8,
  pins: TM_PINS.map((id, i) => ({ id, x: 0, y: 2 + i, label: id === "DIO" ? t("DIO (데이터, 양방향)") : id })),
  render: (_props, visual) => {
    const d = visual.digits;
    const segs = d?.segments ?? [0, 0, 0, 0];
    const on = !!d?.on;
    // Pulse width 1/16 … 14/16 of the time: dimmer at low settings.
    const level = on ? [1, 2, 4, 10, 11, 12, 13, 14][d?.brightness ?? 7] / 14 : 0;
    const shown = segs.map((s) => (on ? s : 0));
    return (
      <g data-digits={shown.map(hex2).join(",")} data-brightness={on ? (d?.brightness ?? 0) : -1}>
        <rect x={0} y={0.3 * P} width={19 * P} height={7.4 * P} rx={1} className="module-pcb" />
        {TM_PINS.map((n, i) => (
          <text key={n} x={0.6 * P} y={(2.15 + i) * P} className="silk module-label">
            {n}
          </text>
        ))}
        <rect x={3 * P} y={0.9 * P} width={15.4 * P} height={6.2 * P} rx={0.6} className="seg-face" />
        {shown.map((s, i) => (
          <Digit
            key={i}
            x={(3.9 + i * 3.6 + (i >= 2 ? 0.6 : 0)) * P}
            y={1.5 * P}
            color="#ff3b30"
            levels={Array.from({ length: 8 }, (_, b) => (i === 1 && b === 7 ? 0 : ((s >> b) & 1) * level))}
          />
        ))}
        {/* Colon: bit 7 of digit 1. */}
        {[3.2, 5.2].map((y) => (
          <circle
            key={y}
            cx={11.1 * P}
            cy={y * P}
            r={0.3 * P}
            fill="#ff3b30"
            opacity={(shown[1] & 0x80) !== 0 ? 0.35 + 0.65 * level : 0.07}
            data-colon={(shown[1] & 0x80) !== 0 ? "1" : "0"}
          />
        ))}
        <text x={10.7 * P} y={-0.4 * P} textAnchor="middle" className="silk small value">
          {on ? t("밝기 {level}/7", { level: d?.brightness ?? 0 }) : t("표시 꺼짐")}
        </text>
        {visual.unpowered && <NoPower x={10.7 * P} y={9 * P} />}
      </g>
    );
  },
};

// ------------------------------------------------------------ joystick

/** Centre of the stick's square and how far it travels (part units). */
const JS_CX = 4 * P,
  JS_CY = 4 * P,
  JS_RANGE = 2.2 * P;
const JS_PINS = ["GND", "+5V", "VRx", "VRy", "SW"];

export const joystick: PartDef = {
  kind: "joystick",
  name: t("조이스틱 (KY-023)"),
  category: "input",
  description:
    t("2축 아날로그 조이스틱 모듈. 10 kΩ 가변저항 두 개가 GND와 +5V 사이에 있고 와이퍼가 VRx, VRy입니다: 왼쪽으로 기울이면 VRx가 0 V 쪽, 위로 기울이면 VRy가 전원 쪽으로 갑니다(가운데 절반). 스틱을 누르면 SW가 GND에 붙습니다 — 모듈에 풀업이 없으니 GPIO 내부 풀업을 켜세요. +5V는 3V3에 연결하세요: 5 V면 와이퍼가 3.3 V를 넘어 ADC 핀(5 V 내성 아님)을 넘깁니다. 손잡이를 끌어 기울이면 놓을 때 가운데로 돌아오고, 움직이지 않고 누르면(클릭) SW가 눌립니다."),
  w: 8,
  h: 10,
  pins: JS_PINS.map((id, i) => ({
    id,
    x: 2 + i,
    y: 10,
    label: { "+5V": t("+5V (VCC, 보통 3V3에)"), VRx: t("VRx (X축 아날로그)"), VRy: t("VRy (Y축 아날로그)"), SW: t("SW (누르면 GND)") }[id] ?? id,
  })),
  props: { x: 0.5, y: 0.5, sw: 0 },
  ranges: {
    x: { min: 0, max: 1, step: 0.01, label: t("X (0 왼쪽 … 1 오른쪽)"), unit: "" },
    y: { min: 0, max: 1, step: 0.01, label: t("Y (0 아래 … 1 위)"), unit: "" },
    sw: { min: 0, max: 1, step: 1, label: t("SW 누름 (1)"), unit: "" },
  },
  controls: { stick: joystickStick(JS_CX, JS_CY, JS_RANGE) },
  render: (props, visual) => {
    const x = Math.min(1, Math.max(0, Number(props.x) || 0)),
      y = Math.min(1, Math.max(0, Number(props.y) || 0));
    const sw = Number(props.sw) > 0;
    const kx = JS_CX + (x - 0.5) * 2 * JS_RANGE,
      ky = JS_CY - (y - 0.5) * 2 * JS_RANGE;
    return (
      <g data-x={x.toFixed(2)} data-y={y.toFixed(2)} data-sw={sw ? "1" : "0"}>
        <rect x={0} y={0} width={8 * P} height={9.4 * P} rx={1} className="module-pcb" />
        {JS_PINS.map((n, i) => (
          <text
            key={n}
            x={(2 + i) * P + 1.2}
            y={9.1 * P}
            transform={`rotate(-90 ${(2 + i) * P + 1.2} ${9.1 * P})`}
            className="silk module-label"
          >
            {n}
          </text>
        ))}
        <rect x={JS_CX - 3.1 * P} y={JS_CY - 3.1 * P} width={6.2 * P} height={6.2 * P} rx={1} className="js-well" />
        <line x1={JS_CX} y1={JS_CY} x2={kx} y2={ky} className="js-shaft" />
        <g data-drag="stick" className={visual.control === "stick" ? "js-knob held" : "js-knob"}>
          {/* A larger invisible target, so the knob is easy to grab. */}
          <circle cx={kx} cy={ky} r={1.6 * P} className="js-hit" />
          <circle cx={kx} cy={ky} r={1.25 * P} className={sw ? "js-cap pressed" : "js-cap"} />
          {[0.45, 0.85].map((r) => (
            <circle key={r} cx={kx} cy={ky} r={r * P} className="js-ring" />
          ))}
        </g>
        <text x={4 * P} y={-0.4 * P} textAnchor="middle" className="silk small value">
          X {x.toFixed(2)} · Y {y.toFixed(2)}
          {sw ? " · SW" : ""}
        </text>
        {visual.unpowered && <NoPower x={4 * P} y={11.4 * P} />}
      </g>
    );
  },
};

// ---------------------------------------------------------- HC-SR501

/** The person walks along y = PIR_TRACK; the dome is at (PIR_CX, PIR_CY). */
const PIR_W = 12;
const PIR_CX = 6 * P,
  PIR_CY = 9.6 * P,
  PIR_TRACK = 3.6 * P;
/** Half-angle of the field of view drawn (the real lens covers ~110°). */
const PIR_HALF = (38 * Math.PI) / 180;
const PIR_REACH = PIR_CY - PIR_TRACK;
const personX = (pos: number) => pos * PIR_W * P;
const inView = (pos: number) => Math.abs(personX(pos) - PIR_CX) <= PIR_REACH * Math.tan(PIR_HALF);

const PIR_STATE: Record<string, string> = {
  off: t("꺼짐"),
  warmup: t("준비 중 (워밍업)"),
  ready: t("감지 대기"),
  high: t("감지! OUT High"),
  block: t("차단 시간 (2.5 s)"),
};

/** A person seen from the front, feet at (x, y). */
function Person({ x, y, moving }: { x: number; y: number; moving: boolean }) {
  const s = P * 0.9;
  return (
    <g className={moving ? "person moving" : "person"} transform={`translate(${x} ${y})`}>
      <circle cx={0} cy={-3.1 * s} r={0.45 * s} />
      <path d={`M 0 ${-2.6 * s} V ${-1.1 * s} M ${-0.8 * s} ${-2.1 * s} L 0 ${-2.3 * s} L ${0.8 * s} ${-2.1 * s} M ${-0.6 * s} 0 L 0 ${-1.1 * s} L ${0.6 * s} 0`} />
    </g>
  );
}

export const pir: PartDef = {
  kind: "pir",
  name: t("PIR 인체 감지 센서 (HC-SR501)"),
  category: "sensor",
  description:
    t("적외선(PIR) 움직임 센서 모듈. 사람이 시야(부채꼴) 안에서 움직이면 OUT이 3.3 V(High)가 됩니다. 유지 시간 delay(모듈의 Tx 가변저항, 실제 0.3초–5분, 여기선 기본 3초): mode H(재트리거)는 마지막 움직임부터, mode L(단발)은 처음 감지부터 셉니다. OUT이 Low로 돌아온 뒤 약 2.5초는 아무것도 감지하지 않습니다(차단 시간). 전원을 넣고 warmup초(실제 30–60초, 여기선 기본 3초) 동안은 안정화 중이라 감지하지 않습니다. VCC는 5V(4.5–20 V) — 3V3에서는 동작하지 않습니다. 사람을 끌어 부채꼴 안을 지나가게 하거나 '움직임' 버튼을 누르세요."),
  w: PIR_W,
  h: 14,
  pins: [
    { id: "VCC", x: 5, y: 14, label: "VCC (5V, 4.5–20 V)" },
    { id: "OUT", x: 6, y: 14, label: t("OUT (움직임 시 3.3 V)") },
    { id: "GND", x: 7, y: 14, label: "GND" },
  ],
  props: { mode: "H", delay: 3, warmup: 3, person: 0.05, motion: 0 },
  propOptions: { mode: ["H", "L"] },
  ranges: {
    delay: { min: 0.3, max: 300, step: 0.1, label: t("유지 시간 (Tx)"), unit: "s", log: true },
    warmup: { min: 0, max: 60, step: 1, label: t("워밍업"), unit: "s" },
    motion: { min: 0, max: 1, step: 1, label: t("움직임 (1 = 있음)"), unit: "" },
  },
  controls: { person: personDrag(0, PIR_W * P, inView), wave: waveControl },
  render: (props, visual) => {
    const pos = Math.min(1, Math.max(0, Number(props.person) || 0));
    const motion = Number(props.motion) > 0;
    const state = visual.text ?? "off";
    const out = (visual.on ?? 0) > 0.5;
    const reach = PIR_REACH + 0.4 * P;
    const dx = reach * Math.tan(PIR_HALF);
    return (
      <g data-pir-state={state} data-pir-out={out ? "1" : "0"} data-motion={motion ? "1" : "0"} data-person={pos.toFixed(3)}>
        {/* Field of view. */}
        <path
          d={`M ${PIR_CX} ${PIR_CY} L ${PIR_CX - dx} ${PIR_CY - reach} A ${reach * 1.3} ${reach * 1.3} 0 0 1 ${PIR_CX + dx} ${PIR_CY - reach} Z`}
          className={motion && inView(pos) ? "pir-fan seen" : "pir-fan"}
        />
        <line x1={0} y1={PIR_TRACK} x2={PIR_W * P} y2={PIR_TRACK} className="pir-track" />
        <g data-drag="person" className={visual.control === "person" ? "person-grab held" : "person-grab"}>
          <rect x={personX(pos) - 1.2 * P} y={PIR_TRACK - 3.8 * P} width={2.4 * P} height={4.2 * P} className="js-hit" />
          <Person x={personX(pos)} y={PIR_TRACK} moving={motion} />
        </g>
        {/* The module: PCB, Fresnel dome, the two trimmers and the H/L jumper. */}
        <rect x={2 * P} y={7.6 * P} width={8 * P} height={5.8 * P} rx={0.8} className="pir-pcb" />
        <circle cx={PIR_CX} cy={PIR_CY + 0.3 * P} r={1.9 * P} className="pir-dome" />
        {[0.9, 1.4].map((r) => (
          <circle key={r} cx={PIR_CX} cy={PIR_CY + 0.3 * P} r={r * P} className="pir-lens" />
        ))}
        <circle cx={3 * P} cy={12.4 * P} r={0.4 * P} className="pir-trim" />
        <circle cx={9 * P} cy={12.4 * P} r={0.4 * P} className="pir-trim" />
        <text x={3 * P} y={11.6 * P} textAnchor="middle" className="silk tiny">
          Sx
        </text>
        <text x={9 * P} y={11.6 * P} textAnchor="middle" className="silk tiny">
          Tx {Number(props.delay) || 0}s
        </text>
        <text x={4.4 * P} y={12.8 * P} textAnchor="middle" className="silk tiny">
          {props.mode === "L" ? t("L 단발") : t("H 재트리거")}
        </text>
        {["VCC", "OUT", "GND"].map((n, i) => (
          <text key={n} x={(5 + i) * P} y={13.2 * P} textAnchor="middle" className="silk tiny">
            {n}
          </text>
        ))}
        <circle cx={8.3 * P} cy={8.4 * P} r={0.32 * P} className={out ? "pir-led on" : "pir-led"} data-pir-led={out ? "1" : "0"} />
        <g data-drag="wave" className={visual.control === "wave" ? "shake-button held" : "shake-button"} aria-label={t("움직임")}>
          <rect x={10.2 * P} y={11.9 * P} width={2.3 * P} height={1.1 * P} rx={1.5} />
          <text x={11.35 * P} y={12.68 * P} textAnchor="middle">
            {t("움직임")}
          </text>
        </g>
        <text x={PIR_CX} y={7.2 * P} textAnchor="middle" className="silk small value" data-pir-label={state}>
          {PIR_STATE[state] ?? state}
        </text>
        {visual.unpowered && <NoPower x={PIR_CX} y={15.4 * P} />}
      </g>
    );
  },
};

// ------------------------------------------------------------- BMP280

const BMP_PINS = ["VCC", "GND", "SCL", "SDA"];

/** Altitude (m) of a pressure (hPa) by the barometric formula. */
export const altitudeOf = (hpa: number) => 44330 * (1 - Math.pow(hpa / 1013.25, 0.1903));

export const bmp280: PartDef = {
  kind: "bmp280",
  name: t("기압·온도 센서 (BMP280)"),
  category: "sensor",
  description:
    t("Bosch BMP280 기압계 모듈(I2C). 주소 0x76(SDO를 GND에), 0x77(SDO를 VCC에). 칩 ID 0xD0 = 0x58, 0xE0에 0xB6을 쓰면 리셋. 0x88–0x9F에 공장 보정값(dig_T1–T3, dig_P1–P9, 리틀 엔디언; 데이터시트 예제 값)이 있고, 0xF4(ctrl_meas)에 온도·기압 오버샘플링과 모드(00 잠자기, 01 강제 측정 한 번, 11 연속)를 씁니다. 강제 측정 중엔 0xF3 비트 3이 1, 끝나면 0xF7부터 기압 20비트, 0xFA부터 온도 20비트 원시값이 들어 있습니다 — 데이터시트의 보정 공식(정수 코드)을 돌리면 설정한 온도·기압이 나옵니다. 오버샘플링 0(건너뜀)이면 0x80000. 고도 ≈ 44330 × (1 − (P/1013.25)^0.1903) m. IIR 필터와 대기 시간은 시뮬레이션하지 않습니다. 센서를 누르고 있으면 손가락 체온으로 데워집니다. VCC 3V3."),
  w: 5,
  h: 5,
  pins: BMP_PINS.map((id, i) => ({ id, x: 1 + i, y: 5, label: id })),
  props: { address: "0x76", temp: 25, pressure: 1013.25 },
  propOptions: { address: ["0x76", "0x77"] },
  ranges: {
    temp: { min: -40, max: 85, step: 0.1, label: t("온도"), unit: "°C" },
    pressure: { min: 300, max: 1100, step: 0.25, label: t("기압"), unit: "hPa" },
  },
  controls: { touch: fingerTouch("temp") },
  render: (props, visual) => {
    const t = Number(props.temp),
      p = Number(props.pressure);
    return (
      <g data-drag="touch" data-temp={t} data-pressure={p} data-mode={visual.text ?? ""}>
        <rect x={0} y={0} width={5 * P} height={5 * P} rx={1.2} className="bmp-pcb" />
        {BMP_PINS.map((n, i) => (
          <text key={n} x={(1 + i) * P} y={4.4 * P} textAnchor="middle" className="silk tiny">
            {n}
          </text>
        ))}
        <rect x={1.8 * P} y={1.2 * P} width={1.4 * P} height={1.4 * P} rx={0.3} className="bmp-can" />
        <circle cx={2.15 * P} cy={1.55 * P} r={0.12 * P} fill="#333" />
        <text x={2.5 * P} y={3.4 * P} textAnchor="middle" className="silk tiny">
          BMP280 {String(props.address ?? "0x76")}
        </text>
        {visual.control === "touch" && <Fingertip x={2.5 * P} y={1.9 * P} scale={0.8} />}
        <text x={2.5 * P} y={-0.5 * P} textAnchor="middle" className="silk small value">
          {t.toFixed(1)} °C · {p.toFixed(1)} hPa (≈ {altitudeOf(p).toFixed(0)} m)
        </text>
        {visual.unpowered && <NoPower x={2.5 * P} y={6.4 * P} />}
      </g>
    );
  },
};
