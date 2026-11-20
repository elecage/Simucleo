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
 */
const PRECACHE = /*__PRECACHE__*/[];
const VERSION = "__VERSION__";
const PREFIX = "simucleo-";
const CACHE = PREFIX + VERSION;
const PARALLEL = 6;
const SRI_HEADER = "x-simucleo-integrity";

const scope = () => self.registration.scope;
const abs = (url) => new URL(url, scope()).href;
const PATHS = new Set(PRECACHE.map((e) => e.url));

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
async function reuse(e) {
  for (const key of await caches.keys()) {
    if (!key.startsWith(PREFIX) || key === CACHE) continue;
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

self.addEventListener("install", (event) => {
  event.waitUntil(precache());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
      }
      await self.clients.claim();
      broadcast(await status());
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
});
