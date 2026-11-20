// Unit tests of M30: share links (encode/decode, limits, corrupt input),
// shrinking an ELF for a link, and the QR encoder checked by an
// independent decoder and the standard's constants (`npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import type { CatalogEntry } from "../src/editor/projectFormat.ts";
import { seal } from "../src/lessons/integrity.ts";
import type { ResultsFile } from "../src/lessons/progress.ts";
import { defaultScope } from "../src/run/scopeSettings.ts";
import { readElf, stripElf } from "../src/share/elf.ts";
import {
  decodeShare,
  encodeShare,
  findFragment,
  findFragments,
  fromBase64Url,
  inflate,
  MAX_LINK_CHARS,
  MAX_UNPACKED_BYTES,
  shareUrl,
  toBase64Url,
  type ShareInput,
} from "../src/share/link.ts";
import {
  alignmentPositions,
  byteCapacity,
  ECC_CODEWORDS_PER_BLOCK,
  encodeQr,
  formatBits,
  NUM_ERROR_CORRECTION_BLOCKS,
  numRawDataModules,
  QR_MAX_BYTES,
  versionBits,
  type Ecc,
} from "../src/share/qr.ts";

// ------------------------------------------------------------ fixtures

const CATALOG: Record<string, CatalogEntry> = {
  "nucleo-f401re": { pins: [{ id: "PA5" }, { id: "GND" }, { id: "D7" }] },
  "led-5mm": { props: { color: "red" }, pins: [{ id: "A" }, { id: "K" }] },
  resistor: { props: { ohms: "220" }, pins: [{ id: "1" }, { id: "2" }] },
};

const PROJECT = {
  parts: [
    { id: "nucleo", kind: "nucleo-f401re", x: 0, y: 0, props: {} },
    { id: "led1", kind: "led-5mm", x: 10, y: 5, props: { color: "green" } },
    { id: "r1", kind: "resistor", x: 20, y: 5, props: { ohms: "330" } },
  ],
  wires: [
    { id: "w1", a: { part: "nucleo", pin: "D7" }, b: { part: "r1", pin: "1" }, color: "#e53935", points: [{ x: 3, y: 4 }] },
    { id: "w2", a: { part: "r1", pin: "2" }, b: { part: "led1", pin: "A" }, color: "#1e88e5" },
    { id: "w3", a: { part: "led1", pin: "K" }, b: { part: "nucleo", pin: "GND" }, color: "#212121" },
  ],
  scope: { ...defaultScope(), analog: [] } as ReturnType<typeof defaultScope>,
};

async function resultFile(student = "3학년 2반 김민수"): Promise<ResultsFile> {
  return seal({
    format: "simucleo-lesson-results",
    version: 1,
    student,
    exportedAt: "2026-11-20T09:00:00.000Z",
    lessons: [
      {
        id: "led-blink",
        title: "LED 깜빡이 배선",
        steps: ["배선", "실행"],
        startedAt: "2026-11-20T08:40:00.000Z",
        completedAt: "2026-11-20T08:55:00.000Z",
        attempts: 2,
        passed: 2,
        total: 2,
        checks: [
          { key: "0.0", step: 0, label: "D7 — 저항", pass: true, at: "2026-11-20T08:50:00.000Z" },
          { key: "1.0", step: 1, label: "LED가 깜빡임", pass: true, at: "2026-11-20T08:55:00.000Z" },
        ],
      },
    ],
  });
}

