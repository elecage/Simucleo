// RC522 RFID reader module (M35): the NXP MFRC522 on SPI with its antenna
// coil, and the cards and tags a student puts on it (./rfidTags.ts). The
// model lives in `simucleo_circuit::rc522`.
import { ANTENNA, TAGS, tagCentre, tagControl, type Tag } from "./rfidTags";
import { PITCH, type PartDef } from "./types";
import { t } from "../i18n";

const P = PITCH;

/** Header pins, left to right as printed on the module. */
const PINS = ["SDA", "SCK", "MOSI", "MISO", "IRQ", "GND", "RST", "3V3"];
const PIN_LABEL: Record<string, string> = {
  SDA: t("SDA (SPI 칩 선택 NSS, Low = 선택)"),
  SCK: "SCK (SPI)",
  MOSI: "MOSI (SPI)",
  MISO: t("MISO (SPI, 선택됐을 때만 출력)"),
  IRQ: t("IRQ (인터럽트 출력, 오픈 드레인 · Low = 요청)"),
  GND: "GND",
  RST: t("RST (NRSTPD, Low = 하드 파워다운 · 모듈에 10 kΩ 풀업)"),
  "3V3": t("3.3V (2.5–3.6 V, 5 V 금지)"),
};

/** The card's state as the reader leaves it (visual.text). */
const STATE: Record<string, string> = {
  none: t("카드 없음"),
  off: t("카드에 전원 없음 (안테나 꺼짐)"),
  idle: t("카드 대기 (IDLE)"),
  ready: t("카드 응답 (READY)"),
  active: t("카드 선택됨 (ACTIVE)"),
  auth: t("카드 인증됨 (Crypto1)"),
  halt: t("카드 정지 (HALT)"),
};

function TagShape({ tag, x, y, held, on }: { tag: Tag; x: number; y: number; held: boolean; on: boolean }) {
  const cx = x * P,
    cy = y * P;
  const dark = tag.shape === "fob";
  const ink = dark ? "#e0e7ff" : "#334155";
  const lift = held ? "drop-shadow(0 3px 3px rgba(0,0,0,0.45))" : undefined;
  return (
    <g
      data-drag={`tag${tag.n}`}
      data-tag={tag.n}
      data-on={on ? "1" : "0"}
      style={{ cursor: "grab", filter: lift }}
      opacity={on ? 0.93 : 1}
    >
      {tag.shape === "card" && (
        <rect x={cx - 2.05 * P} y={cy - 1.3 * P} width={4.1 * P} height={2.6 * P} rx={2} fill={tag.color} stroke="#94a3b8" strokeWidth={0.6} />
      )}
      {tag.shape === "fob" && (
        <g>
          <path
            d={`M ${cx - 1.2 * P} ${cy - 0.2 * P} a ${1.2 * P} ${1.2 * P} 0 0 1 ${2.4 * P} 0 L ${cx + 0.55 * P} ${cy + 1.2 * P} h ${-1.1 * P} Z`}
            fill={tag.color}
            stroke="#1e3a8a"
            strokeWidth={0.6}
          />
          <circle cx={cx} cy={cy - 0.65 * P} r={0.25 * P} fill="#0f172a" />
        </g>
      )}
      {tag.shape === "sticker" && <circle cx={cx} cy={cy} r={1.25 * P} fill={tag.color} stroke="#059669" strokeWidth={0.6} />}
      {tag.shape !== "fob" && (
        <circle cx={cx} cy={cy} r={0.75 * P} fill="none" stroke={ink} strokeWidth={0.3} opacity={0.35} />
      )}
      <text x={cx} y={cy + (tag.shape === "fob" ? 0.3 : -0.25) * P} textAnchor="middle" fontSize={3} fontWeight={600} fill={ink}>
        {tag.label}
      </text>
      <text x={cx} y={cy + (tag.shape === "fob" ? 0.85 : 0.45) * P} textAnchor="middle" fontSize={tag.uid.length > 12 ? 1.6 : 2} fill={ink}>
        {tag.uid}
      </text>
    </g>
  );
}

