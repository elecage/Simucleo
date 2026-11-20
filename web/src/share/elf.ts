// Shrinking an uploaded ELF for a share link (M30). An ELF built with
// `-g3` is mostly DWARF (source debugging); the simulator only needs the
// loadable segments (`PT_LOAD`), and the symbol table for Error_Handler
// detection and the RTOS view (crates/elf: `FirmwareImage::parse`).
// Pure, unit tested in test/m30.test.ts.

export type Strip = "none" | "debug" | "all";

const EM_ARM = 40;
const PT_LOAD = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const STT_OBJECT = 1;
const STT_FUNC = 2;
const SHN_ABS = 0xfff1;

export interface ElfSegment {
  paddr: number;
  vaddr: number;
  memsz: number;
  flags: number;
  align: number;
  data: Uint8Array;
}
export interface ElfSymbol {
  name: string;
  value: number;
  size: number;
  info: number;
}
export interface ElfInfo {
  entry: number;
  segments: ElfSegment[];
  /** Function and object symbols with an address (what the simulator reads). */
  symbols: ElfSymbol[];
}

export class ElfError extends Error {}

import { t } from "../i18n/index.ts";

const cstr = (b: Uint8Array, at: number) => {
  let end = at;
  while (end < b.length && b[end] !== 0) end++;
  return new TextDecoder().decode(b.subarray(at, end));
};

/** Read what a 32-bit little-endian ARM ELF has to load. Throws ElfError. */
export function readElf(bytes: Uint8Array): ElfInfo {
  if (bytes.length < 52 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
    throw new ElfError(t("ELF 파일이 아닙니다."));
  }
  if (bytes[4] !== 1 || bytes[5] !== 1) throw new ElfError(t("32비트 리틀 엔디언 ELF가 아닙니다."));
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o: number) => v.getUint16(o, true);
  const u32 = (o: number) => v.getUint32(o, true);
  const inside = (off: number, len: number) => off >= 0 && len >= 0 && off + len <= bytes.length;
  if (u16(18) !== EM_ARM) throw new ElfError(t("ARM용 ELF가 아닙니다."));
  const phoff = u32(28);
  const phentsize = u16(42);
  const phnum = u16(44);
  if (phnum && (phentsize < 32 || !inside(phoff, phentsize * phnum))) throw new ElfError(t("프로그램 헤더가 파일 밖을 가리킵니다."));
  // What is copied out of the file is bounded by the file itself: segments
  // (and symbol tables) pointing at the same bytes again and again would
  // otherwise turn a small link into any amount of memory.
  let budget = bytes.length;
  const take = (len: number, what: string) => {
    budget -= len;
    if (budget < 0) throw new ElfError(t("{what}이(가) 겹쳐 파일보다 많은 데이터를 가리킵니다.", { what }));
  };
  const segments: ElfSegment[] = [];
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    if (u32(o) !== PT_LOAD) continue;
    const [off, paddr, filesz, memsz] = [u32(o + 4), u32(o + 12), u32(o + 16), u32(o + 20)];
    if (!inside(off, filesz)) throw new ElfError(t("세그먼트 {i}가 파일 밖을 가리킵니다.", { i }));
    take(filesz, t("세그먼트"));
    segments.push({ paddr, vaddr: u32(o + 8), memsz, flags: u32(o + 24), align: u32(o + 28), data: bytes.slice(off, off + filesz) });
  }
  const symbols: ElfSymbol[] = [];
  const shoff = u32(32);
  const shentsize = u16(46);
  const shnum = u16(48);
  if (shnum && shentsize >= 40 && inside(shoff, shentsize * shnum)) {
    for (let i = 0; i < shnum; i++) {
      const s = shoff + i * shentsize;
      if (u32(s + 4) !== SHT_SYMTAB) continue;
      const [off, size, link, entsize] = [u32(s + 16), u32(s + 20), u32(s + 24), u32(s + 36) || 16];
      if (link >= shnum || !inside(off, size)) continue;
      const str = shoff + link * shentsize;
      const [stroff, strsize] = [u32(str + 16), u32(str + 20)];
      if (!inside(stroff, strsize)) continue;
      const strtab = bytes.subarray(stroff, stroff + strsize);
      take(size, t("심볼 표"));
      for (let e = off + entsize; e + 16 <= off + size; e += entsize) {
        const info = bytes[e + 12];
        const type = info & 0xf;
        const value = u32(e + 4);
        if ((type !== STT_FUNC && type !== STT_OBJECT) || value === 0) continue;
        const name = cstr(strtab, u32(e));
        if (!name || name.startsWith("$")) continue;
        symbols.push({ name, value, size: u32(e + 8), info });
      }
    }
  }
  return { entry: u32(24), segments, symbols };
}

