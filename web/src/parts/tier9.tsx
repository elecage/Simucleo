// Tier 9 parts (M21): motors. A NEMA17 bipolar stepper with an A4988 /
// DRV8825 step driver or an L298N dual H-bridge, a hobby ESC with a
// brushless motor and propeller, a BLDC with hall sensors on a 3-phase
// bridge, and a DC supply for their motor voltage. Their models live in
// `simucleo_circuit::tier9`.
import { shaftTurn } from "./controls";
import { PITCH, type MotorView, type PartDef, type VisualState } from "./types";
import { t } from "../i18n";

const P = PITCH;

const NoPower = ({ x, y, text = t("전원 부족") }: { x: number; y: number; text?: string }) => (
  <text x={x} y={y} textAnchor="middle" className="silk small unpowered" data-unpowered="1">
    {text}
  </text>
);

const fmt = (v: number, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : "0");

/**
 * A signed current bar centred at (x, y): right of the centre line for a
 * positive current, left for a negative one, `w` long at full current.
 */
function CurrentBar({ x, y, w, value, label, name }: { x: number; y: number; w: number; value: number; label: string; name: string }) {
  const v = Math.max(-1.2, Math.min(1.2, value));
  const len = (Math.abs(v) * w) / 2;
  return (
    <g data-coil={name} data-current={v.toFixed(2)}>
      <text x={x - w / 2 - 0.4 * P} y={y + 0.3 * P} textAnchor="end" className="silk tiny">
        {label}
      </text>
      <rect x={x - w / 2} y={y - 0.35 * P} width={w} height={0.7 * P} className="coil-track" />
      <rect x={v >= 0 ? x : x - len} y={y - 0.35 * P} width={len} height={0.7 * P} className={v >= 0 ? "coil-bar pos" : "coil-bar neg"} />
      <line x1={x} y1={y - 0.5 * P} x2={x} y2={y + 0.5 * P} className="coil-zero" />
    </g>
  );
}

// ------------------------------------------------------------ battery

export const battery: PartDef = {
  kind: "battery",
  name: t("DC 전원 (배터리/어댑터)"),
  category: "basic",
  description:
    t("모터용 직류 전원: 12 V 어댑터, 3S 리튬폴리머(11.1 V) 배터리 등. 보드의 5V·3V3로는 스텝 드라이버(VMOT 8 V 이상)나 ESC를 돌릴 수 없습니다. +를 모터 전원 입력(VMOT, 12V, PVDD, BAT+)에, −를 GND에 연결하고, 신호의 기준이 같도록 −를 Nucleo의 GND와도 이어 주세요(공통 접지). 전압은 슬라이더로 바꿉니다."),
  w: 5,
  h: 4,
  pins: [
    { id: "+", x: 1, y: 4, label: t("+ (모터 전원)") },
    { id: "-", x: 4, y: 4, label: "− (GND)" },
  ],
  props: { voltage: 12 },
  ranges: { voltage: { min: 3, max: 24, step: 0.1, label: t("전압"), unit: "V" } },
  render: (props) => {
    const v = Number(props.voltage) || 0;
    return (
      <g data-voltage={v}>
        <line x1={P} y1={3 * P} x2={P} y2={4 * P} stroke="#d32f2f" strokeWidth={1.4} />
        <line x1={4 * P} y1={3 * P} x2={4 * P} y2={4 * P} stroke="#222" strokeWidth={1.4} />
        <rect x={0} y={0.2 * P} width={5 * P} height={2.9 * P} rx={1.2} className="battery-body" />
        <rect x={0.3 * P} y={0.5 * P} width={1.2 * P} height={2.3 * P} rx={0.6} className="battery-cap" />
        <text x={3.3 * P} y={1.6 * P} textAnchor="middle" className="silk battery-label">
          {fmt(v, 1)} V
        </text>
        <text x={3.3 * P} y={2.6 * P} textAnchor="middle" className="silk tiny battery-label">
          {t("+ 빨강 · − 검정")}
        </text>
      </g>
    );
  },
};

// ---------------------------------------------------- NEMA17 stepper

const NEMA_PINS: [string, string, string][] = [
  ["A+", "#111", t("A+ (검정, 코일 A)")],
  ["A-", "#16a34a", t("A− (초록, 코일 A)")],
  ["B+", "#dc2626", t("B+ (빨강, 코일 B)")],
  ["B-", "#2563eb", t("B− (파랑, 코일 B)")],
];
/** Shaft centre in part units. */
const NEMA_C = { x: 4.5 * P, y: 4.2 * P };

