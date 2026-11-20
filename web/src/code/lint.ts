// Rule-based suggestions (M33): a few educational checks on the student's C
// files, each with a short message and a "왜?" explanation in Korean. They
// look at the text (a light scanner, no compiler), so they can be wrong in
// unusual code; they are suggestions (warnings and notes), never errors, and
// never block a build. Unit tested in test/m33.test.ts.
import { functionDefs, lineAt, lineStarts, maskC, matchBrace, topStatements, varDecls, type FunctionDef } from "./cscan.ts";

export type LintRule =
  | "delay-in-isr"
  | "loop-in-isr"
  | "clock-missing"
  | "write-input"
  | "assign-in-if"
  | "printf-uart"
  | "printf-newline"
  | "volatile-shared";

export interface LintIssue {
  rule: LintRule;
  file: string;
  /** Offsets in that file's text and the 1-based line. */
  from: number;
  to: number;
  line: number;
  severity: "warning" | "info";
  message: string;
  /** The "왜?" explanation. */
  why: string;
}

export interface LintFile {
  path: string;
  text: string;
}

/** Macro values the rules may follow (`LD2_GPIO_Port` → `GPIOA`): from the symbol index and the files. */
export type MacroLookup = (name: string) => string | undefined;

export const RULE_TITLE: Record<LintRule, string> = {
  "delay-in-isr": "인터럽트 안의 HAL_Delay",
  "loop-in-isr": "인터럽트 안의 무한 루프",
  "clock-missing": "GPIO 클럭을 켜지 않음",
  "write-input": "입력으로 설정한 핀에 쓰기",
  "assign-in-if": "조건문 안의 =",
  "printf-uart": "printf가 나갈 UART가 초기화되지 않음",
  "printf-newline": "줄바꿈 없는 printf",
  "volatile-shared": "인터럽트와 함께 쓰는 변수에 volatile 없음",
};

const WHY: Record<LintRule, string> = {
  "delay-in-isr":
    "HAL_Delay는 SysTick 인터럽트가 1 ms마다 올리는 uwTick을 보며 기다립니다. 인터럽트 처리 함수(…_IRQHandler, …Callback) 안에서는 " +
    "SysTick이 같거나 낮은 우선순위라 끼어들지 못해 uwTick이 멈추고, 함수가 영원히 돌아오지 않을 수 있습니다. 그렇지 않더라도 인터럽트 안에서 " +
    "기다리면 그동안 다른 인터럽트와 main이 멈춥니다. 인터럽트에서는 플래그만 세우고, 기다리는 일은 main의 while(1)에서 하세요.",
  "loop-in-isr":
    "인터럽트 처리 함수는 짧게 끝나야 합니다. 그 안의 while(1)이나 for(;;)은 빠져나오지 못해 main과 우선순위가 같거나 낮은 인터럽트가 " +
    "모두 멈춥니다(펌웨어가 \"멈춘\" 것처럼 보임). 반복할 일은 main의 루프에서 하고, 인터럽트에서는 변수나 플래그만 바꾸세요.",
  "clock-missing":
    "STM32의 주변장치는 전력을 아끼려고 클럭이 꺼진 채로 시작합니다. GPIO 포트도 RCC에서 클럭을 켜야(__HAL_RCC_GPIOx_CLK_ENABLE()) " +
    "레지스터에 쓴 값이 들어갑니다. 켜지 않으면 HAL_GPIO_Init이 아무 일도 하지 않은 것처럼 핀이 그대로입니다. CubeMX는 MX_GPIO_Init의 " +
    "맨 앞에서 쓰는 포트마다 클럭을 켭니다.",
  "write-input":
    "HAL_GPIO_WritePin·TogglePin은 출력 데이터 레지스터(ODR)를 바꿉니다. 핀이 입력(GPIO_MODE_INPUT, 인터럽트 모드)으로 설정되어 있으면 " +
    "출력 드라이버가 꺼져 있어 핀 전압은 바뀌지 않습니다(입력에서는 ODR이 풀업·풀다운에도 쓰이지 않음 — PUPDR이 정함). 그 핀을 출력으로 " +
    "쓰려면 Mode를 GPIO_MODE_OUTPUT_PP로 설정하세요.",
  "assign-in-if":
    "C에서 =는 대입이고 비교는 ==입니다. if (x = 5)는 x에 5를 넣고 그 값(0이 아님)을 참으로 보므로 항상 실행됩니다. 비교하려면 ==를 쓰세요. " +
    "정말 대입한 값을 검사하려는 것이면 괄호를 한 번 더 써서 if ((x = f()))처럼 뜻을 보이세요.",
  "printf-uart":
    "이 템플릿의 printf는 syscalls.c의 _write가 huart2(USART2, ST-LINK 가상 COM 포트)로 보냅니다. huart2를 HAL_UART_Init으로 초기화하지 " +
    "않으면 HAL_UART_Transmit이 바로 오류로 돌아와 콘솔에 아무것도 나오지 않습니다. hal-uart-printf 예제의 MX_USART2_UART_Init처럼 " +
    "huart2.Instance = USART2, BaudRate 115200 등을 정하고 HAL_UART_Init(&huart2)를 부르세요.",
  "printf-newline":
    "newlib의 stdout은 줄 단위로 버퍼링됩니다. \\n이 나오거나 버퍼가 찰 때까지 printf한 글자는 UART로 나가지 않습니다. 바로 보이게 하려면 " +
    "끝에 \\n을 넣거나 fflush(stdout)을 부르세요.",
  "volatile-shared":
    "인터럽트에서 바꾸고 main에서 읽는 변수는 volatile이어야 합니다. 컴파일러는 main의 루프만 보고 값이 바뀌지 않는다고 가정해 변수를 " +
    "레지스터에 한 번 읽어 두고 다시 읽지 않을 수 있습니다(최적화). 그러면 인터럽트가 값을 바꿔도 main은 모릅니다. " +
    "volatile은 \"매번 메모리에서 읽어라\"는 뜻입니다.",
};

