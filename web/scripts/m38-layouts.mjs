// M38: the layouts of the bundled circuits. Each entry places the parts
// (through-hole parts seated in breadboard holes, modules beside the
// board) and names the rails; scripts/route.mjs then draws the jumpers
// that make exactly the nets recorded in test/data/m38-nets.json.
//
//   node scripts/m38-layouts.mjs [name-filter …]
//
// Re-running it rewrites the circuits' wires (colours are kept per net).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadAppModel } from "./appmodel.mjs";
import { allCircuits, saveCircuit, web } from "./circuits.mjs";
import { holePoint, rewire, seat as seatPart } from "./route.mjs";

const snapshot = JSON.parse(readFileSync(join(web, "test", "data", "m38-nets.json"), "utf8"));
const model = await loadAppModel();

/** Helpers handed to each layout. */
function context(project, nets) {
  const part = (id) => {
    const p = project.parts.find((x) => x.id === id);
    if (!p) throw new Error(`no part ${id}`);
    return p;
  };
  const netWith = (k) => nets.find((n) => n.split(" ").includes(k))?.split(" ") ?? [];
  const opts = { rails: {}, colors: {}, prefer: {} };
  const ctx = {
    opts,
    part,
    has: (id) => project.parts.some((p) => p.id === id),
    /** Add (or move) a half breadboard. */
    bb(id, x, y) {
      const p = project.parts.find((q) => q.id === id);
      if (p) Object.assign(p, { x, y });
      else project.parts.splice(1, 0, { id, kind: "breadboard-half", x, y, props: {} });
    },
    place(id, x, y) {
      Object.assign(part(id), { x, y });
    },
    seat(id, pin, hole) {
      seatPart(model, project, id, pin, hole);
    },
    /** Rails by net: `rails({ "bb1:tp": "3V3", "bb1:bn": "GND_P1" })`. */
    rails(r) {
      for (const [k, v] of Object.entries(r)) opts.rails[k] = v.includes(":") ? v : `nucleo:${v}`;
    },
    /** Is `a` on the same net as `b` (pin keys)? */
    joined: (a, b) => netWith(a).includes(b),
    /**
     * An LED with its series resistor in the lower half: the LED's legs
     * in row f (it leans over the channel), the resistor in row g from
     * the signal column to the anode column, so the cathode column has
     * rows h–j free for its jumper to the ground rail. `col` is the
     * leftmost column used; returns the first free column after it.
     */
    ledCell(led, r, bb, col, row = "g") {
      // Which LED leg meets which resistor leg (a start circuit may have it reversed, or not at all).
      const pair = ["A", "K"].flatMap((x) => ["1", "2"].filter((y) => ctx.joined(`${led}:${x}`, `${r}:${y}`)).map((y) => [x, y]))[0];
      if (!pair) {
        // Not joined yet (a lesson's start): the LED in the upper half, the resistor below it.
        ctx.seat(led, "K", `${bb}:e${col}`);
        ctx.seat(r, "1", `${bb}:${row}${col}`);
        return col + 5;
      }
      const [x, y] = pair;
      // The LED's cathode column k, anode k + 1; the resistor leg y in the column of leg x.
      const legCol = (k) => (x === "A" ? k + 1 : k);
      const k = y === "2" ? col + 4 - (x === "A" ? 1 : 0) : col;
      ctx.seat(led, "K", `${bb}:f${k}`);
      ctx.seat(r, y, `${bb}:${row}${legCol(k)}`);
      return Math.max(k + 2, legCol(k) + (y === "1" ? 5 : 1));
    },
    /** Grid point of a hole, for placing modules next to it. */
    hole: (h) => {
      const [bb, id] = h.split(":");
      return holePoint(part(bb), id);
    },
  };
  return ctx;
}

const L = {};

/** The rails of the analogue lessons' start circuits (their text names them). */
const RAILS_3V3_TOP_5V_BOTTOM = { "bb1:tp": "3V3", "bb1:tn": "GND_P1", "bb1:bp": "5V", "bb1:bn": "GND_P1" };

// ------------------------------------------------------------ A. basics

const ledOnly = (c) => {
  c.bb("bb1", 42, 4);
  c.ledCell("led1", "r1", "bb1", 10);
  c.rails({ "bb1:bn": "GND_P1" });
};
L["examples/lesson-led-on"] = ledOnly;
L["examples/lesson-sleep-wfi"] = ledOnly;
L["e2e/solutions/led-blink"] = ledOnly;
L["e2e/solutions/pwm-breathe"] = ledOnly;

