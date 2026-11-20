import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Offline app (M29): after one visit the service worker has every file
// of the build cached, and the app loads, runs example firmware and opens
// lessons with the network off. A new version waits for the banner.

test.describe.configure({ timeout: 120_000 });

const status = (page: Page) => page.getByTestId("run-status");
const offlineStatus = (page: Page) => page.getByTestId("offline-status");
const ld2On = (page: Page) => page.locator("[data-led=LD2]").evaluate((e) => Number(getComputedStyle(e).opacity) > 0.5);
const panel = (page: Page) => page.getByRole("complementary", { name: "실습" });
const marker = (page: Page) => page.evaluate(() => (window as unknown as { marker?: number }).marker);
const hasWaiting = (page: Page) =>
  page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !!r?.waiting));

async function ld2Toggles(page: Page, ms: number) {
  let last: boolean | null = null;
  let n = 0;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const on = await ld2On(page);
    if (last !== null && on !== last) n++;
    last = on;
    await page.waitForTimeout(20);
  }
  return n;
}

/** First visit: wait until the service worker reports everything cached and controls the page. */
async function firstVisit(page: Page, url = "/") {
  await page.goto(url);
  await expect(status(page)).toContainText("예제를");
  await expect(offlineStatus(page)).toHaveText("오프라인 사용 준비됨", { timeout: 60_000 });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

async function runBlinky(page: Page) {
  await page.getByLabel("예제 펌웨어").selectOption("hal-blinky.elf");
  await expect(status(page)).toContainText("hal-blinky");
  await page.getByRole("button", { name: "▶ 실행" }).click();
  await page.waitForTimeout(300);
  expect(await ld2Toggles(page, 2000)).toBeGreaterThanOrEqual(3);
}

test("after one visit the app loads offline, runs an example and opens a lesson", async ({ page, context }) => {
  await firstVisit(page);
  await expect(page.getByTestId("offline-badge")).toHaveCount(0);
  const cacheNames = await page.evaluate(() => caches.keys());
  expect(cacheNames).toHaveLength(1);
  expect(cacheNames[0]).toMatch(/^simucleo-[0-9a-f]{12}$/);

  await context.setOffline(true);
  await expect(page.getByTestId("offline-badge")).toHaveText("오프라인");

  await page.reload();
  await expect(status(page)).toContainText("예제를");
  await expect(page.locator(".version").first()).toContainText("core v");
  await expect(page.getByTestId("offline-badge")).toBeVisible();
  // Really offline: a file that is not precached does not load.
  expect(await page.evaluate(() => fetch("./not-precached.txt").then(() => "loaded", () => "failed"))).toBe("failed");

  // Example firmware (the ELF and the WASM simulator come from the cache).
  await runBlinky(page);
  await page.getByRole("button", { name: "⏸ 일시정지" }).click();

  // A lesson: the list is in the bundle, its firmware (hal-blinky) cached.
  await page.getByRole("button", { name: "📝 실습" }).click();
  await panel(page).locator('[data-lesson="led-blink"]').getByRole("button", { name: "시작" }).click();
  await expect(panel(page).locator(".lesson-title")).toHaveText("LED 깜빡이 배선");
  await expect(status(page)).toContainText("hal-blinky");

  // Back online: the badge goes.
  await context.setOffline(false);
  await expect(page.getByTestId("offline-badge")).toHaveCount(0);
});

// The banner test needs a changed sw.js on the same origin (routes do not
// reach the browser's service worker update check), so it serves dist/
// itself and can swap sw.js for another version.
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

async function serveDist(swOverride: { body: string | null }) {
  const dist = fileURLToPath(new URL("../dist/", import.meta.url));
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url!, "http://x").pathname).replace(/^\/+/, "") || "index.html";
    if (path === "sw.js" && swOverride.body !== null) {
      res.writeHead(200, { "content-type": MIME[".js"], "cache-control": "no-cache" });
      res.end(swOverride.body);
      return;
    }
    const file = join(dist, path);
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, server, sw: readFileSync(join(dist, "sw.js"), "utf8") };
}

test("a new version waits for the banner; a running simulation is asked first", async ({ page }) => {
  const swOverride: { body: string | null } = { body: null };
  const { url, server, sw } = await serveDist(swOverride);
  try {
    await firstVisit(page, url);
    const oldVersion = (await page.evaluate(() => caches.keys()))[0];

    // Deploy "another version" (only the cache version differs) and let the browser look for it.
    swOverride.body = sw.replace(/const VERSION = "([0-9a-f]+)"/, 'const VERSION = "$1-next"');
    expect(swOverride.body).not.toBe(sw);
    await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r!.update()));
    const banner = page.getByTestId("update-banner");
    await expect(banner).toContainText("새 버전이 있습니다", { timeout: 60_000 });
    // Waiting, not taken over.
    expect(await hasWaiting(page)).toBe(true);

    await runBlinky(page);
    await page.evaluate(() => ((window as unknown as { marker: number }).marker = 1));

    // Running: the reload is asked first. "No" keeps the simulation going.
    const dialogs: string[] = [];
    page.once("dialog", (d) => {
      dialogs.push(d.message());
      void d.dismiss();
    });
    await banner.getByRole("button", { name: "새로 고침" }).click();
    await expect.poll(() => dialogs.length).toBe(1);
    expect(dialogs[0]).toContain("시뮬레이션이 실행 중입니다");
    await page.waitForTimeout(500);
    expect(await marker(page)).toBe(1);
    expect(await hasWaiting(page)).toBe(true);
    expect(await ld2Toggles(page, 1200)).toBeGreaterThanOrEqual(1);

    // "Yes": the new version takes over and the page reloads with it.
    page.once("dialog", (d) => void d.accept());
    await banner.getByRole("button", { name: "새로 고침" }).click();
    await page.waitForFunction(() => (window as unknown as { marker?: number }).marker === undefined);
    await expect(status(page)).toContainText("hal-blinky"); // autosave brought the firmware back
    await expect(offlineStatus(page)).toHaveText("오프라인 사용 준비됨", { timeout: 60_000 });
    await expect(offlineStatus(page)).toHaveAttribute("title", `캐시 버전 ${oldVersion.replace("simucleo-", "")}-next`);
    await expect(page.getByTestId("update-banner")).toHaveCount(0);
    // The old version's cache is gone.
    expect(await page.evaluate(() => caches.keys())).toEqual([`${oldVersion}-next`]);
  } finally {
    server.close();
  }
});
