import { expect, test, type Page } from "@playwright/test";

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
