// A compact QR code encoder (M30), byte mode only: a share link is ASCII.
// It follows ISO/IEC 18004 the way Project Nayuki's reference does —
// versions 1–40, error correction levels L/M/Q/H, Reed–Solomon over
// GF(256) with 0x11D, the eight masks chosen by the penalty rules. Pure,
// unit tested in test/m30.test.ts with an independent decoder.

export type Ecc = "L" | "M" | "Q" | "H";

const ECC_INDEX: Record<Ecc, number> = { L: 0, M: 1, Q: 2, H: 3 };
/** The two format bits of each level (L = 01, M = 00, Q = 11, H = 10). */
const ECC_FORMAT: Record<Ecc, number> = { L: 1, M: 0, Q: 3, H: 2 };

// prettier-ignore
export const ECC_CODEWORDS_PER_BLOCK: number[][] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
// prettier-ignore
export const NUM_ERROR_CORRECTION_BLOCKS: number[][] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

export interface QrCode {
  version: number;
  ecc: Ecc;
  mask: number;
  /** Modules per side (17 + 4·version). */
  size: number;
  /** `modules[y][x]`: true is dark. */
  modules: boolean[][];
}

/** Bits of the data area (everything that is not a function pattern). */
export function numRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

export function numDataCodewords(ver: number, ecc: Ecc): number {
  const e = ECC_INDEX[ecc];
  return Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[e][ver] * NUM_ERROR_CORRECTION_BLOCKS[e][ver];
}

/** How many bytes fit in byte mode at this version and level. */
export function byteCapacity(ver: number, ecc: Ecc): number {
  const countBits = ver < 10 ? 8 : 16;
  return Math.floor((numDataCodewords(ver, ecc) * 8 - 4 - countBits) / 8);
}

/** The most bytes any QR code holds (version 40, level L). */
export const QR_MAX_BYTES = byteCapacity(40, "L");

// ------------------------------------------------------------ Reed–Solomon

export function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((c, i) => (result[i] ^= gfMul(c, factor)));
  }
  return result;
}

// ------------------------------------------------------------ encoding

/** Format information: level and mask, BCH(15,5), XOR 0x5412. */
export function formatBits(ecc: Ecc, mask: number): number {
  const data = (ECC_FORMAT[ecc] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

/** Version information (versions 7 and up): BCH(18,6). */
export function versionBits(ver: number): number {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}

export function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const numAlign = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = ver * 4 + 10; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

const bit = (x: number, i: number) => ((x >>> i) & 1) !== 0;

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

class Grid {
  size: number;
  modules: boolean[][];
  fn: boolean[][];
  ver: number;
  constructor(ver: number) {
    this.ver = ver;
    this.size = ver * 4 + 17;
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
    this.fn = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }
  set(x: number, y: number, dark: boolean) {
    this.modules[y][x] = dark;
    this.fn[y][x] = true;
  }
  functionPatterns() {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && x < n && y >= 0 && y < n) this.set(x, y, d !== 2 && d !== 4);
        }
      }
    }
    const al = alignmentPositions(this.ver);
    const last = al.length - 1;
    al.forEach((ay, i) =>
      al.forEach((ax, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) this.set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }),
    );
    this.format(0); // reserve the area; drawn again with the real mask
    if (this.ver >= 7) {
      const bits = versionBits(this.ver);
      for (let i = 0; i < 18; i++) {
        const a = n - 11 + (i % 3);
        const b = Math.floor(i / 3);
        this.set(a, b, bit(bits, i));
        this.set(b, a, bit(bits, i));
      }
    }
  }
  format(bits: number) {
    const n = this.size;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(bits, i));
    this.set(8, 7, bit(bits, 6));
    this.set(8, 8, bit(bits, 7));
    this.set(7, 8, bit(bits, 8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(bits, i));
    for (let i = 0; i < 8; i++) this.set(n - 1 - i, 8, bit(bits, i));
    for (let i = 8; i < 15; i++) this.set(8, n - 15 + i, bit(bits, i));
    this.set(8, n - 8, true); // the dark module
  }
  codewords(data: number[]) {
    const n = this.size;
    let i = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? n - 1 - vert : vert;
          if (!this.fn[y][x] && i < data.length * 8) {
            this.modules[y][x] = bit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }
  applyMask(mask: number) {
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) if (!this.fn[y][x] && maskBit(mask, x, y)) this.modules[y][x] = !this.modules[y][x];
  }
  penalty(): number {
    const n = this.size;
    const m = this.modules;
    let score = 0;
    const lines: boolean[][] = [];
    for (let y = 0; y < n; y++) lines.push(m[y]);
    for (let x = 0; x < n; x++) lines.push(m.map((row) => row[x]));
    const finder = [true, false, true, true, true, false, true];
    for (const line of lines) {
      // Runs of five or more of one colour.
      let run = 1;
      for (let i = 1; i <= n; i++) {
        if (i < n && line[i] === line[i - 1]) run++;
        else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      // Finder-like 1:1:3:1:1 with four light modules on one side.
      for (let i = 0; i + 7 <= n; i++) {
        if (!finder.every((v, k) => line[i + k] === v)) continue;
        const lightBefore = [1, 2, 3, 4].every((k) => i - k < 0 || !line[i - k]);
        const lightAfter = [0, 1, 2, 3].every((k) => i + 7 + k >= n || !line[i + 7 + k]);
        if (lightBefore || lightAfter) score += 40;
      }
    }
    let dark = 0;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (m[y][x]) dark++;
        if (x + 1 < n && y + 1 < n && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
      }
    }
    const total = n * n;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  }
}

