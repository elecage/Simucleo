// The app's own part catalogue and circuit model, loaded into Node for the
// layout check (test/m38.test.ts) and the example routing helper
// (scripts/route.mjs). The part definitions are .tsx (they draw
// themselves), so they are bundled with esbuild first instead of
// duplicating their pins and sizes here.
import { buildSync } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");

const entry = `
export { PART_BY_KIND, busCatalog } from "./src/parts/index.ts";
export { toCircuit } from "./src/editor/model.ts";
`;

/** `{ PART_BY_KIND, busCatalog, toCircuit }` of the app. */
export async function loadAppModel() {
  const out = buildSync({
    stdin: { contents: entry, resolveDir: web, loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    jsx: "automatic",
    external: ["react", "react/jsx-runtime", "react-dom"],
    loader: { ".css": "empty" },
    logLevel: "silent",
  });
  // A data: URL cannot resolve bare imports; the drawings are never called.
  const code = out.outputFiles[0].text.replace(/^import .* from "react(\/jsx-runtime)?";$/gm, (line) =>
    line.replace(/import (.*) from .*/, "const $1 = {};").replace(/ as /g, ": "),
  );
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

/**
 * Nets of a project as the core builds them (`simucleo_circuit::netlist`):
 * part-internal buses, drawn wires and pins sharing a grid point. Returns
 * a list of pin-key arrays (`part:pin`).
 */
export function projectNets(model, project) {
  const circuit = model.toCircuit(project);
  const buses = model.busCatalog();
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    parent.set(x, r);
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const part of circuit.parts) {
    for (const bus of buses[part.kind] ?? []) for (const pin of bus) union(`${part.id}:${bus[0]}`, `${part.id}:${pin}`);
  }
  for (const w of circuit.wires) union(`${w.a.part}:${w.a.pin}`, `${w.b.part}:${w.b.pin}`);
  const groups = new Map();
  for (const k of parent.keys()) {
    const r = find(k);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(k);
  }
  return [...groups.values()];
}

/**
 * The connectivity that matters: nets of every pin that is not a
 * breadboard hole, each sorted, nets of one pin left out (an unconnected
 * pin), sorted. Two layouts with equal `essentialNets` are the same circuit.
 */
export function essentialNets(model, project) {
  const kind = new Map(project.parts.map((p) => [p.id, p.kind]));
  return projectNets(model, project)
    .map((net) => net.filter((k) => !String(kind.get(k.slice(0, k.indexOf(":"))) ?? "").startsWith("breadboard")).sort())
    .filter((net) => net.length >= 2)
    .map((net) => net.join(" "))
    .sort();
}
