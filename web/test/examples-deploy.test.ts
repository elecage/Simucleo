// Every example the site lists is built where the site is deployed (and in
// CI): the Pages workflow once built only the first examples, so the newer
// ones (and the lessons' firmware) were missing from the live site.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workflow = (name: string) => readFileSync(join(here, "../../.github/workflows", name), "utf8");
const projects = execFileSync("node", [join(here, "../scripts/examples.mjs"), "--projects"], { encoding: "utf8" })
  .trim()
  .split(/\s+/);

test("the example list names its firmware directories", () => {
  assert.ok(projects.length > 40, projects.join(" "));
  for (const p of ["hal-blinky", "hal-imu-matrix", "hal-bldc-sensorless", "lesson-parking", "bare-blinky"]) assert.ok(projects.includes(p), p);
});

test("the Pages deploy builds every listed example and fails on a missing one", () => {
  const pages = workflow("pages.yml");
  assert.match(pages, /for d in \$\(node web\/scripts\/examples\.mjs --projects\)/);
  assert.match(pages, /make -C firmware\/hal-blinky variants/);
  assert.match(pages, /npm run examples -- --strict/);
});

test("CI builds every listed example before copying them, and fails on a missing one", () => {
  const ci = workflow("ci.yml");
  // The web job's firmware step: the explicit list of directories.
  const step = ci.slice(ci.indexOf("make -C firmware/bare-blinky"), ci.indexOf("npm run examples"));
  const built = new Set([...step.matchAll(/make -C firmware\/([\w-]+)/g)].map((m) => m[1]));
  for (const m of step.matchAll(/for d in ([^;]+);/g)) for (const d of m[1].trim().split(/\s+/)) built.add(d);
  assert.deepEqual(projects.filter((p) => !built.has(p)), []);
  assert.match(ci, /npm run examples -- --strict/);
});
