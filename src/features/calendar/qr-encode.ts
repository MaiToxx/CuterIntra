/**
 * A QR code encoder for the one use the extension has: a link, in byte mode,
 * at error correction level M, in the smallest version that holds it.
 *
 * WHY our own: qrcode-generator was 20 KB of content.js, parsed on every
 * Intra page for a picture drawn in one card of the hub. It also carries
 * Kanji, alphanumeric and numeric modes, three more correction levels and
 * GIF, SVG and ASCII outputs, none of them used. tests/qr-encode.test.ts
 * checks this file against that library, module for module, on every
 * version from 1 to 40: it stays a dev dependency for that.
 *
 * The mask is chosen with the library's own scoring (which is not quite the
 * standard's: its first rule counts like neighbours, not runs), so that both
 * draw the same picture.
 */

/** Error correction codewords per block, level M, by version (index 0 unused). */
const EC_PER_BLOCK = [
  0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28,
  28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];
/** Number of blocks, level M, by version. */
const BLOCKS = [
  0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25,
  26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];

/** Centres of the alignment patterns of a version. */
function alignmentCentres(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let pos = version * 4 + 10; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

/** Codewords of a version, data and correction together. */
function totalCodewords(version: number): number {
  let bits = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const count = Math.floor(version / 7) + 2;
    bits -= (25 * count - 10) * count - 55;
    if (version >= 7) bits -= 36;
  }
  return bits >> 3;
}

const dataCodewords = (version: number): number =>
  totalCodewords(version) - EC_PER_BLOCK[version] * BLOCKS[version];

/** GF(256) product, modulo x^8 + x^4 + x^3 + x^2 + 1. */
function gfMul(a: number, b: number): number {
  let out = 0;
  for (; b > 0; b >>= 1) {
    if (b & 1) out ^= a;
    a = (a << 1) ^ (a & 0x80 ? 0x11d : 0);
  }
  return out;
}

/** The Reed-Solomon correction codewords of one block. */
function correction(data: number[], length: number): number[] {
  // generator: the product of (x - 2^i), highest power left out
  const gen = new Array<number>(length).fill(0);
  gen[length - 1] = 1;
  let root = 1;
  for (let i = 0; i < length; i++) {
    for (let j = 0; j < length; j++) {
      gen[j] = gfMul(gen[j], root);
      if (j + 1 < length) gen[j] ^= gen[j + 1];
    }
    root = gfMul(root, 2);
  }
  const out = new Array<number>(length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (out.shift() as number);
    out.push(0);
    for (let i = 0; i < length; i++) out[i] ^= gfMul(gen[i], factor);
  }
  return out;
}

/** The remainder that protects the format (15 bits) or the version (18 bits). */
function bch(value: number, shift: number, poly: number): number {
  const top = 32 - Math.clz32(poly);
  let rest = value << shift;
  for (let n; (n = 32 - Math.clz32(rest)) >= top; ) rest ^= poly << (n - top);
  return (value << shift) | rest;
}

const MASKS: ((row: number, col: number) => boolean)[] = [
  (i, j) => (i + j) % 2 === 0,
  (i) => i % 2 === 0,
  (_, j) => j % 3 === 0,
  (i, j) => (i + j) % 3 === 0,
  (i, j) => ((i >> 1) + Math.floor(j / 3)) % 2 === 0,
  (i, j) => ((i * j) % 2) + ((i * j) % 3) === 0,
  (i, j) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
  (i, j) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0,
];

type Grid = (boolean | null)[][];

/** The codewords of the message, padded, split in blocks and interleaved. */
function codewords(bytes: Uint8Array, version: number): number[] {
  const capacity = dataCodewords(version);
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(4, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) put(byte, 8);
  if (bits.length + 4 <= capacity * 8) put(0, 4);
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  }
  for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);

  const blocks = BLOCKS[version];
  const ecLength = EC_PER_BLOCK[version];
  const total = totalCodewords(version);
  const shortBlocks = blocks - (total % blocks);
  const shortLength = Math.floor(total / blocks) - ecLength;
  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  for (let b = 0, at = 0; b < blocks; b++) {
    const length = shortLength + (b < shortBlocks ? 0 : 1);
    const block = data.slice(at, at + length);
    at += length;
    dataBlocks.push(block);
    ecBlocks.push(correction(block, ecLength));
  }
  const out: number[] = [];
  for (let i = 0; i <= shortLength; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < ecLength; i++) for (const block of ecBlocks) out.push(block[i]);
  return out;
}

