// Analog inputs and actuators (M5): potentiometer, LDR, temperature sensor,
// servo, DC motor with driver. Their electrical models live in
// `simucleo_circuit::sim`; the live inputs (knob position, light, temperature)
// are part properties, adjustable on the canvas or in the inspector.
import { FINGER_C, fingerTouch, holdValues, rotaryKnob, slideHandle, type Slide } from "./controls";
import { Fingertip } from "./feedback";
import { PITCH, type PartDef } from "./types";
import { t } from "../i18n";

const P = PITCH;

/** Grey label shown on a part whose supply is too low. */
const NoPower = ({ x, y }: { x: number; y: number }) => (
  <text x={x} y={y} textAnchor="middle" className="silk small unpowered" data-unpowered="1">
    {t("전원 부족")}
  </text>
);

/** SVG arc around (cx, cy) from angle a0 to a1 (degrees clockwise from 12 o'clock). */
function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const pt = (a: number) => `${cx + Math.sin((a * Math.PI) / 180) * r} ${cy - Math.cos((a * Math.PI) / 180) * r}`;
  return `M ${pt(a0)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${pt(a1)}`;
}

/** A clockwise arrowhead at angle `a` on the circle of `arc`. */
function arrowHead(cx: number, cy: number, r: number, a: number): string {
  const rad = (a * Math.PI) / 180;
  const [x, y] = [cx + Math.sin(rad) * r, cy - Math.cos(rad) * r];
  // Tangent (clockwise) and outward normal.
  const [tx, ty] = [Math.cos(rad), Math.sin(rad)];
  const [nx, ny] = [Math.sin(rad), -Math.cos(rad)];
  const k = 0.45 * P;
  return `M ${x + tx * k} ${y + ty * k} L ${x + nx * k * 0.7} ${y + ny * k * 0.7} L ${x - nx * k * 0.7} ${y - ny * k * 0.7} Z`;
}

/** Knob centre of the potentiometer (part units). */
const POT_CX = P,
  POT_CY = 1.1 * P;

export const potentiometer: PartDef = {
  kind: "potentiometer",
  name: t("가변저항"),
  category: "input",
  description:
    t("양 끝(1, 2)을 3V3와 GND에, 가운데(W, 와이퍼)를 아날로그 핀(A0 등)에 연결. 노브를 잡고 돌리거나(270°) 노브 위에서 마우스 휠을 굴려 돌립니다. 몸체 아래쪽을 끌면 옮겨집니다."),
  w: 2,
  h: 3,
  pins: [
    { id: "1", x: 0, y: 3, label: t("1 (한쪽 끝)") },
    { id: "W", x: 1, y: 3, label: t("W (와이퍼, 가운데)") },
    { id: "2", x: 2, y: 3, label: t("2 (다른 쪽 끝)") },
  ],
  props: { ohms: "10k", position: 0.5 },
  propOptions: { ohms: ["1k", "10k", "100k"] },
  ranges: { position: { min: 0, max: 1, step: 0.01, label: t("노브 위치"), unit: "" } },
  controls: { knob: rotaryKnob("position", POT_CX, POT_CY) },
  render: (props, visual) => {
    const pos = Math.min(1, Math.max(0, Number(props.position)));
    const deg = -135 + 270 * pos;
    const [cx, cy] = [POT_CX, POT_CY];
    return (
      <g>
        {[0, 1, 2].map((i) => (
          <line key={i} x1={i * P} y1={2 * P} x2={i * P} y2={3 * P} className="lead" />
        ))}
        <rect x={-0.4 * P} y={0} width={2.8 * P} height={2.2 * P} rx={3} className="pot-body" />
        {/* The 270° travel, filled up to the wiper. */}
        <path d={arc(cx, cy, 1.05 * P, -135, 135)} className="pot-track" />
        {pos > 0.002 && <path d={arc(cx, cy, 1.05 * P, -135, deg)} className="pot-fill" />}
        <g data-drag="knob" className={visual.control === "knob" ? "knob turning" : "knob"} data-angle={deg.toFixed(0)}>
          <circle cx={cx} cy={cy} r={0.85 * P} className="pot-knob" />
          <g transform={`rotate(${deg} ${cx} ${cy})`}>
            {/* Grip ridges turn with the knob. */}
            {[45, 135, 225, 315].map((r) => (
              <line key={r} x1={cx} y1={cy - 0.85 * P} x2={cx} y2={cy - 0.62 * P} className="pot-ridge" transform={`rotate(${r} ${cx} ${cy})`} />
            ))}
            <line x1={cx} y1={cy - 0.1 * P} x2={cx} y2={cy - 0.78 * P} className="pot-mark" />
          </g>
        </g>
        <text x={P} y={-0.3 * P} textAnchor="middle" className="silk small value" data-position={pos.toFixed(2)}>
          {Math.round(pos * 100)}%
        </text>
      </g>
    );
  },
};

