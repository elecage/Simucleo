// More parts (M8): 7-segment displays, keypad, rotary encoder, thermistor,
// ultrasonic sensor, DS18B20, I2C character LCD and a stepper motor. Their
// models live in `simucleo_circuit::sim` and `simucleo_circuit::devices`.
import { PITCH, type LcdView, type PartDef, type VisualState } from "./types";

const P = PITCH;

const NoPower = ({ x, y }: { x: number; y: number }) => (
  <text x={x} y={y} textAnchor="middle" className="silk small unpowered" data-unpowered="1">
    전원 부족
  </text>
);

// --------------------------------------------------------- 7-segment

/** Segment outlines of one digit, 4 × 6.4 units, origin top-left. */
function segPath(seg: number, w: number, h: number): string {
  const t = 0.12 * w; // thickness
  const half = h / 2;
  const hz = (y: number) =>
    `M ${t * 1.2} ${y} l ${t / 2} ${-t / 2} h ${w - 3.4 * t} l ${t / 2} ${t / 2} l ${-t / 2} ${t / 2} h ${-(w - 3.4 * t)} Z`;
  const vt = (x: number, y0: number) =>
    `M ${x} ${y0 + t * 1.2} l ${t / 2} ${-t / 2} l ${t / 2} ${t / 2} v ${half - 2.4 * t} l ${-t / 2} ${t / 2} l ${-t / 2} ${-t / 2} Z`;
  switch (seg) {
    case 0:
      return hz(t / 2);
    case 1:
      return vt(w - t, 0);
    case 2:
      return vt(w - t, half - t / 2);
    case 3:
      return hz(h - t / 2);
    case 4:
      return vt(0, half - t / 2);
    case 5:
      return vt(0, 0);
    default:
      return hz(half);
  }
}

function Digit({ x, y, levels, color }: { x: number; y: number; levels: number[]; color: string }) {
  const w = 3 * P,
    h = 5 * P;
  // Multiplexed digits are lit part of the time: boost so they read clearly.
  const op = (b: number) => (b > 0.02 ? 0.35 + 0.65 * Math.min(1, b * 3) : 0.07);
  return (
    <g transform={`translate(${x} ${y}) skewX(-6)`}>
      {[0, 1, 2, 3, 4, 5, 6].map((s) => (
        <path key={s} d={segPath(s, w, h)} fill={color} opacity={op(levels[s] ?? 0)} data-seg={s} />
      ))}
      <circle cx={w + 0.45 * P} cy={h - 0.1 * P} r={0.25 * P} fill={color} opacity={op(levels[7] ?? 0)} data-seg={7} />
    </g>
  );
}

const SEG_COLOR: Record<string, string> = { red: "#ff3b30", green: "#34c759", blue: "#3b82f6", yellow: "#ffd60a", white: "#f5f5f5" };

const SEG_HINT =
  "세그먼트 a–g, dp는 위에서부터 시계 방향(a 위, b 오른쪽 위, c 오른쪽 아래, d 아래, e 왼쪽 아래, f 왼쪽 위, g 가운데)입니다. 세그먼트마다 저항(330–470 Ω)을 다세요.";

export const sevenSegment: PartDef = {
  kind: "seven-segment",
  name: "7세그먼트 (1자리)",
  category: "display",
  description: `${SEG_HINT} 공통 캐소드면 COM을 GND에, 공통 애노드면 3V3에 연결합니다.`,
  w: 4,
  h: 7,
  pins: [
    ...["g", "f", "COM", "a", "b"].map((id, i) => ({ id: i === 2 ? "COM" : id, x: i, y: 0, label: id === "COM" ? "COM (공통)" : `${id} 세그먼트` })),
    ...["e", "d", "COM2", "c", "dp"].map((id, i) => ({ id, x: i, y: 7, label: id === "COM2" ? "COM (공통)" : `${id} 세그먼트` })),
  ],
  buses: [["COM", "COM2"]],
  props: { common: "cathode", color: "red" },
  propOptions: { common: ["cathode", "anode"], color: ["red", "green", "blue", "yellow", "white"] },
  render: (props, visual) => (
    <g data-brightness={(visual.channels ?? []).map((b) => b.toFixed(2)).join(",")}>
      <rect x={-0.5 * P} y={0.3 * P} width={5 * P} height={6.4 * P} rx={1} className="seg-body" />
      <Digit x={0.4 * P} y={0.9 * P} levels={visual.channels ?? []} color={SEG_COLOR[String(props.color)] ?? "#ff3b30"} />
    </g>
  ),
};

