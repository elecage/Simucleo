// A minimal ustar reader and writer (M33): the editor's SDK bundle and the
// compiler's header tree are tar files (gzip on the wire). Regular files and
// directories only; names up to 255 bytes (ustar prefix + name).

export interface TarEntry {
  name: string;
  data: Uint8Array;
}

const BLOCK = 512;
const enc = new TextEncoder();
const dec = new TextDecoder();

function writeString(h: Uint8Array, at: number, len: number, s: string) {
  const b = enc.encode(s);
  if (b.length > len) throw new Error(`tar: field too long: ${s}`);
  h.set(b, at);
}

function writeOctal(h: Uint8Array, at: number, len: number, n: number) {
  writeString(h, at, len, n.toString(8).padStart(len - 1, "0") + "\0");
}

/** Split a path into ustar's prefix (≤ 155) and name (≤ 100). */
function splitName(path: string): [string, string] {
  const b = enc.encode(path);
  if (b.length <= 100) return ["", path];
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== "/") continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (enc.encode(prefix).length <= 155 && enc.encode(name).length <= 100) return [prefix, name];
  }
  throw new Error(`tar: path too long: ${path}`);
}

function header(path: string, size: number, dir: boolean): Uint8Array {
  const h = new Uint8Array(BLOCK);
  const [prefix, name] = splitName(path);
  writeString(h, 0, 100, name);
  writeOctal(h, 100, 8, dir ? 0o755 : 0o644);
  writeOctal(h, 108, 8, 0);
  writeOctal(h, 116, 8, 0);
  writeOctal(h, 124, 12, size);
  writeOctal(h, 136, 12, 0); // mtime 0: the same input gives the same bytes
  h.fill(0x20, 148, 156); // checksum counted as spaces
  h[156] = dir ? 0x35 : 0x30;
  writeString(h, 257, 6, "ustar\0");
  writeString(h, 263, 2, "00");
  writeString(h, 345, 155, prefix);
  let sum = 0;
  for (const b of h) sum += b;
  writeString(h, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return h;
}

/** A tar of `entries` (sorted by name), with the directories they need. */
export function writeTar(entries: TarEntry[]): Uint8Array {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const dirs = new Set<string>();
  const parts: Uint8Array[] = [];
  for (const e of sorted) {
    const segs = e.name.split("/");
    for (let i = 1; i < segs.length; i++) {
      const d = segs.slice(0, i).join("/");
      if (!dirs.has(d)) {
        dirs.add(d);
        parts.push(header(d, 0, true)); // no trailing "/": the compiler's tar reader wants none
      }
    }
    parts.push(header(e.name, e.data.length, false), e.data);
    const pad = (BLOCK - (e.data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const cstr = (b: Uint8Array) => {
  const z = b.indexOf(0);
  return dec.decode(z < 0 ? b : b.subarray(0, z));
};

/** The regular files of a tar. Throws on a broken header. */
export function readTar(bytes: Uint8Array): TarEntry[] {
  const out: TarEntry[] = [];
  let at = 0;
  while (at + BLOCK <= bytes.length) {
    const h = bytes.subarray(at, at + BLOCK);
    if (h.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    const stored = parseInt(cstr(h.subarray(148, 156)).trim(), 8);
    if (stored !== sum) throw new Error(`tar: bad header checksum at ${at}`);
    const size = parseInt(cstr(h.subarray(124, 136)).trim() || "0", 8);
    const prefix = cstr(h.subarray(345, 500));
    const name = (prefix ? prefix + "/" : "") + cstr(h.subarray(0, 100));
    const type = h[156];
    at += BLOCK;
    if (at + size > bytes.length) throw new Error(`tar: ${name} is cut off`);
    if (type === 0x30 || type === 0) out.push({ name, data: bytes.slice(at, at + size) });
    at += Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}

/** Gunzip with the browser's (or Node's) DecompressionStream. */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
