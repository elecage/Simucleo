// Direct manipulation of input parts on the breadboard (M14): the building
// blocks behind `PartDef.controls`. Each control turns a pointer gesture on
// an element marked `data-drag="<name>"` into prop values — the same props
// the inspector sliders edit, so both stay in step. The editor (Canvas)
// routes the gesture, throttles the writes and runs the timed ones.
import { PITCH, type ControlPointer, type PartControl, type PropValues } from "./types";

const num = (v: string | number | undefined) => Number(v) || 0;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round = (v: number, step: number) => Math.round(v / step) * step;
/** Rounds without float noise (0.30000000000000004). */
const tidy = (v: number, step: number) => Number(round(v, step).toFixed(6));

// ------------------------------------------------------------- knob

/**
 * A rotary knob centred at (cx, cy) in part units: grab it and turn. The
 * angle the pointer sweeps around the centre moves `prop` over [0, 1] for
 * `travel` degrees (no jump on the press, it follows the hand).
 */
export function rotaryKnob(prop: string, cx: number, cy: number, travel = 270): PartControl {
  const angleAt = (p: ControlPointer) => {
    const dx = p.x - cx,
      dy = p.y - cy;
    // Too near the centre the angle is noise.
    return Math.hypot(dx, dy) < 2 ? null : (Math.atan2(dx, -dy) * 180) / Math.PI;
  };
  return {
    hint: "노브를 잡고 돌리세요 — 시계 방향으로 돌리면 커집니다. 마우스 휠로도 조금씩 돌아갑니다.",
    start(p, props) {
      let value = num(props[prop]);
      let prev = angleAt(p);
      return {
        move(q) {
          const a = angleAt(q);
          if (a === null) return;
          if (prev === null) {
            prev = a;
            return;
          }
          const d = ((a - prev + 540) % 360) - 180;
          prev = a;
          value = clamp(value + d / travel, 0, 1);
          return { [prop]: tidy(value, 0.001) };
        },
      };
    },
    wheel(deltaY, props) {
      // One notch (100 px) is 2 % of the travel; trackpads send less.
      const step = clamp(-deltaY / 100, -1, 1) * 0.02;
      return { [prop]: tidy(clamp(num(props[prop]) + step, 0, 1), 0.001) };
    },
  };
}

// ----------------------------------------------------- slide handle

export interface Slide {
  /** Distance from the sensor's face (grid steps) ↔ prop value. */
  toValue: (d: number) => number;
  fromValue: (v: number) => number;
  min: number;
  max: number;
}

/**
 * A handle above the part (a lamp, an obstacle) that slides along the line
 * up from `faceY` (part units): its distance sets `prop` through `slide`.
 */
export function slideHandle(prop: string, faceY: number, slide: Slide, hint: string): PartControl {
  const distAt = (p: ControlPointer) => (faceY - p.y) / PITCH;
  return {
    hint,
    start(p, props) {
      // Keep the handle where it was grabbed (no jump).
      const offset = distAt(p) - slide.fromValue(num(props[prop]));
      return {
        move(q) {
          const d = clamp(distAt(q) - offset, slide.min, slide.max);
          return { [prop]: slide.toValue(d) };
        },
      };
    },
  };
}

// ------------------------------------------------------- hold value

/** While pressed, the props take `values`; released, they go back. */
export function holdValues(values: PropValues, hint: string): PartControl {
  return {
    hint,
    start(_p, props) {
      const saved: PropValues = Object.fromEntries(Object.keys(values).map((k) => [k, num(props[k])]));
      return { set: values, release: () => saved };
    },
  };
}

// ---------------------------------------------------- finger touch

/** Skin temperature a fingertip warms a small sensor towards (°C). */
export const FINGER_C = 33;
/** Relative humidity breath carries to a humidity sensor (%). */
export const BREATH_RH = 85;
/** Time constants (s): warming under the finger, cooling off in still air. */
const WARM_S = 3;
const COOL_S = 3.5;
/** A press shorter than this (ms) does not warm anything. */
const TOUCH_DELAY = 250;

