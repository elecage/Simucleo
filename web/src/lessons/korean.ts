// Korean particles after names that may be Latin letters or digits
// ("PA5가", "3V3으로", "저항이"), read the way Korean speakers say them.

// Last sound of each Latin letter and digit as read in Korean: does it end
// in a consonant (받침), and is that consonant ㄹ?
const LETTER_BATCHIM: Record<string, "" | "c" | "l"> = {
  a: "", b: "", c: "", d: "", e: "", f: "", g: "", h: "", i: "", j: "", k: "",
  l: "l", m: "c", n: "c", o: "", p: "", q: "", r: "l", s: "", t: "", u: "", v: "",
  w: "", x: "", y: "", z: "",
  "0": "c", "1": "l", "2": "", "3": "c", "4": "", "5": "", "6": "c", "7": "l", "8": "l", "9": "",
};

/** The final consonant of a word: none, some (c), or ㄹ (l). */
function batchim(word: string): "" | "c" | "l" {
  const w = word.replace(/[\s)\]"'.]+$/u, "");
  const ch = w.at(-1);
  if (!ch) return "";
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    const jong = (code - 0xac00) % 28;
    return jong === 0 ? "" : jong === 8 ? "l" : "c";
  }
  return LETTER_BATCHIM[ch.toLowerCase()] ?? "";
}

/** `word` followed by the right particle: 이/가, 을/를, 은/는, 와/과, 으로/로. */
export function josa(word: string, pair: "이/가" | "을/를" | "은/는" | "와/과" | "으로/로"): string {
  const b = batchim(word);
  const [withB, without] = pair.split("/");
  if (pair === "으로/로") return word + (b === "c" ? "으로" : "로");
  if (pair === "와/과") return word + (b ? "과" : "와");
  return word + (b ? withB : without);
}
