/**
 * Format and version information.
 *
 * These are the two small fields a decoder must read *before* it can read
 * anything else: format info says which error-correction level and mask were
 * used, version info says how big the symbol is. Everything downstream depends
 * on getting them right, so both carry their own error correction —
 * independent of the Reed-Solomon protecting the payload.
 *
 * That correction is BCH, not Reed-Solomon. The distinction matters
 * practically: these fields are tiny and fixed-size, so rather than run a
 * decoder, we compare against every legal value and take the closest. Fifteen
 * bits with 32 candidates makes exhaustive comparison both simpler and faster
 * than the algebra — and it cannot fail in a way that returns a wrong-but-
 * plausible answer, which for a field that determines how to read everything
 * else is the failure that matters.
 */

import type { BitMatrix } from "../types.js";

/** Error-correction level, in the order the format field encodes them. */
export type ErrorCorrectionLevel = `L` | `M` | `Q` | `H`;

/** What the format field carries. */
export interface FormatInfo {
  readonly errorCorrectionLevel: ErrorCorrectionLevel;
  /** Which of the eight mask patterns was applied to the data modules. */
  readonly mask: number;
}

/**
 * The 32 legal format values, pre-computed.
 *
 * Index is the raw 5-bit format (EC level in the high 2 bits, mask in the low
 * 3); the value is the full 15-bit sequence after BCH encoding and XOR with
 * the fixed mask pattern 0x5412.
 *
 * From ISO/IEC 18004 Annex C. Written out rather than generated because the
 * table IS the specification here — generating it would mean reimplementing
 * the BCH encoder just to reproduce 32 constants that never change, and any
 * bug in that generator would be invisible.
 */
const FORMAT_SEQUENCES = [
  0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0, 0x77c4,
  0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976, 0x1689, 0x13be,
  0x1ce7, 0x19d0, 0x0762, 0x0255, 0x0d0c, 0x083b, 0x355f, 0x3068, 0x3f31,
  0x3a06, 0x24b4, 0x2183, 0x2eda, 0x2bed
] as const;

/**
 * The 34 legal version values for versions 7 and above.
 *
 * Versions 1-6 carry no version block at all — their size is inferred from
 * the module count, which is why `readVersion` takes the matrix dimension as
 * its starting point rather than trusting this field alone.
 *
 * From ISO/IEC 18004 Annex D.
 */
const VERSION_SEQUENCES = [
  0x07c94, 0x085bc, 0x09a99, 0x0a4d3, 0x0bbf6, 0x0c762, 0x0d847, 0x0e60d,
  0x0f928, 0x10b78, 0x1145d, 0x12a17, 0x13532, 0x149a6, 0x15683, 0x168c9,
  0x177ec, 0x18ec4, 0x191e1, 0x1afab, 0x1b08e, 0x1cc1a, 0x1d33f, 0x1ed75,
  0x1f250, 0x209d5, 0x216f0, 0x228ba, 0x2379f, 0x24b0b, 0x2542e, 0x26a64,
  0x27541, 0x28c69
] as const;

/** Error-correction levels in the order the format field encodes them. */
const EC_LEVELS: readonly ErrorCorrectionLevel[] = [`M`, `L`, `H`, `Q`];

/** How many bits differ between two values. */
const hammingDistance = (a: number, b: number): number => {
  let difference = a ^ b;
  let count = 0;
  while (difference !== 0) {
    count += difference & 1;
    difference >>>= 1;
  }
  return count;
};

/**
 * Find the closest legal value, or `null` if nothing is close enough.
 *
 * `maxDistance` is the correction capability of the BCH code. Accepting a
 * worse match would mean guessing, and a wrong format value does not produce a
 * slightly-wrong decode — it produces a completely different (and confidently
 * wrong) reading of every module in the symbol.
 */
const closestMatch = (
  received: number,
  candidates: readonly number[],
  maxDistance: number
): { index: number; distance: number } | null => {
  let best: { index: number; distance: number } | null = null;

  for (const [index, candidate] of candidates.entries()) {
    const distance = hammingDistance(received, candidate);
    if (distance === 0) return { index, distance };
    if (best === null || distance < best.distance) best = { index, distance };
  }

  if (best === null || best.distance > maxDistance) return null;
  return best;
};

