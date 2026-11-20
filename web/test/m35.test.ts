// M35: the CAN decoder (decodeCan) on frames built bit by bit, its labels
// and content matches, and the CAN settings of the waveform view.
import { test } from "node:test";
import assert from "node:assert/strict";
import { annotationLabel, decodeCan, findMatches, isSyncPoint, scanStep, type Line } from "../src/run/decode.ts";
import { contentMatch, DEFAULT_CONTENT, newDecoder, sanitizeScope } from "../src/run/scopeSettings.ts";
import { parseCanStatus } from "../src/parts/canStatus.ts";
import { canFrameBits, type CanFrameSpec } from "./parity.ts";

const BIT = 8000; // 125 kbit/s

/** Frames on a line: each acknowledged unless `nack`, 10 idle bits between. */
function bus(frames: (CanFrameSpec & { nack?: boolean })[], bit = BIT): Line {
  const edges: [number, boolean][] = [];
  let level = true;
  let t = 50 * bit;
  for (const f of frames) {
    const { bits, ack } = canFrameBits(f);
    if (!f.nack) bits[ack] = false;
    for (const b of bits) {
      if (b !== level) edges.push([t, b]);
      level = b;
      t += bit;
    }
    t += 10 * bit;
  }
  return { level0: true, edges };
}

test("CAN: a standard data frame decodes field by field", () => {
  const anns = decodeCan(bus([{ id: 0x123, data: [0xca, 0xfe] }]), { bitrate: 125000 });
  assert.deepEqual(
    anns.map((a) => [a.kind, a.value ?? null, a.error ?? null]),
    [
      ["sof", null, null],
      ["address", 0x123, null],
      ["dlc", 2, null],
      ["data", 0xca, null],
      ["data", 0xfe, null],
      ["crc", anns[5].value, null],
      ["ack", null, null],
      ["eof", null, null],
    ],
  );
  // SOF at the first falling edge, each field after the last.
  assert.equal(anns[0].start, 50 * BIT);
  assert.equal(anns[1].start, 51 * BIT);
  for (let i = 1; i < anns.length; i++) assert.ok(anns[i].start >= anns[i - 1].end - 1e-6);
  assert.equal(annotationLabel(anns[1], "hex"), "ID 0x123");
  assert.equal(annotationLabel(anns[2], "hex"), "DLC 2");
  assert.equal(annotationLabel(anns[6], "hex"), "ACK");
  assert.ok(isSyncPoint(anns[0], "can"));
  assert.ok(!isSyncPoint(anns[1], "can"));
});

test("CAN: extended and remote frames, NACK, bad CRC and a stuff error", () => {
  const line = bus([
    { id: 0x1abcde01, ext: true, data: [0x55] },
    { id: 0x7ff, rtr: true, dlc: 4 },
    { id: 0x100, data: [1], nack: true },
    { id: 0x100, data: [2], badCrc: true },
  ]);
  const anns = decodeCan(line, { bitrate: 125000 });
  const ids = anns.filter((a) => a.kind === "address");
  assert.deepEqual(
    ids.map((a) => [a.addr, a.rw, a.note ?? ""]),
    [
      [0x1abcde01, "W", "EXT"],
      [0x7ff, "R", ""],
      [0x100, "W", ""],
      [0x100, "W", ""],
    ],
  );
  assert.equal(annotationLabel(ids[0], "hex"), "ID 0x1ABCDE01 EXT");
  assert.equal(annotationLabel(ids[1], "hex"), "ID 0x7FF RTR");
  // The remote frame has its DLC but no data.
  const dlc = anns.filter((a) => a.kind === "dlc");
  assert.equal(dlc[1].value, 4);
  assert.equal(anns.filter((a) => a.kind === "data").length, 3);
  const acks = anns.filter((a) => a.kind === "ack");
  assert.deepEqual(
    acks.map((a) => a.ack),
    [true, true, false, true],
  );
  assert.equal(acks[2].error, "NACK");
  assert.ok(anns.filter((a) => a.kind === "crc")[3].error);
  assert.equal(anns.filter((a) => a.kind === "eof").length, 4);

  // Six dominant bits inside a frame: a stuff error, then back to idle.
  const { bits } = canFrameBits({ id: 0x555, data: [0xaa] });
  const cut = [...bits.slice(0, 8), false, false, false, false, false, false, ...Array(11).fill(true)];
  const edges: [number, boolean][] = [];
  let level = true;
  cut.forEach((b, k) => {
    if (b !== level) edges.push([1e6 + k * BIT, b]);
    level = b;
  });
  const next = bus([{ id: 0x42, data: [7] }]);
  const both: Line = { level0: true, edges: [...edges, ...next.edges.map(([t, l]) => [t + 2e6, l] as [number, boolean])] };
  const a2 = decodeCan(both, { bitrate: 125000 });
  const err = a2.find((a) => a.kind === "error");
  assert.ok(err?.error);
  assert.deepEqual(
    a2.filter((a) => a.kind === "address").map((a) => a.addr),
    [0x42],
  );
});

