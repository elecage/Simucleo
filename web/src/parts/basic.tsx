import { PITCH, type PartDef } from "./types";

const LED_COLORS: Record<string, string> = {
  red: "#ff2a2a", green: "#2aff5a", yellow: "#ffe02a", blue: "#3a7bff", white: "#ffffff",
};

export const led5mm: PartDef = {
  kind: "led-5mm",
  name: "LED 5mm",
  category: "output",
  w: 1,
  h: 3,
  pins: [
    { id: "A", x: 1, y: 3, label: "Anode (+)" },
    { id: "K", x: 0, y: 3, label: "Cathode (−)" },
  ],
  props: { color: "red" },
  render: (props, visual) => {
    const color = LED_COLORS[String(props.color)] ?? LED_COLORS.red;
    const b = visual.burnt ? 0 : visual.brightness ?? 0;
    return (
      <g>
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
  "220": ["red", "red", "brown"],
  "330": ["orange", "orange", "brown"],
  "1k": ["brown", "black", "red"],
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
      <circle cx={1.5 * PITCH} cy={PITCH} r={(visual.pressed ? 0.7 : 0.8) * PITCH} className="btn-cap" />
    </g>
  ),
};
