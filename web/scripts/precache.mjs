// The service worker's precache list (M29): every file of the build
// (`dist/`) with its SHA-256, a cache version from all of them, and the
// finished `dist/sw.js` (web/sw/service-worker.js with the list put in).
// `vite build` runs it as the last step (see `serviceWorkerPlugin`), so the
// list is made from the files actually emitted and never drifts.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** The finished service worker's name; it is not precached itself. */
export const SW_FILE = "sw.js";

const LIST_MARK = "/*__PRECACHE__*/[]";
const VERSION_MARK = "__VERSION__";

/** Every file under `dir`, as paths relative to it with "/" separators, sorted. */
function walk(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full).split(sep).join("/"));
  }
  return out.sort();
}

/**
 * The files to precache: everything in `distDir` except the service worker.
 * `url` is relative to the site's base (the service worker's scope),
 * `integrity` is the subresource-integrity value of its bytes.
 */
export function collectPrecache(distDir) {
  return walk(distDir)
    .filter((url) => url !== SW_FILE)
    .map((url) => {
      const bytes = readFileSync(join(distDir, url));
      const digest = createHash("sha256").update(bytes).digest();
      return { url, size: bytes.length, integrity: `sha256-${digest.toString("base64")}` };
    });
}

/** The cache version: a short hash of every precached path and its content. */
export function cacheVersion(entries) {
  const h = createHash("sha256");
  for (const e of [...entries].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))) {
    h.update(`${e.url}\0${e.integrity}\n`);
  }
  return h.digest("hex").slice(0, 12);
}

/**
 * Problems that would make the app not work offline: no index.html,
 * manifest or WASM, an example (examples/index.json) or its project file
 * not in the list, or a bundled lesson (`lessonIds`) in none of the
 * precached scripts (lessons are compiled into the JS bundle).
 */
export function missingForOffline(entries, distDir, lessonIds = []) {
  const urls = new Set(entries.map((e) => e.url));
  const missing = [];
  for (const need of ["index.html", "manifest.webmanifest"]) if (!urls.has(need)) missing.push(need);
  if (![...urls].some((u) => u.startsWith("assets/") && u.endsWith(".wasm"))) missing.push("assets/*.wasm");
  if (urls.has("examples/index.json")) {
    const index = JSON.parse(readFileSync(join(distDir, "examples", "index.json"), "utf8"));
    for (const ex of index) {
      for (const f of [ex.file, ex.project]) if (f && !urls.has(`examples/${f}`)) missing.push(`examples/${f}`);
    }
  }
  if (lessonIds.length) {
    const scripts = [...urls].filter((u) => u.endsWith(".js")).map((u) => readFileSync(join(distDir, u), "utf8"));
    for (const id of lessonIds) {
      if (!scripts.some((s) => s.includes(JSON.stringify(id)))) missing.push(`lesson ${id}`);
    }
  }
  return missing;
}

/** The ids of the lessons in `lessonsDir` (web/lessons/*.json). */
export function lessonIds(lessonsDir) {
  if (!existsSync(lessonsDir)) return [];
  return readdirSync(lessonsDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(lessonsDir, f), "utf8")).id ?? f.replace(/\.json$/, ""));
}

/** The service worker source with the version and the list put in. */
export function renderServiceWorker(template, entries, version) {
  for (const mark of [LIST_MARK, VERSION_MARK]) {
    if (template.split(mark).length !== 2) throw new Error(`service worker template: expected one ${mark}`);
  }
  const list = JSON.stringify(entries.map(({ url, integrity }) => ({ url, integrity })));
  return template.replace(LIST_MARK, list).replace(VERSION_MARK, version);
}

/** Write `distDir/sw.js` from `templateFile`; fails if something offline needs is missing. */
export function writeServiceWorker(distDir, templateFile, lessonsDir) {
  const entries = collectPrecache(distDir);
  const missing = missingForOffline(entries, distDir, lessonIds(lessonsDir));
  if (missing.length) throw new Error(`precache: missing ${missing.join(", ")}`);
  const version = cacheVersion(entries);
  writeFileSync(join(distDir, SW_FILE), renderServiceWorker(readFileSync(templateFile, "utf8"), entries, version));
  const mb = entries.reduce((s, e) => s + e.size, 0) / 1e6;
  return { version, count: entries.length, mb };
}

/**
 * Vite plugin: after `vite build`, write dist/sw.js with the precache list.
 * `template` and `lessons` are relative to the Vite root (web/).
 */
export function serviceWorkerPlugin({ template, lessons }) {
  let root = ".";
  let outDir = "dist";
  return {
    name: "simucleo-service-worker",
    apply: "build",
    configResolved(config) {
      root = config.root;
      outDir = join(config.root, config.build.outDir);
    },
    closeBundle() {
      const { version, count, mb } = writeServiceWorker(outDir, join(root, template), join(root, lessons));
      console.log(`sw.js: ${count} files (${mb.toFixed(1)} MB) precached, cache ${version}`);
    },
  };
}
