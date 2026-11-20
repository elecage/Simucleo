# 부트로더로 보드 펌웨어 바꾸기 (IAP, 이중 이미지, 롤백)

완성된 제품은 ST-LINK 없이 펌웨어를 바꿉니다. 플래시 앞부분에 **부트로더**를 두고, 부트로더가 UART로 새 이미지를 받아
플래시에 쓰고(IAP, In-Application Programming) 검사한 뒤 그 이미지로 점프합니다. 새 이미지가 잘못되면 이전 이미지로
되돌아갑니다(롤백). 예제 **hal-bootloader**(부트로더)와 **iap-app**(부트로더가 올리는 응용 이미지 v1, v2, bad)에
이 과정이 모두 들어 있습니다.

## 플래시 지도

STM32F401RE의 512 KB 플래시는 크기가 다른 섹터 8개로 나뉩니다. 지우기는 섹터 단위로만 됩니다.

| 섹터 | 주소 | 크기 | 쓰임 |
|---|---|---|---|
| 0–1 | `0x08000000` | 32 KB | 부트로더 (`bootloader.ld`가 32 KB로 제한) |
| 2 | `0x08008000` | 16 KB | 부트 메타데이터: 16바이트 기록을 이어 붙임 |
| 3–4 | `0x0800C000` | 80 KB | 사용 안 함 |
| 5 | `0x08020000` | 128 KB | 슬롯 A: 실행하는 이미지 (이미지는 이 주소에 링크) |
| 6 | `0x08040000` | 128 KB | 슬롯 B: 받는 곳 (XMODEM이 여기에 씀) |
| 7 | `0x08060000` | 128 KB | 슬롯 C: 이전 이미지의 백업 (롤백할 때 씀) |

공통 정의는 `firmware/hal-bootloader/bootmeta.h`에 있고 부트로더와 응용 이미지가 함께 씁니다.

## 이미지 형식

응용 이미지는 슬롯 A(`0x08020000`)에 링크한 바이너리(`.bin`)입니다. 맨 앞은 벡터 테이블(초기 SP, 리셋 벡터, …)이고,
오프셋 `0x200`(F401의 벡터 테이블 0x198바이트 바로 뒤, 링커 스크립트의 `.image_header` 섹션)에 16바이트 헤더가 있습니다.

| 오프셋 | 필드 | 값 |
|---|---|---|
| `0x200` | magic | `0x21474D49` (메모리에서 `"IMG!"`) |
| `0x204` | version | 1, 2, … (bad 이미지는 3) |
| `0x208` | size | 이미지 전체 바이트 수 (4의 배수, 0xFF로 채움) |
| `0x20C` | crc32 | 이미지 전체의 CRC-32, 이 필드는 0으로 보고 계산 |

CRC-32는 zip/zlib의 것입니다(IEEE 802.3, 반사, 다항식 `0xEDB88320`, 초깃값 `0xFFFFFFFF`, 끝에 XOR `0xFFFFFFFF`).
링크한 뒤 `firmware/iap-app/mkimage.py`가 size와 crc32를 채운 `build/iap-app-*.bin`을 만들고, 디버깅용 ELF에도 같은 헤더를
넣습니다. 응용 이미지는 `USER_VECT_TAB_ADDRESS`, `VECT_TAB_OFFSET=0x20000`으로 빌드해서 `SystemInit`이 `VTOR`를
`0x08000000`으로 되돌리지 않습니다.

부트로더는 받은 이미지를 다음 순서로 검사합니다. 실패하면 이유를 출력합니다.

1. 헤더 magic (`no image header (bad magic)`)
2. size가 헤더 뒤까지 있고 128 KB 슬롯 안이며 4의 배수 (`bad size`)
3. CRC-32 (`CRC mismatch (computed 0x…, header 0x…)`)
4. 초기 SP가 SRAM(`0x20000000`–`0x20018000`) 안 (`initial stack pointer outside SRAM`)
5. 리셋 벡터가 Thumb 주소이고 슬롯 A의 이미지 안 (`reset vector outside slot A`)

## 부트 메타데이터

섹터 2에 16바이트 기록을 차례로 씁니다(최대 1024개). **마지막 유효 기록**이 현재 상태입니다. 모두 0xFF인 기록에서 목록이
끝납니다.

| 오프셋 | 필드 | |
|---|---|---|
| 0 | magic (u32) | `0xB0075EC7` |
| 4 | state (u16) | 1 = trial(새 이미지, 아직 확인 안 됨), 2 = confirmed, 3 = rolled back |
| 6 | tries (u16) | trial 이미지로 부팅한 횟수 |
| 8 | version (u32) | 슬롯 A 이미지의 version |
| 12 | check (u32) | 앞 12바이트의 CRC-32 |

