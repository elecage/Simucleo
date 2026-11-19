// Tier 7 parts (M17): HC-05 Bluetooth serial module and a 1-channel relay
// module. Their models live in `simucleo_circuit::devices` (Hc05, Relay);
// the HC-05's phone is the "블루투스" tab of the bottom panel.
import { PITCH, type PartDef } from "./types";

const P = PITCH;

const NoPower = ({ x, y }: { x: number; y: number }) => (
  <text x={x} y={y} textAnchor="middle" className="silk small unpowered" data-unpowered="1">
    전원 부족
  </text>
);

// ------------------------------------------------------------- HC-05

/** Header pins left to right, as printed on the ZS-040 board. */
const HC05_PINS = ["STATE", "RXD", "TXD", "GND", "VCC", "EN"];

const HC05_LABEL: Record<string, string> = {
  STATE: "STATE (휴대폰 연결 시 High)",
  RXD: "RXD (MCU의 TX를 여기에)",
  TXD: "TXD (MCU의 RX로)",
  GND: "GND",
  VCC: "VCC (3.6–6 V, 보통 5V)",
  EN: "EN/KEY (전원을 켤 때 High면 AT 모드)",
};

/** What the module's LED does in each state (`visual.text`). */
const HC05_STATE: Record<string, string> = {
  waiting: "연결 대기",
  connected: "연결됨",
  at: "AT 모드",
  off: "꺼짐",
};

export const hc05: PartDef = {
  kind: "hc05",
  name: "블루투스 모듈 (HC-05)",
  category: "module",
  description:
    "HC-05 블루투스 시리얼 모듈(ZS-040). 휴대폰과 블루투스로 이어져 UART를 그대로 전달합니다 — 아래 '블루투스 (HC-05)' 탭이 휴대폰 화면입니다. MCU의 TX를 RXD에, TXD를 MCU의 RX에 교차로 연결하세요: USART1은 D8(PA9, TX)·D2(PA10, RX), USART6은 PC6·PC7 또는 PA11·PA12. USART2(D1/D0)는 ST-LINK 가상 COM 포트가 쓰고 있습니다. 데이터 모드는 baud(기본 9600) 8N1 — 펌웨어의 보레이트와 다르면 글자가 깨집니다. 휴대폰이 연결되면 STATE가 High가 되고 LED가 천천히 두 번씩 깜박입니다(대기 중엔 빠르게). EN을 High로 둔 채 전원을 넣으면 38400 baud AT 모드: AT → OK, AT+NAME? → +NAME:HC-05, AT+UART=9600,0,0 등. VCC는 5V(3.6–6 V), 신호는 3.3 V.",
  w: 7,
  h: 12,
  pins: HC05_PINS.map((id, i) => ({ id, x: 0.5 + i + 0.5, y: 12, label: HC05_LABEL[id] })),
  props: { baud: 9600 },
  propOptions: { baud: ["9600", "19200", "38400", "57600", "115200"] },
  render: (_props, visual) => {
    const mode = visual.text ?? "off";
    return (
      <g data-bt-mode={mode}>
        <rect x={0} y={1.2 * P} width={7 * P} height={10.3 * P} rx={1} className="module-pcb" />
        {/* The HC-05 core board with its PCB antenna. */}
        <rect x={0.6 * P} y={0} width={5.8 * P} height={7.6 * P} rx={0.6} className="bt-core" />
        <path
          d={`M ${1.2 * P} ${1.4 * P} h ${4.6 * P} v ${-0.6 * P} h ${-4} v ${0.4 * P} h ${-4} v ${-0.4 * P} h ${-4} v ${0.4 * P} h ${-4} v ${-0.4 * P} h ${-4} v ${0.4 * P}`}
          className="bt-antenna"
        />
        <rect x={2.2 * P} y={2.6 * P} width={2.6 * P} height={2.6 * P} className="chip" />
        <text x={3.5 * P} y={6.6 * P} textAnchor="middle" className="silk module-label">
          HC-05
        </text>
        <circle cx={5.6 * P} cy={8.6 * P} r={0.35 * P} className={`bt-led ${mode}`} data-bt-led={mode} />
        {HC05_PINS.map((name, i) => (
          <text
            key={name}
            x={(1 + i) * P + 1.2}
            y={11.2 * P}
            transform={`rotate(-90 ${(1 + i) * P + 1.2} ${11.2 * P})`}
            className="silk module-label"
          >
            {name}
          </text>
        ))}
        <text x={3.5 * P} y={-0.5 * P} textAnchor="middle" className="silk small value">
          {HC05_STATE[mode] ?? mode}
        </text>
        {visual.unpowered && <NoPower x={3.5 * P} y={13.2 * P} />}
      </g>
    );
  },
};

// ------------------------------------------------------------- relay