/** A tact switch straddling the channel: 1a·1b in row e, 2a·2b in row f. */
const button = (c, sw, col, bb = "bb1") => c.seat(sw, "1a", `${bb}:e${col}`);

const buttonLed = (c) => {
  c.bb("bb1", 42, 4);
  c.ledCell("led1", "r1", "bb1", 6);
  button(c, "sw1", 20);
  c.rails({ "bb1:bn": "GND_P1" });
};
L["examples/hal-button-exti"] = buttonLed;
L["examples/lesson-button-poll"] = buttonLed;

L["examples/lesson-knight-rider"] = (c) => {
  c.bb("bb1", 42, 4);
  let col = 4;
  for (const i of [0, 1, 2, 3]) col = c.ledCell(`led${i}`, `r${i}`, "bb1", col) + 1;
  c.rails({ "bb1:bn": "GND_P1" });
};

const twoLeds = (c) => {
  c.bb("bb1", 42, 4);
  const col = c.ledCell("led1", "r1", "bb1", 6) + 3;
  c.ledCell("led2", "r2", "bb1", col);
  c.rails({ "bb1:bn": "GND_P1" });
};
L["examples/lesson-timer-irq"] = twoLeds;
L["examples/lesson-scope-mystery"] = twoLeds;

L["examples/lesson-ldr-nightlight"] = (c) => {
  c.bb("bb1", 42, 4);
  c.ledCell("led1", "r1", "bb1", 4);
  // 3V3 → rl → A1 → LDR → GND: a divider.
  c.seat("rl", "1", "bb1:g16");
  c.seat("ldr", "1", "bb1:f20");
  c.rails({ "bb1:bp": "3V3", "bb1:bn": "GND_P1" });
};

L["examples/lesson-debug-average"] = (c) => {
  c.bb("bb1", 42, 4);
  c.ledCell("led1", "r1", "bb1", 4);
  c.seat("pot", "1", "bb1:f18");
  c.rails({ "bb1:bp": "3V3", "bb1:bn": "GND_P1" });
};

L["examples/lesson-parking"] = (c) => {
  c.bb("bb1", 42, 4);
  let col = 1;
  for (const i of [1, 2, 3]) col = c.ledCell(`led${i}`, `r${i}`, "bb1", col);
  c.seat("bz1", "+", "bb1:f17");
  c.seat("us", "VCC", "bb1:f24");
  c.rails({ "bb1:bp": "5V", "bb1:bn": "GND_P1" });
};

L["examples/lesson-thermostat"] = (c) => {
  c.bb("bb1", 42, 4);
  c.seat("aht", "VCC", "bb1:f4");
  // NO → rh → heater LED → GND.
  c.ledCell("heat", "rh", "bb1", 14);
  c.place("oled", 46, 30);
  c.place("k1", 82, 12);
  c.rails({ "bb1:bp": "3V3", "bb1:bn": "GND_P1", "bb1:tp": "5V", "bb1:tn": "GND_P1" });
};

// ------------------------------------------------------- B–C. analogue

L["examples/hal-adc-servo"] = (c) => {
  c.bb("bb1", 42, 4);
  // As in the lessons (04, C1, C4, E5): upper rails 3V3/GND, lower rails 5V/GND.
  // The sensors stand in the upper half, a jumper from row a to the rail above.
  c.seat("pot", "1", "bb1:e3");
  c.seat("tmp", "VS", "bb1:e8");
  // 3V3 → r1 → A1 → LDR → GND; the LDR's legs in row a, the resistor in row c.
  c.seat("r1", "1", "bb1:c14");
  c.seat("ldr", "1", "bb1:a18");
  c.place("sv", 50, 29);
  c.place("m", 60, 29);
  c.rails(RAILS_3V3_TOP_5V_BOTTOM);
};

L["examples/hal-pwm-led"] = (c) => {
  c.bb("bb1", 42, 4);
  // R, COM, G, B in row f; each colour's resistor runs right to its signal column.
  c.seat("rgb1", "R", "bb1:f10");
  c.seat("rR", "1", "bb1:g10");
  c.seat("rG", "1", "bb1:h12");
  c.seat("rB", "1", "bb1:i13");
  c.rails({ "bb1:bn": "GND_P1" });
};

L["examples/hal-buzzer-melody"] = (c) => {
  c.bb("bb1", 42, 4);
  c.seat("bz1", "+", "bb1:f12");
  c.rails({ "bb1:bn": "GND_P1" });
};

