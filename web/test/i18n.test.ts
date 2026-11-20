// M34: every Korean string the interface shows goes through t() and has an
// English translation; lessons and example projects have theirs.
//
// The source scan uses the TypeScript parser: a Korean string literal, JSX
// text or template literal is untranslated unless it is the (literal) first
// argument of t(). Comments and regular expressions are not looked at; a line
// that ends in `// i18n-ok` is skipped (Korean that is data, not interface).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { EN, GROUPS } from "../src/i18n/en/index.ts";
import { setLangForTest, t } from "../src/i18n/index.ts";
import { translateLesson, lessonStrings } from "../src/i18n/lessons.ts";
import type { Lesson } from "../src/lessons/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, "..");
const HANGUL = /[가-힣ㄱ-ㆎ]/;

/** Files whose Korean is not interface text. */
const SKIP = new Set(["src/lessons/korean.ts"]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(web, p);
    if (rel === "src/i18n/en" || rel === "src/wasm/pkg") continue;
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts") && !SKIP.has(rel)) out.push(p);
  }
  return out;
}

interface Found {
  file: string;
  line: number;
  text: string;
}

/** The untranslated Korean of a file, and the keys of its t() calls. */
export function scan(file: string): { untranslated: Found[]; keys: Found[] } {
  const code = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const lines = code.split("\n");
  const untranslated: Found[] = [];
  const keys: Found[] = [];
  const rel = relative(web, file);
  const at = (n: ts.Node, text: string): Found => ({ file: rel, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, text });
  const ok = (n: ts.Node) => /\/\/\s*i18n-ok\b/.test(lines[sf.getLineAndCharacterOfPosition(n.getStart(sf)).line] ?? "");
  const isKey = (n: ts.Node) => {
    const p = n.parent;
    return !!p && ts.isCallExpression(p) && p.arguments[0] === n && ts.isIdentifier(p.expression) && p.expression.text === "t";
  };
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      if (isKey(n)) {
        // t(ko, vars, "context"): the entry is "context::ko".
        const ctx = (n.parent as ts.CallExpression).arguments[2];
        keys.push(at(n, ctx && ts.isStringLiteral(ctx) ? `${ctx.text}::${n.text}` : n.text));
      }
      else if (HANGUL.test(n.text) && !ok(n)) untranslated.push(at(n, n.text));
    } else if (ts.isTemplateExpression(n)) {
      const text = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join("${…}");
      if (HANGUL.test(text) && !ok(n)) untranslated.push(at(n, isKey(n) ? `t() key with \${}: ${text}` : text));
    } else if (ts.isJsxText(n)) {
      if (HANGUL.test(n.text) && !ok(n)) untranslated.push(at(n, n.text.trim()));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { untranslated, keys };
}

const FILES = sources(join(web, "src"));
const scanned = FILES.map(scan);

