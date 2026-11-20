// Spectrum view of the waveform panel (M27): the FFT of one channel over
// the visible window (or between the cursors), with peak markers, the
// fundamental, DC, THD and an SNR-like estimate, and a cursor that follows
// the pointer or the arrow keys. The maths is in spectrum.ts.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Wave } from "./math";
import { fmtHz, fmtTime, fmtVolts } from "./scope";
import type { SpectrumCfg } from "./scopeSettings";
import { FFT_SIZES, WINDOWS, analyze, dbv, peaks, resample, spectrum, type WindowKind } from "./spectrum";
import { t } from "../i18n";

const H = 220;
const LEFT = 52;
const BOTTOM = 20;
const TOPM = 8;
const DB_RANGE = 100;

const WINDOW_TEXT: Record<WindowKind, string> = { rect: t("사각 (Rectangular)"), hann: "Hann", hamming: "Hamming", blackman: "Blackman" };

/** "−12.3 dBV" */
const fmtDb = (db: number) => `${db < 0 ? "−" : ""}${Math.abs(db).toFixed(1)} dBV`;
const fmtLevel = (vrms: number, db: boolean) => (db ? fmtDb(dbv(vrms)) : `${fmtVolts(vrms)} RMS`);

/** 1-2-5 ticks over [lo, hi] (about `count` of them). */
function niceTicks(lo: number, hi: number, count: number): number[] {
  const raw = (hi - lo) / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * p).find((s) => s >= raw) ?? 10 * p;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(v);
  return out;
}