export const stepperNema17: PartDef = {
  kind: "stepper-nema17",
  name: t("스테퍼 모터 (NEMA17 바이폴라)"),
  category: "actuator",
  description:
    t("42 mm NEMA17 바이폴라 스테퍼: 코일 두 개(A: A+/A−, B: B+/B−), 한 바퀴 200스텝(1.8°), 홀딩 토크 40 N·cm. 두 코일 전류의 방향 벡터 atan2(I_B, I_A)가 회전자를 끌어당기고, 전기각 한 주기(360°)가 4스텝 = 7.2°입니다. 드라이버(A4988/DRV8825 또는 L298N)의 출력 쌍에 코일 하나씩 연결하세요(1A/1B → A+/A−, 2A/2B → B+/B−). 한 코일의 두 선을 바꾸면 반대로 돕니다. 멈춘 상태에서 갑자기 빠르게(약 1100 스텝/s 이상) 스텝을 주거나 부하가 토크보다 크면 회전자가 자기장을 놓쳐 스텝을 잃습니다(탈조) — 가속 램프로 천천히 올리세요. 드라이버가 꺼져 있으면(EN High) 축을 손으로 돌릴 수 있고, 켜져 있으면 홀딩 토크가 되돌립니다. 부하(브레이크) 슬라이더로 탈조를 일으켜 보세요."),
  w: 9,
  h: 10,
  pins: NEMA_PINS.map(([id, , label], i) => ({ id, x: 3 + i, y: 10, label })),
  props: { load: 0, inertia: 0, turn: 0 },
  ranges: {
    load: { min: 0, max: 60, step: 1, label: t("부하 (브레이크)"), unit: "N·cm" },
    inertia: { min: 0, max: 500, step: 10, label: t("축에 단 관성"), unit: "g·cm²" },
  },
  controls: { shaft: shaftTurn("turn", NEMA_C.x, NEMA_C.y) },
  render: (_props, visual: VisualState) => {
    const m: MotorView | undefined = visual.motor;
    const angle = visual.angle ?? 0;
    const rpm = visual.rpm ?? 0;
    const steps = m?.steps ?? 0;
    const lost = m?.lost ?? 0;
    const coils = m?.coils ?? [0, 0];
    const stalled = !!m?.stalled;
    const { x: cx, y: cy } = NEMA_C;
    return (
      <g
        data-angle={angle.toFixed(1)}
        data-steps={steps.toFixed(1)}
        data-lost={lost}
        data-rpm={rpm.toFixed(0)}
        data-stalled={stalled ? "1" : "0"}
      >
        {NEMA_PINS.map(([id, color], i) => (
          <line key={id} x1={(3 + i) * P} y1={8.6 * P} x2={(3 + i) * P} y2={10 * P} stroke={color} strokeWidth={1.3} />
        ))}
        {/* Front of the motor: square flange, round boss, the shaft. */}
        <rect x={0.6 * P} y={0.3 * P} width={7.8 * P} height={7.8 * P} rx={1.2} className="nema-body" />
        {[
          [1.3, 1.0],
          [7.7, 1.0],
          [1.3, 7.4],
          [7.7, 7.4],
        ].map(([x, y]) => (
          <circle key={`${x}${y}`} cx={x * P} cy={y * P} r={0.35 * P} className="nema-screw" />
        ))}
        <circle cx={cx} cy={cy} r={2.6 * P} className="nema-boss" />
        {/* Step ticks every 18° (10 full steps). */}
        {Array.from({ length: 20 }, (_, i) => (
          <line
            key={i}
            x1={cx}
            y1={cy - 2.35 * P}
            x2={cx}
            y2={cy - (i % 5 === 0 ? 1.9 : 2.1) * P}
            className="nema-tick"
            transform={`rotate(${i * 18} ${cx} ${cy})`}
          />
        ))}
        <g data-drag="shaft" className={visual.control === "shaft" ? "shaft-grab held" : "shaft-grab"}>
          <circle cx={cx} cy={cy} r={2.3 * P} className="js-hit" />
          <g transform={`rotate(${angle} ${cx} ${cy})`} data-shaft-angle={angle.toFixed(1)}>
            {/* A flag on the shaft: the marker that shows each step. */}
            <rect x={cx - 0.25 * P} y={cy - 2.2 * P} width={0.5 * P} height={2.2 * P} rx={0.2} className="nema-flag" />
            <circle cx={cx} cy={cy} r={0.6 * P} className="motor-shaft" />
          </g>
        </g>
        <text x={cx} y={-0.4 * P} textAnchor="middle" className="silk small value" data-readout="1">
          {t("{angle}° · {steps} 스텝 · {rpm} rpm", { angle: fmt(angle, 1), steps: fmt(steps, 1), rpm: fmt(rpm) })}
        </text>
        {/* Coil currents, signed. */}
        <CurrentBar x={cx} y={6.4 * P} w={4 * P} value={coils[0] ?? 0} label="A" name="A" />
        <CurrentBar x={cx} y={7.4 * P} w={4 * P} value={coils[1] ?? 0} label="B" name="B" />
        {(stalled || lost > 0) && (
          <text x={cx} y={11.2 * P} textAnchor="middle" className={stalled ? "silk small stall on" : "silk small stall"} data-stall={stalled ? "1" : "0"}>
            {stalled ? t("탈조! ") : ""}{t("잃은 스텝 {lost}", { lost })}
          </text>
        )}
      </g>
    );
  },
};

// ---------------------------------------------------- A4988 / DRV8825

