// Unit tests of M29: the precache list made from the build, the cache
// version, the service worker itself (run in a sandbox with fake caches
// and network) and the page's update/install/offline logic (`npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  cacheVersion,
  collectPrecache,
  lessonIds,
  missingForOffline,
  renderServiceWorker,
  writeServiceWorker,
} from "../scripts/precache.mjs";
import { createPwa, RUNNING_CONFIRM, type ContainerLike, type PwaEnv, type RegistrationLike, type WorkerLike } from "../src/pwa.ts";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(WEB, "sw", "service-worker.js");
const LESSONS = join(WEB, "lessons");
const IDS = lessonIds(LESSONS);

/** A small dist/ like `vite build` + `npm run examples` make. */
function fakeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), "simucleo-dist-"));
  const put = (path: string, data: string | Buffer) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), data);
  };
  put("index.html", '<script type="module" src="./assets/index-abc.js"></script>');
  put("assets/index-abc.js", `const L=[${IDS.map((id) => `{id:${JSON.stringify(id)}}`).join(",")}];`);
  put("assets/worker-def.js", "self.onmessage=()=>{}");
  put("assets/index-123.css", "body{}");
  put("assets/simucleo_wasm_bg-xyz.wasm", Buffer.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  put("manifest.webmanifest", "{}");
  put("icons/icon-192.png", Buffer.from([0x89, 0x50]));
  put("examples/hal-blinky.elf", Buffer.from("\x7fELF blinky"));
  put("examples/hal-button-exti.elf", Buffer.from("\x7fELF exti"));
  put("examples/hal-button-exti.simucleo.json", "{}");
  put("examples/src/hal-blinky/Core/Src/main.c", "int main(void){}");
  put(
    "examples/index.json",
    JSON.stringify([
      { name: "hal-blinky", file: "hal-blinky.elf" },
      { name: "hal-button-exti", file: "hal-button-exti.elf", project: "hal-button-exti.simucleo.json" },
    ]),
  );
  put("sw.js", "// an old service worker");
  return dir;
}

test("the precache list has the app shell, the WASM, every example and its project", () => {
  const dist = fakeDist();
  try {
    const urls = collectPrecache(dist).map((e) => e.url);
    for (const u of [
      "index.html",
      "manifest.webmanifest",
      "assets/index-abc.js",
      "assets/worker-def.js",
      "assets/index-123.css",
      "assets/simucleo_wasm_bg-xyz.wasm",
      "icons/icon-192.png",
      "examples/index.json",
      "examples/hal-blinky.elf",
      "examples/hal-button-exti.elf",
      "examples/hal-button-exti.simucleo.json",
      "examples/src/hal-blinky/Core/Src/main.c",
    ]) {
      assert.ok(urls.includes(u), `${u} precached`);
    }
    assert.ok(!urls.includes("sw.js"), "the service worker does not cache itself");
    assert.deepEqual(missingForOffline(collectPrecache(dist), dist, IDS), []);
    // Integrity is the SHA-256 of the bytes.
    const e = collectPrecache(dist).find((x) => x.url === "examples/hal-blinky.elf")!;
    const sha = createHash("sha256").update(readFileSync(join(dist, "examples/hal-blinky.elf"))).digest("base64");
    assert.equal(e.integrity, `sha256-${sha}`);
  } finally {
    rmSync(dist, { recursive: true });
  }
});

test("every bundled lesson is checked: in no precached script, the build fails", () => {
  assert.ok(IDS.length >= 6 && IDS.includes("led-blink"), IDS.join(","));
  const dist = fakeDist();
  try {
    // The lessons are compiled into the JS bundle; drop one from it.
    writeFileSync(join(dist, "assets/index-abc.js"), `const L=[${IDS.slice(1).map((id) => `{id:"${id}"}`).join(",")}];`);
    assert.deepEqual(missingForOffline(collectPrecache(dist), dist, IDS), [`lesson ${IDS[0]}`]);
    assert.throws(() => writeServiceWorker(dist, TEMPLATE, LESSONS), /missing lesson/);
  } finally {
    rmSync(dist, { recursive: true });
  }
});

test("a missing example, project file or WASM is reported", () => {
  const dist = fakeDist();
  try {
    const entries = collectPrecache(dist).filter(
      (e) => !["examples/hal-blinky.elf", "examples/hal-button-exti.simucleo.json", "assets/simucleo_wasm_bg-xyz.wasm"].includes(e.url),
    );
    assert.deepEqual(missingForOffline(entries, dist, IDS).sort(), [
      "assets/*.wasm",
      "examples/hal-blinky.elf",
      "examples/hal-button-exti.simucleo.json",
    ]);
  } finally {
    rmSync(dist, { recursive: true });
  }
});

