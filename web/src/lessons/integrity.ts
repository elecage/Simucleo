// Integrity field of a results file (M24): a SHA-256 over the canonical
// JSON of the file without the field itself, made with WebCrypto.
//
// This is tamper-EVIDENT against casual editing only (a student opening the
// JSON in a text editor and changing "pass": false to true). It is NOT a
// signature: there is no secret, so anyone who reads this code can edit a
// file and compute a new hash. docs/lessons.md says so to teachers.

export const INTEGRITY_ALG = "SHA-256";

export interface IntegrityField {
  alg: typeof INTEGRITY_ALG;
  /** Lower-case hex. */
  hash: string;
}

/** "verified": the hash matches; "tampered": it does not (or is malformed);
 * "unverified": the file has no hash (made before M24, or a CSV). */
export type Integrity = "verified" | "tampered" | "unverified";

/** JSON with object keys sorted at every level and no white space. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonicalJson(v))).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** What the hash covers: everything but the `integrity` field. */
const content = (file: Record<string, unknown>) => {
  const rest = { ...file };
  delete rest.integrity;
  return canonicalJson(rest);
};

/** The file with its integrity field (re)computed. */
export async function seal<T extends object>(file: T): Promise<T & { integrity: IntegrityField }> {
  const hash = await sha256Hex(content(file as Record<string, unknown>));
  return { ...file, integrity: { alg: INTEGRITY_ALG, hash } };
}

export async function verify(file: unknown): Promise<Integrity> {
  if (!file || typeof file !== "object") return "tampered";
  const f = file as Record<string, unknown>;
  if (f.integrity === undefined) return "unverified";
  const i = f.integrity as Partial<IntegrityField> | null;
  if (!i || i.alg !== INTEGRITY_ALG || typeof i.hash !== "string") return "tampered";
  return (await sha256Hex(content(f))) === i.hash.toLowerCase() ? "verified" : "tampered";
}
