// Unit tests of M39: the zip reader, finding the ELF in a project folder,
// matching uploaded files to DWARF paths, and a real CubeIDE-like project
// (`firmware/cubeide-blinky`, built with Windows paths) end to end through
// the WASM core (`npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, listZip, MAX_UNPACKED, MAX_ZIP_ENTRIES, readZip, safePath, ZipError } from "../src/upload/zip.ts";
import { collect, decodeSource, elfRank, isElf, sortElfs, type PickedFile } from "../src/upload/folder.ts";
import { matchSources, segments, suffixLength } from "../src/upload/match.ts";
import { attachSources, elfKey, isAttached, MAX_STORED_SOURCES, summary } from "../src/upload/attach.ts";
import { writeZip } from "./zipwriter.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "../../firmware/cubeide-blinky/build/blinky");
const FIXTURE_ZIP = join(here, "../../firmware/cubeide-blinky/build/blinky.zip");
const WIN = "C:/Users/student/STM32CubeIDE/workspace_1.16.0/blinky";
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const rejects = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: Error) => e instanceof ZipError && re.test(e.message));

/** A minimal 32-bit ELF header (enough for the magic check). */
const fakeElf = (tag = 0) => {
  const b = new Uint8Array(64);
  b.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]);
  b[63] = tag;
  return b;
};

const picked = (path: string, data: Uint8Array | string, mtime = 0): PickedFile => {
  const b = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return { path, size: b.length, mtime, bytes: async () => b };
};

// ------------------------------------------------------------- zip reader

test("zip: stored and deflated entries, data descriptors, UTF-8 names, CRC-32", async () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  const big = "int main(void) { return 0; }\n".repeat(500);
  const zip = writeZip([
    { name: "p/Core/Src/main.c", data: big },
    { name: "p/Core/Inc/main.h", data: "#pragma once\n", method: 0 },
    { name: "p/Debug/p.elf", data: fakeElf(), descriptor: true },
    { name: "p/Core/Src/stream.c", data: big + "// x\n", descriptor: true, method: 8 },
    { name: "p/소스/메인 함수.c", data: "/* 한글 주석 */\n" },
    { name: "p/empty/", data: "", method: 0 },
  ]);
  const list = listZip(zip);
  assert.deepEqual(
    list.map((e) => e.path),
    ["p/Core/Src/main.c", "p/Core/Inc/main.h", "p/Debug/p.elf", "p/Core/Src/stream.c", "p/소스/메인 함수.c", "p/empty"],
  );
  assert.equal(list[0].mtime, Date.UTC(2024, 2, 1, 12, 0, 0));
  const files = await readZip(zip);
  assert.equal(files.length, 5); // the directory is not a file
  assert.equal(text(files[0].data), big);
  assert.equal(text(files[1].data), "#pragma once\n");
  assert.deepEqual(files[2].data, fakeElf());
  assert.equal(text(files[3].data), big + "// x\n");
  assert.equal(text(files[4].data), "/* 한글 주석 */\n");
  // Only the entries asked for are unpacked.
  assert.deepEqual((await readZip(zip, (e) => e.path.endsWith(".h"))).map((f) => f.path), ["p/Core/Inc/main.h"]);
});

test("zip: paths that leave the folder reject the whole zip", async () => {
  for (const name of ["../evil.c", "p/../../evil.c", "/etc/passwd", "C:/Windows/evil.c", "p\\..\\..\\evil.c"]) {
    const zip = writeZip([{ name: "p/ok.c", data: "ok" }, { name, data: "x" }]);
    assert.throws(() => listZip(zip), (e: Error) => e instanceof ZipError && /경로/.test(e.message), name);
  }
  assert.equal(safePath("p/./a//b.c"), "p/a/b.c");
  assert.equal(safePath("p\\Core\\main.c"), "p/Core/main.c");
});