export function SpectrumPanel({
  wave,
  from,
  to,
  cfg,
  sources,
  sourceName,
  onChange,
  hasCursors,
}: {
  /** The channel (times in ns), or null while there is none. */
  wave: Wave | null;
  /** The span analysed (ns). */
  from: number;
  to: number;
  cfg: SpectrumCfg;
  /** Channels that can be analysed: [value, label]. */
  sources: [string, string][];
  sourceName: string;
  onChange: (c: SpectrumCfg) => void;
  hasCursors: boolean;
}) {
  const set = (patch: Partial<SpectrumCfg>) => onChange({ ...cfg, ...patch });
  const svg = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const el = svg.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(240, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const [cursorBin, setCursorBin] = useState<number | null>(null);

  const span = to - from;
  const sp = useMemo(() => {
    if (!wave || !(span > 0)) return null;
    return spectrum(resample(wave, from, to, cfg.n), span / 1e9, cfg.window);
  }, [wave, from, to, span, cfg.n, cfg.window]);
  const stats = useMemo(() => (sp ? analyze(sp) : null), [sp]);
  const marks = useMemo(() => (sp ? peaks(sp, cfg.peaks) : []), [sp, cfg.peaks]);

  // Axes.
  const plotW = width - LEFT - 8;
  const plotH = H - TOPM - BOTTOM;
  const nyq = sp ? sp.fs / 2 : 1;
  const f0 = stats?.fundamental?.freq;
  const fMin = cfg.logFreq ? (sp ? sp.df : 1) : 0;
  // Linear: up to 12.5 × the fundamental (its first ten harmonics), or all of it.
  const fMax = sp ? (cfg.fit && !cfg.logFreq && f0 !== undefined ? Math.min(nyq, 12.5 * f0) : nyq) : 1;
  const xOf = (f: number) =>
    LEFT +
    (cfg.logFreq
      ? ((Math.log10(Math.max(f, fMin)) - Math.log10(fMin)) / (Math.log10(fMax) - Math.log10(fMin) || 1)) * plotW
      : ((f - fMin) / (fMax - fMin || 1)) * plotW);
  const fOf = (x: number) => {
    const u = Math.min(1, Math.max(0, (x - LEFT) / plotW));
    return cfg.logFreq ? 10 ** (Math.log10(fMin) + u * (Math.log10(fMax) - Math.log10(fMin))) : fMin + u * (fMax - fMin);
  };
  let maxMag = 0;
  if (sp) for (let k = 1; k < sp.mag.length; k++) maxMag = Math.max(maxMag, sp.mag[k]);
  if (sp) maxMag = Math.max(maxMag, sp.mag[0]);
  const dbTop = Math.ceil(dbv(maxMag || 1e-3) / 10) * 10 + 10;
  const linTop = niceTicks(0, (maxMag || 1) * 1.1, 5).at(-1) ?? 1;
  const yOf = (vrms: number) => {
    const u = cfg.db ? (dbTop - dbv(vrms)) / DB_RANGE : 1 - vrms / linTop;
    return TOPM + Math.min(1, Math.max(0, u)) * plotH;
  };

  // The trace: the largest bin in each pixel column.
  const points = useMemo(() => {
    if (!sp) return "";
    const cols = new Map<number, number>();
    const first = cfg.logFreq ? 1 : 0;
    for (let k = first; k < sp.mag.length; k++) {
      if (k * sp.df > fMax) break;
      const px = Math.round(xOf(k * sp.df));
      const m = sp.mag[k];
      if (!(cols.get(px)! >= m)) cols.set(px, m);
    }
    return [...cols.entries()].map(([px, m]) => `${px},${yOf(m).toFixed(1)}`).join(" ");
    // (xOf and yOf follow from these.)
  }, [sp, cfg.logFreq, cfg.db, width, dbTop, linTop, fMax]);

  const xTicks = cfg.logFreq
    ? Array.from({ length: 12 }, (_, i) => 10 ** i).filter((f) => f >= fMin && f <= fMax)
    : niceTicks(0, fMax, 8);
  const yTicks = cfg.db ? Array.from({ length: 11 }, (_, i) => dbTop - i * 10) : niceTicks(0, linTop, 5);

  const bins = sp ? sp.mag.length : 0;
  const cur = cursorBin !== null && cursorBin < bins ? cursorBin : null;
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!sp || !svg.current) return;
    const x = e.clientX - svg.current.getBoundingClientRect().left;
    if (x < LEFT) return;
    setCursorBin(Math.min(bins - 1, Math.max(0, Math.round(fOf(x) / sp.df))));
  };
  const onKey = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (!sp) return;
    const step = e.shiftKey ? 10 : 1;
    const at = cur ?? stats?.fundamental?.bin ?? 0;
    const go = (k: number) => {
      e.preventDefault();
      setCursorBin(Math.min(bins - 1, Math.max(0, k)));
    };
    if (e.key === "ArrowRight") go(at + step);
    else if (e.key === "ArrowLeft") go(at - step);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(bins - 1);
    else if (e.key === "p" || e.key === "P") {
      // Jump to the next peak marker.
      const next = marks.map((m) => m.bin).sort((a, b) => a - b).find((b) => b > at) ?? marks.map((m) => m.bin).sort((a, b) => a - b)[0];
      if (next !== undefined) go(next);
    } else if (e.key === "Escape") setCursorBin(null);
  };

  const fund = stats?.fundamental;
  return (
    <div className="spectrum" data-testid="spectrum">
      <div className="wave-controls scope-controls">
        <b>{t("스펙트럼")}</b>
        <label>
          {t("소스")}{" "}
          <select value={sourceName} onChange={(e) => set({ source: e.target.value })} aria-label={t("스펙트럼 소스")}>
            {!sources.some(([v]) => v === sourceName) && <option value={sourceName}>{sourceName || "—"}{t(" (없음)")}</option>}
            {sources.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("창 함수")}{" "}
          <select value={cfg.window} onChange={(e) => set({ window: e.target.value as WindowKind })} aria-label={t("창 함수")}>
            {WINDOWS.map((w) => (
              <option key={w} value={w}>
                {WINDOW_TEXT[w]}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("점 수")}{" "}
          <select value={cfg.n} onChange={(e) => set({ n: Number(e.target.value) })} aria-label={t("FFT 점 수")}>
            {FFT_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("크기")}{" "}
          <select value={cfg.db ? "db" : "lin"} onChange={(e) => set({ db: e.target.value === "db" })} aria-label={t("크기 단위")}>
            <option value="db">dBV</option>
            <option value="lin">{t("선형 (V RMS)")}</option>
          </select>
        </label>
        <label>
          {t("주파수축")}{" "}
          <select value={cfg.logFreq ? "log" : "lin"} onChange={(e) => set({ logFreq: e.target.value === "log" })} aria-label={t("주파수축")}>
            <option value="lin">{t("선형")}</option>
            <option value="log">{t("로그")}</option>
          </select>
        </label>
        {!cfg.logFreq && (
          <label>
            <input type="checkbox" checked={cfg.fit} onChange={(e) => set({ fit: e.target.checked })} /> {t("기본파 ×12까지")}
          </label>
        )}
        <label>
          {t("피크")}{" "}
          <input
            type="number"
            min={0}
            max={20}
            step={1}
            className="num"
            value={cfg.peaks}
            aria-label={t("피크 표시 개수")}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isInteger(v) && v >= 0 && v <= 20) set({ peaks: v });
            }}
          />
        </label>
        <label>
          {t("구간")}{" "}
          <select value={cfg.range} onChange={(e) => set({ range: e.target.value as SpectrumCfg["range"] })} aria-label={t("스펙트럼 구간")}>
            <option value="view">{t("보이는 구간")}</option>
            <option value="cursors">{t("커서 A–B")}</option>
          </select>
        </label>
        {cfg.range === "cursors" && !hasCursors && <span className="hint">{t("커서를 켜면 A–B 구간을 봅니다 (지금은 보이는 구간)")}</span>}
        {sp && (
          <span className="dim" data-testid="fft-info" data-fs={sp.fs} data-df={sp.df} data-n={sp.n} data-span={span}>
            {fmtTime(span)} · N {sp.n} · fs {fmtHz(sp.fs)} · Δf {fmtHz(sp.df)}
          </span>
        )}
      </div>
      <svg
        ref={svg}
        className="spectrum-svg"
        height={H}
        viewBox={`0 0 ${width} ${H}`}
        tabIndex={0}
        role="img"
        aria-label={t("{name} 스펙트럼 그림 — 화살표·Home·End로 읽기 선 이동, P는 다음 피크", { name: sourceName })}
        data-testid="spectrum-plot"
        onPointerMove={onMove}
        onPointerLeave={() => setCursorBin(null)}
        onKeyDown={onKey}
      >
        <g className="scope-grid">
          <rect x={LEFT} y={TOPM} width={plotW} height={plotH} />
          {xTicks.map((f) => (
            <g key={`x${f}`}>
              <line x1={xOf(f)} x2={xOf(f)} y1={TOPM} y2={TOPM + plotH} />
              {xOf(f) + 44 < width && (
                <text x={xOf(f) + 2} y={H - 6}>
                  {fmtHz(f)}
                </text>
              )}
            </g>
          ))}
          {yTicks.map((v) => (
            <g key={`y${v}`}>
              <line x1={LEFT} x2={LEFT + plotW} y1={cfg.db ? TOPM + ((dbTop - v) / DB_RANGE) * plotH : yOf(v)} y2={cfg.db ? TOPM + ((dbTop - v) / DB_RANGE) * plotH : yOf(v)} />
              <text x={LEFT - 4} y={(cfg.db ? TOPM + ((dbTop - v) / DB_RANGE) * plotH : yOf(v)) + 3} textAnchor="end">
                {cfg.db ? `${v}` : fmtVolts(v)}
              </text>
            </g>
          ))}
          <text x={4} y={TOPM + 8}>
            {cfg.db ? "dBV" : "V RMS"}
          </text>
        </g>
        {!sp && (
          <text x={LEFT + plotW / 2} y={TOPM + plotH / 2} className="scope-wait" textAnchor="middle">
            {wave ? t("구간이 없습니다") : t("소스 채널이 없습니다 — 핀·아날로그·수학 채널을 고르세요")}
          </text>
        )}
        <polyline className="spectrum-trace" points={points} />
        {marks.map((m, i) => m.freq > fMax ? null : (
          <g key={m.bin} className="spectrum-peak" transform={`translate(${xOf(m.freq)},${yOf(sp!.mag[m.bin])})`}>
            <path d="M -4 -9 L 4 -9 L 0 -3 Z" />
            <text y={-11} textAnchor="middle">
              {i + 1}
            </text>
          </g>
        ))}
        {cur !== null && sp && (
          <g className="spectrum-cursor">
            <line x1={xOf(cur * sp.df)} x2={xOf(cur * sp.df)} y1={TOPM} y2={TOPM + plotH} />
            <text
              x={Math.min(xOf(cur * sp.df) + 4, LEFT + plotW - 150)}
              y={TOPM + 12}
              data-testid="fft-cursor"
              data-hz={cur * sp.df}
              data-vrms={sp.mag[cur]}
            >
              {fmtHz(cur * sp.df)} · {fmtLevel(sp.mag[cur], cfg.db)}
            </text>
          </g>
        )}
      </svg>
      {sp && stats && (
        <div className="scope-measure spectrum-measure">
          <table>
            <tbody>
              <tr>
                <th>{t("{name} 스펙트럼", { name: sourceName })}</th>
                <td>
                  {t("기본파")}{" "}
                  <b data-testid="fft-fund" data-hz={fund?.freq} data-vrms={fund?.vrms}>
                    {fund ? `${fmtHz(fund.freq)} · ${fmtLevel(fund.vrms, cfg.db)}` : "—"}
                  </b>
                </td>
                <td>
                  DC <b data-testid="fft-dc" data-v={stats.dc}>{fmtVolts(stats.dc)}</b>
                </td>
                <td>
                  {t("THD (2–10차)")}{" "}
                  <b data-testid="fft-thd" data-ratio={stats.thd}>
                    {stats.thd !== undefined ? `${(stats.thd * 100).toFixed(2)} %` : "—"}
                  </b>
                </td>
                <td title={t("기본파 전력 ÷ (기본파와 2–10차 고조파를 뺀 나머지 AC 전력)")}>
                  {t("SNR (추정)")}{" "}
                  <b data-testid="fft-snr" data-db={stats.snr}>
                    {stats.snr === undefined ? "—" : Number.isFinite(stats.snr) ? `${stats.snr.toFixed(1)} dB` : "∞"}
                  </b>
                </td>
                <td>
                  AC RMS <b data-testid="fft-ac">{fmtVolts(stats.acRms)}</b>
                </td>
              </tr>
            </tbody>
          </table>
          <table data-testid="fft-harmonics">
            <thead>
              <tr>
                <th>{t("고조파")}</th>
                {stats.harmonics.map((h) => (
                  <th key={h.order}>{t("{n}차", { n: h.order })}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th>{t("주파수")}</th>
                {stats.harmonics.map((h) => (
                  <td key={h.order}>{fmtHz(h.freq)}</td>
                ))}
              </tr>
              <tr>
                <th>{t("기본파 대비")}</th>
                {stats.harmonics.map((h) => (
                  <td key={h.order} data-testid={`fft-h${h.order}`} data-order={h.order} data-dbc={h.dbc} data-vrms={h.vrms} data-hz={h.freq}>
                    {h.order === 1 ? "0 dB" : `${h.dbc.toFixed(1)} dB`}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
          {marks.length > 0 && (
            <table data-testid="fft-peaks">
              <thead>
                <tr>
                  <th>{t("피크")}</th>
                  <th>{t("주파수")}</th>
                  <th>{t("크기")}</th>
                  {f0 !== undefined && <th>{t("÷ 기본파")}</th>}
                </tr>
              </thead>
              <tbody>
                {marks.map((m, i) => (
                  <tr key={m.bin} data-hz={m.freq} data-vrms={m.vrms}>
                    <td>{i + 1}</td>
                    <td>{fmtHz(m.freq)}</td>
                    <td>{fmtLevel(m.vrms, cfg.db)}</td>
                    {f0 !== undefined && <td>×{(m.freq / f0).toFixed(2)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
