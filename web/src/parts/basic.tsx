import { PITCH, type PartDef } from "./types";

const LED_COLORS: Record<string, string> = {
  red: "#ff2a2a", green: "#2aff5a", yellow: "#ffe02a", blue: "#3a7bff", white: "#ffffff",
};

/** Red ring that blinks while a part carries too much current. */
const Overcurrent = ({ cx, cy, r }: { cx: number; cy: number; r: number }) => (
  <circle cx={cx} cy={cy} r={r} className="overcurrent" data-overcurrent="1">
    <title>전류가 너무 큽니다 — 저항을 직렬로 넣으세요</title>
  </circle>
);

export const led5mm: PartDef = {
  kind: "led-5mm",
  name: "LED 5mm",
  category: "output",
  description: "긴 다리(A, +)가 애노드. 저항과 직렬로 연결하세요.",
  w: 1,
  h: 3,
  pins: [
    { id: "A", x: 1, y: 3, label: "Anode (+, 긴 다리)" },
    { id: "K", x: 0, y: 3, label: "Cathode (−, 짧은 다리)" },
  ],
  props: { color: "red" },
  propOptions: { color: ["red", "green", "yellow", "blue", "white"] },
  render: (props, visual) => {
    const color = LED_COLORS[String(props.color)] ?? LED_COLORS.red;
    const b = visual.burnt ? 0 : visual.brightness ?? 0;
    return (
      <g data-brightness={b.toFixed(2)}>
        {visual.overcurrent && <Overcurrent cx={0.5 * PITCH} cy={0.6 * PITCH} r={1.4 * PITCH} />}
        <line x1={0} y1={1.2 * PITCH} x2={0} y2={3 * PITCH} className="lead" />
        <line x1={PITCH} y1={1.2 * PITCH} x2={PITCH} y2={3 * PITCH} className="lead" />
        {b > 0 && <circle cx={0.5 * PITCH} cy={0.6 * PITCH} r={PITCH * (1 + b)} fill={color} opacity={0.35 * b} />}
        <path
          d={`M ${-0.3 * PITCH} ${1.3 * PITCH} V ${0.3 * PITCH} A ${0.8 * PITCH} ${0.8 * PITCH} 0 0 1 ${1.3 * PITCH} ${0.3 * PITCH} V ${1.3 * PITCH} Z`}
          fill={color}
          className={visual.burnt ? "led-body burnt" : "led-body"}
          style={{ opacity: 0.55 + 0.45 * b }}
        />
      </g>
    );
  },
};

// Resistor colour code bands for common values.
const BANDS: Record<string, string[]> = {
  "100": ["brown", "black", "brown"],
  "220": ["red", "red", "brown"],
  "330": ["orange", "orange", "brown"],
  "1k": ["brown", "black", "red"],
  "4.7k": ["yellow", "violet", "red"],
  "10k": ["brown", "black", "orange"],
};
const BAND_HEX: Record<string, string> = {
  black: "#111", brown: "#7a3e12", red: "#d22", orange: "#f80", yellow: "#ee0",
  green: "#2a2", blue: "#24f", violet: "#a3f", grey: "#888", white: "#fff",
};

export const resistor: PartDef = {
  kind: "resistor",
  name: "저항",
  category: "basic",
  w: 4,
  h: 0,
  pins: [
    { id: "1", x: 0, y: 0 },
    { id: "2", x: 4, y: 0 },
  ],
  props: { ohms: "220" },
  propOptions: { ohms: ["100", "220", "330", "1k", "4.7k", "10k"] },
  render: (props) => {
    const bands = BANDS[String(props.ohms)] ?? BANDS["220"];
    return (
      <g>
        <line x1={0} y1={0} x2={4 * PITCH} y2={0} className="lead" />
        <rect x={0.9 * PITCH} y={-0.45 * PITCH} width={2.2 * PITCH} height={0.9 * PITCH} rx={4} className="resistor-body" />
        {[...bands, "gold"].map((c, i) => (
          <rect
            key={i}
            x={(1.2 + i * 0.45) * PITCH} y={-0.45 * PITCH} width={0.22 * PITCH} height={0.9 * PITCH}
            fill={c === "gold" ? "#c9a227" : BAND_HEX[c]}
          />
        ))}
      </g>
    );
  },
};

export const tactSwitch: PartDef = {
  kind: "tact-switch",
  name: "택트 스위치",
  category: "input",
  description: "누르는 동안 위(1a·1b)와 아래(2a·2b)가 연결됩니다. 실행 중 클릭해서 누르세요.",
  w: 3,
  h: 2,
  pins: [
    { id: "1a", x: 0, y: 0 }, { id: "1b", x: 3, y: 0 },
    { id: "2a", x: 0, y: 2 }, { id: "2b", x: 3, y: 2 },
  ],
  buses: [["1a", "1b"], ["2a", "2b"]],
  render: (_props, visual) => (
    <g>
      <rect x={-0.2 * PITCH} y={-0.2 * PITCH} width={3.4 * PITCH} height={2.4 * PITCH} rx={2} className="btn-body" />
      <g data-action="press" className="board-button">
        <circle cx={1.5 * PITCH} cy={PITCH} r={(visual.pressed ? 0.7 : 0.8) * PITCH} className="btn-cap" />
      </g>
    </g>
  ),
};