test("the cache version changes with any content and not with the order", () => {
  const dist = fakeDist();
  try {
    const a = collectPrecache(dist);
    const v = cacheVersion(a);
    assert.match(v, /^[0-9a-f]{12}$/);
    assert.equal(cacheVersion([...a].reverse()), v);
    writeFileSync(join(dist, "examples/hal-blinky.elf"), "\x7fELF blinky v2");
    const changed = cacheVersion(collectPrecache(dist));
    assert.notEqual(changed, v);
    writeFileSync(join(dist, "examples/hal-blinky.elf"), "\x7fELF blinky");
    assert.equal(cacheVersion(collectPrecache(dist)), v);
    writeFileSync(join(dist, "icons/new.png"), "x");
    assert.notEqual(cacheVersion(collectPrecache(dist)), v);
    // The old sw.js is not part of the version.
    rmSync(join(dist, "icons/new.png"));
    writeFileSync(join(dist, "sw.js"), "// something else");
    assert.equal(cacheVersion(collectPrecache(dist)), v);
  } finally {
    rmSync(dist, { recursive: true });
  }
});

test("writeServiceWorker puts the list and the version into dist/sw.js", () => {
  const dist = fakeDist();
  try {
    const { version, count } = writeServiceWorker(dist, TEMPLATE, LESSONS);
    const sw = readFileSync(join(dist, "sw.js"), "utf8");
    assert.ok(sw.includes(`const VERSION = "${version}"`));
    const list = JSON.parse(sw.match(/const PRECACHE = (\[.*?\]);/)![1]) as { url: string; integrity: string }[];
    assert.equal(list.length, count);
    assert.ok(list.some((e) => e.url === "examples/hal-blinky.elf" && e.integrity.startsWith("sha256-")));
    assert.throws(() => renderServiceWorker("const VERSION = 1;", [], "x"), /expected one/);
  } finally {
    rmSync(dist, { recursive: true });
  }
});

test("the real build (if built): sw.js precaches the WASM, index.html, every example ELF and lesson", (t) => {
  const dist = join(WEB, "dist");
  if (!existsSync(join(dist, "sw.js"))) return t.skip("no dist/ (run npm run build)");
  const sw = readFileSync(join(dist, "sw.js"), "utf8");
  const list = (JSON.parse(sw.match(/const PRECACHE = (\[.*?\]);/)![1]) as { url: string }[]).map((e) => e.url);
  assert.ok(list.includes("index.html"));
  assert.ok(list.some((u) => /^assets\/.*\.wasm$/.test(u)));
  assert.ok(list.includes("manifest.webmanifest"));
  if (existsSync(join(dist, "examples/index.json"))) {
    const index = JSON.parse(readFileSync(join(dist, "examples/index.json"), "utf8")) as { file: string; project?: string }[];
    for (const ex of index) {
      assert.ok(list.includes(`examples/${ex.file}`), ex.file);
      if (ex.project) assert.ok(list.includes(`examples/${ex.project}`), ex.project);
    }
  }
  const scripts = list.filter((u) => u.endsWith(".js")).map((u) => readFileSync(join(dist, u), "utf8"));
  for (const id of IDS) assert.ok(scripts.some((s) => s.includes(`"${id}"`)), `lesson ${id}`);
});

// ------------------------------------------------- the service worker

const SCOPE = "https://example.test/Simucleo/";
/** Objects from the sandbox, as plain ones of this realm. */
const plain = (m: unknown) => JSON.parse(JSON.stringify(m)) as unknown;

class FakeCache {
  map = new Map<string, Response>();
  async keys() {
    return [...this.map.keys()].map((url) => ({ url }));
  }
  async put(url: string, res: Response) {
    this.map.set(url, res);
  }
  async match(url: string) {
    return this.map.get(url)?.clone();
  }
}

type Stores = Map<string, FakeCache>;

