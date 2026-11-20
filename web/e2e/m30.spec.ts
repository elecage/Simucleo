import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// Share links and QR codes (M30): a project goes into the link's
// fragment, opens in another browser after the receiver says so, and
// reproduces the circuit and firmware; "선생님께 보내기" carries a sealed
// lesson result that the teacher view verifies; it works offline.

test.describe.configure({ timeout: 120_000 });

const status = (page: Page) => page.getByTestId("run-status");
const panel = (page: Page) => page.getByRole("complementary", { name: "실습" });
const shareDialog = (page: Page) => page.getByRole("dialog", { name: "공유" });
const teacherDialog = (page: Page) => page.getByRole("dialog", { name: "선생님께 보내기" });
const receive = (page: Page) => page.getByRole("dialog", { name: "공유 링크 열기" });
const teacher = (page: Page) => page.getByRole("dialog", { name: "선생님용 결과 모아보기" });
const ld2On = (page: Page) => page.locator("[data-led=LD2]").evaluate((e) => Number(getComputedStyle(e).opacity) > 0.5);

const board = { id: "nucleo", kind: "nucleo-f401re", x: 4, y: 2, props: {} };
const led = { id: "myLed", kind: "led-5mm", x: 46, y: 9, props: { color: "green" } };
const res = { id: "R7", kind: "resistor", x: 46, y: 20, props: { ohms: "330" } };
/** D13 (PA5, with LD2) → R7 → LED → GND. */
const CIRCUIT = {
  name: "보낼 회로",
  parts: [board, led, res],
  wires: [
    { id: "w1", a: { part: "nucleo", pin: "D13" }, b: { part: "R7", pin: "1" }, color: "#e53935", points: [{ x: 40, y: 12 }] },
    { id: "w2", a: { part: "R7", pin: "2" }, b: { part: "myLed", pin: "A" }, color: "#1e88e5" },
    { id: "w3", a: { part: "myLed", pin: "K" }, b: { part: "nucleo", pin: "GND_D" }, color: "#212121" },
  ],
};
const MINE = {
  name: "받는 사람의 작업",
  parts: [board, { ...led, id: "keepMe", props: { color: "blue" } }],
  wires: [{ id: "w9", a: { part: "nucleo", pin: "D7" }, b: { part: "keepMe", pin: "A" }, color: "#43a047" }],
};

async function ready(page: Page, url = "/") {
  await page.goto(url);
  await expect(status(page)).toContainText(/예제를|·/);
}

async function fresh(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 1400, height: 820 } });
  return { context, page: await context.newPage() };
}

async function openProject(page: Page, project: object) {
  await page.getByTestId("project-input").setInputFiles({
    name: "p.simucleo.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ format: "simucleo-project", version: 1, ...project })),
  });
}

/** The autosaved project (what a reload brings back), once it has caught up. */
async function autosave(page: Page): Promise<{ name: string; parts: object[]; wires: object[]; firmware?: { name: string; example?: string; data?: string } }> {
  await page.waitForTimeout(700);
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("simucleo", 1);
        req.onsuccess = () => {
          const get = req.result.transaction("kv").objectStore("kv").get("autosave");
          get.onsuccess = () => resolve(JSON.parse(get.result as string));
          get.onerror = () => reject(get.error);
        };
        req.onerror = () => reject(req.error);
      }),
  );
}

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

async function runsBlinky(page: Page) {
  await page.getByRole("button", { name: "▶ 실행" }).click();
  await page.waitForTimeout(300);
  expect(await ld2Toggles(page, 2000)).toBeGreaterThanOrEqual(3);
  await page.getByRole("button", { name: "⏸ 일시정지" }).click();
}

/** The sender: CIRCUIT with the hal-blinky example; the link from 🔗 공유. */
async function exampleLink(page: Page) {
  await ready(page);
  await openProject(page, CIRCUIT);
  await page.getByLabel("예제 펌웨어").selectOption("hal-blinky.elf");
  await expect(status(page)).toContainText("hal-blinky");
  await page.getByRole("button", { name: "🔗 공유" }).click();
  const link = await shareDialog(page).getByTestId("share-link").inputValue();
  return link;
}