/**
 * Press and hold to touch the sensor: `temp` heads for skin temperature
 * with a first-order lag, `humidity` (if given) for breath; released, both
 * relax back to what they were before the touch. Moving the inspector
 * slider meanwhile stops the animation.
 */
export function fingerTouch(temp: string, humidity?: string): PartControl {
  const keys = humidity ? [temp, humidity] : [temp];
  return {
    hint: humidity
      ? "누르고 있으면 손가락과 입김으로 온도·습도가 올라갑니다 — 떼면 천천히 돌아옵니다. 끌면 부품이 옮겨집니다."
      : "누르고 있으면 손가락 체온으로 데워집니다 — 떼면 천천히 식습니다. 끌면 부품이 옮겨집니다.",
    holdOnly: true,
    start(p, props, carry) {
      // Touched again while still cooling: the same room to return to.
      const ambient = (carry as PropValues | undefined) ?? Object.fromEntries(keys.map((k) => [k, num(props[k])]));
      const cur: PropValues = Object.fromEntries(keys.map((k) => [k, num(props[k])]));
      let written: PropValues = { ...cur };
      let last = p.t;
      return {
        carry: ambient,
        tick(t, held, now) {
          // Someone moved the slider: theirs wins.
          if (keys.some((k) => Math.abs(num(now[k]) - written[k]) > 1e-6)) return { done: true };
          const dt = Math.max(0, t - last) / 1000;
          last = t;
          // A quick click (to select the part) is not a touch.
          if (held && t - p.t < TOUCH_DELAY) return {};
          const k = 1 - Math.exp(-dt / (held ? WARM_S : COOL_S));
          cur[temp] += ((held ? FINGER_C : ambient[temp]) - cur[temp]) * k;
          if (humidity) cur[humidity] += ((held ? Math.max(BREATH_RH, ambient[humidity]) : ambient[humidity]) - cur[humidity]) * k;
          const settled = !held && keys.every((key) => Math.abs(cur[key] - ambient[key]) < 0.15);
          const out = settled ? { ...ambient } : Object.fromEntries(keys.map((key) => [key, tidy(cur[key], 0.1)]));
          const changed = keys.some((key) => out[key] !== written[key]);
          written = out;
          return { set: changed ? out : undefined, done: settled };
        },
      };
    },
  };
}

// ------------------------------------------------------------ tilt

/** Largest tilt a drag sets (degrees). */
const MAX_TILT = 90;
/** The rotation rate falls back to 0 this long (ms) after the drag stops moving. */
const GYRO_HOLD = 150;

/**
 * Tilting a motion sensor: about 1° per screen pixel, roll from horizontal
 * and pitch from vertical travel. While it moves, the angle's rate of
 * change is what the gyroscope measures.
 */
export const tiltControl: PartControl = {
  hint: "끌어서 기울이세요 — 좌우는 roll, 위아래는 pitch. 모듈 가장자리를 끌면 옮겨집니다.",
  start(p, props) {
    const roll0 = num(props.roll),
      pitch0 = num(props.pitch);
    let roll = roll0,
      pitch = pitch0,
      t0 = p.t,
      spinning = false;
    const tilt = (v: number) => clamp(Math.round(v), -MAX_TILT, MAX_TILT);
    const rate = (d: number, dt: number) => clamp(Math.round(d / dt), -2000, 2000);
    return {
      move(q) {
        const r = tilt(roll0 + (q.clientX - p.clientX));
        const pi = tilt(pitch0 + (q.clientY - p.clientY));
        if (r === roll && pi === pitch) return;
        const dt = Math.max(8, q.t - t0) / 1000;
        const out = { roll: r, pitch: pi, gx: rate(r - roll, dt), gy: rate(pi - pitch, dt) };
        [roll, pitch, t0, spinning] = [r, pi, q.t, true];
        return out;
      },
      release: () => ({ gx: 0, gy: 0 }),
      tick(t, held) {
        if (!held) return { done: true };
        if (spinning && t - t0 > GYRO_HOLD) {
          spinning = false;
          return { set: { gx: 0, gy: 0 } };
        }
        return {};
      },
    };
  },
};