export const relay: PartDef = {
  kind: "relay",
  name: "릴레이 모듈 (5V, 1채널)",
  category: "actuator",
  description:
    "SRD-05VDC-SL-C 릴레이에 구동 트랜지스터·다이오드·LED가 달린 모듈. VCC는 5V(코일은 3.75 V 이상에서 붙음), IN으로 코일을 켭니다: trigger=low(흔한 모듈)는 IN을 Low로, high는 High로 하면 켜집니다. 코일이 켜지면 약 10 ms 뒤 COM이 NC에서 NO로 넘어가고(접점이 잠깐 튑니다), 끄면 5 ms 뒤 돌아옵니다. 접점은 MCU와 전기적으로 분리된 스위치라 다른 전원(5V 등)으로 램프·LED·모터를 켤 수 있습니다: 전원 → COM, NO → 부하 → GND.",
  w: 10,
  h: 6,
  pins: [
    { id: "VCC", x: 0, y: 2, label: "VCC (5V)" },
    { id: "GND", x: 0, y: 3, label: "GND" },
    { id: "IN", x: 0, y: 4, label: "IN (코일 제어)" },
    { id: "NO", x: 10, y: 2, label: "NO (평상시 열림: 켜지면 COM과 연결)" },
    { id: "COM", x: 10, y: 3, label: "COM (공통)" },
    { id: "NC", x: 10, y: 4, label: "NC (평상시 닫힘: 꺼져 있을 때 COM과 연결)" },
  ],
  props: { trigger: "low" },
  propOptions: { trigger: ["low", "high"] },
  render: (_props, visual) => {
    const closed = !!visual.closed;
    const coil = (visual.on ?? 0) > 0.5;
    // The armature inside the window: from COM to NO (closed) or NC.
    const [px, py] = [7.4 * P, 3 * P];
    const tip = closed ? [8.7 * P, 2.15 * P] : [8.7 * P, 3.85 * P];
    return (
      <g data-closed={closed ? "1" : "0"} data-coil={coil ? "1" : "0"}>
        <rect x={0} y={0.4 * P} width={10 * P} height={5.4 * P} rx={1} className="module-pcb" />
        {["VCC", "GND", "IN"].map((n, i) => (
          <text key={n} x={0.6 * P} y={(2.15 + i) * P} className="silk module-label">
            {n}
          </text>
        ))}
        {/* The relay can, with a window onto the contacts. */}
        <rect x={2.1 * P} y={0.9 * P} width={4.6 * P} height={4.4 * P} rx={0.6} className="relay-can" />
        <text x={4.4 * P} y={2.1 * P} textAnchor="middle" className="relay-text">
          SRD-05VDC
        </text>
        <text x={4.4 * P} y={2.8 * P} textAnchor="middle" className="relay-text">
          SL-C
        </text>
        {/* Coil */}
        <rect x={3.1 * P} y={3.3 * P} width={2.6 * P} height={1.3 * P} className={coil ? "relay-coil on" : "relay-coil"} />
        {[0, 1, 2, 3].map((i) => (
          <line key={i} x1={(3.4 + i * 0.6) * P} y1={3.3 * P} x2={(3.4 + i * 0.6) * P} y2={4.6 * P} className="relay-winding" />
        ))}
        {/* Screw terminals and the contacts */}
        <rect x={7 * P} y={0.8 * P} width={3 * P} height={4.6 * P} rx={0.6} className="relay-terminal" />
        {["NO", "COM", "NC"].map((n, i) => (
          <g key={n}>
            <circle cx={9.4 * P} cy={(2 + i) * P} r={0.3 * P} className="screw" />
            <text x={9.4 * P} y={(1.55 + i) * P} textAnchor="middle" className="relay-text small">
              {n}
            </text>
            {n !== "COM" && <circle cx={8.75 * P} cy={(2 + i) * P} r={0.14 * P} className="relay-contact" />}
            <line x1={(n === "COM" ? 7.4 : 8.75) * P} y1={(2 + i) * P} x2={9.1 * P} y2={(2 + i) * P} className="relay-winding" />
          </g>
        ))}
        <line x1={px} y1={py} x2={tip[0]} y2={tip[1]} className="relay-arm" data-arm={closed ? "no" : "nc"} />
        <circle cx={px} cy={py} r={0.18 * P} className="relay-pivot" />
        {/* Module LED: lit while the coil is driven. */}
        <circle cx={1.3 * P} cy={1.2 * P} r={0.3 * P} className={coil ? "relay-led on" : "relay-led"} data-relay-led={coil ? "1" : "0"} />
        <text x={5 * P} y={-0.3 * P} textAnchor="middle" className="silk small value">
          {closed ? "COM–NO 연결" : "COM–NC 연결"}
        </text>
        {visual.unpowered && <NoPower x={5 * P} y={7 * P} />}
      </g>
    );
  },
};
