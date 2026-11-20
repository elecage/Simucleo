// M35: K-type thermocouple amplifier modules on SPI (read only) — a MAX6675
// module and an Adafruit-style MAX31855K breakout, each with its probe on
// the screw terminals (+ yellow, − red). The chips are modelled in
// `simucleo_circuit::thermocouple`.
import type { JSX } from "react";
import { exposure, readingOf, toggle, type TcReading } from "./thermocouple-logic";
import { PITCH, type PartDef, type VisualState } from "./types";
import { t } from "../i18n";

const P = PITCH;

const NoPower = ({ x, y }: { x: number; y: number }) => (
  <text x={x} y={y} textAnchor="middle" className="silk small unpowered" data-unpowered="1">
    {t("전원 부족")}
  </text>
);

/** A lighter's flame and ice water, held to the probe's tip. */
const FLAME_C = 800;
const ICE_C = 0;

const controls = {
  flame: exposure(FLAME_C, 3, 6, t("누르고 있으면 라이터 불꽃(약 {c} °C)으로 끝을 달굽니다 — 떼면 실온으로 식습니다.", { c: FLAME_C })),
  ice: exposure(ICE_C, 2, 8, t("누르고 있으면 끝을 얼음물(0 °C)에 담급니다 — 떼면 실온으로 돌아옵니다.")),
  plug: toggle("unplugged", t("누르면 열전대를 단자에서 뽑거나 다시 꽂습니다 (열림 고장).")),
};

const props = { temp: 25, ambient: 25, unplugged: 0, reversed: "0", short: "none" };
const propOptions = { unplugged: ["0", "1"], reversed: ["0", "1"], short: ["none", "gnd", "vcc"] };
const ranges = {
  temp: { min: -200, max: 1350, step: 0.25, label: t("열전대 끝 온도"), unit: "°C" },
  ambient: { min: -20, max: 70, step: 0.1, label: t("주변(모듈) 온도"), unit: "°C" },
};

const FAULT_TEXT: Record<string, string> = {
  OPEN: t("열림"),
  OC: t("OC 열림"),
  SCG: t("SCG GND 단락"),
  SCV: t("SCV VCC 단락"),
};

/** What the chip will report, under the part. */
function Readout({ r, x, y, word }: { r: TcReading | null; x: number; y: number; word?: string }) {
  if (!r || !word) return null;
  const value = r.hot === null ? r.faults.map((f) => FAULT_TEXT[f]).join(" · ") : `${r.hot.toFixed(2)} °C`;
  const cold = r.cold === undefined ? "" : ` · CJ ${r.cold.toFixed(2)} °C`;
  return (
    <text x={x} y={y} className="silk small value" data-word={word} data-reading={r.hot ?? r.faults.join(",")}>
      SO 0x{word} → {value}
      {cold}
    </text>
  );
}

/**
 * The module body at the origin (`w` × `h` grid steps, header on the left
 * edge), its screw terminals on the right and the probe running to the
 * right from them.
 */
