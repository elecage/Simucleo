import { expect, test, type Page } from "@playwright/test";

// M34: a browser asking for English gets the English interface — no Korean
// left on the main screen, in any bottom tab, in a lesson or in the
// configuration tool — and the language menu switches to Korean and back
// (remembered after a reload).

test.use({ locale: "en-US" });

const HANGUL = /[가-힣]+/g;

/** Korean the page shows: visible text, tooltips, labels and placeholders. */
async function korean(page: Page): Promise<string[]> {
  const found = await page.evaluate(() => {
    const out: string[] = [document.body.innerText];
    for (const el of document.querySelectorAll("[title], [aria-label], [placeholder]")) {
      if ((el as HTMLElement).closest("[hidden]")) continue;
      for (const a of ["title", "aria-label", "placeholder"]) {
        const v = el.getAttribute(a);
        if (v) out.push(v);
      }
    }
    return out.join("\n");
  });
  // The language menu names Korean in Korean on purpose.
  const text = found.replaceAll("한국어", "").replaceAll("Language / 언어", "");
  return [...text.matchAll(HANGUL)].map((m) => {
    const i = m.index ?? 0;
    return text.slice(Math.max(0, i - 30), i + 40).replace(/\s+/g, " ");
  });
}

const status = (page: Page) => page.getByTestId("run-status");

test("an English browser gets the English interface everywhere", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("button", { name: "📝 Lessons" })).toBeVisible();
  await expect(page.getByLabel("Language / 언어")).toHaveValue("en");
  expect(await korean(page)).toEqual([]);

  // An example project: its name in English, the run controls, warnings.
  await page.locator('select:has(option[value="hal-blinky.elf"])').selectOption("hal-blinky.elf");
  await expect(status(page)).not.toHaveText("");
  await page.waitForTimeout(1500);
  expect(await korean(page)).toEqual([]);

  // Every bottom tab.
  const tabs = page.locator("nav.tabs button.tab");
  const n = await tabs.count();
  expect(n).toBeGreaterThan(4);
  for (let i = 0; i < n; i++) {
    await tabs.nth(i).click();
    await page.waitForTimeout(300);
    expect(await korean(page), `tab ${await tabs.nth(i).innerText()}`).toEqual([]);
  }

  // A lesson, started.
  await page.getByRole("button", { name: "📝 Lessons" }).click();
  expect(await korean(page)).toEqual([]);
  page.once("dialog", (d) => d.accept());
  await page.locator('[data-lesson="led-blink"]').getByRole("button", { name: "Start" }).click();
  await expect(page.locator(".lesson-title")).toBeVisible();
  expect(await korean(page)).toEqual([]);
});

test("the configuration tool is in English", async ({ page }) => {
  await page.goto("/");
  await page.locator("nav.tabs button.tab", { hasText: "Code" }).click();
  await page.getByRole("button", { name: /Configure|configuration tool/i }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const tabs = dialog.getByRole("tab");
  const n = await tabs.count();
  expect(n).toBe(4);
  for (let i = 0; i < n; i++) {
    await tabs.nth(i).click();
    expect(await korean(page), `config tab ${i}`).toEqual([]);
  }
});

test("the language menu switches to Korean and back, and is remembered", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Language / 언어").selectOption("ko");
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await expect(page.getByRole("button", { name: "📝 실습" })).toBeVisible();
  // Remembered without the query, though the browser asks for English.
  await page.goto("/");
  await expect(page.getByRole("button", { name: "📝 실습" })).toBeVisible();
  await page.getByLabel("Language / 언어").selectOption("en");
  await expect(page.getByRole("button", { name: "📝 Lessons" })).toBeVisible();
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
});
