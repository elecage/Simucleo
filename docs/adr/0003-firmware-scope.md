# ADR 0003: 지원 펌웨어 범위: 베어메탈, CubeMX HAL, FreeRTOS

- 상태: 채택 (2026-11-18)

## 결정
다음 세 종류의 펌웨어를 **수정 없이** 실행하는 것을 목표로 한다.
1. **베어메탈**: 정확한 리셋 값, 비트밴딩, (옵션) 세미호스팅
2. **CubeMX HAL**: `SystemClock_Config`가 기대하는 레디 플래그, `CFGR.SWS`, FLASH 레이턴시 읽기 확인, SysTick 기반 `HAL_GetTick`
3. **CubeMX FreeRTOS (CMSIS-RTOS v2, `ARM_CM4F` 포트)**: SVC/PendSV/SysTick, tail-chaining, PSP/MSP, BASEPRI, IPR 우선순위 4비트, FP 확장 스택 프레임, TIM 타임베이스

## 결과
- FreeRTOS 요구사항은 **M0 CPU 코어 설계 단계에서** 반영한다(예외 모델, FP 프레임).
- `Error_Handler`, HardFault 진입은 ELF 심볼로 감지해 원인을 보여 준다.
- `firmware/`에 종류별 예제를 두고 CI에서 회귀 테스트한다.
