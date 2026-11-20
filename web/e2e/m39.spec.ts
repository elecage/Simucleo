import { expect, test, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { writeZip } from "../test/zipwriter.ts";

// M39: a whole STM32CubeIDE project folder or its zip. The fixture is
// hal-blinky laid out like a CubeIDE project and built with the DWARF paths
// of a Windows workspace (`make -C firmware/cubeide-blinky`): the uploaded
// files must be matched to those paths by suffix.

test.describe.configure({ timeout: 120_000 });

const FIXTURE = "../firmware/cubeide-blinky/build/blinky";
const ZIP = "../firmware/cubeide-blinky/build/blinky.zip";
test.skip(!existsSync(ZIP), "build firmware/cubeide-blinky first");

const MAIN = existsSync(ZIP) ? readFileSync(`${FIXTURE}/Core/Src/main.c`, "utf8").split("\n") : [];
/** The line of main.c that toggles LD2 (code at -O0). */
const TOGGLE = MAIN.findIndex((l) => l.includes("HAL_GPIO_TogglePin(LD2_GPIO_Port, LD2_Pin);")) + 1;

const status = (page: Page) => page.getByTestId("run-status");
const uploadStatus = (page: Page) => page.getByTestId("upload-status");
const fileSelect = (page: Page) => page.getByLabel("소스 파일");

async function ready(page: Page) {
  await page.goto("/");
  await expect(status(page)).toContainText(/예제를|·/);
}

/** Toolbar items and the canvas: none may move (drags in progress, M29/M30). */
const layout = (page: Page) =>
  page.evaluate(() => {
    const m = document.querySelector("main")!.getBoundingClientRect();
    const items = [...document.querySelector(".toolbar")!.children].map((c) => {
      const r = c.getBoundingClientRect();
      return `${r.left},${r.top},${r.width},${r.height}`;
    });
    return `${m.top} ${m.height} ${document.querySelector(".toolbar")!.getBoundingClientRect().height} | ${items.join(" ")}`;
  });

/** Sources of blinky connected, main.c shown, a breakpoint on the toggle line stops there. */
async function debugsWithSources(page: Page) {
  await expect(status(page)).toContainText("blinky.elf");
  await expect(uploadStatus(page)).toContainText(/소스 \d+개 연결/);
  await expect(fileSelect(page).locator("option:checked")).toHaveText("blinky/Core/Src/main.c");
  await expect(page.locator(`.src-line[data-line='${TOGGLE}']`)).toContainText("HAL_GPIO_TogglePin(LD2_GPIO_Port, LD2_Pin);");
  await page.getByTestId(`gutter-${TOGGLE}`).click();
  await expect(page.getByTestId(`gutter-${TOGGLE}`)).toHaveClass(/bp/);
  await page.getByRole("button", { name: "▶ 실행" }).click();
  await expect(page.getByTestId("debug-status")).toContainText("중단점", { timeout: 10_000 });
  await expect(page.locator(".src-line.here")).toHaveAttribute("data-line", String(TOGGLE));
  await expect(page.locator(".frames li").first()).toContainText("main");
  // Remove it again (a reload starts without breakpoints anyway).
  await page.getByTestId(`gutter-${TOGGLE}`).click();
}

async function openUploadMenu(page: Page) {
  await page.getByRole("button", { name: "소스 (디버그)" }).click();
  await page.locator(".upload-menu > summary").click();
}

test("a CubeIDE project zip: ELF loaded, sources matched, breakpoint in main.c, kept after reload", async ({ page }) => {
  await ready(page);
  const before = await layout(page);
  await openUploadMenu(page);
  await page.getByTestId("bundle-input").setInputFiles(ZIP);
  await debugsWithSources(page);
  // HAL drivers are in the zip, so they are connected too.
  await page.locator(".upload-files > summary").click();
  await expect(page.getByTestId("matched-files")).toContainText("blinky/Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_gpio.c");
  await expect(page.getByTestId("matched-files")).not.toContainText("Backup");
  await page.locator(".upload-files > summary").click();
  await page.screenshot({ path: "test-results/m39-zip.png" });
  expect(await layout(page)).toBe(before);

  // Reload: the ELF (autosave) and its sources (IndexedDB) come back.
  await page.waitForTimeout(700);
  await page.reload();
  await expect(status(page)).toContainText("blinky.elf");
  await page.getByRole("button", { name: "소스 (디버그)" }).click();
  await expect(uploadStatus(page)).toContainText(/소스 \d+개 연결/);
  await debugsWithSources(page);
  expect(await layout(page)).toBe(before);
});

test("a project folder (webkitdirectory picker)", async ({ page }) => {
  await ready(page);
  const before = await layout(page);
  await openUploadMenu(page);
  await page.getByTestId("folder-input").setInputFiles(FIXTURE);
  await debugsWithSources(page);
  expect(await layout(page)).toBe(before);
});

test("sources only (no ELF in the zip) attach to the ELF already loaded; missing ones are listed", async ({ page }) => {
  await ready(page);
  await page.getByTestId("elf-input").setInputFiles(`${FIXTURE}/Debug/blinky.elf`);
  await expect(status(page)).toContainText("blinky.elf");
  await page.getByRole("button", { name: "소스 (디버그)" }).click();
  await expect(page.locator(".source-code")).toContainText("의 소스가 없습니다");
  const zip = writeZip(
    ["Core/Src/main.c", "Core/Src/stm32f4xx_it.c", "Core/Inc/main.h"].map((f) => ({
      name: `blinky/${f}`,
      data: readFileSync(`${FIXTURE}/${f}`),
    })),
  );
  await openUploadMenu(page);
  await page.getByTestId("bundle-input").setInputFiles({ name: "core.zip", mimeType: "application/zip", buffer: Buffer.from(zip) });
  await expect(uploadStatus(page)).toContainText(/소스 2개 연결 · DWARF에 있지만 없는 파일 \d+개\(HAL 드라이버 등\)/);
  await expect(uploadStatus(page)).toContainText("지금 펌웨어 blinky.elf에 붙임");
  await page.locator(".upload-files > summary").click();
  await expect(page.getByTestId("missing-files")).toContainText(
    "C:/Users/student/STM32CubeIDE/workspace_1.16.0/blinky/Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_gpio.c",
  );
  await page.locator(".upload-files > summary").click();
  await debugsWithSources(page);
});

test("drag and drop a zip anywhere on the app", async ({ page }) => {
  await ready(page);
  const before = await layout(page);
  const b64 = readFileSync(ZIP).toString("base64");
  const dt = await page.evaluateHandle((data) => {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const t = new DataTransfer();
    t.items.add(new File([bytes], "blinky.zip", { type: "application/zip" }));
    return t;
  }, b64);
  await page.dispatchEvent("main", "dragenter", { dataTransfer: dt });
  await expect(page.getByTestId("drop-overlay")).toBeVisible();
  // The overlay is fixed: nothing moves under it.
  expect(await layout(page)).toBe(before);
  await page.dispatchEvent("main", "dragover", { dataTransfer: dt });
  await page.dispatchEvent("main", "drop", { dataTransfer: dt });
  await expect(page.getByTestId("drop-overlay")).toBeHidden();
  // The source tab comes to the front by itself.
  await debugsWithSources(page);
  expect(await layout(page)).toBe(before);
});

test("a zip that climbs out of its folder, or is too big, is refused and changes nothing", async ({ page }) => {
  await ready(page);
  await page.getByLabel("예제 펌웨어").selectOption("hal-blinky.elf");
  await expect(status(page)).toContainText("hal-blinky");
  const before = await layout(page);
  await openUploadMenu(page);
  const evil = writeZip([
    { name: "blinky/Debug/blinky.elf", data: readFileSync(`${FIXTURE}/Debug/blinky.elf`) },
    { name: "blinky/../../evil.c", data: "int evil;" },
  ]);
  await page.getByTestId("bundle-input").setInputFiles({ name: "evil.zip", mimeType: "application/zip", buffer: Buffer.from(evil) });
  await expect(uploadStatus(page)).toContainText("폴더 밖");
  await expect(uploadStatus(page)).toHaveClass(/error/);
  await expect(status(page)).toContainText("hal-blinky");
  await expect(status(page)).not.toContainText("blinky.elf ·");

  // 40 sources of 1.9 MB of zeros: 76 MB unpacked (the zip is a few KB).
  const big = writeZip(Array.from({ length: 40 }, (_, i) => ({ name: `big/Core/Src/f${i}.c`, data: new Uint8Array(1_900_000) })));
  expect(big.length).toBeLessThan(200_000);
  await page.locator(".upload-menu > summary").click();
  await page.getByTestId("bundle-input").setInputFiles({ name: "big.zip", mimeType: "application/zip", buffer: Buffer.from(big) });
  await expect(uploadStatus(page)).toContainText("너무 큽니다");
  await expect(status(page)).toContainText("hal-blinky");
  // The bundled example's sources are still what the source tab shows.
  await expect(fileSelect(page).locator("option:checked")).toHaveText("hal-blinky/main.c");
  expect(await layout(page)).toBe(before);
});

test("several ELFs: the student picks one (Debug/Release first, newest first)", async ({ page }) => {
  await ready(page);
  const elf = readFileSync(`${FIXTURE}/Debug/blinky.elf`);
  const zip = writeZip([
    { name: "blinky/old/blinky.elf", data: elf, date: new Date(Date.UTC(2024, 8, 1)) },
    { name: "blinky/Debug/blinky.elf", data: elf, date: new Date(Date.UTC(2024, 0, 1)) },
    { name: "blinky/Release/blinky.elf", data: elf, date: new Date(Date.UTC(2024, 5, 1)) },
    { name: "blinky/Core/Src/main.c", data: readFileSync(`${FIXTURE}/Core/Src/main.c`) },
  ]);
  await openUploadMenu(page);
  await page.getByTestId("bundle-input").setInputFiles({ name: "three.zip", mimeType: "application/zip", buffer: Buffer.from(zip) });
  const choice = page.getByTestId("elf-choice");
  await expect(choice.locator("label")).toHaveText([/blinky\/Release\/blinky\.elf/, /blinky\/Debug\/blinky\.elf/, /blinky\/old\/blinky\.elf/]);
  await expect(choice.locator("input").first()).toBeChecked();
  await expect(status(page)).not.toContainText("blinky.elf");
  await choice.locator("label").nth(1).click();
  await choice.getByRole("button", { name: "불러오기" }).click();
  await expect(choice).toBeHidden();
  await expect(uploadStatus(page)).toContainText("소스 1개 연결");
  await debugsWithSources(page);
});

test("share links carry no sources: the receiver gets the ELF and the usual no-source state", async ({ page, browser }) => {
  await ready(page);
  await openUploadMenu(page);
  await page.getByTestId("bundle-input").setInputFiles(ZIP);
  await expect(uploadStatus(page)).toContainText(/소스 \d+개 연결/);
  await page.getByRole("button", { name: "🔗 공유" }).click();
  const dlg = page.getByRole("dialog", { name: "공유" });
  // With the debug info (the receiver could debug), still no source text.
  await dlg.getByLabel("디버그 정보 빼기").uncheck();
  await expect(dlg.getByTestId("share-summary")).not.toContainText("→");
  const link = await dlg.getByTestId("share-link").inputValue();
  expect(link).not.toContain("HAL_GPIO_TogglePin");
  await dlg.getByRole("button", { name: "공유 닫기" }).click();
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1400, height: 820 } });
  try {
    const other = await context.newPage();
    await other.goto(link);
    await other.getByRole("dialog", { name: "공유 링크 열기" }).getByRole("button", { name: "열기" }).click();
    await expect(status(other)).toContainText("blinky.elf");
    await other.getByRole("button", { name: "소스 (디버그)" }).click();
    await expect(fileSelect(other).locator("option:checked")).toContainText("Core/Src/main.c (소스 없음)");
    await expect(other.locator(".source-code")).toContainText("의 소스가 없습니다");
    await expect(other.getByTestId("upload-status")).toHaveCount(0);
  } finally {
    await context.close();
  }
});

