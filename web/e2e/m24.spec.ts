import { expect, test, type Browser, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// M24 classroom features: the teacher's results view (results exported by
// two students in their own browsers, one file edited afterwards), the
// lesson editor (checks generated from the circuit, saved to "내 레슨",
// started again after a reload and graded), and grading marks on the
// schematic for failed wiring checks.

const status = (page: Page) => page.getByTestId("run-status");
const panel = (page: Page) => page.getByRole("complementary", { name: "실습" });
const check = (page: Page, key: string) => panel(page).locator(`[data-check="${key}"]`);
const teacher = (page: Page) => page.getByRole("dialog", { name: "선생님용 결과 모아보기" });
const editor = (page: Page) => page.getByRole("dialog", { name: "레슨 편집기" });

const board = { id: "nucleo", kind: "nucleo-f401re", x: 4, y: 2, props: {} };
const led = { id: "myLed", kind: "led-5mm", x: 46, y: 9, props: { color: "red" } };
const res = { id: "R7", kind: "resistor", x: 46, y: 20, props: { ohms: "220" } };
/** D13 → R7 → LED → GND: lesson 1 wired right. */
const RIGHT = {
  parts: [board, led, res],
  wires: [
    { id: "w1", a: { part: "nucleo", pin: "D13" }, b: { part: "R7", pin: "1" } },
    { id: "w2", a: { part: "R7", pin: "2" }, b: { part: "myLed", pin: "A" } },
    { id: "w3", a: { part: "myLed", pin: "K" }, b: { part: "nucleo", pin: "GND_D" } },
  ],
};
/** The same chain on D12 (PA6). */
const WRONG_PIN = { ...RIGHT, wires: RIGHT.wires.map((w) => (w.id === "w1" ? { ...w, a: { part: "nucleo", pin: "D12" } } : w)) };
/** No resistor: D13 → LED → GND. */
const NO_RESISTOR = {
  parts: [board, led],
  wires: [
    { id: "w1", a: { part: "nucleo", pin: "D13" }, b: { part: "myLed", pin: "A" } },
    { id: "w2", a: { part: "myLed", pin: "K" }, b: { part: "nucleo", pin: "GND_D" } },
  ],
};

async function ready(page: Page) {
  await page.goto("/");
  await expect(status(page)).toContainText("예제를");
}

async function openProject(page: Page, project: object) {
  await page.getByTestId("project-input").setInputFiles({
    name: "p.simucleo.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ format: "simucleo-project", version: 1, ...project })),
  });
}

async function startLesson(page: Page, id: string) {
  await page.getByRole("button", { name: "📝 실습" }).click();
  await panel(page).locator(`[data-lesson="${id}"]`).getByRole("button", { name: "시작" }).click();
  await expect(panel(page).locator(".lesson-title")).toBeVisible();
}

async function grade(page: Page) {
  await panel(page).getByRole("button", { name: "채점", exact: true }).click();
  await expect(panel(page).getByTestId("grade-progress")).toBeVisible();
  await expect(panel(page).getByTestId("grade-progress")).toHaveCount(0, { timeout: 30_000 });
}

/** The JSON results file of the student in `page`, through the real export button. */
async function exportJson(page: Page, student: string): Promise<{ name: string; text: string }> {
  await panel(page).getByRole("button", { name: "← 목록" }).click();
  await panel(page).getByLabel("학생 이름").fill(student);
  const dl = page.waitForEvent("download");
  await panel(page).getByRole("button", { name: "JSON", exact: true }).click();
  const d = await dl;
  return { name: d.suggestedFilename(), text: readFileSync((await d.path())!, "utf8") };
}

/** A student in a browser of their own. */
async function student(browser: Browser, name: string, project: object, graded: boolean) {
  const context = await browser.newContext({ locale: "ko-KR", baseURL: test.info().project.use.baseURL, viewport: { width: 1400, height: 820 } });
  const page = await context.newPage();
  await ready(page);
  await startLesson(page, "led-blink");
  await openProject(page, project);
  if (graded) {
    await expect(check(page, "1.0")).toHaveAttribute("data-status", "pass");
    await grade(page);
    await expect(panel(page).getByTestId("lesson-complete")).toBeVisible();
  } else {
    await expect(check(page, "0.1")).toHaveAttribute("data-status", "fail");
  }
  const file = await exportJson(page, name);
  await context.close();
  return file;
}

const asFile = (name: string, text: string) => ({ name, mimeType: "application/json", buffer: Buffer.from(text) });
const row = (page: Page, name: string) => teacher(page).locator(`tbody tr[data-student="${name}"]`);

test("teacher view: two students' exports in one table, pass rates, duplicates, a tampered and an old file", async ({ page, browser }) => {
  test.setTimeout(90_000);
  const kim = await student(browser, "kim 01", RIGHT, true);
  const park = await student(browser, "park 02", NO_RESISTOR, false);
  expect(kim.name).toBe("lesson-results_kim_01.json");
  expect(JSON.parse(kim.text).integrity.hash).toMatch(/^[0-9a-f]{64}$/);

  await ready(page);
  await page.getByRole("button", { name: "📝 실습" }).click();
  await panel(page).getByRole("button", { name: "👩‍🏫 선생님용 결과 모아보기" }).click();
  await teacher(page).getByTestId("teacher-input").setInputFiles([asFile(kim.name, kim.text), asFile(park.name, park.text)]);

  const table = teacher(page).getByTestId("teacher-table");
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(table.locator("thead")).toContainText("LED 깜빡이 배선");
  await expect(table.locator("thead")).toContainText("2. D13 → 저항 → LED → GND");
  // kim did everything; park placed only the LED and wired it without a resistor.
  await expect(row(page, "kim 01").locator('[data-cell="led-blink:score"]')).toContainText("✅ 100% (7/7)");
  await expect(row(page, "kim 01").locator('[data-cell="led-blink:time"]')).not.toContainText("미완료");
  await expect(row(page, "park 02").locator('[data-cell="led-blink:0"]')).toHaveAttribute("data-status", "partial");
  await expect(row(page, "park 02").locator('[data-cell="led-blink:1"]')).toHaveAttribute("data-status", "fail");
  await expect(row(page, "park 02").locator('[data-cell="led-blink:time"]')).toContainText("미완료");
  for (const r of ["kim 01", "park 02"]) await expect(row(page, r).getByTestId("row-integrity")).toHaveAttribute("data-integrity", "verified");
  const rates = teacher(page).getByTestId("pass-rates");
  await expect(rates.locator("td").nth(1)).toHaveText("50% (1/2)"); // completed
  await expect(rates.locator('[data-rate="led-blink:0"]')).toHaveText("50%");
  await expect(rates.locator('[data-rate="led-blink:1"]')).toHaveText("50%");

  // Sorting by score: highest first, then the other way round.
  await table.getByRole("columnheader", { name: "점수" }).click();
  await expect(table.locator("tbody tr").first()).toHaveAttribute("data-student", "kim 01");
  await table.getByRole("columnheader", { name: /점수/ }).click();
  await expect(table.locator("tbody tr").first()).toHaveAttribute("data-student", "park 02");
  await teacher(page).getByLabel("학생 검색").fill("park");
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await teacher(page).getByLabel("학생 검색").fill("");

  // park "fixes" the file by hand (same export time: it replaces the original),
  // and an old copy of kim's file without the hash turns up.
  const edited = JSON.parse(park.text);
  for (const c of edited.lessons[0].checks) {
    c.pass = true;
    delete c.pending;
  }
  const old = JSON.parse(kim.text);
  delete old.integrity;
  old.exportedAt = "2020-01-01T00:00:00.000Z";
  await teacher(page)
    .getByTestId("teacher-input")
    .setInputFiles([asFile("park-edited.json", JSON.stringify(edited, null, 2)), asFile("kim-old.json", JSON.stringify(old))]);
  await expect(teacher(page).getByTestId("teacher-file")).toHaveCount(4);
  await expect(teacher(page).locator('[data-testid=teacher-file][data-integrity="tampered"]')).toContainText("park-edited.json");
  await expect(teacher(page).locator('[data-testid=teacher-file][data-integrity="unverified"]')).toContainText("검증 안 됨");
  await expect(teacher(page).getByTestId("teacher-duplicates").locator("li")).toHaveCount(2);
  await expect(teacher(page).getByTestId("teacher-duplicates")).toContainText("kim 01 · led-blink — " + kim.name + " 사용, kim-old.json 무시");
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(row(page, "park 02").getByTestId("row-integrity")).toHaveAttribute("data-integrity", "tampered");
  await expect(row(page, "park 02").getByTestId("row-integrity")).toContainText("변조됨");
  await expect(row(page, "kim 01").getByTestId("row-integrity")).toHaveAttribute("data-integrity", "verified");
  await teacher(page).getByLabel("변조 의심만").check();
  await expect(table.locator("tbody tr")).toHaveCount(1);
  await teacher(page).getByLabel("변조 의심만").uncheck();

  const dl = page.waitForEvent("download");
  await teacher(page).getByRole("button", { name: "표 CSV로 내보내기" }).click();
  const csv = readFileSync((await (await dl).path())!, "utf8");
  expect(csv).toMatch(/^﻿student,integrity,files,LED 깜빡이 배선 점수/);
  expect(csv).toMatch(/\r\nkim 01,검증됨,lesson-results_kim_01\.json,100,7\/7,yes,\d+,1,pass,pass,pass\r\n/);
  expect(csv).toMatch(/\r\npark 02,변조됨,park-edited\.json,100,/);
  expect(csv).toContain("통과율");
});

test("lesson editor: checks from the current wiring, saved to 내 레슨, started after a reload and graded", async ({ page }) => {
  test.setTimeout(60_000);
  await ready(page);
  await openProject(page, RIGHT);
  await expect(page.locator('[data-id="R7"]')).toHaveCount(1);
  await page.getByRole("button", { name: "📝 실습" }).click();
  await panel(page).getByRole("button", { name: "✏️ 레슨 편집기" }).click();
  const ed = editor(page);
  await expect(ed.getByTestId("editor-errors")).toContainText("'goal'가 없습니다");
  await ed.getByLabel("레슨 id").fill("led-blink");
  await expect(ed.getByTestId("editor-errors")).toContainText("기본 실습의 id");
  await ed.getByLabel("레슨 id").fill("my-blink");
  await ed.getByLabel("레슨 제목").fill("내 LED 실습");
  await ed.getByLabel("목표").fill("D13에 저항과 LED를 달고 1초 주기로 깜빡입니다.");
  await ed.getByLabel("시작 회로").selectOption("project");
  await expect(ed).toContainText("부품 3개 · 와이어 3개");
  await ed.getByLabel("펌웨어").selectOption("hal-blinky.elf");
  await ed.getByLabel("단계 1 제목").fill("배선하고 채점");

  await ed.getByRole("button", { name: "현재 배선에서 검사 만들기" }).click();
  await expect(ed.getByTestId("editor-note")).toContainText("배선 검사 3개");
  await expect(ed.locator(".editor-check")).toHaveCount(3);
  await expect(ed.locator(".editor-check").nth(2)).toHaveAttribute("data-type", "series");
  // A behaviour check by form: the period of PA5.
  await ed.getByRole("button", { name: "+ 검사" }).click();
  const last = ed.locator(".editor-check").last();
  await last.getByLabel("검사 종류").selectOption("period");
  await expect(last.getByLabel("주기 (ms)")).toHaveValue("1000");
  // A broken field shows up as an error, and saving waits for it.
  await last.getByLabel("주기 (ms)").fill("");
  await expect(ed.getByTestId("editor-errors")).toContainText("단계 1 검사 4 (period): 'ms'가 없습니다");
  await expect(ed.getByRole("button", { name: "내 레슨에 저장" })).toBeDisabled();
  await last.getByLabel("주기 (ms)").fill("1000");
  await expect(ed.getByTestId("editor-errors")).toHaveText("✅ 레슨 형식이 맞습니다");

  const dl = page.waitForEvent("download");
  await ed.getByRole("button", { name: "JSON 파일로 내려받기" }).click();
  const d = await dl;
  expect(d.suggestedFilename()).toBe("my-blink.json");
  const saved = JSON.parse(readFileSync((await d.path())!, "utf8"));
  expect(saved.steps[0].checks).toEqual([
    { type: "part", kind: "led-5mm" },
    { type: "part", kind: "resistor" },
    { type: "series", from: "PA5", to: "GND", through: ["resistor", "led-5mm"] },
    { type: "period", pin: "PA5", ms: 1000, tolerance: 0.05 },
  ]);
  expect(saved.start.project.parts).toHaveLength(3);

  // Preview on the current project: the wiring checks are already green.
  await ed.getByRole("button", { name: "미리 보기 (현재 프로젝트로)" }).click();
  await expect(panel(page).getByTestId("lesson-preview")).toBeVisible();
  await expect(check(page, "0.2")).toHaveAttribute("data-status", "pass");
  await panel(page).getByRole("button", { name: "편집기로 돌아가기" }).click();
  await editor(page).getByRole("button", { name: "내 레슨에 저장" }).click();
  await editor(page).getByRole("button", { name: "레슨 편집기 닫기" }).click();

  // A reload: the lesson is in 내 레슨; starting it loads its circuit and firmware.
  await page.waitForTimeout(600);
  await page.reload();
  // Ready: the start-up prompt, or already the lesson's firmware when the
  // reopened lesson restored it first (both orders happen).
  await expect(status(page)).toContainText(/예제를|hal-blinky/);
  if (!(await panel(page).count())) await page.getByRole("button", { name: "📝 실습" }).click();
  await expect(panel(page).getByText("불러오는 중…")).toHaveCount(0);
  if (await panel(page).getByRole("button", { name: "← 목록" }).count()) await panel(page).getByRole("button", { name: "← 목록" }).click();
  const mine = panel(page).getByRole("region", { name: "내 레슨" }).locator('[data-lesson="my-blink"]');
  await expect(mine).toContainText("내 LED 실습");
  await openProject(page, { parts: [board], wires: [] }); // nothing wired now
  await mine.getByRole("button", { name: "시작" }).click();
  await expect(panel(page).locator(".lesson-title")).toHaveText("내 LED 실습");
  await expect(status(page)).toContainText("hal-blinky");
  for (const k of ["0.0", "0.1", "0.2"]) await expect(check(page, k)).toHaveAttribute("data-status", "pass");
  await expect(check(page, "0.3")).toHaveAttribute("data-status", "pending");
  await grade(page);
  await expect(check(page, "0.3")).toHaveAttribute("data-status", "pass");
  await expect(check(page, "0.3")).toContainText(/측정 주기 100\d ms/);
  await expect(panel(page).getByTestId("lesson-complete")).toBeVisible();

  // And it can be removed.
  await panel(page).getByRole("button", { name: "← 목록" }).click();
  page.once("dialog", (d) => void d.accept());
  await panel(page).getByRole("button", { name: "내 LED 실습 삭제" }).click();
  await expect(panel(page).locator('[data-lesson="my-blink"]')).toHaveCount(0);
});

test("a wiring check that fails at grading marks its pins and nets on the schematic and the breadboard", async ({ page }) => {
  test.setTimeout(60_000);
  await ready(page);
  await startLesson(page, "led-blink");
  await openProject(page, WRONG_PIN);
  await expect(check(page, "1.0")).toHaveAttribute("data-status", "fail");
  // Not before grading.
  await expect(page.locator(".pin.marked")).toHaveCount(0);
  await grade(page);
  await expect(panel(page).getByTestId("lesson-marks")).toContainText("1개");
  await expect(page.locator('[data-pins="R7"] [data-pin="1"]')).toHaveClass(/marked/);
  await expect(page.locator('[data-pins="nucleo"] [data-pin="D12"]')).toHaveClass(/marked/);
  await expect(page.locator('[data-pins="nucleo"] [data-pin="D13"]')).toHaveClass(/marked/); // where it should go

  await page.getByRole("button", { name: "회로도" }).click();
  await expect(page.getByTestId("sch-marks")).toBeVisible();
  const sch = page.locator("svg.schematic");
  await expect(sch.locator('[data-part="R7"] [data-mark="fail"]')).toHaveCount(2);
  await expect(sch.locator('[data-part="myLed"] [data-mark="fail"]')).toHaveCount(2);
  // The wrong MCU net (PA6, where the resistor is) is marked.
  await expect(sch.locator('[data-part="nucleo"] [data-pin*="D12"]')).toHaveAttribute("data-mark", "fail");

  // Wired right, the check passes and the marks go.
  await openProject(page, RIGHT);
  await expect(check(page, "1.0")).toHaveAttribute("data-status", "pass");
  await expect(sch.locator("[data-mark]")).toHaveCount(0);
  await expect(page.getByTestId("sch-marks")).toHaveCount(0);
});

// ------------------------------------------------- review fixes (PR #29)

/** Put a value in the app's IndexedDB (as an older version or an edited database would have). */
async function idbPut(page: Page, key: string, value: unknown) {
  await page.evaluate(
    ([k, v]) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open("simucleo", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("kv");
        req.onsuccess = () => {
          const tx = req.result.transaction("kv", "readwrite");
          tx.objectStore("kv").put(v, k);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      }),
    [key, value] as const,
  );
}

async function openEditorFromPanel(page: Page) {
  if (!(await panel(page).count())) await page.getByRole("button", { name: "📝 실습" }).click();
  await expect(panel(page).getByText("불러오는 중…")).toHaveCount(0);
  if (await panel(page).getByRole("button", { name: "← 목록" }).count()) await panel(page).getByRole("button", { name: "← 목록" }).click();
  await panel(page).getByRole("button", { name: "✏️ 레슨 편집기" }).click();
  await expect(editor(page)).toBeVisible();
}

test("a malformed lesson JSON shows its errors in the editor instead of crashing, also after a reload", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page);
  await openEditorFromPanel(page);
  const malformed = { steps: [{ title: "Step", text: "", checks: [] }] };
  await editor(page).getByTestId("editor-load").setInputFiles(asFile("bad.json", JSON.stringify(malformed)));
  await expect(editor(page).getByTestId("editor-errors")).toContainText("'id'가 없습니다");
  await expect(editor(page).getByTestId("editor-errors")).toContainText("'goal'가 없습니다");
  await expect(editor(page).getByLabel("단계 1 제목")).toHaveValue("Step");
  await expect(editor(page).getByLabel("시작 회로")).toHaveValue("empty");
  await expect(editor(page).getByRole("button", { name: "내 레슨에 저장" })).toBeDisabled();
  // Not a lesson at all: refused with a reason, the draft stays.
  await editor(page).getByTestId("editor-load").setInputFiles(asFile("list.json", "[1, 2]"));
  await expect(editor(page).getByRole("alert")).toContainText("레슨 파일이 아닙니다");
  await expect(editor(page).getByLabel("단계 1 제목")).toHaveValue("Step");

  // The draft was saved; it opens again after a reload.
  await page.waitForTimeout(600);
  await page.reload();
  await expect(status(page)).toContainText("예제를");
  await openEditorFromPanel(page);
  await expect(editor(page).getByTestId("editor-errors")).toContainText("'id'가 없습니다");
  await expect(editor(page).getByLabel("단계 1 제목")).toHaveValue("Step");

  // A draft and a 내 레슨 already stored broken (before this fix) do not brick the app either.
  await idbPut(page, "lessons:draft", { title: { x: 1 }, start: null, firmware: null, steps: [null, { title: "둘째", checks: [7] }] });
  await idbPut(page, "lessons:mine", [null, { id: "broken", title: "고장 난 레슨", start: { project: {} }, steps: 3 }]);
  await page.reload();
  await expect(status(page)).toContainText("예제를");
  await openEditorFromPanel(page);
  await expect(editor(page).getByLabel("단계 2 제목")).toHaveValue("둘째");
  await expect(editor(page).getByTestId("editor-errors")).toContainText("'title'가 없습니다");
  await editor(page).getByRole("button", { name: "레슨 편집기 닫기" }).click();
  const broken = panel(page).getByRole("region", { name: "내 레슨" }).locator('[data-lesson="broken"]');
  await expect(broken).toContainText("레슨 파일 오류");
  await broken.getByRole("button", { name: "편집" }).click();
  await expect(editor(page).getByLabel("레슨 제목")).toHaveValue("고장 난 레슨");
  await expect(editor(page).getByTestId("editor-errors")).toContainText("'steps'가 비어 있습니다");
  expect(errors).toEqual([]);
});

