// Timing-sensitive single-wire parts (M7): NeoPixel (WS2812B) chains and
// DHT11/DHT22 sensors. Their decoders live in `simucleo_circuit::devices`.
import { BREATH_RH, FINGER_C, fingerTouch } from "./controls";
import { Fingertip } from "./feedback";
import { PITCH, type PartDef, type VisualState } from "./types";
import { t } from "../i18n";

const P = PITCH;

const NoPower = ({ x, y }: { x: number; y: number }) => (
  <text x={x} y={y} textAnchor="middle" className="silk small unpowered" data-unpowered="1">
    {t("전원 부족")}
  </text>
);

const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;

/** One LED: a 5050 package with the colour it shows (brighter = larger glow). */
function Pixel({ x, y, c, i }: { x: number; y: number; c: number; i: number }) {
  const r = (c >> 16) & 255,
    g = (c >> 8) & 255,
    b = c & 255;
  const level = Math.max(r, g, b) / 255;
  // Show dim colours visibly: scale up to full brightness for the fill.
  const k = level > 0 ? 255 / Math.max(r, g, b) : 0;
  const shown = level > 0 ? `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})` : "#f5f5f5";
  return (
    <g data-led={i} data-color={hex(c)}>
      <rect x={x - 3.2} y={y - 3.2} width={6.4} height={6.4} rx={0.8} className="ws2812" />
      {level > 0 && <circle cx={x} cy={y} r={3 + 4 * level} fill={shown} opacity={0.25 + 0.45 * level} />}
      <circle cx={x} cy={y} r={2.2} fill={shown} />
    </g>
  );
}

function leds(visual: VisualState, n: number): number[] {
  return Array.from({ length: n }, (_, i) => visual.leds?.[i] ?? 0);
}

const pixelPins = (pins: { id: string; x: number; y: number }[]) =>
  pins.map((p) => ({
    ...p,
    label: { VCC: "5V (VCC)", DIN: t("DIN (데이터 입력)"), GND: "GND", DOUT: t("DOUT (데이터 출력 → 다음 NeoPixel의 DIN)") }[p.id] ?? p.id,
  }));

const PIXEL_HINT =
  t("WS2812B: 800 kHz로 LED마다 24비트(G, R, B 순서, 상위 비트 먼저)를 보냅니다. 비트 0은 0.4 µs, 1은 0.8 µs High이고, 50 µs 이상 Low면 표시가 바뀝니다. LED는 처음 24비트씩 갖고 나머지는 DOUT으로 넘기므로, DOUT을 다른 NeoPixel의 DIN에 이으면 한 줄로 이어집니다(앞 부품의 LED 다음 번호부터). VCC는 5V(3.5 V 이상).");

export const neopixelRing: PartDef = {
  kind: "neopixel-ring",
  name: t("NeoPixel 링"),
  category: "output",
  description: PIXEL_HINT,
  w: 10,
  h: 11,
  pins: pixelPins([
    { id: "VCC", x: 4, y: 11 },
    { id: "DIN", x: 5, y: 11 },
    { id: "GND", x: 6, y: 11 },
    { id: "DOUT", x: 7, y: 11 },
  ]),
  props: { count: 12 },
  propOptions: { count: ["12", "16", "24"] },
  render: (props, visual) => {
    const n = Number(props.count) || 12;
    const c = 5 * P,
      R = 3.9 * P;
    return (
      <g data-pixels={n}>
        <circle cx={c} cy={c} r={R + 0.9 * P} className="pixel-pcb" />
        <circle cx={c} cy={c} r={R - 0.9 * P} className="pixel-hole" />
        {leds(visual, n).map((col, i) => {
          const a = (2 * Math.PI * i) / n - Math.PI / 2;
          return <Pixel key={i} i={i} c={col} x={c + R * Math.cos(a)} y={c + R * Math.sin(a)} />;
        })}
        <line x1={4 * P} y1={9.6 * P} x2={4 * P} y2={11 * P} className="lead" />
        <line x1={5 * P} y1={9.6 * P} x2={5 * P} y2={11 * P} className="lead" />
        <line x1={6 * P} y1={9.6 * P} x2={6 * P} y2={11 * P} className="lead" />
        <line x1={7 * P} y1={9.3 * P} x2={7 * P} y2={11 * P} className="lead" />
        {visual.unpowered && <NoPower x={c} y={c + 2} />}
      </g>
    );
  },
};

