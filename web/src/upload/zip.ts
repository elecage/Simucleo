// A small zip reader for uploaded project folders (M39): stored (method 0)
// and deflate (method 8, via the browser's `DecompressionStream`) entries,
// sizes from the central directory (so data descriptors need nothing more),
// UTF-8 names, CRC-32 checked. The input is untrusted: a cap on entries and
// on the bytes unpacked (declared and actual), no ZIP64, no encryption, and
// names that climb out of the folder (`..`, `/x`, `C:`) reject the whole zip.

export const MAX_ZIP_ENTRIES = 20_000;
/** Total bytes we unpack from one zip (only the entries asked for count). */
export const MAX_UNPACKED = 64 * 1024 * 1024;

export class ZipError extends Error {}

export interface ZipEntry {
  /** Path inside the zip, `/`-separated, no leading `/`. */
  path: string;
  /** Uncompressed size from the central directory. */
  size: number;
  /** Modification time (ms since the epoch, local DOS time read as UTC). */
  mtime: number;
  method: number;
  crc: number;
  compSize: number;
  dataStart: number;
  dir: boolean;
}

let CRC_TABLE: Uint32Array | null = null;
export function crc32(data: Uint8Array, crc = 0): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** Whether a stored path stays inside the folder. */
export function safePath(name: string): string {
  const p = name.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) throw new ZipError(`zip 안의 경로가 절대 경로입니다: ${name}`);
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  if (parts.includes("..")) throw new ZipError(`zip 안의 경로가 폴더 밖을 가리킵니다(..): ${name}`);
  return parts.join("/");
}

function dosTime(time: number, date: number): number {
  const y = 1980 + (date >> 9),
    mo = ((date >> 5) & 15) - 1,
    d = date & 31;
  return Date.UTC(y, mo, d || 1, time >> 11, (time >> 5) & 63, (time & 31) * 2);
}

/** The entries of a zip, from its central directory. */
export function listZip(buf: Uint8Array): ZipEntry[] {
  const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // End of central directory: the last 22 bytes plus a comment of up to 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("zip 파일이 아니거나 끝이 잘렸습니다.");
  if (eocd >= 20 && v.getUint32(eocd - 20, true) === 0x07064b50)
    throw new ZipError("ZIP64 형식(4 GB 넘는 zip)은 지원하지 않습니다.");
  const count = v.getUint16(eocd + 10, true);
  const cdSize = v.getUint32(eocd + 12, true);
  const cdOff = v.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOff === 0xffffffff) throw new ZipError("ZIP64 형식은 지원하지 않습니다.");
  if (count > MAX_ZIP_ENTRIES) throw new ZipError(`zip에 파일이 너무 많습니다(${count}개, 최대 ${MAX_ZIP_ENTRIES}개).`);
  if (cdOff + cdSize > eocd) throw new ZipError("zip의 목록(중앙 디렉터리)이 손상되었습니다.");
  const utf8 = new TextDecoder("utf-8");
  const out: ZipEntry[] = [];
  let p = cdOff;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || v.getUint32(p, true) !== 0x02014b50) throw new ZipError("zip의 목록(중앙 디렉터리)이 손상되었습니다.");
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const time = v.getUint16(p + 12, true);
    const date = v.getUint16(p + 14, true);
    const crc = v.getUint32(p + 16, true);
    const compSize = v.getUint32(p + 20, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const local = v.getUint32(p + 42, true);
    if (p + 46 + nameLen + extraLen + commentLen > eocd) throw new ZipError("zip의 목록(중앙 디렉터리)이 손상되었습니다.");
    let name = utf8.decode(buf.subarray(p + 46, p + 46 + nameLen));
    // Info-ZIP Unicode Path (0x7075): the UTF-8 name when the main one is not.
    for (let e = p + 46 + nameLen; e + 4 <= p + 46 + nameLen + extraLen; ) {
      const id = v.getUint16(e, true),
        len = v.getUint16(e + 2, true);
      if (id === 0x7075 && len > 5 && !(flags & 0x800)) name = utf8.decode(buf.subarray(e + 9, e + 4 + len));
      e += 4 + len;
    }
    if (compSize === 0xffffffff || size === 0xffffffff || local === 0xffffffff)
      throw new ZipError("ZIP64 형식은 지원하지 않습니다.");
    if (flags & 1) throw new ZipError(`암호가 걸린 zip은 열 수 없습니다: ${name}`);
    const path = safePath(name);
    if (local + 30 > buf.length || v.getUint32(local, true) !== 0x04034b50) throw new ZipError(`zip이 손상되었습니다: ${name}`);
    const dataStart = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
    if (dataStart + compSize > buf.length) throw new ZipError(`zip이 손상되었거나 잘렸습니다: ${name}`);
    out.push({ path, size, mtime: dosTime(time, date), method, crc, compSize, dataStart, dir: name.endsWith("/") });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflateRaw(data: Uint8Array, limit: number, name: string): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  void writer.write(data as Uint8Array<ArrayBuffer>).catch(() => {});
  void writer.close().catch(() => {});
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      // More than the central directory said: a lie, stop unpacking.
      if (total > limit) {
        void reader.cancel().catch(() => {});
        throw new ZipError(`zip 안의 파일이 적힌 크기보다 큽니다(압축 폭탄?): ${name}`);
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof ZipError) throw e;
    throw new ZipError(`zip 안의 파일을 풀지 못했습니다(손상): ${name}`);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export interface UnzippedFile {
  path: string;
  data: Uint8Array;
  mtime: number;
}

/**
 * Unpack the entries `want` picks (all files by default). The declared sizes
 * of the picked entries must stay under `maxTotal` (checked before anything
 * is unpacked), every entry unpacks to exactly its declared size and CRC.
 */
export async function readZip(
  buf: Uint8Array,
  want: (e: ZipEntry) => boolean = () => true,
  maxTotal = MAX_UNPACKED,
): Promise<UnzippedFile[]> {
  const entries = listZip(buf).filter((e) => !e.dir && want(e));
  const declared = entries.reduce((s, e) => s + e.size, 0);
  if (declared > maxTotal)
    throw new ZipError(
      `zip을 풀면 너무 큽니다(${(declared / 1048576).toFixed(1)} MB, 최대 ${(maxTotal / 1048576).toFixed(0)} MB).`,
    );
  const out: UnzippedFile[] = [];
  for (const e of entries) {
    const raw = buf.subarray(e.dataStart, e.dataStart + e.compSize);
    let data: Uint8Array;
    if (e.method === 0) data = raw.slice();
    else if (e.method === 8) data = await inflateRaw(raw, e.size, e.path);
    else throw new ZipError(`지원하지 않는 압축 방식(${e.method})입니다: ${e.path}`);
    if (data.length !== e.size) throw new ZipError(`zip 안의 파일 크기가 맞지 않습니다(손상): ${e.path}`);
    if (crc32(data) !== e.crc) throw new ZipError(`zip 안의 파일이 손상되었습니다(CRC 불일치): ${e.path}`);
    out.push({ path: e.path, data, mtime: e.mtime });
  }
  return out;
}

export const isZip = (b: Uint8Array) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5);
