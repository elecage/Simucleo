// Direct manipulation of input parts on the breadboard (M14): the building
// blocks behind `PartDef.controls`. Each control turns a pointer gesture on
// an element marked `data-drag="<name>"` into prop values — the same props
// the inspector sliders edit, so both stay in step. The editor (Canvas)
// routes the gesture, throttles the writes and runs the timed ones.
import { PITCH, type ControlPointer, type PartControl, type PropValues } from "./types";
import { t } from "../i18n";

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
    hint: t("노브를 잡고 돌리세요 — 시계 방향으로 돌리면 커집니다. 마우스 휠로도 조금씩 돌아갑니다."),
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
      ? t("누르고 있으면 손가락과 입김으로 온도·습도가 올라갑니다 — 떼면 천천히 돌아옵니다. 끌면 부품이 옮겨집니다.")
      : t("누르고 있으면 손가락 체온으로 데워집니다 — 떼면 천천히 식습니다. 끌면 부품이 옮겨집니다."),
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

// ----------------------------------------------------------- shake

/** How long a shake lasts (ms) and how fast it dies down (ms). */
export const SHAKE_MS = 450;
const SHAKE_TAU = 180;
/** Back-and-forth rate of a shake (Hz). */
const SHAKE_HZ = 5;
const NO_SHAKE: PropValues = { ax: 0, ay: 0, az: 0 };

/**
 * The extra acceleration (g, on top of gravity) `ms` into a shake whose
 * first jolt is `amp` (ax, ay, az): it swings back and forth and dies
 * away; after SHAKE_MS it is all 0.
 */
export function shakeAt(ms: number, amp: [number, number, number]): PropValues {
  if (ms >= SHAKE_MS || ms < 0) return { ...NO_SHAKE };
  // A square-ish swing: every sample (the firmware reads every 100 ms) is
  // a jolt one way or the other, not a zero crossing.
  const swing = Math.cos(2 * Math.PI * SHAKE_HZ * (ms / 1000)) >= 0 ? 1 : -1;
  const k = swing * Math.exp(-ms / SHAKE_TAU);
  return { ax: tidy(amp[0] * k, 0.01), ay: tidy(amp[1] * k, 0.01), az: tidy(amp[2] * k, 0.01) };
}

/** The jolt the shake button gives (g). */
const SHAKE_AMP: [number, number, number] = [1.5, -1.0, 0.5];

/** A button on the sensor: one press shakes it (a few decaying swings). */
export const shakeControl: PartControl = {
  hint: t("누르면 센서를 흔듭니다 — 0.5초쯤 흔들리며 중력에 가속도(ax·ay·az)가 더해집니다."),
  start(p) {
    const t0 = p.t;
    let over = false;
    return {
      set: shakeAt(0, SHAKE_AMP),
      tick(t) {
        if (over) return { done: true };
        over = t - t0 >= SHAKE_MS;
        return { set: shakeAt(t - t0, SHAKE_AMP), done: over };
      },
    };
  },
};

// ------------------------------------------------------------ tilt

/** Largest tilt a drag sets (degrees). */
const MAX_TILT = 90;
/** The rotation rate falls back to 0 this long (ms) after the drag stops moving. */
const GYRO_HOLD = 150;
/** A drag that turns back faster than this (px/ms) is a flick: a shake. */
const FLICK_SPEED = 1.2;

/**
 * Tilting a motion sensor: about 1° per screen pixel, roll from horizontal
 * and pitch from vertical travel. While it moves, the angle's rate of
 * change is what the gyroscope measures. A quick back-and-forth flick
 * shakes it as well, harder the faster the flick.
 */
