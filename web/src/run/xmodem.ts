// XMODEM sender (M37): sends a file to the board over the virtual COM port,
// as a terminal program does for a bootloader. A pure state machine — fed
// with the bytes received and the time, it returns the bytes to send — so
// it runs in the simulation worker on simulated time (the simulation may
// run faster or slower than real time; the timeouts are simulated seconds).
//
// The receiver starts the transfer: 'C' asks for 128-byte blocks with a
// CRC-16 (XMODEM-CRC), NAK for the original 8-bit checksum. Each block is
// SOH, block number (from 1, modulo 256), its complement, 128 data bytes
// (the last block padded with 0x1A) and the check. ACK takes the next
// block, NAK (or no answer in time) has the block sent again, up to
// `retries` times. EOT ends the file and is answered with ACK. Two CAN in a
// row from the receiver abort; the sender aborts with CAN CAN CAN.

export const SOH = 0x01;
export const EOT = 0x04;
export const ACK = 0x06;
export const NAK = 0x15;
export const CAN = 0x18;
/** 'C': the receiver asks for CRC mode. */
export const CRC_MODE = 0x43;
export const PAD = 0x1a;
export const BLOCK = 128;

/** CRC-16/XMODEM (CCITT polynomial 0x1021, initial 0, MSB first). */
export function crc16(data: Uint8Array, from = 0, to = data.length): number {
  let crc = 0;
  for (let i = from; i < to; i++) {
    crc ^= data[i] << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** The 8-bit arithmetic checksum of the original XMODEM. */
export function checksum(data: Uint8Array, from = 0, to = data.length): number {
  let s = 0;
  for (let i = from; i < to; i++) s = (s + data[i]) & 0xff;
  return s;
}

export interface XmodemOptions {
  /** How long to wait for the receiver's 'C' or NAK (s). */
  startTimeoutS?: number;
  /** How long to wait for the answer to a block or EOT once sent (s). */
  ackTimeoutS?: number;
  /** Times a block (or EOT) is sent again before giving up. */
  retries?: number;
  /** Time on the line of one byte (s): 10 bits at 115200 baud. The answer
   * timeout starts once the block is out. */
  byteTimeS?: number;
}

export type XmodemResult =
  | { kind: "ok" }
  | { kind: "cancelled"; by: "user" | "receiver" }
  | { kind: "failed"; reason: XmodemFailure };

/** Why a transfer failed (the page words it). */
export type XmodemFailure = "no-start" | "retries" | "eot" | "reset" | "reload";

export interface XmodemStatus {
  /** Waiting for 'C'/NAK, sending blocks, sending EOT, finished. */
  state: "waiting" | "sending" | "eot" | "done";
  /** Blocks the receiver acknowledged. */
  acked: number;
  /** Blocks in the file. */
  total: number;
  /** The block being sent now (1-based; 0 before the first). */
  block: number;
  /** Retransmissions so far (NAK or timeout), over the whole transfer. */
  resent: number;
  mode: "crc" | "checksum" | null;
  result: XmodemResult | null;
}

export interface XmodemStep {
  /** Bytes to send to the receiver now (empty: nothing). */
  tx: Uint8Array;
  /** Received bytes that were not part of the protocol (text the receiver
   * printed), for the console. */
  passthrough: Uint8Array;
}

const EMPTY = new Uint8Array(0);

export class XmodemSender {
  private readonly data: Uint8Array;
  private readonly opts: Required<XmodemOptions>;
  readonly total: number;
  private state: XmodemStatus["state"] = "waiting";
  private mode: XmodemStatus["mode"] = null;
  /** The block being sent (1-based). */
  private block = 0;
  private tries = 0;
  private resent = 0;
  private deadline: number;
  private cans = 0;
  private result: XmodemResult | null = null;

  constructor(data: Uint8Array, now: number, options: XmodemOptions = {}) {
    this.data = data;
    this.opts = {
      startTimeoutS: options.startTimeoutS ?? 60,
      ackTimeoutS: options.ackTimeoutS ?? 10,
      retries: options.retries ?? 10,
      byteTimeS: options.byteTimeS ?? 10 / 115200,
    };
    this.total = Math.ceil(data.length / BLOCK);
    this.deadline = now + this.opts.startTimeoutS;
  }

  get done(): boolean {
    return this.state === "done";
  }

  status(): XmodemStatus {
    const acked = this.state === "done" && this.result?.kind === "ok" ? this.total : Math.max(0, this.block - 1);
    return {
      state: this.state,
      acked: this.state === "eot" ? this.total : acked,
      total: this.total,
      block: this.block,
      resent: this.resent,
      mode: this.mode,
      result: this.result,
    };
  }

  /** Packet `n` (1-based) in the current mode. */
  packet(n: number): Uint8Array {
    const crc = this.mode === "crc";
    const p = new Uint8Array(3 + BLOCK + (crc ? 2 : 1));
    p[0] = SOH;
    p[1] = n & 0xff;
    p[2] = ~n & 0xff;
    const chunk = this.data.subarray((n - 1) * BLOCK, n * BLOCK);
    p.set(chunk, 3);
    p.fill(PAD, 3 + chunk.length, 3 + BLOCK);
    if (crc) {
      const c = crc16(p, 3, 3 + BLOCK);
      p[3 + BLOCK] = c >> 8;
      p[4 + BLOCK] = c & 0xff;
    } else {
      p[3 + BLOCK] = checksum(p, 3, 3 + BLOCK);
    }
    return p;
  }

  private emit(now: number, bytes: Uint8Array): Uint8Array {
    this.deadline = now + bytes.length * this.opts.byteTimeS + this.opts.ackTimeoutS;
    return bytes;
  }

  private finish(result: XmodemResult): void {
    this.state = "done";
    this.result = result;
  }

  /** Send the current block or EOT again, or give up. */
  private retry(now: number): Uint8Array {
    this.tries++;
    this.resent++;
    if (this.tries > this.opts.retries) {
      this.finish({ kind: "failed", reason: this.state === "eot" ? "eot" : "retries" });
      return Uint8Array.of(CAN, CAN, CAN);
    }
    return this.emit(now, this.state === "eot" ? Uint8Array.of(EOT) : this.packet(this.block));
  }

  /** Move on to block `n`, or to EOT after the last one. */
  private next(now: number, n: number): Uint8Array {
    this.tries = 0;
    this.block = n;
    if (n > this.total) {
      this.state = "eot";
      return this.emit(now, Uint8Array.of(EOT));
    }
    this.state = "sending";
    return this.emit(now, this.packet(n));
  }

  /**
   * Feed what arrived since the last call at simulated time `now` (s), and
   * let the timeouts run: returns what to send, and the received bytes that
   * were not protocol.
   */
  update(now: number, rx: Uint8Array = EMPTY): XmodemStep {
    if (this.state === "done") return { tx: EMPTY, passthrough: rx };
    const out: Uint8Array[] = [];
    const pass: number[] = [];
    for (let i = 0; i < rx.length; i++) {
      const b = rx[i];
      if (this.done) {
        pass.push(...rx.subarray(i));
        break;
      }
      if (b === CAN) {
        if (++this.cans >= 2) this.finish({ kind: "cancelled", by: "receiver" });
        continue;
      }
      this.cans = 0;
      switch (this.state) {
        case "waiting":
          if (b === CRC_MODE || b === NAK) {
            this.mode = b === CRC_MODE ? "crc" : "checksum";
            out.push(this.next(now, 1));
          } else pass.push(b);
          break;
        case "sending":
        case "eot":
          if (b === ACK) {
            if (this.state === "eot") this.finish({ kind: "ok" });
            else out.push(this.next(now, this.block + 1));
          } else if (b === NAK) {
            out.push(this.retry(now));
          } else if (b !== CRC_MODE) {
            // ('C' repeated by a receiver still waiting: not text.)
            pass.push(b);
          }
          break;
      }
    }
    if (!this.done && now >= this.deadline) {
      if (this.state === "waiting") {
        this.finish({ kind: "failed", reason: "no-start" });
      } else {
        out.push(this.retry(now));
      }
    }
    return { tx: concat(out), passthrough: pass.length ? Uint8Array.from(pass) : EMPTY };
  }

  /** The user aborts: the bytes that tell the receiver. */
  cancel(): Uint8Array {
    if (this.state === "done") return EMPTY;
    this.finish({ kind: "cancelled", by: "user" });
    return Uint8Array.of(CAN, CAN, CAN);
  }

  /** The transfer cannot go on (the board was reset, other firmware loaded). */
  abort(reason: XmodemFailure): void {
    if (this.state !== "done") this.finish({ kind: "failed", reason });
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 0) return EMPTY;
  if (parts.length === 1) return parts[0];
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
