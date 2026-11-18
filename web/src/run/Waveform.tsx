// Logic probe: level of chosen MCU pins over the last few milliseconds, with
// measured frequency and duty, like a small logic analyser.
import { useEffect, useRef, useState } from "react";
import type { Runner } from "../sim/useRunner";

const WINDOWS: [string, number][] = [
  ["2 ms", 2],
  ["20 ms", 20],
  ["200 ms", 200],
  ["2 s", 2000],
];
const PIN_NAMES = [
  ...["A", "B", "C"].flatMap((p) => Array.from({ length: 16 }, (_, i) => `P${p}${i}`)),
  "PD2",
  "PH0",
  "PH1",
];
const ROW = 34;
const WIDTH = 1000;

interface Trace {
  /** Level before the first edge. */
  start: boolean;
  edges: [number, boolean][];
  dense: boolean;
}

function measure(t: Trace, from: number, to: number) {
  // Level at `from`, then the edges inside the window.
  let level = t.start;
  const inside: [number, boolean][] = [];
  for (const e of t.edges) {
    if (e[0] <= from) level = e[1];
    else if (e[0] <= to) inside.push(e);
  }
  let high = 0;
  let last = from;
  let cur = level;
  for (const [ts, l] of inside) {
    if (cur) high += ts - last;
    last = ts;
    cur = l;
  }
  if (cur) high += to - last;
  const rises = inside.filter((e) => e[1]).map((e) => e[0]);
  const freq = rises.length >= 2 ? ((rises.length - 1) * 1000) / (rises[rises.length - 1] - rises[0]) : undefined;
  return { level, inside, duty: high / (to - from), freq };
}

const fmtHz = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(2)} kHz` : `${f.toFixed(1)} Hz`);

export function Waveform({ runner }: { runner: Runner }) {
  const [pins, setPins] = useState<string[]>(["PA5"]);
  const [windowMs, setWindowMs] = useState(20);
  const traces = useRef(new Map<string, Trace>());
  const lastTime = useRef(0);
  const lastFrame = useRef<unknown>(null);
  const { setProbes, ready } = runner;

  useEffect(() => {
    if (ready) setProbes(pins);
  }, [pins, ready, setProbes]);

  // Fold each frame's edges into the traces (render-time bookkeeping on a ref).
  const f = runner.frame;
  // Every frame object is new: process each once, even at an unchanged time
  // (a switch pressed while paused produces a frame at the same time).
  if (f && f !== lastFrame.current) {
    lastFrame.current = f;
    if (f.timeMs < lastTime.current) traces.current.clear(); // reset or new firmware
    lastTime.current = f.timeMs;
    for (const p of f.probes) {
      let t = traces.current.get(p.name);
      if (!t) {
        t = { start: p.level0, edges: [], dense: false };
        traces.current.set(p.name, t);
      }
      t.edges.push(...p.edges);
      t.dense = p.dense;
      // Keep two windows of history.
      const keepFrom = f.timeMs - 2 * Math.max(...WINDOWS.map((w) => w[1]));
      let drop = 0;
      while (drop < t.edges.length && t.edges[drop][0] < keepFrom) drop++;
      if (drop > 0) {
        t.start = t.edges[drop - 1][1];
        t.edges.splice(0, drop);
      }
    }
  }

  const now = f?.timeMs ?? 0;
  const from = now - windowMs;
  const x = (t: number) => ((t - from) / windowMs) * WIDTH;

  return (
    <div className="waveform">
      <div className="wave-controls">
        <label>
          핀 추가{" "}
          <select
            value=""
            aria-label="프로브 핀 추가"
            onChange={(e) => e.target.value && setPins((p) => (p.includes(e.target.value) ? p : [...p, e.target.value]))}
          >
            <option value="">…</option>
            {PIN_NAMES.filter((n) => !pins.includes(n)).map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </label>
        <label>
          시간 폭{" "}
          <select value={windowMs} onChange={(e) => setWindowMs(Number(e.target.value))} aria-label="시간 폭">
            {WINDOWS.map(([l, v]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <span className="hint">핀의 실제 레벨(입력 포함)을 보여 줍니다. 실행 중에 갱신됩니다.</span>
      </div>
      <div className="wave-rows">
        {pins.map((name) => {
          const t = traces.current.get(name);
          const m = t ? measure(t, from, now) : undefined;
          let points = "";
          if (m) {
            let level = m.level;
            const y = (l: boolean) => (l ? 6 : ROW - 6);
            points = `0,${y(level)}`;
            for (const [ts, l] of m.inside) {
              points += ` ${x(ts).toFixed(1)},${y(level)} ${x(ts).toFixed(1)},${y(l)}`;
              level = l;
            }
            points += ` ${WIDTH},${y(level)}`;
          }
          return (
            <div key={name} className="wave-row" data-probe={name}>
              <div className="wave-label">
                <b>{name}</b>
                <button aria-label={`${name} 제거`} onClick={() => setPins((p) => p.filter((q) => q !== name))}>
                  ×
                </button>
                <div className="dim" data-testid={`probe-${name}`}>
                  {m?.freq !== undefined ? `${fmtHz(m.freq)} · ` : ""}
                  {m ? `${(m.duty * 100).toFixed(0)}% H` : "—"}
                  {t?.dense ? " · 너무 빠름" : ""}
                </div>
              </div>
              <svg viewBox={`0 0 ${WIDTH} ${ROW}`} preserveAspectRatio="none" className="wave-svg">
                <polyline points={points} />
              </svg>
            </div>
          );
        })}
      </div>
    </div>
  );
}
