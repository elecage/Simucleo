// Analog inputs and actuators (M5): potentiometer, LDR, temperature sensor,
// servo, DC motor with driver. Their electrical models live in
// `simucleo_circuit::sim`; the live inputs (knob position, light, temperature)
// are part properties, adjustable on the canvas or in the inspector.
import { PITCH, type PartDef } from "./types";

const P = PITCH;

/** Grey label shown on a part whose supply is too low. */
const NoPower = ({ x, y }: { x: number; y: number }) => (
  <text x={x} y={y} textAnchor="middle" className="silk small unpowered" data-unpowered="1">
    전원 부족
  </text>
);

export const potentiometer: PartDef = {
  kind: "potentiometer",
  name: "가변저항",
  category: "input",
  description: "양 끝(1, 2)을 3V3와 GND에, 가운데(W, 와이퍼)를 아날로그 핀(A0 등)에 연결. 노브를 위아래로 끌어 돌립니다.",
  w: 2,
  h: 3,
  pins: [
    { id: "1", x: 0, y: 3, label: "1 (한쪽 끝)" },
    { id: "W", x: 1, y: 3, label: "W (와이퍼, 가운데)" },
    { id: "2", x: 2, y: 3, label: "2 (다른 쪽 끝)" },
  ],
  props: { ohms: "10k", position: 0.5 },
  propOptions: { ohms: ["1k", "10k", "100k"] },
  ranges: { position: { min: 0, max: 1, step: 0.01, label: "노브 위치", unit: "" } },
  render: (props) => {
    const pos = Math.min(1, Math.max(0, Number(props.position)));
    const a = ((-135 + 270 * pos) * Math.PI) / 180;
    const cx = P,
      cy = 1.1 * P;
    return (
      <g>
        {[0, 1, 2].map((i) => (
          <line key={i} x1={i * P} y1={2 * P} x2={i * P} y2={3 * P} className="lead" />
        ))}
        <rect x={-0.4 * P} y={0} width={2.8 * P} height={2.2 * P} rx={3} className="pot-body" />
        <g data-drag-prop="position" data-min="0" data-max="1" className="knob">
          <circle cx={cx} cy={cy} r={0.85 * P} className="pot-knob" />
          <line x1={cx} y1={cy} x2={cx + Math.sin(a) * 0.75 * P} y2={cy - Math.cos(a) * 0.75 * P} className="pot-mark" />
        </g>
        <text x={P} y={-0.3 * P} textAnchor="middle" className="silk small value" data-position={pos.toFixed(2)}>
          {Math.round(pos * 100)}%
        </text>
      </g>
    );
  },
};

export const ldr: PartDef = {
  kind: "ldr",
  name: "조도센서 (LDR)",
  category: "sensor",
  description: "빛이 밝을수록 저항이 작아집니다 (10 lux에서 약 10 kΩ). 고정 저항과 분압기로 묶어 아날로그 핀에 연결하세요.",
  w: 1,
  h: 3,
  pins: [
    { id: "1", x: 0, y: 3, label: "1" },
    { id: "2", x: 1, y: 3, label: "2" },
  ],
  props: { lux: 300 },
  ranges: { lux: { min: 1, max: 10000, step: 1, label: "밝기", unit: "lux", log: true } },
  render: (props) => {
    const lux = Number(props.lux) || 0;
    const glow = Math.min(1, Math.log10(Math.max(1, lux)) / 4);
    return (
      <g>
        <line x1={0} y1={1.3 * P} x2={0} y2={3 * P} className="lead" />
        <line x1={P} y1={1.3 * P} x2={P} y2={3 * P} className="lead" />
        {glow > 0 && <circle cx={0.5 * P} cy={0.6 * P} r={1.4 * P} fill="#fde047" opacity={0.45 * glow} />}
        <circle cx={0.5 * P} cy={0.6 * P} r={0.75 * P} className="ldr-body" />
        <path
          d={`M ${0.05 * P} ${0.6 * P} q ${0.15 * P} -${0.4 * P} ${0.3 * P} 0 t ${0.3 * P} 0 t ${0.3 * P} 0`}
          className="ldr-track"
        />
        <text x={0.5 * P} y={-0.4 * P} textAnchor="middle" className="silk small value">
          {lux >= 1000 ? `${(lux / 1000).toFixed(1)}k` : Math.round(lux)} lux
        </text>
      </g>
    );
  },
};

