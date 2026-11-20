// M35: the pixels of colour TFT displays travel apart from the frame JSON.
//
// A 240×320 RGB565 picture is 150 KB: as base64 in every frame's JSON it
// would cost more than everything else together. So the frame only carries
// the display's state and a `version` that moves when the picture changes;
// the worker asks the simulator for the bytes (`Simulator.tftPixels`) only
// then and hands them over as an ArrayBuffer (transferred, not copied) on
// the part's `tft.pixels`. The page takes them off the frame as it arrives
// and keeps the latest picture of each display here, where the part's
// canvas reads it (also after it is drawn anew, e.g. when the part moves).
import type { PartFrame, SimFrame } from "./protocol";

/** What the worker hands over: the frame's view of a display plus, when it changed, its pixels. */
export interface TftPicture {
  version: number;
  width: number;
  height: number;
  /** RGB565 little-endian, row by row; empty while the display is dark. */
  pixels: Uint8Array;
}

// --------------------------------------------------------- worker side

/** The version whose pixels were last sent, by part id. */
const sent = new Map<string, number>();
/** Frames not yet posted that carry pixels, by part id (a later picture supersedes them). */
const pending = new Map<string, PartFrame>();

/**
 * Worker: give the frame's displays whose picture changed their pixels
 * (`fetch(id)`), dropping those of an earlier frame of the same batch
 * (versions are unique across displays and simulator resets, so a
 * changed version always means a changed picture).
 */
export function attachTftPixels(frame: SimFrame, fetch: (id: string) => Uint8Array) {
  for (const p of frame.parts) {
    if (!p.tft || sent.get(p.id) === p.tft.version) continue;
    sent.set(p.id, p.tft.version);
    const earlier = pending.get(p.id);
    if (earlier?.tft) delete earlier.tft.pixels;
    p.tft.pixels = fetch(p.id);
    pending.set(p.id, p);
  }
}

/** Worker: the buffers to transfer with the message that carries the pending frames. */
export function tftPosted(): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const p of pending.values()) if (p.tft?.pixels) out.push(p.tft.pixels.buffer as ArrayBuffer);
  pending.clear();
  return out;
}

// ----------------------------------------------------------- page side

const pictures = new Map<string, TftPicture>();

/** Page: keep the pixels the frames brought (and take them off the frames). */
export function takeTftPixels(frames: SimFrame[]) {
  for (const f of frames)
    for (const p of f.parts) {
      const px = p.tft?.pixels;
      if (!p.tft || !px) continue;
      pictures.set(p.id, { version: p.tft.version, width: p.tft.width, height: p.tft.height, pixels: px });
      delete p.tft.pixels;
    }
}

/** The latest picture of display part `id`. */
export function tftPicture(id: string): TftPicture | undefined {
  return pictures.get(id);
}

/** RGB565 (little-endian) → RGBA into `out` (`width × height × 4` bytes). */
export function rgb565ToRgba(src: Uint8Array, out: Uint8ClampedArray) {
  const n = Math.min(src.length >> 1, out.length >> 2);
  for (let i = 0; i < n; i++) {
    const v = src[2 * i] | (src[2 * i + 1] << 8);
    const r = v >> 11,
      g = (v >> 5) & 0x3f,
      b = v & 0x1f;
    const o = 4 * i;
    out[o] = (r << 3) | (r >> 2);
    out[o + 1] = (g << 2) | (g >> 4);
    out[o + 2] = (b << 3) | (b >> 2);
    out[o + 3] = 255;
  }
}