export const rfidRc522: PartDef = {
  kind: "rfid-rc522",
  name: t("RFID 리더 (RC522)"),
  category: "module",
  description: t(
    "13.56 MHz RFID 리더 모듈 (NXP MFRC522, ISO 14443 A). SPI로 연결: SCK·MISO·MOSI는 D13/D12/D11 (SPI1, 모드 0, 10 MHz 이하), SDA는 칩 선택(NSS)이라 아무 GPIO(보통 D10), RST는 GPIO(보통 D9)를 High로, 3.3V는 3V3에 — 5 V는 칩을 망가뜨립니다. 주소 바이트: 비트 7 = 읽기, 레지스터 주소는 비트 6–1(왼쪽으로 한 칸 민 값). VersionReg(0x37)는 0x92(v2.0). 안테나를 켜려면 TxControlReg 비트 0–1, 카드가 알아듣게 TxASKReg = 0x40(100 % ASK). 카드가 없으면 타이머(TAuto, 보통 25 ms)가 끝나 TimerIRq가 됩니다. 오른쪽의 카드(MIFARE Classic 1K 두 장, 키 태그, Ultralight NFC 스티커)를 끌어 안테나 위에 놓거나 클릭하세요. 카드의 키는 모두 FF FF FF FF FF FF. MIFARE 인증은 키가 맞으면 통과하고 MFCrypto1On이 켜집니다 — Crypto1 암호 자체는 흉내내지 않습니다.",
  ),
  w: 16,
  h: 12,
  pins: PINS.map((id, i) => ({ id, x: i + 1, y: 12, label: PIN_LABEL[id] ?? id })),
  props: { card: 0 },
  propOptions: { card: ["0", "1", "2", "3", "4"] },
  controls: Object.fromEntries(TAGS.map((tag) => [`tag${tag.n}`, tagControl(tag.n)])),
  render: (props, visual) => {
    const card = Number(props.card) || 0;
    const field = (visual.on ?? 0) > 0.5;
    const state = visual.text ?? "off";
    const powered = visual.text !== undefined && !visual.unpowered;
    // The tag on the antenna and the one held are drawn on top.
    const order = [...TAGS].sort((a, b) => {
      const rank = (x: Tag) => (visual.control === `tag${x.n}` ? 2 : card === x.n ? 1 : 0);
      return rank(a) - rank(b);
    });
    return (
      <g data-card={card} data-card-state={state} data-field={field ? "1" : "0"}>
        <rect x={0} y={0} width={9 * P} height={12.6 * P} rx={1.5} className="module-pcb" />
        {/* Antenna coil: a few copper turns around the edge. */}
        {[0, 0.35, 0.7].map((d) => (
          <rect
            key={d}
            data-antenna={d === 0 ? "1" : undefined}
            x={(ANTENNA.x0 + d) * P}
            y={(ANTENNA.y0 + d) * P}
            width={(ANTENNA.x1 - ANTENNA.x0 - 2 * d) * P}
            height={(ANTENNA.y1 - ANTENNA.y0 - 2 * d) * P}
            rx={2.5}
            fill="none"
            stroke="#d4a017"
            strokeWidth={0.9}
          />
        ))}
        {field &&
          [1.4, 2.4, 3.4].map((r) => (
            <circle key={r} cx={4.5 * P} cy={4.2 * P} r={r * P} fill="none" stroke="#38bdf8" strokeWidth={0.6} opacity={0.5} data-field-ring="1" />
          ))}
        <rect x={3.5 * P} y={8.3 * P} width={2 * P} height={1.6 * P} rx={0.5} fill="#1f2937" />
        <text x={4.5 * P} y={9.25 * P} textAnchor="middle" fontSize={2.2} fill="#e5e7eb">
          MFRC522
        </text>
        <rect x={6.6 * P} y={8.5 * P} width={1.4 * P} height={1 * P} rx={0.3} fill="#cbd5e1" />
        <text x={7.3 * P} y={9.15 * P} textAnchor="middle" fontSize={1.6} fill="#334155">
          27.12
        </text>
        <circle cx={1.6 * P} cy={9.1 * P} r={0.32 * P} fill={powered ? "#ef4444" : "#4b1d1d"} data-power-led={powered ? "1" : "0"} />
        {PINS.map((n, i) => (
          <g key={n}>
            <rect x={(i + 1) * P - 2} y={12 * P - 2} width={4} height={4} className="header-pin" />
            <text x={(i + 1) * P} y={11.4 * P} textAnchor="middle" className="silk tiny">
              {n === "3V3" ? "3.3V" : n}
            </text>
          </g>
        ))}
        <text x={4.5 * P} y={-0.8 * P} textAnchor="middle" className="silk small value" data-state-label={state}>
          RC522 · {STATE[state] ?? state}
        </text>
        {/* The tray beside the reader. */}
        <rect x={10.6 * P} y={0} width={4.8 * P} height={11.6 * P} rx={1.5} fill="none" stroke="#94a3b8" strokeDasharray="2 2" strokeWidth={0.5} />
        {order.map((tag) => {
          const c = tagCentre(tag.n, card);
          return <TagShape key={tag.n} tag={tag} x={c.x} y={c.y} held={visual.control === `tag${tag.n}`} on={card === tag.n} />;
        })}
        {visual.unpowered && (
          <text x={4.5 * P} y={13.8 * P} textAnchor="middle" className="silk small unpowered" data-unpowered="1">
            {t("전원 부족")}
          </text>
        )}
      </g>
    );
  },
};
