# THIRD_PARTY

Simucleo 자체는 MIT다. 사이트가 함께 내려보내거나 빌드에 쓰는 다른 프로젝트의 것과 라이선스를 적는다.
원문은 각 위치에 그대로 있다.

## 소스 탭에 함께 보이는 라이브러리 소스

예제 펌웨어가 이 라이브러리로 빌드되므로, 그 안(예: `HAL_Delay`)에서 멈췄을 때 소스 탭이 그 코드를 보여 주도록 원본을 그대로
사이트에 넣는다(`web/scripts/examples.mjs` → `web/public/examples/src/vendor/`, 라이선스 파일도 같은 자리에).

| 무엇 | 어디에 | 라이선스 | 원문 |
|---|---|---|---|
| STM32F4 HAL 드라이버 `Src/` (예제가 쓰는 20개) | `examples/src/vendor/stm32f4xx_hal_driver/Src`; 원본 `firmware/vendor/stm32f4xx_hal_driver` | BSD-3-Clause | 같은 자리의 `LICENSE.md` |
| FreeRTOS 커널과 CMSIS-RTOS2 래퍼 | `examples/src/vendor/freertos`; 원본 `firmware/vendor/freertos` | MIT | 같은 자리의 `LICENSE.md` |
| FatFs | `examples/src/vendor/fatfs`; 원본 `firmware/vendor/fatfs` | FatFs 라이선스(BSD 계열, ChaN·ST 고지) | 같은 자리의 `LICENSE.md` |
| CMSIS Core 헤더 | `examples/src/vendor/CMSIS/Include`; 원본 `firmware/vendor/CMSIS` | Apache-2.0 | 같은 자리의 `LICENSE.txt` |

## 브라우저 안 C 빌드 (M33)