/** A small ARM ELF: two PT_LOAD segments, an EXIDX header, 40 KB of "DWARF" and a symbol table. */
function makeElf(): Uint8Array {
  const text = new Uint8Array(96).map((_, i) => (i * 7 + 3) & 0xff);
  const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const debug = new Uint8Array(40_000).map((_, i) => (i * 31) ^ (i >> 3));
  const names = ["", "main", "Error_Handler", "counter", "$t", "start.c", "static_fn", "zero_fn", "no_type"];
  const strtab = new TextEncoder().encode(names.join("\0") + "\0");
  const off = (k: number) => names.slice(0, k).reduce((a, n) => a + n.length + 1, 0);
  // [name index, value, size, info, shndx]
  const syms: [number, number, number, number, number][] = [
    [0, 0, 0, 0, 0],
    [5, 0, 0, 0x04, 0xfff1], // FILE, local
    [4, 0x08000000, 0, 0x00, 1], // $t, local NOTYPE
    [6, 0x08000031, 8, 0x02, 1], // static_fn, local FUNC
    [1, 0x08000011, 16, 0x12, 1], // main, global FUNC
    [2, 0x08000021, 4, 0x12, 1], // Error_Handler
    [3, 0x20000000, 4, 0x11, 2], // counter, global OBJECT
    [7, 0, 4, 0x12, 1], // a function at 0: not read by the simulator
    [8, 0x08000040, 0, 0x10, 1], // global NOTYPE
  ];
  const shstr = new TextEncoder().encode("\0.text\0.data\0.debug_info\0.symtab\0.strtab\0.shstrtab\0");
  const at = { ph: 52, text: 0x100, data: 0x160, debug: 0x170, sym: 0, str: 0, shstr: 0, sh: 0 };
  at.sym = at.debug + debug.length;
  at.str = at.sym + syms.length * 16;
  at.shstr = at.str + strtab.length;
  at.sh = (at.shstr + shstr.length + 3) & ~3;
  const out = new Uint8Array(at.sh + 7 * 40);
  const v = new DataView(out.buffer);
  out.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]);
  v.setUint16(16, 2, true);
  v.setUint16(18, 40, true);
  v.setUint32(20, 1, true);
  v.setUint32(24, 0x08000011, true);
  v.setUint32(28, at.ph, true);
  v.setUint32(32, at.sh, true);
  v.setUint32(36, 0x05000400, true);
  v.setUint16(40, 52, true);
  v.setUint16(42, 32, true);
  v.setUint16(44, 3, true);
  v.setUint16(46, 40, true);
  v.setUint16(48, 7, true);
  v.setUint16(50, 6, true);
  const ph = (i: number, type: number, o: number, vaddr: number, paddr: number, filesz: number, memsz: number, flags: number) => {
    const p = at.ph + i * 32;
    [type, o, vaddr, paddr, filesz, memsz, flags, 0x1000].forEach((x, k) => v.setUint32(p + k * 4, x, true));
  };
  ph(0, 1, at.text, 0x08000000, 0x08000000, text.length, text.length, 5);
  ph(1, 0x70000001, at.text + 0x50, 0x08000050, 0x08000050, 8, 8, 4); // EXIDX: not loaded
  ph(2, 1, at.data, 0x20000000, 0x08000060, data.length, 32, 6);
  out.set(text, at.text);
  out.set(data, at.data);
  out.set(debug, at.debug);
  syms.forEach(([n, value, size, info, shndx], i) => {
    const e = at.sym + i * 16;
    v.setUint32(e, off(n), true);
    v.setUint32(e + 4, value, true);
    v.setUint32(e + 8, size, true);
    out[e + 12] = info;
    v.setUint16(e + 14, shndx, true);
  });
  out.set(strtab, at.str);
  out.set(shstr, at.shstr);
  const sh = (i: number, name: number, type: number, o: number, size: number, link = 0, info = 0, entsize = 0) => {
    const s = at.sh + i * 40;
    [name, type, 0, 0, o, size, link, info, 4, entsize].forEach((x, k) => v.setUint32(s + k * 4, x, true));
  };
  sh(1, 1, 1, at.text, text.length);
  sh(2, 7, 1, at.data, data.length);
  sh(3, 13, 1, at.debug, debug.length);
  sh(4, 25, 2, at.sym, syms.length * 16, 5, 4, 16);
  sh(5, 33, 3, at.str, strtab.length);
  sh(6, 41, 3, at.shstr, shstr.length);
  return out;
}

const share = (input: Partial<ShareInput> = {}, opts?: { compress?: boolean }) =>
  encodeShare({ project: PROJECT, name: "LED 회로", ...input }, opts);
const PAGE = "https://elecage.github.io/Simucleo/";

// ------------------------------------------------------------ links