상태를 바꿀 때마다 섹터를 지우지 않고 빈 칸에 새 기록을 씁니다. 프로그래밍은 비트를 1에서 0으로만 바꿀 수 있어서 지운
칸에만 쓸 수 있고, 지우기는 느리고(16 KB에 250 ms) 섹터마다 약 1만 번으로 횟수가 정해져 있기 때문입니다. 섹터 2는 가득
찼을 때만 지웁니다. 쓰다가 리셋·전원 차단으로 끊긴 기록은 check가 맞지 않아 건너뜁니다.

## 부팅 순서

1. 배너와 리셋 원인을 출력합니다. 원인은 `RCC_CSR`의 플래그(IWDGRSTF → `watchdog`, SFTRSTF → `software`,
   PORRSTF/BORRSTF → `power-on`, PINRSTF → `pin (reset button)`)에서 읽고, 다음 리셋을 위해 `RMVF`로 지웁니다.
   이어서 슬롯 A의 이미지(`slot A: app v1, 15924 bytes` 또는 `slot A: none`)를 출력합니다.
2. 마지막 기록이 **trial**이면 tries를 하나 늘린 기록을 쓰고(`trial boot 1/3 of app v2 (watchdog on, 2 s)`),
   IWDG를 2 s(LSI 32 kHz / 64, 리로드 999)로 켜고 바로 부팅합니다. 이미지가 멈추면 워치독이 보드를 리셋해서 부트로더로
   돌아옵니다. 확인 없이 3번 부팅했으면(tries가 3을 넘으면) 롤백합니다: 슬롯 C를 A로 복사하고 **rolled back** 기록을 씁니다
   (`app v3 not confirmed after 3 tries: rolling back`, `restoring the backup app v2 from slot C...`,
   `rolled back to app v2`).
3. 슬롯 A에 유효한 이미지가 있으면 `booting app v1 in 2 s, press any key for the menu`를 출력하고 2 s 안에 키가
   없으면 부팅합니다. 없으면 `no valid image in slot A`를 출력하고 메뉴에 머뭅니다.

점프(`booting app v1`): UART를 끄고 `HAL_RCC_DeInit`(클럭을 HSI 16 MHz로), 인터럽트를 막고 SysTick을 멈추고
`HAL_DeInit`, NVIC의 모든 인터럽트를 끄고 대기 중인 것을 지운 뒤 `SCB->VTOR = 0x08020000`, MSP를 이미지의 벡터 0으로
설정하고 인터럽트를 다시 허용한 다음 벡터 1(리셋 핸들러)로 뜁니다.

## 메뉴와 업데이트

USART2(ST-LINK 가상 COM 포트, 115200 8N1)로 한 글자 명령을 받습니다. 프롬프트는
`menu: u = update (XMODEM), b = boot, r = roll back, i = info` 다음 줄의 `> `입니다.

- `u` — 업데이트. `erasing slot B...` → `slot B erased in 1100 ms` →
  `waiting for XMODEM-CRC upload (send the .bin file; CAN aborts)...` 를 출력한 뒤 XMODEM-CRC로 받습니다.
- `b` — 지금 부팅. `r` — 슬롯 C의 백업을 A로 복사하고 부팅. `i` — 슬롯 세 개, 메타데이터 상태, 사용한 기록 수.

**XMODEM-CRC**(받는 쪽):

- 보내는 쪽이 시작할 때까지 1초마다 `C`를 보냅니다(60번, 그다음 `update aborted: no sender`).
- 블록: `SOH`(128바이트) 또는 `STX`(1024바이트), 블록 번호, 번호의 보수, 데이터, CRC-16/CCITT(다항식 0x1021, 초깃값 0,
  상위 바이트 먼저). 맞으면 슬롯 B에 바로 프로그래밍하고 `ACK`, CRC·번호가 틀리거나 바이트가 1 s 안에 안 오면 `NAK`
  (연속 10번이면 중단). 앞 블록이 다시 오면(ACK를 잃었을 때) 쓰지 않고 `ACK`.
- `EOT`에 `ACK`하고 끝. 보내는 쪽의 `CAN CAN`은 중단(`update aborted: cancelled by the sender`). 받는 쪽이 중단할 때는
  `CAN`을 세 번 보냅니다.
- 마지막 블록의 채움(0x1A)은 헤더의 size 뒤라 검사에 들어가지 않습니다.