const DRV_LEFT = ["EN", "MS1", "MS2", "MS3", "RST", "SLP", "STEP", "DIR"];
const DRV_RIGHT = ["VMOT", "GND", "2B", "2A", "1A", "1B", "VDD", "GND2"];
const DRV_LABEL: Record<string, string> = {
  EN: t("EN (Low = 출력 켜짐, 보드에서 풀다운)"),
  MS1: t("MS1 / M0 (마이크로스텝, 풀다운)"),
  MS2: t("MS2 / M1 (마이크로스텝, 풀다운)"),
  MS3: t("MS3 / M2 (마이크로스텝, 풀다운)"),
  RST: t("RST (Low = 리셋, 떠 있음: SLP에 연결)"),
  SLP: t("SLP (Low = 절전, 보드에서 풀업)"),
  STEP: t("STEP (상승 에지마다 한 마이크로스텝)"),
  DIR: t("DIR (회전 방향)"),
  VMOT: t("VMOT (모터 전원 8–35 V)"),
  GND: t("GND (모터 전원)"),
  "2B": t("2B (코일 B)"),
  "2A": t("2A (코일 B)"),
  "1A": t("1A (코일 A)"),
  "1B": t("1B (코일 A)"),
  VDD: t("VDD (로직 전원 3–5.5 V, 3V3에)"),
  GND2: t("GND (로직)"),
};
const DRV_STATE: Record<string, string> = {
  on: t("출력 켜짐"),
  disabled: t("꺼짐 (EN High)"),
  sleep: t("절전 (SLP Low)"),
  reset: t("리셋 (RST Low)"),
  "no-vmot": t("VMOT 없음"),
  "no-vdd": t("VDD 없음"),
};

export const a4988: PartDef = {
  kind: "a4988",
  name: t("스텝 드라이버 (A4988 / DRV8825)"),
  category: "module",
  description:
    t("바이폴라 스테퍼용 스텝/방향 드라이버 캐리어 보드(Pololu 형). STEP 핀이 Low→High로 바뀔 때마다 DIR 방향으로 한 마이크로스텝 움직이고, 코일 전류를 사인/코사인 표에 맞춰 조절합니다(1A/1B = 코일 A, 2A/2B = 코일 B). 마이크로스텝(MS1 MS2 MS3): 000 풀, 100 1/2, 010 1/4, 110 1/8, 111 1/16. model을 DRV8825로 바꾸면 M0 M1 M2: 001 1/16, 101·011·111 1/32. STEP 펄스는 High·Low 모두 1 µs 이상(DRV8825는 1.9 µs). EN이 High, SLP가 Low, RST가 Low이면 출력이 꺼져 모터가 헐거워집니다 — RST는 보드에서 떠 있으니 SLP에 연결하세요. VMOT에 8–35 V 모터 전원(DC 전원 부품)과 GND, VDD에 3V3(A4988의 High 판정은 0.7 × VDD). current는 전류 제한 가변저항(Vref)으로 정한 정격 전류의 비율입니다."),
  w: 6,
  h: 9,
  pins: [
    ...DRV_LEFT.map((id, i) => ({ id, x: 0, y: 1 + i, label: DRV_LABEL[id] })),
    ...DRV_RIGHT.map((id, i) => ({ id, x: 6, y: 1 + i, label: DRV_LABEL[id] })),
  ],
  buses: [["GND", "GND2"]],
  props: { model: "A4988", current: 100 },
  propOptions: { model: ["A4988", "DRV8825"] },
  ranges: { current: { min: 10, max: 100, step: 5, label: t("전류 제한 (Vref)"), unit: "%" } },
  render: (props, visual) => {
    const m = visual.motor;
    const state = m?.state ?? "no-vdd";
    const on = state === "on";
    const drv = props.model === "DRV8825";
    return (
      <g data-state={state} data-micro={m?.micro ?? 1} data-steps={m?.steps ?? 0}>
        <rect x={0.5 * P} y={0.3 * P} width={5 * P} height={9.4 * P} rx={0.8} className={drv ? "drv-pcb drv8825" : "drv-pcb"} />
        {DRV_LEFT.map((n, i) => (
          <text key={n} x={0.9 * P} y={(1.25 + i) * P} className="silk tiny drv-label">
            {n}
          </text>
        ))}
        {DRV_RIGHT.map((n, i) => (
          <text key={n} x={5.1 * P} y={(1.25 + i) * P} textAnchor="end" className="silk tiny drv-label">
            {n === "GND2" ? "GND" : n}
          </text>
        ))}
        <rect x={2.1 * P} y={3.4 * P} width={1.8 * P} height={1.8 * P} className="chip" />
        <text x={3 * P} y={4.45 * P} textAnchor="middle" className="silk chip-label">
          {drv ? "8825" : "4988"}
        </text>
        {/* The current-limit trimmer. */}
        <circle cx={3 * P} cy={2 * P} r={0.55 * P} className="pir-trim" />
        <text x={3 * P} y={6.3 * P} textAnchor="middle" className="silk tiny drv-label" data-micro-label="1">
          {t("{micro} 스텝", { micro: visual.text ?? "1/1" })}
        </text>
        <text x={3 * P} y={7.2 * P} textAnchor="middle" className={on ? "silk tiny drv-label" : "silk tiny drv-off"} data-state-label={state}>
          {DRV_STATE[state] ?? state}
        </text>
        <circle cx={3 * P} cy={8.3 * P} r={0.35 * P} className={on ? "drv-led on" : "drv-led"} />
        {visual.unpowered && <NoPower x={3 * P} y={-0.5 * P} text={state === "no-vdd" ? t("VDD 없음") : t("VMOT 없음")} />}
      </g>
    );
  },
};

