// The XMODEM sender (src/run/xmodem.ts) against a receiver model: a
// bootloader-like XMODEM-CRC / checksum receiver on a serial line with the
// time each byte takes, on simulated time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ACK, CAN, checksum, crc16, EOT, NAK, PAD, SOH, XmodemSender, type XmodemOptions } from "../src/run/xmodem.ts";

const BYTE_S = 10 / 115200;

interface ReceiverOptions {
  checksumMode?: boolean;
  /** Packets (counted from 0, every packet that arrives) to damage on the line. */
  corrupt?: Set<number>;
  /** ACKs (counted from 0) lost on the line: the sender times out. */
  loseAck?: Set<number>;
  /** NAK the first EOT (some receivers do, to be sure). */
  nakFirstEot?: boolean;
  /** Cancel (CAN CAN) after this many good blocks. */
  cancelAfter?: number;
  /** Never answer: no 'C'. */
  silent?: boolean;
  /** Answer every packet with NAK. */
  alwaysNak?: boolean;
  /** Text the receiver prints before its first 'C'. */
  banner?: string;
}

/** A receiver: answers what it gets, sends 'C'/NAK every second until the first block. */
class Receiver {
  file: number[] = [];
  expected = 1;
  started = false;
  done = false;
  cancelled = false;
  packets = 0;
  acks = 0;
  eots = 0;
  naks = 0;
  private buf: number[] = [];
  private lastPoke = -Infinity;
  private bannerSent = false;
  private o: ReceiverOptions;
  constructor(o: ReceiverOptions = {}) {
    this.o = o;
  }

  private ack(out: number[]) {
    const n = this.acks++;
    if (!this.o.loseAck?.has(n)) out.push(ACK);
  }

  /** Bytes arrived; returns the answer. */
  receive(now: number, bytes: number[]): number[] {
    const out: number[] = [];
    if (!this.bannerSent && this.o.banner) {
      this.bannerSent = true;
      out.push(...new TextEncoder().encode(this.o.banner));
    }
    if (this.done || this.o.silent) return out;
    if (!this.started && now - this.lastPoke >= 1) {
      this.lastPoke = now;
      out.push(this.o.checksumMode ? NAK : 0x43);
    }
    this.buf.push(...bytes);
    const len = 3 + 128 + (this.o.checksumMode ? 1 : 2);
    while (this.buf.length) {
      if (this.buf[0] === EOT) {
        this.buf.shift();
        if (this.o.nakFirstEot && this.eots++ === 0) out.push(NAK);
        else {
          out.push(ACK);
          this.done = true;
        }
        continue;
      }
      if (this.buf[0] === CAN) {
        this.buf.shift();
        this.cancelled = true;
        this.done = true;
        continue;
      }
      if (this.buf[0] !== SOH) {
        this.buf.shift(); // noise
        continue;
      }
      if (this.buf.length < len) break;
      const p = Uint8Array.from(this.buf.splice(0, len));
      const k = this.packets++;
      if (this.o.corrupt?.has(k)) p[3 + (k % 128)] ^= 0x55;
      this.started = true;
      const good =
        p[1] === (~p[2] & 0xff) &&
        (this.o.checksumMode
          ? checksum(p, 3, 131) === p[131]
          : crc16(p, 3, 131) === ((p[131] << 8) | p[132]));
      if (!good || this.o.alwaysNak) {
        this.naks++;
        out.push(NAK);
        continue;
      }
      if (p[1] === ((this.expected - 1) & 0xff)) {
        // The previous block again (its ACK was lost): ACK, do not keep.
        this.ack(out);
        continue;
      }
      if (p[1] !== (this.expected & 0xff)) {
        out.push(CAN, CAN);
        this.done = true;
        continue;
      }
      this.file.push(...p.subarray(3, 131));
      this.expected++;
      if (this.o.cancelAfter !== undefined && this.expected - 1 >= this.o.cancelAfter) {
        out.push(CAN, CAN);
        this.done = true;
        continue;
      }
      this.ack(out);
    }
    // CAN CAN in the middle of a block: the receiver's timeout finds it.
    if (this.buf.length >= 2 && this.buf.slice(-2).every((b) => b === CAN)) {
      this.cancelled = true;
      this.done = true;
    }
    return out;
  }
}

/** Run sender and receiver on one line: each byte takes BYTE_S each way. */
function transfer(data: Uint8Array, ro: ReceiverOptions = {}, so: XmodemOptions = {}, until = 200, cancelAt?: number) {
  const rx = new Receiver(ro);
  const tx = new XmodemSender(data, 0, { byteTimeS: BYTE_S, ...so });
  // Bytes in flight: [arrival time, byte].
  let toRx: [number, number][] = [];
  let toTx: [number, number][] = [];
  let lineFreeRx = 0;
  let lineFreeTx = 0;
  const dt = 0.001;
  let displayed = "";
  let progress: number[] = [];
  for (let now = 0; now < until && !tx.done; now += dt) {
    if (cancelAt !== undefined && now >= cancelAt) {
      for (const b of tx.cancel()) toRx.push([now, b]);
    }
    const arrivedTx = toTx.filter(([t]) => t <= now).map(([, b]) => b);
    toTx = toTx.filter(([t]) => t > now);
    const step = tx.update(now, Uint8Array.from(arrivedTx));
    displayed += new TextDecoder().decode(step.passthrough);
    for (const b of step.tx) {
      lineFreeRx = Math.max(lineFreeRx, now) + BYTE_S;
      toRx.push([lineFreeRx, b]);
    }
    progress.push(tx.status().acked);
    const arrivedRx = toRx.filter(([t]) => t <= now).map(([, b]) => b);
    toRx = toRx.filter(([t]) => t > now);
    for (const b of rx.receive(now, arrivedRx)) {
      lineFreeTx = Math.max(lineFreeTx, now) + BYTE_S;
      toTx.push([lineFreeTx, b]);
    }
  }
  // The CANs of a cancel reach the receiver.
  rx.receive(until, toRx.map(([, b]) => b));
  progress = progress.filter((v, i) => i === 0 || v !== progress[i - 1]);
  return { rx, tx, status: tx.status(), displayed, progress };
}

