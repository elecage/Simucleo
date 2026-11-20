// Speed of every bundled example (M31): each runs headless for a few
// simulated seconds, with its circuit, the way the web worker runs it
// (src/sim/benchRun.ts), natively (crates/wasm/examples/bench.rs) and as
// WebAssembly in Node (the same core the browser runs). Prints a table of
// ×real-time (simulated time / wall time).
//
//   node scripts/bench.mjs [--seconds 3] [--native] [--wasm] [--only name,…]
//                          [--check 1.5] [--write ../docs/performance.md]
//
// Neither --native nor --wasm: both. --check X fails (exit 1) if an example
// runs slower than ×X natively; a slow one is measured twice more and the
// best run counts, so a busy machine does not fail it by chance. --write
// puts the table between the bench markers of that file. Needs the
// firmware built and copied (npm run examples) and, for WASM, npm run wasm.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppModel } from "./appmodel.mjs";
import { benchRun } from "../src/sim/benchRun.ts";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(web, "..");
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? dflt : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);
const seconds = Number(opt("seconds", "3"));
const check = opt("check", null);
const only = opt("only", null)?.split(",");
const wantNative = flag("native") || !flag("wasm");
const wantWasm = flag("wasm") || !flag("native");

const examplesDir = join(web, "public", "examples");
if (!existsSync(join(examplesDir, "index.json"))) {
  console.error("No examples: build the firmware and run `npm run examples` first.");
  process.exit(2);
}
const index = JSON.parse(readFileSync(join(examplesDir, "index.json"), "utf8"));
const model = await loadAppModel();
const catalog = JSON.stringify(model.busCatalog());
const signals = JSON.stringify(model.boardSignals());

/** One job per example: its ELF and, if it comes with one, the circuit as the editor hands it over. */
const jobs = index
  .filter((ex) => !only || only.includes(ex.name))
  .map((ex) => {
    const project = join(web, "examples", ex.file.replace(/\.elf$/, ".simucleo.json"));
    const wiring = existsSync(project)
      ? { circuit: JSON.stringify(model.toCircuit(JSON.parse(readFileSync(project, "utf8")))), catalog, signals }
      : null;
    return { name: ex.name, elf: join(examplesDir, ex.file), wiring, simMs: seconds * 1000, parts: wiring ? JSON.parse(wiring.circuit).parts.length : 0 };
  });

/** Native: one process for a list of jobs. */
function runNative(list) {
  const dir = mkdtempSync(join(tmpdir(), "simucleo-bench-"));
  try {
    const file = join(dir, "jobs.json");
    writeFileSync(file, JSON.stringify(list));
    const out = execFileSync("cargo", ["run", "--quiet", "--release", "-p", "simucleo-wasm", "--example", "bench", "--", file], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: 1 << 24,
    });
    return Object.fromEntries(out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((r) => [r.name, r]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let native = {};
if (wantNative) {
  native = runNative(jobs);
  if (check) {
    // A slow one: twice more, the best counts (a busy machine, not a regression).
    for (const j of jobs) {
      for (let k = 0; k < 2 && native[j.name] && !native[j.name].stopped && native[j.name].ratio < Number(check); k++) {
        const again = runNative([j])[j.name];
        if (again.ratio > native[j.name].ratio) native[j.name] = again;
      }
    }
  }
}

const wasm = {};
if (wantWasm) {
  const pkg = join(web, "src", "wasm", "pkg");
  if (!existsSync(join(pkg, "simucleo_wasm_bg.wasm"))) {
    console.error("No WASM build: run `npm run wasm` first (or pass --native).");
    process.exit(2);
  }
  const { initSync, Simulator } = await import(join(pkg, "simucleo_wasm.js"));
  initSync({ module: readFileSync(join(pkg, "simucleo_wasm_bg.wasm")) });
  for (const j of jobs) {
    const sim = new Simulator();
    sim.loadElf(readFileSync(j.elf));
    if (j.wiring) sim.setWiring(j.wiring.circuit, j.wiring.catalog, j.wiring.signals);
    benchRun(sim, 100); // warm up
    wasm[j.name] = benchRun(sim, j.simMs);
    sim.free();
  }
}

const fmt = (r) => (!r ? "—" : r.stopped ? "멈춤" : `×${r.ratio >= 100 ? r.ratio.toFixed(0) : r.ratio.toFixed(1)}`);
const rows = jobs.map((j) => `| \`${j.name}\` | ${j.parts || "—"} | ${wantNative ? fmt(native[j.name]) : "—"} | ${wantWasm ? fmt(wasm[j.name]) : "—"} |`);
const cpu = cpus()[0]?.model?.replace(/\s+/g, " ").trim() ?? "?";
const table = [
  `${seconds} s 시뮬레이션, ${cpu} (${cpus().length}코어), Node ${process.version}. 배율 = 시뮬레이션 시간 / 실제 시간(클수록 빠름).`,
  "",
  "| 예제 | 부품 | 네이티브 | WASM (Node) |",
  "|---|---:|---:|---:|",
  ...rows,
].join("\n");
console.log(table);

const write = opt("write", null);
if (write) {
  const file = join(web, write);
  const text = readFileSync(file, "utf8");
  const [start, end] = ["<!-- bench:start -->", "<!-- bench:end -->"];
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a < 0 || b < a) {
    console.error(`${write}: no ${start} … ${end}`);
    process.exit(2);
  }
  writeFileSync(file, `${text.slice(0, a + start.length)}\n${table}\n${text.slice(b)}`);
}

if (check) {
  const slow = jobs.filter((j) => native[j.name] && !native[j.name].stopped && native[j.name].ratio < Number(check));
  if (slow.length) {
    console.error(`\nSlower than ×${check} natively: ${slow.map((j) => `${j.name} ${fmt(native[j.name])}`).join(", ")}`);
    process.exit(1);
  }
  console.error(`\nEvery example runs at ×${check} or faster natively.`);
}