L["examples/hal-pir-alarm"] = (c) => {
  c.bb("bb1", 42, 4);
  c.ledCell("led", "r1", "bb1", 6);
  c.place("pir", 80, 4);
  c.rails({ "bb1:bn": "GND_P1", "bb1:bp": "5V" });
};

L["examples/hal-relay"] = (c) => {
  c.bb("bb1", 42, 4);
  button(c, "sw1", 6);
  c.ledCell("lamp", "r1", "bb1", 14);
  c.place("k1", 82, 12);
  c.rails({ "bb1:bn": "GND_P1", "bb1:tp": "5V", "bb1:tn": "GND_P1" });
};

L["examples/hal-onewire-multi"] = (c) => {
  c.bb("bb1", 42, 4);
  c.seat("t1", "GND", "bb1:f6");
  c.seat("t2", "GND", "bb1:f12");
  c.seat("t3", "GND", "bb1:f18");
  c.rails({ "bb1:bp": "3V3", "bb1:bn": "GND_P1" });
};

L["examples/hal-dht-capture"] = (c) => {
  c.bb("bb1", 42, 4);
  c.seat("dht", "VCC", "bb1:f12");
  c.rails({ "bb1:bp": "3V3", "bb1:bn": "GND_P1" });
};

L["examples/hal-bmp280"] = (c) => {
  c.bb("bb1", 42, 4);
  c.seat("baro", "VCC", "bb1:f12");
  c.rails({ "bb1:bp": "3V3", "bb1:bn": "GND_P1" });
};

L["examples/hal-sonar-onewire"] = (c) => {
  c.bb("bb1", 42, 4);
  c.seat("ds", "GND", "bb1:f5");
  c.seat("us", "VCC", "bb1:f17");
  c.rails({ "bb1:bp": "3V3", "bb1:bn": "GND_P1", "bb1:tp": "5V", "bb1:tn": "GND_P1" });
};

// ------------------------------------------------------------ D. buses

L["examples/hal-i2c-oled"] = (c) => {
  c.bb("bb1", 42, 4);
  c.seat("rtc", "SCL", "bb1:f6");
  c.seat("aht", "VCC", "bb1:f16");
  c.place("oled", 80, 6);
  c.rails({ "bb1:bp": "3V3", "bb1:bn": "GND_P1" });
};

L["examples/hal-spi-sd-logger"] = (c) => {
  c.bb("bb1", 42, 4);
  c.seat("rtc", "SCL", "bb1:f3");
  c.seat("aht", "VCC", "bb1:f10");
  c.seat("sd", "GND", "bb1:f18");
  c.place("oled", 80, 6);
  c.rails({ "bb1:bp": "3V3", "bb1:bn": "GND_P1", "bb1:tp": "5V", "bb1:tn": "GND_P1" });
};

L["examples/hal-shift-register"] = (c) => {
  c.bb("bb1", 42, 4);
  c.bb("bb2", 78, 4);
  // The 74HC595 straddles the channel: VCC…Q7S in row e, Q1…GND in row f.
  c.seat("sr", "VCC", "bb1:e2");
  let col = 11;
  for (const i of [0, 1, 2, 3]) col = c.ledCell(`led${i}`, `r${i}`, "bb1", col);
  col = 2;
  for (const i of [4, 5, 6, 7]) col = c.ledCell(`led${i}`, `r${i}`, "bb2", col) + 1;
  c.rails({ "bb1:tp": "3V3", "bb1:tn": "GND_P1", "bb1:bn": "GND_P1", "bb2:bn": "GND_P1" });
};

L["examples/hal-7seg-keypad"] = (c) => {
  c.bb("bb1", 42, 4);
  c.bb("bb2", 42, 28);
  // The display straddles the channel (top pins in row b, bottom pins in row h).
  c.seat("disp", "D1", "bb1:b12");
  let col = 2;
  for (const i of [0, 1, 2, 3]) {
    c.seat(`r${i}`, "1", `bb2:${"fghi"[i]}${col}`);
    col += 1;
  }
  col = 14;
  for (const i of [4, 5, 6, 7]) {
    c.seat(`r${i}`, "1", `bb2:${"fghi"[i - 4]}${col}`);
    col += 1;
  }
  c.place("kp", 8, -18);
};

