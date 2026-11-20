// Unit tests of M26: the NEC (IR) decoder, its content condition, and the
// decoder parity fixture the Rust content trigger is checked against
// (`npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { annotationLabel, decodeNec, findMatches, necLast, type Annotation, type Line } from "../src/run/decode.ts";
import { contentMatch, DEFAULT_CONTENT, exactContent, newDecoder, sanitizeScope } from "../src/run/scopeSettings.ts";
import { parityJson } from "./parity.ts";

const M = 562_500;

/** The receiver's output (idle high, low during a burst) for a script of marks and spaces (ns). */
class Ir {
  edges: [number, boolean][] = [];
  t = 1e6;
  mark(ns: number) {
    this.edges.push([this.t, false], [this.t + ns, true]);
    this.t += ns;
    return this;
  }
  space(ns: number) {
    this.t += ns;
    return this;
  }
  /** A whole frame: leader, 32 bits LSB first, final mark. */
  frame(bytes: number[], o: { bitMark?: number; finalMark?: number } = {}) {
    this.mark(9e6).space(4.5e6);
    for (const b of bytes)
      for (let k = 0; k < 8; k++) {
        this.mark(o.bitMark ?? M);
        this.space((b >> k) & 1 ? 3 * M : M);
      }
    return this.mark(o.finalMark ?? M);
  }
  repeat() {
    return this.mark(9e6).space(2.25e6).mark(M);
  }
  line(): Line {
    return { level0: true, edges: this.edges };
  }
}

const nec = (addr: number, cmd: number) => [addr, ~addr & 0xff, cmd, ~cmd & 0xff];

test("NEC: leader, address, command and their inverses, LSB first", () => {
  const ir = new Ir().frame(nec(0x00, 0x1c));
  const anns = decodeNec(ir.line());
  assert.deepEqual(
    anns.map((a) => a.kind),
    ["leader", "data", "data", "data", "data"],
  );
  const lead = anns[0];
  assert.equal(lead.addr, 0x00);
  assert.equal(lead.value, 0x1c);
  assert.equal(lead.error, undefined);
  assert.equal(lead.start, 1e6);
  assert.equal(lead.end, 1e6 + 13.5e6);
  assert.equal(annotationLabel(lead, "hex"), "리더 · 주소 0x00 명령 0x1C");
  assert.deepEqual(
    anns.slice(1).map((a) => [a.value, a.note]),
    [
      [0x00, "주소"],
      [0xff, "주소 반전"],
      [0x1c, "명령"],
      [0xe3, "명령 반전"],
    ],
  );
  // Bytes span their 8 bits: 0x1C has three 1s (3 × 2.25 + 5 × 1.125 ms).
  assert.equal(anns[3].end - anns[3].start, 3 * 4 * M + 5 * 2 * M);
  assert.deepEqual(necLast(anns), { addr: 0, cmd: 0x1c });
});

test("NEC: a repeat code while the key is held, then a new frame", () => {
  const ir = new Ir().frame(nec(0x00, 0x45)).space(40e6).repeat().space(96e6).repeat().space(50e6).frame(nec(0x01, 0x46));
  const anns = decodeNec(ir.line());
  assert.deepEqual(
    anns.filter((a) => a.kind !== "data").map((a) => [a.kind, a.addr, a.value]),
    [
      ["leader", 0, 0x45],
      ["repeat", undefined, undefined],
      ["repeat", undefined, undefined],
      ["leader", 1, 0x46],
    ],
  );
  const rep = anns.find((a) => a.kind === "repeat")!;
  assert.equal(rep.end - rep.start, 9e6 + 2.25e6 + M);
  assert.equal(annotationLabel(rep, "hex"), "반복");
  assert.deepEqual(necLast(anns), { addr: 1, cmd: 0x46 });
});

test("NEC errors: a check byte that is not the inverse, a bad space, a cut frame, a bad leader", () => {
  const bad = decodeNec(new Ir().frame([0x00, 0xff, 0x1c, 0xe2]).line());
  assert.match(bad[0].error!, /명령 검사 실패/);
  assert.equal(bad[0].value, 0x1c);
  assert.match(decodeNec(new Ir().frame([0x07, 0xf7, 0x1c, 0xe3]).line())[0].error!, /주소 검사 실패/);

  // A 3 ms space after the 5th bit.
  const ir = new Ir().mark(9e6).space(4.5e6);
  for (let k = 0; k < 5; k++) ir.mark(M).space(M);
  ir.mark(M).space(3e6).mark(M);
  const sp = decodeNec(ir.line());
  assert.match(sp[0].error!, /비트 5: 공백 3000 µs/);
  assert.equal(sp[0].value, undefined);

  // A new leader before the 32nd bit.
  const cut = new Ir().mark(9e6).space(4.5e6);
  for (let k = 0; k < 12; k++) cut.mark(M).space(M);
  cut.frame(nec(0, 0x08));
  const c = decodeNec(cut.line());
  assert.equal(c[0].error, "프레임이 끝나지 않음 (12비트)");
  assert.equal(c.filter((a) => a.kind === "leader" && !a.error).length, 1);

  // A 3 ms space after the leader mark; a 1.2 ms bit mark.
  assert.match(decodeNec(new Ir().mark(9e6).space(3e6).mark(M).line())[0].error!, /리더 뒤 공백 3000 µs/);
  assert.match(decodeNec(new Ir().frame(nec(0, 1), { bitMark: 1.2e6 }).line())[0].error!, /마크 폭 1200 µs/);
  // A short burst alone is no frame.
  assert.deepEqual(decodeNec(new Ir().mark(M).space(M).mark(M).line()), []);
});

