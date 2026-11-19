// Bus modules (M6): I2C and SPI breakouts. Their protocol models live in
// `simucleo_circuit::devices`; each module carries its own pull-ups (I2C)
// and only answers when its VCC is powered.
import { BREATH_RH, FINGER_C, fingerTouch } from "./controls";
import { Fingertip } from "./feedback";
import { PITCH, type PartDef, type VisualState } from "./types";

const P = PITCH;

const NoPower = ({ x, y }: { x: number; y: number }) => (
  <text x={x} y={y} textAnchor="middle" className="silk small unpowered" data-unpowered="1">
    전원 부족
  </text>
);

/** Header pins along the top or bottom edge, with their names on the board. */
function Header({ pins, y, labelY }: { pins: { x: number; name: string }[]; y: number; labelY: number }) {
  return (
    <g>
      {pins.map((p) => (
        <g key={p.name}>
          <rect x={p.x * P - 2} y={y - 2} width={4} height={4} className="header-pin" />
          <text x={p.x * P} y={labelY} textAnchor="middle" className="silk module-label">
            {p.name}
          </text>
        </g>
      ))}
    </g>
  );
}

// ------------------------------------------------------------ OLED screen

const urlCache = new Map<string, string>();

/** PNG data URL of a 128×64 frame (cached: frames repeat while idle). */
function screenUrl(b64: string): string {
  const hit = urlCache.get(b64);
  if (hit) return hit;
  const bits = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const img = ctx.createImageData(128, 64);
  for (let i = 0; i < 128 * 64; i++) {
    const on = (bits[i >> 3] >> (7 - (i & 7))) & 1;
    img.data.set(on ? [190, 236, 255, 255] : [6, 10, 18, 255], i * 4);
  }
  ctx.putImageData(img, 0, 0);
  const url = canvas.toDataURL();
  if (urlCache.size > 64) urlCache.clear();
  urlCache.set(b64, url);
  return url;
}

function litPixels(b64: string): number {
  let n = 0;
  for (const c of atob(b64)) {
    let b = c.charCodeAt(0);
    for (; b; b &= b - 1) n++;
  }
  return n;
}

function OledBody({ visual, pins, label }: { visual: VisualState; pins: { x: number; name: string }[]; label: string }) {
  const w = 12 * P,
    h = 9 * P;
  const screen = visual.screen;
  return (
    <g data-lit={screen ? "1" : "0"} data-pixels={screen ? litPixels(screen) : 0}>
      <rect x={0} y={0} width={w} height={h} rx={3} className="module-pcb" />
      <Header pins={pins} y={0} labelY={0.9 * P} />
      <rect x={0.6 * P} y={2 * P} width={w - 1.2 * P} height={5.6 * P} rx={1} className="oled-glass" />
      {screen ? (
        <image
          href={screenUrl(screen)}
          x={P}
          y={2.3 * P}
          width={10 * P}
          height={5 * P}
          preserveAspectRatio="none"
          style={{ imageRendering: "pixelated" }}
        />
      ) : null}
      <text x={w / 2} y={h - 0.4 * P} textAnchor="middle" className="silk module-label">
        {label}
      </text>
      {visual.unpowered && <NoPower x={w / 2} y={h + P} />}
    </g>
  );
}

const OLED_I2C_PINS = [
  { x: 4, name: "GND" },
  { x: 5, name: "VCC" },
  { x: 6, name: "SCL" },
  { x: 7, name: "SDA" },
];

export const oledI2c: PartDef = {
  kind: "oled-ssd1306",
  name: "OLED 128×64 (I2C)",
  category: "display",
  description:
    "SSD1306 0.96인치 OLED, I2C 주소 0x3C (뒷면 점퍼로 0x3D). VCC는 3V3, SCL/SDA는 D15/D14 (I2C1). 모듈에 풀업 저항이 있습니다.",
  w: 12,
  h: 9,
  pins: OLED_I2C_PINS.map((p) => ({ id: p.name, x: p.x, y: 0, label: p.name })),
  props: { address: "0x3C" },
  propOptions: { address: ["0x3C", "0x3D"] },
  render: (props, visual) => <OledBody visual={visual} pins={OLED_I2C_PINS} label={`SSD1306 ${props.address}`} />,
};