L["examples/hal-encoder-stepper-lcd"] = (c) => {
  c.bb("bb1", 42, 4);
  c.seat("enc", "CLK", "bb1:f3");
  // 3V3 → r1 → A0 → thermistor → GND.
  c.seat("r1", "1", "bb1:g12");
  c.seat("ntc", "1", "bb1:f16");
  c.place("lcd", 80, 2);
  c.place("mot", 84, 18);
  c.rails({ "bb1:bp": "3V3", "bb1:bn": "GND_P1", "bb1:tp": "5V", "bb1:tn": "GND_P1" });
};

L["examples/hal-imu-matrix"] = (c) => {
  c.bb("bb1", 42, 4);
  c.seat("imu", "VCC", "bb1:f6");
  c.place("mx", 82, 4);
  c.place("bar", 82, 16);
  c.rails({ "bb1:bp": "3V3", "bb1:bn": "GND_P1", "bb1:tp": "5V", "bb1:tn": "GND_P1" });
};

L["examples/lesson-digital-clock"] = (c) => {
  c.bb("bb1", 42, 4);
  c.seat("rtc", "SCL", "bb1:f4");
  button(c, "sw1", 14);
  c.place("disp", 80, 6);
  c.rails({ "bb1:bp": "3V3", "bb1:bn": "GND_P1" });
};

// -------------------------------------------- modules only (no breadboard)

L["examples/hal-bluetooth-led"] = (c) => c.place("bt", 46, 10);
L["examples/hal-ir-remote"] = (c) => c.place("ir", 46, 8);
L["examples/hal-tm1637-clock"] = (c) => c.place("disp", 46, 12);
L["examples/hal-neopixel-dma"] = (c) => c.place("ring", 46, 10);
L["examples/hal-neopixel-chain"] = (c) => {
  c.place("ring", 46, 10);
  c.place("strip", 62, 30);
};
L["examples/hal-joystick-oled"] = (c) => {
  c.place("oled", 46, 10);
  c.place("js", 64, 10);
};
L["examples/hal-servos-multi"] = (c) => {
  c.place("s1", 46, 12);
  c.place("s2", 54, 12);
  c.place("s3", 62, 12);
};
L["examples/lesson-joystick-servos"] = (c) => {
  c.place("js", 46, 10);
  c.place("s1", 60, 12);
  c.place("s2", 68, 12);
};
L["examples/hal-stepper-a4988"] = (c) => {
  c.place("drv", 50, 10);
  c.place("mot", 64, 8);
  c.place("bat", 50, 26);
};
L["examples/hal-stepper-l298n"] = (c) => {
  c.place("br", 50, 10);
  c.place("mot", 66, 8);
  c.place("bat", 50, 28);
};
L["examples/hal-bldc-hall"] = (c) => {
  c.place("br", 50, 10);
  c.place("mot", 66, 8);
  c.place("bat", 50, 28);
};

L["examples/hal-bldc-pwm"] = (c) => {
  c.bb("bb1", 42, 30);
  c.seat("pot", "1", "bb1:f4");
  c.place("br", 50, 8);
  c.place("mot", 66, 6);
  c.place("bat", 66, 22);
  c.rails({ "bb1:bp": "3V3", "bb1:bn": "GND_P1" });
};

L["examples/hal-esc-bldc"] = (c) => {
  c.bb("bb1", 42, 4);
  c.seat("pot", "1", "bb1:f6");
  c.place("esc", 80, 6);
  c.place("bat", 82, 22);
  c.rails({ "bb1:bp": "3V3", "bb1:bn": "GND_P1" });
};

L["examples/hal-bldc-sensorless"] = (c) => {
  c.bb("bb1", 42, 30);
  c.seat("pot", "1", "bb1:f2");
  // Per phase: OUT → r?1 → A? → r?2 → GND, and r n? from A? to the virtual neutral (A5).
  c.seat("ru1", "1", "bb1:g8");
  c.seat("ru2", "1", "bb1:h12");
  c.seat("rnu", "1", "bb1:a12");
  c.seat("rv1", "1", "bb1:g15");
  c.seat("rv2", "1", "bb1:h19");
  c.seat("rnv", "1", "bb1:b19");
  c.seat("rw1", "1", "bb1:i22");
  c.seat("rw2", "1", "bb1:j26");
  c.seat("rnw", "1", "bb1:c26");
  c.place("br", 50, 8);
  c.place("mot", 66, 6);
  c.place("bat", 82, 12);
  c.rails({ "bb1:bp": "3V3", "bb1:bn": "GND_P1" });
};