// -------------------------------------------------------------- L298N

const L298_BOTTOM = ["12V", "GND", "5V", "ENA", "IN1", "IN2", "IN3", "IN4", "ENB"];
const L298_LABEL: Record<string, string> = {
  "12V": t("12V (모터 전원 VS, 7 V 이상이면 보드의 5 V 레귤레이터도 동작)"),
  GND: "GND",
  "5V": t("5V (로직 전원 입력/출력)"),
  ENA: t("ENA (브리지 A 켜기, PWM — jumpers=off일 때)"),
  ENB: t("ENB (브리지 B 켜기, PWM — jumpers=off일 때)"),
  IN1: "IN1 (OUT1)",
  IN2: "IN2 (OUT2)",
  IN3: "IN3 (OUT3)",
  IN4: "IN4 (OUT4)",
  OUT1: t("OUT1 (브리지 A)"),
  OUT2: t("OUT2 (브리지 A)"),
  OUT3: t("OUT3 (브리지 B)"),
  OUT4: t("OUT4 (브리지 B)"),
};

export const l298n: PartDef = {
  kind: "l298n",
  name: t("H-브리지 모듈 (L298N, 2채널)"),
  category: "module",
  description:
    t("L298N 듀얼 H-브리지 모듈. 브리지 A: IN1·IN2 → OUT1·OUT2, 브리지 B: IN3·IN4 → OUT3·OUT4. IN1 High·IN2 Low면 OUT1→OUT2 방향, 반대면 반대 방향, 같으면 브레이크(전류 0). ENA/ENB가 Low면 그 브리지가 꺼지고, PWM을 주면 코일 전류가 듀티만큼으로 평균됩니다 — 모듈의 ENA/ENB 점퍼를 빼야(jumpers=off) 핀이 쓰입니다. 바이폴라 스테퍼는 코일 A를 OUT1/OUT2에, 코일 B를 OUT3/OUT4에 연결하고 펌웨어가 풀스텝(A+, B+, A−, B−) 또는 반스텝(A+, A+B+, B+, …) 순서를 직접 만듭니다. 순서가 틀려 자기장이 180° 뒤집히면(예: A+ 다음 A−) 회전자가 어느 쪽으로 돌지 몰라 떨기만 합니다. 12V에 모터 전원, GND는 Nucleo와 공통. 입력의 High는 2.3 V 이상(3.3 V 출력으로 됨)."),
  w: 10,
  h: 10,
  pins: [
    { id: "OUT1", x: 0, y: 3, label: L298_LABEL.OUT1 },
    { id: "OUT2", x: 0, y: 4, label: L298_LABEL.OUT2 },
    { id: "OUT3", x: 10, y: 3, label: L298_LABEL.OUT3 },
    { id: "OUT4", x: 10, y: 4, label: L298_LABEL.OUT4 },
    ...L298_BOTTOM.map((id, i) => ({ id, x: 1 + i, y: 10, label: L298_LABEL[id] })),
  ],
  props: { jumpers: "on" },
  propOptions: { jumpers: ["on", "off"] },
  render: (props, visual) => {
    const m = visual.motor;
    const out = m?.coils ?? [0, 0];
    const powered = !visual.unpowered && !!m;
    const jumpers = props.jumpers !== "off";
    return (
      <g data-out-a={(out[0] ?? 0).toFixed(2)} data-out-b={(out[1] ?? 0).toFixed(2)} data-jumpers={jumpers ? "on" : "off"}>
        <rect x={0.3 * P} y={0.3 * P} width={9.4 * P} height={9.2 * P} rx={0.8} className="l298-pcb" />
        {/* The heatsink over the L298N. */}
        <rect x={3 * P} y={0.6 * P} width={4 * P} height={3.4 * P} className="l298-heatsink" />
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <line key={i} x1={(3.3 + i * 0.68) * P} y1={0.8 * P} x2={(3.3 + i * 0.68) * P} y2={3.8 * P} className="l298-fin" />
        ))}
        <text x={5 * P} y={4.8 * P} textAnchor="middle" className="silk tiny drv-label">
          L298N
        </text>
        <text x={0.8 * P} y={2.4 * P} className="silk tiny drv-label">
          A
        </text>
        <text x={9.2 * P} y={2.4 * P} textAnchor="end" className="silk tiny drv-label">
          B
        </text>
        {/* Bridge outputs averaged over the frame. */}
        <CurrentBar x={5 * P} y={6 * P} w={4.5 * P} value={out[0] ?? 0} label="A" name="A" />
        <CurrentBar x={5 * P} y={7 * P} w={4.5 * P} value={out[1] ?? 0} label="B" name="B" />
        {L298_BOTTOM.map((n, i) => (
          <text key={n} x={(1 + i) * P} y={9.2 * P} textAnchor="middle" className="silk tiny drv-label">
            {n}
          </text>
        ))}
        {/* ENA/ENB jumpers. */}
        {jumpers &&
          [4, 9].map((x) => <rect key={x} x={(x - 0.35) * P} y={7.9 * P} width={0.7 * P} height={0.7 * P} className="l298-jumper" />)}
        <circle cx={8.6 * P} cy={1.2 * P} r={0.35 * P} className={powered ? "drv-led on" : "drv-led"} />
        {visual.unpowered && <NoPower x={5 * P} y={-0.5 * P} text={t("12V 없음")} />}
      </g>
    );
  },
};