export const neopixelStrip: PartDef = {
  kind: "neopixel-strip",
  name: t("NeoPixel 스트립 (8)"),
  category: "output",
  description: PIXEL_HINT,
  w: 17,
  h: 3,
  pins: pixelPins([
    { id: "GND", x: 0, y: 1 },
    { id: "DIN", x: 0, y: 2 },
    { id: "VCC", x: 0, y: 3 },
    { id: "DOUT", x: 17, y: 2 },
  ]),
  props: { count: 8 },
  render: (_props, visual) => (
    <g data-pixels={8}>
      <rect x={0.5 * P} y={0.4 * P} width={16.5 * P} height={2.8 * P} rx={2} className="pixel-pcb" />
      {leds(visual, 8).map((col, i) => (
        <Pixel key={i} i={i} c={col} x={(2 + 2 * i) * P} y={1.8 * P} />
      ))}
      {visual.unpowered && <NoPower x={8.5 * P} y={4.5 * P} />}
    </g>
  ),
};

export const neopixelMatrix: PartDef = {
  kind: "neopixel-matrix",
  name: t("NeoPixel 매트릭스 8×8"),
  category: "output",
  description: t("{hint} LED 번호는 줄마다 왼쪽에서 오른쪽(0–7, 8–15, …)입니다.", { hint: PIXEL_HINT }),
  w: 16,
  h: 17,
  pins: pixelPins([
    { id: "VCC", x: 7, y: 17 },
    { id: "DIN", x: 8, y: 17 },
    { id: "GND", x: 9, y: 17 },
    { id: "DOUT", x: 10, y: 17 },
  ]),
  props: { count: 64 },
  render: (_props, visual) => (
    <g data-pixels={64}>
      <rect x={0} y={0} width={16 * P} height={16 * P} rx={2} className="pixel-pcb" />
      {leds(visual, 64).map((col, i) => (
        <Pixel key={i} i={i} c={col} x={(1 + 2 * (i % 8)) * P} y={(1 + 2 * Math.floor(i / 8)) * P} />
      ))}
      {[7, 8, 9, 10].map((x) => (
        <line key={x} x1={x * P} y1={16 * P} x2={x * P} y2={17 * P} className="lead" />
      ))}
      {visual.unpowered && <NoPower x={8 * P} y={18.4 * P} />}
    </g>
  ),
};

export const dht: PartDef = {
  kind: "dht",
  name: t("온습도 센서 (DHT22/DHT11)"),
  category: "sensor",
  description:
    t("단선 통신. MCU가 DATA를 Low로 잡았다 놓으면(DHT22 1 ms 이상, DHT11 18 ms 이상) 센서가 80 µs Low, 80 µs High 후 40비트(습도 16, 온도 16, 체크섬 8)를 보냅니다. 비트마다 50 µs Low 뒤 High가 약 27 µs면 0, 70 µs면 1. 모듈에 10 kΩ 풀업이 있습니다. 센서를 누르고 있으면 손가락 체온(약 {finger} °C)과 입김(습도 {breath} %)으로 값이 오르고, 떼면 원래대로 돌아옵니다.", { finger: FINGER_C, breath: BREATH_RH }),
  w: 4,
  h: 6,
  pins: [
    { id: "VCC", x: 1, y: 6, label: "+ (VCC 3.3–5 V)" },
    { id: "DATA", x: 2, y: 6, label: "OUT (DATA)" },
    { id: "GND", x: 3, y: 6, label: "− (GND)" },
  ],
  props: { model: "DHT22", temp: 25, humidity: 50 },
  propOptions: { model: ["DHT22", "DHT11"] },
  ranges: {
    temp: { min: -40, max: 80, step: 0.1, label: t("온도"), unit: "°C" },
    humidity: { min: 0, max: 100, step: 0.1, label: t("습도"), unit: "%" },
  },
  controls: { touch: fingerTouch("temp", "humidity") },
  render: (props, visual) => {
    const dht11 = props.model === "DHT11";
    return (
      <g data-drag="touch" data-temp={Number(props.temp)} data-humidity={Number(props.humidity)}>
        <rect x={0} y={0} width={4 * P} height={5.3 * P} rx={1.5} className="module-pcb" />
        <rect x={0.5 * P} y={0.3 * P} width={3 * P} height={3.8 * P} rx={1} className={dht11 ? "dht11-body" : "dht22-body"} />
        {Array.from({ length: 5 }, (_, r) =>
          [0, 1, 2].map((c) => (
            <rect key={`${r}-${c}`} x={(0.85 + c * 0.85) * P} y={(0.6 + r * 0.65) * P} width={0.55 * P} height={0.35 * P} className="dht-grille" />
          )),
        )}
        {[1, 2, 3].map((x) => (
          <line key={x} x1={x * P} y1={5.3 * P} x2={x * P} y2={6 * P} className="lead" />
        ))}
        <text x={2 * P} y={4.85 * P} textAnchor="middle" className="silk module-label">
          {String(props.model)}
        </text>
        {visual.control === "touch" && <Fingertip x={2 * P} y={2.2 * P} scale={1.2} />}
        <text x={2 * P} y={-0.5 * P} textAnchor="middle" className="silk small value">
          {Number(props.temp)} °C · {Number(props.humidity)} %
        </text>
        {visual.unpowered && <NoPower x={2 * P} y={7.2 * P} />}
      </g>
    );
  },
};
