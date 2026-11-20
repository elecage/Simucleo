// Write test/data/m38-nets.json: the parts and nets of every bundled
// circuit, the reference the layout check compares against, and for the
// lesson start circuits which supplies their breadboard rails carry (the
// lesson text names them: "위쪽 레일은 3V3"). Taken from the circuits as
// they were before M38 re-laid them out:
//   node scripts/m38-snapshot.mjs abf3ebb
// Run it again only for a deliberate change of a circuit (not of its layout).
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { essentialNets, loadAppModel } from "./appmodel.mjs";
import { allCircuits, circuitSignature, railSupplies, web } from "./circuits.mjs";

const rev = process.argv[2];
const model = await loadAppModel();
const snap = {};
for (const [name, file, current] of allCircuits()) {
  let project = current;
  if (rev) {
    const text = execSync(`git show ${rev}:web/${relative(web, file)}`, { cwd: web, encoding: "utf8" });
    project = name.endsWith("#start") ? JSON.parse(text).start.project : JSON.parse(text);
  }
  snap[name] = circuitSignature(model, essentialNets, project);
  if (name.endsWith("#start")) snap[name].rails = railSupplies(model, project);
}
mkdirSync(join(web, "test", "data"), { recursive: true });
writeFileSync(join(web, "test", "data", "m38-nets.json"), JSON.stringify(snap, null, 1) + "\n");
console.log(`${Object.keys(snap).length} circuits`);