test("zip: bombs, lies and damage are caught", async () => {
  // Declared sizes over the cap: refused before anything is unpacked.
  const huge = writeZip([{ name: "p/a.c", data: "x", claimSize: MAX_UNPACKED + 1 }]);
  await rejects(readZip(huge), /너무 큽니다/);
  // An entry that unpacks to more than it claims (a real bomb, 8 MB of zeros).
  const bomb = writeZip([{ name: "p/zero.c", data: new Uint8Array(8 << 20), claimSize: 1000 }]);
  assert.ok(bomb.length < 20_000);
  await rejects(readZip(bomb), /압축 폭탄/);
  // Several entries together over the cap.
  const many = writeZip([0, 1, 2].map((i) => ({ name: `p/${i}.c`, data: "x", claimSize: 30 << 20 })));
  await rejects(readZip(many), /너무 큽니다/);
  // Too many entries.
  const crowd = writeZip(Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({ name: `f${i}`, data: "", method: 0 as const })));
  assert.throws(() => listZip(crowd), /너무 많습니다/);
  // Bad CRC, a flipped byte in deflated data, a truncated zip, not a zip.
  await rejects(readZip(writeZip([{ name: "p/a.c", data: "hello", claimCrc: 1234 }])), /CRC/);
  const good = writeZip([{ name: "p/a.c", data: "hello world ".repeat(100) }]);
  const flipped = good.slice();
  flipped[40] ^= 0xff;
  await rejects(readZip(flipped), /손상/);
  assert.throws(() => listZip(good.subarray(0, good.length - 30)), ZipError);
  assert.throws(() => listZip(new TextEncoder().encode("not a zip at all, just some text")), /zip 파일이 아니거나/);
  // ZIP64 and encrypted entries are refused clearly.
  const z64 = writeZip([{ name: "p/a.c", data: "x", claimSize: 0xffffffff }]);
  assert.throws(() => listZip(z64), /ZIP64/);
  const enc = writeZip([{ name: "p/a.c", data: "x" }]);
  const v = new DataView(enc.buffer);
  const cd = v.getUint32(enc.length - 6, true);
  v.setUint16(cd + 8, v.getUint16(cd + 8, true) | 1, true);
  assert.throws(() => listZip(enc), /암호/);
});

test("zip: a zip written by Python's zipfile (the fixture) reads back", { skip: !existsSync(FIXTURE_ZIP) && "build firmware/cubeide-blinky" }, async () => {
  const zip = new Uint8Array(readFileSync(FIXTURE_ZIP));
  const files = await readZip(zip, (e) => /\.(c|h|s|elf)$/.test(e.path));
  const main = files.find((f) => f.path === "blinky/Core/Src/main.c")!;
  assert.equal(text(main.data), readFileSync(join(FIXTURE, "Core/Src/main.c"), "utf8"));
  const elf = files.find((f) => f.path === "blinky/Debug/blinky.elf")!;
  assert.deepEqual(elf.data, new Uint8Array(readFileSync(join(FIXTURE, "Debug/blinky.elf"))));
});

// ------------------------------------------------------------- the ELF

test("ELF picking: Debug/Release first, newest first, magic checked", async () => {
  assert.equal(elfRank("blinky/Debug/blinky.elf"), 0);
  assert.equal(elfRank("blinky/release/blinky.elf"), 0);
  assert.equal(elfRank("blinky/build/blinky.elf"), 1);
  assert.equal(elfRank("blinky/Debug/blinky.axf"), 2);
  const order = sortElfs([
    { path: "p/old/x.elf", mtime: 9 },
    { path: "p/Release/x.elf", mtime: 1 },
    { path: "p/Debug/x.elf", mtime: 5 },
    { path: "p/x.axf", mtime: 10 },
  ]).map((e) => e.path);
  assert.deepEqual(order, ["p/Debug/x.elf", "p/Release/x.elf", "p/old/x.elf", "p/x.axf"]);

  const got = await collect([
    picked("p/Release/p.elf", fakeElf(1), 100),
    picked("p/Debug/p.elf", fakeElf(2), 200),
    picked("p/Debug/p.out", "not an elf, a log file"),
    picked("p/keil/p.axf", fakeElf(3), 300),
    picked("p/Debug/p.map", "Memory map"),
    picked("p/Debug/main.o", fakeElf(4)),
    picked("p/Core/Src/main.c", "int main;\n"),
    picked("p/Core/Src/blob.c", new Uint8Array([1, 0, 2])),
  ]);
  assert.deepEqual(got.elfs.map((e) => e.path), ["p/Debug/p.elf", "p/Release/p.elf", "p/keil/p.axf"]);
  assert.deepEqual(got.sources.map((s) => s.path), ["p/Core/Src/main.c"]);
  assert.equal(got.skipped, 4); // .out without magic, .map, .o, binary .c
  assert.ok(isElf(fakeElf()) && !isElf(new TextEncoder().encode("\x7fELX".padEnd(64))));
  // EUC-KR (older editors on Korean Windows) still reads as text.
  assert.equal(decodeSource(new Uint8Array([0x2f, 0x2f, 0xc7, 0xd1, 0xb1, 0xdb])), "//한글");
});