/** Run dist/sw.js-like code in a sandbox with fake caches (`stores`) and network (`net`). */
function loadSw(files: Record<string, string>, stores: Stores = new Map()) {
  const entries = Object.entries(files).map(([url, body]) => ({
    url,
    size: body.length,
    integrity: `sha256-${createHash("sha256").update(body).digest("base64")}`,
  }));
  const version = cacheVersion(entries);
  const code = renderServiceWorker(readFileSync(TEMPLATE, "utf8"), entries, version);
  const handlers: Record<string, (e: unknown) => void> = {};
  const posted: unknown[] = [];
  const fetched: { url: string; cache?: string; integrity?: string }[] = [];
  const state = { online: true, skipped: 0, claimed: 0 };
  const net = { ...files } as Record<string, string>;
  class Request {
    url: string;
    cache?: string;
    integrity?: string;
    method = "GET";
    mode = "cors";
    constructor(url: string, init: { cache?: string; integrity?: string } = {}) {
      this.url = url;
      this.cache = init.cache;
      this.integrity = init.integrity;
    }
  }
  const sandbox = {
    URL,
    Request,
    Response,
    Headers,
    Promise,
    Set,
    Array,
    JSON,
    setTimeout,
    clearTimeout,
    self: {
      registration: { scope: SCOPE },
      addEventListener: (type: string, f: (e: unknown) => void) => (handlers[type] = f),
      skipWaiting: () => state.skipped++,
      clients: {
        claim: async () => state.claimed++,
        matchAll: async () => [{ postMessage: (m: unknown) => posted.push(plain(m)) }],
      },
    },
    caches: {
      open: async (name: string) => {
        if (!stores.has(name)) stores.set(name, new FakeCache());
        return stores.get(name)!;
      },
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
    },
    fetch: async (req: Request | string) => {
      const r = typeof req === "string" ? new Request(req) : req;
      fetched.push({ url: r.url, cache: r.cache, integrity: r.integrity });
      if (!state.online) throw new TypeError("Failed to fetch");
      const path = r.url.slice(SCOPE.length).split("?")[0] || "index.html";
      return path in net
        ? new Response(net[path], { status: 200, headers: { "content-type": path.endsWith(".wasm") ? "application/wasm" : "text/plain" } })
        : new Response("", { status: 404 });
    },
  };
  vm.runInNewContext(code, sandbox);
  /** Fire an extendable event; resolves when its waitUntil/respondWith settle. */
  async function fire(type: string, extra: Record<string, unknown> = {}) {
    const waits: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    handlers[type]({
      ...extra,
      waitUntil: (p: Promise<unknown>) => waits.push(p),
      respondWith: (p: Promise<Response>) => (response = p),
    });
    await Promise.all(waits);
    return response;
  }
  /** The text of the response to a fetch event, or null when not answered. */
  async function get(path: string, init: Partial<{ method: string; mode: string; url: string }> = {}) {
    const res = await fire("fetch", { request: Object.assign(new Request(init.url ?? SCOPE + path), init) });
    return res ? (await res).text() : null;
  }
  return { version, cache: () => stores.get(`simucleo-${version}`)!, stores, posted, fetched, state, net, fire, get };
}

const FILES = {
  "index.html": "<html>v1</html>",
  "assets/index-abc.js": "app",
  "assets/simucleo_wasm_bg-xyz.wasm": "wasm",
  "examples/hal-blinky.elf": "elf",
};

test("service worker: install caches every file past the HTTP cache with its integrity", async () => {
  const sw = loadSw(FILES);
  await sw.fire("install");
  assert.deepEqual([...sw.cache().map.keys()].sort(), Object.keys(FILES).map((p) => SCOPE + p).sort());
  assert.equal(sw.fetched.length, 4);
  for (const f of sw.fetched) {
    assert.equal(f.cache, "reload");
    assert.match(f.integrity!, /^sha256-/);
  }
  const wasm = sw.cache().map.get(SCOPE + "assets/simucleo_wasm_bg-xyz.wasm")!;
  assert.equal(wasm.headers.get("content-type"), "application/wasm");
  // A failed download fails the install (tried again on the next visit).
  const bad = loadSw(FILES);
  delete bad.net["examples/hal-blinky.elf"];
  await assert.rejects(bad.fire("install"), /hal-blinky\.elf: HTTP 404/);
});

test("service worker: an update downloads only the changed files", async () => {
  const stores: Stores = new Map();
  const v1 = loadSw(FILES, stores);
  await v1.fire("install");
  await v1.fire("activate");
  const v2 = loadSw({ ...FILES, "assets/index-abc.js": "app v2", "examples/new.elf": "new" }, stores);
  assert.notEqual(v2.version, v1.version);
  await v2.fire("install");
  assert.deepEqual(v2.fetched.map((f) => f.url).sort(), [SCOPE + "assets/index-abc.js", SCOPE + "examples/new.elf"]);
  assert.equal(await (await v2.cache().match(SCOPE + "assets/index-abc.js"))!.text(), "app v2");
  assert.equal(await (await v2.cache().match(SCOPE + "examples/hal-blinky.elf"))!.text(), "elf");
  // The old version keeps serving its own files until the new one takes over.
  assert.equal(await v1.get("assets/index-abc.js"), "app");
  await v2.fire("activate");
  assert.deepEqual([...stores.keys()], [`simucleo-${v2.version}`]);
});