test("a project with example firmware: a short link that reproduces the project exactly", async () => {
  const enc = await share({ firmware: { name: "hal-blinky", example: "hal-blinky.elf" } });
  assert.match(enc.fragment, /^s1=[A-Za-z0-9_-]+$/);
  const url = shareUrl(`${PAGE}#old`, enc.fragment);
  assert.equal(url, `${PAGE}#${enc.fragment}`);
  // Small enough for a QR code with the page address in front.
  assert.ok(url.length < QR_MAX_BYTES, `${url.length} chars`);
  assert.ok(enc.compressed && enc.packedBytes < enc.rawBytes);
  assert.equal(enc.elfBytes, 0);

  const r = await decodeShare(url, CATALOG);
  assert.equal(r.loaded.name, "LED 회로");
  assert.deepEqual(r.loaded.project.parts, PROJECT.parts.map((p) => ({ ...p, props: { ...CATALOG[p.kind].props, ...p.props } })));
  assert.deepEqual(r.loaded.project.wires, PROJECT.wires);
  assert.deepEqual(r.loaded.project.scope, PROJECT.scope);
  assert.deepEqual(r.loaded.firmware, { name: "hal-blinky", example: "hal-blinky.elf" });
  assert.equal(r.elf, undefined);
  assert.deepEqual(r.loaded.notes, []);
  assert.equal(r.chars, enc.fragment.length);
});

test("an uploaded ELF goes in as bytes: full, stripped of debug info, or stripped of symbols too", async () => {
  const elf = makeElf();
  const full = await share({ firmware: { name: "my.elf", bytes: elf }, strip: "none" });
  const debug = await share({ firmware: { name: "my.elf", bytes: elf }, strip: "debug" });
  const all = await share({ firmware: { name: "my.elf", bytes: elf }, strip: "all" });
  assert.equal(full.elfBytes, elf.length);
  assert.ok(debug.elfBytes < 1000 && all.elfBytes < debug.elfBytes, `${debug.elfBytes} ${all.elfBytes}`);
  assert.ok(debug.fragment.length < full.fragment.length);
  for (const [enc, strip] of [[full, "none"], [debug, "debug"], [all, "all"]] as const) {
    const r = await decodeShare(enc.fragment, CATALOG);
    assert.equal(r.loaded.firmware?.name, "my.elf");
    assert.equal(r.loaded.firmware?.example, undefined);
    const bytes = Uint8Array.from(Buffer.from(r.loaded.firmware!.data!, "base64"));
    assert.equal(bytes.length, enc.elfBytes);
    assert.deepEqual(r.elf, { size: enc.elfBytes, originalSize: elf.length, strip });
    if (strip === "none") assert.deepEqual(bytes, elf);
    // What the simulator loads is the same.
    assert.deepEqual(readElf(bytes).segments, readElf(elf).segments);
    assert.equal(readElf(bytes).entry, 0x08000011);
    assert.deepEqual(readElf(bytes).symbols.map((s) => s.name).sort(), strip === "all" ? [] : ["Error_Handler", "counter", "main", "static_fn"]);
  }
});

test("lesson context and a sealed result travel with the link and verify", async () => {
  const result = await resultFile();
  const enc = await share({ firmware: { name: "hal-blinky", example: "hal-blinky.elf" }, lesson: "led-blink", result });
  const r = await decodeShare(`보내요: ${PAGE}#${enc.fragment}  `, CATALOG);
  assert.equal(r.lesson, "led-blink");
  assert.equal(r.result?.integrity, "verified");
  assert.equal(r.result?.source, "링크: 3학년 2반 김민수");
  assert.deepEqual(r.result?.file, result);

  // An edited result in a re-made link no longer matches its hash.
  const forged = structuredClone(result);
  forged.lessons[0].checks[1].pass = false;
  forged.lessons[0].passed = 1;
  const bad = await decodeShare((await share({ result: forged })).fragment, CATALOG);
  assert.equal(bad.result?.integrity, "tampered");
  // Not a results file at all: an error, the project still opens.
  const junk = await decodeShare((await share({ result: { nope: 1 } as unknown as ResultsFile })).fragment, CATALOG);
  assert.ok(junk.result?.error);
  assert.equal(junk.loaded.project.parts.length, 3);
});

test("without CompressionStream the link is stored uncompressed and still opens", async () => {
  const enc = await share({ firmware: { name: "hal-blinky", example: "hal-blinky.elf" } }, { compress: false });
  assert.equal(enc.compressed, false);
  assert.equal(fromBase64Url(enc.fragment.slice(3))[0], 0);
  const r = await decodeShare(enc.fragment, CATALOG);
  assert.equal(r.loaded.project.wires.length, 3);
});