/** Data codewords with error correction, split in blocks and interleaved. */
export function interleave(data: number[], ver: number, ecc: Ecc): number[] {
  const e = ECC_INDEX[ecc];
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[e][ver];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[e][ver];
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(blockEccLen);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const eccPart = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(eccPart));
  }
  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

/**
 * The smallest QR code holding `bytes` at level `ecc` (or a lower level
 * when it does not fit even at version 40, down to `minEcc`); null if
 * nothing holds it. `mask` forces a mask (tests); normally the one with
 * the lowest penalty.
 */
export function encodeQr(bytes: Uint8Array, ecc: Ecc = "M", opts: { minEcc?: Ecc; mask?: number } = {}): QrCode | null {
  const levels: Ecc[] = (["H", "Q", "M", "L"] as Ecc[]).filter(
    (l) => ECC_INDEX[l] <= ECC_INDEX[ecc] && ECC_INDEX[l] >= ECC_INDEX[opts.minEcc ?? "L"],
  );
  for (const level of levels) {
    for (let ver = 1; ver <= 40; ver++) {
      if (bytes.length > byteCapacity(ver, level)) continue;
      return build(bytes, ver, level, opts.mask);
    }
  }
  return null;
}

function build(bytes: Uint8Array, ver: number, ecc: Ecc, forcedMask?: number): QrCode {
  const bits: number[] = [];
  const put = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  put(0b0100, 4); // byte mode
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacity = numDataCodewords(ver, ecc) * 8;
  put(0, Math.min(4, capacity - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; data.length < capacity / 8; pad ^= 0xec ^ 0x11) data.push(pad);

  const grid = new Grid(ver);
  grid.functionPatterns();
  grid.codewords(interleave(data, ver, ecc));
  let best = forcedMask ?? 0;
  if (forcedMask === undefined) {
    let min = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      grid.applyMask(mask);
      grid.format(formatBits(ecc, mask));
      const p = grid.penalty();
      if (p < min) {
        min = p;
        best = mask;
      }
      grid.applyMask(mask); // undo (XOR)
    }
  }
  grid.applyMask(best);
  grid.format(formatBits(ecc, best));
  return { version: ver, ecc, mask: best, size: grid.size, modules: grid.modules };
}

/** An SVG path of the dark modules (one unit per module, `margin` units of quiet zone). */
export function qrPath(qr: QrCode, margin = 4): string {
  let d = "";
  qr.modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) d += `M${x + margin} ${y + margin}h1v1h-1z`;
    }),
  );
  return d;
}