// Loads still on their way give way to an upload (M39 review): the last
// session's restore, answering late, must not replace the uploaded ELF;
// sources read while another firmware came must not attach to it.

test("an upload made while the last session is still being restored stays", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
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
            req.addEventListener("success", (e) => setTimeout(() => handler?.(e), 2500));
          },
        });
      }
      return req;
    };
  });
  await ready(page);
  await page.getByLabel("예제 펌웨어").selectOption("hal-imu-matrix.elf");
  await expect(status(page)).toContainText("hal-imu-matrix");
  await page.waitForTimeout(1500); // autosaved
  await page.evaluate(() => localStorage.setItem("slow-autosave", "1"));
  await page.reload();
  await expect(status(page)).toContainText("예제를");
  await openUploadMenu(page);
  await page.getByTestId("bundle-input").setInputFiles(ZIP);
  await expect(status(page)).toContainText("blinky.elf");
  await page.waitForTimeout(4000);
  await expect(status(page)).toContainText("blinky.elf");
  await expect(uploadStatus(page)).toContainText(/소스 \d+개 연결/);
});

test("sources read while another firmware is loaded are not attached to it", async ({ page }) => {
  // With the flag set, reading an uploaded file takes 2 s.
  await page.addInitScript(() => {
    const read = Blob.prototype.arrayBuffer;
    Blob.prototype.arrayBuffer = async function (this: Blob) {
      if ((window as unknown as { slowFiles?: boolean }).slowFiles) await new Promise((r) => setTimeout(r, 2000));
      return read.call(this);
    };
  });
  await ready(page);
  await page.getByTestId("elf-input").setInputFiles(`${FIXTURE}/Debug/blinky.elf`);
  await expect(status(page)).toContainText("blinky.elf");
  const zip = writeZip([{ name: "blinky/Core/Src/main.c", data: readFileSync(`${FIXTURE}/Core/Src/main.c`) }]);
  await openUploadMenu(page);
  await page.evaluate(() => ((window as unknown as { slowFiles: boolean }).slowFiles = true));
  await page.getByTestId("bundle-input").setInputFiles({ name: "core.zip", mimeType: "application/zip", buffer: Buffer.from(zip) });
  // Meanwhile: another firmware (an example, fetched, not read from a file).
  page.on("dialog", (d) => void d.accept());
  await page.getByLabel("예제 펌웨어").selectOption("hal-blinky.elf");
  await expect(status(page)).toContainText("hal-blinky");
  await expect(uploadStatus(page)).toContainText("펌웨어가 바뀌어 소스를 붙이지 않았습니다");
  await expect(uploadStatus(page)).not.toContainText("붙임");
});