test("links of another version or corrupted links are rejected with a clear message", async () => {
  const enc = await share({ firmware: { name: "hal-blinky", example: "hal-blinky.elf" } });
  const data = enc.fragment.slice(3);
  await assert.rejects(decodeShare(`${PAGE}#s2=${data}`, CATALOG), /더 새 버전의 Simucleo/);
  await assert.rejects(decodeShare(`#s0=${data}`, CATALOG), /알 수 없는 링크 형식/);
  await assert.rejects(decodeShare(PAGE, CATALOG), /공유 링크가 아닙니다/);
  await assert.rejects(decodeShare(`#s1=${data.slice(0, 5)}*${data.slice(6)}`, CATALOG), /손상/);
  // Cut short (a chat app ate the end).
  await assert.rejects(decodeShare(`#s1=${data.slice(0, Math.floor(data.length / 2))}`, CATALOG), /손상/);
  // One byte changed inside the compressed data.
  const bytes = fromBase64Url(data);
  bytes[Math.floor(bytes.length / 2)] ^= 0x55;
  await assert.rejects(decodeShare(`#s1=${toBase64Url(bytes)}`, CATALOG), /손상|읽지 못/);
  // Unknown method byte.
  const m = fromBase64Url(data);
  m[0] = 7;
  await assert.rejects(decodeShare(`#s1=${toBase64Url(m)}`, CATALOG), /압축 방식 7/);

  // Well-formed containers with bad contents.
  const pack = (json: unknown, tail = new Uint8Array()) => {
    const j = new TextEncoder().encode(JSON.stringify(json));
    const body = new Uint8Array(5 + j.length + tail.length);
    new DataView(body.buffer).setUint32(1, j.length, true);
    body.set(j, 5);
    body.set(tail, 5 + j.length);
    return `#s1=${toBase64Url(body)}`; // method 0: stored
  };
  const doc = { format: "simucleo-share", version: 1, project: PROJECT };
  assert.equal((await decodeShare(pack(doc), CATALOG)).loaded.project.parts.length, 3);
  await assert.rejects(decodeShare(pack({ ...doc, format: "other" }), CATALOG), /공유 링크가 아닙니다/);
  await assert.rejects(decodeShare(pack({ ...doc, version: 9 }), CATALOG), /버전 9/);
  await assert.rejects(decodeShare(pack({ ...doc, project: { parts: "x" } }), CATALOG), /프로젝트를 읽지 못했습니다/);
  await assert.rejects(decodeShare(pack(doc, new Uint8Array([1, 2])), CATALOG), /남는 내용/);
  await assert.rejects(decodeShare(pack({ ...doc, elf: { size: 4, originalSize: 4, strip: "none" } }, new Uint8Array(3)), CATALOG), /크기가 맞지 않음/);
  await assert.rejects(decodeShare(pack({ ...doc, elf: { size: 60, originalSize: 60, strip: "none" } }, new Uint8Array(60)), CATALOG), /올바른 ELF가 아닙니다/);
  // A path in the example name is not fetched; unknown parts and bad lesson ids are dropped.
  const odd = await decodeShare(
    pack({
      ...doc,
      lesson: "<img src=x onerror=alert(1)>",
      project: { ...PROJECT, firmware: { name: "x", example: "../../secret.elf" }, parts: [...PROJECT.parts, { id: "evil", kind: "<script>", x: 0, y: 0, props: {} }] },
    }),
    CATALOG,
  );
  assert.equal(odd.loaded.firmware, undefined);
  assert.equal(odd.lesson, undefined);
  assert.equal(odd.loaded.project.parts.length, 3);
  assert.ok(odd.loaded.notes.some((n) => n.includes("예제 펌웨어")));
  assert.ok(odd.loaded.notes.some((n) => n.includes("실습 id")));
});