export const tiltControl: PartControl = {
  hint: t("끌어서 기울이세요 — 좌우는 roll, 위아래는 pitch. 빠르게 왔다 갔다 하면 흔들립니다. 모듈 가장자리를 끌면 옮겨집니다."),
  start(p, props) {
    const roll0 = num(props.roll),
      pitch0 = num(props.pitch);
    let roll = roll0,
      pitch = pitch0,
      t0 = p.t,
      spinning = false;
    const tilt = (v: number) => clamp(Math.round(v), -MAX_TILT, MAX_TILT);
    const rate = (d: number, dt: number) => clamp(Math.round(d / dt), -2000, 2000);
    // Pointer velocity (px/ms) for spotting a reversal, and a shake running.
    let last = { x: p.clientX, y: p.clientY, t: p.t };
    let vel = { x: 0, y: 0 };
    let shake: { t: number; amp: [number, number, number] } | null = null;
    const flick = (q: ControlPointer) => {
      const dt = q.t - last.t;
      if (dt < 4) return;
      const v = { x: (q.clientX - last.x) / dt, y: (q.clientY - last.y) / dt };
      // Turned back hard on either axis: shake along it (screen x moves
      // roll, i.e. the chip's Y axis; screen y the X axis).
      const back = (a: number, b: number) => a * b < 0 && Math.abs(a) > FLICK_SPEED;
      if (back(vel.x, v.x) || back(vel.y, v.y)) {
        const g = (s: number) => clamp(s / FLICK_SPEED, 0.8, 2);
        const sx = back(vel.x, v.x) ? Math.sign(vel.x) * g(Math.abs(vel.x)) : 0;
        const sy = back(vel.y, v.y) ? Math.sign(vel.y) * g(Math.abs(vel.y)) : 0;
        shake = { t: q.t, amp: [sy, sx, 0.3 * Math.hypot(sx, sy)] };
      }
      vel = v;
      last = { x: q.clientX, y: q.clientY, t: q.t };
    };
    return {
      move(q) {
        flick(q);
        const jolt = shake ? shakeAt(q.t - shake.t, shake.amp) : {};
        const r = tilt(roll0 + (q.clientX - p.clientX));
        const pi = tilt(pitch0 + (q.clientY - p.clientY));
        if (r === roll && pi === pitch) return shake ? jolt : undefined;
        const dt = Math.max(8, q.t - t0) / 1000;
        const out = { roll: r, pitch: pi, gx: rate(r - roll, dt), gy: rate(pi - pitch, dt), ...jolt };
        [roll, pitch, t0, spinning] = [r, pi, q.t, true];
        return out;
      },
      release: () => ({ gx: 0, gy: 0 }),
      tick(t, held) {
        const set: PropValues = {};
        if (shake) {
          Object.assign(set, shakeAt(t - shake.t, shake.amp));
          if (t - shake.t >= SHAKE_MS) shake = null;
        }
        if (spinning && (!held || t - t0 > GYRO_HOLD)) {
          spinning = false;
          Object.assign(set, { gx: 0, gy: 0 });
        }
        const any = Object.keys(set).length > 0;
        return { set: any ? set : undefined, done: !held && !shake };
      },
    };
  },
};

// ------------------------------------------------------- joystick (M19)

/** A press that does not move the stick holds SW down after this (ms). */
const STICK_PRESS_MS = 120;
/** A quick click still presses SW for this long (ms). */
const STICK_CLICK_MS = 200;
/** Moving the pointer further than this (part units) is a drag. */
const STICK_SLOP = 0.25 * PITCH;

/**
 * A thumb stick centred at (cx, cy) that travels ±`range` part units in
 * its square: dragging sets `x` (0 left … 1 right) and `y` (0 down … 1
 * up); released, it springs back to the centre. Pressing it without
 * moving pushes the stick down (SW, the `sw` prop), as does a quick click.
 */