const isIsr = (name: string) => /(_IRQHandler|Callback)$/.test(name);

interface Scanned {
  file: LintFile;
  masked: string;
  starts: number[];
  fns: FunctionDef[];
}

function scan(file: LintFile): Scanned {
  const masked = maskC(file.text, { preprocessor: true });
  return { file, masked, starts: lineStarts(file.text), fns: functionDefs(masked) };
}

function issue(s: Scanned, rule: LintRule, from: number, to: number, severity: LintIssue["severity"], message: string): LintIssue {
  return { rule, file: s.file.path, from, to, line: lineAt(s.starts, from), severity, message, why: WHY[rule] };
}

/** `#define NAME value` in the files (without comments). */
function fileMacros(files: LintFile[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files) {
    const masked = maskC(f.text);
    for (const m of masked.matchAll(/^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)[ \t]+(.+)$/gm)) out.set(m[1], m[2].trim());
  }
  return out;
}

/** Follow macros until a word stops changing (`LD2_GPIO_Port` → `GPIOA`). */
function resolver(files: LintFile[], lookup: MacroLookup): (expr: string) => string {
  const local = fileMacros(files);
  return (expr) => {
    let e = expr.trim();
    for (let i = 0; i < 8; i++) {
      const v = /^[A-Za-z_]\w*$/.test(e) ? (local.get(e) ?? lookup(e)) : undefined;
      if (!v) break;
      e = v.trim().replace(/^\((.*)\)$/, "$1").trim();
    }
    return e;
  };
}

/** The call's arguments (top-level commas), from the `(` at `open`. */
function callArgs(masked: string, open: number): { args: string[]; close: number } {
  const close = matchBrace(masked, open, "(", ")");
  const inner = masked.slice(open + 1, close);
  const args: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      args.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  args.push(cur.trim());
  return { args, close };
}

function* calls(masked: string, name: string, from = 0, to = masked.length) {
  const re = new RegExp(`\\b${name}\\s*\\(`, "g");
  re.lastIndex = from;
  for (let m = re.exec(masked); m && m.index < to; m = re.exec(masked)) {
    const open = m.index + m[0].length - 1;
    yield { at: m.index, end: m.index + name.length, ...callArgs(masked, open) };
  }
}

// ------------------------------------------------------------------ rules

function isrRules(s: Scanned): LintIssue[] {
  const out: LintIssue[] = [];
  for (const fn of s.fns.filter((f) => isIsr(f.name))) {
    for (const c of calls(s.masked, "HAL_Delay", fn.bodyStart, fn.bodyEnd)) {
      out.push(issue(s, "delay-in-isr", c.at, c.end, "warning", `인터럽트 처리 함수 ${fn.name} 안에서 HAL_Delay를 부릅니다. 멈출 수 있습니다.`));
    }
    const body = s.masked.slice(fn.bodyStart, fn.bodyEnd);
    for (const m of body.matchAll(/\bwhile\s*\(\s*(?:1[uUlL]*|true)\s*\)|\bfor\s*\(\s*;\s*;\s*\)/g)) {
      const at = fn.bodyStart + m.index!;
      out.push(issue(s, "loop-in-isr", at, at + m[0].length, "warning", `인터럽트 처리 함수 ${fn.name} 안의 무한 루프: 빠져나오지 못합니다.`));
    }
  }
  return out;
}

