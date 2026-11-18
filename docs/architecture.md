# Simucleo 아키텍처

교육용 **STM32 Nucleo-F401RE 시뮬레이터**. 브라우저에서 ELF를 업로드하면 Cortex-M4F 코어가
기계어를 실행하고, 내부 Peripheral과 브레드보드 위 외부 부품을 함께 시뮬레이션해 준실시간으로 보여 준다.

![배선 편집기 v0](images/wiring-editor-v0.png)

## 목표와 비목표

**목표**
- 수정하지 않은 펌웨어 실행: 베어메탈, **CubeMX HAL**, **CubeMX FreeRTOS(CMSIS-RTOS v2)**
- 실제와 유사한 브레드보드 배선 GUI. 실행 중 배선 변경(hot-plug) 허용
- 학생이 "왜 안 되는지" 볼 수 있는 진단: 미구현 레지스터 접근, `Error_Handler`/HardFault 진입 원인, 전기 규칙 위반
- 설치 없이 브라우저에서 동작 (Rust → WASM)

**비목표 (당분간)**
- 사이클 정확(cycle-accurate) 파이프라인 모델. 명령어당 사이클 근사로 충분하다
- SPICE 수준의 과도 해석
- 다중 보드/다른 MCU 계열 (구조는 열어 두되 구현은 F401RE에 집중)
- 회로도 뷰 (브레드보드 뷰 이후)

## 구성도

```
 브라우저 UI 스레드 (TypeScript + React)          Web Worker (WASM)
┌──────────────────────────────────┐   postMessage   ┌──────────────────────────────┐
│ 배선 편집기 (SVG)                  │ ─ Circuit JSON ─▶│ simucleo-wasm                 │
│ 부품 라이브러리 / 속성 패널          │ ─ 입력 이벤트 ──▶│  ├ Machine (스케줄러, 시간 동기) │
│ 가상 콘솔 · 파형 · 레지스터 · RTOS   │◀─ VisualState ──│  ├ CPU backend (Rust 코어)     │
│ AudioWorklet (부저)               │◀─ 오디오 엣지 ───│  ├ STM32F401 Peripherals       │
└──────────────────────────────────┘    (~60 Hz)     │  └ Circuit (넷리스트, 부품 모델) │
                                                     └──────────────────────────────┘
```

현재 v0는 Worker 없이 메인 스레드에서 WASM을 호출한다(M2에서 Worker로 이전).

## Rust 크레이트

| 크레이트 | 역할 |
|---|---|
| `simucleo-core` | `Bus`, `Memory`, `CpuBackend` trait, `Registers`, 사이클 기반 `Scheduler`, **`cortexm`**(NVIC/SCB/SysTick/예외 모델, 모든 백엔드 공용) |
| `simucleo-cpu-armv7m` | 자체 Thumb/Thumb-2 + DSP + FPv4-SP 인터프리터 (기본 백엔드, WASM 지원) |
| `simucleo-periph-stm32f4` | F401RE 버스 라우팅, 비트밴딩, RCC(클럭 트리)/PWR/FLASH/GPIO/USART 모델, SVD에서 생성한 레지스터 맵과 범용 레지스터 파일, 이벤트 스케줄러 |
| `simucleo-nucleo` | 보드 단위 머신: CPU + 버스 + 시스템, ELF 로드, 리셋(원인별), 이벤트 기반 시간 진행과 ns 타임라인, B1 버튼, 가상 콘솔, 정지 원인 진단 |
| `simucleo-difftest` | Unicorn과 lock-step 비교 (테스트 전용, `unicorn` feature, GPLv2 의존성 격리) |
| `simucleo-circuit` | 배선 → 넷리스트(Union-Find), 부품 모델(`DutyIntegrator`, LED 등) |
| `simucleo-elf` | ELF 로더: LMA 기준 세그먼트, 심볼 테이블 |
| `simucleo-cli` | 헤드리스 실행기 (`simucleo info|run fw.elf`). 회귀 테스트에 사용 |
| `simucleo-wasm` | `wasm-bindgen` 바인딩 |

## 핵심 설계 결정

### 1. 시간은 CPU 사이클로만 표현한다
- 모든 Peripheral은 매 사이클 틱하지 않고, 관찰 가능한 일이 생기는 사이클에 이벤트를 예약한다
  (`Scheduler::schedule_in`).
- Machine 루프: `cpu.run(next_deadline - now)` → 기한이 된 이벤트 처리 → 반복.
- WFI/WFE이면 다음 이벤트 시각으로 시간을 건너뛴다. FreeRTOS Idle 태스크에서 성능이 크게 좋아진다.
- **실시간 동기**: 프레임마다 실제 경과 시간만큼 시뮬레이션 시간을 진행하고, 따라가지 못하면
  배속을 낮추며 `0.73x`처럼 표시한다. 0.01x 같은 느린 재생도 지원한다.

### 2. 예외/NVIC 모델은 CPU 백엔드 밖의 공용 모듈
- 스택 프레임(기본/FP 확장), EXC_RETURN, tail-chaining, BASEPRI/PRIMASK 마스킹, SVC/PendSV/SysTick.
- Rust 코어와 Unicorn 백엔드가 같은 구현을 사용하므로 인터럽트 동작이 동일하다.
- FreeRTOS `ARM_CM4F` 포트 요구사항: IPR 우선순위 비트 4개(`0xFF` 쓰기 → `0xF0` 읽힘),
  PSP 전환, FP 문맥(lazy stacking은 즉시 저장으로 단순화).

