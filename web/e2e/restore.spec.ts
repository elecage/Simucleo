import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// The last session comes back from IndexedDB a moment after the page is
// ready. Whatever the user opens in that moment must stay: a restore that
// finishes later gives way (it used to replace the user's pick with the
// last session's circuit and firmware).

const status = (page: Page) => page.getByTestId("run-status");

test("an example picked while the last session is still being restored stays", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  // With the flag set, reading the autosave answers 2.5 s late (a slow disk).
  await page.addInitScript(() => {
    const get = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (this: IDBObjectStore, key: IDBValidKey | IDBKeyRange) {
      const req = get.call(this, key);
      if (key === "autosave" && localStorage.getItem("slow-autosave")) {
        let handler: ((e: Event) => void) | null = null;
        Object.defineProperty(req, "onsuccess", {
          configurable: true,
          get: () => handler,
          set(f: (e: Event) => void) {
            handler = f;
            req.addEventListener("success", (e) => {
              (window as unknown as { slowed: number }).slowed = ((window as unknown as { slowed?: number }).slowed ?? 0) + 1;
              setTimeout(() => handler?.(e), 2500);
            });
          },
        });
      }
      return req;
    };
  });
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
  await page.getByLabel("예제 펌웨어").selectOption("hal-imu-matrix.elf");
  await expect(status(page)).toContainText("hal-imu-matrix");
  await page.waitForTimeout(1500); // autosaved
  await page.evaluate(() => localStorage.setItem("slow-autosave", "1"));
  await page.reload();
  await expect(status(page)).toContainText("예제를");
  await page.getByLabel("예제 펌웨어").selectOption("hal-ir-remote.elf");
  await expect(status(page)).toContainText("hal-ir-remote");
  // Long after the restore has its answer: still the user's pick.
  await page.waitForTimeout(4000);
  expect(await page.evaluate(() => (window as unknown as { slowed?: number }).slowed)).toBe(1);
  await expect(status(page)).toContainText("hal-ir-remote");
  await expect(page.locator("[data-id=ir]")).toHaveCount(1);
  await expect(page.locator("[data-id=imu]")).toHaveCount(0);
});

// A project file without firmware keeps the firmware, even one still on its
// way: a lesson's example is fetched when the lesson starts, and the student
// may open the circuit before it has arrived (it used to be dropped).
test.describe("firmware still on its way", () => {
  test.use({ serviceWorkers: "block" }); // routes do not see the service worker's cache
  test("a project without firmware opened while a lesson's firmware loads keeps that firmware", async ({ page }) => {
    page.on("dialog", (d) => void d.accept());
    let delayed = 0;
    await page.route("**/examples/lesson-knight-rider.elf", async (route) => {
      delayed++;
      await new Promise((r) => setTimeout(r, 2000));
      await route.continue();
    });
    await page.goto("/");
    await expect(status(page)).toContainText("예제를");
    const panel = page.getByRole("complementary", { name: "실습" });
    await page.getByRole("button", { name: "📝 실습" }).click();
    await panel.locator('[data-lesson="knight-rider"]').getByRole("button", { name: "시작" }).click();
    // The circuit (no firmware in it) before the lesson's ELF has come.
    const project = JSON.parse(readFileSync("public/examples/lesson-knight-rider.simucleo.json", "utf8"));
    delete project.firmware;
    await page.getByTestId("project-input").setInputFiles({ name: "circuit.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(project)) });
    await expect(status(page)).toContainText("lesson-knight-rider", { timeout: 10_000 });
    expect(delayed).toBe(1);
  });
});