/** Top of the LDR's head (part units): distances to the lamp start here. */
const LDR_FACE = -0.15 * P;
/** Lamp distance (grid steps) ↔ illuminance: inverse square, 10000 lux nearest. */
const LAMP_NEAR = 0.6,
  LAMP_FAR = 6;
const LAMP: Slide = {
  min: LAMP_NEAR,
  max: LAMP_FAR,
  toValue: (d) => Math.round(10000 * (LAMP_NEAR / d) ** 2),
  fromValue: (lux) => Math.min(LAMP_FAR, Math.max(LAMP_NEAR, LAMP_NEAR * Math.sqrt(10000 / Math.max(1, lux)))),
};

export const ldr: PartDef = {
  kind: "ldr",
  name: t("조도센서 (LDR)"),
  category: "sensor",
  description:
    t("빛이 밝을수록 저항이 작아집니다 (10 lux에서 약 10 kΩ). 고정 저항과 분압기로 묶어 아날로그 핀에 연결하세요. 위의 손전등을 끌어 가까이 대면 밝아지고(거리의 제곱에 반비례, 약 100–10000 lux) ✋를 누르고 있으면 손으로 가려 어두워집니다(약 5 lux)."),
  w: 1,
  h: 3,
  pins: [
    { id: "1", x: 0, y: 3, label: "1" },
    { id: "2", x: 1, y: 3, label: "2" },
  ],
  props: { lux: 300 },
  ranges: { lux: { min: 1, max: 10000, step: 1, label: t("밝기"), unit: "lux", log: true } },
  controls: {
    lamp: slideHandle("lux", LDR_FACE, LAMP, t("손전등을 위아래로 끌어 보세요 — 센서에 가까울수록 밝아집니다 (거리의 제곱에 반비례).")),
    cover: holdValues({ lux: 5 }, t("누르고 있는 동안 손으로 센서를 가립니다 (약 5 lux).")),
  },
  render: (props, visual) => {
    const lux = Number(props.lux) || 0;
    const glow = Math.min(1, Math.log10(Math.max(1, lux)) / 4);
    const covered = visual.control === "cover";
    // The lamp: as far away as the light allows (the far end when dimmer).
    const d = LAMP.fromValue(lux);
    const lens = LDR_FACE - d * P;
    const beam = Math.min(1, Math.max(0.08, Math.log10(Math.max(1, lux)) / 4));
    const cx = 0.5 * P;
    return (
      <g>
        {/* Light cone from the lamp to the sensor. */}
        <path
          d={`M ${cx - 0.35 * P} ${lens} L ${cx + 0.35 * P} ${lens} L ${cx + 1.1 * P} ${LDR_FACE + 0.4 * P} L ${cx - 1.1 * P} ${LDR_FACE + 0.4 * P} Z`}
          className="lamp-beam"
          opacity={0.55 * beam}
        />
        <g data-drag="lamp" className={visual.control === "lamp" ? "lamp held" : "lamp"} data-distance={d.toFixed(2)}>
          <rect x={cx - 0.45 * P} y={lens - 2.2 * P} width={0.9 * P} height={1.5 * P} rx={1.5} className="lamp-handle" />
          <path d={`M ${cx - 0.45 * P} ${lens - 0.7 * P} L ${cx + 0.45 * P} ${lens - 0.7 * P} L ${cx + 0.6 * P} ${lens} L ${cx - 0.6 * P} ${lens} Z`} className="lamp-head" />
          <rect x={cx - 0.55 * P} y={lens - 0.12 * P} width={1.1 * P} height={0.24 * P} className="lamp-lens" opacity={0.4 + 0.6 * beam} />
          {/* Easier to grab than the thin flashlight. */}
          <rect x={cx - 0.9 * P} y={lens - 2.4 * P} width={1.8 * P} height={2.5 * P} fill="transparent" />
        </g>
        <text x={cx + 0.9 * P} y={lens - 0.9 * P} className="silk small value" data-lux={Math.round(lux)}>
          {lux >= 1000 ? `${(lux / 1000).toFixed(1)}k` : Math.round(lux)} lux
        </text>
        <line x1={0} y1={1.3 * P} x2={0} y2={3 * P} className="lead" />
        <line x1={P} y1={1.3 * P} x2={P} y2={3 * P} className="lead" />
        {glow > 0 && <circle cx={cx} cy={0.6 * P} r={1.4 * P} fill="#fde047" opacity={0.45 * glow} pointerEvents="none" />}
        <circle cx={cx} cy={0.6 * P} r={0.75 * P} className="ldr-body" />
        <path
          d={`M ${0.05 * P} ${0.6 * P} q ${0.15 * P} -${0.4 * P} ${0.3 * P} 0 t ${0.3 * P} 0 t ${0.3 * P} 0`}
          className="ldr-track"
        />
        {covered && <ellipse cx={cx} cy={0.4 * P} rx={1.3 * P} ry={1.1 * P} className="hand-cover" />}
        <g data-drag="cover" className={covered ? "cover-button held" : "cover-button"}>
          <circle cx={2 * P} cy={0.6 * P} r={0.6 * P} />
          <text x={2 * P} y={0.85 * P} textAnchor="middle">
            ✋
          </text>
        </g>
      </g>
    );
  },
};

