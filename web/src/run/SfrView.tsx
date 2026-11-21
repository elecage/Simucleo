// The SFR tab: every peripheral register of the STM32F401 (from ST's SVD)
// with its fields, live while the firmware runs, and editable by hand —
// like STM32CubeIDE's "SFRs" view. Values are read without side effects;
// writes go through the bus like the CPU's stores (see docs/sfr.md).
import { memo, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Runner } from "../sim/useRunner";
import { t } from "../i18n";
import {
  bitRange,
  enumName,
  fieldValue,
  fieldWrite,
  filterSfr,
  findReg,
  hex32,
  loadPinned,
  loadSfr,
  parseValue,
  regKey,
  savePinned,
  STATUS_CLOCK_ON,
  STATUS_GATED,
  STATUS_MODEL,
  type SfrField,
  type SfrPeripheral,
  type SfrRegister,
} from "./sfr";

/** What the frames brought: value per address, how often it changed, status per base. */
interface Live {
  values: Map<number, number>;
  changes: Map<number, number>;
  status: Map<number, number>;
}

const EMPTY: Live = { values: new Map(), changes: new Map(), status: new Map() };

const accessText = (a: SfrRegister["access"]) => (a === "r" ? t("읽기 전용") : a === "w" ? t("쓰기 전용") : t("읽기/쓰기"));

/** Live values of the subscribed registers, from every frame. */
function useLive(runner: Runner): Live {
  const [live, setLive] = useState<Live>(EMPTY);
  const { onFrame } = runner;
  useEffect(
    () =>
      onFrame((e) => {
        const s = e.sfr;
        if (!s) return;
        setLive((prev) => {
          let same = s.addrs.length === prev.values.size && s.bases.length === prev.status.size;
          const values = new Map<number, number>();
          const changes = new Map<number, number>();
          for (let i = 0; i < s.addrs.length; i++) {
            const a = s.addrs[i];
            const v = s.values[i];
            const old = prev.values.get(a);
            values.set(a, v);
            const n = prev.changes.get(a) ?? 0;
            changes.set(a, old !== undefined && old !== v ? n + 1 : n);
            if (old !== v) same = false;
          }
          const status = new Map<number, number>();
          for (let i = 0; i < s.bases.length; i++) {
            status.set(s.bases[i], s.status[i]);
            if (prev.status.get(s.bases[i]) !== s.status[i]) same = false;
          }
          return same ? prev : { values, changes, status };
        });
      }),
    [onFrame],
  );
  return live;
}

