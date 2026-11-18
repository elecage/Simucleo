# ADR 0001: Rust 코어 + WASM + 웹 프런트엔드

- 상태: 채택 (2026-11-18)

## 맥락
교육용 시뮬레이터라서 학생이 설치 없이 바로 써야 한다. 또 CPU 에뮬레이션은 성능이 중요하다.

## 결정
- 시뮬레이션 코어는 **Rust**로 작성하고 `wasm32-unknown-unknown`으로 빌드한다.
- 프런트엔드는 **TypeScript + React**(패널 UI)와 **SVG 캔버스**(배선 편집기)로 만든다.
- 시뮬레이션은 Web Worker에서 실행하고, UI에는 약 60 Hz로 VisualState를 보낸다.
- 코어는 헤드리스 라이브러리로 유지하고, 같은 코드를 CLI(`simucleo-cli`)와 테스트에서도 쓴다.

## 결과
- 브라우저만 있으면 동작한다. 데스크톱판이 필요해지면 Tauri로 같은 UI를 재사용할 수 있다.
- GDB 원격 서버 같은 로컬 기능은 CLI/데스크톱판에서 제공한다.
- SharedArrayBuffer(COOP/COEP 필요)는 성능 문제가 확인될 때만 도입한다.