test("oversized links and zip bombs are refused before they are unpacked", async () => {
  await assert.rejects(decodeShare(`#s1=${"A".repeat(MAX_LINK_CHARS + 4)}`, CATALOG), /너무 깁니다/);
  // 64 MB of zeros packs into a link of about 87 000 characters.
  const zeros = new Uint8Array(64 * 1024 * 1024);
  const packed = new Uint8Array(await new Response(new Blob([zeros]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
  const bomb = new Uint8Array(1 + packed.length);
  bomb[0] = 1;
  bomb.set(packed, 1);
  const link = `#s1=${toBase64Url(bomb)}`;
  assert.ok(link.length < 200_000, `${link.length}`);
  const t0 = Date.now();
  await assert.rejects(decodeShare(link, CATALOG), /너무 큽니다/);
  assert.ok(Date.now() - t0 < 5000);
  // inflate itself stops at its cap.
  await assert.rejects(inflate(packed, 1024), /너무 큽니다/);
  assert.equal((await inflate(packed.subarray(0, packed.length), MAX_UNPACKED_BYTES * 8)).length, zeros.length);
});

test("a link is never made that its receiver would refuse as too big", async () => {
  // A 9 MB ELF (padded with zeros: it compresses to a short link) sent whole.
  const big = new Uint8Array(9 * 1024 * 1024);
  big.set(makeElf());
  const fw = { name: "big.elf", bytes: big };
  await assert.rejects(share({ firmware: fw, strip: "none" }), /너무 큽니다.*파일로 저장/);
  // Stripped it is a few KB, and opens.
  const ok = await share({ firmware: fw, strip: "debug" });
  assert.ok(ok.elfBytes < 4096, `${ok.elfBytes}`);
  const back = await decodeShare(`#${ok.fragment}`, CATALOG);
  assert.equal(back.elf?.size, ok.elfBytes);
});

test("an ELF whose headers point at the same bytes again and again is refused, not copied", async () => {
  // 1024 PT_LOAD headers over one 64 KB range: 64 MB if each were copied.
  const n = 1024;
  const dataAt = 52 + n * 32;
  const elf = new Uint8Array(dataAt + 65536);
  const v = new DataView(elf.buffer);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]);
  v.setUint16(16, 2, true);
  v.setUint16(18, 40, true);
  v.setUint32(28, 52, true);
  v.setUint16(42, 32, true);
  v.setUint16(44, n, true);
  for (let i = 0; i < n; i++) {
    const p = 52 + i * 32;
    [1, dataAt, 0x08000000, 0x08000000, 65536, 65536, 5, 4].forEach((x, k) => v.setUint32(p + k * 4, x, true));
  }
  assert.throws(() => readElf(elf), /겹쳐/);
  // Through a link: refused with that message before anything is shown.
  const enc = await share({ firmware: { name: "evil.elf", bytes: elf }, strip: "none" });
  await assert.rejects(decodeShare(`#${enc.fragment}`, CATALOG), /겹쳐/);
  // Symbol tables likewise: three SYMTAB sections over the 40 KB of debug bytes.
  const e2 = makeElf();
  const d2 = new DataView(e2.buffer);
  const shoff = d2.getUint32(32, true);
  const debugOff = d2.getUint32(shoff + 3 * 40 + 16, true);
  for (const i of [1, 2, 3]) {
    const s = shoff + i * 40;
    d2.setUint32(s + 4, 2, true); // SHT_SYMTAB
    d2.setUint32(s + 16, debugOff, true);
    d2.setUint32(s + 20, 40_000, true);
    d2.setUint32(s + 24, 5, true); // .strtab
    d2.setUint32(s + 36, 16, true);
  }
  assert.throws(() => readElf(e2), /겹쳐/);
  // The real layout is well within it.
  assert.equal(readElf(makeElf()).segments.length, 2);
});

test("links are found in pasted text: one, or many on lines", async () => {
  const a = (await share()).fragment;
  const b = (await share({ name: "다른" })).fragment;
  assert.equal(findFragment(`${PAGE}#${a}`), a);
  assert.equal(findFragment(a), a);
  assert.equal(findFragment(`${PAGE}#other`), null);
  assert.deepEqual(findFragments(`${PAGE}#${a}\n  ${PAGE}#${b}\r\nhello`), [a, b]);
});

// ------------------------------------------------------------ ELF

test("stripping keeps the load segments and the symbols the simulator reads", () => {
  const elf = makeElf();
  const info = readElf(elf);
  assert.equal(info.segments.length, 2);
  assert.deepEqual(
    info.segments.map((s) => [s.paddr, s.vaddr, s.data.length, s.memsz]),
    [[0x08000000, 0x08000000, 96, 96], [0x08000060, 0x20000000, 8, 32]],
  );
  assert.deepEqual(info.symbols.map((s) => s.name), ["static_fn", "main", "Error_Handler", "counter"]);
  assert.equal(stripElf(elf, "none"), elf);
  const debug = stripElf(elf, "debug");
  const all = stripElf(elf, "all");
  assert.ok(debug.length < 600 && all.length < 300, `${debug.length} ${all.length}`);
  const d = readElf(debug);
  assert.deepEqual(d.segments, info.segments);
  assert.deepEqual(d.symbols.map((s) => [s.name, s.value, s.size, s.info]).sort(), info.symbols.map((s) => [s.name, s.value, s.size, s.info]).sort());
  // Locals first, as ELF wants (sh_info: first global).
  const v = new DataView(debug.buffer);
  const shoff = v.getUint32(32, true);
  assert.equal(v.getUint16(48, true), 4);
  assert.equal(v.getUint32(shoff + 40 + 28, true), 2);
  // e_flags (hard-float ABI) kept; no section headers without symbols.
  assert.equal(v.getUint32(36, true), 0x05000400);
  assert.equal(new DataView(all.buffer).getUint16(48, true), 0);
  assert.deepEqual(readElf(all).segments, info.segments);
  assert.deepEqual(readElf(all).symbols, []);
  assert.throws(() => stripElf(new Uint8Array(100), "debug"), /ELF 파일이 아닙니다/);
  const x86 = elf.slice();
  x86[18] = 3;
  assert.throws(() => readElf(x86), /ARM/);
  const broken = elf.slice();
  new DataView(broken.buffer).setUint32(52 + 4, 0xfffffff0, true);
  assert.throws(() => readElf(broken), /파일 밖/);
});

test("a real example ELF shrinks to a few KB and loads the same (when built)", { skip: !existsSync("../firmware/hal-blinky/build/hal-blinky.elf") }, () => {
  const elf = new Uint8Array(readFileSync("../firmware/hal-blinky/build/hal-blinky.elf"));
  const s = stripElf(elf, "debug");
  assert.ok(elf.length > 200_000 && s.length < 32_000, `${elf.length} → ${s.length}`);
  assert.deepEqual(readElf(s).segments, readElf(elf).segments);
  assert.deepEqual(readElf(s).symbols.map((x) => x.name).sort(), readElf(elf).symbols.map((x) => x.name).sort());
  assert.ok(readElf(s).symbols.some((x) => x.name === "Error_Handler"));
});

// ------------------------------------------------------------ QR

// An independent decoder: it knows the layout from the standard, reads the
// format information, unmasks, collects the codewords, checks every
// Reed–Solomon block by its syndromes and parses the byte-mode segment.
const EXP: number[] = [];
const LOG: number[] = [];
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x = (x << 1) ^ (x & 0x80 ? 0x11d : 0);
}
const mul = (a: number, b: number) => (a && b ? EXP[(LOG[a] + LOG[b]) % 255] : 0);