test("NEC: the frame counts only once its final mark has ended within tolerance", () => {
  const good = (o: { finalMark?: number }) => decodeNec(new Ir().frame(nec(0, 0x1c), o).space(40e6).line());
  const ok = good({});
  assert.equal(ok[0].error, undefined);
  assert.deepEqual(findMatches(ok, { kind: "nec", cmd: 0x1c }), [1e6]);
  // A 4 ms final mark: the bytes are shown, the frame is in error and does not match.
  const long = good({ finalMark: 4e6 });
  assert.equal(long[0].value, 0x1c);
  assert.equal(long[0].error, "마지막 마크 폭 4000 µs (0.56 ms가 아님)");
  assert.deepEqual(findMatches(long, { kind: "nec", cmd: 0x1c }), []);
  // A leader-long one cuts it short (and is the next leader).
  const cut = good({ finalMark: 9e6 });
  assert.equal(cut[0].error, "프레임이 끝나지 않음 (마지막 마크 9000 µs)");
  assert.deepEqual(findMatches(cut, { kind: "nec", cmd: 0x1c }), []);
  // A final mark not over when the span ends.
  const open = new Ir().frame(nec(0, 0x1c));
  open.edges.pop();
  const o = decodeNec(open.line());
  assert.equal(o[0].error, "프레임이 끝나지 않음 (마지막 마크)");
  assert.deepEqual(findMatches(o, { kind: "nec", cmd: 0x1c }), []);
});

test("NEC content condition: a command (and address), check bytes right", () => {
  const ir = new Ir().frame(nec(0, 0x1c)).space(40e6).frame(nec(1, 0x1c)).space(40e6).frame([0, 0xff, 0x1c, 0xe0]);
  const anns: Annotation[] = decodeNec(ir.line());
  const starts = anns.filter((a) => a.kind === "leader").map((a) => a.start);
  assert.deepEqual(findMatches(anns, { kind: "nec", cmd: 0x1c }), starts.slice(0, 2));
  assert.deepEqual(findMatches(anns, { kind: "nec", cmd: 0x1c, addr: 1 }), [starts[1]]);
  assert.deepEqual(findMatches(anns, { kind: "nec", cmd: 0x1d }), []);
  assert.deepEqual(findMatches(anns, { kind: "nec", cmd: 0x1c }, starts[0]), [starts[1]]);

  const c = { ...DEFAULT_CONTENT, kind: "nec" as const, text: "0x1C" };
  assert.deepEqual(contentMatch(c, "nec"), { kind: "nec", cmd: 0x1c });
  assert.deepEqual(contentMatch({ ...c, addr: "0" }, "nec"), { kind: "nec", cmd: 0x1c, addr: 0 });
  assert.equal(contentMatch({ ...c, addr: "x" }, "nec"), null);
  assert.equal(contentMatch({ ...c, text: "0x100" }, "nec"), null);
  // The default condition of a new NEC decoder is a command.
  assert.deepEqual(contentMatch({ ...DEFAULT_CONTENT }, "nec"), { kind: "nec", cmd: 0x41 });
  assert.deepEqual(newDecoder(3, "nec").pins, ["PB3"]);
});

test("the simulator's trigger takes every decoder's conditions", () => {
  for (const [type, m] of [
    ["uart", { kind: "text", text: "OK" }],
    ["uart", { kind: "byte", value: 0x41 }],
    ["i2c", { kind: "address", addr: 0x76, rw: "W" }],
    ["i2c", { kind: "byte", value: 0xd0 }],
    ["spi", { kind: "byte", value: 0x9f }],
    ["onewire", { kind: "byte", value: 0x44 }],
    ["tm1637", { kind: "byte", value: 0xc0 }],
    ["ws2812", { kind: "pixel", index: 3 }],
    ["nec", { kind: "nec", cmd: 0x1c }],
  ] as const)
    assert.equal(exactContent(type, m), true, `${type} ${m.kind}`);
  // A condition the decoder does not offer stays with the view.
  assert.equal(exactContent("spi", { kind: "text", text: "A" }), false);
});

test("project file: the NEC decoder and its condition are kept", () => {
  const s = sanitizeScope({
    pins: ["PB3"],
    decoders: [{ id: 1, type: "nec", pins: ["PB3"] }],
    trigger: { source: "dec:1", content: { kind: "nec", text: "0x45", addr: "0x00" } },
  })!;
  assert.equal(s.decoders[0].type, "nec");
  assert.deepEqual(s.trigger.content, { ...DEFAULT_CONTENT, kind: "nec", text: "0x45", addr: "0x00" });
  // Older files have no address: any.
  assert.equal(sanitizeScope({ trigger: { content: { kind: "byte" } } })!.trigger.content.addr, "");
});

test("decoder parity fixture: what the TypeScript decoders give now", () => {
  // The Rust content trigger is checked against this file
  // (crates/wasm/tests/decode_parity.rs); a decoder change here must
  // regenerate it (node scripts/decode-parity.ts) and keep that test passing.
  const file = readFileSync(new URL("../../crates/wasm/tests/fixtures/decode-parity.json", import.meta.url), "utf8");
  assert.ok(file === parityJson(), "decode-parity.json is stale: run `node scripts/decode-parity.ts` in web/");
  const cases = JSON.parse(file).cases as { name: string; items: unknown[]; matches: { starts: number[] }[] }[];
  assert.ok(cases.length >= 20);
  // The text condition stops at a frame in error (the M25 fix), here too.
  const u = cases.find((c) => c.name.startsWith("uart 8N1 115200"))!;
  assert.ok(u.items.some((i) => (i as unknown[])[8] === "other"));
});