test("collect: zips inside the picked files, irrelevant big entries not unpacked", async () => {
  const zip = writeZip([
    { name: "p/Debug/p.elf", data: fakeElf() },
    { name: "p/Core/Src/main.c", data: "int main;\n" },
    // A huge object file the zip claims: never unpacked, so no cap hit.
    { name: "p/Debug/huge.o", data: "x", claimSize: MAX_UNPACKED * 2 },
  ]);
  const got = await collect([picked("p.zip", zip)]);
  assert.deepEqual(got.elfs.map((e) => e.path), ["p/Debug/p.elf"]);
  assert.deepEqual(got.sources, [{ path: "p/Core/Src/main.c", text: "int main;\n" }]);
  await assert.rejects(collect([picked("p.zip", writeZip([{ name: "../x.c", data: "x" }]))]), /폴더 밖/);
  await assert.rejects(collect([picked("p.zip", new TextEncoder().encode("hello"))]), /zip 파일이 아닙니다/);
});

// ------------------------------------------------------------- matching

test("matching: Windows and POSIX build paths, ../, case, longest suffix, ties", () => {
  assert.deepEqual(segments("C:\\Users\\Kim\\ws\\..\\b\\.\\Main.C"), ["c:", "users", "kim", "ws", "b", "main.c"]);
  assert.equal(suffixLength(segments("/a/b/Core/Src/main.c"), segments("x/core/src/MAIN.c")), 3);
  const dwarf = [
    "C:/Users/kim/STM32CubeIDE/workspace_1.16.0/blinky/Core/Src/main.c",
    "C:/Users/kim/STM32CubeIDE/workspace_1.16.0/blinky/Core/Inc/main.h",
    "/home/lee/proj/blinky/Core/Src/stm32f4xx_it.c",
    "../Core/Src/syscalls.c",
    "C:/ST/STM32CubeIDE_1.16.0/plugins/tools/arm-none-eabi/include/stdint.h",
    "C:/Users/kim/STM32CubeIDE/workspace_1.16.0/blinky/Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_gpio.c",
    "C:/Users/kim/ws/blinky/Core/Src/util.c",
  ];
  const files = [
    "blinky/Core/Src/main.c",
    "blinky/Backup/Core/Src/main.c", // shorter suffix: loses
    "blinky/core/inc/MAIN.H", // case differs
    "blinky/Core/Src/stm32f4xx_it.c",
    "blinky/Core/Src/syscalls.c",
    "blinky/a/util.c", // the same suffix (just the name) twice: a tie
    "blinky/b/util.c",
    "blinky/README.md",
  ];
  const m = matchSources(dwarf, files);
  assert.equal(m.matched[dwarf[0]], "blinky/Core/Src/main.c");
  assert.equal(m.matched[dwarf[1]], "blinky/core/inc/MAIN.H");
  assert.equal(m.matched[dwarf[2]], "blinky/Core/Src/stm32f4xx_it.c");
  assert.equal(m.matched[dwarf[3]], "blinky/Core/Src/syscalls.c");
  assert.equal(m.matched[dwarf[6]], "blinky/a/util.c");
  assert.deepEqual(m.missing, [dwarf[4], dwarf[5]]);
  assert.deepEqual(m.ties, [{ dwarf: dwarf[6], candidates: ["blinky/a/util.c", "blinky/b/util.c"] }]);
  // One file serves one DWARF path: the one it shares more with.
  const two = matchSources(["/x/app/main.c", "/x/boot/main.c"], ["proj/boot/main.c"]);
  assert.deepEqual(two.matched, { "/x/boot/main.c": "proj/boot/main.c" });
  assert.deepEqual(two.missing, ["/x/app/main.c"]);
  // Names must match: nothing for a file of another name.
  assert.deepEqual(matchSources(["/x/main.c"], ["main.cpp", "xmain.c"]).missing, ["/x/main.c"]);
});