const image = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + (i >> 8)) & 0xff);
const padded = (d: Uint8Array) => {
  const out = new Uint8Array(Math.ceil(d.length / 128) * 128).fill(PAD);
  out.set(d);
  return [...out];
};

test("crc16 is CRC-16/XMODEM", () => {
  assert.equal(crc16(new TextEncoder().encode("123456789")), 0x31c3);
  assert.equal(checksum(Uint8Array.of(0xff, 0x02)), 0x01);
});

test("a file goes over in CRC mode, the last block padded with 0x1A", () => {
  const data = image(1000);
  const { rx, status, progress } = transfer(data);
  assert.deepEqual(status.result, { kind: "ok" });
  assert.equal(status.mode, "crc");
  assert.equal(status.total, 8);
  assert.equal(status.acked, 8);
  assert.equal(status.resent, 0);
  assert.deepEqual(rx.file, padded(data));
  // Progress counts up block by block.
  assert.deepEqual(progress, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test("a receiver that starts with NAK gets checksum mode", () => {
  const data = image(300);
  const { rx, status } = transfer(data, { checksumMode: true });
  assert.deepEqual(status.result, { kind: "ok" });
  assert.equal(status.mode, "checksum");
  assert.deepEqual(rx.file, padded(data));
});

test("damaged blocks are NAKed and sent again", () => {
  const data = image(128 * 5);
  const { rx, status } = transfer(data, { corrupt: new Set([0, 2, 3]) });
  assert.deepEqual(status.result, { kind: "ok" });
  assert.equal(rx.naks, 3);
  assert.equal(status.resent, 3);
  assert.deepEqual(rx.file, padded(data));
});

test("a lost ACK: the block goes again after the timeout, the receiver keeps it once", () => {
  const data = image(128 * 3);
  const { rx, status } = transfer(data, { loseAck: new Set([1]) }, { ackTimeoutS: 1 });
  assert.deepEqual(status.result, { kind: "ok" });
  assert.equal(status.resent, 1);
  assert.deepEqual(rx.file, padded(data));
});

test("EOT NAKed once is sent again", () => {
  const { status, rx } = transfer(image(10), { nakFirstEot: true });
  assert.deepEqual(status.result, { kind: "ok" });
  assert.equal(rx.eots, 2);
});

test("after 10 retries the sender gives up and cancels", () => {
  const { status, rx } = transfer(image(256), { alwaysNak: true });
  assert.deepEqual(status.result, { kind: "failed", reason: "retries" });
  assert.equal(status.resent, 11);
  assert.equal(rx.naks, 11, "the first try and 10 retries");
  assert.ok(rx.cancelled, "CAN reached the receiver");
});

test("no 'C' within the start timeout: failed", () => {
  const { status } = transfer(image(256), { silent: true }, { startTimeoutS: 5 }, 10);
  assert.deepEqual(status.result, { kind: "failed", reason: "no-start" });
  assert.equal(status.block, 0);
});

test("CAN CAN from the receiver aborts", () => {
  const { status } = transfer(image(128 * 6), { cancelAfter: 2 });
  assert.deepEqual(status.result, { kind: "cancelled", by: "receiver" });
  // (The second block was answered with CAN CAN, not ACK.)
  assert.equal(status.acked, 1);
});

test("the user cancels: CAN reaches the receiver", () => {
  const { status, rx } = transfer(image(128 * 400), {}, {}, 30, 0.5);
  assert.deepEqual(status.result, { kind: "cancelled", by: "user" });
  assert.ok(status.acked > 5 && status.acked < 400, String(status.acked));
  assert.ok(rx.cancelled);
});

test("text before the transfer passes through; 'C' and ACK do not", () => {
  const { displayed, status } = transfer(image(200), { banner: "Waiting for XMODEM...\r\n" });
  assert.deepEqual(status.result, { kind: "ok" });
  assert.equal(displayed, "Waiting for XMODEM...\r\n");
});

test("a single CAN is not an abort; timeouts follow the time given, not the calls", () => {
  const s = new XmodemSender(image(128), 100, { startTimeoutS: 2, ackTimeoutS: 3, byteTimeS: 0 });
  let r = s.update(100.5, Uint8Array.of(CAN, 0x43));
  assert.equal(r.tx.length, 133);
  assert.equal(r.tx[0], SOH);
  assert.equal(r.tx[1], 1);
  assert.equal(r.tx[2], 0xfe);
  // Many calls, little time: nothing is resent.
  for (let i = 0; i < 100; i++) assert.equal(s.update(100.5 + i * 0.01).tx.length, 0);
  r = s.update(103.6);
  assert.equal(r.tx.length, 133, "resent after 3 s");
  r = s.update(103.7, Uint8Array.of(ACK));
  assert.deepEqual([...r.tx], [EOT]);
  r = s.update(103.8, Uint8Array.of(ACK, 0x41, 0x42));
  assert.deepEqual(s.status().result, { kind: "ok" });
  assert.equal(new TextDecoder().decode(r.passthrough), "AB");
});

test("an empty file sends only EOT", () => {
  const s = new XmodemSender(new Uint8Array(0), 0);
  assert.deepEqual([...s.update(0, Uint8Array.of(0x43)).tx], [EOT]);
  s.update(0.1, Uint8Array.of(ACK));
  assert.deepEqual(s.status().result, { kind: "ok" });
});