/** Polynomial division remainder, data bits followed by the check bits. */
function bch(data: number, gen: number, deg: number): number {
  let v = data << deg;
  for (let i = 31; i >= deg; i--) if ((v >>> i) & 1) v ^= gen << (i - deg);
  return (data << deg) | v;
}

const MASKS: ((i: number, j: number) => boolean)[] = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (_, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i + j) % 2) + ((i * j) % 3)) % 2 === 0,
];
const LEVEL: Record<number, Ecc> = { 1: "L", 0: "M", 3: "Q", 2: "H" };

function decodeQr(m: boolean[][]): { bytes: Uint8Array; ecc: Ecc; mask: number; version: number } {
  const n = m.length;
  const version = (n - 17) / 4;
  assert.ok(Number.isInteger(version) && version >= 1 && version <= 40);
  const dark = (x: number, y: number) => m[y][x];
  // Finder patterns: 7×7 rings in three corners.
  for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) assert.equal(dark(cx + dx, cy + dy), Math.max(Math.abs(dx), Math.abs(dy)) !== 2);
  }
  for (let i = 8; i < n - 8; i++) assert.equal(dark(i, 6), i % 2 === 0, "timing");
  // Format information, both copies.
  let f1 = 0;
  let f2 = 0;
  const first = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  first.forEach(([x, y], i) => (f1 |= Number(dark(x, y)) << i));
  for (let i = 0; i < 8; i++) f2 |= Number(dark(n - 1 - i, 8)) << i;
  for (let i = 8; i < 15; i++) f2 |= Number(dark(8, n - 15 + i)) << i;
  assert.equal(f1, f2, "format copies");
  assert.ok(dark(8, n - 8), "dark module");
  const fmt = f1 ^ 0x5412;
  assert.equal(bch(fmt >>> 10, 0b10100110111, 10), fmt, "format BCH");
  const ecc = LEVEL[fmt >>> 13];
  const mask = (fmt >>> 10) & 7;
  if (version >= 7) {
    let v1 = 0;
    for (let i = 0; i < 18; i++) v1 |= Number(dark(n - 11 + (i % 3), Math.floor(i / 3))) << i;
    assert.equal(v1, bch(version, 0b1111100100101, 12), "version information");
  }
  // Which modules are data.
  const al = alignmentPositions(version);
  const isFn = (x: number, y: number) => {
    if ((x < 9 && y < 9) || (x >= n - 8 && y < 9) || (x < 9 && y >= n - 8) || x === 6 || y === 6) return true;
    if (version >= 7 && ((x >= n - 11 && x < n - 8 && y < 6) || (y >= n - 11 && y < n - 8 && x < 6))) return true;
    return al.some((ay) => al.some((ax) => !((ax === 6 && ay === 6) || (ax === 6 && ay === n - 7) || (ax === n - 7 && ay === 6)) && Math.abs(x - ax) <= 2 && Math.abs(y - ay) <= 2));
  };
  const bits: number[] = [];
  let up = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let k = 0; k < n; k++) {
      const y = up ? n - 1 - k : k;
      for (const x of [col, col - 1]) if (!isFn(x, y)) bits.push(Number(dark(x, y) !== MASKS[mask](y, x)));
    }
    up = !up;
  }
  assert.equal(bits.length, numRawDataModules(version));
  const codewords: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  // De-interleave: short blocks first, data then error correction.
  const e = { L: 0, M: 1, Q: 2, H: 3 }[ecc];
  const nb = NUM_ERROR_CORRECTION_BLOCKS[e][version];
  const ec = ECC_CODEWORDS_PER_BLOCK[e][version];
  const total = codewords.length;
  const long = total % nb;
  const shortData = Math.floor(total / nb) - ec;
  const blocks = Array.from({ length: nb }, (_, b) => ({ data: [] as number[], ecc: [] as number[], len: shortData + (b >= nb - long ? 1 : 0) }));
  let p = 0;
  for (let i = 0; i <= shortData; i++) for (const b of blocks) if (i < b.len) b.data.push(codewords[p++]);
  for (let i = 0; i < ec; i++) for (const b of blocks) b.ecc.push(codewords[p++]);
  assert.equal(p, total);
  for (const b of blocks) {
    const cw = [...b.data, ...b.ecc];
    for (let i = 0; i < ec; i++) {
      const a = EXP[i];
      let s = 0;
      for (const c of cw) s = mul(s, a) ^ c;
      assert.equal(s, 0, `syndrome ${i}`);
    }
  }
  const data = blocks.flatMap((b) => b.data);
  const dbits = data.flatMap((c) => [7, 6, 5, 4, 3, 2, 1, 0].map((i) => (c >>> i) & 1));
  const read = (at: number, len: number) => dbits.slice(at, at + len).reduce((a, b) => (a << 1) | b, 0);
  assert.equal(read(0, 4), 0b0100, "byte mode");
  const cb = version < 10 ? 8 : 16;
  const count = read(4, cb);
  const bytes = new Uint8Array(count);
  for (let i = 0; i < count; i++) bytes[i] = read(4 + cb + 8 * i, 8);
  return { bytes, ecc, mask, version };
}