export const tempSensor: PartDef = {
  kind: "temp-sensor",
  name: t("아날로그 온도센서"),
  category: "sensor",
  description:
    t("TMP36: 출력 0.5 V + 10 mV/°C, 2.7 V 이상에서 동작 (3V3 가능). LM35: 10 mV/°C, 4 V 이상 필요 (5V에 연결). 평평한 면을 보고 왼쪽부터 VS, OUT, GND. 센서를 누르고 있으면 손가락 체온(약 {finger} °C)으로 몇 초에 걸쳐 데워지고, 떼면 원래 온도로 식습니다.", { finger: FINGER_C }),
  w: 2,
  h: 3,
  pins: [
    { id: "VS", x: 0, y: 3, label: t("VS (+전원)") },
    { id: "OUT", x: 1, y: 3, label: t("OUT (전압 출력)") },
    { id: "GND", x: 2, y: 3, label: "GND" },
  ],
  props: { model: "TMP36", temp: 25 },
  propOptions: { model: ["TMP36", "LM35"] },
  ranges: { temp: { min: -40, max: 125, step: 0.5, label: t("온도"), unit: "°C" } },
  controls: { touch: fingerTouch("temp") },
  render: (props, visual) => (
    <g data-drag="touch" data-temp={Number(props.temp)}>
      {[0, 1, 2].map((i) => (
        <line key={i} x1={i * P} y1={1.2 * P} x2={i * P} y2={3 * P} className="lead" />
      ))}
      {/* TO-92: flat face towards the viewer */}
      <path d={`M ${-0.4 * P} ${1.3 * P} V ${0.4 * P} A ${1.4 * P} ${1.1 * P} 0 0 1 ${2.4 * P} ${0.4 * P} V ${1.3 * P} Z`} className="to92" />
      <text x={P} y={1.05 * P} textAnchor="middle" className="to92-label">
        {String(props.model)}
      </text>
      {visual.control === "touch" && <Fingertip x={P} y={0.7 * P} />}
      <text x={P} y={-0.5 * P} textAnchor="middle" className="silk small value">
        {Number(props.temp)} °C
      </text>
      {visual.unpowered && <NoPower x={P} y={4.1 * P} />}
    </g>
  ),
};

export const servo: PartDef = {
  kind: "servo",
  name: t("서보 모터"),
  category: "actuator",
  description:
    t("SG90 계열. 갈색 GND, 빨강 V+(5V), 주황 SIG(PWM). 50 Hz에서 펄스 폭 0.5 ms = 0°, 1.5 ms = 90°, 2.5 ms = 180°."),
  w: 4,
  h: 5,
  pins: [
    { id: "GND", x: 1, y: 5, label: t("GND (갈색)") },
    { id: "V+", x: 2, y: 5, label: t("V+ (빨강, 5V)") },
    { id: "SIG", x: 3, y: 5, label: t("SIG (주황, PWM)") },
  ],
  render: (_props, visual) => {
    const angle = visual.angle ?? 90;
    // 0° points left, 180° right (horn seen from above).
    const rot = angle - 90;
    return (
      <g data-angle={angle.toFixed(1)}>
        <line x1={P} y1={3.6 * P} x2={P} y2={5 * P} stroke="#7c4a1e" strokeWidth={1.4} />
        <line x1={2 * P} y1={3.6 * P} x2={2 * P} y2={5 * P} stroke="#d32f2f" strokeWidth={1.4} />
        <line x1={3 * P} y1={3.6 * P} x2={3 * P} y2={5 * P} stroke="#f57c00" strokeWidth={1.4} />
        <rect x={0} y={0.8 * P} width={4 * P} height={2.8 * P} rx={3} className="servo-body" />
        {/* Protractor: 0° left, 90° up, 180° right; swept part shaded. */}
        <path d={arc(1.2 * P, 1.8 * P, 2.15 * P, -90, 90)} className="servo-scale" />
        {angle > 0.5 && (
          <path d={`${arc(1.2 * P, 1.8 * P, 2.15 * P, -90, angle - 90)} L ${1.2 * P} ${1.8 * P} Z`} className="servo-sweep" />
        )}
        {[0, 45, 90, 135, 180].map((t) => (
          <line
            key={t}
            x1={1.2 * P}
            y1={1.8 * P - 2.0 * P}
            x2={1.2 * P}
            y2={1.8 * P - 2.35 * P}
            className="servo-tick"
            transform={`rotate(${t - 90} ${1.2 * P} ${1.8 * P})`}
          />
        ))}
        <circle cx={1.2 * P} cy={1.8 * P} r={0.8 * P} className="servo-hub" />
        <g transform={`rotate(${rot} ${1.2 * P} ${1.8 * P})`}>
          <path
            d={`M ${1.2 * P} ${1.8 * P - 0.35 * P} L ${1.2 * P} ${1.8 * P + 0.35 * P} L ${1.2 * P - 1.9 * P} ${1.8 * P + 0.15 * P} L ${1.2 * P - 1.9 * P} ${1.8 * P - 0.15 * P} Z`}
            className="servo-horn"
            transform={`rotate(90 ${1.2 * P} ${1.8 * P})`}
          />
        </g>
        <text x={2.9 * P} y={2.4 * P} textAnchor="middle" className="servo-label">
          {Math.round(angle)}°
        </text>
        {visual.unpowered && <NoPower x={2 * P} y={0.4 * P} />}
      </g>
    );
  },
};