// ---------------------------------------------------------- ESC + BLDC

const ESC_STATE: Record<string, string> = {
  off: t("꺼짐 (배터리 없음)"),
  waiting: t("신호 대기"),
  arming: t("아밍 중… (최저 스로틀 1초)"),
  "throttle-high": t("아밍 거부 — 스로틀을 내리세요"),
  armed: t("아밍됨"),
  failsafe: t("페일세이프 — 신호 끊김"),
};
const ESC_C = { x: 8 * P, y: 3.6 * P };

export const escBldc: PartDef = {
  kind: "esc-bldc",
  name: t("ESC + 브러시리스 모터 (프로펠러)"),
  category: "actuator",
  description:
    t("취미용 ESC(BLHeli 계열)와 아웃러너 BLDC 모터, 프로펠러. 신호는 서보와 같은 50 Hz 펄스: 1000 µs = 정지 … 2000 µs = 최대 스로틀. 전원을 넣은 뒤 최저 스로틀(1000 µs)을 1초 이상 받아야 '아밍'되어 돌기 시작합니다(삐 소리) — 처음부터 스로틀이 올라가 있으면 아밍을 거부합니다. 신호가 0.5초 넘게 끊기면 페일세이프로 모터를 멈추고 다시 아밍해야 합니다. 최고 속도는 KV × 배터리 전압(1000 KV × 11.1 V = 11100 rpm), 속도는 스로틀을 1차 지연으로 따라갑니다. BAT+/BAT−에 배터리(DC 전원 부품, 2–4S: 7–17 V), SIG를 PWM 핀에, GND를 Nucleo GND에. 부하 슬라이더로 프로펠러를 잡아 보세요."),
  w: 12,
  h: 9,
  pins: [
    { id: "SIG", x: 1, y: 9, label: t("SIG (흰색/노랑, 서보 펄스)") },
    { id: "GND", x: 2, y: 9, label: t("GND (검정, 신호 기준 = 배터리 −)") },
    { id: "BAT+", x: 9, y: 9, label: t("BAT+ (빨강, 배터리 +)") },
    { id: "BAT-", x: 10, y: 9, label: t("BAT− (검정, 배터리 −)") },
  ],
  buses: [["GND", "BAT-"]],
  props: { kv: 1000, load: 0 },
  ranges: {
    kv: { min: 300, max: 3000, step: 50, label: t("모터 KV"), unit: "rpm/V" },
    load: { min: 0, max: 100, step: 1, label: t("부하 (프로펠러 잡기)"), unit: "%" },
  },
  render: (_props, visual) => {
    const m = visual.motor;
    const state = m?.state ?? "off";
    const rpm = visual.rpm ?? 0;
    const angle = visual.angle ?? 0;
    const throttle = m?.throttle ?? 0;
    const blur = Math.min(1, Math.abs(rpm) / 3000);
    const { x: cx, y: cy } = ESC_C;
    return (
      <g data-esc-state={state} data-rpm={rpm.toFixed(0)} data-throttle={throttle.toFixed(2)} data-beeps={m?.beeps ?? 0}>
        {[1, 2, 9, 10].map((x, i) => (
          <line key={x} x1={x * P} y1={7.6 * P} x2={x * P} y2={9 * P} stroke={["#e5e7eb", "#222", "#d32f2f", "#222"][i]} strokeWidth={1.3} />
        ))}
        {/* The ESC in its shrink wrap. */}
        <rect x={0.2 * P} y={4.2 * P} width={4.6 * P} height={3.4 * P} rx={1} className="esc-body" />
        <text x={2.5 * P} y={5.4 * P} textAnchor="middle" className="silk tiny esc-label">
          ESC 30A
        </text>
        <rect x={0.6 * P} y={6} width={3.8 * P} height={0.6 * P} className="coil-track" transform={`translate(0 ${6.2 * P - 6})`} />
        <rect x={0.6 * P} y={6.2 * P} width={3.8 * P * throttle} height={0.6 * P} className="coil-bar pos" data-throttle-bar="1" />
        <text x={2.5 * P} y={7.4 * P} textAnchor="middle" className="silk tiny esc-label">
          {t("스로틀 {pct} %", { pct: fmt(throttle * 100) })}
        </text>
        {/* Three phase wires to the motor. */}
        {[0, 1, 2].map((i) => (
          <line key={i} x1={4.8 * P} y1={(5 + i * 0.5) * P} x2={(cx / P - 1.6) * P} y2={(cy / P + 0.6 + i * 0.4) * P} className={`phase-wire p${i}`} />
        ))}
        {/* Outrunner bell and the propeller. */}
        <circle cx={cx} cy={cy} r={1.6 * P} className="bldc-bell" />
        {blur > 0.05 && <circle cx={cx} cy={cy} r={3.4 * P} className="prop-disc" opacity={0.15 + 0.35 * blur} />}
        <g transform={`rotate(${angle} ${cx} ${cy})`} data-prop-angle={angle.toFixed(0)} opacity={1 - 0.6 * blur}>
          <path
            d={`M ${cx} ${cy} C ${cx + 0.6 * P} ${cy - 1.2 * P} ${cx + 0.5 * P} ${cy - 3 * P} ${cx} ${cy - 3.4 * P} C ${cx - 0.5 * P} ${cy - 3 * P} ${cx - 0.3 * P} ${cy - 1.2 * P} ${cx} ${cy} Z`}
            className="prop-blade"
          />
          <path
            d={`M ${cx} ${cy} C ${cx - 0.6 * P} ${cy + 1.2 * P} ${cx - 0.5 * P} ${cy + 3 * P} ${cx} ${cy + 3.4 * P} C ${cx + 0.5 * P} ${cy + 3 * P} ${cx + 0.3 * P} ${cy + 1.2 * P} ${cx} ${cy} Z`}
            className="prop-blade"
          />
          <circle cx={cx} cy={cy} r={0.45 * P} className="motor-shaft" />
        </g>
        <text x={2.5 * P} y={1 * P} textAnchor="middle" className={state === "armed" ? "silk tiny esc-state armed" : "silk tiny esc-state"} data-esc-label={state}>
          {ESC_STATE[state] ?? state}
        </text>
        <text x={2.5 * P} y={2.2 * P} textAnchor="middle" className="silk small value">
          {fmt(rpm)} rpm
        </text>
        {(m?.beeps ?? 0) > 0 && (
          <text x={2.5 * P} y={3.4 * P} textAnchor="middle" className="silk tiny esc-label" data-beep="1">
            {t("♪ 삐 ×{n}", { n: m?.beeps ?? 0 })}
          </text>
        )}
        {m?.stalled && (
          <text x={cx} y={-0.4 * P} textAnchor="middle" className="silk small stall on">
            {t("모터가 막힘!")}
          </text>
        )}
        {visual.unpowered && <NoPower x={cx} y={8.4 * P} text={t("배터리 없음")} />}
      </g>
    );
  },
};