export const sevenSegment4: PartDef = {
  kind: "seven-segment-4",
  name: "7세그먼트 (4자리)",
  category: "display",
  description: `${SEG_HINT} 네 자리가 세그먼트 핀을 함께 쓰고 자리마다 공통 핀(D1–D4)이 있어, 한 번에 한 자리씩 빠르게 돌아가며 켜야 합니다(멀티플렉싱).`,
  w: 20,
  h: 8,
  pins: [
    ...["D1", "a", "f", "D2", "D3", "b"].map((id, i) => ({ id, x: 7 + i, y: 0, label: id.startsWith("D") ? `${id} (자리 공통)` : `${id} 세그먼트` })),
    ...["e", "d", "dp", "c", "g", "D4"].map((id, i) => ({ id, x: 7 + i, y: 8, label: id.startsWith("D") ? `${id} (자리 공통)` : `${id} 세그먼트` })),
  ],
  props: { common: "cathode", color: "red" },
  propOptions: { common: ["cathode", "anode"], color: ["red", "green", "blue", "yellow", "white"] },
  render: (props, visual) => {
    const ch = visual.channels ?? [];
    const color = SEG_COLOR[String(props.color)] ?? "#ff3b30";
    return (
      <g data-brightness={ch.map((b) => b.toFixed(2)).join(",")}>
        <rect x={0} y={0.4 * P} width={20 * P} height={7.2 * P} rx={1} className="seg-body" />
        {[0, 1, 2, 3].map((d) => (
          <Digit key={d} x={(1.6 + d * 4.6) * P} y={1.4 * P} levels={ch.slice(d * 8, d * 8 + 8)} color={color} />
        ))}
      </g>
    );
  },
};

// --------------------------------------------------------- keypad

const KEYS = [
  ["1", "2", "3", "A"],
  ["4", "5", "6", "B"],
  ["7", "8", "9", "C"],
  ["*", "0", "#", "D"],
];

export const keypad: PartDef = {
  kind: "keypad-4x4",
  name: "키패드 4×4",
  category: "input",
  description:
    "멤브레인 키패드. 키를 누르면 그 줄(R1–R4)과 칸(C1–C4)이 이어집니다. 줄 하나를 Low로 하고 칸들을 풀업 입력으로 읽는 식으로 스캔하세요. 키를 클릭해 누릅니다.",
  w: 9,
  h: 12,
  pins: [
    ...[1, 2, 3, 4].map((i) => ({ id: `R${i}`, x: i, y: 12, label: `R${i} (줄)` })),
    ...[1, 2, 3, 4].map((i) => ({ id: `C${i}`, x: 4 + i, y: 12, label: `C${i} (칸)` })),
  ],
  render: (_props, visual) => (
    <g>
      <rect x={0} y={0} width={9 * P} height={10.6 * P} rx={2} className="keypad-body" />
      {KEYS.map((row, r) =>
        row.map((k, c) => {
          const down = visual.action === `key:${k}`;
          return (
            <g key={k} data-action={`key:${k}`} data-key={k} className="keypad-key">
              <rect
                x={(0.5 + c * 2.05) * P}
                y={(0.5 + r * 2.45) * P}
                width={1.8 * P}
                height={2.1 * P}
                rx={1.5}
                className={down ? "key-cap down" : "key-cap"}
              />
              <text x={(1.4 + c * 2.05) * P} y={(1.85 + r * 2.45) * P} textAnchor="middle" className="key-label">
                {k}
              </text>
            </g>
          );
        }),
      )}
      <rect x={0.6 * P} y={10.6 * P} width={8 * P} height={1.4 * P} className="ribbon" />
    </g>
  ),
};

// --------------------------------------------------- rotary encoder

