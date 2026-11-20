/* Simucleo service worker (M29): the app works offline after one visit.
 *
 * `vite build` turns this file into dist/sw.js (scripts/precache.mjs):
 * PRECACHE becomes every built file with its SHA-256, VERSION a hash of
 * all of them. One cache per version; old ones go when a new version
 * takes over. Installing a new version copies the files whose bytes did
 * not change from the old cache, so an update downloads only the rest.
 * (A change to this file alone keeps the version and its cache.)
 *
 * - Precached files (hashed JS/CSS/WASM, examples, icons): cache first.
 * - Page loads (navigations): the index.html of this version's cache, so the
 *   page always belongs to the same release as the examples, lessons and
 *   firmware it loads from the cache (a new deploy's page reaches the user
 *   only with its own files, when the update is accepted). The network
 *   only when the cache has no page (never once installed).
 * - Everything else (other sites, POSTs, files not in the list) is left
 *   alone. User files (uploaded ELFs, projects, autosave, SD card) live
 *   in IndexedDB/localStorage and never go through here.
 * - A new version waits until the page posts SKIP_WAITING (the update
 *   banner), so a running simulation is never reloaded unasked.
 * - The in-browser compiler (M33, toolchain/, about 20 MB) is not in the
 *   list above: OPTIONAL lists it apart, cached in its own cache
 *   (simucleo-editor-<version of those files>) only when the page posts
 *   CACHE_EDITOR ("편집기 오프라인으로 받기"); the same rules (integrity,
 *   reuse of unchanged files) apply. Once cached, a new version of the app
 *   brings the new compiler into its cache when it takes over.
 */
const PRECACHE = /*__PRECACHE__*/[];
const VERSION = "__VERSION__";
const OPTIONAL = /*__OPTIONAL__*/[];
const OPTIONAL_VERSION = "__OPTIONAL_VERSION__";
const PREFIX = "simucleo-";
const CACHE = PREFIX + VERSION;
const EDITOR_PREFIX = PREFIX + "editor-";
const EDITOR_CACHE = EDITOR_PREFIX + OPTIONAL_VERSION;
const PARALLEL = 6;
const SRI_HEADER = "x-simucleo-integrity";

const scope = () => self.registration.scope;
const abs = (url) => new URL(url, scope()).href;
const PATHS = new Set(PRECACHE.map((e) => e.url));
const OPTIONAL_PATHS = new Set(OPTIONAL.map((e) => e.url));

async function broadcast(msg) {
  for (const c of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) c.postMessage(msg);
}

/** How many of the list are in this version's cache. */
async function cachedCount() {
  const cache = await caches.open(CACHE);
  const keys = new Set((await cache.keys()).map((r) => r.url));
  return PRECACHE.filter((e) => keys.has(abs(e.url))).length;
}

async function status() {
  const cached = await cachedCount();
  return { type: "STATUS", version: VERSION, total: PRECACHE.length, cached, ready: cached === PRECACHE.length };
}

/** The same bytes in an older version's cache (an update re-downloads only what changed). */
async function reuse(e, current = CACHE) {
  for (const key of await caches.keys()) {
    if (!key.startsWith(PREFIX) || key === current) continue;
    const old = await (await caches.open(key)).match(abs(e.url));
    if (old && old.headers.get(SRI_HEADER) === e.integrity) return old;
  }
  return null;
}

async function download(e) {
  // Past the HTTP cache, and only the bytes this version was built with.
  const res = await fetch(new Request(abs(e.url), { cache: "reload", integrity: e.integrity }));
  if (!res.ok) throw new Error(`${e.url}: HTTP ${res.status}`);
  // Stored with its integrity (for `reuse`), not marked redirected.
  const headers = new Headers(res.headers);
  headers.set(SRI_HEADER, e.integrity);
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers });
}

