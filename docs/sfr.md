# SFR 보기: 주변장치 레지스터를 보고 바꾸기

STM32CubeIDE의 **SFRs** 창처럼, 칩의 모든 주변장치 레지스터(SFR, Special Function Register)를 필드까지 펼쳐 보고, 펌웨어가 도는
동안 값이 바뀌는 것을 지켜보고, 손으로 바꿀 수 있습니다. 아래 탭의 **SFR**을 엽니다.

## 무엇이 보이나

- **주변장치 목록**: ST가 낸 STM32F401 SVD 파일의 주변장치 46개(GPIOA–H, RCC, TIM1–11, USART1/2/6, I2C1–3, SPI1–4, ADC1, DMA1/2,
  EXTI, FLASH, PWR, SYSCFG, RTC, WWDG, IWDG, OTG_FS, DBG …)가 베이스 주소 순서로 나옵니다. 처음에는 모두 접혀 있고, 누르면 레지스터가
  펼쳐집니다(펼친 주변장치의 레지스터만 읽으므로 실행 속도에 거의 영향이 없습니다).
  - **클럭 꺼짐**: RCC의 클럭 활성화 비트(`RCC_AHB1ENR.GPIOAEN`, `RCC_APB1ENR.USART2EN`, `TIM2EN` …)가 0인 주변장치입니다. 칩에서처럼
    레지스터가 0으로 읽히고 쓰기는 무시됩니다. 예를 들어 hal-blinky는 GPIOA·C·H만 켜므로 SPI2와 TIM2에 이 표시가 붙습니다. 리셋 직후에는
    모든 주변장치의 클럭이 꺼져 있어서, 펌웨어가 `__HAL_RCC_GPIOA_CLK_ENABLE()`을 지나야 표시가 사라집니다. ADC_Common은 ADC1EN,
    I2S2ext/I2S3ext는 SPI2EN/SPI3EN, OTG_FS_*는 OTGFSEN을 따릅니다. RCC·FLASH·EXTI·IWDG·RTC·DBG에는 클럭 게이트가 없습니다.
  - **레지스터만**: 시뮬레이터에 동작 모델이 없는 주변장치입니다(WWDG, CRC, RTC, SDIO, OTG_FS, I2S2ext …). 쓴 값을 저장했다가 그대로
    읽어 줄 뿐, 그 주변장치가 하는 일은 일어나지 않습니다.
- **레지스터**: 이름, 주소, 지금 값(16진수), 리셋값, 접근(읽기/쓰기·읽기 전용·쓰기 전용). 지난 프레임과 값이 달라지면 값이 노랗게
  잠깐 빛납니다. 값이 리셋값과 다르면 리셋값이 파랗게 `*`와 함께 표시됩니다. 쓰기 전용 레지스터(`GPIOx_BSRR`, `TIMx_EGR`, `IWDG_KR`
  …)는 칩에서 읽으면 0이므로 값 대신 "쓰기 전용"이라고 나옵니다.
- **필드**: 레지스터 이름을 누르면 필드가 MSB부터 펼쳐집니다. 비트 범위(`[5]`, `[15:8]`), 이름, 값(16진수와 10진수), 값 이름(있으면,
  예: `MODER5` = `Output`), 쓰기 효과(아래), 설명(SVD의 영어 설명, 마우스를 올리면 전체).

## 검색

검색 칸에 주변장치·레지스터·필드 이름의 일부를 쓰면 맞는 것만 남습니다(대소문자 무관).

- `USART2`: USART2 전체, 그리고 그 이름이 든 필드가 있는 RCC(`APB1ENR.USART2EN`)
- `RXNE`: RXNE 필드가 있는 레지스터들(USART·SPI의 SR)을 펼쳐서
- `TIM2.CNT`, `GPIOA.ODR`: 주변장치.레지스터 하나, `USART2.SR.RXNE`: 그 필드가 있는 레지스터를 펼쳐서

## 읽기: 부작용 없이

이 보기는 값을 **부작용 없이** 읽습니다. 실제 보드에서는 디버거가 `USARTx_DR`을 읽으면 수신 데이터가 빠지고 RXNE가 지워지거나,
SR 다음 DR을 읽는 순서로 플래그(ORE, I2C의 ADDR …)가 지워질 수 있지만, 여기서는 값을 들여다보기만 하므로 펌웨어의 동작이 바뀌지
않습니다. 다만 칩과 같이 클럭이 꺼진 주변장치는 0, 쓰기 전용 레지스터도 0으로 읽힙니다.

## 쓰기: CPU의 저장 명령처럼

- **레지스터 값**: 16진 값을 누르면 편집 칸이 됩니다. 값을 쓰고 **Enter**를 누르면 쓰고, **Esc**는 취소입니다. 값은 16진수로 읽습니다
  (`0x1F3`과 `1F3`은 같음). 2진수는 `0b101`처럼 씁니다. 쓴 값이 그대로 레지스터에 한 번(32비트 워드) 쓰입니다.
- **필드**: 1비트 필드는 체크 상자, 값 이름이 있는 필드는 목록, 그 밖의 여러 비트 필드는 숫자 칸(Enter로 쓰기)입니다. 읽기 전용 필드와
  레지스터는 바꿀 수 없습니다.