// ------------------------------------------------ lesson start circuits
// The same builds as the reference circuits, with only what the start has
// joined: loose LEDs sit in the upper half, their resistors below them.

const S = (lesson) => `lessons/${lesson}#start`;
const loose = (pairs) => (c) => {
  c.bb("bb1", 42, 4);
  let col = 4;
  for (const [led, r] of pairs) col = c.ledCell(led, r, "bb1", col) + 2;
  c.rails({});
};
L[S("a4-button-poll")] = buttonLed;
L[S("a6-knight-rider")] = loose([0, 1, 2, 3].map((i) => [`led${i}`, `r${i}`]));
L[S("a7-seven-segment")] = L["examples/hal-7seg-keypad"];
L[S("b1-timer-irq")] = loose([["led1", "r1"], ["led2", "r2"]]);
L[S("b2-pwm-breathe")] = loose([["led1", "r1"]]);
L[S("f3-sleep-wfi")] = loose([["led1", "r1"]]);
L[S("f4-scope-measure")] = loose([["led1", "r1"], ["led2", "r2"]]);
L[S("b5-servo")] = L["examples/hal-servos-multi"];
L[S("c5-joystick-servos")] = L["examples/lesson-joystick-servos"];
L[S("04-adc-servo")] = (c) => {
  c.bb("bb1", 42, 4);
  c.seat("pot", "1", "bb1:e3");
  c.place("sv", 50, 29);
  c.rails(RAILS_3V3_TOP_5V_BOTTOM);
};
L[S("c1-pot-serial")] = (c) => {
  c.bb("bb1", 42, 4);
  c.seat("pot", "1", "bb1:e3");
  c.rails(RAILS_3V3_TOP_5V_BOTTOM);
};
L[S("c4-tmp36")] = (c) => {
  c.bb("bb1", 42, 4);
  c.seat("tmp", "VS", "bb1:e8");
  c.rails(RAILS_3V3_TOP_5V_BOTTOM);
};
L[S("c3-ldr-nightlight")] = (c) => {
  c.bb("bb1", 42, 4);
  c.ledCell("led1", "r1", "bb1", 4);
  c.seat("rl", "1", "bb1:h11");
  c.seat("ldr", "1", "bb1:f18");
};
L[S("05-i2c-oled")] = L["examples/hal-i2c-oled"];
L[S("d3-i2c-rtc")] = L["examples/hal-i2c-oled"];
L[S("d4-spi-595")] = L["examples/hal-shift-register"];
L[S("d6-onewire-ds18b20")] = L["examples/hal-onewire-multi"];
L[S("e1-sonar-alarm")] = (c) => {
  c.bb("bb1", 42, 4);
  c.ledCell("led3", "r3", "bb1", 4);
  c.seat("us", "VCC", "bb1:f20");
};
L[S("e2-pir-alarm")] = L["examples/hal-pir-alarm"];
L[S("e4-stepper-a4988")] = L["examples/hal-stepper-a4988"];
L[S("e5-dc-motor")] = (c) => {
  c.bb("bb1", 42, 4);
  c.seat("r1", "1", "bb1:c14");
  c.seat("ldr", "1", "bb1:a18");
  c.place("m", 60, 29);
  c.rails(RAILS_3V3_TOP_5V_BOTTOM);
};
L[S("e6-relay")] = L["examples/hal-relay"];
L[S("g1-thermostat")] = L["examples/lesson-thermostat"];
L[S("g2-parking-assist")] = L["examples/lesson-parking"];
L[S("g3-digital-clock")] = L["examples/lesson-digital-clock"];

// ------------------------------------------------------------------- run

const filters = process.argv.slice(2);
let done = 0;
for (const [name, file, project] of allCircuits()) {
  const short = name.replace(/\.simucleo\.json$/, "").replace(/\.json#start$/, "#start");
  const layout = L[short];
  if (!layout || (filters.length && !filters.some((f) => short.includes(f)))) continue;
  const nets = snapshot[name].nets;
  const oldWires = project.wires;
  const c = context(project, nets);
  layout(c);
  try {
    rewire(model, project, nets, { ...c.opts, oldWires });
  } catch (e) {
    console.error(`${short}: ${e.message}`);
    process.exitCode = 1;
    continue;
  }
  saveCircuit(name, file, project);
  done++;
  console.log(`${short}: ${project.wires.length} jumpers`);
}
console.log(`${done} circuits laid out`);
