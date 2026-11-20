// English for the M35 CAN bus module and the CAN decoder: Korean source
// text → English. See ../index.ts.
export const CAN: Record<string, string> = {
  // web/src/parts/can.tsx
  "CAN 버스 모듈 (MCP2515 + TJA1050)": "CAN bus module (MCP2515 + TJA1050)",
  "SPI로 붙이는 CAN 컨트롤러 MCP2515와 트랜시버 TJA1050 모듈(8 MHz 크리스털). STM32F401에는 CAN이 없어서 이 모듈을 씁니다. SPI 명령: RESET 0xC0, READ 0x03, WRITE 0x02, READ RX BUFFER 0x90/0x94, LOAD TX BUFFER 0x40–0x45, RTS 0x81–0x84, READ STATUS 0xA0, RX STATUS 0xB0, BIT MODIFY 0x05. 리셋 후 설정 모드: 여기서만 CNF1–3(비트 타이밍, 비트레이트 = 1 / (2·(BRP+1)/8 MHz × (1+PRSEG+PS1+PS2)))과 마스크·필터를 쓸 수 있고, CANCTRL로 정상·루프백·수신 전용·슬립 모드로 갑니다. 송신 버퍼 3개, 수신 버퍼 2개(RXB0/RXB1, 마스크 RXM0–1, 필터 RXF0–5, 표준·확장 ID, 롤오버), CANINTE/CANINTF와 INT 핀, EFLG·TEC·REC. 두 모듈 이상의 CANH끼리, CANL끼리 이으면 하나의 버스: 프레임은 ID로 중재되고 비트레이트(스터프 비트 포함)대로 시간이 걸립니다. 비트레이트가 다르거나, 종단 저항(J1 점퍼)이 하나도 없거나, 노드가 혼자면 ACK가 없어 TXERR·재전송·TEC 증가(에러 패시브, 버스 오프)가 실제 칩처럼 일어납니다. 파형 창에서 CANH나 CANL을 프로브하면 버스 신호(High = 리세시브)가 보이고 CAN 디코더로 풀 수 있습니다.":
    "MCP2515 CAN controller on SPI with a TJA1050 transceiver (8 MHz crystal). The STM32F401 has no CAN, which is why this module is used. SPI instructions: RESET 0xC0, READ 0x03, WRITE 0x02, READ RX BUFFER 0x90/0x94, LOAD TX BUFFER 0x40–0x45, RTS 0x81–0x84, READ STATUS 0xA0, RX STATUS 0xB0, BIT MODIFY 0x05. After reset it is in configuration mode: only there can CNF1–3 (bit timing, bit rate = 1 / (2·(BRP+1)/8 MHz × (1+PRSEG+PS1+PS2))) and the masks and filters be written; CANCTRL switches to normal, loopback, listen-only or sleep mode. Three transmit buffers, two receive buffers (RXB0/RXB1, masks RXM0–1, filters RXF0–5, standard and extended IDs, rollover), CANINTE/CANINTF and the INT pin, EFLG, TEC and REC. Two or more modules with CANH to CANH and CANL to CANL form one bus: frames are arbitrated by ID and take the time their bit rate (with stuff bits) gives. A different bit rate, no termination at all (J1 jumper) or a node on its own get no ACK: TXERR, retransmission and a rising TEC (error passive, bus-off) as on the real chip. Probe CANH or CANL in the waveform view to see the bus (high = recessive) and decode it with the CAN decoder.",
  "INT (인터럽트 출력, Low면 수신·송신 완료·오류)": "INT (interrupt output, low on a message received, sent or an error)",
  "CS (칩 선택, Low)": "CS (chip select, active low)",
  "VCC (5 V — TJA1050 트랜시버는 5 V가 필요)": "VCC (5 V — the TJA1050 transceiver needs 5 V)",
  "설정 모드": "Configuration",
  "정상 모드": "Normal",
  "루프백": "Loopback",
  "수신 전용": "Listen-only",
  "슬립": "Sleep",
  "에러 패시브": "error passive",
  "송신 {tx} · 수신 {rx}": "Sent {tx} · received {rx}",
  // web/src/run/decode.ts, Waveform.tsx: the CAN decoder
  "스터프 오류": "Stuff error",
  "CRC 오류": "CRC error",
  "형식 오류 ({field})": "Form error ({field})",
  "비트레이트": "Bit rate",
  "CAN 비트레이트": "CAN bit rate",
};
