// Every bundled circuit: the example projects, the lesson solutions used by
// the E2E tests and the start circuits written into lessons. Shared by the
// layout check (test/m38.test.ts), its snapshot and scripts/route.mjs.
import { projectNets } from "./appmodel.mjs";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const web = join(dirname(fileURLToPath(import.meta.url)), "..");

/** `[name, file, project]` of every circuit; `name` is the file relative to web/. */
export function allCircuits() {
  const out = [];
  for (const dir of ["examples", "e2e/solutions"]) {
    for (const f of readdirSync(join(web, dir)).filter((f) => f.endsWith(".simucleo.json")).sort()) {
      const file = join(web, dir, f);
      out.push([`${dir}/${f}`, file, JSON.parse(readFileSync(file, "utf8"))]);
    }
  }
  for (const f of readdirSync(join(web, "lessons")).filter((f) => f.endsWith(".json")).sort()) {
    const file = join(web, "lessons", f);
    const lesson = JSON.parse(readFileSync(file, "utf8"));
    if (lesson.start && typeof lesson.start === "object" && "project" in lesson.start) {
      out.push([`lessons/${f}#start`, file, lesson.start.project]);
    }
  }
  return out;
}

/** One-line JSON with spaces, as the lesson files write small objects. */
const inline = (v) =>
  v !== null && typeof v === "object"
    ? Array.isArray(v)
      ? `[${v.map(inline).join(", ")}]`
      : Object.keys(v).length
        ? `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(", ")} }`
        : "{}"
    : JSON.stringify(v);

/** JSON with 2-space indent, objects and arrays that fit on one line kept on one line. */
export function pretty(v, indent = "") {
  const one = inline(v);
  if (indent.length + one.length <= 120 || v === null || typeof v !== "object") return one;
  const inner = indent + "  ";
  if (Array.isArray(v)) return `[\n${v.map((x) => inner + pretty(x, inner)).join(",\n")}\n${indent}]`;
  return `{\n${Object.entries(v).map(([k, x]) => `${inner}${JSON.stringify(k)}: ${pretty(x, inner)}`).join(",\n")}\n${indent}}`;
}

/** The `"start": {…}` value's text span in a lesson file. */
function startSpan(text) {
  const at = text.indexOf('"start":');
  let i = text.indexOf("{", at);
  const from = i;
  let depth = 0;
  let str = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (str) {
      if (ch === "\\") i++;
      else if (ch === '"') str = false;
    } else if (ch === '"') str = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return [from, i + 1];
  }
  throw new Error("no start");
}

/** Write `project` back to where `allCircuits` found it; a lesson keeps the rest of its text. */
export function saveCircuit(name, file, project) {
  if (name.endsWith("#start")) {
    const text = readFileSync(file, "utf8");
    const [a, b] = startSpan(text);
    const body = [
      "{",
      '    "project": {',
      '      "parts": [',
      project.parts.map((p) => `        ${inline(p)}`).join(",\n"),
      "      ],",
      project.wires.length ? '      "wires": [\n' + project.wires.map((w) => `        ${inline(w)}`).join(",\n") + "\n      ]" : '      "wires": []',
      "    }",
      "  }",
    ].join("\n");
    writeFileSync(file, text.slice(0, a) + body + text.slice(b));
  } else {
    writeFileSync(file, pretty(project) + "\n");
  }
}

/**
 * Which board supply each breadboard rail carries: `["bb1:tn GND", "bb1:tp 3V3"]`
 * (the rail by its kind: tp/tn upper +/−, bp/bn lower).
 */
export function railSupplies(model, project) {
  const out = new Set();
  const bbs = new Set(project.parts.filter((p) => p.kind.startsWith("breadboard")).map((p) => p.id));
  for (const net of projectNets(model, project)) {
    const supply = ["3V3", "5V", "GND"].find((s) => net.includes(`nucleo:${s === "GND" ? "GND_P1" : s}`));
    if (!supply) continue;
    for (const k of net) {
      const [part, pin] = k.split(":");
      const rail = /^(tp|tn|bp|bn)\d+$/.exec(pin);
      if (bbs.has(part) && rail) out.add(`${part}:${rail[1]} ${supply}`);
    }
  }
  return [...out].sort();
}

/** What must not change in a layout pass: the parts (not breadboards) and the nets. */
export function circuitSignature(model, essentialNets, project) {
  const parts = project.parts
    .filter((p) => !p.kind.startsWith("breadboard"))
    .map((p) => `${p.id} ${p.kind} ${JSON.stringify(p.props ?? {})}`)
    .sort();
  return { parts, nets: essentialNets(model, project) };
}