export const dcMotor: PartDef = {
  kind: "dc-motor",
  name: t("DC 모터 (드라이버 포함)"),
  category: "actuator",
  description:
    t("H-브리지 드라이버 모듈(L9110S 계열)이 달린 기어드 DC 모터. IA에 PWM, IB를 LOW로 두면 정방향, 반대면 역방향. VCC는 5V."),
  w: 4,
  h: 5,
  pins: [
    { id: "IA", x: 0, y: 5, label: t("IA (정방향 입력)") },
    { id: "IB", x: 1, y: 5, label: t("IB (역방향 입력)") },
    { id: "VCC", x: 2, y: 5, label: "VCC (5V)" },
    { id: "GND", x: 3, y: 5, label: "GND" },
  ],
  render: (_props, visual) => {
    const angle = visual.angle ?? 0;
    const rpm = visual.rpm ?? 0;
    return (
      <g data-rpm={rpm.toFixed(0)}>
        {[0, 1, 2, 3].map((i) => (
          <line key={i} x1={i * P} y1={4 * P} x2={i * P} y2={5 * P} className="lead" />
        ))}
        <rect x={-0.4 * P} y={3.2 * P} width={3.8 * P} height={0.9 * P} rx={2} className="driver-board" />
        <circle cx={1.5 * P} cy={1.5 * P} r={1.5 * P} className="motor-can" />
        <g transform={`rotate(${angle} ${1.5 * P} ${1.5 * P})`}>
          {[0, 120, 240].map((a) => (
            <line
              key={a}
              x1={1.5 * P}
              y1={1.5 * P}
              x2={1.5 * P}
              y2={0.35 * P}
              className="motor-spoke"
              transform={`rotate(${a} ${1.5 * P} ${1.5 * P})`}
            />
          ))}
          {/* One marked spoke: the turning reads even when slow. */}
          <line x1={1.5 * P} y1={1.5 * P} x2={1.5 * P} y2={0.35 * P} className="motor-spoke marked" />
          <circle cx={1.5 * P} cy={0.55 * P} r={0.22 * P} className="motor-dot" />
          <circle cx={1.5 * P} cy={1.5 * P} r={0.3 * P} className="motor-shaft" />
        </g>
        {Math.abs(rpm) > 1 && (
          // Direction arrow around the can, stronger the faster it turns.
          <g className="motor-dir" opacity={0.3 + 0.7 * Math.min(1, Math.abs(rpm) / 150)} data-dir={rpm > 0 ? "cw" : "ccw"}>
            <g transform={rpm > 0 ? undefined : `translate(${3 * P} 0) scale(-1 1)`}>
              <path d={arc(1.5 * P, 1.5 * P, 1.85 * P, 25, 115)} className="motor-arrow" />
              <path d={arrowHead(1.5 * P, 1.5 * P, 1.85 * P, 115)} className="motor-arrow-head" />
            </g>
          </g>
        )}
        <text x={1.5 * P} y={-0.4 * P} textAnchor="middle" className="silk small value">
          {Math.round(rpm)} rpm
        </text>
        {visual.unpowered && <NoPower x={1.5 * P} y={1.6 * P} />}
      </g>
    );
  },
};