test("QR constants agree with the standard", () => {
  // Format information table (ISO/IEC 18004, after the 0x5412 mask).
  assert.equal(formatBits("L", 0), 0b111011111000100);
  assert.equal(formatBits("M", 0), 0b101010000010010);
  assert.equal(formatBits("Q", 0), 0b011010101011111);
  assert.equal(formatBits("H", 0), 0b001011010001001);
  assert.equal(formatBits("M", 5), 0b100000011001110);
  for (const l of ["L", "M", "Q", "H"] as Ecc[]) for (let mk = 0; mk < 8; mk++) assert.equal(formatBits(l, mk) ^ 0x5412, bch(((({ L: 1, M: 0, Q: 3, H: 2 })[l] << 3) | mk), 0b10100110111, 10));
  // Version information of version 7 and 40.
  assert.equal(versionBits(7), 0x07c94);
  assert.equal(versionBits(40), 0x28c69);
  // Byte-mode capacities from the standard's table.
  const cap: [number, Ecc, number][] = [[1, "L", 17], [1, "M", 14], [1, "Q", 11], [1, "H", 7], [2, "M", 26], [7, "L", 154], [10, "M", 213], [20, "Q", 482], [20, "H", 382], [40, "L", 2953], [40, "M", 2331], [40, "H", 1273]];
  for (const [ver, l, n] of cap) assert.equal(byteCapacity(ver, l), n, `${ver}-${l}`);
  assert.equal(QR_MAX_BYTES, 2953);
  assert.deepEqual(alignmentPositions(2), [6, 18]);
  assert.deepEqual(alignmentPositions(7), [6, 22, 38]);
  assert.deepEqual(alignmentPositions(15), [6, 26, 48, 70]);
  assert.deepEqual(alignmentPositions(32), [6, 34, 60, 86, 112, 138]);
  assert.deepEqual(alignmentPositions(40), [6, 30, 58, 86, 114, 142, 170]);
});