function clockRule(all: Scanned[], resolve: (e: string) => string): LintIssue[] {
  const enabled = new Set<string>();
  for (const s of all) {
    for (const m of s.masked.matchAll(/__HAL_RCC_GPIO([A-K])_CLK_ENABLE\s*\(/g)) enabled.add(m[1]);
    // Register-level: RCC->AHB1ENR |= RCC_AHB1ENR_GPIOAEN;
    for (const m of s.masked.matchAll(/RCC_AHB1ENR_GPIO([A-K])EN\b/g)) enabled.add(m[1]);
  }
  const out: LintIssue[] = [];
  const reported = new Set<string>();
  for (const s of all) {
    for (const c of calls(s.masked, "HAL_GPIO_Init")) {
      const port = /^GPIO([A-K])$/.exec(resolve(c.args[0] ?? ""));
      if (!port || enabled.has(port[1]) || reported.has(port[1])) continue;
      reported.add(port[1]);
      out.push(
        issue(s, "clock-missing", c.at, c.end, "warning", `GPIO${port[1]}를 설정하지만 클럭을 켜지 않았습니다: 먼저 __HAL_RCC_GPIO${port[1]}_CLK_ENABLE();`),
      );
    }
  }
  return out;
}

const pinNumbers = (expr: string, resolve: (e: string) => string): number[] | null => {
  const out: number[] = [];
  for (const part of expr.split("|")) {
    const r = resolve(part.trim());
    const m = /^GPIO_PIN_(\d+)$/.exec(r);
    if (m) out.push(Number(m[1]));
    else if (r === "GPIO_PIN_All") for (let i = 0; i < 16; i++) out.push(i);
    else return null;
  }
  return out;
};

function writeInputRule(all: Scanned[], resolve: (e: string) => string): LintIssue[] {
  // How each pin is configured, from `X.Pin = …; X.Mode = …; HAL_GPIO_Init(PORT, &X);`.
  const modes = new Map<string, Set<"in" | "out">>();
  for (const s of all) {
    const fields = new Map<string, { pin?: string; mode?: string }>();
    const re = /\b([A-Za-z_]\w*)\s*\.\s*(Pin|Mode)\s*=\s*([^;]+);|\bHAL_GPIO_Init\s*\(/g;
    for (const m of s.masked.matchAll(re)) {
      if (m[1]) {
        const f = fields.get(m[1]) ?? {};
        if (m[2] === "Pin") f.pin = m[3];
        else f.mode = m[3];
        fields.set(m[1], f);
        continue;
      }
      const { args } = callArgs(s.masked, m.index! + m[0].length - 1);
      const port = resolve(args[0] ?? "");
      const v = /^&\s*([A-Za-z_]\w*)$/.exec(args[1] ?? "");
      const f = v && fields.get(v[1]);
      if (!f?.pin || !f.mode) continue;
      const pins = pinNumbers(f.pin, resolve);
      if (!pins) continue;
      const mode = resolve(f.mode);
      const kind = /OUTPUT|_AF_/.test(mode) ? "out" : /INPUT|_IT_|_EVT_|ANALOG/.test(mode) ? "in" : null;
      if (!kind) continue;
      for (const p of pins) {
        const key = `${port}:${p}`;
        modes.set(key, (modes.get(key) ?? new Set()).add(kind));
      }
    }
  }
  const out: LintIssue[] = [];
  for (const s of all) {
    for (const name of ["HAL_GPIO_WritePin", "HAL_GPIO_TogglePin"]) {
      for (const c of calls(s.masked, name)) {
        const port = resolve(c.args[0] ?? "");
        const pins = pinNumbers(c.args[1] ?? "", resolve);
        if (!pins) continue;
        const bad = pins.filter((p) => {
          const m = modes.get(`${port}:${p}`);
          return m && m.has("in") && !m.has("out");
        });
        if (!bad.length) continue;
        const pname = `P${port.replace(/^GPIO/, "")}${bad[0]}`;
        out.push(issue(s, "write-input", c.at, c.end, "warning", `${pname}는 입력으로 설정되어 있어 ${name}가 핀을 바꾸지 못합니다.`));
      }
    }
  }
  return out;
}

function assignInIf(s: Scanned): LintIssue[] {
  const out: LintIssue[] = [];
  for (const m of s.masked.matchAll(/\b(if|while)\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchBrace(s.masked, open, "(", ")");
    const inner = s.masked.slice(open + 1, close);
    // `if ((x = f()))`: deliberate.
    const t = inner.trim();
    if (t.startsWith("(") && matchBrace(t, 0, "(", ")") === t.length - 1) continue;
    let depth = 0;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth--;
      else if (ch === "=" && depth === 0) {
        const prev = inner[i - 1] ?? "";
        const next = inner[i + 1] ?? "";
        if (next === "=") {
          i++;
          continue;
        }
        if ("=!<>+-*/%&|^".includes(prev)) continue;
        const at = open + 1 + i;
        out.push(issue(s, "assign-in-if", at, at + 1, "warning", `${m[1]} 조건 안에 = (대입)이 있습니다. 비교하려면 ==입니다.`));
        break;
      }
    }
  }
  return out;
}

function printfRules(all: Scanned[]): LintIssue[] {
  const out: LintIssue[] = [];
  const uartInit = all.some((s) => /\bHAL_UART_Init\s*\(\s*&\s*huart2\s*\)/.test(s.masked));
  let first = true;
  for (const s of all) {
    for (const c of calls(s.masked, "printf")) {
      if (!uartInit && first) {
        out.push(issue(s, "printf-uart", c.at, c.end, "warning", "printf를 쓰지만 huart2(USART2)를 HAL_UART_Init으로 초기화하지 않았습니다. 콘솔에 아무것도 나오지 않습니다."));
        first = false;
      }
      // The format string as written (the masked copy has blanked it).
      const open = s.masked.indexOf("(", c.at);
      const lit = /^\s*"((?:[^"\\\n]|\\.)*)"\s*[,)]/.exec(s.file.text.slice(open + 1));
      if (lit && !lit[1].includes("\\n") && !lit[1].includes("\\r")) {
        out.push(issue(s, "printf-newline", c.at, c.end, "info", "줄바꿈(\\n) 없는 printf: \\n이나 fflush(stdout) 전까지 콘솔에 나오지 않습니다."));
      }
    }
  }
  return out;
}

