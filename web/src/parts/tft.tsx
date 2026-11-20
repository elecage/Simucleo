// M35: colour SPI TFT displays — the 1.8" 128×160 ST7735S module (red
// PCB) and the 2.4"/2.8" 240×320 ILI9341 module. The controller model is
// `simucleo_circuit::tft`; the picture comes as RGB565 bytes only when it
// changed (`sim/tftStore.ts`) and is drawn on a <canvas> in the part.
import { useEffect, useRef } from "react";
import { rgb565ToRgba, tftPicture } from "../sim/tftStore";
import { PITCH, type PartDef, type VisualState } from "./types";
import { t } from "../i18n";

const P = PITCH;

const NoPower = ({ x, y }: { x: number; y: number }) => (
  <text x={x} y={y} textAnchor="middle" className="silk small unpowered" data-unpowered="1">
    {t("전원 부족")}
  </text>
);

/** How bright the picture looks with the backlight at `bl` (0–1): barely visible without it. */
export function screenBrightness(bl: number): number {
  return 0.04 + 0.96 * Math.min(1, Math.max(0, bl));
}

/** The panel: a canvas of the controller's picture, scaled to the part. */
function TftScreen({ visual, x, y, w, h, px, py }: { visual: VisualState; x: number; y: number; w: number; h: number; px: number; py: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const tft = visual.tft;
  const lit = !!tft?.lit && !visual.unpowered;
  const version = tft?.version ?? 0;
  const id = tft?.id;
  // Draw only when the picture changed (or the canvas is new).
  const drawn = useRef(-1);
  useEffect(() => {
    const c = canvas.current;
    const pic = id ? tftPicture(id) : undefined;
    if (!c || !lit || !pic || pic.version === drawn.current || pic.pixels.length !== pic.width * pic.height * 2) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const img = ctx.createImageData(pic.width, pic.height);
    rgb565ToRgba(pic.pixels, img.data);
    ctx.putImageData(img, 0, 0);
    drawn.current = pic.version;
  }, [id, lit, version]);
  const bl = tft?.backlight ?? 0;
  const bright = screenBrightness(bl);
  return (
    <g data-tft-lit={lit ? "1" : "0"} data-tft-version={version} data-backlight={bl.toFixed(2)} data-inverted={tft?.inverted ? "1" : "0"}>
      {/* Dark panel; the backlight shows through a display that is off. */}
      <rect x={x} y={y} width={w} height={h} fill={bl > 0.05 && !visual.unpowered ? "#1a1f27" : "#07090c"} />
      <foreignObject x={x} y={y} width={w} height={h} style={{ display: lit ? undefined : "none" }}>
        <canvas
          ref={canvas}
          width={px}
          height={py}
          data-tft-canvas="1"
          style={{ width: "100%", height: "100%", display: "block", imageRendering: "pixelated", filter: bright < 1 ? `brightness(${bright})` : undefined }}
        />
      </foreignObject>
    </g>
  );
}

interface Layout {
  w: number;
  h: number;
  pins: string[];
  /** Screen in the drawing (grid units) and its pixels. */
  screen: { x: number; y: number; w: number; h: number; px: number; py: number };
  pcb: string;
  label: string;
}

function TftBody({ visual, l }: { visual: VisualState; l: Layout }) {
  const s = l.screen;
  return (
    <g>
      <rect x={0} y={0} width={l.w * P} height={l.h * P} rx={2} fill={l.pcb} stroke="#7f1d1d" />
      {l.pins.map((name, i) => (
        <g key={name}>
          <rect x={(2 + i) * P - 2} y={-2} width={4} height={4} className="header-pin" />
          <text x={(2 + i) * P} y={0.6 * P} textAnchor="end" className="silk module-label" transform={`rotate(-90 ${(2 + i) * P} ${0.6 * P})`} dy={1.2}>
            {name}
          </text>
        </g>
      ))}
      <rect x={(s.x - 0.4) * P} y={(s.y - 0.4) * P} width={(s.w + 0.8) * P} height={(s.h + 0.8) * P} rx={0.6} className="oled-glass" />
      <TftScreen visual={visual} x={s.x * P} y={s.y * P} w={s.w * P} h={s.h * P} px={s.px} py={s.py} />
      <text x={(l.w / 2) * P} y={(l.h - 0.5) * P} textAnchor="middle" className="silk module-label">
        {l.label}
      </text>
      {visual.unpowered && <NoPower x={(l.w / 2) * P} y={(l.h + 1) * P} />}
    </g>
  );
}

const ST7735_PINS = ["VCC", "GND", "CS", "RESET", "A0", "SDA", "SCK", "LED"];
const ILI9341_PINS = ["VCC", "GND", "CS", "RESET", "DC", "SDI", "SCK", "LED", "SDO"];

const PIN_LABEL: Record<string, string> = {
  VCC: t("VCC (3.3–5 V, 모듈에 레귤레이터)"),
  CS: t("CS (칩 선택, Low = 선택)"),
  RESET: t("RESET (하드웨어 리셋, Low = 리셋)"),
  A0: t("A0 = D/C (Low = 명령, High = 데이터)"),
  DC: t("DC (Low = 명령, High = 데이터)"),
  SDA: t("SDA = MOSI (D11, 직렬 데이터 입력)"),
  SDI: t("SDI = MOSI (D11, 직렬 데이터 입력)"),
  SDO: t("SDO = MISO (D12, 읽기 데이터 출력)"),
  SCK: t("SCK (D13, 상승 에지에 샘플)"),
  LED: t("LED (백라이트, High = 켜짐, PWM으로 밝기)"),
};

const ST7735_LAYOUT: Layout = {
  w: 13,
  h: 20,
  pins: ST7735_PINS,
  screen: { x: 1.5, y: 4, w: 10, h: 12.5, px: 128, py: 160 },
  pcb: "#b91c1c",
  label: '1.8" ST7735S 128×160',
};

const ILI9341_LAYOUT: Layout = {
  w: 20,
  h: 28,
  pins: ILI9341_PINS,
  screen: { x: 2, y: 4, w: 16, h: 21.3, px: 240, py: 320 },
  pcb: "#b91c1c",
  label: '2.8" ILI9341 240×320 SPI',
};

export const tftSt7735: PartDef = {
  kind: "tft-st7735",
  name: t("컬러 TFT 1.8인치 (ST7735S)"),
  category: "display",
  description: t(
    "1.8인치 128×160 컬러 TFT(빨간 기판) — ST7735S 컨트롤러, 4선 SPI. CS를 Low로 하고 SCK 상승 에지마다 SDA로 MSB부터 바이트를 보냅니다(SPI 모드 0, 하드웨어 SPI1이면 D13 SCK, D11 MOSI). A0(D/C)이 Low면 명령, High면 파라미터·픽셀 데이터. 전원을 켜거나 RESET을 Low로 하면 잠자기·화면 꺼짐 상태라 아무것도 보이지 않습니다: SLPOUT(0x11, 리셋 뒤 120 ms 기다린 다음), COLMOD(0x3A: 0x05 = 16비트 RGB565, 0x06 = 18비트, 0x03 = 12비트), MADCTL(0x36: MY·MX 뒤집기, MV 회전, BGR 색 순서), DISPON(0x29)을 보내야 합니다. 그리기: CASET(0x2A)·RASET(0x2B)로 창을 정하고 RAMWR(0x2C) 뒤 픽셀을 보내면 창 안을 왼쪽→오른쪽, 위→아래로 채우고 끝나면 처음으로 돌아갑니다. INVON/INVOFF(0x21/0x20)는 색 반전, SWRESET(0x01)은 레지스터 초기화(리셋·SLPOUT 뒤 5 ms 동안 명령 무시). 지우지 않은 메모리는 처음에 무작위 잡음입니다. 이 모듈의 패널은 MADCTL 0일 때 위아래가 뒤집혀 있어 보통 MY|MX(0xC0)를 씁니다. tab: black(RGB 패널), red(BGR), green(132×162 메모리, 패널이 2열·1행 안쪽). LED는 백라이트: 연결하지 않으면 화면이 어둡고, PWM 듀티만큼 밝아집니다. VCC는 5V 또는 3V3.",
  ),
  w: ST7735_LAYOUT.w,
  h: ST7735_LAYOUT.h,
  pins: ST7735_PINS.map((id, i) => ({ id, x: 2 + i, y: 0, label: PIN_LABEL[id] ?? id })),
  props: { tab: "black" },
  propOptions: { tab: ["black", "red", "green"] },
  render: (_props, visual) => <TftBody visual={visual} l={ST7735_LAYOUT} />,
};

export const tftIli9341: PartDef = {
  kind: "tft-ili9341",
  name: t("컬러 TFT 2.8인치 (ILI9341)"),
  category: "display",
  description: t(
    "2.4/2.8인치 240×320 컬러 TFT — ILI9341 컨트롤러, 4선 SPI(터치 핀은 없음). 명령은 ST7735S와 같은 계열입니다: CS Low, SCK 상승 에지에 SDI(MOSI)를 MSB부터, DC Low = 명령 / High = 데이터. 리셋 뒤 잠자기·화면 꺼짐: SLPOUT(0x11) → 120 ms → COLMOD(0x3A = 0x55 16비트 또는 0x66 18비트) → MADCTL(0x36) → DISPON(0x29). CASET/RASET/RAMWR(0x2A/0x2B/0x2C)로 창에 픽셀을 채우고, 0x3C는 쓰던 자리에서 이어 씁니다. SDO(MISO)로 읽기: 0xD3(ID4 → 더미, 0x00, 0x93, 0x41), 0x04, 0x09(상태), 0x0A(전원 모드, 켜진 뒤 0x9C), 0x0B, 0x0C, RAMRD(0x2E, 픽셀당 R·G·B 3바이트) — 모두 첫 바이트는 더미. 패널이 좌우로 뒤집혀 붙어 있고 BGR이라 보통 MADCTL 0x48(MX|BGR)을 씁니다. LED는 백라이트(High = 켜짐, PWM으로 밝기). VCC는 5V 또는 3V3.",
  ),
  w: ILI9341_LAYOUT.w,
  h: ILI9341_LAYOUT.h,
  pins: ILI9341_PINS.map((id, i) => ({ id, x: 2 + i, y: 0, label: PIN_LABEL[id] ?? id })),
  render: (_props, visual) => <TftBody visual={visual} l={ILI9341_LAYOUT} />,
};
