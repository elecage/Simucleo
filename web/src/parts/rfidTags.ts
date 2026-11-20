// The RFID cards and tags of the RC522 part (M35) and the gesture that puts
// them on the reader's antenna. Prop `card` says which one lies there
// (0 = none, 1–4 = TAGS[n − 1]); the simulator (`simucleo_circuit::rc522`)
// holds their UIDs and memory.
import { PITCH, type ControlPointer, type PartControl, type PropValues } from "./types.ts";
import { t } from "../i18n/index.ts";

export interface Tag {
  n: number;
  shape: "card" | "fob" | "sticker";
  label: string;
  /** As the example firmware prints it. */
  uid: string;
  /** MIFARE Classic 1K or Ultralight. */
  chip: string;
  color: string;
}

export const TAGS: Tag[] = [
  { n: 1, shape: "card", label: t("카드 A"), uid: "7A 3B 1C 9D", chip: "MIFARE Classic 1K", color: "#f8fafc" },
  { n: 2, shape: "card", label: t("카드 B"), uid: "5E 82 F4 03", chip: "MIFARE Classic 1K", color: "#fde68a" },
  { n: 3, shape: "fob", label: t("키 태그"), uid: "C1 9A 6E 22", chip: "MIFARE Classic 1K", color: "#2563eb" },
  { n: 4, shape: "sticker", label: t("NFC 스티커"), uid: "04 A1 B2 C3 D4 E5 80", chip: "MIFARE Ultralight", color: "#a7f3d0" },
];

/** The antenna coil on the module (part grid units). */
export const ANTENNA = { x0: 0.6, y0: 0.6, x1: 8.4, y1: 7.8 };
const ANTENNA_CENTRE = { x: (ANTENNA.x0 + ANTENNA.x1) / 2, y: (ANTENNA.y0 + ANTENNA.y1) / 2 };

/** Where a tag lies (centre, grid units): on the antenna or in its tray slot. */
export function tagCentre(n: number, card: number): { x: number; y: number } {
  if (card === n) return ANTENNA_CENTRE;
  return { x: 13, y: 1.45 + (n - 1) * 2.9 };
}

/** Within the antenna's outline (a tag dropped there is read). */
export function onAntenna(x: number, y: number): boolean {
  return x >= ANTENNA.x0 && x <= ANTENNA.x1 && y >= ANTENNA.y0 && y <= ANTENNA.y1;
}

/**
 * Tag `n`: a click puts it on the antenna or takes it off; dragged, it lands
 * where it is dropped — on the antenna it is read (and pushes away the one
 * that was there), elsewhere it goes back to the tray.
 */
export function tagControl(n: number): PartControl {
  return {
    hint: t("카드를 끌어 리더의 안테나 위에 놓거나 치우세요 — 클릭하면 올렸다 내렸다 합니다."),
    start(p: ControlPointer, props) {
      const card = Number(props.card) || 0;
      const c = tagCentre(n, card);
      const off = { x: p.x / PITCH - c.x, y: p.y / PITCH - c.y };
      let moved = false;
      return {
        move(q: ControlPointer) {
          if (Math.hypot(q.x - p.x, q.y - p.y) >= 0.4 * PITCH) moved = true;
        },
        release(q: ControlPointer): PropValues {
          if (!moved) return { card: card === n ? 0 : n };
          const on = onAntenna(q.x / PITCH - off.x, q.y / PITCH - off.y);
          return { card: on ? n : card === n ? 0 : card };
        },
      };
    },
  };
}