/**
 * A smaller ELF that loads the same: the header, the PT_LOAD program
 * headers and their bytes, and with "debug" a symbol table of the function
 * and object symbols (section index SHN_ABS: the sections are gone). "all"
 * drops the symbols too. "none" returns the bytes as they are.
 */
export function stripElf(bytes: Uint8Array, strip: Strip): Uint8Array {
  if (strip === "none") return bytes;
  const elf = readElf(bytes);
  const keepSymbols = strip === "debug";
  const syms = keepSymbols ? [...elf.symbols].sort((a, b) => (a.info >> 4 === 0 ? 0 : 1) - (b.info >> 4 === 0 ? 0 : 1)) : [];
  const enc = new TextEncoder();
  const strParts: Uint8Array[] = [new Uint8Array(1)];
  let strLen = 1;
  const nameOff = syms.map((s) => {
    const b = enc.encode(s.name + "\0");
    strParts.push(b);
    strLen += b.length;
    return strLen - b.length;
  });
  const shstr = enc.encode("\0.symtab\0.strtab\0.shstrtab\0");
  const align4 = (n: number) => (n + 3) & ~3;

  const phoff = 52;
  let at = phoff + elf.segments.length * 32;
  const segOff = elf.segments.map((s) => {
    at = align4(at);
    const o = at;
    at += s.data.length;
    return o;
  });
  let symOff = 0;
  let strOff = 0;
  let shstrOff = 0;
  let shoff = 0;
  if (keepSymbols) {
    symOff = align4(at);
    strOff = symOff + 16 * (syms.length + 1);
    shstrOff = strOff + strLen;
    shoff = align4(shstrOff + shstr.length);
    at = shoff + 4 * 40;
  }
  const out = new Uint8Array(at);
  const v = new DataView(out.buffer);
  const src = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  out.set(bytes.subarray(0, 16)); // e_ident
  v.setUint16(16, src.getUint16(16, true), true); // e_type
  v.setUint16(18, EM_ARM, true);
  v.setUint32(20, 1, true);
  v.setUint32(24, elf.entry, true);
  v.setUint32(28, elf.segments.length ? phoff : 0, true);
  v.setUint32(32, shoff, true);
  v.setUint32(36, src.getUint32(36, true), true); // e_flags (float ABI)
  v.setUint16(40, 52, true);
  v.setUint16(42, 32, true);
  v.setUint16(44, elf.segments.length, true);
  v.setUint16(46, keepSymbols ? 40 : 0, true);
  v.setUint16(48, keepSymbols ? 4 : 0, true);
  v.setUint16(50, keepSymbols ? 3 : 0, true);
  elf.segments.forEach((s, i) => {
    const o = phoff + i * 32;
    v.setUint32(o, PT_LOAD, true);
    v.setUint32(o + 4, segOff[i], true);
    v.setUint32(o + 8, s.vaddr, true);
    v.setUint32(o + 12, s.paddr, true);
    v.setUint32(o + 16, s.data.length, true);
    v.setUint32(o + 20, s.memsz, true);
    v.setUint32(o + 24, s.flags, true);
    v.setUint32(o + 28, s.align, true);
    out.set(s.data, segOff[i]);
  });
  if (keepSymbols) {
    syms.forEach((s, i) => {
      const e = symOff + 16 * (i + 1);
      v.setUint32(e, nameOff[i], true);
      v.setUint32(e + 4, s.value, true);
      v.setUint32(e + 8, s.size, true);
      out[e + 12] = s.info;
      v.setUint16(e + 14, SHN_ABS, true);
    });
    let p = strOff;
    for (const b of strParts) {
      out.set(b, p);
      p += b.length;
    }
    out.set(shstr, shstrOff);
    const firstGlobal = 1 + syms.filter((s) => s.info >> 4 === 0).length;
    const sh = (i: number, name: number, type: number, off: number, size: number, link: number, info: number, align: number, entsize: number) => {
      const o = shoff + i * 40;
      v.setUint32(o, name, true);
      v.setUint32(o + 4, type, true);
      v.setUint32(o + 16, off, true);
      v.setUint32(o + 20, size, true);
      v.setUint32(o + 24, link, true);
      v.setUint32(o + 28, info, true);
      v.setUint32(o + 32, align, true);
      v.setUint32(o + 36, entsize, true);
    };
    sh(1, 1, SHT_SYMTAB, symOff, 16 * (syms.length + 1), 2, firstGlobal, 4, 16);
    sh(2, 9, SHT_STRTAB, strOff, strLen, 0, 0, 1, 0);
    sh(3, 17, SHT_STRTAB, shstrOff, shstr.length, 0, 0, 1, 0);
  }
  return out;
}
