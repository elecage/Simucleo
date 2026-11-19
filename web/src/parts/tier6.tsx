// Tier 6 parts (M13): MPU-6050 motion sensor, MAX7219 LED dot matrix and an
// IR receiver with its NEC remote. Their models live in
// `simucleo_circuit::devices` (Mpu6050, Max7219, IrRemote).
import { PITCH, type MatrixView, type PartDef } from "./types";

const P = PITCH;

const NoPower = ({ x, y }: { x: number; y: number }) => (
  <text x={x} y={y} textAnchor="middle" className="silk small unpowered" data-unpowered="1">
    전원 부족
  </text>
);

// ------------------------------------------------------------ MPU-6050

/** The board's outline turned by roll (about X) and pitch (about Y), seen
 * from above with a little perspective. */
function tiltedBoard(roll: number, pitch: number, cx: number, cy: number, size: number): string {
  const r = (roll * Math.PI) / 180,
    p = (pitch * Math.PI) / 180;
  const corners = [
    [-1, -0.7],
    [1, -0.7],
    [1, 0.7],
    [-1, 0.7],
  ];
  return corners
    .map(([x, y]) => {
      // Screen x to the right, y down, z towards the viewer. Positive roll
      // tips the right edge down, positive pitch the lower edge.
      const x1 = x * Math.cos(r);
      const z1 = -x * Math.sin(r);
      const y1 = y * Math.cos(p);
      const z2 = z1 - y * Math.sin(p);
      const k = 1 / (1 - 0.25 * z2); // nearer edges look bigger
      return `${cx + x1 * size * k},${cy + y1 * size * k}`;
    })
    .join(" ");
}

const MPU_PINS = ["VCC", "GND", "SCL", "SDA"];

export const mpu6050: PartDef = {
  kind: "mpu6050",
  name: "가속도·자이로 (MPU-6050)",
  category: "sensor",
  description:
    "GY-521 모듈. I2C 주소 0x68 (AD0을 High로 하면 0x69). 처음엔 잠자기 상태(PWR_MGMT_1 0x6B = 0x40)라 0x6B에 0을 써서 깨워야 측정값이 나옵니다. 0x3B부터 14바이트: 가속도 X·Y·Z, 온도(°C = 값/340 + 36.53), 자이로 X·Y·Z (빅엔디언 int16). 감도: ±2 g 16384 LSB/g, ±250 °/s 131 LSB/(°/s) (0x1C, 0x1B로 범위 변경). 가운데 기판을 마우스로 끌면 기울어집니다 — 좌우는 roll, 위아래는 pitch, 끄는 동안 그 속도가 자이로 값이 됩니다. 모듈 가장자리를 끌면 옮겨집니다.",
  w: 8,
  h: 9,
  pins: MPU_PINS.map((id, i) => ({ id, x: 2 + i, y: 9, label: id })),
  props: { address: "0x68", roll: 0, pitch: 0, gx: 0, gy: 0, gz: 0, temp: 25 },
  propOptions: { address: ["0x68", "0x69"] },
  ranges: {
    roll: { min: -90, max: 90, step: 1, label: "Roll (X축 기울기)", unit: "°" },
    pitch: { min: -90, max: 90, step: 1, label: "Pitch (Y축 기울기)", unit: "°" },
    gx: { min: -500, max: 500, step: 1, label: "자이로 X", unit: "°/s" },
    gy: { min: -500, max: 500, step: 1, label: "자이로 Y", unit: "°/s" },
    gz: { min: -500, max: 500, step: 1, label: "자이로 Z", unit: "°/s" },
    temp: { min: -40, max: 85, step: 0.5, label: "온도", unit: "°C" },
  },
  render: (props, visual) => {
    const roll = Number(props.roll) || 0,
      pitch = Number(props.pitch) || 0;
    // Where a ball on the board would roll to (the matrix example's dot).
    const bx = 4 * P + Math.sin((roll * Math.PI) / 180) * 2.4 * P;
    const by = 4 * P + Math.sin((pitch * Math.PI) / 180) * 2.4 * P;
    return (
      <g data-roll={roll} data-pitch={pitch}>
        <rect x={0} y={0} width={8 * P} height={8.4 * P} rx={1.5} className="module-pcb" />
        {MPU_PINS.map((name, i) => (
          <text key={name} x={(2 + i) * P} y={8 * P} textAnchor="middle" className="silk module-label">
            {name}
          </text>
        ))}
        <g data-drag-tilt="1" className="imu-pad">
          <circle cx={4 * P} cy={4 * P} r={3.3 * P} className="imu-dial" />
          <line x1={0.9 * P} y1={4 * P} x2={7.1 * P} y2={4 * P} className="imu-axis" />
          <line x1={4 * P} y1={0.9 * P} x2={4 * P} y2={7.1 * P} className="imu-axis" />
          <polygon points={tiltedBoard(roll, pitch, 4 * P, 4 * P, 2.2 * P)} className="imu-board" />
          <rect x={3.4 * P} y={3.4 * P} width={1.2 * P} height={1.2 * P} className="chip" />
          <circle cx={bx} cy={by} r={0.45 * P} className="imu-ball" />
        </g>
        <text x={4 * P} y={-0.5 * P} textAnchor="middle" className="silk small value">
          roll {roll.toFixed(0)}° · pitch {pitch.toFixed(0)}°
        </text>
        {visual.unpowered && <NoPower x={4 * P} y={10.2 * P} />}
      </g>
    );
  },
};