const OLED_SPI_PINS = [
  { x: 3, name: "GND" },
  { x: 4, name: "VCC" },
  { x: 5, name: "D0" },
  { x: 6, name: "D1" },
  { x: 7, name: "RES" },
  { x: 8, name: "DC" },
  { x: 9, name: "CS" },
];

export const oledSpi: PartDef = {
  kind: "oled-ssd1306-spi",
  name: "OLED 128×64 (SPI)",
  category: "display",
  description:
    "SSD1306 OLED의 4선 SPI 버전. D0 = SCK (D13), D1 = MOSI (D11), CS·DC·RES는 아무 GPIO. DC가 High면 데이터, Low면 명령. RES를 Low로 하면 초기화됩니다.",
  w: 12,
  h: 9,
  pins: OLED_SPI_PINS.map((p) => ({
    id: p.name,
    x: p.x,
    y: 0,
    label: { D0: "D0 (SCK)", D1: "D1 (MOSI)", RES: "RES (리셋, Low)", DC: "DC (데이터/명령)", CS: "CS (선택, Low)" }[p.name] ?? p.name,
  })),
  render: (_props, visual) => <OledBody visual={visual} pins={OLED_SPI_PINS} label="SSD1306 SPI" />,
};

// -------------------------------------------------------------------- RTC

const RTC_PINS = [
  { x: 1, name: "SCL" },
  { x: 2, name: "SDA" },
  { x: 3, name: "VCC" },
  { x: 4, name: "GND" },
];

export const rtc: PartDef = {
  kind: "rtc-ds3231",
  name: "RTC 시계 (DS3231)",
  category: "module",
  description:
    "I2C 주소 0x68. 레지스터 0x00–0x06에 초·분·시·요일·일·월·연도가 BCD로 들어 있습니다. 시뮬레이션을 시작한 시각에서 출발하고, 백업 배터리가 있어 보드를 리셋해도 계속 갑니다.",
  w: 6,
  h: 5,
  pins: RTC_PINS.map((p) => ({ id: p.name, x: p.x, y: 5, label: p.name })),
  props: { temp: 25 },
  ranges: { temp: { min: -40, max: 85, step: 0.25, label: "온도", unit: "°C" } },
  render: (_props, visual) => {
    const [date, time] = (visual.text ?? "").split(" ");
    return (
      <g>
        <rect x={0} y={0} width={6 * P} height={5 * P} rx={2} className="module-pcb" />
        <Header pins={RTC_PINS} y={5 * P} labelY={4.3 * P} />
        <circle cx={4.2 * P} cy={1.8 * P} r={1.3 * P} className="coin-cell" />
        <rect x={0.5 * P} y={0.8 * P} width={2 * P} height={1.6 * P} className="chip" />
        <text x={1.5 * P} y={1.8 * P} textAnchor="middle" className="silk chip-label">
          DS3231
        </text>
        {visual.text && (
          <text x={3 * P} y={-0.5 * P} textAnchor="middle" className="silk small value" data-rtc={visual.text}>
            {date} {time}
          </text>
        )}
        {visual.unpowered && <NoPower x={3 * P} y={6.2 * P} />}
      </g>
    );
  },
};

// ------------------------------------------------------------------ AHT20

const AHT_PINS = [
  { x: 0, name: "VCC" },
  { x: 1, name: "GND" },
  { x: 2, name: "SCL" },
  { x: 3, name: "SDA" },
];