export const rgbLed: PartDef = {
  kind: "rgb-led",
  name: "RGB LED",
  category: "output",
  description: "R·G·B 각각 저항을 거쳐 연결. 공통 단자(COM)는 캐소드형이면 GND, 애노드형이면 3V3.",
  w: 3,
  h: 3,
  pins: [
    { id: "R", x: 0, y: 3, label: "R" },
    { id: "COM", x: 1, y: 3, label: "COM (공통, 가장 긴 다리)" },
    { id: "G", x: 2, y: 3, label: "G" },
    { id: "B", x: 3, y: 3, label: "B" },
  ],
  props: { common: "cathode" },
  propOptions: { common: ["cathode", "anode"] },
  render: (_props, visual) => {
    const [r, g, b] = visual.channels ?? [0, 0, 0];
    const max = Math.max(r, g, b);
    const mix = `rgb(${Math.round(255 * (0.35 + 0.65 * r))}, ${Math.round(255 * (0.35 + 0.65 * g))}, ${Math.round(255 * (0.35 + 0.65 * b))})`;
    const glow = `rgb(${Math.round(255 * r)}, ${Math.round(255 * g)}, ${Math.round(255 * b)})`;
    return (
      <g data-rgb={[r, g, b].map((x) => x.toFixed(2)).join(",")}>
        {[0, 1, 2, 3].map((i) => (
          <line key={i} x1={i * PITCH} y1={1.4 * PITCH} x2={i * PITCH} y2={3 * PITCH} className="lead" />
        ))}
        {max > 0 && <circle cx={1.5 * PITCH} cy={0.6 * PITCH} r={PITCH * (1.4 + max)} fill={glow} opacity={0.35 * max} />}
        {visual.overcurrent && <Overcurrent cx={1.5 * PITCH} cy={0.6 * PITCH} r={1.8 * PITCH} />}
        <path
          d={`M ${0.4 * PITCH} ${1.5 * PITCH} V ${0.4 * PITCH} A ${1.1 * PITCH} ${1.1 * PITCH} 0 0 1 ${2.6 * PITCH} ${0.4 * PITCH} V ${1.5 * PITCH} Z`}
          fill={max > 0 ? mix : "#e8eef2"}
          className="led-body"
          style={{ opacity: 0.6 + 0.4 * max }}
        />
      </g>
    );
  },
};

/** Sound waves next to a buzzer that is sounding. */
const Waves = ({ x, y }: { x: number; y: number }) => (
  <g className="sound-waves">
    {[1, 2, 3].map((i) => (
      <path key={i} d={`M ${x + i * 3} ${y - i * 3} Q ${x + i * 5} ${y} ${x + i * 3} ${y + i * 3}`} />
    ))}
  </g>
);

function buzzer(kind: string, name: string, description: string): PartDef {
  return {
    kind,
    name,
    category: "output",
    description,
    w: 2,
    h: 3,
    pins: [
      { id: "+", x: 0, y: 3, label: "+ (긴 다리)" },
      { id: "-", x: 2, y: 3, label: "−" },
    ],
    render: (_props, visual) => {
      const on = (visual.on ?? 0) > 0.02;
      return (
        <g data-sounding={on ? "1" : "0"} data-freq={visual.freq ? Math.round(visual.freq) : ""}>
          <line x1={0} y1={1.6 * PITCH} x2={0} y2={3 * PITCH} className="lead" />
          <line x1={2 * PITCH} y1={1.6 * PITCH} x2={2 * PITCH} y2={3 * PITCH} className="lead" />
          <circle cx={PITCH} cy={0.8 * PITCH} r={1.25 * PITCH} className="buzzer-body" />
          <circle cx={PITCH} cy={0.8 * PITCH} r={0.25 * PITCH} className="buzzer-hole" />
          <text x={-0.2 * PITCH} y={-0.2 * PITCH} className="silk small">+</text>
          {on && <Waves x={2.4 * PITCH} y={0.8 * PITCH} />}
          {visual.freq !== undefined && (
            <text x={PITCH} y={-0.7 * PITCH} textAnchor="middle" className="silk small">{Math.round(visual.freq)} Hz</text>
          )}
        </g>
      );
    },
  };
}

export const buzzerActive = buzzer(
  "buzzer-active",
  "능동 부저",
  "전원이 들어오면 스스로 일정한 음을 냅니다 (HIGH = 소리).",
);
export const buzzerPassive = buzzer(
  "buzzer-passive",
  "수동 부저",
  "주파수를 직접 만들어야 소리가 납니다 (PWM/토글). 음높이 = 신호 주파수.",
);
