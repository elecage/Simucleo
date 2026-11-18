# Simucleo

교육용 **STM32 Nucleo-F401RE 시뮬레이터**. 브라우저에서 펌웨어(ELF)를 업로드하면 Cortex-M4F 코어가
기계어를 실행하고, 내부 Peripheral과 브레드보드 위 외부 부품(LED, 버저, 모터, 센서, OLED 등)을 함께
시뮬레이션해 준실시간으로 보여 준다.

**웹에서 바로 써 보기: https://elecage.github.io/Simucleo/** (`main`에 병합될 때마다 자동 배포)

![PWM으로 RGB LED와 LD2 밝기 제어](docs/images/m3-pwm-rgb.png)

> **상태: M7 완료.** DMA가 타이머 PWM에 듀티 값을 넣어 NeoPixel에 무지개를 그리고, 입력 캡처로 DHT22를
> 읽는다. 회로 쪽 센서가 스스로 신호를 보내는 단선 통신도 실제 타이밍으로 동작한다.
>
> **M6:** I2C·SPI로 OLED에 그림을 그리고, RTC 시계와 온습도 센서를 읽고, SD 카드에 FatFs로 기록한다.
> SD 카드 내용은 디스크 이미지로 내려받거나 넣을 수 있다.
>
> **M5:** 가변저항·조도센서·온도센서를 ADC로 읽고, 서보와 DC 모터를 움직인다.
>
> **M4:** CubeMX로 만든 FreeRTOS(CMSIS-RTOS v2) 펌웨어가 수정 없이 실행되고, RTOS 탭에서 태스크 상태·스택·CPU 사용률·실행 타임라인을 본다.
>
> **M3:** 브레드보드에 꽂은 LED, RGB LED, 택트 스위치, 부저가 실행 중인 펌웨어와 연결된다.
> 배선된 회로를 DC 해석해 PWM 밝기, 부저 음, 버튼 인터럽트(EXTI)를 보여 주고, 저항 없는 LED 같은
> 전기 규칙 위반을 알려 준다. 파형(로직 프로브) 뷰, 프로젝트 파일 저장·열기·자동 저장, 배선도 그림 내보내기,
> 배선이 포함된 예제가 있다. CPU 코어는 Unicorn과 명령어 단위로 검증했고, STM32CubeMX HAL 펌웨어가
> 84 MHz로 실시간 실행된다. 이후 계획(회로도 뷰, GDB 서버, 소스 레벨 디버깅, 추가 부품)과 진행 상황은 [로드맵](docs/roadmap.md)을 참고.

## 특징 (목표)
- 수정하지 않은 **베어메탈 / CubeMX HAL / CubeMX FreeRTOS** 펌웨어 실행
- Arduino 헤더와 **Morpho 헤더**를 모두 갖춘 Nucleo 보드, 브레드보드 드래그 앤 드롭 배선, 실행 중 배선 변경
- PWM 밝기, 부저 소리, 모터 회전, OLED 화면 등 실제와 비슷한 표시
- 교육용 진단: 미구현 레지스터 접근, `Error_Handler`/HardFault 원인, 저항 없는 LED 같은 전기 규칙 위반
- 가상 콘솔(UART), 파형 뷰, 레지스터/메모리 뷰, RTOS 태스크 뷰

## 문서
- [아키텍처](docs/architecture.md)
- [로드맵](docs/roadmap.md)
- [외부 부품 계획](docs/parts.md)
- ADR: [Rust+WASM](docs/adr/0001-rust-wasm-web.md) · [CPU 백엔드](docs/adr/0002-cpu-backends.md) · [펌웨어 범위](docs/adr/0003-firmware-scope.md) · [배선 편집기](docs/adr/0004-wiring-editor.md)

## 구조
```
crates/
  core/            Bus, CpuBackend trait, 사이클 스케줄러, Cortex-M 시스템(NVIC/SCB/SysTick)
  cpu-armv7m/      자체 Cortex-M4F 인터프리터 (Thumb-2, DSP, FPv4-SP)
  periph-stm32f4/  F401RE Peripheral: RCC/PWR/FLASH/GPIO/EXTI/SYSCFG/USART/TIM/ADC/I2C/SPI/DMA, SVD 레지스터 맵, 비트밴딩
  nucleo/          보드 단위 머신 (ELF 로드, 리셋, 실행)
  difftest/        Unicorn과 lock-step 비교 (테스트 전용)
  circuit/         넷리스트 추출, 회로 DC 해석(LED·스위치·부저), 전기 규칙 검사
  elf/             ELF 로더
  cli/             헤드리스 실행기 (simucleo)
  wasm/            웹용 WASM 바인딩
web/               React + SVG 배선 편집기
firmware/          테스트 펌웨어 (arm-none-eabi-gcc)
docs/              설계 문서, ADR
```

## 빌드
필요한 도구: Rust(stable), Node.js 20+, `wasm-bindgen-cli`(Cargo.lock의 `wasm-bindgen`과 같은 버전), 예제 펌웨어용 `arm-none-eabi-gcc`.

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.130 --locked
```

```bash
cargo test --workspace
```

```bash
cd web && npm install && npm run wasm && npm run dev
```

내장 예제를 쓰려면 먼저 펌웨어를 빌드하고 `npm run examples`로 `web/public/examples`에 복사한다(아래 펌웨어 README 참고).

```bash
make -C firmware/hal-uart-printf && cargo run --release -p simucleo-cli -- run firmware/hal-uart-printf/build/hal-uart-printf.elf --input "hi" --input-at 300
```

```text
Hello from Simucleo! SystemCoreClock = 84000000 Hz
HCLK 84000000, PCLK1 42000000, PCLK2 84000000
tick 0 at 259 ms
HI
...
```

펌웨어가 멈추면 이유를 알려 준다(예: `STOP: Error_Handler() was called from SystemClock_Config(): a HAL call returned an error`).

펌웨어 테스트와 Unicorn 차분 테스트는 [firmware/README.md](firmware/README.md)를 참고.

## 라이선스
MIT. Unicorn/QEMU(GPLv2)는 기본 배포판에 포함하지 않는다([ADR 0002](docs/adr/0002-cpu-backends.md)).