export function SfrView({ runner }: { runner: Runner }) {
  const [list, setList] = useState<SfrPeripheral[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    loadSfr().then(
      (l) => live && setList(l),
      (e: unknown) => live && setError(String(e)),
    );
    return () => {
      live = false;
    };
  }, []);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [openRegs, setOpenRegs] = useState<Set<string>>(() => new Set());
  const [pinned, setPinned] = useState<string[]>(() => loadPinned());
  const hits = useMemo(() => (list ? filterSfr(list, query) : []), [list, query]);
  // A search that matched registers or fields opens what holds them.
  useEffect(() => {
    if (!query.trim()) return;
    const ps = hits.filter((h) => h.open).map((h) => h.p.name);
    const rs = hits.flatMap((h) => [...h.openRegs].map((r) => `${h.p.name}.${r}`));
    if (ps.length) setOpen((o) => new Set([...o, ...ps]));
    if (rs.length) setOpenRegs((o) => new Set([...o, ...rs]));
  }, [hits, query]);

  const toggle = (set: Dispatch<SetStateAction<Set<string>>>, key: string) =>
    set((o) => {
      const n = new Set(o);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  const togglePin = useCallback((key: string) => {
    setPinned((p) => {
      const next = p.includes(key) ? p.filter((k) => k !== key) : [...p, key];
      savePinned(next);
      return next;
    });
  }, []);

  // Subscribe to the registers on screen (open peripherals, watched list)
  // and every peripheral's status; nothing once the tab closes.
  const watched = useMemo(
    () => (list ? pinned.map((k) => findReg(list, k)).filter((x): x is NonNullable<typeof x> => !!x) : []),
    [list, pinned],
  );
  const addrs = useMemo(() => {
    const out = new Set<number>();
    for (const w of watched) if (w.r.access !== "w") out.add(w.r.addr);
    for (const h of hits) if (open.has(h.p.name)) for (const r of h.registers) if (r.access !== "w") out.add(r.addr);
    return [...out].sort((a, b) => a - b);
  }, [hits, open, watched]);
  const bases = useMemo(() => (list ?? []).map((p) => p.base), [list]);
  const { sfrSubscribe, sfrWrite, ready } = runner;
  const subKey = addrs.join(",") + "|" + bases.length;
  const subRef = useRef({ addrs, bases });
  subRef.current = { addrs, bases };
  useEffect(() => {
    if (!ready || !list) return;
    sfrSubscribe(subRef.current.addrs, subRef.current.bases);
  }, [ready, list, subKey, sfrSubscribe]);
  useEffect(() => () => sfrSubscribe([], []), [sfrSubscribe]);

  const live = useLive(runner);
  const statusOf = (p: SfrPeripheral) => live.status.get(p.base);

  if (error) return <p className="hint">{t("레지스터 설명을 불러오지 못했습니다: {error}", { error })}</p>;
  if (!list) return <p className="hint">{t("레지스터 설명을 불러오는 중…")}</p>;
  return (
    <div className="sfr-view" data-testid="sfr-view">
      <div className="sfr-head">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("주변장치·레지스터·필드 이름 (예: USART2, TIM2.CNT, RXNE)")}
          aria-label={t("SFR 검색")}
          data-testid="sfr-search"
        />
        <span className="hint">
          {t(
            "값은 부작용 없이 읽습니다 — 실제 보드에서 디버거가 DR·SR을 읽으면 플래그가 지워지기도 하지만 여기서는 아닙니다. 쓰기는 CPU의 저장 명령과 같아서 W1C 플래그가 지워지고 변환이 시작되는 등 그대로 동작합니다.",
          )}
        </span>
      </div>
      {watched.length > 0 && (
        <section className="sfr-watched" data-testid="sfr-watched" aria-label={t("감시 목록")}>
          <h4>{t("감시 목록")}</h4>
          <table className="sfr-regs">
            <tbody>
              {watched.map(({ p, r }) => (
                <RegisterRows
                  key={regKey(p, r)}
                  p={p}
                  r={r}
                  label={regKey(p, r)}
                  live={live}
                  status={statusOf(p)}
                  open={openRegs.has(regKey(p, r))}
                  onToggle={() => toggle(setOpenRegs, regKey(p, r))}
                  pinned
                  onPin={togglePin}
                  write={sfrWrite}
                />
              ))}
            </tbody>
          </table>
        </section>
      )}
      <div className="sfr-list">
        {hits.length === 0 && <p className="hint">{t("'{q}'에 맞는 레지스터가 없습니다.", { q: query })}</p>}
        {hits.map((h) => {
          const st = statusOf(h.p);
          const isOpen = open.has(h.p.name);
          const clockOff = st !== undefined && st & STATUS_GATED && !(st & STATUS_CLOCK_ON);
          const regFile = st !== undefined && !(st & STATUS_MODEL);
          return (
            <div key={h.p.name} className="sfr-periph" data-testid="sfr-periph" data-name={h.p.name}>
              <button
                className="sfr-periph-head"
                onClick={() => toggle(setOpen, h.p.name)}
                aria-expanded={isOpen}
                title={h.p.desc}
              >
                <span className="sfr-caret">{isOpen ? "▾" : "▸"}</span>
                <b>{h.p.name}</b>
                <span className="sfr-addr">{hex32(h.p.base)}</span>
                {clockOff ? (
                  <span
                    className="sfr-badge off"
                    data-testid="sfr-clock-off"
                    title={t("RCC의 클럭 활성화 비트가 0입니다: 레지스터는 0으로 읽히고 쓰기는 무시됩니다.")}
                  >
                    {t("클럭 꺼짐")}
                  </span>
                ) : null}
                {regFile && (
                  <span
                    className="sfr-badge file"
                    data-testid="sfr-regfile"
                    title={t("동작 모델이 없는 주변장치입니다: 쓴 값을 저장했다가 그대로 읽어 줄 뿐입니다.")}
                  >
                    {t("레지스터만")}
                  </span>
                )}
                <span className="dim sfr-desc">{h.p.desc}</span>
              </button>
              {isOpen && (
                <table className="sfr-regs">
                  <tbody>
                    {h.registers.map((r) => (
                      <RegisterRows
                        key={r.name}
                        p={h.p}
                        r={r}
                        label={r.name}
                        live={live}
                        status={st}
                        open={openRegs.has(regKey(h.p, r))}
                        onToggle={() => toggle(setOpenRegs, regKey(h.p, r))}
                        pinned={pinned.includes(regKey(h.p, r))}
                        onPin={togglePin}
                        write={sfrWrite}
                      />
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface RowProps {
  p: SfrPeripheral;
  r: SfrRegister;
  label: string;
  live: Live;
  status: number | undefined;
  open: boolean;
  onToggle: () => void;
  pinned: boolean;
  onPin: (key: string) => void;
  write: (addr: number, value: number) => void;
}

/** A register's row, and its fields' rows when open. Redrawn only when its value or state changed. */
const RegisterRows = memo(
  function RegisterRows({ p, r, label, live, status, open, onToggle, pinned, onPin, write }: RowProps) {
    const key = regKey(p, r);
    const known = live.values.has(r.addr);
    const value = r.access === "w" ? 0 : (live.values.get(r.addr) ?? 0);
    const changes = live.changes.get(r.addr) ?? 0;
    const modelled = status === undefined || !!(status & STATUS_MODEL);
    const differs = known && r.access !== "w" && value !== r.reset;
    return (
      <>
        <tr className="sfr-reg" data-testid="sfr-reg" data-key={key} data-value={known ? hex32(value) : ""} title={r.desc}>
          <td>
            <button
              className={pinned ? "sfr-pin on" : "sfr-pin"}
              onClick={() => onPin(key)}
              aria-label={pinned ? t("{reg} 감시 해제", { reg: key }) : t("{reg} 감시", { reg: key })}
              aria-pressed={pinned}
            >
              {pinned ? "★" : "☆"}
            </button>
          </td>
          <td>
            <button className="sfr-reg-name" onClick={onToggle} aria-expanded={open} disabled={!r.fields.length}>
              <span className="sfr-caret">{r.fields.length ? (open ? "▾" : "▸") : ""}</span>
              {label}
            </button>
          </td>
          <td className="sfr-addr">{hex32(r.addr)}</td>
          <td>
            {r.access === "w" ? (
              <WordEditor label={key} value={null} onWrite={(v) => write(r.addr, v)} />
            ) : r.access === "r" ? (
              <span key={changes} className={changes ? "sfr-val changed" : "sfr-val"} data-testid="sfr-value">
                {known ? hex32(value) : "…"}
              </span>
            ) : (
              <WordEditor label={key} value={known ? value : null} changes={changes} onWrite={(v) => write(r.addr, v)} />
            )}
          </td>
          <td className={differs ? "sfr-reset differs" : "sfr-reset"} title={differs ? t("리셋값과 다릅니다") : t("리셋값")}>
            {hex32(r.reset)}
            {differs ? " *" : ""}
          </td>
          <td className="dim">{accessText(r.access)}</td>
        </tr>
        {open &&
          r.fields
            .slice()
            .reverse()
            .map((f) => (
              <FieldRow key={f.name} p={p} r={r} f={f} regValue={value} known={known} modelled={modelled} write={write} />
            ))}
      </>
    );
  },
  (a, b) =>
    a.r === b.r &&
    a.label === b.label &&
    a.status === b.status &&
    a.open === b.open &&
    a.pinned === b.pinned &&
    a.onPin === b.onPin &&
    a.write === b.write &&
    a.live.values.get(a.r.addr) === b.live.values.get(b.r.addr) &&
    a.live.values.has(a.r.addr) === b.live.values.has(b.r.addr) &&
    a.live.changes.get(a.r.addr) === b.live.changes.get(b.r.addr),
);

/** A register's hex value; a click edits it (Enter writes, Esc cancels). `value` null: write-only. */
function WordEditor({
  label,
  value,
  changes = 0,
  onWrite,
}: {
  label: string;
  value: number | null;
  changes?: number;
  onWrite: (v: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const bad = text !== null && parseValue(text, true) === null;
  if (text === null)
    return (
      <button
        key={changes}
        className={changes ? "sfr-val edit changed" : "sfr-val edit"}
        onClick={() => setText(value === null ? "0x00000000" : hex32(value))}
        title={t("눌러서 값 바꾸기 (Enter 쓰기, Esc 취소)")}
        aria-label={t("{reg} 값 편집", { reg: label })}
        data-testid="sfr-value"
      >
        {value === null ? t("쓰기 전용") : hex32(value)}
      </button>
    );
  return (
    <input
      className={bad ? "sfr-input bad" : "sfr-input"}
      autoFocus
      value={text}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={() => setText(null)}
      onKeyDown={(e) => {
        if (e.key === "Escape") setText(null);
        if (e.key === "Enter") {
          const v = parseValue(text, true);
          if (v === null) return;
          onWrite(v);
          setText(null);
        }
      }}
      aria-label={t("{reg} 새 값", { reg: label })}
      data-testid="sfr-input"
    />
  );
}

function FieldRow({
  p,
  r,
  f,
  regValue,
  known,
  modelled,
  write,
}: {
  p: SfrPeripheral;
  r: SfrRegister;
  f: SfrField;
  regValue: number;
  known: boolean;
  modelled: boolean;
  write: (addr: number, value: number) => void;
}) {
  const v = fieldValue(regValue, f);
  const name = `${p.name}.${r.name}.${f.name}`;
  const set = (nv: number) => write(r.addr, fieldWrite(r, regValue, f, nv, modelled));
  const ro = f.access === "r" || r.access === "r";
  const en = enumName(f, v);
  const max = f.width >= 32 ? 0xffffffff : 2 ** f.width - 1;
  let control;
  if (!known && f.access !== "w" && r.access !== "w") control = <span>…</span>;
  else if (ro) control = null;
  else if (f.effect === "w1c")
    control = (
      <button onClick={() => set(max)} aria-label={t("{field} 지우기 (1 쓰기)", { field: name })} title={t("이 필드에 1을 써서 플래그를 지우거나 동작을 시작합니다.")}>
        {t("1 쓰기")}
      </button>
    );
  else if (f.width === 1)
    control = <input type="checkbox" checked={v === 1} onChange={(e) => set(e.target.checked ? 1 : 0)} aria-label={name} />;
  else if (f.enums.length)
    control = (
      <select value={v} onChange={(e) => set(Number(e.target.value))} aria-label={name}>
        {!f.enums.some((e) => e.value === v) && <option value={v}>{v}</option>}
        {f.enums.map((e) => (
          <option key={e.value} value={e.value} title={e.desc}>
            {e.value}: {e.name}
          </option>
        ))}
      </select>
    );
  else control = <FieldNumber name={name} value={v} max={max} onWrite={set} />;
  const effect =
    f.effect === "w1c" ? t("1을 쓰면 지워짐") : f.effect === "w0c" ? t("0을 쓰면 지워짐") : f.access === "w" || r.access === "w" ? t("쓰기 전용") : ro ? t("읽기 전용") : "";
  return (
    <tr className="sfr-field" data-testid="sfr-field" data-name={name} data-value={known ? String(v) : ""}>
      <td />
      <td className="sfr-field-name" title={f.desc}>
        <span className="sfr-bits">{bitRange(f)}</span> {f.name}
      </td>
      <td className="sfr-field-val">
        {known || r.access === "w" ? (f.width > 1 ? `0x${v.toString(16).toUpperCase()} (${v})` : String(v)) : "…"}
        {en && <span className="sfr-enum"> {en}</span>}
      </td>
      <td>{control}</td>
      <td className="dim">{effect}</td>
      <td className="sfr-field-desc" title={f.desc}>
        {f.desc}
      </td>
    </tr>
  );
}

/** A multi-bit field's number box (hex with 0x or decimal; Enter writes). */
function FieldNumber({ name, value, max, onWrite }: { name: string; value: number; max: number; onWrite: (v: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  const parsed = text === null ? null : parseValue(text);
  const bad = text !== null && (parsed === null || parsed > max);
  return (
    <input
      className={bad ? "sfr-input small bad" : "sfr-input small"}
      value={text ?? String(value)}
      onFocus={(e) => {
        setText(String(value));
        e.target.select();
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => setText(null)}
      onKeyDown={(e) => {
        if (e.key === "Escape") (e.target as HTMLInputElement).blur();
        if (e.key === "Enter" && parsed !== null && parsed <= max) {
          onWrite(parsed);
          (e.target as HTMLInputElement).blur();
        }
      }}
      aria-label={name}
      title={t("0 … {max} (0x로 시작하면 16진수, Enter 쓰기)", { max })}
    />
  );
}
