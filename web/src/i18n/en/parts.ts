// English for the parts strings (M34): Korean source text → English. See ../index.ts.
export const PARTS: Record<string, string> = {
  // Shared on-part labels
  "전원 부족": "Low supply",
  "온도": "Temperature",
  "습도": "Humidity",
  "밝기": "Brightness",
  "꺼짐": "Off",
  "전원": "Power",

  // analog.tsx
  "가변저항": "Potentiometer",
  "양 끝(1, 2)을 3V3와 GND에, 가운데(W, 와이퍼)를 아날로그 핀(A0 등)에 연결. 노브를 잡고 돌리거나(270°) 노브 위에서 마우스 휠을 굴려 돌립니다. 몸체 아래쪽을 끌면 옮겨집니다.":
    "Connect the two ends (1, 2) to 3V3 and GND and the middle (W, wiper) to an analog pin (A0, etc.). Grab the knob and turn it (270°), or roll the mouse wheel over the knob. Drag the lower part of the body to move it.",
  "1 (한쪽 끝)": "1 (one end)",
  "W (와이퍼, 가운데)": "W (wiper, middle)",
  "2 (다른 쪽 끝)": "2 (other end)",
  "노브 위치": "Knob position",
  "조도센서 (LDR)": "Light sensor (LDR)",
  "빛이 밝을수록 저항이 작아집니다 (10 lux에서 약 10 kΩ). 고정 저항과 분압기로 묶어 아날로그 핀에 연결하세요. 위의 손전등을 끌어 가까이 대면 밝아지고(거리의 제곱에 반비례, 약 100–10000 lux) ✋를 누르고 있으면 손으로 가려 어두워집니다(약 5 lux).":
    "The brighter the light, the lower the resistance (about 10 kΩ at 10 lux). Make a voltage divider with a fixed resistor and connect it to an analog pin. Drag the flashlight above closer to make it brighter (inverse square of the distance, about 100–10000 lux); hold ✋ to cover it with a hand and make it dark (about 5 lux).",
  "손전등을 위아래로 끌어 보세요 — 센서에 가까울수록 밝아집니다 (거리의 제곱에 반비례).":
    "Drag the flashlight up and down — the closer to the sensor, the brighter (inverse square of the distance).",
  "누르고 있는 동안 손으로 센서를 가립니다 (약 5 lux).": "While held, a hand covers the sensor (about 5 lux).",
  "아날로그 온도센서": "Analog temperature sensor",
  "TMP36: 출력 0.5 V + 10 mV/°C, 2.7 V 이상에서 동작 (3V3 가능). LM35: 10 mV/°C, 4 V 이상 필요 (5V에 연결). 평평한 면을 보고 왼쪽부터 VS, OUT, GND. 센서를 누르고 있으면 손가락 체온(약 {finger} °C)으로 몇 초에 걸쳐 데워지고, 떼면 원래 온도로 식습니다.":
    "TMP36: output 0.5 V + 10 mV/°C, works from 2.7 V (3V3 is fine). LM35: 10 mV/°C, needs 4 V or more (connect to 5V). Facing the flat side, from the left: VS, OUT, GND. Hold the sensor down and your fingertip (about {finger} °C) warms it over a few seconds; let go and it cools back to its temperature.",
  "VS (+전원)": "VS (+supply)",
  "OUT (전압 출력)": "OUT (voltage output)",
  "서보 모터": "Servo motor",
  "SG90 계열. 갈색 GND, 빨강 V+(5V), 주황 SIG(PWM). 50 Hz에서 펄스 폭 0.5 ms = 0°, 1.5 ms = 90°, 2.5 ms = 180°.":
    "SG90 type. Brown GND, red V+ (5V), orange SIG (PWM). At 50 Hz, pulse width 0.5 ms = 0°, 1.5 ms = 90°, 2.5 ms = 180°.",
  "GND (갈색)": "GND (brown)",
  "V+ (빨강, 5V)": "V+ (red, 5V)",
  "SIG (주황, PWM)": "SIG (orange, PWM)",
  "DC 모터 (드라이버 포함)": "DC motor (with driver)",
  "H-브리지 드라이버 모듈(L9110S 계열)이 달린 기어드 DC 모터. IA에 PWM, IB를 LOW로 두면 정방향, 반대면 역방향. VCC는 5V.":
    "Geared DC motor with an H-bridge driver module (L9110S type). PWM on IA with IB LOW turns it forward; the other way round, in reverse. VCC is 5V.",
  "IA (정방향 입력)": "IA (forward input)",
  "IB (역방향 입력)": "IB (reverse input)",

  // basic.tsx
  "전류가 너무 큽니다 — 저항을 직렬로 넣으세요": "Too much current — add a resistor in series",
  "긴 다리(A, +)가 애노드. 저항과 직렬로 연결하세요.": "The long leg (A, +) is the anode. Connect it in series with a resistor.",
  "Anode (+, 긴 다리)": "Anode (+, long leg)",
  "Cathode (−, 짧은 다리)": "Cathode (−, short leg)",
  "저항": "Resistor",
  "색띠는 IEC 60062 규격: 3띠(유효숫자 2 + 승수, ±20%), 4띠(+ 오차), 5띠(유효숫자 3 + 승수 + 오차), 6띠(+ 온도계수). 왼쪽부터 읽고, 떨어져 있는 띠가 오차입니다.":
    "Color bands per IEC 60062: 3 bands (2 significant digits + multiplier, ±20%), 4 bands (+ tolerance), 5 bands (3 significant digits + multiplier + tolerance), 6 bands (+ temperature coefficient). Read from the left; the band set apart is the tolerance.",
  "택트 스위치": "Tactile switch",
  "누르는 동안 위(1a·1b)와 아래(2a·2b)가 연결됩니다. 실행 중 클릭해서 누르세요.":
    "While pressed, the top (1a·1b) and bottom (2a·2b) are connected. Click it while running to press it.",
  "R·G·B 각각 저항을 거쳐 연결. 공통 단자(COM)는 캐소드형이면 GND, 애노드형이면 3V3.":
    "Connect R·G·B each through a resistor. The common pin (COM) goes to GND for common cathode, 3V3 for common anode.",
  "COM (공통, 가장 긴 다리)": "COM (common, longest leg)",
  "+ (긴 다리)": "+ (long leg)",
  "능동 부저": "Active buzzer",
  "전원이 들어오면 스스로 일정한 음을 냅니다 (HIGH = 소리).": "Sounds a fixed tone by itself when powered (HIGH = sound).",
  "수동 부저": "Passive buzzer",
  "주파수를 직접 만들어야 소리가 납니다 (PWM/토글). 음높이 = 신호 주파수.":
    "Makes sound only when you generate the frequency (PWM/toggling). Pitch = signal frequency.",

  // breadboard.tsx
  "브레드보드 (하프)": "Breadboard (half)",

  // bus.tsx
  "SSD1306 0.96인치 OLED, I2C 주소 0x3C (뒷면 점퍼로 0x3D). VCC는 3V3, SCL/SDA는 D15/D14 (I2C1). 모듈에 풀업 저항이 있습니다.":
    "SSD1306 0.96-inch OLED, I2C address 0x3C (0x3D with the jumper on the back). VCC is 3V3, SCL/SDA are D15/D14 (I2C1). The module has pull-up resistors.",
  "SSD1306 OLED의 4선 SPI 버전. D0 = SCK (D13), D1 = MOSI (D11), CS·DC·RES는 아무 GPIO. DC가 High면 데이터, Low면 명령. RES를 Low로 하면 초기화됩니다.":
    "4-wire SPI version of the SSD1306 OLED. D0 = SCK (D13), D1 = MOSI (D11), CS·DC·RES on any GPIO. DC High means data, Low means command. Pulling RES Low resets it.",
  "RES (리셋, Low)": "RES (reset, Low)",
  "DC (데이터/명령)": "DC (data/command)",
  "CS (선택, Low)": "CS (select, Low)",
  "RTC 시계 (DS3231)": "RTC clock (DS3231)",
  "I2C 주소 0x68. 레지스터 0x00–0x06에 초·분·시·요일·일·월·연도가 BCD로 들어 있습니다. 시뮬레이션을 시작한 시각에서 출발하고, 백업 배터리가 있어 보드를 리셋해도 계속 갑니다.":
    "I2C address 0x68. Registers 0x00–0x06 hold seconds·minutes·hours·weekday·date·month·year in BCD. It starts from the time the simulation started and has a backup battery, so it keeps running when the board is reset.",
  "온습도 센서 (AHT20)": "Temperature & humidity sensor (AHT20)",
  "I2C 주소 0x38. 0xBE로 보정, 0xAC 0x33 0x00으로 측정을 시작하면 80 ms 뒤 상태 + 습도 20비트 + 온도 20비트 + CRC를 읽을 수 있습니다. 센서를 누르고 있으면 손가락 체온(약 {finger} °C)과 입김(습도 {breath} %)으로 값이 오르고, 떼면 원래대로 돌아옵니다.":
    "I2C address 0x38. Calibrate with 0xBE; start a measurement with 0xAC 0x33 0x00 and after 80 ms you can read status + 20-bit humidity + 20-bit temperature + CRC. Hold the sensor down and your fingertip (about {finger} °C) and breath (humidity {breath} %) raise the readings; let go and they return.",
  "SD 카드 모듈": "SD card module",
  "SPI 모드 SDHC 카드 (512바이트 블록 주소). VCC는 5V (모듈의 레귤레이터, 3 V 이상), SCK/MISO/MOSI는 D13/D12/D11 (SPI1), CS는 아무 GPIO. 카드 내용은 속성 창에서 디스크 이미지로 내려받거나 넣을 수 있습니다.":
    "SDHC card in SPI mode (512-byte block addressing). VCC is 5V (the module's regulator, 3 V or more), SCK/MISO/MOSI are D13/D12/D11 (SPI1), CS on any GPIO. In the properties panel you can download the card's contents as a disk image or load one.",

  // controls.ts
  "노브를 잡고 돌리세요 — 시계 방향으로 돌리면 커집니다. 마우스 휠로도 조금씩 돌아갑니다.":
    "Grab the knob and turn it — clockwise increases. The mouse wheel turns it in small steps too.",
  "누르고 있으면 손가락과 입김으로 온도·습도가 올라갑니다 — 떼면 천천히 돌아옵니다. 끌면 부품이 옮겨집니다.":
    "Hold to raise temperature·humidity with your finger and breath — let go and they slowly return. Drag to move the part.",
  "누르고 있으면 손가락 체온으로 데워집니다 — 떼면 천천히 식습니다. 끌면 부품이 옮겨집니다.":
    "Hold to warm it with your fingertip — let go and it slowly cools. Drag to move the part.",
  "누르면 센서를 흔듭니다 — 0.5초쯤 흔들리며 중력에 가속도(ax·ay·az)가 더해집니다.":
    "Press to shake the sensor — it shakes for about 0.5 s, adding acceleration (ax·ay·az) to gravity.",
  "끌어서 기울이세요 — 좌우는 roll, 위아래는 pitch. 빠르게 왔다 갔다 하면 흔들립니다. 모듈 가장자리를 끌면 옮겨집니다.":
    "Drag to tilt — left/right is roll, up/down is pitch. Move back and forth quickly to shake it. Drag the module's edge to move it.",
  "손잡이를 끌어 기울이세요 — 놓으면 가운데로 돌아옵니다. 움직이지 않고 누르면(클릭) 스틱 버튼(SW)이 눌립니다.":
    "Drag the knob to tilt it — it returns to the center when released. Press without moving (click) to press the stick button (SW).",
  "사람을 좌우로 끌어 센서 앞(부채꼴 안)을 지나가게 하세요 — 움직이는 동안만 움직임이 감지됩니다.":
    "Drag the person left and right past the front of the sensor (inside the fan) — motion is detected only while moving.",
  "누르면 센서 앞에서 움직임이 생깁니다(누르는 동안, 최소 1초).":
    "Press to make motion in front of the sensor (while held, at least 1 s).",
  "축을 잡고 돌리세요 — 드라이버가 꺼져 있으면(EN High) 손으로 돌아가고, 켜져 있으면 홀딩 토크가 되돌립니다. 마우스 휠로 1.8°씩.":
    "Grab the shaft and turn it — with the driver off (EN High) it turns by hand; with it on, the holding torque pulls it back. The mouse wheel turns 1.8° at a time.",

  // more.tsx
  "세그먼트 a–g, dp는 위에서부터 시계 방향(a 위, b 오른쪽 위, c 오른쪽 아래, d 아래, e 왼쪽 아래, f 왼쪽 위, g 가운데)입니다. 세그먼트마다 저항(330–470 Ω)을 다세요.":
    "Segments a–g and dp go clockwise from the top (a top, b top right, c bottom right, d bottom, e bottom left, f top left, g middle). Put a resistor (330–470 Ω) on each segment.",
  "7세그먼트 (1자리)": "7-segment (1 digit)",
  "{hint} 공통 캐소드면 COM을 GND에, 공통 애노드면 3V3에 연결합니다.":
    "{hint} For common cathode connect COM to GND; for common anode, to 3V3.",
  "COM (공통)": "COM (common)",
  "{id} 세그먼트": "{id} segment",
  "7세그먼트 (4자리)": "7-segment (4 digits)",
  "{hint} 네 자리가 세그먼트 핀을 함께 쓰고 자리마다 공통 핀(D1–D4)이 있어, 한 번에 한 자리씩 빠르게 돌아가며 켜야 합니다(멀티플렉싱).":
    "{hint} The four digits share the segment pins and each digit has its own common pin (D1–D4), so you must light one digit at a time, cycling quickly (multiplexing).",
  "{id} (자리 공통)": "{id} (digit common)",
  "키패드 4×4": "Keypad 4×4",
  "멤브레인 키패드. 키를 누르면 그 줄(R1–R4)과 칸(C1–C4)이 이어집니다. 줄 하나를 Low로 하고 칸들을 풀업 입력으로 읽는 식으로 스캔하세요. 키를 클릭해 누릅니다.":
    "Membrane keypad. Pressing a key connects its row (R1–R4) and column (C1–C4). Scan it by driving one row Low and reading the columns as pull-up inputs. Click a key to press it.",
  "R{i} (줄)": "R{i} (row)",
  "C{i} (칸)": "C{i} (column)",
  "로터리 엔코더": "Rotary encoder",
  "KY-040 모듈. 한 칸(detent) 돌릴 때마다 CLK와 DT가 한 주기씩 바뀌고, 시계 방향이면 CLK가 먼저 바뀝니다. 타이머 엔코더 모드(TIMx_CH1/CH2)로 세거나 EXTI로 읽으세요. 모듈에 10 kΩ 풀업이 있습니다. ⟲ ⟳를 눌러 돌리고, 손잡이를 누르면 SW가 GND로 연결됩니다.":
    "KY-040 module. Each detent turned, CLK and DT go through one cycle; clockwise, CLK changes first. Count with a timer in encoder mode (TIMx_CH1/CH2) or read with EXTI. The module has 10 kΩ pull-ups. Press ⟲ ⟳ to turn it; pressing the knob connects SW to GND.",
  "서미스터 (NTC)": "Thermistor (NTC)",
  "온도가 오르면 저항이 줄어드는 NTC. R = R25 · exp(B (1/T − 1/298.15 K)). 고정 저항과 분압기로 묶어 아날로그 핀에서 읽으세요. 머리를 누르고 있으면 손가락 체온(약 {finger} °C)으로 데워지고, 떼면 식습니다.":
    "An NTC: resistance drops as temperature rises. R = R25 · exp(B (1/T − 1/298.15 K)). Make a voltage divider with a fixed resistor and read it on an analog pin. Hold the head down and your fingertip (about {finger} °C) warms it; let go and it cools.",
  "초음파 거리센서": "Ultrasonic distance sensor",
  "HC-SR04P(3.3–5 V). TRIG에 10 µs 이상 High 펄스를 주면, ECHO가 소리가 왕복한 시간만큼 High가 됩니다(1 cm당 약 58 µs, 400 cm 넘으면 38 ms). 입력 캡처로 재면 정확합니다. 앞의 장애물(손)을 위아래로 끌어 거리를 바꿉니다(2–450 cm, 가까운 쪽이 더 세밀). 모듈을 끌면 옮겨집니다.":
    "HC-SR04P (3.3–5 V). Give TRIG a High pulse of 10 µs or more, and ECHO goes High for the sound's round-trip time (about 58 µs per cm; 38 ms beyond 400 cm). Measuring with input capture is accurate. Drag the obstacle (hand) in front up and down to change the distance (2–450 cm, finer when close). Drag the module to move it.",
  "거리": "Distance",
  "장애물을 위아래로 끌어 거리를 바꾸세요 (2–450 cm). 모듈을 끌면 옮겨집니다.":
    "Drag the obstacle up and down to change the distance (2–450 cm). Drag the module to move it.",
  "✋ 장애물": "✋ Obstacle",
  "디지털 온도센서 (DS18B20)": "Digital temperature sensor (DS18B20)",
  "1-Wire. DQ를 480 µs 이상 Low로 하면(리셋) 센서가 존재 펄스로 답합니다. 쓰기 슬롯은 짧은 Low(1)·긴 Low(0), 읽기 슬롯에서 0이면 센서가 선을 Low로 잡습니다. SKIP ROM(0xCC) → CONVERT T(0x44) → 750 ms 뒤 READ SCRATCHPAD(0xBE). 변환 전에는 85 °C가 읽힙니다. 모듈에 4.7 kΩ 풀업이 있습니다. 센서마다 고유한 64비트 ROM 코드(패밀리 0x28, 48비트 일련번호, CRC8)가 있어 여러 개를 한 선에 이을 수 있습니다(멀티드롭): SEARCH ROM(0xF0)으로 모두 찾고 MATCH ROM(0x55) + 8바이트로 하나를 고릅니다. 여러 개일 때 READ ROM(0x33)은 응답이 겹쳐 CRC가 틀립니다. serial에 16진수 12자리를 쓰면 일련번호가 바뀝니다(비우면 부품 이름에서 정해짐). 센서를 누르고 있으면 손가락 체온(약 {finger} °C)으로 데워지고, 떼면 식습니다.":
    "1-Wire. Hold DQ Low for 480 µs or more (reset) and the sensor answers with a presence pulse. Write slots are a short Low (1) or a long Low (0); in a read slot, a 0 means the sensor holds the line Low. SKIP ROM (0xCC) → CONVERT T (0x44) → after 750 ms, READ SCRATCHPAD (0xBE). Before a conversion it reads 85 °C. The module has a 4.7 kΩ pull-up. Each sensor has a unique 64-bit ROM code (family 0x28, 48-bit serial number, CRC8), so several can share one line (multidrop): find them all with SEARCH ROM (0xF0) and pick one with MATCH ROM (0x55) + 8 bytes. With several, READ ROM (0x33) gets overlapping replies and a wrong CRC. Writing 12 hex digits in serial changes the serial number (left empty, it is derived from the part's name). Hold the sensor down and your fingertip (about {finger} °C) warms it; let go and it cools.",
  "DQ (데이터)": "DQ (data)",
  "문자 LCD 16×2 (I2C)": "Character LCD 16×2 (I2C)",
  "HD44780 LCD에 PCF8574 I2C 백팩(주소 0x27, 일부는 0x3F). 백팩의 P0 RS, P1 RW, P2 E, P3 백라이트, P4–P7 D4–D7. 4비트 모드로 초기화(0x3, 0x3, 0x3, 0x2)한 뒤 바이트를 두 니블로 보냅니다. VCC는 5V.":
    "HD44780 LCD with a PCF8574 I2C backpack (address 0x27, some 0x3F). Backpack P0 RS, P1 RW, P2 E, P3 backlight, P4–P7 D4–D7. Initialize in 4-bit mode (0x3, 0x3, 0x3, 0x2), then send each byte as two nibbles. VCC is 5V.",
  "스테퍼 모터 (28BYJ-48)": "Stepper motor (28BYJ-48)",
  "5 V 단극 스테퍼 + ULN2003 드라이버 보드. IN1–IN4 중 High인 코일이 켜집니다. 반스텝 순서 1, 1+2, 2, 2+3, 3, 3+4, 4, 4+1을 돌면 출력축이 4096 반스텝에 한 바퀴 돕니다. 반스텝 사이가 약 1 ms보다 짧으면 따라가지 못합니다.":
    "5 V unipolar stepper + ULN2003 driver board. The coils whose IN1–IN4 is High are energized. Cycling the half-step sequence 1, 1+2, 2, 2+3, 3, 3+4, 4, 4+1 turns the output shaft one revolution per 4096 half steps. With less than about 1 ms between half steps it cannot keep up.",

  // nucleo.tsx
  "보드 내장 (LD2/B1)": "On board (LD2/B1)",
  "ST-LINK·크리스털 사용": "Used by ST-LINK·crystal",

  // tier6.tsx
  "가속도·자이로 (MPU-6050)": "Accelerometer·gyro (MPU-6050)",
  "GY-521 모듈. I2C 주소 0x68 (AD0을 High로 하면 0x69). 처음엔 잠자기 상태(PWR_MGMT_1 0x6B = 0x40)라 0x6B에 0을 써서 깨워야 측정값이 나옵니다. 0x3B부터 14바이트: 가속도 X·Y·Z, 온도(°C = 값/340 + 36.53), 자이로 X·Y·Z (빅엔디언 int16). 감도: ±2 g 16384 LSB/g, ±250 °/s 131 LSB/(°/s) (0x1C, 0x1B로 범위 변경). 가운데 기판을 마우스로 끌면 기울어집니다 — 좌우는 roll, 위아래는 pitch, 끄는 동안 그 속도가 자이로 값이 됩니다. 빠르게 왔다 갔다 끌거나 '흔들기' 버튼을 누르면 흔들립니다: 0.5초쯤 잦아드는 가속도(ax·ay·az, g)가 중력에 더해집니다. 모듈 가장자리를 끌면 옮겨집니다.":
    "GY-521 module. I2C address 0x68 (0x69 with AD0 High). It starts asleep (PWR_MGMT_1 0x6B = 0x40), so write 0 to 0x6B to wake it before it gives readings. 14 bytes from 0x3B: acceleration X·Y·Z, temperature (°C = value/340 + 36.53), gyro X·Y·Z (big-endian int16). Sensitivity: ±2 g 16384 LSB/g, ±250 °/s 131 LSB/(°/s) (change the ranges with 0x1C, 0x1B). Drag the board in the middle with the mouse to tilt it — left/right is roll, up/down is pitch, and the speed while dragging becomes the gyro reading. Drag back and forth quickly or press the 'Shake' button to shake it: an acceleration (ax·ay·az, g) dying out over about 0.5 s is added to gravity. Drag the module's edge to move it.",
  "Roll (X축 기울기)": "Roll (X-axis tilt)",
  "Pitch (Y축 기울기)": "Pitch (Y-axis tilt)",
  "자이로 X": "Gyro X",
  "자이로 Y": "Gyro Y",
  "자이로 Z": "Gyro Z",
  "흔들림 X (중력 외 가속도)": "Shake X (acceleration besides gravity)",
  "흔들림 Y": "Shake Y",
  "흔들림 Z": "Shake Z",
  "흔들기": "Shake",
  "LED 도트 매트릭스 (MAX7219)": "LED dot matrix (MAX7219)",
  "MAX7219 + 8×8 빨간 LED (FC-16 모듈), count로 1–4개를 이어 붙입니다. CS를 Low로 하고 16비트 프레임(주소, 데이터)을 MSB부터 CLK 상승 에지마다 DIN으로 보낸 뒤 CS를 High로 하면 반영됩니다. 하드웨어 SPI(D13 SCK, D11 MOSI)든 GPIO 비트뱅잉이든 됩니다. 여러 개면 마지막 16×N비트가 남고, 먼저 보낸 프레임이 가장 먼 모듈(오른쪽)로 갑니다. 레지스터에서 밀려난 비트는 16클럭 뒤 DOUT으로 나오므로(CLK 하강 에지에서 바뀜), 따로 놓은 다른 모듈의 DIN을 DOUT에 잇고 CLK·CS를 같이 연결해도 체인이 됩니다 — CS가 올라갈 때 모두 함께 반영됩니다. 레지스터: 0x1–0x8 줄(위부터, 비트 7이 왼쪽), 0x9 디코드, 0xA 밝기(0–15), 0xB 스캔 한도, 0xC 셧다운(처음엔 꺼져 있음, 1로 켬), 0xF 디스플레이 테스트. VCC는 5V.":
    "MAX7219 + 8×8 red LEDs (FC-16 module); count chains 1–4 of them. Pull CS Low, send 16-bit frames (address, data) MSB first on DIN, one bit per CLK rising edge, then raise CS High to apply them. Hardware SPI (D13 SCK, D11 MOSI) or GPIO bit-banging both work. With several, the last 16×N bits stay, and the frame sent first goes to the farthest module (right). Bits pushed out of the register come out on DOUT 16 clocks later (changing on the CLK falling edge), so connecting a separately placed module's DIN to DOUT with CLK·CS shared also makes a chain — all apply together when CS goes up. Registers: 0x1–0x8 rows (from the top, bit 7 on the left), 0x9 decode, 0xA brightness (0–15), 0xB scan limit, 0xC shutdown (off at first, 1 turns it on), 0xF display test. VCC is 5V.",
  "DOUT (체인 출력 → 다음 모듈 DIN)": "DOUT (chain output → next module's DIN)",
  "IR 수신기 + 리모컨 (NEC)": "IR receiver + remote (NEC)",
  "VS1838B 적외선 수신 모듈과 17키 리모컨. 버튼을 누르면 OUT(평소 High, 10 kΩ 풀업)에 복조된 NEC 프레임이 나옵니다: 9 ms Low, 4.5 ms High, 32비트(주소 0x00, ~주소, 명령, ~명령, 각각 LSB부터; 비트마다 562.5 µs Low 뒤 562.5 µs High = 0, 1687.5 µs High = 1), 마지막 562.5 µs Low. 누르고 있으면 108 ms마다 반복 코드(9 ms Low, 2.25 ms High, 562.5 µs Low). 명령: 1=0x45 2=0x46 3=0x47 4=0x44 5=0x40 6=0x43 7=0x07 8=0x15 9=0x09 *=0x16 0=0x19 #=0x0D ▲=0x18 ◀=0x08 OK=0x1C ▶=0x5A ▼=0x52. 타이머 입력 캡처로 하강 에지 사이 시간을 재면 됩니다.":
    "VS1838B infrared receiver module and a 17-key remote. Pressing a button puts a demodulated NEC frame on OUT (normally High, 10 kΩ pull-up): 9 ms Low, 4.5 ms High, 32 bits (address 0x00, ~address, command, ~command, each LSB first; per bit 562.5 µs Low then 562.5 µs High = 0, 1687.5 µs High = 1), and a final 562.5 µs Low. While held, a repeat code every 108 ms (9 ms Low, 2.25 ms High, 562.5 µs Low). Commands: 1=0x45 2=0x46 3=0x47 4=0x44 5=0x40 6=0x43 7=0x07 8=0x15 9=0x09 *=0x16 0=0x19 #=0x0D ▲=0x18 ◀=0x08 OK=0x1C ▶=0x5A ▼=0x52. Measure the time between falling edges with timer input capture.",
  "OUT (신호, Low 활성)": "OUT (signal, active Low)",

  // tier7.tsx
  "STATE (휴대폰 연결 시 High)": "STATE (High when a phone is connected)",
  "RXD (MCU의 TX를 여기에)": "RXD (the MCU's TX goes here)",
  "TXD (MCU의 RX로)": "TXD (to the MCU's RX)",
  "VCC (3.6–6 V, 보통 5V)": "VCC (3.6–6 V, usually 5V)",
  "EN/KEY (전원을 켤 때 High면 AT 모드)": "EN/KEY (High at power-up = AT mode)",
  "연결 대기": "Waiting for connection",
  "연결됨": "Connected",
  "AT 모드": "AT mode",
  "블루투스 모듈 (HC-05)": "Bluetooth module (HC-05)",
  "HC-05 블루투스 시리얼 모듈(ZS-040). 휴대폰과 블루투스로 이어져 UART를 그대로 전달합니다 — 아래 '블루투스 (HC-05)' 탭이 휴대폰 화면입니다. MCU의 TX를 RXD에, TXD를 MCU의 RX에 교차로 연결하세요: USART1은 D8(PA9, TX)·D2(PA10, RX), USART6은 PC6·PC7 또는 PA11·PA12. USART2(D1/D0)는 ST-LINK 가상 COM 포트가 쓰고 있습니다. 데이터 모드는 baud(기본 9600) 8N1 — 펌웨어의 보레이트와 다르면 글자가 깨집니다. 휴대폰이 연결되면 STATE가 High가 되고 LED가 천천히 두 번씩 깜박입니다(대기 중엔 빠르게). EN을 High로 둔 채 전원을 넣으면 38400 baud AT 모드: AT → OK, AT+NAME? → +NAME:HC-05, AT+UART=9600,0,0 등. VCC는 5V(3.6–6 V), 신호는 3.3 V.":
    "HC-05 Bluetooth serial module (ZS-040). It links to a phone over Bluetooth and passes the UART straight through — the 'Bluetooth (HC-05)' tab below is the phone's screen. Cross-connect the MCU's TX to RXD and TXD to the MCU's RX: USART1 is D8 (PA9, TX)·D2 (PA10, RX), USART6 is PC6·PC7 or PA11·PA12. USART2 (D1/D0) is used by the ST-LINK virtual COM port. Data mode is baud (default 9600) 8N1 — if the firmware's baud rate differs, the characters come out garbled. When a phone connects, STATE goes High and the LED blinks slowly twice at a time (quickly while waiting). Power it up with EN held High for AT mode at 38400 baud: AT → OK, AT+NAME? → +NAME:HC-05, AT+UART=9600,0,0, etc. VCC is 5V (3.6–6 V), signals are 3.3 V.",
  "릴레이 모듈 (5V, 1채널)": "Relay module (5V, 1 channel)",
  "SRD-05VDC-SL-C 릴레이에 구동 트랜지스터·다이오드·LED가 달린 모듈. VCC는 5V(코일은 3.75 V 이상에서 붙음), IN으로 코일을 켭니다: trigger=low(흔한 모듈)는 IN을 Low로, high는 High로 하면 켜집니다. 코일이 켜지면 약 10 ms 뒤 COM이 NC에서 NO로 넘어가고(접점이 잠깐 튑니다), 끄면 5 ms 뒤 돌아옵니다. 접점은 MCU와 전기적으로 분리된 스위치라 다른 전원(5V 등)으로 램프·LED·모터를 켤 수 있습니다: 전원 → COM, NO → 부하 → GND.":
    "An SRD-05VDC-SL-C relay on a module with a driver transistor·diode·LED. VCC is 5V (the coil pulls in from 3.75 V); IN drives the coil: with trigger=low (the common module) it turns on when IN is Low, with high when IN is High. When the coil turns on, COM moves from NC to NO after about 10 ms (the contact bounces briefly), and returns 5 ms after it turns off. The contact is a switch electrically isolated from the MCU, so it can switch a lamp·LED·motor from another supply (5V, etc.): supply → COM, NO → load → GND.",
  "IN (코일 제어)": "IN (coil control)",
  "NO (평상시 열림: 켜지면 COM과 연결)": "NO (normally open: connected to COM when on)",
  "NC (평상시 닫힘: 꺼져 있을 때 COM과 연결)": "NC (normally closed: connected to COM when off)",
  "COM–NO 연결": "COM–NO connected",
  "COM–NC 연결": "COM–NC connected",

  // tier8.tsx
  "DS / SER (14, 직렬 데이터 입력)": "DS / SER (14, serial data input)",
  "OE (13, Low면 출력 켜짐)": "OE (13, Low = outputs on)",
  "STCP / RCLK (12, 상승 에지에 출력 래치)": "STCP / RCLK (12, latches the outputs on a rising edge)",
  "SHCP / SRCLK (11, 상승 에지에 한 칸 시프트)": "SHCP / SRCLK (11, shifts one stage on a rising edge)",
  "MR (10, Low면 시프트 레지스터 지움)": "MR (10, Low = clears the shift register)",
  "Q7' (9, 직렬 출력 → 다음 595의 DS)": "Q7' (9, serial output → next 595's DS)",
  "시프트 레지스터 (74HC595)": "Shift register (74HC595)",
  "8비트 직렬 입력·병렬 출력 시프트 레지스터(DIP-16). SHCP(SRCLK)가 올라갈 때마다 DS의 비트가 Q0으로 들어오고 나머지는 한 칸씩 밀려 7번째 단은 Q7'으로 나옵니다. STCP(RCLK)가 올라가는 순간 시프트 레지스터가 출력 Q0–Q7에 한꺼번에 옮겨집니다 — 그 전까지 출력은 그대로입니다. OE를 High로 하면 Q0–Q7이 끊깁니다(하이 임피던스): 보통 GND에 연결. MR을 Low로 하면 시프트 레지스터가 지워집니다: 보통 VCC에 연결. Q7'을 다음 595의 DS에, SHCP·STCP를 같이 연결하면 16, 24…개의 출력으로 늘어납니다. GPIO 비트뱅잉도, 하드웨어 SPI(D13 SCK → SHCP, D11 MOSI → DS, GPIO → STCP, MSB 먼저 보내면 비트 n이 Qn)도 됩니다. 출력에는 LED마다 저항(330 Ω 등)을 다세요. 출력 High는 3.3 V로 계산합니다.":
    "8-bit serial-in, parallel-out shift register (DIP-16). Each time SHCP (SRCLK) rises, the bit on DS enters Q0 and the rest move along one stage, the 7th stage coming out on Q7'. The moment STCP (RCLK) rises, the shift register is copied to the outputs Q0–Q7 all at once — until then the outputs stay as they are. OE High disconnects Q0–Q7 (high impedance): usually tie it to GND. MR Low clears the shift register: usually tie it to VCC. Connect Q7' to the next 595's DS, with SHCP·STCP shared, to extend to 16, 24… outputs. GPIO bit-banging works, and so does hardware SPI (D13 SCK → SHCP, D11 MOSI → DS, GPIO → STCP; sent MSB first, bit n lands on Qn). Put a resistor (330 Ω, etc.) on each LED on the outputs. An output High is taken as 3.3 V.",
  "{id} (병렬 출력)": "{id} (parallel output)",
  "출력 꺼짐 (OE High)": "Outputs off (OE High)",
  "4자리 7세그먼트 (TM1637)": "4-digit 7-segment (TM1637)",
  "TM1637 구동 칩이 붙은 4자리 7세그먼트 모듈(가운데 콜론). 핀 두 개(CLK, DIO)로 쓰지만 I2C가 아닙니다: 시작은 CLK가 High일 때 DIO를 내리고, 끝은 CLK가 High일 때 DIO를 올립니다. 바이트는 LSB부터, CLK 상승 에지마다 한 비트씩 읽히고, 8번째 비트 뒤 칩이 한 클럭 동안 DIO를 Low로 당겨 응답(ACK)합니다 — DIO는 오픈 드레인으로 놓아 두어야 읽을 수 있습니다(모듈에 10 kΩ 풀업). 명령: 0x40 데이터(주소 자동 증가) / 0x44 고정 주소, 0xC0–0xC3 자리 주소 뒤에 세그먼트 바이트(비트 0 = a … 비트 6 = g, 둘째 자리의 비트 7 = 콜론), 0x88 | 밝기(0–7) 표시 켜기, 0x80 끄기. CLK는 250 kHz 이하(반주기 2 µs 이상). VCC는 3.3–5 V.":
    "4-digit 7-segment module with a TM1637 driver chip (colon in the middle). It uses two pins (CLK, DIO) but is not I2C: start is DIO falling while CLK is High, stop is DIO rising while CLK is High. Bytes go LSB first, one bit read per CLK rising edge; after the 8th bit the chip acknowledges (ACK) by pulling DIO Low for one clock — DIO must be left open-drain to read it (10 kΩ pull-up on the module). Commands: 0x40 data (auto-increment address) / 0x44 fixed address, 0xC0–0xC3 digit address followed by segment bytes (bit 0 = a … bit 6 = g, bit 7 of the second digit = colon), 0x88 | brightness (0–7) display on, 0x80 off. CLK at most 250 kHz (half period 2 µs or more). VCC is 3.3–5 V.",
  "DIO (데이터, 양방향)": "DIO (data, bidirectional)",
  "밝기 {level}/7": "Brightness {level}/7",
  "표시 꺼짐": "Display off",
  "조이스틱 (KY-023)": "Joystick (KY-023)",
  "2축 아날로그 조이스틱 모듈. 10 kΩ 가변저항 두 개가 GND와 +5V 사이에 있고 와이퍼가 VRx, VRy입니다: 왼쪽으로 기울이면 VRx가 0 V 쪽, 위로 기울이면 VRy가 전원 쪽으로 갑니다(가운데 절반). 스틱을 누르면 SW가 GND에 붙습니다 — 모듈에 풀업이 없으니 GPIO 내부 풀업을 켜세요. +5V는 3V3에 연결하세요: 5 V면 와이퍼가 3.3 V를 넘어 ADC 핀(5 V 내성 아님)을 넘깁니다. 손잡이를 끌어 기울이면 놓을 때 가운데로 돌아오고, 움직이지 않고 누르면(클릭) SW가 눌립니다.":
    "2-axis analog joystick module. Two 10 kΩ potentiometers sit between GND and +5V, with wipers VRx and VRy: tilting left moves VRx toward 0 V, tilting up moves VRy toward the supply (half at the center). Pressing the stick connects SW to GND — the module has no pull-up, so turn on the GPIO's internal pull-up. Connect +5V to 3V3: at 5 V the wipers go above 3.3 V and overdrive the ADC pins (not 5 V tolerant). Drag the knob to tilt it and it returns to the center when released; press without moving (click) to press SW.",
  "+5V (VCC, 보통 3V3에)": "+5V (VCC, usually to 3V3)",
  "VRx (X축 아날로그)": "VRx (X-axis analog)",
  "VRy (Y축 아날로그)": "VRy (Y-axis analog)",
  "SW (누르면 GND)": "SW (GND when pressed)",
  "X (0 왼쪽 … 1 오른쪽)": "X (0 left … 1 right)",
  "Y (0 아래 … 1 위)": "Y (0 down … 1 up)",
  "SW 누름 (1)": "SW pressed (1)",
  "준비 중 (워밍업)": "Starting up (warm-up)",
  "감지 대기": "Waiting for motion",
  "감지! OUT High": "Detected! OUT High",
  "차단 시간 (2.5 s)": "Block time (2.5 s)",
  "PIR 인체 감지 센서 (HC-SR501)": "PIR motion sensor (HC-SR501)",
  "적외선(PIR) 움직임 센서 모듈. 사람이 시야(부채꼴) 안에서 움직이면 OUT이 3.3 V(High)가 됩니다. 유지 시간 delay(모듈의 Tx 가변저항, 실제 0.3초–5분, 여기선 기본 3초): mode H(재트리거)는 마지막 움직임부터, mode L(단발)은 처음 감지부터 셉니다. OUT이 Low로 돌아온 뒤 약 2.5초는 아무것도 감지하지 않습니다(차단 시간). 전원을 넣고 warmup초(실제 30–60초, 여기선 기본 3초) 동안은 안정화 중이라 감지하지 않습니다. VCC는 5V(4.5–20 V) — 3V3에서는 동작하지 않습니다. 사람을 끌어 부채꼴 안을 지나가게 하거나 '움직임' 버튼을 누르세요.":
    "Passive infrared (PIR) motion sensor module. When a person moves within its field of view (the fan), OUT goes to 3.3 V (High). Hold time delay (the module's Tx trimmer, really 0.3 s–5 min, here 3 s by default): mode H (retrigger) counts from the last motion, mode L (single) from the first detection. For about 2.5 s after OUT returns Low it detects nothing (block time). For warmup seconds after power-up (really 30–60 s, here 3 s by default) it is settling and does not detect. VCC is 5V (4.5–20 V) — it does not work on 3V3. Drag the person through the fan or press the 'Motion' button.",
  "OUT (움직임 시 3.3 V)": "OUT (3.3 V on motion)",
  "유지 시간 (Tx)": "Hold time (Tx)",
  "워밍업": "Warm-up",
  "움직임 (1 = 있음)": "Motion (1 = yes)",
  "L 단발": "L single",
  "H 재트리거": "H retrigger",
  "움직임": "Motion",
  "기압·온도 센서 (BMP280)": "Pressure·temperature sensor (BMP280)",
  "Bosch BMP280 기압계 모듈(I2C). 주소 0x76(SDO를 GND에), 0x77(SDO를 VCC에). 칩 ID 0xD0 = 0x58, 0xE0에 0xB6을 쓰면 리셋. 0x88–0x9F에 공장 보정값(dig_T1–T3, dig_P1–P9, 리틀 엔디언; 데이터시트 예제 값)이 있고, 0xF4(ctrl_meas)에 온도·기압 오버샘플링과 모드(00 잠자기, 01 강제 측정 한 번, 11 연속)를 씁니다. 강제 측정 중엔 0xF3 비트 3이 1, 끝나면 0xF7부터 기압 20비트, 0xFA부터 온도 20비트 원시값이 들어 있습니다 — 데이터시트의 보정 공식(정수 코드)을 돌리면 설정한 온도·기압이 나옵니다. 오버샘플링 0(건너뜀)이면 0x80000. 고도 ≈ 44330 × (1 − (P/1013.25)^0.1903) m. IIR 필터와 대기 시간은 시뮬레이션하지 않습니다. 센서를 누르고 있으면 손가락 체온으로 데워집니다. VCC 3V3.":
    "Bosch BMP280 barometer module (I2C). Address 0x76 (SDO to GND), 0x77 (SDO to VCC). Chip ID 0xD0 = 0x58; writing 0xB6 to 0xE0 resets it. 0x88–0x9F hold the factory calibration (dig_T1–T3, dig_P1–P9, little-endian; the datasheet's example values), and 0xF4 (ctrl_meas) takes the temperature·pressure oversampling and the mode (00 sleep, 01 one forced measurement, 11 normal). During a forced measurement bit 3 of 0xF3 is 1; when done, the raw 20-bit pressure is at 0xF7 and the raw 20-bit temperature at 0xFA — running the datasheet's compensation formulas (integer code) gives the temperature·pressure you set. With oversampling 0 (skipped) it reads 0x80000. Altitude ≈ 44330 × (1 − (P/1013.25)^0.1903) m. The IIR filter and standby time are not simulated. Hold the sensor down and your fingertip warms it. VCC 3V3.",
  "기압": "Pressure",

  // tier9.tsx
  "DC 전원 (배터리/어댑터)": "DC supply (battery/adapter)",
  "모터용 직류 전원: 12 V 어댑터, 3S 리튬폴리머(11.1 V) 배터리 등. 보드의 5V·3V3로는 스텝 드라이버(VMOT 8 V 이상)나 ESC를 돌릴 수 없습니다. +를 모터 전원 입력(VMOT, 12V, PVDD, BAT+)에, −를 GND에 연결하고, 신호의 기준이 같도록 −를 Nucleo의 GND와도 이어 주세요(공통 접지). 전압은 슬라이더로 바꿉니다.":
    "DC supply for motors: a 12 V adapter, a 3S LiPo (11.1 V) battery, etc. The board's 5V·3V3 cannot run a step driver (VMOT 8 V or more) or an ESC. Connect + to the motor supply input (VMOT, 12V, PVDD, BAT+) and − to GND, and also join − to the Nucleo's GND so the signals share a reference (common ground). Change the voltage with the slider.",
  "+ (모터 전원)": "+ (motor supply)",
  "전압": "Voltage",
  "+ 빨강 · − 검정": "+ red · − black",
  "A+ (검정, 코일 A)": "A+ (black, coil A)",
  "A− (초록, 코일 A)": "A− (green, coil A)",
  "B+ (빨강, 코일 B)": "B+ (red, coil B)",
  "B− (파랑, 코일 B)": "B− (blue, coil B)",
  "스테퍼 모터 (NEMA17 바이폴라)": "Stepper motor (NEMA17 bipolar)",
  "42 mm NEMA17 바이폴라 스테퍼: 코일 두 개(A: A+/A−, B: B+/B−), 한 바퀴 200스텝(1.8°), 홀딩 토크 40 N·cm. 두 코일 전류의 방향 벡터 atan2(I_B, I_A)가 회전자를 끌어당기고, 전기각 한 주기(360°)가 4스텝 = 7.2°입니다. 드라이버(A4988/DRV8825 또는 L298N)의 출력 쌍에 코일 하나씩 연결하세요(1A/1B → A+/A−, 2A/2B → B+/B−). 한 코일의 두 선을 바꾸면 반대로 돕니다. 멈춘 상태에서 갑자기 빠르게(약 1100 스텝/s 이상) 스텝을 주거나 부하가 토크보다 크면 회전자가 자기장을 놓쳐 스텝을 잃습니다(탈조) — 가속 램프로 천천히 올리세요. 드라이버가 꺼져 있으면(EN High) 축을 손으로 돌릴 수 있고, 켜져 있으면 홀딩 토크가 되돌립니다. 부하(브레이크) 슬라이더로 탈조를 일으켜 보세요.":
    "42 mm NEMA17 bipolar stepper: two coils (A: A+/A−, B: B+/B−), 200 steps per revolution (1.8°), holding torque 40 N·cm. The direction vector of the two coil currents, atan2(I_B, I_A), pulls the rotor, and one electrical cycle (360°) is 4 steps = 7.2°. Connect one coil to each output pair of the driver (A4988/DRV8825 or L298N) (1A/1B → A+/A−, 2A/2B → B+/B−). Swapping the two wires of one coil reverses the direction. Stepping suddenly fast from standstill (above about 1100 steps/s) or a load larger than the torque makes the rotor lose the field and miss steps (stall) — ramp up slowly with acceleration. With the driver off (EN High) you can turn the shaft by hand; with it on, the holding torque pulls it back. Try causing a stall with the load (brake) slider.",
  "부하 (브레이크)": "Load (brake)",
  "축에 단 관성": "Inertia on the shaft",
  "{angle}° · {steps} 스텝 · {rpm} rpm": "{angle}° · {steps} steps · {rpm} rpm",
  "탈조! ": "Stall! ",
  "잃은 스텝 {lost}": "Lost steps {lost}",
  "EN (Low = 출력 켜짐, 보드에서 풀다운)": "EN (Low = outputs on, pulled down on the board)",
  "MS1 / M0 (마이크로스텝, 풀다운)": "MS1 / M0 (microstep, pull-down)",
  "MS2 / M1 (마이크로스텝, 풀다운)": "MS2 / M1 (microstep, pull-down)",
  "MS3 / M2 (마이크로스텝, 풀다운)": "MS3 / M2 (microstep, pull-down)",
  "RST (Low = 리셋, 떠 있음: SLP에 연결)": "RST (Low = reset, floating: connect to SLP)",
  "SLP (Low = 절전, 보드에서 풀업)": "SLP (Low = sleep, pulled up on the board)",
  "STEP (상승 에지마다 한 마이크로스텝)": "STEP (one microstep per rising edge)",
  "DIR (회전 방향)": "DIR (direction)",
  "VMOT (모터 전원 8–35 V)": "VMOT (motor supply 8–35 V)",
  "GND (모터 전원)": "GND (motor supply)",
  "2B (코일 B)": "2B (coil B)",
  "2A (코일 B)": "2A (coil B)",
  "1A (코일 A)": "1A (coil A)",
  "1B (코일 A)": "1B (coil A)",
  "VDD (로직 전원 3–5.5 V, 3V3에)": "VDD (logic supply 3–5.5 V, to 3V3)",
  "GND (로직)": "GND (logic)",
  "출력 켜짐": "Outputs on",
  "꺼짐 (EN High)": "Off (EN High)",
  "절전 (SLP Low)": "Sleep (SLP Low)",
  "리셋 (RST Low)": "Reset (RST Low)",
  "VMOT 없음": "No VMOT",
  "VDD 없음": "No VDD",
  "스텝 드라이버 (A4988 / DRV8825)": "Step driver (A4988 / DRV8825)",
  "바이폴라 스테퍼용 스텝/방향 드라이버 캐리어 보드(Pololu 형). STEP 핀이 Low→High로 바뀔 때마다 DIR 방향으로 한 마이크로스텝 움직이고, 코일 전류를 사인/코사인 표에 맞춰 조절합니다(1A/1B = 코일 A, 2A/2B = 코일 B). 마이크로스텝(MS1 MS2 MS3): 000 풀, 100 1/2, 010 1/4, 110 1/8, 111 1/16. model을 DRV8825로 바꾸면 M0 M1 M2: 001 1/16, 101·011·111 1/32. STEP 펄스는 High·Low 모두 1 µs 이상(DRV8825는 1.9 µs). EN이 High, SLP가 Low, RST가 Low이면 출력이 꺼져 모터가 헐거워집니다 — RST는 보드에서 떠 있으니 SLP에 연결하세요. VMOT에 8–35 V 모터 전원(DC 전원 부품)과 GND, VDD에 3V3(A4988의 High 판정은 0.7 × VDD). current는 전류 제한 가변저항(Vref)으로 정한 정격 전류의 비율입니다.":
    "Step/direction driver carrier board for bipolar steppers (Pololu style). Each time the STEP pin goes Low→High it moves one microstep in the DIR direction, setting the coil currents from a sine/cosine table (1A/1B = coil A, 2A/2B = coil B). Microsteps (MS1 MS2 MS3): 000 full, 100 1/2, 010 1/4, 110 1/8, 111 1/16. With model set to DRV8825, M0 M1 M2: 001 1/16, 101·011·111 1/32. STEP pulses must be at least 1 µs both High and Low (1.9 µs for the DRV8825). EN High, SLP Low or RST Low turns the outputs off and the motor goes slack — RST floats on the board, so connect it to SLP. VMOT takes an 8–35 V motor supply (the DC supply part) and GND; VDD takes 3V3 (the A4988 reads High from 0.7 × VDD). current is the fraction of the rated current set by the current-limit trimmer (Vref).",
  "전류 제한 (Vref)": "Current limit (Vref)",
  "{micro} 스텝": "{micro} step",
  "12V (모터 전원 VS, 7 V 이상이면 보드의 5 V 레귤레이터도 동작)": "12V (motor supply VS; from 7 V the board's 5 V regulator also works)",
  "5V (로직 전원 입력/출력)": "5V (logic supply input/output)",
  "ENA (브리지 A 켜기, PWM — jumpers=off일 때)": "ENA (bridge A enable, PWM — when jumpers=off)",
  "ENB (브리지 B 켜기, PWM — jumpers=off일 때)": "ENB (bridge B enable, PWM — when jumpers=off)",
  "OUT1 (브리지 A)": "OUT1 (bridge A)",
  "OUT2 (브리지 A)": "OUT2 (bridge A)",
  "OUT3 (브리지 B)": "OUT3 (bridge B)",
  "OUT4 (브리지 B)": "OUT4 (bridge B)",
  "H-브리지 모듈 (L298N, 2채널)": "H-bridge module (L298N, 2 channels)",
  "L298N 듀얼 H-브리지 모듈. 브리지 A: IN1·IN2 → OUT1·OUT2, 브리지 B: IN3·IN4 → OUT3·OUT4. IN1 High·IN2 Low면 OUT1→OUT2 방향, 반대면 반대 방향, 같으면 브레이크(전류 0). ENA/ENB가 Low면 그 브리지가 꺼지고, PWM을 주면 코일 전류가 듀티만큼으로 평균됩니다 — 모듈의 ENA/ENB 점퍼를 빼야(jumpers=off) 핀이 쓰입니다. 바이폴라 스테퍼는 코일 A를 OUT1/OUT2에, 코일 B를 OUT3/OUT4에 연결하고 펌웨어가 풀스텝(A+, B+, A−, B−) 또는 반스텝(A+, A+B+, B+, …) 순서를 직접 만듭니다. 순서가 틀려 자기장이 180° 뒤집히면(예: A+ 다음 A−) 회전자가 어느 쪽으로 돌지 몰라 떨기만 합니다. 12V에 모터 전원, GND는 Nucleo와 공통. 입력의 High는 2.3 V 이상(3.3 V 출력으로 됨).":
    "L298N dual H-bridge module. Bridge A: IN1·IN2 → OUT1·OUT2, bridge B: IN3·IN4 → OUT3·OUT4. IN1 High·IN2 Low drives OUT1→OUT2, the other way round the opposite direction, and equal inputs brake (zero current). ENA/ENB Low turns that bridge off, and PWM on them averages the coil current by the duty — the pins are used only with the module's ENA/ENB jumpers removed (jumpers=off). For a bipolar stepper, connect coil A to OUT1/OUT2 and coil B to OUT3/OUT4; the firmware makes the full-step (A+, B+, A−, B−) or half-step (A+, A+B+, B+, …) sequence itself. If a wrong sequence flips the field by 180° (e.g. A+ then A−), the rotor cannot tell which way to turn and just jitters. Motor supply on 12V, GND shared with the Nucleo. An input reads High from 2.3 V (a 3.3 V output works).",
  "12V 없음": "No 12V",
  "꺼짐 (배터리 없음)": "Off (no battery)",
  "신호 대기": "Waiting for signal",
  "아밍 중… (최저 스로틀 1초)": "Arming… (minimum throttle 1 s)",
  "아밍 거부 — 스로틀을 내리세요": "Arming refused — lower the throttle",
  "아밍됨": "Armed",
  "페일세이프 — 신호 끊김": "Failsafe — signal lost",
  "ESC + 브러시리스 모터 (프로펠러)": "ESC + brushless motor (propeller)",
  "취미용 ESC(BLHeli 계열)와 아웃러너 BLDC 모터, 프로펠러. 신호는 서보와 같은 50 Hz 펄스: 1000 µs = 정지 … 2000 µs = 최대 스로틀. 전원을 넣은 뒤 최저 스로틀(1000 µs)을 1초 이상 받아야 '아밍'되어 돌기 시작합니다(삐 소리) — 처음부터 스로틀이 올라가 있으면 아밍을 거부합니다. 신호가 0.5초 넘게 끊기면 페일세이프로 모터를 멈추고 다시 아밍해야 합니다. 최고 속도는 KV × 배터리 전압(1000 KV × 11.1 V = 11100 rpm), 속도는 스로틀을 1차 지연으로 따라갑니다. BAT+/BAT−에 배터리(DC 전원 부품, 2–4S: 7–17 V), SIG를 PWM 핀에, GND를 Nucleo GND에. 부하 슬라이더로 프로펠러를 잡아 보세요.":
    "A hobby ESC (BLHeli type) with an outrunner BLDC motor and a propeller. The signal is the same 50 Hz pulse as a servo's: 1000 µs = stop … 2000 µs = full throttle. After power-up it must receive minimum throttle (1000 µs) for at least 1 s to 'arm' and start turning (beep) — if the throttle is up from the start, it refuses to arm. If the signal is lost for more than 0.5 s, the failsafe stops the motor and it must be armed again. Top speed is KV × battery voltage (1000 KV × 11.1 V = 11100 rpm); the speed follows the throttle with a first-order lag. Battery on BAT+/BAT− (the DC supply part, 2–4S: 7–17 V), SIG to a PWM pin, GND to the Nucleo's GND. Try holding the propeller with the load slider.",
  "SIG (흰색/노랑, 서보 펄스)": "SIG (white/yellow, servo pulse)",
  "GND (검정, 신호 기준 = 배터리 −)": "GND (black, signal reference = battery −)",
  "BAT+ (빨강, 배터리 +)": "BAT+ (red, battery +)",
  "BAT− (검정, 배터리 −)": "BAT− (black, battery −)",
  "모터 KV": "Motor KV",
  "부하 (프로펠러 잡기)": "Load (holding the propeller)",
  "스로틀 {pct} %": "Throttle {pct} %",
  "♪ 삐 ×{n}": "♪ Beep ×{n}",
  "모터가 막힘!": "Motor blocked!",
  "배터리 없음": "No battery",
  "U (상 1, 노랑)": "U (phase 1, yellow)",
  "V (상 2, 초록)": "V (phase 2, green)",
  "W (상 3, 파랑)": "W (phase 3, blue)",
  "HA (홀 A, 오픈 컬렉터: 풀업 필요)": "HA (Hall A, open collector: needs a pull-up)",
  "HB (홀 B, 오픈 컬렉터)": "HB (Hall B, open collector)",
  "HC (홀 C, 오픈 컬렉터)": "HC (Hall C, open collector)",
  "VCC (홀 센서 전원 5V)": "VCC (Hall sensor supply 5V)",
  "BLDC 모터 (홀 센서)": "BLDC motor (Hall sensors)",
  "3상 BLDC 모터(42BLY 계열, 4극쌍, 12 V에서 약 3300 rpm)와 홀 센서 세 개. 홀 A·B·C(코드 = C B A 비트)가 회전자가 여섯 개의 60° 구간 중 어디 있는지 알려 줍니다: 101 → U+ W−, 001 → V+ W−, 011 → V+ U−, 010 → W+ U−, 110 → W+ V−, 100 → U+ V−. 펌웨어가 홀 인터럽트(EXTI, 양쪽 에지)마다 3상 브리지의 상 하나를 전원에, 하나를 GND에 연결하면(6스텝 정류) 다음 구간으로 끌려가며 돕니다. 표가 틀리거나 홀·상을 바꿔 연결하면 제자리에서 떨거나 멈춥니다. 홀 출력은 오픈 컬렉터라 핀의 풀업(GPIO_PULLUP)이나 10 kΩ 풀업이 필요합니다. U·V·W를 브리지의 OUTA·OUTB·OUTC에, VCC를 5V에.":
    "3-phase BLDC motor (42BLY type, 4 pole pairs, about 3300 rpm at 12 V) with three Hall sensors. Hall A·B·C (code = bits C B A) tell which of six 60° sectors the rotor is in: 101 → U+ W−, 001 → V+ W−, 011 → V+ U−, 010 → W+ U−, 110 → W+ V−, 100 → U+ V−. If the firmware, on each Hall interrupt (EXTI, both edges), connects one phase of the 3-phase bridge to the supply and one to GND (6-step commutation), the rotor is pulled into the next sector and turns. A wrong table or swapped Hall·phase wiring makes it jitter in place or stop. The Hall outputs are open collector, so they need the pin's pull-up (GPIO_PULLUP) or a 10 kΩ pull-up. U·V·W to the bridge's OUTA·OUTB·OUTC, VCC to 5V.",
  "멈춤! 정류가 홀과 맞지 않음": "Stalled! Commutation does not match the Hall sensors",
  "멈춤! 정류가 회전자와 맞지 않음": "Stalled! Commutation does not match the rotor",
  "홀 센서 전원 없음": "No Hall sensor supply",
  "BLDC 모터 (센서리스)": "BLDC motor (sensorless)",
  "홀 센서 없는 3상 BLDC 모터(홀 센서 BLDC와 같은 모터: 4극쌍, 상 저항 1 Ω, 12 V에서 약 3300 rpm). 회전자 위치는 역기전력으로 압니다: 6스텝에서 떠 있는 상의 전압은 중성점(별결선 중심) 전압에 그 상의 역기전력을 더한 값이라, 각 60° 구간의 가운데에서 중성점을 지나갑니다(영점). 영점에서 30° 뒤에 정류하면 됩니다. 멈춰 있으면 역기전력이 없어 먼저 한 스텝으로 정렬하고, 열린 루프로 점점 빠르게 정류한 뒤 영점을 따라갑니다. 상마다 10 kΩ/2.2 kΩ 분압기를 ADC 핀에, 세 분압점을 10 kΩ 세 개로 모으면 가상 중성점이 됩니다. U·V·W를 3상 브리지의 OUTA·OUTB·OUTC에.":
    "3-phase BLDC motor without Hall sensors (the same motor as the Hall-sensor BLDC: 4 pole pairs, phase resistance 1 Ω, about 3300 rpm at 12 V). The rotor position is known from the back-EMF: in 6-step drive the floating phase's voltage is the neutral point (star center) voltage plus that phase's back-EMF, so it crosses the neutral in the middle of each 60° sector (zero crossing). Commutate 30° after the zero crossing. At standstill there is no back-EMF, so first align with one step, commutate faster and faster in open loop, then follow the zero crossings. Put a 10 kΩ/2.2 kΩ divider from each phase to an ADC pin; joining the three divider points with three 10 kΩ resistors makes a virtual neutral. U·V·W to the 3-phase bridge's OUTA·OUTB·OUTC.",
  "3상 브리지 모듈 (DRV8302 형)": "3-phase bridge module (DRV8302 style)",
  "BLDC용 3상 하프 브리지 모듈. 상마다 하이사이드(INHx: 출력을 PVDD에)와 로사이드(INLx: 출력을 GND에) 스위치 입력이 있고, 둘 다 Low면 출력이 떠 있습니다. 한 상의 INH와 INL을 동시에 High로 하면 전원이 단락(관통 전류, shoot-through)되므로 모듈이 그 상을 끄고 경고합니다. 스위치(MOSFET)가 꺼지는 데 150 ns쯤 걸리므로, 한쪽이 꺼진 뒤 그보다 빨리 다른 쪽이 켜져도 관통 전류입니다 — TIM1 상보 출력(CHx/CHxN)에 데드타임(BDTR.DTG)을 넣는 이유. 입력을 2 kHz 이상 PWM으로 켜고 끄면 주기마다 듀티를 재어 상 전압을 평균(듀티 × PVDD)으로 모터에 주므로 듀티가 곧 토크·속도입니다. 정적인 GPIO로 켜도 됩니다. 막대: 스위치마다 켜져 있던 비율. 입력은 보드에서 풀다운, High는 2 V 이상. PVDD에 6–60 V 모터 전원(DC 전원 부품), GND는 Nucleo와 공통.":
    "3-phase half-bridge module for BLDC motors. Each phase has a high-side (INHx: output to PVDD) and a low-side (INLx: output to GND) switch input; with both Low the output floats. Driving a phase's INH and INL High at the same time shorts the supply (shoot-through current), so the module turns that phase off and warns. A switch (MOSFET) takes about 150 ns to turn off, so turning the other side on sooner than that after one turns off is also shoot-through — the reason for dead time (BDTR.DTG) on the TIM1 complementary outputs (CHx/CHxN). Switching the inputs with PWM at 2 kHz or more, the module measures the duty each period and gives the motor the average phase voltage (duty × PVDD), so the duty is the torque·speed. Static GPIO works too. Bars: the fraction of time each switch was on. Inputs are pulled down on the board; High is 2 V or more. PVDD takes a 6–60 V motor supply (the DC supply part), GND shared with the Nucleo.",
  "하이사이드": "high side",
  "로사이드": "low side",
  "PVDD (모터 전원 6–60 V)": "PVDD (motor supply 6–60 V)",
  "H 위 · L 아래 · 막대 듀티": "H top · L bottom · bar duty",
  "PVDD 없음": "No PVDD",
  "관통!": "Shoot-through!",

  // timing.tsx
  "DIN (데이터 입력)": "DIN (data input)",
  "DOUT (데이터 출력 → 다음 NeoPixel의 DIN)": "DOUT (data output → next NeoPixel's DIN)",
  "WS2812B: 800 kHz로 LED마다 24비트(G, R, B 순서, 상위 비트 먼저)를 보냅니다. 비트 0은 0.4 µs, 1은 0.8 µs High이고, 50 µs 이상 Low면 표시가 바뀝니다. LED는 처음 24비트씩 갖고 나머지는 DOUT으로 넘기므로, DOUT을 다른 NeoPixel의 DIN에 이으면 한 줄로 이어집니다(앞 부품의 LED 다음 번호부터). VCC는 5V(3.5 V 이상).":
    "WS2812B: send 24 bits per LED (G, R, B order, most significant bit first) at 800 kHz. A 0 bit is 0.4 µs High, a 1 is 0.8 µs, and Low for 50 µs or more updates the display. Each LED keeps the first 24 bits and passes the rest to DOUT, so connecting DOUT to another NeoPixel's DIN chains them into one line (numbered on from the previous part's LEDs). VCC is 5V (3.5 V or more).",
  "NeoPixel 링": "NeoPixel ring",
  "NeoPixel 스트립 (8)": "NeoPixel strip (8)",
  "NeoPixel 매트릭스 8×8": "NeoPixel matrix 8×8",
  "{hint} LED 번호는 줄마다 왼쪽에서 오른쪽(0–7, 8–15, …)입니다.":
    "{hint} The LEDs are numbered left to right in each row (0–7, 8–15, …).",
  "온습도 센서 (DHT22/DHT11)": "Temperature & humidity sensor (DHT22/DHT11)",
  "단선 통신. MCU가 DATA를 Low로 잡았다 놓으면(DHT22 1 ms 이상, DHT11 18 ms 이상) 센서가 80 µs Low, 80 µs High 후 40비트(습도 16, 온도 16, 체크섬 8)를 보냅니다. 비트마다 50 µs Low 뒤 High가 약 27 µs면 0, 70 µs면 1. 모듈에 10 kΩ 풀업이 있습니다. 센서를 누르고 있으면 손가락 체온(약 {finger} °C)과 입김(습도 {breath} %)으로 값이 오르고, 떼면 원래대로 돌아옵니다.":
    "Single-wire protocol. When the MCU pulls DATA Low and releases it (DHT22 1 ms or more, DHT11 18 ms or more), the sensor answers with 80 µs Low, 80 µs High, then sends 40 bits (humidity 16, temperature 16, checksum 8). Each bit is 50 µs Low followed by High: about 27 µs means 0, 70 µs means 1. The module has a 10 kΩ pull-up. Hold the sensor down and your fingertip (about {finger} °C) and breath (humidity {breath} %) raise the readings; let go and they return.",
};
