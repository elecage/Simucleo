// Project files (`.simucleo.json`): the wiring, part properties and
// optionally the firmware, so a circuit can be saved, shared and reopened.
import { PART_BY_KIND } from "../parts";
import type { PlacedPart, Project, WireModel } from "./model";

export const FORMAT = "simucleo-project";
export const VERSION = 1;

/** Firmware referenced by a project: a bundled example, or embedded bytes. */
export interface FirmwareRef {
  name: string;
  /** File name of a bundled example (`hal-pwm-led.elf`). */
  example?: string;
  /** The ELF itself, base64. */
  data?: string;
}

export interface ProjectFile {
  format: typeof FORMAT;
  version: number;
  name?: string;
  parts: PlacedPart[];
  wires: WireModel[];
  firmware?: FirmwareRef;
}

export interface Loaded {
  project: Project;
  name?: string;
  firmware?: FirmwareRef;
  /** Things that were dropped or fixed while loading. */
  notes: string[];
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function serialize(project: Project, name?: string, firmware?: FirmwareRef): string {
  const file: ProjectFile = { format: FORMAT, version: VERSION, name, parts: project.parts, wires: project.wires, firmware };
  return JSON.stringify(file, null, 2) + "\n";
}

/** Bring an older file up to the current version. */
function migrate(file: Record<string, unknown>, notes: string[]): Record<string, unknown> {
  let v = typeof file.version === "number" ? file.version : 0;
  if (v === 0) {
    // Version 0: a bare `{ parts, wires }` as kept by early builds.
    v = 1;
  }
  if (v > VERSION) notes.push(`파일 버전 ${String(file.version)}은 이 시뮬레이터보다 새것입니다. 일부 내용이 빠질 수 있습니다.`);
  return { ...file, version: VERSION };
}

/** Parse and validate a project file. Throws on input that is not a project. */
export function parse(text: string): Loaded {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("JSON 형식이 아닙니다.");
  }
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as Project).parts)) {
    throw new Error("Simucleo 프로젝트 파일이 아닙니다 (parts가 없음).");
  }
  const notes: string[] = [];
  const f = migrate(raw as Record<string, unknown>, notes);
  if (f.format !== undefined && f.format !== FORMAT) throw new Error(`알 수 없는 형식: ${String(f.format)}`);

  const parts: PlacedPart[] = [];
  const ids = new Set<string>();
  for (const p of f.parts as Partial<PlacedPart>[]) {
    if (typeof p?.id !== "string" || typeof p.kind !== "string" || ids.has(p.id)) continue;
    const def = PART_BY_KIND[p.kind];
    if (!def) {
      notes.push(`알 수 없는 부품 '${p.kind}' (${p.id})은 건너뜁니다.`);
      continue;
    }
    ids.add(p.id);
    parts.push({
      id: p.id,
      kind: p.kind,
      x: Number(p.x) || 0,
      y: Number(p.y) || 0,
      // New properties get their defaults.
      props: { ...def.props, ...(p.props ?? {}) },
    });
  }
  const wires: WireModel[] = [];
  const wireIds = new Set<string>();
  for (const w of (Array.isArray(f.wires) ? f.wires : []) as Partial<WireModel>[]) {
    if (!w?.a || !w.b || !ids.has(w.a.part) || !ids.has(w.b.part)) {
      notes.push("없는 부품에 연결된 와이어를 건너뜁니다.");
      continue;
    }
    const pinOk = (r: { part: string; pin: string }) =>
      PART_BY_KIND[parts.find((p) => p.id === r.part)!.kind].pins.some((q) => q.id === r.pin);
    if (!pinOk(w.a) || !pinOk(w.b)) {
      notes.push(`없는 핀에 연결된 와이어를 건너뜁니다 (${w.a.part}.${w.a.pin} — ${w.b.part}.${w.b.pin}).`);
      continue;
    }
    let id = typeof w.id === "string" ? w.id : `w${wires.length + 1}`;
    while (wireIds.has(id) || ids.has(id)) id += "_";
    wireIds.add(id);
    const points = Array.isArray(w.points)
      ? w.points.filter((q) => Number.isFinite(q?.x) && Number.isFinite(q?.y)).map((q) => ({ x: q.x, y: q.y }))
      : [];
    wires.push({
      id,
      a: w.a,
      b: w.b,
      color: typeof w.color === "string" ? w.color : "#1e88e5",
      ...(points.length ? { points } : {}),
    });
  }
  const fw = f.firmware as FirmwareRef | undefined;
  return {
    project: { parts, wires },
    name: typeof f.name === "string" ? f.name : undefined,
    firmware: fw && typeof fw.name === "string" ? fw : undefined,
    notes: [...new Set(notes)],
  };
}

/** Offer `data` as a file download. */
export function download(filename: string, data: Blob): void {
  const url = URL.createObjectURL(data);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ------------------------------------------------------------ autosave

const DB = "simucleo";
const STORE = "kv";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
}

export async function idbSet(key: string, value: unknown): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Private mode or storage disabled: autosave is a convenience only.
  }
}

// ------------------------------------------------------- image export

/** The canvas drawing as a standalone SVG (styles inlined, cropped to the parts). */
export function exportSvg(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  // Crop to the parts and wires (screen boxes mapped back to canvas units),
  // without the background grid.
  clone.querySelector("rect[fill='url(#grid)']")?.remove();
  const rects = [...svg.querySelectorAll("g.part, path.wire")].map((e) => e.getBoundingClientRect());
  const inv = svg.getScreenCTM()?.inverse();
  let [x, y, width, height] = [0, 0, 100, 100];
  if (rects.length && inv) {
    const p0 = new DOMPoint(Math.min(...rects.map((r) => r.left)), Math.min(...rects.map((r) => r.top))).matrixTransform(inv);
    const p1 = new DOMPoint(Math.max(...rects.map((r) => r.right)), Math.max(...rects.map((r) => r.bottom))).matrixTransform(inv);
    [x, y, width, height] = [p0.x, p0.y, p1.x - p0.x, p1.y - p0.y];
  }
  const pad = 10;
  clone.setAttribute("viewBox", `${x - pad} ${y - pad} ${width + 2 * pad} ${height + 2 * pad}`);
  clone.setAttribute("width", String(Math.round(width + 2 * pad)));
  clone.setAttribute("height", String(Math.round(height + 2 * pad)));
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.querySelectorAll(".pin").forEach((e) => e.remove());
  const css = [...document.styleSheets]
    .flatMap((s) => {
      try {
        return [...s.cssRules].map((r) => r.cssText);
      } catch {
        return [];
      }
    })
    .join("\n");
  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = css;
  clone.insertBefore(style, clone.firstChild);
  const bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  bg.setAttribute("x", String(x - pad));
  bg.setAttribute("y", String(y - pad));
  bg.setAttribute("width", String(width + 2 * pad));
  bg.setAttribute("height", String(height + 2 * pad));
  bg.setAttribute("fill", getComputedStyle(svg).backgroundColor || "#ffffff");
  clone.insertBefore(bg, style.nextSibling);
  return new XMLSerializer().serializeToString(clone);
}

/** Render an SVG string to PNG at `scale`× its size. */
export async function svgToPng(svgText: string, scale = 2): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svgText], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("SVG를 그림으로 바꾸지 못했습니다."));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;
    const g = canvas.getContext("2d")!;
    g.scale(scale, scale);
    g.drawImage(img, 0, 0);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG 인코딩 실패"))), "image/png"),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