test("service worker: activate deletes only old simucleo caches and reports ready", async () => {
  const sw = loadSw(FILES, new Map([["simucleo-0123456789ab", new FakeCache()], ["other-app", new FakeCache()]]));
  await sw.fire("install");
  await sw.fire("activate");
  assert.deepEqual([...sw.stores.keys()].sort(), ["other-app", `simucleo-${sw.version}`]);
  assert.equal(sw.state.claimed, 1);
  assert.deepEqual(sw.posted.at(-1), { type: "STATUS", version: sw.version, total: 4, cached: 4, ready: true });
});

test("service worker: SKIP_WAITING only on request; GET_STATUS answers", async () => {
  const sw = loadSw(FILES);
  await sw.fire("install");
  assert.equal(sw.state.skipped, 0, "a new version waits");
  await sw.fire("message", { data: { type: "SKIP_WAITING" } });
  assert.equal(sw.state.skipped, 1);
  const replies: unknown[] = [];
  const source = { postMessage: (m: unknown) => replies.push(plain(m)) };
  await sw.fire("message", { data: { type: "GET_STATUS" }, source });
  assert.deepEqual(replies, [{ type: "STATUS", version: sw.version, total: 4, cached: 4, ready: true }]);
  // Half cached: not ready.
  sw.cache().map.delete(SCOPE + "examples/hal-blinky.elf");
  await sw.fire("message", { data: { type: "GET_STATUS" }, source });
  assert.equal((replies[1] as { ready: boolean }).ready, false);
});

test("service worker: cache first for precached files and pages, the rest untouched", async () => {
  const sw = loadSw(FILES);
  await sw.fire("install");
  sw.net["examples/hal-blinky.elf"] = "elf from a newer deploy";
  assert.equal(await sw.get("examples/hal-blinky.elf?x=1"), "elf");

  // Navigation: this version's page even when a newer deploy is online, so
  // the page never runs against the older cached examples and lessons.
  sw.net["index.html"] = "<html>v2</html>";
  assert.equal(await sw.get("", { mode: "navigate" }), "<html>v1</html>");
  sw.state.online = false;
  assert.equal(await sw.get("?lesson=led-blink", { mode: "navigate" }), "<html>v1</html>");
  assert.equal(await sw.get("examples/hal-blinky.elf"), "elf");

  // Not ours: no respondWith (uploads, other sites, POSTs, unknown files).
  assert.equal(await sw.get("examples/mine.elf"), null);
  assert.equal(await sw.get("", { url: "https://other.test/x.js" }), null);
  assert.equal(await sw.get("assets/index-abc.js", { method: "POST" }), null);
  assert.equal(await sw.get("", { url: "https://example.test/elsewhere/index.html" }), null);
});

// ------------------------------------------------------ the page side

class FakeWorker implements WorkerLike {
  state = "installing";
  messages: unknown[] = [];
  private fs: (() => void)[] = [];
  postMessage(m: unknown) {
    this.messages.push(m);
  }
  addEventListener(_t: "statechange", f: () => void) {
    this.fs.push(f);
  }
  become(state: string) {
    this.state = state;
    for (const f of this.fs) f();
  }
}

function fakePage(opts: { controller: boolean; waiting?: boolean; confirm?: boolean }) {
  const reg: RegistrationLike & { fire(): void } = {
    active: new FakeWorker(),
    waiting: opts.waiting ? new FakeWorker() : null,
    installing: null,
    updates: 0,
    addEventListener(_t: "updatefound", f: () => void) {
      this.fire = f;
    },
    fire() {},
    async update() {
      (this as { updates: number }).updates++;
    },
  } as RegistrationLike & { fire(): void };
  const swListeners: Record<string, ((e: { data: unknown }) => void)[]> = {};
  const sw: ContainerLike & { emit(type: string, data?: unknown): void } = {
    controller: opts.controller ? {} : null,
    ready: Promise.resolve(reg),
    register: async () => reg,
    addEventListener(type: string, f: (e: { data: unknown }) => void) {
      (swListeners[type] ??= []).push(f);
    },
    emit(type: string, data?: unknown) {
      for (const f of swListeners[type] ?? []) f({ data });
    },
  } as ContainerLike & { emit(type: string, data?: unknown): void };
  const winListeners: Record<string, ((e: unknown) => void)[]> = {};
  const log = { reloads: 0, confirms: [] as string[] };
  let online = true;
  const env: PwaEnv = {
    sw,
    swUrl: "./sw.js",
    online: () => online,
    on: (type, f) => (winListeners[type] ??= []).push(f),
    standalone: () => false,
    reload: () => log.reloads++,
    confirm: (m) => {
      log.confirms.push(m);
      return opts.confirm ?? true;
    },
  };
  const win = (type: string, e: unknown = {}) => {
    if (type === "online") online = true;
    if (type === "offline") online = false;
    for (const f of winListeners[type] ?? []) f(e);
  };
  return { pwa: createPwa(env), reg, sw, log, win };
}

