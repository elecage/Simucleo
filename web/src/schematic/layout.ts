// Schematic of the wired circuit, generated from the netlist: every part as
// a symbol, every connection as a net label on the pin (power nets as ground
// and supply symbols). The breadboard is only mechanics, so it is left out;
// the board shows just the MCU pins in use, by signal (PA5, not D13).
import { pinKey, type PinRef, type Project } from "../editor/model";
import { PART_BY_KIND } from "../parts";
import { nucleoSignal } from "../parts/nucleo";
import type { Netlist } from "../sim/simulator";
import { formatOhms, parseOhms } from "../parts/ohms";

/** Drawing grid (SVG units). */
export const G = 10;
/** Length of a pin's stub outside a symbol. */
export const STUB = 2 * G;
/** Room for net labels between columns. */
const LABEL_ROOM = 22 * G;

export type Shape = "mcu" | "box" | "resistor" | "led" | "switch" | "buzzer";
export type PowerKind = "gnd" | "supply";

export interface SchPin {
  /** Pin ids of the part this terminal stands for (bused pins together). */
  ids: string[];
  /** Shown next to the pin inside the symbol. */
  name: string;
  /** Net name, or null when the pin connects to nothing else. */
  net: string | null;
  side: "left" | "right";
  /** Where the stub ends (the label or power symbol goes there). */
  x: number;
  y: number;
}

export interface SchSymbol {
  part: string;
  kind: string;
  shape: Shape;
  title: string;
  /** Under the title (resistor value, LED colour, …). */
  subtitle?: string;
  /** Body box. */
  x: number;
  y: number;
  w: number;
  h: number;
  pins: SchPin[];
}

export interface SchNet {
  name: string;
  power: PowerKind | null;
  /** MCU signal on this net (PA5), for its live level. */
  signal?: string;
  /** Part pins on the net, for tooltips ("R1.1, LED1.A"). */
  members: string[];
}

export interface Schematic {
  symbols: SchSymbol[];
  nets: Record<string, SchNet>;
  width: number;
  height: number;
}

const POWER_SIGNALS = new Set(["3V3", "5V", "E5V", "VIN", "IOREF", "VBAT"]);
const isBoard = (kind: string) => kind === "nucleo-f401re";
const isMechanical = (kind: string) => kind.startsWith("breadboard");

/** MCU signals in port order (PA0, PA1, … PB0, …). */
function signalOrder(s: string): number {
  const m = /^P([A-H])(\d+)$/.exec(s);
  return m ? (m[1].charCodeAt(0) - 65) * 16 + Number(m[2]) : 1000;
}

const SHAPE_OF: Record<string, Shape> = {
  resistor: "resistor",
  "led-5mm": "led",
  "tact-switch": "switch",
  "buzzer-active": "buzzer",
  "buzzer-passive": "buzzer",
  ldr: "resistor",
  thermistor: "resistor",
};

/** The two terminals of a 2-terminal symbol, left then right. */
const TWO_TERMINALS: Record<string, [string[], string[]]> = {
  resistor: [["1"], ["2"]],
  "led-5mm": [["A"], ["K"]],
  "tact-switch": [["1a", "1b"], ["2a", "2b"]],
  "buzzer-active": [["+"], ["-"]],
  "buzzer-passive": [["+"], ["-"]],
  ldr: [["1"], ["2"]],
  thermistor: [["1"], ["2"]],
};

/**
 * Box symbols laid out by hand: supply pins on the left, signals on the
 * right in the order they are used, and what the module is.
 */
const BOX_LAYOUT: Record<
  string,
  { left: string[]; right: string[]; subtitle: (props: Record<string, string | number>) => string }
> = {
  mpu6050: {
    left: ["VCC", "GND"],
    right: ["SCL", "SDA"],
    subtitle: (p) => `IMU (MPU-6050) · I2C ${p.address ?? "0x68"}`,
  },
  max7219: {
    left: ["VCC", "GND"],
    right: ["DIN", "CLK", "CS", "DOUT"],
    subtitle: (p) => `LED 매트릭스 ×${Math.min(4, Math.max(1, Number(p.count) || 1))} (MAX7219)`,
  },
  // Only the receiver is wired: the remote's buttons are not pins.
  "ir-receiver": {
    left: ["VCC", "GND"],
    right: ["OUT"],
    subtitle: () => "IR 수신기 (VS1838B, NEC)",
  },
};

