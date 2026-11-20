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
/**
 * The in-browser compiler (M33, about 20 MB): not in the default precache.
 * The service worker lists it apart (OPTIONAL) and caches it only when the
 * student presses "편집기 오프라인으로 받기".
 */
export const OPTIONAL_DIR = "toolchain/";

const LIST_MARK = "/*__PRECACHE__*/[]";
const VERSION_MARK = "__VERSION__";
const OPTIONAL_MARK = "/*__OPTIONAL__*/[]";
const OPTIONAL_VERSION_MARK = "__OPTIONAL_VERSION__";

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

function entry(distDir, url) {
  const bytes = readFileSync(join(distDir, url));
  const digest = createHash("sha256").update(bytes).digest();
  return { url, size: bytes.length, integrity: `sha256-${digest.toString("base64")}` };
}

/**
 * The files to precache: everything in `distDir` except the service worker
 * and the optional toolchain (`OPTIONAL_DIR`).
 * `url` is relative to the site's base (the service worker's scope),
 * `integrity` is the subresource-integrity value of its bytes.
 */
export function collectPrecache(distDir) {
  return walk(distDir)
    .filter((url) => url !== SW_FILE && !url.startsWith(OPTIONAL_DIR))
    .map((url) => entry(distDir, url));
}

/** The optional files (the compiler, M33): cached only on request. */
export function collectOptional(distDir) {
  if (!existsSync(join(distDir, OPTIONAL_DIR))) return [];
  return walk(distDir)
    .filter((url) => url.startsWith(OPTIONAL_DIR))
    .map((url) => entry(distDir, url));
}

/**
 * Problems with the optional list: a toolchain file the manifest names (or
 * the manifest, the loader) not in it, or any toolchain file in the default
 * precache (it would download 20 MB on every first visit).
 */
export function optionalProblems(precache, optional, distDir) {
  const problems = [];
  for (const e of precache) if (e.url.startsWith(OPTIONAL_DIR)) problems.push(`${e.url} in the default precache`);
  const manifestFile = join(distDir, OPTIONAL_DIR, "manifest.json");
  if (!existsSync(manifestFile)) return problems;
  const urls = new Set(optional.map((e) => e.url));
  const m = JSON.parse(readFileSync(manifestFile, "utf8"));
  const need = [`${OPTIONAL_DIR}manifest.json`, `${OPTIONAL_DIR}clang.js`, m.sdk?.url, ...Object.values(m.files ?? {}).map((f) => f.url)];
  for (const u of need) if (!u || !urls.has(u)) problems.push(`optional ${u ?? "(no url)"}`);
  return problems;
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
 * manifest or WASM, an example (examples/index.json), its project file or
 * a file it sends to the board not in the list, or a bundled lesson (`lessonIds`) in none of the
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
      for (const f of [ex.file, ex.project, ...(ex.files ?? []).map((a) => a.file)]) if (f && !urls.has(`examples/${f}`)) missing.push(`examples/${f}`);
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

/** The service worker source with the versions and the lists put in. */
export function renderServiceWorker(template, entries, version, optional = [], optionalVersion = "none") {
  for (const mark of [LIST_MARK, VERSION_MARK, OPTIONAL_MARK, OPTIONAL_VERSION_MARK]) {
    if (template.split(mark).length !== 2) throw new Error(`service worker template: expected one ${mark}`);
  }
  const list = (l) => JSON.stringify(l.map(({ url, integrity, size }) => ({ url, integrity, size })));
  return template
    .replace(LIST_MARK, list(entries))
    .replace(OPTIONAL_MARK, list(optional))
    .replace(OPTIONAL_VERSION_MARK, optionalVersion)
    .replace(VERSION_MARK, version);
}

/** Write `distDir/sw.js` from `templateFile`; fails if something offline needs is missing. */
export function writeServiceWorker(distDir, templateFile, lessonsDir) {
  const entries = collectPrecache(distDir);
  const missing = missingForOffline(entries, distDir, lessonIds(lessonsDir));
  if (missing.length) throw new Error(`precache: missing ${missing.join(", ")}`);
  const optional = collectOptional(distDir);
  const problems = optionalProblems(entries, optional, distDir);
  if (problems.length) throw new Error(`precache: ${problems.join(", ")}`);
  const version = cacheVersion(entries);
  const optionalVersion = optional.length ? cacheVersion(optional) : "none";
  writeFileSync(join(distDir, SW_FILE), renderServiceWorker(readFileSync(templateFile, "utf8"), entries, version, optional, optionalVersion));
  const mb = entries.reduce((s, e) => s + e.size, 0) / 1e6;
  const optionalMb = optional.reduce((s, e) => s + e.size, 0) / 1e6;
  return { version, count: entries.length, mb, optionalCount: optional.length, optionalMb, optionalVersion };
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
      const { version, count, mb, optionalCount, optionalMb, optionalVersion } = writeServiceWorker(outDir, join(root, template), join(root, lessons));
      console.log(`sw.js: ${count} files (${mb.toFixed(1)} MB) precached, cache ${version}`);
      if (optionalCount) console.log(`sw.js: compiler ${optionalCount} files (${optionalMb.toFixed(1)} MB) on request only, cache editor-${optionalVersion}`);
    },
  };
}
