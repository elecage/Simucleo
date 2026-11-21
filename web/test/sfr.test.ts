// The SFR view's data and arithmetic (src/run/sfr.ts) over the generated
// description (public/sfr/STM32F401.json, tools/svdjson.py).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bitRange,
  enumName,
  fieldMask,
  fieldValue,
  fieldWrite,
  filterSfr,
  findReg,
  loadPinned,
  parseSvdJson,
  parseValue,
  savePinned,
  withField,
  type SfrField,
  type SvdJson,
} from "../src/run/sfr.ts";

const here = dirname(fileURLToPath(import.meta.url));
const list = parseSvdJson(JSON.parse(readFileSync(join(here, "../public/sfr/STM32F401.json"), "utf8")) as SvdJson);

const reg = (key: string) => {
  const r = findReg(list, key);
  assert.ok(r, key);
  return r.r;
};
const field = (key: string): SfrField => {
  const [p, r, f] = key.split(".");
  const x = reg(`${p}.${r}`).fields.find((y) => y.name === f);
  assert.ok(x, key);
  return x;
};

test("the description: every peripheral, derived ones with their source's registers, absolute addresses", () => {
  assert.equal(list.length, 46);
  const names = list.map((p) => p.name);
  for (const n of ["GPIOA", "GPIOH", "RCC", "TIM2", "USART2", "ADC_Common", "SPI2", "EXTI", "DBG"]) assert.ok(names.includes(n), n);
  assert.deepEqual([...list].sort((a, b) => a.base - b.base), list, "sorted by base");
  const odr = reg("GPIOA.ODR");
  assert.equal(odr.addr, 0x4002_0014);
  assert.equal(odr.access, "rw");
  assert.deepEqual([field("GPIOA.ODR.ODR5").lsb, field("GPIOA.ODR.ODR5").width], [5, 1]);
  // TIM4 derives from TIM3, USART6 from USART1: same registers, own base.
  const tim3 = list.find((p) => p.name === "TIM3")!;
  const tim4 = list.find((p) => p.name === "TIM4")!;
  assert.deepEqual(tim4.registers.map((r) => r.name), tim3.registers.map((r) => r.name));
  assert.equal(reg("TIM4.CNT").addr, 0x4000_0824);
  assert.equal(reg("USART6.BRR").addr, 0x4001_1408);
  assert.ok(list.find((p) => p.name === "USART6")!.desc);
  assert.deepEqual(list.find((p) => p.name === "USART2")!.interrupts, [["USART2", 38]]);
  assert.equal(reg("RCC.CR").reset, 0x83);
  assert.equal(reg("TIM2.EGR").access, "w");
  assert.match(reg("USART2.SR").desc, /status/i);
  assert.match(field("USART2.SR.RXNE").desc, /not empty/i);
  // Write effects and enumerated values from the generator's tables.
  assert.equal(field("TIM2.SR.UIF").effect, "w0c");
  assert.equal(field("EXTI.PR.PR3").effect, "w1c");
  assert.equal(field("RCC.CSR.RMVF").effect, "w1c");
  assert.equal(field("USART2.SR.TXE").effect, undefined);
  assert.equal(enumName(field("GPIOA.MODER.MODER5"), 1), "Output");
  assert.equal(enumName(field("GPIOA.ODR.ODR5"), 1), null);
});

test("field decode and encode, 1 to 32 bits", () => {
  const f5 = { lsb: 5, width: 1 };
  const byte = { lsb: 8, width: 8 };
  const all = { lsb: 0, width: 32 };
  assert.equal(fieldMask(f5), 0x20);
  assert.equal(fieldMask(byte), 0xff00);
  assert.equal(fieldMask(all), 0xffffffff);
  assert.equal(fieldMask({ lsb: 31, width: 1 }), 0x8000_0000);
  assert.equal(fieldValue(0xdead_beef, byte), 0xbe);
  assert.equal(fieldValue(0xdead_beef, all), 0xdead_beef);
  assert.equal(fieldValue(0x8000_0000, { lsb: 31, width: 1 }), 1);
  assert.equal(withField(0x1234_5678, byte, 0xab), 0x1234_ab78);
  assert.equal(withField(0, byte, 0x1ff), 0xff00, "excess bits dropped");
  assert.equal(withField(0, { lsb: 31, width: 1 }, 1), 0x8000_0000);
  assert.equal(withField(5, all, 0xffff_fffe), 0xffff_fffe);
  assert.equal(bitRange(f5), "[5]");
  assert.equal(bitRange(byte), "[15:8]");
});

test("read-modify-write of one field: plain fields keep their value", () => {
  assert.equal(fieldWrite(reg("GPIOA.ODR"), 0x20, field("GPIOA.ODR.ODR3"), 1, true), 0x28);
  assert.equal(fieldWrite(reg("GPIOA.ODR"), 0x28, field("GPIOA.ODR.ODR5"), 0, true), 0x08);
  const moder = reg("GPIOA.MODER");
  assert.equal(fieldWrite(moder, 0xa800_0400, field("GPIOA.MODER.MODER5"), 2, true), 0xa800_0800);
  // A write-only register starts from 0 (whatever was read).
  assert.equal(fieldWrite(reg("TIM2.EGR"), 0xffff, field("TIM2.EGR.UG"), 1, true), 1);
});