// ------------------------------------------------- BLDC with hall sensors

const BLDC_PINS: [string, string, string][] = [
  ["U", "#eab308", t("U (상 1, 노랑)")],
  ["V", "#16a34a", t("V (상 2, 초록)")],
  ["W", "#2563eb", t("W (상 3, 파랑)")],
  ["HA", "#9ca3af", t("HA (홀 A, 오픈 컬렉터: 풀업 필요)")],
  ["HB", "#9ca3af", t("HB (홀 B, 오픈 컬렉터)")],
  ["HC", "#9ca3af", t("HC (홀 C, 오픈 컬렉터)")],
  ["VCC", "#d32f2f", t("VCC (홀 센서 전원 5V)")],
  ["GND", "#222", "GND"],
];
const BLDC_C = { x: 4.5 * P, y: 4 * P };

export const bldcHall: PartDef = {
  kind: "bldc-hall",
  name: t("BLDC 모터 (홀 센서)"),
  category: "actuator",
  description:
    t("3상 BLDC 모터(42BLY 계열, 4극쌍, 12 V에서 약 3300 rpm)와 홀 센서 세 개. 홀 A·B·C(코드 = C B A 비트)가 회전자가 여섯 개의 60° 구간 중 어디 있는지 알려 줍니다: 101 → U+ W−, 001 → V+ W−, 011 → V+ U−, 010 → W+ U−, 110 → W+ V−, 100 → U+ V−. 펌웨어가 홀 인터럽트(EXTI, 양쪽 에지)마다 3상 브리지의 상 하나를 전원에, 하나를 GND에 연결하면(6스텝 정류) 다음 구간으로 끌려가며 돕니다. 표가 틀리거나 홀·상을 바꿔 연결하면 제자리에서 떨거나 멈춥니다. 홀 출력은 오픈 컬렉터라 핀의 풀업(GPIO_PULLUP)이나 10 kΩ 풀업이 필요합니다. U·V·W를 브리지의 OUTA·OUTB·OUTC에, VCC를 5V에."),
  w: 10,
  h: 10,
  pins: BLDC_PINS.map(([id, , label], i) => ({ id, x: 1 + i, y: 10, label })),
  props: { load: 0 },
  ranges: { load: { min: 0, max: 20, step: 0.5, label: t("부하 (브레이크)"), unit: "N·cm" } },
  render: (_props, visual) => bldcBody(visual, true),
};