쓰기는 디버거가 하듯 **CPU의 저장 명령과 똑같이** 버스를 지나갑니다. 그래서 효과도 같습니다: `GPIOA_ODR`의 5번 비트를 켜면 LD2가
켜지고, `EXTI_PR`에 1을 쓰면 대기 중인 인터럽트가 지워지며, `ADC_CR2.SWSTART`를 켜면 변환이 시작되고, `TIMx_EGR.UG`는 갱신 이벤트를
일으킵니다. 멈춰 있을 때는 바로, 실행 중일 때는 다음 실행 조각 사이에 쓰이고, 다음 프레임에 결과가 보입니다.

### 필드 하나만 바꾸기와 W1C

필드를 바꾸면 지금 읽은 레지스터 값에서 그 필드의 비트만 바꿔 워드 전체를 씁니다(읽기-수정-쓰기). 그런데 상태 레지스터를 그대로 다시
쓰면 문제가 됩니다.

- **W1C(rc_w1, 1을 쓰면 지워짐)**: `EXTI_PR`, `FLASH_SR`의 오류·EOP 플래그, `RCC_CSR.RMVF`, `RCC_CIR`의 `…C` 비트, `PWR_CR.CWUF/CSBF`,
  `DMA_LIFCR/HIFCR`, `SDIO_ICR`, OTG_FS의 인터럽트 플래그. 읽은 값을 그대로 다시 쓰면 켜져 있던 **다른** 플래그까지 지워집니다. 그래서
  다른 필드를 바꿀 때 이런 필드에는 **0**을 씁니다(동작 모델이 없는 주변장치는 쓴 값을 그대로 저장하므로 읽은 값을 그대로
  씁니다). 이 필드 자체를 지우려면 필드 줄의 **1 쓰기** 단추를 누릅니다.
- **rc_w0(0을 쓰면 지워짐)**: `TIMx_SR`의 모든 플래그, `USART_SR`의 CTS·LBD·TC·RXNE, `I2C_SR1`의 오류 플래그, `SPI_SR.CRCERR`,
  `ADC_SR`, `RTC_ISR`의 플래그, `WWDG_SR.EWIF`. 다른 필드를 바꿀 때 이런 필드에는 **1**을 씁니다(1은 아무것도 바꾸지 않으므로, 값을 읽은
  뒤에 새로 켜진 플래그도 지워지지 않습니다). 동작 모델이 없는 주변장치에서는 쓴 값이 그대로 저장되므로 읽은 값을 그대로 씁니다.
  이 필드의 체크 상자를 끄면 0이 쓰여 플래그가 지워집니다.

ST의 SVD에는 이 정보(`modifiedWriteValues`)가 없어서 RM0368을 보고 만든 표를 씁니다(`tools/svdjson.py`의 `WRITE_EFFECTS`). 값 이름도
SVD에 없어서, 자주 쓰는 필드(GPIO 모드·출력 형태·속도·풀업/풀다운, TIM `CR1.DIR/CMS`, USART `CR1.M`·`CR2.STOP`, ADC `CR1.RES`)만
같은 파일의 `ENUMS` 표로 붙였습니다. 레지스터 값 칸에 직접 쓰는 값은 이런 처리 없이 그대로 쓰입니다.

## 감시 목록

레지스터 줄 왼쪽의 **☆**을 누르면 **감시 목록**에 들어가 목록 맨 위에 늘 보입니다. 예를 들어 `GPIOA.ODR`, `TIM2.CNT`, `USART2.SR`을
함께 띄워 놓고 펌웨어를 돌릴 수 있습니다. 감시 목록은 이 브라우저에 저장되어 새로 고쳐도 남습니다(★을 다시 누르면 빠짐). 브라우저
저장소를 쓸 수 없으면(사생활 보호 모드 등) 이번 방문 동안만 남습니다.

## 개발자

- 레지스터 설명은 `web/public/sfr/STM32F401.json`(약 230 KB, gzip 25 KB)이고, SFR 탭을 처음 열 때 받습니다(오프라인 앱은 미리
  캐시). SVD에서 다시 만들려면:
  ```sh
  python3 tools/svdjson.py crates/periph-stm32f4/svd/STM32F401.svd > web/public/sfr/STM32F401.json
  ```
  형식은 스크립트 첫 주석에 있습니다(짧은 키, `derivedFrom`인 주변장치는 원본의 레지스터 집합을 공유).
- WASM: `sfrRead(addrs: Uint32Array) → Uint32Array`(부작용 없는 워드 읽기), `sfrWrite(addr, value) → bool`(버스를 지나는 워드 쓰기),
  `sfrStatus(bases: Uint32Array) → Uint8Array`(비트 0 클럭 게이트 있음, 비트 1 클럭 켜짐 또는 게이트 없음, 비트 2 동작 모델 있음).
  보드 쪽은 `Nucleo::sfr_read/sfr_write/sfr_status`, 클럭 비트 찾기는 `regmap::clock_enable`.
- 워커: `{type: "sfrSubscribe", addrs, bases}`로 구독하면 프레임마다 `sfr: {addrs, values, bases, status}`가 붙습니다(멈춰 있으면 바로
  한 프레임). `{type: "sfrWrite", addr, value}`는 바로 씁니다. 탭을 닫으면 빈 목록으로 구독을 끝냅니다.
- 필드 계산과 W1C를 지키는 읽기-수정-쓰기: `web/src/run/sfr.ts`(`fieldWrite`), 테스트 `web/test/sfr.test.ts`, E2E `web/e2e/sfr.spec.ts`.