test("read-modify-write: W1C flags of other fields are written 0, not back as read", () => {
  // EXTI_PR: lines 0 and 2 pending; clearing line 0 must not clear line 2.
  assert.equal(fieldWrite(reg("EXTI.PR"), 0b101, field("EXTI.PR.PR0"), 1, true), 0b001);
  // RCC_CSR: LSION on, with reset flags set and RMVF: RMVF is not written back.
  const csr = reg("RCC.CSR");
  const cur = 0x0c00_0000 | (1 << 24);
  assert.equal(fieldWrite(csr, cur, field("RCC.CSR.LSION"), 1, true), 0x0c00_0001);
  // FLASH_SR: clear EOP only, though PGSERR is set too.
  assert.equal(fieldWrite(reg("FLASH.SR"), 0x81, field("FLASH.SR.EOP"), 1, true), 0x01);
});

test("read-modify-write: rc_w0 flags of other fields are written 1 where modelled", () => {
  const sr = reg("TIM2.SR");
  const uif = field("TIM2.SR.UIF");
  const cc1if = field("TIM2.SR.CC1IF");
  const allFlags = sr.fields.reduce((m, f) => m | fieldMask(f), 0) >>> 0;
  // Clear CC1IF: UIF (set or not) and the other flags get 1, which changes nothing.
  assert.equal(fieldWrite(sr, 0b11, cc1if, 0, true), (allFlags & ~fieldMask(cc1if)) >>> 0);
  assert.equal(fieldWrite(sr, 0, uif, 0, true), (allFlags & ~1) >>> 0);
  // Register-file peripheral: what it stores is written back.
  assert.equal(fieldWrite(sr, 0b11, cc1if, 0, false), 0b01);
  // USART_SR: only CTS, LBD, TC, RXNE are rc_w0; clearing TC leaves RXNE alone.
  const usr = reg("USART2.SR");
  const w = fieldWrite(usr, 0xc0, field("USART2.SR.TC"), 0, true);
  assert.equal(w & 0x40, 0, "TC written 0");
  assert.equal(w & 0x20, 0x20, "RXNE written 1: unchanged");
  assert.equal(w & 0x80, 0x80, "TXE (read-only) as read");
});

test("values typed in: hex, binary, decimal", () => {
  assert.equal(parseValue("0x1F"), 31);
  assert.equal(parseValue("0b101"), 5);
  assert.equal(parseValue("42"), 42);
  assert.equal(parseValue("ff", true), 255);
  assert.equal(parseValue("ff"), null);
  assert.equal(parseValue("0xFFFFFFFF"), 0xffffffff);
  assert.equal(parseValue("0x100000000"), null);
  assert.equal(parseValue("0x0000_8000"), 0x8000);
  assert.equal(parseValue("-1"), null);
  assert.equal(parseValue(""), null);
});

test("search by peripheral, register, field, and PERIPH.REG", () => {
  assert.deepEqual(filterSfr(list, "").length, list.length);
  const u2 = filterSfr(list, "usart2");
  // USART2 itself, and RCC for its fields USART2EN and USART2LPEN.
  assert.deepEqual(u2.map((h) => h.p.name), ["USART2", "RCC"]);
  assert.equal(u2[0].registers.length, u2[0].p.registers.length);
  assert.equal(u2[0].open, false);
  assert.ok(u2[1].open && u2[1].openRegs.has("APB1ENR") && u2[1].openRegs.has("APB1LPENR"));
  const cnt = filterSfr(list, "TIM2.CNT");
  assert.deepEqual(cnt.map((h) => [h.p.name, h.registers.map((r) => r.name)]), [["TIM2", ["CNT"]]]);
  assert.ok(cnt[0].open);
  const rxne = filterSfr(list, "RXNE");
  assert.ok(rxne.some((h) => h.p.name === "USART2" && h.registers.some((r) => r.name === "SR") && h.openRegs.has("SR")));
  assert.ok(rxne.every((h) => h.open));
  assert.deepEqual(filterSfr(list, "USART2.SR.RXNE").map((h) => [...h.openRegs]), [["SR"]]);
  assert.deepEqual(filterSfr(list, "nothing-like-this"), []);
});

test("watched registers are kept in storage, which may fail", () => {
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  assert.deepEqual(loadPinned(storage), []);
  savePinned(["GPIOA.ODR", "TIM2.CNT"], storage);
  assert.deepEqual(loadPinned(storage), ["GPIOA.ODR", "TIM2.CNT"]);
  mem.set("simucleo.sfr.pinned", "{not json");
  assert.deepEqual(loadPinned(storage), []);
  const broken = {
    getItem: () => {
      throw new Error("denied");
    },
    setItem: () => {
      throw new Error("denied");
    },
  };
  assert.deepEqual(loadPinned(broken), []);
  savePinned(["X.Y"], broken); // no throw
  assert.deepEqual(loadPinned(undefined), []);
});