export const aht20: PartDef = {
  kind: "aht20",
  name: "온습도 센서 (AHT20)",
  category: "sensor",
  description:
    `I2C 주소 0x38. 0xBE로 보정, 0xAC 0x33 0x00으로 측정을 시작하면 80 ms 뒤 상태 + 습도 20비트 + 온도 20비트 + CRC를 읽을 수 있습니다. 센서를 누르고 있으면 손가락 체온(약 ${FINGER_C} °C)과 입김(습도 ${BREATH_RH} %)으로 값이 오르고, 떼면 원래대로 돌아옵니다.`,
  w: 3,
  h: 4,
  pins: AHT_PINS.map((p) => ({ id: p.name, x: p.x, y: 4, label: p.name === "VCC" ? "VIN (VCC)" : p.name })),
  props: { temp: 25, humidity: 50 },
  ranges: {
    temp: { min: -40, max: 85, step: 0.5, label: "온도", unit: "°C" },
    humidity: { min: 0, max: 100, step: 1, label: "습도", unit: "%" },
  },
  controls: { touch: fingerTouch("temp", "humidity") },
  render: (props, visual) => (
    <g data-drag="touch" data-temp={Number(props.temp)} data-humidity={Number(props.humidity)}>
      <rect x={-0.5 * P} y={0} width={4 * P} height={4 * P} rx={2} className="module-pcb" />
      <Header pins={AHT_PINS} y={4 * P} labelY={3.3 * P} />
      <rect x={0.8 * P} y={0.8 * P} width={1.4 * P} height={1.4 * P} className="chip" />
      <circle cx={1.5 * P} cy={1.5 * P} r={0.3 * P} fill="#555" />
      {visual.control === "touch" && <Fingertip x={1.5 * P} y={1.5 * P} />}
      <text x={1.5 * P} y={-0.5 * P} textAnchor="middle" className="silk small value">
        {Number(props.temp)} °C · {Number(props.humidity)} %
      </text>
      {visual.unpowered && <NoPower x={1.5 * P} y={5.2 * P} />}
    </g>
  ),
};

// ---------------------------------------------------------------- SD card

const SD_PINS = [
  { x: 1, name: "GND" },
  { x: 2, name: "VCC" },
  { x: 3, name: "MISO" },
  { x: 4, name: "MOSI" },
  { x: 5, name: "SCK" },
  { x: 6, name: "CS" },
];

export const sdCard: PartDef = {
  kind: "sd-card",
  name: "SD 카드 모듈",
  category: "module",
  description:
    "SPI 모드 SDHC 카드 (512바이트 블록 주소). VCC는 5V (모듈의 레귤레이터, 3 V 이상), SCK/MISO/MOSI는 D13/D12/D11 (SPI1), CS는 아무 GPIO. 카드 내용은 속성 창에서 디스크 이미지로 내려받거나 넣을 수 있습니다.",
  w: 7,
  h: 6,
  pins: SD_PINS.map((p) => ({ id: p.name, x: p.x, y: 6, label: p.name === "CS" ? "CS (선택, Low)" : p.name })),
  props: { size: 32 },
  propOptions: { size: ["16", "32", "64", "128"] },
  render: (props, visual) => (
    <g>
      <rect x={0} y={0} width={7 * P} height={6 * P} rx={2} className="module-pcb" />
      <Header pins={SD_PINS} y={6 * P} labelY={5.3 * P} />
      <path
        d={`M ${1.2 * P} ${0.4 * P} H ${4.6 * P} L ${5.4 * P} ${1.2 * P} V ${4 * P} H ${1.2 * P} Z`}
        className="sd-slot"
      />
      <text x={3.2 * P} y={2.6 * P} textAnchor="middle" className="silk chip-label">
        SDHC {String(props.size)}MB
      </text>
      <circle
        cx={6.2 * P}
        cy={0.8 * P}
        r={0.35 * P}
        fill={visual.on ? "#ef4444" : "#4b1d1d"}
        data-activity={visual.on ? "1" : "0"}
      />
      {visual.unpowered && <NoPower x={3.5 * P} y={7.2 * P} />}
    </g>
  ),
};
