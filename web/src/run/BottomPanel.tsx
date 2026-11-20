import { useEffect, useRef, useState, type ReactNode } from "react";
import { btLinked, type Runner } from "../sim/useRunner";
import { Waveform } from "./Waveform";
import type { ScopeSettings } from "./scopeSettings";
import { RtosView } from "./RtosView";
import { SourceView } from "./SourceView";

/** A fixed tab, or `bt:<part id>` for an HC-05's phone. */
type Tab = "console" | "source" | "waveform" | "rtos" | "registers" | "memory" | `bt:${string}`;

const hex = (v: number, w = 8) => "0x" + (v >>> 0).toString(16).toUpperCase().padStart(w, "0");

export function BottomPanel({
  runner,
  parts = [],
  scope,
  scopeSeq,
  onScope,
  status,
}: {
  runner: Runner;
  parts?: { id: string; kind: string }[];
  /** The project's waveform settings (M25), see `Waveform`. */
  scope?: ScopeSettings;
  scopeSeq?: number;
  onScope?: (s: ScopeSettings) => void;
  /** Items at the right end of the tab row (the offline status, M29). */
  status?: ReactNode;
}) {
  const [tab, setTab] = useState<Tab>("console");
  // The waveform view keeps its trigger and capture once opened.
  const [scopeOpened, setScopeOpened] = useState(false);
  useEffect(() => {
    if (tab === "waveform") setScopeOpened(true);
  }, [tab]);
  const phones = Object.keys(runner.bluetooth).sort();
  const btTabs: [Tab, string][] = phones.map((id) => [
    `bt:${id}`,
    phones.length > 1 ? `블루투스 (HC-05 · ${id})` : "블루투스 (HC-05)",
  ]);
  // The module was removed: back to the console.
  const btPart = tab.startsWith("bt:") ? tab.slice(3) : null;
  useEffect(() => {
    if (btPart && !runner.bluetooth[btPart]) setTab("console");
  }, [btPart, runner.bluetooth]);
  return (
    <section className="bottom">
      <nav className="tabs">
        {(
          [
            ["console", "가상 콘솔 (USART2)"],
            ...btTabs,
            ["source", "소스 (디버그)"],
            ["waveform", "파형 (프로브)"],
            ["rtos", "RTOS"],
            ["registers", "레지스터"],
            ["memory", "메모리"],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button key={t} className={tab === t ? "tab on" : "tab"} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
        {status}
      </nav>
      <div className="tab-body">
        {tab === "console" && <Console runner={runner} />}
        {btPart && runner.bluetooth[btPart] && <Phone runner={runner} part={btPart} />}
        {/* Kept mounted: breakpoints and added sources survive tab switches. */}
        <div className="tab-keep" hidden={tab !== "source"}>
          <SourceView runner={runner} />
        </div>
        {(tab === "waveform" || scopeOpened) && (
          <div className="tab-keep" hidden={tab !== "waveform"}>
            <Waveform
              runner={runner}
              active={tab === "waveform"}
              parts={parts}
              settings={scope}
              settingsSeq={scopeSeq}
              onSettings={onScope}
            />
          </div>
        )}
        {tab === "rtos" && <RtosView runner={runner} />}
        {tab === "registers" && <Registers runner={runner} />}
        {tab === "memory" && <Memory runner={runner} />}
      </div>
    </section>
  );
}

function Console({ runner }: { runner: Runner }) {
  const out = useRef<HTMLPreElement>(null);
  const [line, setLine] = useState("");
  useEffect(() => {
    out.current?.scrollTo(0, out.current.scrollHeight);
  }, [runner.console]);
  return (
    <div className="console">
      <pre ref={out} data-testid="console-output">
        {runner.console || <span className="hint">USART2(PA2/PA3)로 보낸 내용이 여기에 나옵니다. 115200 baud</span>}
      </pre>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          runner.sendConsole(line + "\r\n");
          setLine("");
        }}
      >
        <input
          value={line}
          onChange={(e) => setLine(e.target.value)}
          placeholder="입력 후 Enter (CR LF와 함께 전송)"
          aria-label="콘솔 입력"
        />
        <button type="button" onClick={runner.clearConsole}>
          지우기
        </button>
      </form>
    </div>
  );
}

/** The phone paired with an HC-05: a chat over the module's UART. */
function Phone({ runner, part }: { runner: Runner; part: string }) {
  const chat = runner.bluetooth[part];
  const out = useRef<HTMLDivElement>(null);
  const [line, setLine] = useState("");
  useEffect(() => {
    out.current?.scrollTo(0, out.current.scrollHeight);
  }, [chat.messages]);
  const s = chat.status;
  const linked = btLinked(s);
  const garbled = chat.messages.some((m) => m.garbled);
  const mismatch = s.mcuBaud !== null && Math.abs(s.mcuBaud / s.baud - 1) > 0.03;
  const wiring = s.txUsart
    ? `${s.txUsart} TX → RXD${s.rxUsart ? `, TXD → ${s.rxUsart} RX` : " (TXD는 MCU RX에 연결 안 됨)"}`
    : "MCU의 USART TX가 RXD에 연결되지 않았습니다";
  return (
    <div className="phone" data-testid="bt-phone" data-part={part}>
      <div className="phone-bar">
        <b>📱 {s.name}</b>
        <span className={linked ? "bt-status on" : "bt-status"} data-testid="bt-status">
          {!s.powered ? "모듈 전원 없음" : s.atMode ? "AT 모드 (38400 baud)" : s.connected ? "연결됨" : "연결 안 됨"}
        </span>
        <button
          onClick={() => runner.bluetoothConnect(part, !s.connected)}
          disabled={!s.powered || s.atMode}
          aria-label={s.connected ? "블루투스 연결 끊기" : "블루투스 연결"}
        >
          {s.connected ? "연결 끊기" : "연결"}
        </button>
        <span className="hint">
          {wiring} · 모듈 {s.baud} baud{s.mcuBaud ? ` · MCU ${Math.round(s.mcuBaud)} baud` : ""}
        </span>
        <button type="button" onClick={() => runner.clearBluetooth(part)}>
          지우기
        </button>
      </div>
      {s.swapped && (
        <p className="bt-warn" role="alert">
          ⚠ MCU의 TX가 모듈의 TXD에 연결되어 있습니다. TX는 상대의 RX로 — MCU TX → 모듈 RXD, 모듈 TXD → MCU RX로 교차해서 연결하세요.
        </p>
      )}
      {(mismatch || garbled) && (
        <p className="bt-warn" role="alert" data-testid="bt-baud-warning">
          ⚠ 글자가 깨집니다: 보레이트가 맞지 않습니다 (모듈 {s.baud} baud
          {s.mcuBaud ? `, 펌웨어 ${Math.round(s.mcuBaud)} baud` : ""}). 펌웨어의 BaudRate나 부품의 baud 속성을 맞추세요.
        </p>
      )}
      <div className="chat" ref={out} data-testid="bt-chat">
        {chat.messages.length === 0 && (
          <p className="hint">
            {linked
              ? "MCU가 보낸 내용이 여기에 나옵니다. 아래에 입력하면 MCU의 RX로 갑니다."
              : "'연결'을 누르면 휴대폰이 HC-05에 연결되고 STATE가 High가 됩니다."}
          </p>
        )}
        {chat.messages.map((m, i) => (
          <div key={i} className={`bubble ${m.from}${m.garbled ? " garbled" : ""}`} data-from={m.from}>
            {m.text}
          </div>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!line) return;
          runner.bluetoothSend(part, line);
          setLine("");
        }}
      >
        <input
          value={line}
          onChange={(e) => setLine(e.target.value)}
          placeholder={linked ? "메시지 입력 후 Enter (CR LF와 함께 전송)" : "먼저 '연결'을 누르세요"}
          aria-label="블루투스 메시지"
        />
        <button type="submit">보내기</button>
      </form>
    </div>
  );
}

function Registers({ runner }: { runner: Runner }) {
  const f = runner.frame;
  if (!f) return <p className="hint">펌웨어를 불러오면 레지스터가 보입니다.</p>;
  const names = ["R0", "R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "R11", "R12", "SP", "LR", "PC"];
  const x = f.xpsr >>> 0;
  const flags = ["N", "Z", "C", "V", "Q"].map((n, i) => (x & (1 << (31 - i)) ? n : n.toLowerCase())).join("");
  return (
    <div className="registers">
      <table>
        <tbody>
          {names.map((n, i) => (
            <tr key={n}>
              <th>{n}</th>
              <td>{hex(f.regs[i])}</td>
              <td className="dim">{i === 15 && f.function ? `<${f.function}>` : (f.regs[i] | 0).toString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table>
        <tbody>
          <tr><th>xPSR</th><td>{hex(x)}</td><td className="dim">{flags}</td></tr>
          <tr><th>MSP</th><td>{hex(f.msp)}</td><td /></tr>
          <tr><th>PSP</th><td>{hex(f.psp)}</td><td /></tr>
          <tr><th>모드</th><td colSpan={2}>{f.exception ? `Handler (${f.exception})` : "Thread"}</td></tr>
          <tr><th>클럭</th><td colSpan={2}>{(f.clockHz / 1e6).toFixed(1)} MHz</td></tr>
        </tbody>
      </table>
    </div>
  );
}

function Memory({ runner }: { runner: Runner }) {
  const [addrText, setAddrText] = useState("0x20000000");
  const addr = (parseInt(addrText, 16) || 0) >>> 0;
  const timeMs = runner.frame?.timeMs;
  const { readMemory } = runner;
  // Refresh with every frame while this tab is open.
  useEffect(() => {
    readMemory(addr & ~0xf, 256);
  }, [addr, timeMs, readMemory]);
  const mem = runner.memory;
  const rows = [];
  if (mem) {
    for (let r = 0; r < mem.bytes.length; r += 16) {
      const chunk = Array.from(mem.bytes.slice(r, r + 16));
      rows.push(
        <tr key={r}>
          <th>{hex(mem.addr + r)}</th>
          <td>{chunk.map((b) => b.toString(16).padStart(2, "0")).join(" ")}</td>
          <td className="dim">{chunk.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("")}</td>
        </tr>,
      );
    }
  }
  return (
    <div className="memory">
      <label>
        주소{" "}
        <input value={addrText} onChange={(e) => setAddrText(e.target.value)} aria-label="메모리 주소" />
      </label>
      <span className="hint"> 0x08000000 플래시 · 0x20000000 SRAM · 0x40000000 Peripheral</span>
      <table>
        <tbody>{rows}</tbody>
      </table>
    </div>
  );
}
