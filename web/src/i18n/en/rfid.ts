// English for the RC522 RFID reader part (M35): parts/rfid.tsx, parts/rfidTags.ts,
// its schematic subtitle and inspector label (the example project name is in data.ts). See ../index.ts.
export const RFID: Record<string, string> = {
  "RFID 리더 (RC522)": "RFID reader (RC522)",
  "13.56 MHz RFID 리더 모듈 (NXP MFRC522, ISO 14443 A). SPI로 연결: SCK·MISO·MOSI는 D13/D12/D11 (SPI1, 모드 0, 10 MHz 이하), SDA는 칩 선택(NSS)이라 아무 GPIO(보통 D10), RST는 GPIO(보통 D9)를 High로, 3.3V는 3V3에 — 5 V는 칩을 망가뜨립니다. 주소 바이트: 비트 7 = 읽기, 레지스터 주소는 비트 6–1(왼쪽으로 한 칸 민 값). VersionReg(0x37)는 0x92(v2.0). 안테나를 켜려면 TxControlReg 비트 0–1, 카드가 알아듣게 TxASKReg = 0x40(100 % ASK). 카드가 없으면 타이머(TAuto, 보통 25 ms)가 끝나 TimerIRq가 됩니다. 오른쪽의 카드(MIFARE Classic 1K 두 장, 키 태그, Ultralight NFC 스티커)를 끌어 안테나 위에 놓거나 클릭하세요. 카드의 키는 모두 FF FF FF FF FF FF. MIFARE 인증은 키가 맞으면 통과하고 MFCrypto1On이 켜집니다 — Crypto1 암호 자체는 흉내내지 않습니다.":
    "13.56 MHz RFID reader module (NXP MFRC522, ISO 14443 A). Connect over SPI: SCK, MISO and MOSI to D13/D12/D11 (SPI1, mode 0, at most 10 MHz), SDA is the chip select (NSS), so any GPIO (usually D10), RST to a GPIO (usually D9) driven high, 3.3V to 3V3 — 5 V damages the chip. Address byte: bit 7 = read, the register address in bits 6–1 (shifted left by one). VersionReg (0x37) reads 0x92 (v2.0). The antenna is on with TxControlReg bits 0–1; cards understand it with TxASKReg = 0x40 (100 % ASK). Without a card the timer (TAuto, usually 25 ms) runs out and sets TimerIRq. Drag a card from the right (two MIFARE Classic 1K cards, a key fob, an Ultralight NFC sticker) onto the antenna, or click it. All card keys are FF FF FF FF FF FF. MIFARE authentication passes when the key matches and turns MFCrypto1On on — the Crypto1 cipher itself is not simulated.",
  "SDA (SPI 칩 선택 NSS, Low = 선택)": "SDA (SPI chip select NSS, low = selected)",
  "MISO (SPI, 선택됐을 때만 출력)": "MISO (SPI, driven only while selected)",
  "IRQ (인터럽트 출력, 오픈 드레인 · Low = 요청)": "IRQ (interrupt output, open drain · low = request)",
  "RST (NRSTPD, Low = 하드 파워다운 · 모듈에 10 kΩ 풀업)": "RST (NRSTPD, low = hard power-down · 10 kΩ pull-up on the module)",
  "3.3V (2.5–3.6 V, 5 V 금지)": "3.3V (2.5–3.6 V, never 5 V)",
  "카드 없음": "No card",
  "카드에 전원 없음 (안테나 꺼짐)": "Card unpowered (antenna off)",
  "카드 대기 (IDLE)": "Card waiting (IDLE)",
  "카드 응답 (READY)": "Card answered (READY)",
  "카드 선택됨 (ACTIVE)": "Card selected (ACTIVE)",
  "카드 인증됨 (Crypto1)": "Card authenticated (Crypto1)",
  "카드 정지 (HALT)": "Card halted (HALT)",
  "카드 A": "Card A",
  "카드 B": "Card B",
  "키 태그": "Key fob",
  "NFC 스티커": "NFC sticker",
  "카드를 끌어 리더의 안테나 위에 놓거나 치우세요 — 클릭하면 올렸다 내렸다 합니다.":
    "Drag a card onto the reader's antenna or away from it — a click puts it on or takes it off.",
  "RFID 리더 (MFRC522) · SPI": "RFID reader (MFRC522) · SPI",
  "안테나 위 카드 (0 없음 · 1 카드 A · 2 카드 B · 3 키 태그 · 4 NFC 스티커)":
    "Card on the antenna (0 none · 1 card A · 2 card B · 3 key fob · 4 NFC sticker)",
};
