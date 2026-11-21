// English for the SFR tab (peripheral registers). Korean source text → English. See ../index.ts.
export const SFR: Record<string, string> = {
  // SfrView.tsx
  "읽기 전용": "read-only",
  "쓰기 전용": "write-only",
  "읽기/쓰기": "read/write",
  "레지스터 설명을 불러오지 못했습니다: {error}": "Could not load the register descriptions: {error}",
  "레지스터 설명을 불러오는 중…": "Loading the register descriptions…",
  "주변장치·레지스터·필드 이름 (예: USART2, TIM2.CNT, RXNE)": "Peripheral, register or field name (e.g. USART2, TIM2.CNT, RXNE)",
  "SFR 검색": "Search SFRs",
  "값은 부작용 없이 읽습니다 — 실제 보드에서 디버거가 DR·SR을 읽으면 플래그가 지워지기도 하지만 여기서는 아닙니다. 쓰기는 CPU의 저장 명령과 같아서 W1C 플래그가 지워지고 변환이 시작되는 등 그대로 동작합니다.":
    "Values are read without side effects — on a real board a debugger reading DR or SR can clear flags, here it does not. Writes act like the CPU's stores: a W1C flag is cleared, a conversion starts, and so on.",
  "감시 목록": "Watched",
  "'{q}'에 맞는 레지스터가 없습니다.": "No register matches '{q}'.",
  "RCC의 클럭 활성화 비트가 0입니다: 레지스터는 0으로 읽히고 쓰기는 무시됩니다.":
    "Its RCC clock enable bit is 0: the registers read 0 and writes are ignored.",
  "클럭 꺼짐": "clock off",
  "동작 모델이 없는 주변장치입니다: 쓴 값을 저장했다가 그대로 읽어 줄 뿐입니다.":
    "This peripheral has no behavioural model: it only stores what is written and reads it back.",
  "레지스터만": "registers only",
  "{reg} 감시 해제": "Unwatch {reg}",
  "{reg} 감시": "Watch {reg}",
  "리셋값과 다릅니다": "differs from the reset value",
  "리셋값": "reset value",
  "눌러서 값 바꾸기 (Enter 쓰기, Esc 취소)": "Click to change the value (Enter writes, Esc cancels)",
  "{reg} 값 편집": "Edit {reg}",
  "{reg} 새 값": "New value of {reg}",
  "{field} 지우기 (1 쓰기)": "Clear {field} (write 1)",
  "이 필드에 1을 써서 플래그를 지우거나 동작을 시작합니다.": "Writes 1 to this field: clears the flag or starts the action.",
  "1 쓰기": "write 1",
  "1을 쓰면 지워짐": "write 1 to clear",
  "0을 쓰면 지워짐": "write 0 to clear",
  "0 … {max} (0x로 시작하면 16진수, Enter 쓰기)": "0 … {max} (hex with 0x, Enter writes)",
};