받은 뒤: `received 16384 bytes`, 검사 결과 `image OK: app v2, 15924 bytes, CRC32 0x…` 또는
`image rejected: <이유>`. 좋으면 `backing up slot A (app v1) to slot C...`(슬롯 A에 유효한 이미지가 있을 때),
`installing app v2 into slot A...`, trial 기록, `rebooting into app v2 (trial)` 후 `NVIC_SystemReset()`.

## 응용 이미지 (iap-app)

`make -C firmware/iap-app`이 세 변형을 모두 만듭니다(`build/iap-app-{v1,v2,bad}.bin`과 `.elf`).

- **v1**: `app v1 (version 1) running from 0x08020000, VTOR 0x08020000`, LD2 1 Hz.
- **v2**: 같은 것, `app v2`, LD2 4 Hz.
- **bad**: `app bad (version 3) ...`를 출력하고 오지 않는 센서를 기다리며 멈춥니다. 워치독을 새로 고치지 않고
  확인도 하지 않습니다 → 워치독 리셋 3번 → 롤백.

좋은 이미지는 업데이트 뒤 처음 실행될 때 섹터 2에 **confirmed** 기록을 쓰고 `confirmed`를 출력합니다. 워치독은 한 번
켜지면 리셋 말고는 끌 수 없으므로, 이미지는 루프마다 무조건 `IWDG->KR = 0xAAAA`로 새로 고칩니다(켜지지 않은 IWDG에
쓰는 것은 아무 일도 하지 않습니다). 실행 중에 `b`를 보내면 부트로더로 리셋합니다.

**롤백의 결과**: v1 → v2 → bad 순서로 올리면 bad를 올릴 때 v2가 슬롯 C에 백업되므로, 롤백 뒤에는 **v2**가 돕니다.
롤백한 이미지는 trial이 아니므로 워치독 없이 부팅합니다.

## 시뮬레이터의 FLASH와 IWDG

- **FLASH 컨트롤러**: `KEYR`에 `0x45670123`, `0xCDEF89AB`로 잠금 해제(틀린 키는 다음 리셋까지 잠금). `SER`+`SNB`+`STRT`
  로 섹터 지우기, `MER`로 전체 지우기, `PG`와 `PSIZE`로 프로그래밍. 순서·크기·정렬이 틀리면 칩처럼 `PGSERR`·`PGPERR`·
  `PGAERR`·`WRPERR`가 서고 값은 써지지 않습니다. 프로그래밍은 셀의 비트를 0으로만 바꿉니다(지운 0xFF에 AND). `EOPIE`면
  끝날 때 `EOP`와 FLASH 인터럽트(IRQ 4) — 부트로더는 `HAL_FLASHEx_Erase_IT`로 지우고 끝날 때까지 WFI로 잡니다.
- **걸리는 시간**(STM32F401 데이터시트 대표값, x32): 16 KB 섹터 250 ms, 64 KB 550 ms, 128 KB 1.1 s(x16은 1.2배,
  x8은 1.6배), 전체 지우기 8 s, 워드 하나 16 µs. 그동안 `BSY`가 섭니다.
- 플래시는 처음에 지워진 상태(0xFF)이고 리셋해도 내용이 남습니다. 섹터마다 지운 횟수(마모)를 셉니다.
- **IWDG**: 32 kHz LSI, `KR` = `0xCCCC` 시작, `0xAAAA` 새로 고침, `0x5555` `PR`/`RLR` 쓰기 허용, `SR`의 `PVU`/`RVU`.
  카운터가 0이 되면 보드를 리셋하고 `RCC_CSR.IWDGRSTF`를 세웁니다. 리셋 말고는 멈추지 않습니다.

## 테스트

`crates/nucleo/tests/firmware.rs`의 `bootloader_updates_over_xmodem_and_rolls_back`이 PC 쪽 XMODEM 송신기
(`tests/support/xmodem.rs`)로 전체를 돌립니다: 빈 보드 → v1(128바이트 블록, CRC 틀린 블록 하나는 NAK 뒤 재전송) →
확인, 1 Hz → 리셋 버튼 → 2 s 뒤 v1 → v2(1 KB 블록), 백업에 v1, 4 Hz → bad → 워치독 리셋 3번 → v2로 롤백 → `CAN`으로
중단 → 바이트 하나 바꾼 이미지는 CRC로 거부되고 v2가 그대로 → 지운 횟수 `[0, 0, 0, 0, 0, 4, 5, 2]`(섹터 2는 한 번도
지우지 않고 기록 11개).

```sh
make -C firmware/hal-bootloader && make -C firmware/iap-app
cargo test --release -p simucleo-nucleo --test firmware bootloader -- --ignored
```