function Module({
  kind,
  label,
  w,
  h,
  pinNames,
  values,
  visual,
}: {
  kind: string;
  label: string;
  w: number;
  h: number;
  pinNames: string[];
  values: Record<string, string | number>;
  visual: VisualState;
}): JSX.Element {
  const unplugged = Number(values.unplugged) === 1;
  const reversed = String(values.reversed) === "1";
  const short = String(values.short ?? "none");
  const temp = Number(values.temp);
  const r = readingOf(kind, visual.text);
  // Terminals: + above, − below.
  const tx = w * P - 1.2 * P;
  const plus = 2 * P,
    minus = 3.4 * P;
  const yellow = "#facc15",
    red = "#dc2626";
  const [atPlus, atMinus] = reversed ? [red, yellow] : [yellow, red];
  // The probe's wires leave from the terminals (a gap when unplugged).
  const gap = unplugged ? 1.6 * P : 0;
  const x0 = w * P + gap;
  const tipX = x0 + 8 * P,
    tipY = 2.7 * P;
  const hot = Math.min(1, Math.max(0, (temp - 40) / 700));
  return (
    <g data-temp={temp} data-unplugged={unplugged ? 1 : 0} data-reversed={reversed ? 1 : 0} data-short={short}>
      <rect x={0} y={0} width={w * P} height={h * P} rx={1} fill="#b91c1c" stroke="#7f1d1d" />
      {pinNames.map((n, i) => (
        <text key={n} x={0.5 * P} y={(1 + i) * P + 1.2} className="silk tiny" style={{ fill: "#fee2e2" }}>
          {n}
        </text>
      ))}
      <rect x={2.2 * P} y={1.6 * P} width={2.2 * P} height={2.6 * P} rx={0.3} className="chip" />
      <text x={3.3 * P} y={3.1 * P} className="silk chip-label" style={{ fontSize: 3 }}>
        {label}
      </text>
      {/* Screw terminal block: click to unplug / plug the probe. */}
      <g data-drag="plug" style={{ cursor: "pointer" }}>
        <rect x={tx} y={1.2 * P} width={1.4 * P} height={3 * P} rx={0.4} fill="#15803d" stroke="#14532d" />
        {[plus, minus].map((y, i) => (
          <g key={y}>
            <circle cx={tx + 0.7 * P} cy={y} r={0.45 * P} fill="#d1d5db" stroke="#6b7280" />
            <line x1={tx + 0.4 * P} y1={y} x2={tx + 1.0 * P} y2={y} stroke="#4b5563" strokeWidth={0.6} />
            <text x={tx - 0.2 * P} y={y + 1.5} textAnchor="end" className="silk tiny" style={{ fill: "#fee2e2" }}>
              {i === 0 ? "+" : "−"}
            </text>
          </g>
        ))}
      </g>
      {/* Probe: two wires twisted into a sheath, the junction at the tip. */}
      <path d={`M ${x0} ${plus} C ${x0 + 2 * P} ${plus} ${x0 + 2 * P} ${tipY} ${x0 + 3 * P} ${tipY}`} stroke={atPlus} strokeWidth={1.2} fill="none" />
      <path d={`M ${x0} ${minus} C ${x0 + 2 * P} ${minus} ${x0 + 2 * P} ${tipY} ${x0 + 3 * P} ${tipY}`} stroke={atMinus} strokeWidth={1.2} fill="none" />
      <rect x={x0 + 3 * P} y={tipY - 0.45 * P} width={5 * P} height={0.9 * P} rx={0.45 * P} fill="#9ca3af" stroke="#4b5563" strokeWidth={0.5} />
      <circle cx={tipX} cy={tipY} r={0.55 * P} fill={`rgb(${150 + 105 * hot}, ${150 - 100 * hot}, ${150 - 120 * hot})`} stroke="#4b5563" strokeWidth={0.5} data-tip="1" />
      {short !== "none" && (
        <g>
          <line x1={tipX} y1={tipY} x2={tipX} y2={tipY - 1.8 * P} stroke="#111827" strokeWidth={0.6} strokeDasharray="1 0.8" />
          <text x={tipX} y={tipY - 2.1 * P} textAnchor="middle" className="silk tiny">
            {short === "gnd" ? t("GND에 닿음") : t("VCC에 닿음")}
          </text>
        </g>
      )}
      {visual.control === "flame" && (
        <path
          d={`M ${tipX} ${tipY + 0.4 * P} c ${-1.2 * P} ${1.2 * P} ${-0.6 * P} ${2.6 * P} 0 ${3 * P} c ${0.6 * P} ${-0.4 * P} ${1.2 * P} ${-1.8 * P} 0 ${-3 * P} z`}
          fill="#f97316"
          opacity={0.85}
          data-flame="1"
        />
      )}
      {visual.control === "ice" && (
        <rect x={tipX - 1.3 * P} y={tipY - 0.9 * P} width={2.6 * P} height={2.2 * P} rx={0.4} fill="#93c5fd" opacity={0.6} data-ice="1" />
      )}
      {/* The things to hold to the tip. */}
      <g data-drag="flame" style={{ cursor: "pointer" }}>
        <rect x={tipX - 3.6 * P} y={tipY + 1.6 * P} width={2.2 * P} height={1.6 * P} rx={0.3} fill="#fff7ed" stroke="#ea580c" strokeWidth={0.5} />
        <text x={tipX - 2.5 * P} y={tipY + 2.75 * P} textAnchor="middle" style={{ fontSize: 6 }}>
          🔥
        </text>
      </g>
      <g data-drag="ice" style={{ cursor: "pointer" }}>
        <rect x={tipX + 1.2 * P} y={tipY + 1.6 * P} width={2.2 * P} height={1.6 * P} rx={0.3} fill="#eff6ff" stroke="#2563eb" strokeWidth={0.5} />
        <text x={tipX + 2.3 * P} y={tipY + 2.75 * P} textAnchor="middle" style={{ fontSize: 6 }}>
          🧊
        </text>
      </g>
      <text x={x0 + 3 * P} y={tipY - 1.0 * P} className="silk small value">
        {temp.toFixed(1)} °C
      </text>
      <Readout r={r} x={0} y={-0.6 * P} word={visual.text} />
      {visual.unpowered && <NoPower x={(w * P) / 2} y={(h + 1.2) * P} />}
    </g>
  );
}