const writes = (body: string, name: string) =>
  new RegExp(`(?:\\b${name}\\s*(?:\\[[^\\]]*\\]\\s*)?(?:=(?!=)|\\+\\+|--|[-+*/%&|^]=|<<=|>>=))|(?:(?:\\+\\+|--)\\s*${name}\\b)`).test(body);
const uses = (body: string, name: string) => new RegExp(`\\b${name}\\b`).test(body);

function volatileRule(all: Scanned[]): LintIssue[] {
  const out: LintIssue[] = [];
  const fns = all.flatMap((s) => s.fns.map((f) => ({ s, f, body: s.masked.slice(f.bodyStart, f.bodyEnd) })));
  for (const s of all) {
    for (const st of topStatements(s.masked)) {
      if (/^\s*(extern|typedef)\b/.test(st.text) || /\(/.test(st.text.split("=")[0])) continue;
      for (const v of varDecls(st.text, st.start)) {
        if (v.volatile || /\bconst\b/.test(st.text.split("=")[0])) continue;
        const inIsr = fns.some((x) => isIsr(x.f.name) && writes(x.body, v.name));
        const inMain = fns.some((x) => !isIsr(x.f.name) && uses(x.body, v.name));
        if (inIsr && inMain) {
          out.push(issue(s, "volatile-shared", v.at, v.at + v.name.length, "warning", `${v.name}는 인터럽트에서 바꾸고 다른 곳에서 읽지만 volatile이 아닙니다.`));
        }
      }
    }
  }
  return out;
}

/** Every suggestion for the project's files, sorted by file and position. */
export function lint(files: LintFile[], lookup: MacroLookup = () => undefined): LintIssue[] {
  const cFiles = files.filter((f) => /\.(c|h)$/.test(f.path));
  const all = cFiles.map(scan);
  const resolve = resolver(cFiles, lookup);
  const out = [
    ...all.flatMap(isrRules),
    ...clockRule(all, resolve),
    ...writeInputRule(all, resolve),
    ...all.flatMap(assignInIf),
    ...printfRules(all),
    ...volatileRule(all),
  ];
  return out.sort((a, b) => (a.file === b.file ? a.from - b.from : a.file < b.file ? -1 : 1));
}