test("attach: summary, stored size cap, shape check", () => {
  const a = attachSources("k", [`${WIN}/Core/Src/main.c`, `${WIN}/Drivers/STM32F4xx_HAL_Driver/Src/hal.c`, `${WIN}/Core/Src/x.c`], [
    { path: "blinky/Core/Src/main.c", text: "int main;" },
  ]);
  assert.equal(summary(a), "소스 1개 연결 · DWARF에 있지만 없는 파일 2개(HAL 드라이버 등)");
  assert.ok(a.stored && isAttached(a));
  assert.ok(!isAttached({ ...a, files: { x: { from: 1 } } }) && !isAttached(null) && !isAttached("x"));
  const big = attachSources("k", ["/p/big.c"], [{ path: "big.c", text: "x".repeat(MAX_STORED_SOURCES + 1) }]);
  assert.equal(big.stored, false);
  assert.notEqual(elfKey(fakeElf(1)), elfKey(fakeElf(2)));
});

// ------------------------------------------------- the CubeIDE-like project

const WASM = join(here, "../src/wasm/pkg/simucleo_wasm_bg.wasm");

/** Every file under `dir`, as the folder picker gives them (`blinky/...`). */
function walk(dir: string, root = dirname(dir)): PickedFile[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return walk(p, root);
    const b = new Uint8Array(readFileSync(p));
    return [{ path: relative(root, p).split("\\").join("/"), size: b.length, mtime: statSync(p).mtimeMs, bytes: async () => b }];
  });
}

test(
  "a CubeIDE project folder built on Windows: ELF found, sources matched by DWARF path",
  { skip: (!existsSync(FIXTURE) && "build firmware/cubeide-blinky") || (!existsSync(WASM) && "run npm run wasm") },
  async () => {
    const { initSync, Simulator } = await import("../src/wasm/pkg/simucleo_wasm.js");
    initSync({ module: readFileSync(WASM) });
    const got = await collect(walk(FIXTURE));
    assert.deepEqual(got.elfs.map((e) => e.path), ["blinky/Debug/blinky.elf"]);
    const sim = new Simulator();
    sim.loadElf(got.elfs[0].bytes);
    const dwarf = (JSON.parse(sim.debugFiles()) as { path: string }[]).map((f) => f.path);
    assert.ok(dwarf.includes(`${WIN}/Core/Src/main.c`), dwarf.join("\n"));
    const a = attachSources(elfKey(got.elfs[0].bytes), dwarf, got.sources);
    assert.equal(a.files[`${WIN}/Core/Src/main.c`].from, "blinky/Core/Src/main.c"); // not Backup/
    assert.equal(a.files[`${WIN}/Core/Src/main.c`].text, readFileSync(join(FIXTURE, "Core/Src/main.c"), "utf8"));
    assert.equal(
      a.files[`${WIN}/Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_gpio.c`].from,
      "blinky/Drivers/STM32F4xx_HAL_Driver/Src/stm32f4xx_hal_gpio.c",
    );
    // Every DWARF file with code that is in the folder is matched; the
    // rest are the toolchain's own (newlib, libgcc), outside the project.
    assert.deepEqual(a.missing, []);
    assert.ok(a.outside.length > 0 && a.outside.every((d) => !d.startsWith(WIN) && /newlib|libgcc/.test(d)), a.outside.join("\n"));
    assert.equal(summary(a), `소스 ${Object.keys(a.files).length}개 연결`);
    assert.deepEqual(a.ties, []);
    assert.ok(Object.keys(a.files).length >= 12, summary(a));

    // Without the HAL drivers: they are reported missing.
    const noDrivers = got.sources.filter((s) => !s.path.includes("/Drivers/"));
    const b = attachSources("k", dwarf, noDrivers);
    assert.ok(b.missing.some((d) => d.endsWith("stm32f4xx_hal_gpio.c")));
    assert.ok(b.missing.every((d) => d.startsWith(`${WIN}/Drivers/`)), b.missing.join("\n"));
    assert.match(summary(b), /^소스 \d+개 연결 · DWARF에 있지만 없는 파일 \d+개\(HAL 드라이버 등\)$/);
  },
);
