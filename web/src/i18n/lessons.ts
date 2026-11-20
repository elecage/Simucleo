// M34: lessons in English. Each web/lessons/<file>.json has a
// web/lessons/en/<file>.json: a map from every Korean string of the lesson
// (title, goal, step text, check labels, hints, …) to its English.
// A lesson's structure (checks, pins, code) is never translated.

/** Every string value in `v`, depth first. */
export function lessonStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) lessonStrings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) lessonStrings(x, out);
  return out;
}

/** `v` with each string that `map` has replaced by its translation. */
export function translateLesson<T>(v: T, map: Record<string, string>): T {
  const go = (x: unknown): unknown => {
    if (typeof x === "string") return map[x] ?? x;
    if (Array.isArray(x)) return x.map(go);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, go(y)]));
    return x;
  };
  return go(v) as T;
}
