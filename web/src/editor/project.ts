// Project files (`.simucleo.json`): the wiring, part properties, the
// waveform view's settings and optionally the firmware, so a circuit can be
// saved, shared and reopened. The format itself is in `projectFormat.ts`.
import { PART_BY_KIND } from "../parts";
import { parseWith, type Loaded } from "./projectFormat";
import { t } from "../i18n";

export { FORMAT, VERSION, serialize, type FirmwareRef, type Loaded, type ProjectFile } from "./projectFormat";

/** Parse and validate a project file. Throws on input that is not a project. */
export const parse = (text: string): Loaded => parseWith(text, PART_BY_KIND);

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
      img.onerror = () => reject(new Error(t("SVG를 그림으로 바꾸지 못했습니다.")));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = img.width * scale;
    canvas.height = img.height * scale;
    const g = canvas.getContext("2d")!;
    g.scale(scale, scale);
    g.drawImage(img, 0, 0);
    return await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(t("PNG 인코딩 실패")))), "image/png"),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}
