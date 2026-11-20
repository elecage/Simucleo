// English for the thermocouple modules (M35): parts/thermocouple.tsx and
// their schematic subtitles.
export const THERMOCOUPLE: Record<string, string> = {
  "누르고 있으면 라이터 불꽃(약 {c} °C)으로 끝을 달굽니다 — 떼면 실온으로 식습니다.":
    "Hold to heat the tip in a lighter's flame (about {c} °C) — let go and it cools to room temperature.",
  "누르고 있으면 끝을 얼음물(0 °C)에 담급니다 — 떼면 실온으로 돌아옵니다.":
    "Hold to dip the tip in ice water (0 °C) — let go and it returns to room temperature.",
  "누르면 열전대를 단자에서 뽑거나 다시 꽂습니다 (열림 고장).":
    "Click to pull the thermocouple out of the terminals or plug it back in (open fault).",
  "열전대 끝 온도": "Probe tip temperature",
  "주변(모듈) 온도": "Ambient (module) temperature",
  "열림": "open",
  "OC 열림": "OC open",
  "SCG GND 단락": "SCG short to GND",
  "SCV VCC 단락": "SCV short to VCC",
  "GND에 닿음": "touches GND",
  "VCC에 닿음": "touches VCC",
  "K형 열전대 (MAX6675)": "K-type thermocouple (MAX6675)",
  "MAX6675 열전대 앰프 모듈과 K형 열전대(+ 노랑, − 빨강). 읽기 전용 SPI: CS를 Low로 하면 SO에 D15가 나오고 SCK 하강 에지마다 다음 비트(모드 0, 최대 4.3 MHz — 더 빠르면 비트가 한 칸씩 밀려 엉터리 값). 16비트: D15 0, D14–D3 온도(0.25 °C 단위, 0–1023.75 °C), D2 열전대 열림, D1 0, D0 하이 임피던스. 변환에 최대 220 ms 걸리고 CS를 Low로 하면 변환이 멈추므로, 더 자주 읽으면 이전 값이 그대로 나옵니다. 하드웨어 SPI(SPI1 RX 전용이나 2선, D13 SCK, D12 MISO)든 비트뱅잉이든 됩니다. 모듈은 41 µV/°C 직선으로 환산하므로 400 °C 위에서는 높게 읽습니다. 끝을 🔥(라이터)나 🧊(얼음물)에 대 보고, 단자를 누르면 열전대가 빠집니다. short로 GND·VCC 단락, reversed로 극성 반대(온도가 거꾸로 내려감). VCC 3–5 V.":
    "MAX6675 thermocouple amplifier module with a K-type thermocouple (+ yellow, − red). Read-only SPI: pulling CS low puts D15 on SO, and every SCK falling edge the next bit (mode 0, at most 4.3 MHz — faster and the bits slip one place: garbage). 16 bits: D15 0, D14–D3 temperature (0.25 °C steps, 0–1023.75 °C), D2 thermocouple open, D1 0, D0 high impedance. A conversion takes up to 220 ms and pulling CS low stops it, so reading more often gives the previous value again. Works with hardware SPI (SPI1 receive-only or 2-line, D13 SCK, D12 MISO) or bit-banged. The module converts with a 41 µV/°C straight line, so above 400 °C it reads high. Hold the tip to 🔥 (a lighter) or 🧊 (ice water); click the terminals to pull the thermocouple out. short: shorted to GND or VCC, reversed: wrong polarity (the temperature goes down instead). VCC 3–5 V.",
  "SCK (클럭 입력)": "SCK (clock input)",
  "CS (Low면 읽기, 변환 멈춤)": "CS (low: read, stops the conversion)",
  "SO (데이터 출력 → MISO)": "SO (data out → MISO)",
  "K형 열전대 (MAX31855K)": "K-type thermocouple (MAX31855K)",
  "MAX31855K 열전대 앰프 브레이크아웃(VIN 3–5 V 레귤레이터, 3Vo 3.3 V 출력)과 K형 열전대(+ 노랑, − 빨강). 읽기 전용 SPI: CS를 Low로 하고 DO에서 32비트를 SCK 하강 에지마다 하나씩(모드 0, 최대 5 MHz). D31–D18 열전대 온도(부호 있는 14비트, 0.25 °C), D16 고장, D15–D4 칩 안의 냉접점 온도(부호 있는 12비트, 0.0625 °C), D2 SCV(VCC 단락), D1 SCG(GND 단락), D0 OC(열림). 앞의 16비트만 읽어도 됩니다. 변환은 최대 100 ms, CS를 Low로 하면 멈춥니다. 41.276 µV/°C 직선으로 환산하므로 NIST 표와 차이(비선형 오차)가 보입니다 — 특히 0 °C 아래. 끝을 🔥나 🧊에 대 보고, 단자를 누르면 열전대가 빠집니다(OC). short로 GND·VCC 단락, reversed로 극성 반대.":
    "MAX31855K thermocouple amplifier breakout (VIN 3–5 V regulator, 3Vo 3.3 V output) with a K-type thermocouple (+ yellow, − red). Read-only SPI: pull CS low and read 32 bits from DO, one per SCK falling edge (mode 0, at most 5 MHz). D31–D18 thermocouple temperature (signed 14 bits, 0.25 °C), D16 fault, D15–D4 the chip's own cold-junction temperature (signed 12 bits, 0.0625 °C), D2 SCV (short to VCC), D1 SCG (short to GND), D0 OC (open). Reading only the first 16 bits is fine. A conversion takes up to 100 ms; pulling CS low stops it. It converts with a 41.276 µV/°C straight line, so it differs from the NIST table (nonlinearity error) — most of all below 0 °C. Hold the tip to 🔥 or 🧊; click the terminals to pull the thermocouple out (OC). short: shorted to GND or VCC, reversed: wrong polarity.",
  "3Vo (3.3 V 레귤레이터 출력)": "3Vo (3.3 V regulator output)",
  "DO (데이터 출력 → MISO)": "DO (data out → MISO)",
  "CLK (클럭 입력)": "CLK (clock input)",
  "K형 열전대 앰프 (MAX6675) · SPI 읽기 전용": "K-type thermocouple amplifier (MAX6675) · read-only SPI",
  "K형 열전대 앰프 (MAX31855K) · SPI 읽기 전용": "K-type thermocouple amplifier (MAX31855K) · read-only SPI",
};