export const rotaryEncoder: PartDef = {
  kind: "rotary-encoder",
  name: "로터리 엔코더",
  category: "input",
  description:
    "KY-040 모듈. 한 칸(detent) 돌릴 때마다 CLK와 DT가 한 주기씩 바뀌고, 시계 방향이면 CLK가 먼저 바뀝니다. 타이머 엔코더 모드(TIMx_CH1/CH2)로 세거나 EXTI로 읽으세요. 모듈에 10 kΩ 풀업이 있습니다. ⟲ ⟳를 눌러 돌리고, 손잡이를 누르면 SW가 GND로 연결됩니다.",
  w: 5,
  h: 7,
  pins: ["CLK", "DT", "SW", "+", "GND"].map((id, i) => ({ id, x: i, y: 7, label: id === "+" ? "+ (VCC)" : id })),
  render: (_props, visual) => {
    const a = visual.angle ?? 0;
    return (
      <g data-angle={a}>
        <rect x={-0.5 * P} y={0} width={5 * P} height={6.4 * P} rx={1.5} className="module-pcb" />
        <g data-action="press">
          <circle cx={2 * P} cy={2.8 * P} r={1.9 * P} className="enc-knob" />
          <line
            x1={2 * P}
            y1={2.8 * P}
            x2={2 * P + Math.sin((a * Math.PI) / 180) * 1.6 * P}
            y2={2.8 * P - Math.cos((a * Math.PI) / 180) * 1.6 * P}
            className="enc-mark"
          />
        </g>
        <g data-action="ccw" className="enc-turn">
          <circle cx={-0.1 * P} cy={0.6 * P} r={0.75 * P} />
          <text x={-0.1 * P} y={0.95 * P} textAnchor="middle">⟲</text>
        </g>
        <g data-action="cw" className="enc-turn">
          <circle cx={4.1 * P} cy={0.6 * P} r={0.75 * P} />
          <text x={4.1 * P} y={0.95 * P} textAnchor="middle">⟳</text>
        </g>
        {visual.unpowered && <NoPower x={2 * P} y={8.2 * P} />}
      </g>
    );
  },
};

// ------------------------------------------------------ thermistor

export const thermistor: PartDef = {
  kind: "thermistor",
  name: "서미스터 (NTC)",
  category: "sensor",
  description:
    "온도가 오르면 저항이 줄어드는 NTC. R = R25 · exp(B (1/T − 1/298.15 K)). 고정 저항과 분압기로 묶어 아날로그 핀에서 읽으세요.",
  w: 1,
  h: 3,
  pins: [
    { id: "1", x: 0, y: 3, label: "1" },
    { id: "2", x: 1, y: 3, label: "2" },
  ],
  props: { ohms: "10k", beta: 3950, temp: 25 },
  propOptions: { ohms: ["10k", "100k"] },
  ranges: { temp: { min: -40, max: 125, step: 0.5, label: "온도", unit: "°C" } },
  render: (props) => (
    <g>
      <line x1={0} y1={1.2 * P} x2={0} y2={3 * P} className="lead" />
      <line x1={P} y1={1.2 * P} x2={P} y2={3 * P} className="lead" />
      <ellipse cx={0.5 * P} cy={0.7 * P} rx={0.8 * P} ry={0.7 * P} className="ntc-body" />
      <text x={0.5 * P} y={-0.4 * P} textAnchor="middle" className="silk small value">
        {Number(props.temp)} °C
      </text>
    </g>
  ),
};

// ------------------------------------------------------- HC-SR04

export const ultrasonic: PartDef = {
  kind: "hc-sr04",
  name: "초음파 거리센서",
  category: "sensor",
  description:
    "HC-SR04P(3.3–5 V). TRIG에 10 µs 이상 High 펄스를 주면, ECHO가 소리가 왕복한 시간만큼 High가 됩니다(1 cm당 약 58 µs, 400 cm 넘으면 38 ms). 입력 캡처로 재면 정확합니다.",
  w: 9,
  h: 5,
  pins: ["VCC", "TRIG", "ECHO", "GND"].map((id, i) => ({ id, x: 3 + i, y: 5, label: id })),
  props: { distance: 50 },
  ranges: { distance: { min: 2, max: 450, step: 1, label: "거리", unit: "cm" } },
  render: (props, visual) => (
    <g>
      <rect x={0} y={0} width={9 * P} height={4.4 * P} rx={1} className="module-pcb" />
      {[2, 7].map((cx) => (
        <g key={cx}>
          <circle cx={cx * P} cy={2.1 * P} r={1.7 * P} className="sonar-can" />
          <circle cx={cx * P} cy={2.1 * P} r={1.2 * P} className="sonar-mesh" />
        </g>
      ))}
      <text x={4.5 * P} y={-0.5 * P} textAnchor="middle" className="silk small value">
        {Number(props.distance)} cm
      </text>
      {visual.unpowered && <NoPower x={4.5 * P} y={6.2 * P} />}
    </g>
  ),
};

