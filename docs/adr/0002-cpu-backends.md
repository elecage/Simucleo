# ADR 0002: CPU 백엔드: 자체 코어 기본, Unicorn·QEMU는 검증용

- 상태: 채택 (2026-11-18)

## 맥락
Unicorn이나 QEMU를 골라 쓸 수 있는지 검토했다. 제약은 다음과 같다.
- 웹(WASM)에서는 JIT(TCG)가 동작하지 않는다. TCI로 Emscripten 빌드하는 방법은 크고 느리며 유지보수가 어렵다.
- Unicorn에는 NVIC가 없고, M-profile 예외 진입/복귀를 호출자가 처리해야 한다.
- QEMU는 자체 Peripheral 모델을 포함한 시스템 에뮬레이터라, CPU만 떼어 우리 Peripheral에 붙이기 어렵다.
- 둘 다 GPLv2이고, 이 저장소는 MIT다.

## 결정
- `simucleo_core::cpu::CpuBackend` trait로 CPU를 추상화한다.
- **기본 백엔드는 자체 Rust 인터프리터**(`simucleo-cpu-armv7m`)로, 웹과 네이티브 모두에서 쓴다.
- **Unicorn**은 네이티브 전용이고 Cargo feature(`unicorn`)로 분리한다. 우선 차분 테스트 기준(`simucleo-difftest`)으로 쓴다. Unicorn에는 NVIC가 없으므로 CLI에서 펌웨어 전체를 실행하는 백엔드(`--backend unicorn`)는 공용 예외 모듈을 붙인 뒤에 검토한다.
- **QEMU**(`-M netduinoplus2`, STM32F405/Cortex-M4F)는 별도 프로세스로 실행하고, GDB 스텁으로 한 명령어씩 비교하는 lockstep 검증에만 쓴다.
- 예외/NVIC 모델은 백엔드 밖의 공용 모듈로 두어, 모든 백엔드가 같은 인터럽트 동작을 갖게 한다.

## 결과
- 웹 배포판에는 GPL 코드가 들어가지 않는다.
- 독립적인 검증 기준이 두 개 생겨 교육용으로 중요한 동작 정확도를 확보하기 쉽다.

## 구현 메모 (M0)
- lock-step 비교는 Unicorn의 코드 훅에서 Rust 코어를 한 명령어씩 진행하며 레지스터를 비교한다.
- Unicorn은 IT 조건이 거짓인 명령어에서 훅을 호출하지 않고, xPSR 읽기에 IT 비트가 나오지 않는다. 그래서 IT 블록 안에서만 따라잡기를 허용하고 APSR만 비교한다.
- Unicorn의 M4 모델은 CPACR 설정 없이 FPU가 켜져 있으므로, 비교할 때는 Rust 쪽 CPACR도 켠다.