const PROBE_W = 11; // grid steps the probe takes right of the board

export const max6675: PartDef = {
  kind: "max6675",
  name: t("K형 열전대 (MAX6675)"),
  category: "sensor",
  description: t(
    "MAX6675 열전대 앰프 모듈과 K형 열전대(+ 노랑, − 빨강). 읽기 전용 SPI: CS를 Low로 하면 SO에 D15가 나오고 SCK 하강 에지마다 다음 비트(모드 0, 최대 4.3 MHz — 더 빠르면 비트가 한 칸씩 밀려 엉터리 값). 16비트: D15 0, D14–D3 온도(0.25 °C 단위, 0–1023.75 °C), D2 열전대 열림, D1 0, D0 하이 임피던스. 변환에 최대 220 ms 걸리고 CS를 Low로 하면 변환이 멈추므로, 더 자주 읽으면 이전 값이 그대로 나옵니다. 하드웨어 SPI(SPI1 RX 전용이나 2선, D13 SCK, D12 MISO)든 비트뱅잉이든 됩니다. 모듈은 41 µV/°C 직선으로 환산하므로 400 °C 위에서는 높게 읽습니다. 끝을 🔥(라이터)나 🧊(얼음물)에 대 보고, 단자를 누르면 열전대가 빠집니다. short로 GND·VCC 단락, reversed로 극성 반대(온도가 거꾸로 내려감). VCC 3–5 V.",
  ),
  w: 6 + PROBE_W,
  h: 7,
  pins: [
    { id: "VCC", x: 0, y: 1, label: "VCC (3–5.5 V)" },
    { id: "GND", x: 0, y: 2, label: "GND" },
    { id: "SCK", x: 0, y: 3, label: t("SCK (클럭 입력)") },
    { id: "CS", x: 0, y: 4, label: t("CS (Low면 읽기, 변환 멈춤)") },
    { id: "SO", x: 0, y: 5, label: t("SO (데이터 출력 → MISO)") },
  ],
  props,
  propOptions,
  ranges,
  controls,
  render: (values, visual) => <Module kind="max6675" label="MAX6675" w={6} h={6} pinNames={["VCC", "GND", "SCK", "CS", "SO"]} values={values} visual={visual} />,
};

export const max31855: PartDef = {
  kind: "max31855",
  name: t("K형 열전대 (MAX31855K)"),
  category: "sensor",
  description: t(
    "MAX31855K 열전대 앰프 브레이크아웃(VIN 3–5 V 레귤레이터, 3Vo 3.3 V 출력)과 K형 열전대(+ 노랑, − 빨강). 읽기 전용 SPI: CS를 Low로 하고 DO에서 32비트를 SCK 하강 에지마다 하나씩(모드 0, 최대 5 MHz). D31–D18 열전대 온도(부호 있는 14비트, 0.25 °C), D16 고장, D15–D4 칩 안의 냉접점 온도(부호 있는 12비트, 0.0625 °C), D2 SCV(VCC 단락), D1 SCG(GND 단락), D0 OC(열림). 앞의 16비트만 읽어도 됩니다. 변환은 최대 100 ms, CS를 Low로 하면 멈춥니다. 41.276 µV/°C 직선으로 환산하므로 NIST 표와 차이(비선형 오차)가 보입니다 — 특히 0 °C 아래. 끝을 🔥나 🧊에 대 보고, 단자를 누르면 열전대가 빠집니다(OC). short로 GND·VCC 단락, reversed로 극성 반대.",
  ),
  w: 6 + PROBE_W,
  h: 8,
  pins: [
    { id: "VIN", x: 0, y: 1, label: "VIN (3–5 V)" },
    { id: "3Vo", x: 0, y: 2, label: t("3Vo (3.3 V 레귤레이터 출력)") },
    { id: "GND", x: 0, y: 3, label: "GND" },
    { id: "DO", x: 0, y: 4, label: t("DO (데이터 출력 → MISO)") },
    { id: "CS", x: 0, y: 5, label: t("CS (Low면 읽기, 변환 멈춤)") },
    { id: "CLK", x: 0, y: 6, label: t("CLK (클럭 입력)") },
  ],
  props,
  propOptions,
  ranges,
  controls,
  render: (values, visual) => (
    <Module kind="max31855" label="31855K" w={6} h={7} pinNames={["VIN", "3Vo", "GND", "DO", "CS", "CLK"]} values={values} visual={visual} />
  ),
};
