import { useEffect, useRef, useState } from "react";
import type { Runner } from "../sim/useRunner";
import { Waveform } from "./Waveform";
import { RtosView } from "./RtosView";
import { SourceView } from "./SourceView";

type Tab = "console" | "source" | "waveform" | "rtos" | "registers" | "memory";

const hex = (v: number, w = 8) => "0x" + (v >>> 0).toString(16).toUpperCase().padStart(w, "0");

export function BottomPanel({ runner }: { runner: Runner }) {
  const [tab, setTab] = useState<Tab>("console");
  return (
    <section className="bottom">
      <nav className="tabs">
        {(
          [
            ["console", "가상 콘솔 (USART2)"],
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
      </nav>
      <div className="tab-body">
        {tab === "console" && <Console runner={runner} />}
        {tab === "source" && <SourceView runner={runner} />}
        {tab === "waveform" && <Waveform runner={runner} />}
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