// ------------------------------------------------------------- MAX7219

/** Module width in grid steps. */
const MODULE_W = 8.4;

function MatrixModule({ rows, intensity, x }: { rows: number[]; intensity: number; x: number }) {
  const on = 0.35 + (0.65 * (intensity + 1)) / 16;
  const dots = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const lit = ((rows[r] ?? 0) >> (7 - c)) & 1;
      dots.push(
        <circle
          key={`${r}-${c}`}
          cx={x + (0.7 + c) * P}
          cy={(0.7 + r) * P}
          r={0.4 * P}
          className={lit ? "dot-led lit" : "dot-led"}
          opacity={lit ? on : 1}
        />,
      );
    }
  }
  return (
    <g>
      <rect x={x + 0.1 * P} y={0.1 * P} width={8.2 * P} height={8.2 * P} className="dot-face" />
      {dots}
    </g>
  );
}

export const max7219: PartDef = {
  kind: "max7219",
  name: "LED 도트 매트릭스 (MAX7219)",
  category: "display",
  description:
    "MAX7219 + 8×8 빨간 LED (FC-16 모듈), count로 1–4개를 이어 붙입니다. CS를 Low로 하고 16비트 프레임(주소, 데이터)을 MSB부터 CLK 상승 에지마다 DIN으로 보낸 뒤 CS를 High로 하면 반영됩니다. 하드웨어 SPI(D13 SCK, D11 MOSI)든 GPIO 비트뱅잉이든 됩니다. 여러 개면 마지막 16×N비트가 남고, 먼저 보낸 프레임이 가장 먼 모듈(오른쪽)로 갑니다. 레지스터: 0x1–0x8 줄(위부터, 비트 7이 왼쪽), 0x9 디코드, 0xA 밝기(0–15), 0xB 스캔 한도, 0xC 셧다운(처음엔 꺼져 있음, 1로 켬), 0xF 디스플레이 테스트. VCC는 5V.",
  w: 9,
  h: 9,
  pins: [
    ...["VCC", "GND", "DIN", "CS", "CLK"].map((id, i) => ({ id, x: 0, y: 2 + i, label: id === "CS" ? "CS (LOAD)" : id })),
    // On the input header too: the drawing's width follows `count`.
    { id: "DOUT", x: 0, y: 7, label: "DOUT (체인 출력 — 여러 개는 count로)" },
  ],
  props: { count: 1 },
  propOptions: { count: ["1", "2", "3", "4"] },
  render: (props, visual) => {
    const count = Math.min(4, Math.max(1, Number(props.count) || 1));
    const m: MatrixView | undefined = visual.matrix;
    const rows = m?.rows ?? [];
    return (
      <g data-matrix={rows.map((r) => r.toString(16).padStart(2, "0")).join(",")}>
        <rect x={0} y={0} width={(count * MODULE_W + 0.6) * P} height={8.4 * P} rx={1} className="module-pcb" />
        {Array.from({ length: count }, (_, i) => (
          <MatrixModule key={i} x={(0.3 + i * MODULE_W) * P} rows={rows.slice(i * 8, i * 8 + 8)} intensity={m?.intensity[i] ?? 0} />
        ))}
        {visual.unpowered && <NoPower x={4.5 * P} y={9.6 * P} />}
      </g>
    );
  },
};