// ------------------------------------------------------- DS18B20

export const ds18b20: PartDef = {
  kind: "ds18b20",
  name: "디지털 온도센서 (DS18B20)",
  category: "sensor",
  description:
    "1-Wire. DQ를 480 µs 이상 Low로 하면(리셋) 센서가 존재 펄스로 답합니다. 쓰기 슬롯은 짧은 Low(1)·긴 Low(0), 읽기 슬롯에서 0이면 센서가 선을 Low로 잡습니다. SKIP ROM(0xCC) → CONVERT T(0x44) → 750 ms 뒤 READ SCRATCHPAD(0xBE). 변환 전에는 85 °C가 읽힙니다. 모듈에 4.7 kΩ 풀업이 있습니다.",
  w: 3,
  h: 5,
  pins: [
    { id: "GND", x: 0, y: 5, label: "GND" },
    { id: "DQ", x: 1, y: 5, label: "DQ (데이터)" },
    { id: "VDD", x: 2, y: 5, label: "VDD" },
  ],
  props: { temp: 25 },
  ranges: { temp: { min: -55, max: 125, step: 0.0625, label: "온도", unit: "°C" } },
  render: (props, visual) => (
    <g>
      {[0, 1, 2].map((i) => (
        <line key={i} x1={i * P} y1={2.6 * P} x2={i * P} y2={5 * P} className="lead" />
      ))}
      <path d={`M ${-0.4 * P} ${2.7 * P} V ${1 * P} A ${1.4 * P} ${1.1 * P} 0 0 1 ${2.4 * P} ${1 * P} V ${2.7 * P} Z`} className="to92" />
      <text x={P} y={2.3 * P} textAnchor="middle" className="to92-label">
        18B20
      </text>
      <text x={P} y={-0.5 * P} textAnchor="middle" className="silk small value">
        {Number(props.temp)} °C
      </text>
      {visual.unpowered && <NoPower x={P} y={6.2 * P} />}
    </g>
  ),
};

// --------------------------------------------------- character LCD

/** HD44780 ROM A00 glyphs we draw as text (the rest as ASCII). */
function glyph(code: number): string {
  if (code === 0x5c) return "¥";
  if (code === 0x7e) return "→";
  if (code === 0x7f) return "←";
  if (code === 0xdf) return "°";
  if (code === 0xe4) return "µ";
  if (code === 0xf4) return "Ω";
  if (code >= 0x20 && code < 0x7e) return String.fromCharCode(code);
  return code >= 0xa0 ? "▯" : " ";
}

function LcdScreen({ lcd, x, y }: { lcd: LcdView | undefined; x: number; y: number }) {
  const cw = 1.6 * P,
    chh = 2.6 * P;
  const lit = lcd?.backlight ?? false;
  return (
    <g transform={`translate(${x} ${y})`} data-lcd={lcd ? lcd.rows.map((r) => r.map(glyph).join("")).join("\n") : ""}>
      <rect x={-0.4 * P} y={-0.4 * P} width={16 * cw + 0.8 * P} height={2 * chh + 0.8 * P} rx={1} className={lit ? "lcd-glass lit" : "lcd-glass"} />
      {(lcd?.rows ?? []).map((row, r) =>
        row.map((code, c) => {
          const cx = c * cw,
            cy = r * chh;
          const cursor = lcd?.cursor && lcd.cursor[0] === r && lcd.cursor[1] === c;
          if (code < 16) {
            // Custom character from CGRAM: 5 × 8 pixels.
            const base = (code & 7) * 8;
            const px = [];
            for (let yy = 0; yy < 8; yy++) {
              for (let xx = 0; xx < 5; xx++) {
                if ((lcd!.cgram[base + yy] >> (4 - xx)) & 1) {
                  px.push(<rect key={`${yy}-${xx}`} x={cx + xx * 0.28 * P + 0.05 * P} y={cy + yy * 0.29 * P + 0.1 * P} width={0.26 * P} height={0.27 * P} className="lcd-px" />);
                }
              }
            }
            return <g key={`${r}-${c}`}>{px}</g>;
          }
          return (
            <g key={`${r}-${c}`}>
              <text x={cx + 0.75 * P} y={cy + 2.05 * P} textAnchor="middle" className="lcd-char">
                {glyph(code)}
              </text>
              {cursor && <rect x={cx + 0.05 * P} y={cy + 2.2 * P} width={1.4 * P} height={0.2 * P} className="lcd-px" />}
            </g>
          );
        }),
      )}
    </g>
  );
}

