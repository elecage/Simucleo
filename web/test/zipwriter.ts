// A tiny zip writer for the M39 tests (unit and E2E): stored or deflated
// entries, optionally with data descriptors (sizes after the data, as
// streaming zippers write them), UTF-8 names, and hooks to forge bad zips.
import { deflateRawSync } from "node:zlib";
import { crc32 } from "../src/upload/zip.ts";

export interface ZipInput {
  name: string;
  data: Uint8Array | string;
  /** 0 stored, 8 deflate (default). */
  method?: 0 | 8;
  /** Write sizes in a data descriptor after the data (flag bit 3). */
  descriptor?: boolean;
  /** Forge: the size the central directory claims (default: the real one). */
  claimSize?: number;
  /** Forge: the CRC the zip claims. */
  claimCrc?: number;
  /** DOS date/time as a JS date (default 2024-03-01 12:00). */
  date?: Date;
}

export function writeZip(entries: ZipInput[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = typeof e.data === "string" ? enc.encode(e.data) : e.data;
    const method = e.method ?? 8;
    const body = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
    const crc = e.claimCrc ?? crc32(raw);
    const size = e.claimSize ?? raw.length;
    const name = enc.encode(e.name);
    const d = e.date ?? new Date(Date.UTC(2024, 2, 1, 12, 0, 0));
    const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
    const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
    const flags = 0x800 | (e.descriptor ? 8 : 0);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, flags, true);
    lh.setUint16(8, method, true);
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    if (!e.descriptor) {
      lh.setUint32(14, crc, true);
      lh.setUint32(18, body.length, true);
      lh.setUint32(22, size, true);
    }
    lh.setUint16(26, name.length, true);
    const parts = [new Uint8Array(lh.buffer), name, body];
    if (e.descriptor) {
      const dd = new DataView(new ArrayBuffer(16));
      dd.setUint32(0, 0x08074b50, true);
      dd.setUint32(4, crc, true);
      dd.setUint32(8, body.length, true);
      dd.setUint32(12, size, true);
      parts.push(new Uint8Array(dd.buffer));
    }
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, flags, true);
    ch.setUint16(10, method, true);
    ch.setUint16(12, time, true);
    ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, body.length, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    for (const p of parts) {
      locals.push(p);
      offset += p.length;
    }
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  const all = [...locals, ...central, new Uint8Array(eocd.buffer)];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of all) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