/**
 * Decode a 15-bit format sequence.
 *
 * The BCH code here corrects up to 3 bit errors, so anything further away is
 * rejected rather than guessed at.
 */
export const decodeFormat = (raw: number): FormatInfo | null => {
  const match = closestMatch(raw & 0x7fff, FORMAT_SEQUENCES, 3);
  if (match === null) return null;

  return {
    errorCorrectionLevel: EC_LEVELS[(match.index >> 3) & 0x3],
    mask: match.index & 0x7
  };
};

/**
 * Decode an 18-bit version sequence, returning the version number.
 *
 * Corrects up to 3 bit errors, same as format. Returns `null` rather than a
 * guess: reading the wrong version means sampling the wrong grid size, which
 * fails in confusing ways much later.
 */
export const decodeVersion = (raw: number): number | null => {
  const match = closestMatch(raw & 0x3ffff, VERSION_SEQUENCES, 3);
  // The table starts at version 7 — versions 1-6 have no version block.
  return match === null ? null : match.index + 7;
};

/** Read a module as a bit. Out-of-range reads are treated as light. */
const bitAt = (matrix: BitMatrix, x: number, y: number): number => {
  if (x < 0 || y < 0 || x >= matrix.width || y >= matrix.height) return 0;
  return matrix.bits[y * matrix.width + x];
};

/**
 * Read the format information out of a matrix.
 *
 * It is stored twice, in two different places, precisely so that damage to one
 * copy is survivable. The primary copy wraps the top-left finder; the backup
 * runs along the bottom-left and top-right edges.
 *
 * Both are tried, primary first. Reading only one would throw away the
 * redundancy the format was designed with — and the backup exists because the
 * top-left corner is exactly where a thumb, a logo, or a fold tends to land.
 */
export const readFormat = (matrix: BitMatrix): FormatInfo | null => {
  const size = matrix.width;

  // Primary: around the top-left finder pattern. The skips at 6 avoid the
  // timing pattern, which runs through row and column 6.
  let primary = 0;
  for (let x = 0; x <= 5; x++) primary = (primary << 1) | bitAt(matrix, x, 8);
  primary = (primary << 1) | bitAt(matrix, 7, 8);
  primary = (primary << 1) | bitAt(matrix, 8, 8);
  primary = (primary << 1) | bitAt(matrix, 8, 7);
  for (let y = 5; y >= 0; y--) primary = (primary << 1) | bitAt(matrix, 8, y);

  const fromPrimary = decodeFormat(primary);
  if (fromPrimary !== null) return fromPrimary;

  // Backup: bottom-left going up, then top-right going right.
  let backup = 0;
  for (let y = size - 1; y >= size - 7; y--) {
    backup = (backup << 1) | bitAt(matrix, 8, y);
  }
  for (let x = size - 8; x < size; x++) {
    backup = (backup << 1) | bitAt(matrix, x, 8);
  }

  return decodeFormat(backup);
};

/**
 * Read the version out of a matrix.
 *
 * Versions 1-6 carry no version block, so their version comes from the module
 * count alone — a 21x21 symbol is version 1, and each version adds 4 modules
 * per side. For 7 and above the dimension still gives the answer, but the
 * explicit block is read as a cross-check: if the two disagree, the grid was
 * probably sampled at the wrong size, and continuing would produce confident
 * nonsense.
 */
export const readVersion = (matrix: BitMatrix): number | null => {
  const size = matrix.width;
  if (size !== matrix.height) return null;
  if (size < 21 || size > 177 || (size - 17) % 4 !== 0) return null;

  const fromSize = (size - 17) / 4;
  if (fromSize < 7) return fromSize;

  // Bottom-left block, read as 18 bits.
  let bottomLeft = 0;
  for (let y = 5; y >= 0; y--) {
    for (let x = size - 9; x >= size - 11; x--) {
      bottomLeft = (bottomLeft << 1) | bitAt(matrix, x, y);
    }
  }

  const decoded = decodeVersion(bottomLeft);
  if (decoded === fromSize) return fromSize;

  // Top-right block, as the second copy.
  let topRight = 0;
  for (let x = 5; x >= 0; x--) {
    for (let y = size - 9; y >= size - 11; y--) {
      topRight = (topRight << 1) | bitAt(matrix, x, y);
    }
  }

  return decodeVersion(topRight) === fromSize ? fromSize : null;
};
