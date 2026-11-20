// M34: the language menu at the end of the toolbar. Each language is named in
// itself; choosing one reloads the page in it (see ./index.ts).
import { lang, LANGS, switchLang, type Lang } from "./index.ts";

const NAME: Record<Lang, string> = { ko: "한국어", en: "English" }; // i18n-ok: each language in its own name

export function LangSelect() {
  return (
    <select
      className="lang-select"
      value={lang()}
      onChange={(e) => switchLang(e.target.value as Lang)}
      aria-label="Language / 언어" // i18n-ok: read in both languages
      title="Language / 언어" // i18n-ok
    >
      {LANGS.map((l) => (
        <option key={l} value={l}>
          {NAME[l]}
        </option>
      ))}
    </select>
  );
}
