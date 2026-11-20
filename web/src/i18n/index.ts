// M34: the user interface in Korean (the source language) or English.
//
// Strings are written in Korean where they are used and wrapped in `t()`;
// the Korean text is the key of its English translation (gettext style), so
// the code reads as before and a missing translation shows the Korean.
// Dictionaries: src/i18n/en/*.ts. test/i18n.test.ts finds every Korean
// string outside a `t()` call and every key without an English entry.
//
// Placeholders: `{name}` is replaced by vars.name. In Korean,
// `{name|이/가}` writes the value followed by the particle that fits it
// (이/가, 을/를, 은/는, 와/과, 으로/로; see lessons/korean.ts). In English,
// `{n#wire/wires}` writes "wire" when n is 1 and "wires" otherwise (only the
// word, not the number).
//
// The language is chosen once, when the page loads: changing it saves the
// choice and reloads the page (the project is kept by its autosave), so
// strings built when a module loads are in the right language too.
import { josa } from "../lessons/korean.ts";
import { EN } from "./en/index.ts";

export type Lang = "ko" | "en";
export const LANGS: Lang[] = ["ko", "en"];
const KEY = "simucleo.lang";

function detect(): Lang {
  try {
    const q = new URLSearchParams(globalThis.location?.search ?? "").get("lang");
    if (q === "ko" || q === "en") {
      globalThis.localStorage?.setItem(KEY, q);
      return q;
    }
    const s = globalThis.localStorage?.getItem(KEY);
    if (s === "ko" || s === "en") return s;
  } catch {
    // storage blocked: fall through to the browser's languages
  }
  const nav = globalThis.navigator;
  // Node (tests): no `location`; Node 21+ does have navigator.languages (from its locale).
  if (!nav || typeof nav.languages === "undefined" || !globalThis.location) return "ko";
  const langs = nav.languages?.length ? nav.languages : [nav.language];
  return langs.some((l) => /^ko\b/i.test(l ?? "")) ? "ko" : "en";
}

let current: Lang = detect();

/** The language of this page. */
export const lang = (): Lang => current;

/** Choose a language: saved, then the page reloads in it. */
export function switchLang(l: Lang) {
  try {
    globalThis.localStorage?.setItem(KEY, l);
  } catch {
    // not saved: the reload below keeps the `lang` query instead
  }
  const url = new URL(globalThis.location.href);
  url.searchParams.set("lang", l);
  globalThis.location.replace(url.toString());
}

/** For tests: the language `t()` translates to from now on. */
export function setLangForTest(l: Lang) {
  current = l;
}

/**
 * A worker's language, from the page's message: a worker has no localStorage
 * and its own URL, so it cannot find the page's choice by itself.
 */
export function setLang(l: Lang) {
  current = l;
}

export type Vars = Record<string, string | number>;

const PLACEHOLDER = /\{(\w+)(?:([|#])([^{}]*))?\}/g;

function fill(template: string, vars: Vars | undefined, l: Lang): string {
  if (!vars) return template;
  return template.replace(PLACEHOLDER, (all, name: string, kind?: string, spec?: string) => {
    if (!(name in vars)) return all;
    const v = vars[name];
    if (kind === "|") {
      return l === "ko" ? josa(String(v), spec as Parameters<typeof josa>[1]) : String(v);
    }
    if (kind === "#") {
      const [one, many] = (spec ?? "").split("/");
      return Number(v) === 1 ? one : (many ?? one);
    }
    return String(v);
  });
}

/** `ko` in the page's language, with its placeholders filled in. */
export function t(ko: string, vars?: Vars): string {
  if (current === "ko") return fill(ko, vars, "ko");
  return fill(EN[ko] ?? ko, vars, "en");
}

/**
 * A string that comes from data (an example project's name, a lesson field)
 * in the page's language: its translation when there is one, else itself.
 */
export function tr(s: string): string {
  return current === "ko" ? s : (EN[s] ?? s);
}

/** The translation of `ko` in English, or undefined (tests, tools). */
export const english = (ko: string): string | undefined => EN[ko];