export const tempSensor: PartDef = {
  kind: "temp-sensor",
  name: "아날로그 온도센서",
  category: "sensor",
  description:
    "TMP36: 출력 0.5 V + 10 mV/°C, 2.7 V 이상에서 동작 (3V3 가능). LM35: 10 mV/°C, 4 V 이상 필요 (5V에 연결). 평평한 면을 보고 왼쪽부터 VS, OUT, GND.",
  w: 2,
  h: 3,
  pins: [
    { id: "VS", x: 0, y: 3, label: "VS (+전원)" },
    { id: "OUT", x: 1, y: 3, label: "OUT (전압 출력)" },
    { id: "GND", x: 2, y: 3, label: "GND" },
  ],
  props: { model: "TMP36", temp: 25 },
  propOptions: { model: ["TMP36", "LM35"] },
  ranges: { temp: { min: -40, max: 125, step: 0.5, label: "온도", unit: "°C" } },
  render: (props, visual) => (
    <g>
      {[0, 1, 2].map((i) => (
        <line key={i} x1={i * P} y1={1.2 * P} x2={i * P} y2={3 * P} className="lead" />
      ))}
      {/* TO-92: flat face towards the viewer */}
      <path d={`M ${-0.4 * P} ${1.3 * P} V ${0.4 * P} A ${1.4 * P} ${1.1 * P} 0 0 1 ${2.4 * P} ${0.4 * P} V ${1.3 * P} Z`} className="to92" />
      <text x={P} y={1.05 * P} textAnchor="middle" className="to92-label">
        {String(props.model)}
      </text>
      <text x={P} y={-0.5 * P} textAnchor="middle" className="silk small value">
        {Number(props.temp)} °C
      </text>
      {visual.unpowered && <NoPower x={P} y={4.1 * P} />}
    </g>
  ),
};

export const servo: PartDef = {
  kind: "servo",
  name: "서보 모터",
  category: "actuator",
  description:
    "SG90 계열. 갈색 GND, 빨강 V+(5V), 주황 SIG(PWM). 50 Hz에서 펄스 폭 0.5 ms = 0°, 1.5 ms = 90°, 2.5 ms = 180°.",
  w: 4,
  h: 5,
  pins: [
    { id: "GND", x: 1, y: 5, label: "GND (갈색)" },
    { id: "V+", x: 2, y: 5, label: "V+ (빨강, 5V)" },
    { id: "SIG", x: 3, y: 5, label: "SIG (주황, PWM)" },
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
  name: "DC 모터 (드라이버 포함)",
  category: "actuator",
  description:
    "H-브리지 드라이버 모듈(L9110S 계열)이 달린 기어드 DC 모터. IA에 PWM, IB를 LOW로 두면 정방향, 반대면 역방향. VCC는 5V.",
  w: 4,
  h: 5,
  pins: [
    { id: "IA", x: 0, y: 5, label: "IA (정방향 입력)" },
    { id: "IB", x: 1, y: 5, label: "IB (역방향 입력)" },
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
          <circle cx={1.5 * P} cy={1.5 * P} r={0.3 * P} className="motor-shaft" />
        </g>
        <text x={1.5 * P} y={-0.4 * P} textAnchor="middle" className="silk small value">
          {Math.round(rpm)} rpm
        </text>
        {visual.unpowered && <NoPower x={1.5 * P} y={1.6 * P} />}
      </g>
    );
  },
};