test("page: a waiting version shows the banner; SKIP_WAITING, then reload on the controller change", async () => {
  const p = fakePage({ controller: true, waiting: true });
  await p.pwa.start();
  assert.equal(p.pwa.state().update, true);
  assert.deepEqual((p.reg.active as FakeWorker).messages, [{ type: "GET_STATUS" }]);
  assert.equal(p.pwa.applyUpdate(false), true);
  assert.deepEqual((p.reg.waiting as FakeWorker).messages, [{ type: "SKIP_WAITING" }]);
  assert.equal(p.log.reloads, 0, "not before the new version controls the page");
  p.sw.emit("controllerchange");
  assert.equal(p.log.reloads, 1);
  assert.deepEqual(p.log.confirms, []);
});

test("page: while a simulation runs it asks first; no means nothing happens", async () => {
  const p = fakePage({ controller: true, waiting: true, confirm: false });
  await p.pwa.start();
  assert.equal(p.pwa.applyUpdate(true), false);
  assert.deepEqual(p.log.confirms, [RUNNING_CONFIRM]);
  assert.deepEqual((p.reg.waiting as FakeWorker).messages, []);
  p.sw.emit("controllerchange"); // e.g. another tab updated
  assert.equal(p.log.reloads, 0, "never reloads unasked");
  assert.equal(p.pwa.state().update, true);
});

test("page: a version found later shows the banner when installed; the first install does not", async () => {
  const first = fakePage({ controller: false });
  await first.pwa.start();
  const w = new FakeWorker();
  first.reg.installing = w;
  first.reg.fire();
  w.become("installed");
  first.sw.emit("controllerchange"); // clients.claim() on the first install
  assert.equal(first.pwa.state().update, false);
  assert.equal(first.log.reloads, 0);

  const later = fakePage({ controller: true });
  await later.pwa.start();
  assert.equal(later.pwa.state().update, false);
  const w2 = new FakeWorker();
  later.reg.installing = w2;
  later.reg.fire();
  w2.become("installed");
  assert.equal(later.pwa.state().update, true);
  later.pwa.dismissUpdate();
  assert.equal(later.pwa.state().update, false);
});

test("page: offline-ready status from the service worker, the offline badge, the install prompt", async () => {
  const p = fakePage({ controller: false });
  assert.equal(p.pwa.state().offline.state, "off");
  await p.pwa.start();
  assert.equal(p.pwa.state().offline.state, "preparing");
  p.sw.emit("message", { type: "PROGRESS", done: 10, total: 126, version: "v1" });
  assert.deepEqual(p.pwa.state().offline, { state: "preparing", done: 10, total: 126, version: "v1" });
  p.sw.emit("message", { type: "STATUS", ready: true, version: "v1", cached: 126, total: 126 });
  assert.deepEqual(p.pwa.state().offline, { state: "ready", version: "v1" });
  p.sw.emit("message", { type: "PROGRESS", done: 10, total: 126, version: "v2" }); // an update caching
  assert.equal(p.pwa.state().offline.state, "ready");

  assert.equal(p.pwa.state().online, true);
  p.win("offline");
  assert.equal(p.pwa.state().online, false);
  p.win("online");
  assert.equal(p.pwa.state().online, true);
  assert.equal((p.reg as unknown as { updates: number }).updates, 1, "back online: look for a new version");

  let prevented = 0;
  let prompted = 0;
  p.win("beforeinstallprompt", {
    preventDefault: () => prevented++,
    prompt: async () => prompted++,
    userChoice: Promise.resolve({ outcome: "accepted" }),
  });
  assert.equal(prevented, 1);
  assert.equal(p.pwa.state().installable, true);
  await p.pwa.install();
  assert.equal(prompted, 1);
  assert.equal(p.pwa.state().installable, false);
  assert.equal(p.pwa.state().installed, true);
});
