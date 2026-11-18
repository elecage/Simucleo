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
- **Unicorn 백엔드**(`simucleo-cpu-unicorn`, 계획)는 네이티브 전용이고 Cargo feature로 분리한다. 용도는 차분 테스트 기준과 CLI 선택 실행(`--backend unicorn`)이다.
- **QEMU**(`-M netduinoplus2`, STM32F405/Cortex-M4F)는 별도 프로세스로 실행하고, GDB 스텁으로 한 명령어씩 비교하는 lockstep 검증에만 쓴다.
- 예외/NVIC 모델은 백엔드 밖의 공용 모듈로 두어, 모든 백엔드가 같은 인터럽트 동작을 갖게 한다.

## 결과
- 웹 배포판에는 GPL 코드가 들어가지 않는다.
- 독립적인 검증 기준이 두 개 생겨 교육용으로 중요한 동작 정확도를 확보하기 쉽다.
