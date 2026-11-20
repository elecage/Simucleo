// M35: the common MCP2515 + TJA1050 CAN bus module. The STM32F401 has no
// CAN controller, so the MCP2515 sits on SPI; the TJA1050 drives the bus.
// The chip and the bus between modules live in `simucleo_circuit::mcp2515`;
// the module shows its mode, bit rate, error state and counters.
import { parseCanStatus } from "./canStatus";
import { PITCH, type PartDef } from "./types";
import { t } from "../i18n";

const P = PITCH;

/** The 7-pin header on the left edge, top to bottom. */
const HEADER = ["INT", "SCK", "SI", "SO", "CS", "GND", "VCC"];
const HEADER_LABEL: Record<string, string> = {
  INT: t("INT (인터럽트 출력, Low면 수신·송신 완료·오류)"),
  SCK: "SCK (SPI clock → D13 / PA5)",
  SI: "SI (MOSI → D11 / PA7)",
  SO: "SO (MISO → D12 / PA6)",
  CS: t("CS (칩 선택, Low)"),
  GND: "GND",
  VCC: t("VCC (5 V — TJA1050 트랜시버는 5 V가 필요)"),
};

const MODE_TEXT: Record<string, string> = {
  config: t("설정 모드"),
  normal: t("정상 모드"),
  loopback: t("루프백"),
  "listen-only": t("수신 전용"),
  sleep: t("슬립"),
};