test("results exported before 채점 count the ungraded checks: the teacher sees 57 %, not 100 %", async ({ page, browser }) => {
  test.setTimeout(60_000);
  const context = await browser.newContext({ locale: "ko-KR", baseURL: test.info().project.use.baseURL, viewport: { width: 1400, height: 820 } });
  const sp = await context.newPage();
  await ready(sp);
  await startLesson(sp, "led-blink");
  await openProject(sp, RIGHT);
  for (const k of ["0.0", "0.1", "1.0", "2.3"]) await expect(check(sp, k)).toHaveAttribute("data-status", "pass");
  await expect(check(sp, "2.1")).toHaveAttribute("data-status", "pending");
  const f = await exportJson(sp, "lee 03");
  await context.close();
  const lesson = JSON.parse(f.text).lessons[0];
  expect(lesson).toMatchObject({ passed: 4, total: 7 });
  expect(lesson.checks.filter((c: { pending?: boolean }) => c.pending).map((c: { key: string }) => c.key)).toEqual(["2.0", "2.1", "2.2"]);

  await ready(page);
  await page.getByRole("button", { name: "📝 실습" }).click();
  await panel(page).getByRole("button", { name: "👩‍🏫 선생님용 결과 모아보기" }).click();
  await teacher(page).getByTestId("teacher-input").setInputFiles([asFile(f.name, f.text)]);
  const score = row(page, "lee 03").locator('[data-cell="led-blink:score"]');
  await expect(score).toContainText("57% (4/7)");
  await expect(score).toContainText("미채점 검사 있음");
  await expect(row(page, "lee 03").getByTestId("row-integrity")).toHaveAttribute("data-integrity", "verified");
  await expect(row(page, "lee 03").locator('[data-cell="led-blink:2"]')).toHaveAttribute("data-status", "partial");
  await expect(row(page, "lee 03").locator('[data-cell="led-blink:1"]')).toHaveAttribute("data-status", "pass");

  // The same file as an older version wrote it (no pending entries, no hash):
  // the bundled lesson's definition fills in the missing checks.
  const old = JSON.parse(f.text);
  delete old.integrity;
  old.student = "lee old";
  old.lessons[0].checks = old.lessons[0].checks.filter((c: { pending?: boolean }) => !c.pending);
  await teacher(page).getByTestId("teacher-input").setInputFiles([asFile("old.json", JSON.stringify(old))]);
  await expect(row(page, "lee old").locator('[data-cell="led-blink:score"]')).toContainText("57% (4/7)");
  await expect(row(page, "lee old").locator('[data-cell="led-blink:2"]')).toHaveAttribute("data-status", "partial");
});

