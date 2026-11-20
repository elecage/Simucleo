# THIRD_PARTY

Simucleo 자체는 MIT다. 사이트가 함께 내려보내거나 빌드에 쓰는 다른 프로젝트의 것과 라이선스를 적는다.
원문은 각 위치에 그대로 있다.

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

## 그 밖

- 예제 펌웨어가 쓰는 HAL, CMSIS, FreeRTOS, FatFs: [firmware/vendor/README.md](firmware/vendor/README.md).
- 레지스터 표의 SVD(Apache-2.0): 같은 곳.
- Unicorn/QEMU(GPLv2)는 테스트에만 쓰고 배포판에 넣지 않는다([ADR 0002](docs/adr/0002-cpu-backends.md)).