test("a circuit with example firmware opens in a fresh browser exactly, after asking; a QR code is shown", async ({ page, browser }) => {
  const link = await exampleLink(page);
  expect(link).toMatch(/^http:\/\/localhost:\d+\/#s1=[A-Za-z0-9_-]+$/);
  // Small: a QR code is offered and the summary says what goes in.
  const qr = shareDialog(page).getByTestId("share-qr");
  await expect(qr).toBeVisible();
  expect(Number(await qr.getAttribute("data-version"))).toBeLessThanOrEqual(40);
  await expect(shareDialog(page).getByTestId("share-no-qr")).toHaveCount(0);
  await expect(shareDialog(page).getByTestId("share-summary")).toContainText("부품 3개 · 와이어 3개");
  await expect(shareDialog(page).getByTestId("share-summary")).toContainText("예제 hal-blinky.elf");
  expect(Number(await shareDialog(page).getByTestId("share-size").getAttribute("data-chars"))).toBe(link.length);
  // The copy button puts the same link on the clipboard.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await shareDialog(page).getByRole("button", { name: "링크 복사" }).click();
  await expect(shareDialog(page).getByRole("button", { name: "✓ 복사됨" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  await shareDialog(page).getByRole("button", { name: "공유 닫기" }).click();
  const sent = await autosave(page);

  const { context, page: other } = await fresh(browser);
  try {
    await other.goto(link);
    const dlg = receive(other);
    await expect(dlg).toBeVisible();
    await expect(dlg.getByTestId("receive-name")).toHaveText("보낼 회로");
    await expect(dlg.getByTestId("receive-summary")).toContainText("부품 3개 · 와이어 3개");
    await expect(dlg.getByTestId("receive-firmware")).toHaveText("펌웨어: 예제 hal-blinky.elf");
    // Nothing loaded before "열기".
    await expect(status(other)).toContainText("예제를");
    await dlg.getByRole("button", { name: "열기" }).click();
    await expect(dlg).toHaveCount(0);
    await expect(status(other)).toContainText("hal-blinky");
    await expect(other.getByLabel("프로젝트 이름")).toHaveValue("보낼 회로");
    // The fragment is gone, so a reload does not ask again.
    expect(new URL(other.url()).hash).toBe("");
    const got = await autosave(other);
    expect(got.parts).toEqual(sent.parts);
    expect(got.wires).toEqual(sent.wires);
    expect(got.firmware?.example).toBe("hal-blinky.elf");
    expect(got.firmware?.name).toBe(sent.firmware?.name);
    await runsBlinky(other);
    await other.reload();
    await expect(status(other)).toContainText("hal-blinky");
    await expect(receive(other)).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("opening a link never replaces the receiver's work without consent", async ({ page, browser }) => {
  const link = await exampleLink(page);
  const { context, page: other } = await fresh(browser);
  try {
    await ready(other);
    await openProject(other, MINE);
    const mine = await autosave(other);
    expect(mine.parts).toHaveLength(2);

    // Same page, new fragment (a hashchange), and a cancel.
    await other.goto(link);
    await expect(receive(other)).toBeVisible();
    await expect(receive(other).getByTestId("receive-warning")).toContainText("받는 사람의 작업");
    await receive(other).getByRole("button", { name: "취소" }).click();
    await expect(receive(other)).toHaveCount(0);
    expect(new URL(other.url()).hash).toBe("");
    expect((await autosave(other)).parts).toEqual(mine.parts);
    await other.reload();
    await expect(status(other)).toContainText("예제를");
    await expect(receive(other)).toHaveCount(0);
    expect((await autosave(other)).parts).toEqual(mine.parts);

    // A real page load with the link, "열기", and "no" to the usual question: still mine.
    await other.goto("about:blank");
    await other.goto(link);
    await expect(receive(other)).toBeVisible();
    const asked: string[] = [];
    other.once("dialog", (d) => {
      asked.push(d.message());
      void d.dismiss();
    });
    await receive(other).getByRole("button", { name: "열기" }).click();
    await expect.poll(() => asked.length).toBe(1);
    expect(asked[0]).toContain("저장하지 않은 내용은 사라집니다");
    await expect(receive(other)).toBeVisible();
    expect((await autosave(other)).parts).toEqual(mine.parts);
    // "yes": replaced.
    other.once("dialog", (d) => void d.accept());
    await receive(other).getByRole("button", { name: "열기" }).click();
    await expect(receive(other)).toHaveCount(0);
    await expect(status(other)).toContainText("hal-blinky");
    expect((await autosave(other)).parts).toHaveLength(3);
  } finally {
    await context.close();
  }
});

test("a broken link says so and changes nothing", async ({ page }) => {
  await ready(page);
  await openProject(page, MINE);
  await page.goto("/#s1=AAAA-not-a-link");
  await expect(receive(page).getByTestId("receive-error")).toContainText("손상");
  await receive(page).getByRole("button", { name: "닫기" }).click();
  expect((await autosave(page)).parts).toHaveLength(2);
  await page.goto("/#s9=abc");
  await expect(receive(page).getByTestId("receive-error")).toContainText("더 새 버전");
});

test("an uploaded ELF travels in the link, stripped of debug info; no QR for it", async ({ page, browser }) => {
  await ready(page);
  await openProject(page, CIRCUIT);
  await page.getByTestId("elf-input").setInputFiles("public/examples/hal-blinky.elf");
  await expect(status(page)).toContainText("hal-blinky.elf");
  await page.getByRole("button", { name: "🔗 공유" }).click();
  const dlg = shareDialog(page);
  await expect(dlg.getByLabel("디버그 정보 빼기")).toBeChecked();
  await expect(dlg.getByTestId("share-summary")).toContainText(/hal-blinky\.elf 829 KB → \d+(\.\d)? KB/);
  const stripped = await dlg.getByTestId("share-link").inputValue();
  expect(stripped.length).toBeGreaterThan(2953);
  expect(stripped.length).toBeLessThan(20_000);
  await expect(dlg.getByTestId("share-qr")).toHaveCount(0);
  await expect(dlg.getByTestId("share-no-qr")).toContainText("QR 코드 없음");
  await expect(dlg.getByTestId("share-long")).toBeVisible();
  // With the debug info: much longer, still a link.
  await dlg.getByLabel("디버그 정보 빼기").uncheck();
  await expect(dlg.getByTestId("share-summary")).not.toContainText("→");
  const full = await dlg.getByTestId("share-link").inputValue();
  expect(full.length).toBeGreaterThan(10 * stripped.length);
  await dlg.getByRole("button", { name: "공유 닫기" }).click();
  const elf = readFileSync("public/examples/hal-blinky.elf").toString("base64");

  const { context, page: other } = await fresh(browser);
  try {
    await other.goto(stripped);
    await expect(receive(other).getByTestId("receive-firmware")).toContainText(/hal-blinky\.elf \(링크에 든 ELF \d+(\.\d)? KB, 디버그 정보 뺌\)/);
    await receive(other).getByRole("button", { name: "열기" }).click();
    await expect(status(other)).toContainText("hal-blinky.elf");
    expect((await autosave(other)).firmware?.data?.length).toBeLessThan(elf.length / 10);
    await runsBlinky(other);

    // The full ELF comes back byte for byte.
    await other.goto("about:blank");
    await other.goto(full);
    other.once("dialog", (d) => void d.accept()); // replaces the stripped one just opened
    await receive(other).getByRole("button", { name: "열기" }).click();
    await expect(status(other)).toContainText("hal-blinky.elf");
    expect((await autosave(other)).firmware?.data).toBe(elf);
  } finally {
    await context.close();
  }
});

test("선생님께 보내기: the teacher view imports the link and shows the student's row as verified", async ({ page, browser }) => {
  const { context, page: student } = await fresh(browser);
  let link: string;
  try {
    await ready(student);
    await student.getByRole("button", { name: "📝 실습" }).click();
    await panel(student).locator('[data-lesson="led-blink"]').getByRole("button", { name: "시작" }).click();
    await expect(panel(student).locator(".lesson-title")).toHaveText("LED 깜빡이 배선");
    await openProject(student, { ...CIRCUIT, wires: CIRCUIT.wires.map((w) => ({ ...w, points: undefined })) });
    await expect(panel(student).locator('[data-check="1.0"]')).toHaveAttribute("data-status", "pass");
    await panel(student).getByRole("button", { name: "채점", exact: true }).click();
    await expect(panel(student).getByTestId("lesson-complete")).toBeVisible({ timeout: 30_000 });
    await panel(student).getByLabel("학생 이름").fill("kim 01");
    await panel(student).getByRole("button", { name: "📤 선생님께 보내기" }).click();
    const dlg = teacherDialog(student);
    await expect(dlg.getByLabel(/실습 결과 넣기/)).toBeChecked();
    await expect(dlg.getByTestId("share-summary")).toContainText("실습 결과: kim 01 · 실습 1개");
    await expect(dlg.getByTestId("share-summary")).toContainText("실습: LED 깜빡이 배선");
    link = await dlg.getByTestId("share-link").inputValue();
  } finally {
    await context.close();
  }

  // The teacher pastes it into the results view.
  await ready(page);
  await page.getByRole("button", { name: "📝 실습" }).click();
  await panel(page).getByRole("button", { name: "👩‍🏫 선생님용 결과 모아보기" }).click();
  await teacher(page).getByLabel("공유 링크 붙여넣기").fill(`김 학생이 보냄:\n${link}\n`);
  await teacher(page).getByRole("button", { name: "링크 추가" }).click();
  const row = teacher(page).locator('tbody tr[data-student="kim 01"]');
  await expect(row.getByTestId("row-integrity")).toHaveAttribute("data-integrity", "verified");
  await expect(row.getByTestId("row-integrity")).toContainText("검증됨");
  await expect(row.locator('[data-cell="led-blink:score"]')).toContainText("✅ 100%");
  await expect(teacher(page).getByTestId("teacher-file")).toContainText("링크: kim 01");
  // A link without a result is reported, not added as a student.
  const plain = link.replace(/#.*/, "#s1=") ;
  await teacher(page).getByLabel("공유 링크 붙여넣기").fill(plain);
  await teacher(page).getByRole("button", { name: "링크 추가" }).click();
  await expect(teacher(page).getByTestId("teacher-file").nth(1)).toContainText("손상");
  await teacher(page).getByRole("button", { name: "결과 모아보기 닫기" }).click();

  // Opening the link itself: the result is verified there too, and "열기" brings the circuit and the lesson.
  await page.goto(link);
  await expect(receive(page).getByTestId("receive-result")).toContainText("kim 01 · 실습 1개 ✅ 검증됨");
  await receive(page).getByRole("button", { name: "열기" }).click();
  await expect(panel(page).locator(".lesson-title")).toHaveText("LED 깜빡이 배선");
  await expect(status(page)).toContainText("hal-blinky");
  expect((await autosave(page)).parts).toHaveLength(3);
  // Or straight into the table without touching the project.
  await page.goto("about:blank");
  await page.goto(link);
  await receive(page).getByRole("button", { name: "👩‍🏫 결과 모아보기에 추가" }).click();
  await expect(teacher(page).locator('tbody tr[data-student="kim 01"]').getByTestId("row-integrity")).toHaveAttribute("data-integrity", "verified");
});

test("a link opens offline once the app is cached", async ({ browser }) => {
  const { context, page } = await fresh(browser);
  try {
    const link = await exampleLink(page);
    await shareDialog(page).getByRole("button", { name: "공유 닫기" }).click();
    await expect(page.getByTestId("offline-status")).toHaveText("오프라인 사용 준비됨", { timeout: 60_000 });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await openProject(page, MINE);
    await context.setOffline(true);
    // A new tab, offline: the service worker serves the page, the fragment stays in the address.
    const tab = await context.newPage();
    await tab.goto(link);
    await expect(tab.getByTestId("offline-badge")).toBeVisible();
    await expect(receive(tab)).toBeVisible();
    await expect(receive(tab).getByTestId("receive-name")).toHaveText("보낼 회로");
    tab.once("dialog", (d) => void d.accept());
    await receive(tab).getByRole("button", { name: "열기" }).click();
    await expect(status(tab)).toContainText("hal-blinky");
    await runsBlinky(tab);
  } finally {
    await context.close();
  }
});

// The share button sits in the toolbar, inside the project name's box: it
// takes no room of its own (a wider item wraps the run controls, a taller
// toolbar moves the canvas under a drag in progress).
test("the share button never moves the canvas", async ({ page }) => {
  for (const width of [1400, 1280, 1100]) {
    await page.setViewportSize({ width, height: 820 });
    await ready(page);
    const layout = await page.evaluate(() => {
      const btn = document.querySelector<HTMLElement>(".share-btn")!;
      const box = () => {
        const m = document.querySelector("main")!.getBoundingClientRect();
        const t = document.querySelector(".toolbar")!.getBoundingClientRect();
        const items = [...document.querySelector(".toolbar")!.children].map((c) => {
          const r = c.getBoundingClientRect();
          return `${r.left},${r.top},${r.width},${r.height}`;
        });
        return `${m.top} ${m.height} ${t.height} | ${items.join(" ")}`;
      };
      const withBtn = box();
      btn.style.display = "none";
      const without = box();
      btn.style.display = "";
      const b = btn.getBoundingClientRect();
      const name = document.querySelector(".project-name")!.getBoundingClientRect();
      const inside = b.left >= name.left && b.right <= name.right && b.top >= name.top && b.bottom <= name.bottom;
      return { withBtn, without, inside, nameWidth: name.width, visible: b.width > 0 };
    });
    expect(layout.visible).toBe(true);
    expect(layout.inside).toBe(true);
    expect(layout.nameWidth).toBe(130); // as before M30
    expect(layout.withBtn).toBe(layout.without);
    // Opening and closing the dialog moves nothing either.
    const before = await page.locator("main").boundingBox();
    await page.getByRole("button", { name: "🔗 공유" }).click();
    await shareDialog(page).getByRole("button", { name: "공유 닫기" }).click();
    expect(await page.locator("main").boundingBox()).toEqual(before);
  }
});