test("QR codes decode back to their bytes, at every size and with every mask", async () => {
  const enc = new TextEncoder();
  const inputs = [
    "HELLO",
    "https://elecage.github.io/Simucleo/",
    `https://elecage.github.io/Simucleo/#${(await share({ firmware: { name: "hal-blinky", example: "hal-blinky.elf" } })).fragment}`,
    "가".repeat(100),
    "x".repeat(2331),
  ];
  for (const text of inputs) {
    const bytes = enc.encode(text);
    const qr = encodeQr(bytes, "M")!;
    assert.ok(qr, text.slice(0, 20));
    assert.equal(qr.ecc, "M");
    assert.equal(qr.size, 17 + 4 * qr.version);
    assert.ok(qr.version === 1 || bytes.length > byteCapacity(qr.version - 1, "M"), "smallest version");
    const d = decodeQr(qr.modules);
    assert.deepEqual(d.bytes, bytes);
    assert.equal(d.version, qr.version);
    assert.equal(d.mask, qr.mask);
  }
  for (let mask = 0; mask < 8; mask++) {
    for (const ecc of ["L", "M", "Q", "H"] as Ecc[]) {
      const bytes = enc.encode(`mask ${mask} level ${ecc} — 마스크`);
      const d = decodeQr(encodeQr(bytes, ecc, { minEcc: ecc, mask })!.modules);
      assert.deepEqual([d.bytes, d.mask, d.ecc], [bytes, mask, ecc]);
    }
  }
  // Version 7+ (version information) and 10+ (16-bit count) with several block sizes.
  for (const len of [150, 300, 1000, 1500]) {
    const bytes = new Uint8Array(len).map((_, i) => (i * 131 + 7) & 0xff);
    const qr = encodeQr(bytes, "Q")!;
    assert.deepEqual(decodeQr(qr.modules).bytes, bytes);
  }
});

test("QR falls back to level L for long links and gives up past 2953 bytes", () => {
  const long = new Uint8Array(2500).fill(65);
  const qr = encodeQr(long, "M")!;
  assert.equal(qr.ecc, "L");
  assert.ok(byteCapacity(qr.version - 1, "L") < 2500 && qr.version < 40);
  assert.deepEqual(decodeQr(qr.modules).bytes, long);
  assert.equal(encodeQr(new Uint8Array(2953).fill(65), "M")?.version, 40);
  assert.equal(encodeQr(new Uint8Array(2954).fill(65), "M"), null);
});