/** The BLDC's can, rotor, rpm, phase currents and (with sensors) halls. */
function bldcBody(visual: VisualState, withHalls: boolean) {
  const m = visual.motor;
  const angle = visual.angle ?? 0;
  const rpm = visual.rpm ?? 0;
  const halls = visual.text ?? "000";
  const cur = m?.coils ?? [0, 0, 0];
  const { x: cx, y: cy } = BLDC_C;
  return (
    <g data-rpm={rpm.toFixed(0)} data-halls={halls} data-stalled={m?.stalled ? "1" : "0"}>
      {BLDC_PINS.slice(0, withHalls ? BLDC_PINS.length : 3).map(([id, color], i) => (
        <line key={id} x1={(1 + i) * P} y1={8.8 * P} x2={(1 + i) * P} y2={10 * P} stroke={color} strokeWidth={1.2} />
      ))}
      <circle cx={cx} cy={cy} r={3.4 * P} className="bldc-can" />
      <g transform={`rotate(${angle} ${cx} ${cy})`} data-rotor-angle={angle.toFixed(0)}>
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <path
            key={i}
            d={`M ${cx} ${cy} L ${cx + 2.6 * P * Math.sin((i * Math.PI) / 4 - 0.35)} ${cy - 2.6 * P * Math.cos((i * Math.PI) / 4 - 0.35)} A ${2.6 * P} ${2.6 * P} 0 0 1 ${cx + 2.6 * P * Math.sin((i * Math.PI) / 4 + 0.35)} ${cy - 2.6 * P * Math.cos((i * Math.PI) / 4 + 0.35)} Z`}
            className={i % 2 ? "magnet s" : "magnet n"}
          />
        ))}
        <line x1={cx} y1={cy} x2={cx} y2={cy - 3 * P} className="motor-spoke marked" />
        <circle cx={cx} cy={cy} r={0.5 * P} className="motor-shaft" />
      </g>
      <text x={cx} y={-0.4 * P} textAnchor="middle" className="silk small value">
        {fmt(rpm)} rpm
      </text>
      {/* Hall states A, B, C. */}
      {withHalls && ["A", "B", "C"].map((h, i) => {
        const on = halls[i] === "1";
        return (
          <g key={h} data-hall={h} data-level={on ? "1" : "0"}>
            <circle cx={8.6 * P} cy={(1 + i * 1.1) * P} r={0.38 * P} className={on ? "hall-led on" : "hall-led"} />
            <text x={9.4 * P} y={(1.25 + i * 1.1) * P} className="silk tiny">
              H{h}
            </text>
          </g>
        );
      })}
      {["U", "V", "W"].map((ph, i) => (
        <g key={`b${ph}`}>
          <rect x={(7.9 + i * 0.7) * P} y={5.2 * P} width={0.5 * P} height={2.6 * P} className="coil-track" />
          <rect
            x={(7.9 + i * 0.7) * P}
            y={(cur[i] ?? 0) >= 0 ? (6.5 - 1.3 * Math.min(1, cur[i] ?? 0)) * P : 6.5 * P}
            width={0.5 * P}
            height={1.3 * Math.min(1, Math.abs(cur[i] ?? 0)) * P}
            className={(cur[i] ?? 0) >= 0 ? "coil-bar pos" : "coil-bar neg"}
            data-phase={ph}
            data-current={(cur[i] ?? 0).toFixed(2)}
          />
          <text x={(8.15 + i * 0.7) * P} y={8.5 * P} textAnchor="middle" className="silk tiny">
            {ph}
          </text>
        </g>
      ))}
      {m?.stalled && (
        <text x={cx} y={11.2 * P} textAnchor="middle" className="silk small stall on" data-stall="1">
          {withHalls ? t("멈춤! 정류가 홀과 맞지 않음") : t("멈춤! 정류가 회전자와 맞지 않음")}
        </text>
      )}
      {withHalls && visual.unpowered && <NoPower x={cx} y={11.2 * P} text={t("홀 센서 전원 없음")} />}
    </g>
  );
}

// ------------------------------------------------- sensorless BLDC (M28)

export const bldcSensorless: PartDef = {
  kind: "bldc",
  name: t("BLDC 모터 (센서리스)"),
  category: "actuator",
  description:
    t("홀 센서 없는 3상 BLDC 모터(홀 센서 BLDC와 같은 모터: 4극쌍, 상 저항 1 Ω, 12 V에서 약 3300 rpm). 회전자 위치는 역기전력으로 압니다: 6스텝에서 떠 있는 상의 전압은 중성점(별결선 중심) 전압에 그 상의 역기전력을 더한 값이라, 각 60° 구간의 가운데에서 중성점을 지나갑니다(영점). 영점에서 30° 뒤에 정류하면 됩니다. 멈춰 있으면 역기전력이 없어 먼저 한 스텝으로 정렬하고, 열린 루프로 점점 빠르게 정류한 뒤 영점을 따라갑니다. 상마다 10 kΩ/2.2 kΩ 분압기를 ADC 핀에, 세 분압점을 10 kΩ 세 개로 모으면 가상 중성점이 됩니다. U·V·W를 3상 브리지의 OUTA·OUTB·OUTC에."),
  w: 10,
  h: 10,
  pins: BLDC_PINS.slice(0, 3).map(([id, , label], i) => ({ id, x: 1 + i, y: 10, label })),
  props: { load: 0 },
  ranges: { load: { min: 0, max: 20, step: 0.5, label: t("부하 (브레이크)"), unit: "N·cm" } },
  render: (_props, visual) => bldcBody(visual, false),
};

// ---------------------------------------------------- 3-phase bridge

const PH_IN = ["INHA", "INLA", "INHB", "INLB", "INHC", "INLC"];