const placeholders = (s: string) =>
  [...s.replace(/^[\w-]+::/, "").matchAll(/\{(\w+)(?:[|#][^{}]*)?\}/g)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i).sort();

test("i18n: no Korean interface text outside t()", () => {
  const all = scanned.flatMap((s) => s.untranslated);
  const byFile = new Map<string, number>();
  for (const f of all) byFile.set(f.file, (byFile.get(f.file) ?? 0) + 1);
  assert.equal(
    all.length,
    0,
    `${all.length} untranslated in ${byFile.size} files:\n` +
      [...byFile].map(([f, n]) => `  ${n} ${f}`).join("\n") +
      "\nfirst ones:\n" +
      all
        .slice(0, 30)
        .map((f) => `  ${f.file}:${f.line} ${f.text.slice(0, 80)}`)
        .join("\n"),
  );
});

test("i18n: every t() key has an English entry with the same placeholders", () => {
  const problems: string[] = [];
  for (const k of scanned.flatMap((s) => s.keys)) {
    const en = EN[k.text];
    if (en === undefined) problems.push(`${k.file}:${k.line} no English for ${JSON.stringify(k.text)}`);
    else if (placeholders(en).join() !== placeholders(k.text).join())
      problems.push(`${k.file}:${k.line} placeholders differ: ${JSON.stringify(k.text)} → ${JSON.stringify(en)}`);
  }
  assert.deepEqual(problems.slice(0, 40), [], `${problems.length} problems`);
});

test("i18n: dictionaries are English, agree with each other, and every UI entry is used", () => {
  const used = new Set(scanned.flatMap((s) => s.keys.map((k) => k.text)));
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const [group, dict] of Object.entries(GROUPS)) {
    for (const [ko, en] of Object.entries(dict)) {
      if (HANGUL.test(en)) problems.push(`${group}: Korean in the English of ${JSON.stringify(ko)}`);
      if (!en.trim()) problems.push(`${group}: empty English for ${JSON.stringify(ko)}`);
      const other = seen.get(ko);
      if (other !== undefined && other !== en) problems.push(`${group}: ${JSON.stringify(ko)} translated two ways`);
      seen.set(ko, en);
      if (group !== "DATA" && !used.has(ko)) problems.push(`${group}: unused entry ${JSON.stringify(ko)}`);
    }
  }
  assert.deepEqual(problems.slice(0, 40), [], `${problems.length} problems`);
});

test("i18n: t() fills placeholders, particles and plurals", () => {
  try {
    setLangForTest("ko");
    assert.equal(t("{pin|이/가} 바뀌지 않았습니다", { pin: "PA5" }), "PA5가 바뀌지 않았습니다");
    assert.equal(t("{name|을/를} 찾지 못했습니다", { name: "LED" }), "LED를 찾지 못했습니다");
    assert.equal(t("와이어 {n}개", { n: 3 }), "와이어 3개");
    setLangForTest("en");
    // A context picks its own entry; the plain key keeps its own.
    assert.equal(t("연결", undefined, "category"), "Connectivity");
    assert.equal(t("연결"), "Connect");
    // Not in a dictionary: the Korean, filled in.
    assert.equal(t("사전에 없는 말 {n}", { n: 1 }), "사전에 없는 말 1");
  } finally {
    setLangForTest("ko");
  }
});

test("i18n: every example project's name has English", () => {
  const dir = join(web, "public/examples");
  const missing = readdirSync(dir)
    .filter((f) => f.endsWith(".simucleo.json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")).name as string)
    .filter((n) => HANGUL.test(n ?? "") && GROUPS.DATA[n] === undefined);
  assert.deepEqual(missing, []);
});

test("i18n: every lesson has an English file covering its Korean", () => {
  const dir = join(web, "lessons");
  const problems: string[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const lesson = JSON.parse(readFileSync(join(dir, f), "utf8")) as Lesson;
    const enFile = join(dir, "en", f);
    if (!existsSync(enFile)) {
      problems.push(`${f}: no lessons/en/${f}`);
      continue;
    }
    const map = JSON.parse(readFileSync(enFile, "utf8")) as Record<string, string>;
    const korean = lessonStrings(lesson).filter((s) => HANGUL.test(s));
    for (const s of korean) if (map[s] === undefined) problems.push(`${f}: no English for ${JSON.stringify(s.slice(0, 60))}`);
    for (const [ko, en] of Object.entries(map)) {
      if (HANGUL.test(en)) problems.push(`${f}: Korean left in ${JSON.stringify(en.slice(0, 60))}`);
      if (!korean.includes(ko)) problems.push(`${f}: unused entry ${JSON.stringify(ko.slice(0, 60))}`);
    }
    // Translated, nothing Korean is left anywhere in the lesson.
    const en = translateLesson(lesson, map);
    const left = lessonStrings(en).filter((s) => HANGUL.test(s));
    if (left.length) problems.push(`${f}: still Korean after translation: ${left[0].slice(0, 60)}`);
  }
  assert.deepEqual(problems.slice(0, 40), [], `${problems.length} problems`);
});