export const lcdI2c: PartDef = {
  kind: "lcd-i2c",
  name: "문자 LCD 16×2 (I2C)",
  category: "display",
  description:
    "HD44780 LCD에 PCF8574 I2C 백팩(주소 0x27, 일부는 0x3F). 백팩의 P0 RS, P1 RW, P2 E, P3 백라이트, P4–P7 D4–D7. 4비트 모드로 초기화(0x3, 0x3, 0x3, 0x2)한 뒤 바이트를 두 니블로 보냅니다. VCC는 5V.",
  w: 30,
  h: 12,
  pins: ["GND", "VCC", "SDA", "SCL"].map((id, i) => ({ id, x: 0, y: 4 + i, label: id })),
  props: { address: "0x27" },
  propOptions: { address: ["0x27", "0x3F"] },
  render: (_props, visual) => (
    <g>
      <rect x={0} y={0} width={30 * P} height={11 * P} rx={1.5} className="lcd-pcb" />
      <rect x={-0.5 * P} y={3.4 * P} width={1.8 * P} height={4.2 * P} className="backpack" />
      <LcdScreen lcd={visual.lcd} x={2.4 * P} y={2.6 * P} />
      {visual.unpowered && <NoPower x={15 * P} y={12.2 * P} />}
    </g>
  ),
};

// --------------------------------------------------------- stepper

export const stepper: PartDef = {
  kind: "stepper-28byj48",
  name: "스테퍼 모터 (28BYJ-48)",
  category: "actuator",
  description:
    "5 V 단극 스테퍼 + ULN2003 드라이버 보드. IN1–IN4 중 High인 코일이 켜집니다. 반스텝 순서 1, 1+2, 2, 2+3, 3, 3+4, 4, 4+1을 돌면 출력축이 4096 반스텝에 한 바퀴 돕니다. 반스텝 사이가 약 1 ms보다 짧으면 따라가지 못합니다.",
  w: 12,
  h: 9,
  pins: [
    ...[1, 2, 3, 4].map((i) => ({ id: `IN${i}`, x: 5 + i, y: 9, label: `IN${i}` })),
    { id: "VCC", x: 10, y: 9, label: "+ (5V)" },
    { id: "GND", x: 11, y: 9, label: "− (GND)" },
  ],
  render: (_props, visual: VisualState) => {
    const a = visual.angle ?? 0;
    const b = visual.channels ?? [];
    return (
      <g data-angle={a.toFixed(2)}>
        <circle cx={3 * P} cy={4 * P} r={2.9 * P} className="stepper-can" />
        <circle cx={3 * P} cy={3 * P} r={0.9 * P} className="stepper-hub" />
        <g transform={`rotate(${a} ${3 * P} ${3 * P})`}>
          <rect x={2.75 * P} y={1.2 * P} width={0.5 * P} height={1.8 * P} className="stepper-shaft" />
        </g>
        <rect x={6.4 * P} y={2.5 * P} width={5.2 * P} height={6 * P} rx={1} className="uln-pcb" />
        <rect x={7.2 * P} y={3.3 * P} width={2 * P} height={2.6 * P} className="chip" />
        {[0, 1, 2, 3].map((i) => (
          <circle key={i} cx={10.3 * P} cy={(3.3 + i * 0.9) * P} r={0.3 * P} fill={(b[i] ?? 0) > 0.05 ? "#ef4444" : "#4b1d1d"} opacity={0.4 + 0.6 * Math.min(1, b[i] ?? 0)} />
        ))}
        {visual.unpowered && <NoPower x={6 * P} y={10.2 * P} />}
      </g>
    );
  },
};