// ------------------------------------------------------- IR receiver

/** Remote buttons: [action key, label, column, row]; NEC commands in the description. */
const IR_BUTTONS: [string, string, number, number][] = [
  ["UP", "▲", 1, 0],
  ["LEFT", "◀", 0, 1],
  ["OK", "OK", 1, 1],
  ["RIGHT", "▶", 2, 1],
  ["DOWN", "▼", 1, 2],
  ["1", "1", 0, 3],
  ["2", "2", 1, 3],
  ["3", "3", 2, 3],
  ["4", "4", 0, 4],
  ["5", "5", 1, 4],
  ["6", "6", 2, 4],
  ["7", "7", 0, 5],
  ["8", "8", 1, 5],
  ["9", "9", 2, 5],
  ["*", "*", 0, 6],
  ["0", "0", 1, 6],
  ["#", "#", 2, 6],
];

export const irReceiver: PartDef = {
  kind: "ir-receiver",
  name: "IR 수신기 + 리모컨 (NEC)",
  category: "input",
  description:
    "VS1838B 적외선 수신 모듈과 17키 리모컨. 버튼을 누르면 OUT(평소 High, 10 kΩ 풀업)에 복조된 NEC 프레임이 나옵니다: 9 ms Low, 4.5 ms High, 32비트(주소 0x00, ~주소, 명령, ~명령, 각각 LSB부터; 비트마다 562.5 µs Low 뒤 562.5 µs High = 0, 1687.5 µs High = 1), 마지막 562.5 µs Low. 누르고 있으면 108 ms마다 반복 코드(9 ms Low, 2.25 ms High, 562.5 µs Low). 명령: 1=0x45 2=0x46 3=0x47 4=0x44 5=0x40 6=0x43 7=0x07 8=0x15 9=0x09 *=0x16 0=0x19 #=0x0D ▲=0x18 ◀=0x08 OK=0x1C ▶=0x5A ▼=0x52. 타이머 입력 캡처로 하강 에지 사이 시간을 재면 됩니다.",
  w: 12,
  h: 16,
  pins: [
    { id: "OUT", x: 0, y: 16, label: "OUT (신호, Low 활성)" },
    { id: "GND", x: 1, y: 16, label: "GND" },
    { id: "VCC", x: 2, y: 16, label: "VCC" },
  ],
  render: (_props, visual) => (
    <g>
      {/* Receiver module */}
      <rect x={-0.6 * P} y={10.4 * P} width={3.2 * P} height={5 * P} rx={1} className="module-pcb" />
      <path d={`M ${-0.1 * P} ${12.6 * P} V ${11.4 * P} A ${1.1 * P} ${1.1 * P} 0 0 1 ${2.1 * P} ${11.4 * P} V ${12.6 * P} Z`} className="ir-dome" />
      <circle cx={1.6 * P} cy={14.2 * P} r={0.3 * P} fill={visual.on ? "#ef4444" : "#4b1d1d"} data-ir-active={visual.on ? "1" : "0"} />
      {["S", "−", "+"].map((t, i) => (
        <text key={t} x={i * P} y={15.2 * P} textAnchor="middle" className="silk module-label">
          {t}
        </text>
      ))}
      {visual.text && (
        <text x={1 * P} y={9.8 * P} textAnchor="middle" className="silk small value" data-ir-code={visual.text}>
          {visual.text}
        </text>
      )}
      {/* Remote */}
      <rect x={4 * P} y={0} width={7.6 * P} height={15.4 * P} rx={3} className="remote-body" />
      <circle cx={7.8 * P} cy={0.9 * P} r={0.35 * P} className="remote-led" />
      {IR_BUTTONS.map(([key, label, c, r]) => {
        const down = visual.action === `key:${key}`;
        const cx = (5.6 + c * 2.2) * P,
          cy = (2.4 + r * 1.85) * P;
        return (
          <g key={key} data-action={`key:${key}`} data-key={key} className="keypad-key">
            <circle cx={cx} cy={cy} r={0.8 * P} className={down ? "key-cap down" : "key-cap"} />
            <text x={cx} y={cy + 0.3 * P} textAnchor="middle" className="key-label">
              {label}
            </text>
          </g>
        );
      })}
      {visual.unpowered && <NoPower x={1 * P} y={17.2 * P} />}
    </g>
  ),
};