export function buildSchematic(project: Project, netlist: Netlist): Schematic {
  const kindOf = new Map(project.parts.map((p) => [p.id, p.kind]));
  // Nets that connect something (the breadboard does not count): pins of
  // two parts, or two pins of one part that are not joined inside it (a
  // wire shorting a resistor, a jumper between two MCU signals).
  const terminal = (p: PinRef) => {
    const def = PART_BY_KIND[kindOf.get(p.part) ?? ""];
    const bus = def?.buses?.findIndex((b) => b.includes(p.pin)) ?? -1;
    return bus >= 0 ? `${p.part}#${bus}` : pinKey(p);
  };
  const netOfPin = new Map<string, number>();
  const real = netlist.nets
    .map((n) => n.pins.filter((p) => !isMechanical(kindOf.get(p.part) ?? "")))
    .filter((pins) => new Set(pins.map(terminal)).size >= 2);
  real.forEach((pins, i) => pins.forEach((p) => netOfPin.set(pinKey(p), i)));

  // Name each net: by the MCU signal on it, else N1, N2, ….
  const names: string[] = [];
  const signals: (string | undefined)[] = [];
  let n = 0;
  for (const pins of real) {
    const sigs = [
      ...new Set(pins.filter((p) => isBoard(kindOf.get(p.part)!)).map((p) => nucleoSignal(p.pin) ?? p.pin)),
    ].sort((a, b) => signalOrder(a) - signalOrder(b) || a.localeCompare(b));
    names.push(sigs.length ? sigs.join("/") : `N${++n}`);
    signals.push(sigs.find((s) => /^P[A-H]\d+$/.test(s)));
  }
  const nets: Record<string, SchNet> = {};
  real.forEach((pins, i) => {
    const name = names[i];
    nets[name] = {
      name,
      power: name === "GND" ? "gnd" : POWER_SIGNALS.has(name) ? "supply" : null,
      signal: signals[i],
      members: pins
        .filter((p) => !isBoard(kindOf.get(p.part)!))
        .map((p) => `${p.part}.${p.pin}`)
        .sort(),
    };
  });
  const netName = (p: PinRef) => {
    const i = netOfPin.get(pinKey(p));
    return i === undefined ? null : names[i];
  };

  const symbols: SchSymbol[] = [];

  // The board: the MCU signals in use, I/O first, then power.
  const board = project.parts.find((p) => isBoard(p.kind));
  let mcuH = 0;
  const mcuW = 14 * G;
  if (board) {
    const bySignal = new Map<string, string[]>();
    for (const pin of PART_BY_KIND[board.kind].pins) {
      if (netName({ part: board.id, pin: pin.id }) === null) continue;
      const s = nucleoSignal(pin.id) ?? pin.id;
      bySignal.set(s, [...(bySignal.get(s) ?? []), pin.id]);
    }
    const sigs = [...bySignal.keys()].sort((a, b) => {
      const pa = POWER_SIGNALS.has(a) || a === "GND";
      const pb = POWER_SIGNALS.has(b) || b === "GND";
      return Number(pa) - Number(pb) || signalOrder(a) - signalOrder(b) || a.localeCompare(b);
    });
    mcuH = Math.max(6, sigs.length * 2 + 2) * G;
    const x = 4 * G;
    const y = 6 * G;
    symbols.push({
      part: board.id,
      kind: board.kind,
      shape: "mcu",
      title: "STM32F401RE",
      subtitle: board.id,
      x,
      y,
      w: mcuW,
      h: mcuH,
      pins: sigs.map((s, i) => {
        const ids = bySignal.get(s)!;
        // The Arduino name, when the signal has one (D13, A0).
        const alias = ids.find((id) => /^[DA]\d+$/.test(id));
        return {
          ids,
          name: alias ? `${s} (${alias})` : s,
          net: netName({ part: board.id, pin: ids[0] }),
          side: "right" as const,
          x: x + mcuW + STUB,
          y: y + (2 * i + 2) * G,
        };
      }),
    });
  }

  // Other parts in columns to the right, those on lower MCU pins first.
  // Compared pin by pin, so of two parts on the same clock the one on more
  // MCU pins (the first of a chain) comes first.
  const order = new Map(symbols[0]?.pins.map((p, i) => [p.net, i]) ?? []);
  const rank = (id: string) => {
    const def = PART_BY_KIND[kindOf.get(id)!];
    return def.pins.map((p) => order.get(netName({ part: id, pin: p.id })) ?? 999).sort((a, b) => a - b);
  };
  const byRank = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] ?? 999) - (b[i] ?? 999);
      if (d) return d;
    }
    return 0;
  };
  const parts = project.parts
    .filter((p) => !isBoard(p.kind) && !isMechanical(p.kind) && PART_BY_KIND[p.kind])
    .sort((a, b) => byRank(rank(a.id), rank(b.id)) || a.id.localeCompare(b.id));
  const colX0 = (board ? 4 * G + mcuW + STUB : 0) + LABEL_ROOM + STUB;
  const maxColH = Math.max(mcuH + 6 * G, 60 * G);
  let colX = colX0;
  let colW = 0;
  let y = 6 * G;
  for (const part of parts) {
    const def = PART_BY_KIND[part.kind];
    const shape = SHAPE_OF[part.kind] ?? "box";
    let sym: SchSymbol;
    const title = part.id;
    const subtitle =
      part.kind === "resistor"
        ? ((r) => (r ? formatOhms(r) : ""))(parseOhms(part.props.ohms ?? def.props?.ohms ?? ""))
        : part.kind === "led-5mm"
          ? `LED ${part.props.color ?? def.props?.color ?? ""}`
          : (BOX_LAYOUT[part.kind]?.subtitle({ ...def.props, ...part.props }) ?? def.name);
    if (shape !== "box") {
      const [l, r] = TWO_TERMINALS[part.kind];
      const w = 6 * G;
      const h = 4 * G;
      const term = (ids: string[], side: "left" | "right", px: number): SchPin => ({
        ids,
        name: ids.join("/"),
        net: ids.map((id) => netName({ part: part.id, pin: id })).find((x) => x !== null) ?? null,
        side,
        x: px,
        y: 0,
      });
      sym = {
        part: part.id,
        kind: part.kind,
        shape,
        title,
        subtitle,
        x: 0,
        y: 0,
        w,
        h,
        pins: [term(l, "left", 0), term(r, "right", 0)],
      };
    } else {
      // Bused pins (COM and COM2) are one terminal.
      const groups: string[][] = [];
      const seen = new Set<string>();
      const layout = BOX_LAYOUT[part.kind];
      const listed = layout ? [...layout.left, ...layout.right] : [];
      for (const p of [...listed.map((id) => ({ id })), ...def.pins]) {
        if (seen.has(p.id)) continue;
        const bus = def.buses?.find((b) => b.includes(p.id)) ?? [p.id];
        bus.forEach((id) => seen.add(id));
        groups.push(bus);
      }
      const left = layout ? layout.left.length : Math.ceil(groups.length / 2);
      const rows = Math.max(left, groups.length - left);
      const longest = Math.max(...groups.map((g) => g.join("/").length));
      const w = Math.max(10 * G, Math.ceil((longest * 2 * 7 + 3 * G) / G) * G);
      const h = (rows * 2 + 2) * G;
      sym = {
        part: part.id,
        kind: part.kind,
        shape,
        title,
        subtitle,
        x: 0,
        y: 0,
        w,
        h,
        pins: groups.map((ids, i) => ({
          ids,
          name: ids.join("/"),
          net: ids.map((id) => netName({ part: part.id, pin: id })).find((x) => x !== null) ?? null,
          side: i < left ? ("left" as const) : ("right" as const),
          x: 0,
          y: ((i < left ? i : i - left) * 2 + 2) * G,
        })),
      };
    }
    // Next column when this one is full.
    if (y > 6 * G && y + sym.h + 4 * G > maxColH) {
      colX += colW + 2 * STUB + LABEL_ROOM * 2;
      colW = 0;
      y = 6 * G;
    }
    sym.x = colX;
    sym.y = y + 2 * G; // room for the title
    for (const p of sym.pins) {
      if (sym.shape !== "box") p.y = sym.h / 2;
      p.x = sym.x + (p.side === "left" ? -STUB : sym.w + STUB);
      p.y += sym.y;
    }
    symbols.push(sym);
    colW = Math.max(colW, sym.w);
    y = sym.y + sym.h + 4 * G;
  }

  const right = Math.max(colX + colW + STUB + LABEL_ROOM, board ? 4 * G + mcuW + STUB + LABEL_ROOM : 0);
  const bottom = Math.max(...symbols.map((s) => s.y + s.h), 0) + 6 * G;
  return { symbols, nets, width: right, height: bottom };
}