test("CAN: bit times a few percent off still decode; the wrong bit rate does not", () => {
  const line = bus([{ id: 0x321, data: [1, 2, 3] }], BIT * 1.03);
  assert.deepEqual(
    decodeCan(line, { bitrate: 125000 })
      .filter((a) => a.kind === "data")
      .map((a) => a.value),
    [1, 2, 3],
  );
  const wrong = decodeCan(line, { bitrate: 250000 });
  assert.ok(!wrong.some((a) => a.kind === "eof" && !a.error) || wrong.some((a) => a.error));
});

test("CAN: content matches on an ID (R = remote frame) and on data bytes", () => {
  const anns = decodeCan(bus([{ id: 0x123, data: [0x55] }, { id: 0x123, rtr: true }, { id: 0x1abcde01, ext: true, data: [] }]), {
    bitrate: 125000,
  });
  const idStart = anns.filter((a) => a.kind === "address").map((a) => a.start);
  assert.deepEqual(findMatches(anns, { kind: "address", addr: 0x123, rw: "W" }), [idStart[0]]);
  assert.deepEqual(findMatches(anns, { kind: "address", addr: 0x123, rw: "R" }), [idStart[1]]);
  assert.deepEqual(findMatches(anns, { kind: "address", addr: 0x1abcde01, rw: "any" }), [idStart[2]]);
  assert.equal(findMatches(anns, { kind: "byte", value: 0x55 }).length, 1);
  // A 29-bit ID parses for CAN, not for I2C.
  const c = { ...DEFAULT_CONTENT, kind: "address" as const, text: "0x1ABCDE01" };
  assert.deepEqual(contentMatch(c, "can"), { kind: "address", addr: 0x1abcde01, rw: "any" });
  assert.equal(contentMatch(c, "i2c"), null);
  // The live scan anchors on a SOF.
  const { hits } = scanStep((f, to) => decodeCan(bus([{ id: 0x123, data: [0x55] }]), { bitrate: 125000 }, to), "can", { kind: "byte", value: 0x55 }, { checked: -Infinity, anchor: 0 }, 1e9, 1e9);
  assert.equal(hits.length, 1);
});

test("CAN: settings keep part pins and the bit rate", () => {
  assert.equal(newDecoder(1, "can").baud, 125000);
  assert.deepEqual(newDecoder(1, "can").pins, ["can1.CANH"]);
  const s = sanitizeScope({
    pins: ["PA5", "can1.CANH", "can2.CANL", "can1.VCC", "x.y.CANH"],
    decoders: [{ id: 1, type: "can", pins: ["can2.CANL"], baud: 500000 }, { id: 2, type: "can", pins: ["PA9"] }],
  })!;
  assert.deepEqual(s.pins, ["PA5", "can1.CANH", "can2.CANL"]);
  assert.deepEqual(
    s.decoders.map((d) => [d.pins, d.baud]),
    [
      [["can2.CANL"], 500000],
      [["PA9"], 125000],
    ],
  );
});

test("CAN module: the simulator's status text", () => {
  assert.deepEqual(parseCanStatus("normal 125 kbit/s error-passive TEC 128 REC 0 TX 3 RX 2"), {
    mode: "normal",
    rate: "125 kbit/s",
    state: "error-passive",
    tec: 128,
    rec: 0,
    tx: 3,
    rx: 2,
  });
  assert.equal(parseCanStatus(undefined), null);
});