async function precache() {
  const cache = await caches.open(CACHE);
  const have = new Set((await cache.keys()).map((r) => r.url));
  const todo = PRECACHE.filter((e) => !have.has(abs(e.url)));
  let done = PRECACHE.length - todo.length;
  let next = 0;
  async function worker() {
    while (next < todo.length) {
      const e = todo[next++];
      await cache.put(abs(e.url), (await reuse(e)) || (await download(e)));
      done++;
      if (done % 10 === 0 || done === PRECACHE.length) broadcast({ type: "PROGRESS", version: VERSION, done, total: PRECACHE.length });
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
}

// ------------------------------------------------ the compiler (M33)

async function editorStatus() {
  // (caches.open would create the cache: only asked, never made here.)
  const keys = (await caches.has(EDITOR_CACHE)) ? new Set((await (await caches.open(EDITOR_CACHE)).keys()).map((r) => r.url)) : new Set();
  const cached = OPTIONAL.filter((e) => keys.has(abs(e.url))).length;
  return { type: "EDITOR_STATUS", version: OPTIONAL_VERSION, total: OPTIONAL.length, cached, ready: OPTIONAL.length > 0 && cached === OPTIONAL.length };
}

let editorJob = null;
/** Cache every optional file (reusing unchanged ones), reporting bytes. */
function cacheEditor(report) {
  editorJob ??= (async () => {
    const cache = await caches.open(EDITOR_CACHE);
    const have = new Set((await cache.keys()).map((r) => r.url));
    const total = OPTIONAL.reduce((s, e) => s + (e.size || 0), 0);
    let done = OPTIONAL.filter((e) => have.has(abs(e.url))).reduce((s, e) => s + (e.size || 0), 0);
    for (const e of OPTIONAL) {
      if (have.has(abs(e.url))) continue;
      await cache.put(abs(e.url), (await reuse(e, EDITOR_CACHE)) || (await download(e)));
      done += e.size || 0;
      report({ type: "EDITOR_PROGRESS", version: OPTIONAL_VERSION, done, total });
    }
    // Older compilers' caches are not needed any more.
    for (const key of await caches.keys()) if (key.startsWith(EDITOR_PREFIX) && key !== EDITOR_CACHE) await caches.delete(key);
    return editorStatus();
  })().finally(() => {
    editorJob = null;
  });
  return editorJob;
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      let hadEditor = false;
      for (const key of await caches.keys()) {
        // The compiler's caches follow their own version (below).
        if (key.startsWith(EDITOR_PREFIX)) {
          if (key !== EDITOR_CACHE) hadEditor = true;
          continue;
        }
        if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
      broadcast(await status());
      // The student had the compiler offline: bring this version's in (the
      // unchanged files come from the old cache, which then goes).
      if (hadEditor && OPTIONAL.length) await cacheEditor(broadcast).then(broadcast, () => {});
    })(),
  );
});

self.addEventListener("message", (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "SKIP_WAITING") self.skipWaiting();
  else if (msg.type === "GET_STATUS") {
    const reply = event.ports && event.ports[0];
    event.waitUntil(status().then((s) => (reply ? reply.postMessage(s) : event.source && event.source.postMessage(s))));
  } else if (msg.type === "EDITOR_STATUS" || msg.type === "CACHE_EDITOR") {
    const reply = event.ports && event.ports[0];
    const send = (m) => (reply ? reply.postMessage(m) : event.source && event.source.postMessage(m));
    const job = msg.type === "CACHE_EDITOR" ? cacheEditor(send) : editorStatus();
    const failed = (err) => ({ type: "EDITOR_STATUS", version: OPTIONAL_VERSION, total: OPTIONAL.length, cached: 0, ready: false, error: String((err && err.message) || err) });
    event.waitUntil(job.then(send, (err) => send(failed(err))));
  }
});

async function fromCache(url) {
  const cache = await caches.open(CACHE);
  return cache.match(abs(url));
}

async function navigate(request) {
  return (await fromCache("index.html")) || fetch(request);
}

async function cacheFirst(request, url) {
  return (await fromCache(url)) || fetch(request);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const base = scope();
  if (!request.url.startsWith(base)) return;
  if (request.mode === "navigate") {
    event.respondWith(navigate(request));
    return;
  }
  const path = request.url.slice(base.length).split(/[?#]/)[0];
  if (PATHS.has(path)) event.respondWith(cacheFirst(request, path));
  // The compiler: from its cache once "편집기 오프라인으로 받기" put it there.
  // (caches.match with a cacheName does not create the cache, unlike open.)
  else if (OPTIONAL_PATHS.has(path)) event.respondWith(caches.match(abs(path), { cacheName: EDITOR_CACHE }).then((r) => r || fetch(request)));
});