/**
 * The grid for one mask. `scoring` leaves the format and version modules
 * light, as the library does while it compares the masks.
 */
function build(version: number, data: number[], mask: number, scoring: boolean): boolean[][] {
  const size = version * 4 + 17;
  const grid: Grid = Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null));

  const finder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        if (row + r < 0 || size <= row + r || col + c < 0 || size <= col + c) continue;
        const ring = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r % 6 === 0 || c % 6 === 0);
        grid[row + r][col + c] = ring || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      }
    }
  };
  finder(0, 0);
  finder(size - 7, 0);
  finder(0, size - 7);

  const centres = alignmentCentres(version);
  for (const row of centres) {
    for (const col of centres) {
      if (grid[row][col] !== null) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          grid[row + r][col + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
        }
      }
    }
  }

  for (let i = 8; i < size - 8; i++) {
    if (grid[i][6] === null) grid[i][6] = i % 2 === 0;
    if (grid[6][i] === null) grid[6][i] = i % 2 === 0;
  }

  // format: level M is 0, then the mask
  const format = bch(mask, 10, 0x537) ^ 0x5412;
  for (let i = 0; i < 15; i++) {
    const dark = !scoring && ((format >> i) & 1) === 1;
    grid[i < 6 ? i : i < 8 ? i + 1 : size - 15 + i][8] = dark;
    grid[8][i < 8 ? size - i - 1 : i < 9 ? 15 - i : 14 - i] = dark;
  }
  grid[size - 8][8] = !scoring;

  if (version >= 7) {
    const info = bch(version, 12, 0x1f25);
    for (let i = 0; i < 18; i++) {
      const dark = !scoring && ((info >> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      grid[a][b] = dark;
      grid[b][a] = dark;
    }
  }

  const masked = MASKS[mask];
  let step = -1;
  let row = size - 1;
  let bit = 7;
  let at = 0;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        if (grid[row][col - c] !== null) continue;
        const dark = at < data.length && ((data[at] >>> bit) & 1) === 1;
        grid[row][col - c] = dark !== masked(row, col - c);
        if (--bit < 0) {
          at++;
          bit = 7;
        }
      }
      row += step;
      if (row < 0 || size <= row) {
        row -= step;
        step = -step;
        break;
      }
    }
  }
  return grid as boolean[][];
}

/** The library's penalty of a grid: the lower, the easier to scan. */
function penalty(grid: boolean[][]): number {
  const size = grid.length;
  let points = 0;
  let darkCount = 0;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const dark = grid[row][col];
      if (dark) darkCount++;
      let same = 0;
      for (let r = -1; r <= 1; r++) {
        for (let c = -1; c <= 1; c++) {
          if ((r || c) && grid[row + r]?.[col + c] === dark) same++;
        }
      }
      if (same > 5) points += same - 2;
      if (row < size - 1 && col < size - 1) {
        const block =
          +dark + +grid[row + 1][col] + +grid[row][col + 1] + +grid[row + 1][col + 1];
        if (block === 0 || block === 4) points += 3;
      }
      // dark, light, three dark, light, dark: what a finder looks like
      const looksLikeFinder = (cell: (i: number) => boolean) =>
        cell(0) && !cell(1) && cell(2) && cell(3) && cell(4) && !cell(5) && cell(6);
      if (col < size - 6 && looksLikeFinder((i) => grid[row][col + i])) points += 40;
      if (row < size - 6 && looksLikeFinder((i) => grid[row + i][col])) points += 40;
    }
  }
  return points + (Math.abs((100 * darkCount) / size / size - 50) / 5) * 10;
}

/**
 * The modules of the QR code of `text`, row by row, true for dark. Throws
 * when the text is too long for the largest code (2,331 bytes).
 */
export function qrModules(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let version = 1;
  const fits = () => 4 + (version < 10 ? 8 : 16) + bytes.length * 8 <= dataCodewords(version) * 8;
  while (!fits()) {
    if (++version > 40) throw new Error("QR code: text too long");
  }
  const data = codewords(bytes, version);
  let best = 0;
  let lowest = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const points = penalty(build(version, data, mask, true));
    if (points < lowest) {
      lowest = points;
      best = mask;
    }
  }
  return build(version, data, best, false);
}