export const bridge3ph: PartDef = {
  kind: "bridge-3ph",
  name: t("3상 브리지 모듈 (DRV8302 형)"),
  category: "module",
  description:
    t("BLDC용 3상 하프 브리지 모듈. 상마다 하이사이드(INHx: 출력을 PVDD에)와 로사이드(INLx: 출력을 GND에) 스위치 입력이 있고, 둘 다 Low면 출력이 떠 있습니다. 한 상의 INH와 INL을 동시에 High로 하면 전원이 단락(관통 전류, shoot-through)되므로 모듈이 그 상을 끄고 경고합니다. 스위치(MOSFET)가 꺼지는 데 150 ns쯤 걸리므로, 한쪽이 꺼진 뒤 그보다 빨리 다른 쪽이 켜져도 관통 전류입니다 — TIM1 상보 출력(CHx/CHxN)에 데드타임(BDTR.DTG)을 넣는 이유. 입력을 2 kHz 이상 PWM으로 켜고 끄면 주기마다 듀티를 재어 상 전압을 평균(듀티 × PVDD)으로 모터에 주므로 듀티가 곧 토크·속도입니다. 정적인 GPIO로 켜도 됩니다. 막대: 스위치마다 켜져 있던 비율. 입력은 보드에서 풀다운, High는 2 V 이상. PVDD에 6–60 V 모터 전원(DC 전원 부품), GND는 Nucleo와 공통."),
  w: 8,
  h: 9,
  pins: [
    ...PH_IN.map((id, i) => ({ id, x: 0, y: 1 + i, label: `${id} (${id[2] === "H" ? t("하이사이드") : t("로사이드")} ${id[3]})` })),
    { id: "OUTA", x: 8, y: 2, label: "OUTA (→ U)" },
    { id: "OUTB", x: 8, y: 3, label: "OUTB (→ V)" },
    { id: "OUTC", x: 8, y: 4, label: "OUTC (→ W)" },
    { id: "PVDD", x: 5, y: 9, label: t("PVDD (모터 전원 6–60 V)") },
    { id: "GND", x: 6, y: 9, label: "GND" },
  ],
  render: (_props, visual) => {
    const out = visual.motor?.coils ?? [0, 0, 0];
    const duty = visual.motor?.duty ?? [];
    const shoot = visual.motor?.shoot_through ?? false;
    return (
      <g
        data-outputs={out.map((o) => (o > 0.5 ? "H" : o < -0.5 ? "L" : "Z")).join("")}
        data-duty={duty.map((d) => d.toFixed(3)).join(",")}
        data-shoot={shoot ? "1" : "0"}
      >
        <rect x={0.4 * P} y={0.3 * P} width={7.2 * P} height={8.2 * P} rx={0.8} className="drv-pcb bridge3" />
        {PH_IN.map((n, i) => (
          <text key={n} x={0.8 * P} y={(1.25 + i) * P} className="silk tiny drv-label">
            {n}
          </text>
        ))}
        {["A", "B", "C"].map((ph, i) => {
          const s = out[i] ?? 0;
          return (
            <g key={ph} data-phase={ph} data-switch={s > 0.5 ? "H" : s < -0.5 ? "L" : "Z"}>
              <rect x={(4 + i * 1.1) * P} y={1 * P} width={0.8 * P} height={0.8 * P} className={s > 0.5 ? "switch-led on" : "switch-led"} />
              <rect x={(4 + i * 1.1) * P} y={3.4 * P} width={0.8 * P} height={0.8 * P} className={s < -0.5 ? "switch-led low" : "switch-led"} />
              {/* Duty bars: how long each switch was on over the frame. */}
              {[0, 1].map((side) => {
                const d = Math.max(0, Math.min(1, duty[3 * side + i] ?? 0));
                const y = (side === 0 ? 1.9 : 4.3) * P;
                return (
                  <g key={side} data-duty-bar={`${side === 0 ? "H" : "L"}${ph}`} data-value={d.toFixed(3)}>
                    <rect x={(4 + i * 1.1) * P} y={y} width={0.8 * P} height={0.22 * P} className="duty-track" />
                    <rect x={(4 + i * 1.1) * P} y={y} width={0.8 * P * d} height={0.22 * P} className={side === 0 ? "duty-fill" : "duty-fill low"} />
                  </g>
                );
              })}
              <text x={(4.4 + i * 1.1) * P} y={2.95 * P} textAnchor="middle" className="silk tiny drv-label">
                {ph}
              </text>
            </g>
          );
        })}
        <text x={7.2 * P} y={5.4 * P} textAnchor="end" className="silk tiny drv-label">
          {t("H 위 · L 아래 · 막대 듀티")}
        </text>
        <rect x={2.6 * P} y={6} width={2.4 * P} height={1.6 * P} className="chip" transform={`translate(0 ${5.8 * P - 6})`} />
        <text x={3.8 * P} y={6.8 * P} textAnchor="middle" className="silk chip-label">
          3PH
        </text>
        {["PVDD", "GND"].map((n, i) => (
          <text key={n} x={(5 + i) * P} y={8.2 * P} textAnchor="middle" className="silk tiny drv-label">
            {n}
          </text>
        ))}
        {visual.unpowered && <NoPower x={4 * P} y={-0.5 * P} text={t("PVDD 없음")} />}
        {shoot && (
          <g data-shoot-warning="1">
            <rect x={0.6 * P} y={7 * P} width={1.9 * P} height={1.2 * P} rx={0.3} className="shoot-badge" />
            <text x={1.55 * P} y={7.8 * P} textAnchor="middle" className="silk tiny shoot-text">
              {t("관통!")}
            </text>
          </g>
        )}
      </g>
    );
  },
};