export const canMcp2515: PartDef = {
  kind: "can-mcp2515",
  name: t("CAN 버스 모듈 (MCP2515 + TJA1050)"),
  category: "module",
  description: t(
    "SPI로 붙이는 CAN 컨트롤러 MCP2515와 트랜시버 TJA1050 모듈(8 MHz 크리스털). STM32F401에는 CAN이 없어서 이 모듈을 씁니다. SPI 명령: RESET 0xC0, READ 0x03, WRITE 0x02, READ RX BUFFER 0x90/0x94, LOAD TX BUFFER 0x40–0x45, RTS 0x81–0x84, READ STATUS 0xA0, RX STATUS 0xB0, BIT MODIFY 0x05. 리셋 후 설정 모드: 여기서만 CNF1–3(비트 타이밍, 비트레이트 = 1 / (2·(BRP+1)/8 MHz × (1+PRSEG+PS1+PS2)))과 마스크·필터를 쓸 수 있고, CANCTRL로 정상·루프백·수신 전용·슬립 모드로 갑니다. 송신 버퍼 3개, 수신 버퍼 2개(RXB0/RXB1, 마스크 RXM0–1, 필터 RXF0–5, 표준·확장 ID, 롤오버), CANINTE/CANINTF와 INT 핀, EFLG·TEC·REC. 두 모듈 이상의 CANH끼리, CANL끼리 이으면 하나의 버스: 프레임은 ID로 중재되고 비트레이트(스터프 비트 포함)대로 시간이 걸립니다. 비트레이트가 다르거나, 종단 저항(J1 점퍼)이 하나도 없거나, 노드가 혼자면 ACK가 없어 TXERR·재전송·TEC 증가(에러 패시브, 버스 오프)가 실제 칩처럼 일어납니다. 파형 창에서 CANH나 CANL을 프로브하면 버스 신호(High = 리세시브)가 보이고 CAN 디코더로 풀 수 있습니다.",
  ),
  w: 14,
  h: 9,
  pins: [
    ...HEADER.map((id, i) => ({ id, x: 0, y: 1 + i, label: HEADER_LABEL[id] })),
    { id: "CANH", x: 14, y: 3, label: "CANH" },
    { id: "CANL", x: 14, y: 5, label: "CANL" },
  ],
  props: { term: "on", osc: "8 MHz" },
  propOptions: { term: ["on", "off"], osc: ["8 MHz", "16 MHz"] },
  render: (props, visual) => {
    const st = parseCanStatus(visual.text);
    const term = String(props.term ?? "on") !== "off";
    const powered = !visual.unpowered;
    return (
      <g
        data-can-mode={st?.mode ?? ""}
        data-can-state={st?.state ?? ""}
        data-tec={st?.tec ?? ""}
        data-rec={st?.rec ?? ""}
        data-rx={st?.rx ?? ""}
        data-tx={st?.tx ?? ""}
        data-term={term ? "on" : "off"}
      >
        <rect x={0} y={0} width={14 * P} height={9 * P} rx={2} className="module-pcb" />
        {HEADER.map((id, i) => (
          <g key={id}>
            <rect x={-2} y={(1 + i) * P - 2} width={4} height={4} className="header-pin" />
            <text x={0.6 * P} y={(1 + i) * P + 1.5} className="silk module-label">
              {id}
            </text>
          </g>
        ))}
        {/* MCP2515 (SOIC-18), 8 MHz crystal, TJA1050 (SO-8) */}
        <rect x={2.6 * P} y={1.2 * P} width={3.2 * P} height={4 * P} rx={0.6} fill="#1f2937" />
        <text x={4.2 * P} y={3.3 * P} className="silk chip-label">
          MCP2515
        </text>
        <rect x={2.8 * P} y={6.2 * P} width={2.8 * P} height={1.1 * P} rx={3} fill="#d1d5db" stroke="#6b7280" strokeWidth={0.5} />
        <text x={4.2 * P} y={6.85 * P} className="silk chip-label" fill="#111">
          8.000
        </text>
        <rect x={7.2 * P} y={2.2 * P} width={2.2 * P} height={2.2 * P} rx={0.5} fill="#1f2937" />
        <text x={8.3 * P} y={3.45 * P} className="silk chip-label">
          TJA1050
        </text>
        {/* Screw terminal CANH / CANL */}
        <rect x={11.6 * P} y={2.2 * P} width={2.2 * P} height={3.6 * P} rx={0.6} fill="#2563eb" stroke="#1e3a8a" />
        <circle cx={12.7 * P} cy={3 * P} r={0.55 * P} fill="#9ca3af" />
        <circle cx={12.7 * P} cy={5 * P} r={0.55 * P} fill="#9ca3af" />
        <text x={11.4 * P} y={3 * P + 1.5} textAnchor="end" className="silk module-label">
          H
        </text>
        <text x={11.4 * P} y={5 * P + 1.5} textAnchor="end" className="silk module-label">
          L
        </text>
        {/* J1: the 120 Ω termination jumper */}
        <g data-jumper={term ? "on" : "off"}>
          <rect x={10.6 * P} y={6.4 * P} width={0.6 * P} height={0.6 * P} fill="#d4af37" />
          <rect x={11.6 * P} y={6.4 * P} width={0.6 * P} height={0.6 * P} fill="#d4af37" />
          {term && <rect x={10.4 * P} y={6.2 * P} width={2 * P} height={1 * P} rx={1} fill="#111827" />}
          <text x={11.4 * P} y={8.2 * P} textAnchor="middle" className="silk module-label">
            J1 120Ω
          </text>
        </g>
        {/* Power LED */}
        <circle cx={8.3 * P} cy={7.2 * P} r={0.4 * P} fill={powered ? "#ef4444" : "#4b1d1d"} />
        <circle cx={6.6 * P} cy={7.2 * P} r={0.4 * P} fill={visual.on ? "#f59e0b" : "#3f2e0b"} data-int={visual.on ? "1" : "0"} />
        <text x={7 * P} y={-0.8 * P} textAnchor="middle" className="silk small value" data-testid="can-status">
          {!powered
            ? t("전원 부족")
            : st
              ? `${MODE_TEXT[st.mode] ?? st.mode} · ${st.rate} · TEC ${st.tec} REC ${st.rec}${st.state === "bus-off" ? " · BUS-OFF" : st.state === "error-passive" ? ` · ${t("에러 패시브")}` : ""}`
              : ""}
        </text>
        {powered && st && (
          <text x={7 * P} y={10.2 * P} textAnchor="middle" className="silk small">
            {t("송신 {tx} · 수신 {rx}", { tx: st.tx, rx: st.rx })}
          </text>
        )}
      </g>
    );
  },
};