export function joystickStick(cx: number, cy: number, range: number): PartControl {
  return {
    hint: t("손잡이를 끌어 기울이세요 — 놓으면 가운데로 돌아옵니다. 움직이지 않고 누르면(클릭) 스틱 버튼(SW)이 눌립니다."),
    start(p) {
      const t0 = p.t;
      let moved = false;
      let pressed = false;
      let clickUntil = 0;
      return {
        move(q) {
          if (!moved && Math.hypot(q.x - p.x, q.y - p.y) < STICK_SLOP) return;
          moved = true;
          const dx = clamp(q.x - cx, -range, range);
          const dy = clamp(q.y - cy, -range, range);
          const out: PropValues = { x: tidy(0.5 + dx / (2 * range), 0.01), y: tidy(0.5 - dy / (2 * range), 0.01) };
          if (pressed) {
            pressed = false;
            out.sw = 0;
          }
          return out;
        },
        release(q): PropValues {
          if (!moved && !pressed) {
            // A quick click: a short press of SW.
            pressed = true;
            clickUntil = q.t + STICK_CLICK_MS;
            return { sw: 1 };
          }
          pressed = false;
          return { x: 0.5, y: 0.5, sw: 0 };
        },
        tick(t, held): { set?: PropValues; done?: boolean } {
          if (held) {
            if (!moved && !pressed && t - t0 >= STICK_PRESS_MS) {
              pressed = true;
              return { set: { sw: 1 } };
            }
            return {};
          }
          if (clickUntil && t < clickUntil) return {};
          return { set: clickUntil ? { sw: 0, x: 0.5, y: 0.5 } : undefined, done: true };
        },
      };
    },
  };
}

// ---------------------------------------------------- PIR person (M19)

/** Motion stops this long (ms) after the figure was last moved. */
export const STILL_MS = 300;
/** The "움직임" button reports motion at least this long (ms). */
const WAVE_MS = 1000;

/**
 * The person in front of a PIR sensor: dragging moves `person` (0 … 1
 * along the track from `x0` to `x1`, part units); while the figure moves
 * inside the field of view (`inView`), `motion` is 1, and it drops back
 * to 0 once the figure stands still or leaves.
 */
export function personDrag(x0: number, x1: number, inView: (pos: number) => boolean): PartControl {
  return {
    hint: t("사람을 좌우로 끌어 센서 앞(부채꼴 안)을 지나가게 하세요 — 움직이는 동안만 움직임이 감지됩니다."),
    start(p, props) {
      const offset = (p.x - x0) / (x1 - x0) - num(props.person);
      let last = p.t;
      let pos = num(props.person);
      let moving = false;
      return {
        move(q) {
          const next = tidy(clamp((q.x - x0) / (x1 - x0) - offset, 0, 1), 0.005);
          if (next === pos) return;
          pos = next;
          last = q.t;
          const m = inView(pos);
          const out: PropValues = { person: pos };
          if (m !== moving) {
            moving = m;
            out.motion = m ? 1 : 0;
          }
          return out;
        },
        tick(t, held) {
          if (moving && t - last >= STILL_MS) {
            moving = false;
            return { set: { motion: 0 }, done: !held };
          }
          return { done: !held && !moving };
        },
      };
    },
  };
}

/** A button: motion while held, and for at least WAVE_MS. */
export const waveControl: PartControl = {
  hint: t("누르면 센서 앞에서 움직임이 생깁니다(누르는 동안, 최소 1초)."),
  start(p) {
    const t0 = p.t;
    return {
      set: { motion: 1 },
      tick(t, held) {
        if (held || t - t0 < WAVE_MS) return {};
        return { set: { motion: 0 }, done: true };
      },
    };
  },
};

// ------------------------------------------------------ shaft (M21)

/**
 * A motor shaft centred at (cx, cy) turned by hand: the angle the pointer
 * sweeps around it adds to `prop` (degrees, unbounded; clockwise
 * positive). The simulator turns the rotor by the difference — a driver
 * that holds the motor pulls it back, a free one stays where it is put.
 */
export function shaftTurn(prop: string, cx: number, cy: number): PartControl {
  const angleAt = (p: ControlPointer) => {
    const dx = p.x - cx,
      dy = p.y - cy;
    return Math.hypot(dx, dy) < 1.5 ? null : (Math.atan2(dx, -dy) * 180) / Math.PI;
  };
  return {
    hint: t("축을 잡고 돌리세요 — 드라이버가 꺼져 있으면(EN High) 손으로 돌아가고, 켜져 있으면 홀딩 토크가 되돌립니다. 마우스 휠로 1.8°씩."),
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
          value += d;
          return { [prop]: tidy(value, 0.1) };
        },
      };
    },
    wheel(deltaY, props) {
      return { [prop]: tidy(num(props[prop]) + (deltaY > 0 ? 1.8 : -1.8), 0.1) };
    },
  };
}