### 3. Peripheral은 "HAL이 기대하는 만큼" 정확하게

**버스, 이벤트, 인터럽트 (M1 구현)**
- Peripheral은 시간이 걸리는 일(예: UART 한 프레임)을 버스의 스케줄러에 사이클 단위로 예약한다.
- 머신은 CPU를 다음 이벤트 시각까지만 실행하고, 이벤트를 처리한 뒤 다시 실행한다.
- CPU는 Peripheral 공간에 접근한 명령어 직후 `Bus::poll`을 호출한다. 이 호출에서 IRQ 라인을 NVIC에 바로 반영하고, 더 이른 이벤트가 새로 생겼거나 클럭이 바뀌었으면 제어를 머신에 돌려준다(`Yield`).
- 클럭은 `Yield` 지점에서만 바뀌므로, 사이클을 실제 시간(ns)으로 바꾸는 타임라인이 정확하다.
- 레지스터 정의는 ST SVD에서 생성한다(`tools/svdgen.py`). 동작 모델이 없는 Peripheral은 SVD 리셋 값으로 시작하는 레지스터 파일이 받고, 접근 기록이 진단에 쓰인다.

- 레지스터 맵과 리셋 값은 ST SVD에서 생성한다(M1).
- `SystemClock_Config` 대응: 레디 플래그, `CFGR.SWS`, FLASH 레이턴시 읽기 확인, PWR VOS.
- 미구현 레지스터 접근은 0을 읽고 기록하며, GUI에 "어떤 Peripheral을 기다리는지" 보여 준다.
- `Error_Handler`, `HardFault_Handler` 진입은 ELF 심볼로 감지해 콜스택과 함께 보고한다.

### 4. 외부 회로: 넷 단위, 단계적 정밀도
- 편집기가 보내는 `Circuit`(부품 + 와이어)을 `build_netlist`가 넷으로 묶는다. 이때 브레드보드 행,
  전원 레일, 스위치 내부 연결 같은 **부품 내부 버스**와 **같은 그리드 점에 놓인 핀**도 연결로 친다.
- 넷 값은 디지털(H/L/Z), PWM 통계, 아날로그 전압(M5, MNA 솔버) 순서로 정밀도를 높인다.
- I2C/SPI 장치는 MCU Peripheral과 트랜잭션 단위로 연결하고, 비트뱅잉은 핀 레벨 디코더를 거친다.
- 넷리스트는 결정적(정렬된) 출력이라 hot-plug 시 이전 넷리스트와 비교해 바뀐 부분만 반영할 수 있다.

### 5. 표시는 적분값으로
MCU 신호는 MHz 단위로 바뀌는데 화면은 60 Hz다. 부품 모델은 프레임 동안 신호를 적분해
`VisualState`(밝기, 각도, 주파수, 프레임버퍼)를 만든다. 예를 들어 PWM LED의 밝기는 켜진 시간의
비율이고, 7세그먼트 멀티플렉싱은 잔상으로 보인다. 수동 부저는 엣지 타임스탬프를
AudioWorklet으로 보내 실제 소리를 만든다.

### 6. 프런트엔드
- React는 패널 UI에만 쓴다. 캔버스는 SVG이고, 실행 중 애니메이션은 React 재렌더링 대신
  DOM 속성을 직접 갱신한다(M3).
- 0.1인치 그리드 스냅. 핀은 와이어보다 위 레이어에 있어 이미 연결된 핀도 다시 선택할 수 있다.
- 프로젝트 저장: JSON(부품, 와이어, 속성, ELF 참조). 자동 저장은 IndexedDB.

## 검증 전략
- **명령어 단위 테스트**: 디코더/실행기 단위 테스트
- **차분 테스트**(`crates/difftest`): `firmware/difftest`의 C/어셈블리 프로그램(-O0/-O1/-O2/-Os/-O3)을 Rust 코어와 Unicorn에서 동시에 실행하고, Unicorn이 명령어를 실행할 때마다 R0–R15·APSR·S0–S31·FPSCR를 비교한 뒤 마지막에 SRAM을 비교한다. Unicorn은 IT 조건이 거짓인 명령어에서 훅을 부르지 않으므로 IT 블록 안에서만 따라잡기를 허용한다
- **예외 모델 자가 테스트**(`firmware/exceptions`): Unicorn에는 NVIC가 없으므로, 예외·인터럽트·FreeRTOS 방식 문맥 교환은 펌웨어가 스스로 검사하고 결과를 SRAM에 남긴다
- **QEMU lockstep**: `qemu-system-arm -M netduinoplus2`(STM32F405, 같은 Cortex-M4F)와 GDB 스텁으로 한 명령어씩 비교
- **펌웨어 회귀 테스트**: `firmware/` 예제를 CI에서 빌드한 뒤 `simucleo-cli`로 실행하고 UART 출력과 핀 변화 기록 비교
- **E2E**: Playwright로 배선 → 넷리스트 → 동작 확인

## 라이선스
저장소는 MIT다. Unicorn과 QEMU는 GPLv2이므로 Unicorn 백엔드는 feature flag로 분리해 기본(웹) 배포에
포함하지 않고, QEMU는 별도 프로세스로만 사용한다. STM32CubeF4 HAL(BSD-3)과 FreeRTOS(MIT)는
예제 펌웨어에 포함할 수 있다.