test("editing a saved lesson's checks clears its old results: a changed period check is not left passed", async ({ page }) => {
  test.setTimeout(60_000);
  await ready(page);
  const v1 = {
    id: "my-period",
    order: 120,
    title: "주기 실습",
    level: "입문",
    goal: "PA5가 1초 주기로 토글합니다.",
    start: "empty",
    firmware: { example: "hal-blinky.elf" },
    steps: [{ title: "채점", text: "채점을 누르세요.", checks: [{ type: "period", pin: "PA5", ms: 1000 }] }],
  };
  await page.getByRole("button", { name: "📝 실습" }).click();
  await panel(page).getByTestId("lesson-import").setInputFiles(asFile("my-period.json", JSON.stringify(v1)));
  const mine = panel(page).getByRole("region", { name: "내 레슨" }).locator('[data-lesson="my-period"]');
  await mine.getByRole("button", { name: "시작" }).click();
  await expect(status(page)).toContainText("hal-blinky");
  await grade(page);
  await expect(check(page, "0.0")).toHaveAttribute("data-status", "pass");
  await expect(panel(page).getByTestId("lesson-complete")).toBeVisible();

  // The teacher changes the period to 500 ms and saves under the same id.
  await panel(page).getByRole("button", { name: "← 목록" }).click();
  await expect(mine).toContainText("✅");
  await mine.getByRole("button", { name: "편집" }).click();
  await editor(page).getByLabel("주기 (ms)").fill("500");
  await editor(page).getByRole("button", { name: "내 레슨에 저장" }).click();
  await editor(page).getByRole("button", { name: "레슨 편집기 닫기" }).click();
  await expect(mine).not.toContainText("✅");
  await mine.getByRole("button", { name: "이어서 하기" }).click();
  await expect(check(page, "0.0")).toHaveAttribute("data-status", "pending");
  await expect(check(page, "0.0")).toContainText("500 ms");
  await expect(panel(page).getByTestId("lesson-complete")).toHaveCount(0);
  // And after a reload too (the reset progress was stored).
  await page.waitForTimeout(600);
  await page.reload();
  // Ready: the start-up prompt, or already the lesson's firmware when the
  // reopened lesson restored it first (both orders happen).
  await expect(status(page)).toContainText(/예제를|hal-blinky/);
  if (!(await panel(page).count())) await page.getByRole("button", { name: "📝 실습" }).click();
  // The panel reopens the lesson that was open once it has read the saved progress.
  await expect(panel(page).getByText("불러오는 중…")).toHaveCount(0);
  if (await panel(page).getByRole("button", { name: "← 목록" }).count()) await panel(page).getByRole("button", { name: "← 목록" }).click();
  await mine.getByRole("button", { name: "이어서 하기" }).click();
  await expect(check(page, "0.0")).toHaveAttribute("data-status", "pending");
  // Graded again, the new check fails on the 1 s blinky.
  await grade(page);
  await expect(check(page, "0.0")).toHaveAttribute("data-status", "fail");
});