| 무엇 | 어디에 | 라이선스 | 원문 |
|---|---|---|---|
| LLVM: Clang, LLD (`ld.lld`), LLVM 도구 — WebAssembly로 빌드한 것 | `web/public/toolchain/llvm.core*.wasm.gz.bin` (편집기에서 처음 빌드할 때 받음), npm 패키지 [`microbit-clang-wasm`](https://www.npmjs.com/package/microbit-clang-wasm) 21.11.0-alpha.3 (Arm Toolchain for Embedded 21.1.1 기반) | Apache-2.0 WITH LLVM-exception | `web/public/toolchain/clang-LICENSES.md`, `clang-LICENSE.txt` |
| Clang 내장 헤더 (`stdint.h`, `stddef.h`, `stdarg.h` 등 Arm에 필요한 것만) | `web/public/toolchain/clang-include.tar.gz.bin` | Apache-2.0 WITH LLVM-exception | 위와 같음 |
| 패키지의 로더와 WASI 런타임 (YoWASP/clang, `@yowasp/runtime`, jco가 만든 모듈) | `web/public/toolchain/clang.js`, `llvm.core2–4.wasm` | ISC (YoWASP), Apache-2.0 (패키지·jco) | 위와 같음 |
| newlib-nano (`libc_nano.a`), `libm.a`, libgloss `libnosys.a`, newlib 헤더 | SDK 묶음 `web/public/toolchain/sdk-hal.tar.gz.bin` (`sdk/lib`, `sdk/include/libc`), Debian/Ubuntu `libnewlib-arm-none-eabi`에서 `firmware/editor-sdk`가 디버그 정보만 빼고 복사 | BSD 계열 여러 고지(newlib) | 묶음 안 `sdk/licenses/newlib.txt` |
| libgcc (`libgcc.a`, `crti/crtbegin/crtend/crtn.o`) | SDK 묶음 `sdk/lib` (`gcc-arm-none-eabi`) | GPL-3.0 WITH GCC Runtime Library Exception — 이 예외로 libgcc를 링크한 펌웨어는 GPL 조건을 따르지 않아도 됨 | 묶음 안 `sdk/licenses/libgcc.txt` |
| STM32F4 HAL 드라이버 (헤더, 미리 빌드한 `libhal.a`) | SDK 묶음 `sdk/include/hal`, `sdk/lib/libhal.a`; 원본 `firmware/vendor/stm32f4xx_hal_driver` | BSD-3-Clause | `firmware/vendor/stm32f4xx_hal_driver/LICENSE.md`, 묶음 안 `sdk/licenses/` |
| CMSIS Core, CMSIS 장치 파일(STM32F4) | SDK 묶음 `sdk/include/cmsis`, `sdk/include/device`, 시작 코드 `sdk/lib/obj/startup_stm32f401xe.o`·`system_stm32f4xx.o`; 원본 `firmware/vendor/CMSIS`, `firmware/vendor/cmsis_device_f4` | Apache-2.0 | `firmware/vendor/CMSIS/LICENSE.txt`, `firmware/vendor/cmsis_device_f4/LICENSE.md` |
| HAL·CMSIS·newlib 헤더에서 뽑은 자동완성 색인 | `web/public/editor/hal-symbols.json` | 위 헤더의 라이선스(이름·시그니처·문서 첫 문장) | — |
| CodeMirror 6 (`@codemirror/*`), Lezer (`@lezer/cpp`, `@lezer/common`, `@lezer/lr`, `@lezer/highlight`), `style-mod`, `w3c-keyname`, `crelt`, `@marijn/find-cluster-break` | 코드 탭의 JavaScript 묶음 | MIT | 각 패키지의 `LICENSE` (`web/node_modules/…`) |

## CubeMX식 설정 도구 (M36)

설정 도구가 만드는 프로젝트의 `Drivers/`·시작 코드·링커 스크립트는 사이트에 든 STM32CubeF4 묶음에서 온다. 편집기에서 읽기 전용으로
보이고, **zip으로 내보내기**를 누르면 프로젝트와 함께 zip에 들어간다(라이선스 파일도 같이).

| 무엇 | 어디에 | 라이선스 | 원문 |
|---|---|---|---|
| STM32F4 HAL 드라이버 v1.8.6 (`Inc/`, `Inc/Legacy/`, 예제가 쓰는 `Src/` 20개) | `web/public/cube/cubef4-hal-1.8.6.tar.gz.bin` (`Drivers/STM32F4xx_HAL_Driver`); 원본 `firmware/vendor/stm32f4xx_hal_driver` | BSD-3-Clause | 묶음 안 `Drivers/STM32F4xx_HAL_Driver/LICENSE.md` |
| CMSIS 장치 파일 STM32F4 v2.6.11 (`stm32f401xe.h`, `stm32f4xx.h`, `system_stm32f4xx.h`, `system_stm32f4xx.c`, `startup_stm32f401xe.s` → `Core/Startup/startup_stm32f401retx.s`) | 같은 묶음 (`Drivers/CMSIS/Device/ST/STM32F4xx`, `Core/`); 원본 `firmware/vendor/cmsis_device_f4` | Apache-2.0 | 묶음 안 `Drivers/CMSIS/Device/ST/STM32F4xx/LICENSE.md` |
| CMSIS Core 헤더 (`core_cm4.h` 등) | 같은 묶음 (`Drivers/CMSIS/Include`); 원본 `firmware/vendor/CMSIS/Include` | Apache-2.0 | 묶음 안 `Drivers/CMSIS/LICENSE.txt` |
| `stm32f4xx_hal_conf.h`의 틀 | 생성 코드(`web/src/cube/codegen.ts`) — ST의 템플릿과 같은 구성을 따름 | BSD-3-Clause (ST 템플릿) | 위 HAL 라이선스 |

생성하는 `main.c`·`stm32f4xx_it.c`·`stm32f4xx_hal_msp.c`·`syscalls.c`·`sysmem.c`와 `.ioc`·`.project`·`.cproject`는 Simucleo가 CubeMX·
CubeIDE의 형식을 따라 쓴 것이다(ST의 파일을 복사하지 않음). 테스트용 `.ioc` 세 개(`web/test/data/m36/`)도 직접 썼다.

## 그 밖

- 예제 펌웨어가 쓰는 HAL, CMSIS, FreeRTOS, FatFs: [firmware/vendor/README.md](firmware/vendor/README.md).
- 레지스터 표의 SVD(Apache-2.0): 같은 곳.
- Unicorn/QEMU(GPLv2)는 테스트에만 쓰고 배포판에 넣지 않는다([ADR 0002](docs/adr/0002-cpu-backends.md)).
