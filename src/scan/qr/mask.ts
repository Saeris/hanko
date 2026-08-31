/**
 * Mask patterns and the function-module map.
 *
 * A QR encoder XORs the data region with one of eight patterns before writing
 * it, choosing whichever produces the most evenly-distributed result. That is
 * what stops a payload of mostly-zeroes rendering as a large blank area that
 * scanners mistake for background, or as stripes that look like a finder
 * pattern.
 *
 * Decoding therefore means applying the same pattern again — XOR is its own
 * inverse — but ONLY to data modules. Function modules (finders, timing,
 * alignment, format, version) are never masked, so the map of where they live
 * has to be exact. A single module misclassified shifts every subsequent bit
 * and the payload decodes to noise.
 */

import type { BitMatrix } from "../types.js";

/**
 * The eight mask patterns, from ISO/IEC 18004 §7.8.2.
 *
 * Each answers "should the module at (x, y) be flipped?". They are written as
 * predicates rather than lookup tables because the formulae ARE the spec, and
 * a reader checking this against the standard can compare them line by line.
 *
 * Note the argument order: the spec writes these in terms of (row, column),
 * so these take (y, x) — matching it exactly rather than swapping to the (x,
 * y) convention used elsewhere, because a transposed mask still produces a
 * valid-looking symbol that decodes to garbage.
 */
const MASK_PATTERNS: ReadonlyArray<(y: number, x: number) => boolean> = [
  (y, x) => (y + x) % 2 === 0,
  (y) => y % 2 === 0,
  (_y, x) => x % 3 === 0,
  (y, x) => (y + x) % 3 === 0,
  (y, x) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (y, x) => ((y * x) % 2) + ((y * x) % 3) === 0,
  (y, x) => (((y * x) % 2) + ((y * x) % 3)) % 2 === 0,
  (y, x) => (((y + x) % 2) + ((y * x) % 3)) % 2 === 0
];

/**
 * Alignment pattern centre coordinates, indexed by version.
 *
 * From ISO/IEC 18004 Annex E. Version 1 has none; every later version places
 * a 5x5 pattern at each intersection of these coordinates, except where one
 * would overlap a finder.
 */
const ALIGNMENT_CENTERS: ReadonlyArray<readonly number[]> = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
  [6, 28, 50, 72, 94],
  [6, 26, 50, 74, 98],
  [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110],
  [6, 30, 58, 86, 114],
  [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126],
  [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138],
  [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150],
  [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162],
  [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170]
];

/** Whether a mask index is one of the eight legal patterns. */
export const isValidMask = (mask: number): boolean =>
  Number.isInteger(mask) && mask >= 0 && mask < MASK_PATTERNS.length;

/** Apply mask `mask` at `(x, y)`. Its own inverse, so this both masks and unmasks. */
export const shouldFlip = (mask: number, x: number, y: number): boolean => {
  const pattern = MASK_PATTERNS[mask];
  if (pattern === undefined) throw new Error(`Unknown mask pattern ${mask}`);
  return pattern(y, x);
};

/**
 * Build a map of which modules carry data.
 *
 * `true` means the module is a function pattern and must be skipped. Computed
 * once per decode rather than tested per module: the reading order zigzags
 * across the symbol, and re-deriving "is this a finder?" at every step is both
 * slower and far easier to get subtly wrong.
 */
export const functionModuleMap = (
  size: number,
  version: number
): Uint8Array => {
  const map = new Uint8Array(size * size);
  const mark = (x: number, y: number): void => {
    if (x >= 0 && y >= 0 && x < size && y < size) map[y * size + x] = 1;
  };

  // Finder patterns and their separators, at three corners. 8x8 rather than
  // 7x7 because the one-module separator around each is also reserved.
  for (const [originX, originY] of [
    [0, 0],
    [size - 7, 0],
    [0, size - 7]
  ] as const) {
    for (let y = -1; y <= 7; y++) {
      for (let x = -1; x <= 7; x++) mark(originX + x, originY + y);
    }
  }

  // Timing patterns: the alternating row and column at index 6.
  for (let i = 0; i < size; i++) {
    mark(6, i);
    mark(i, 6);
  }

  // Format information. The primary copy occupies row 8 and column 8 for
  // indices 0-8; the secondary copy is 8 modules along the top-right row and
  // 7 up the bottom-left column. Marking both arms to 8 — the obvious first
  // guess — reserves modules that actually carry data, which shifts every
  // subsequent bit and decodes the payload as noise.
  for (let i = 0; i <= 8; i++) {
    mark(i, 8);
    mark(8, i);
  }
  for (let i = 0; i < 8; i++) mark(size - 1 - i, 8);
  for (let i = 0; i < 7; i++) mark(8, size - 1 - i);

  // The dark module, always set. Fixed at (8, 4 * version + 9) by the spec,
  // which is one row above where the bottom-left format copy ends.
  mark(8, 4 * version + 9);

  // Alignment patterns, at every intersection that does not overlap a finder.
  const centers = ALIGNMENT_CENTERS[version] ?? [];
  for (const centerY of centers) {
    for (const centerX of centers) {
      const nearFinder =
        (centerX <= 8 && centerY <= 8) ||
        (centerX <= 8 && centerY >= size - 9) ||
        (centerX >= size - 9 && centerY <= 8);
      if (nearFinder) continue;

      for (let y = -2; y <= 2; y++) {
        for (let x = -2; x <= 2; x++) mark(centerX + x, centerY + y);
      }
    }
  }

  // Version information, for version 7 and above only.
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        mark(size - 11 + j, i);
        mark(i, size - 11 + j);
      }
    }
  }

  return map;
};

/**
 * Read the data modules in the order the spec writes them.
 *
 * The path runs in two-module-wide columns from the bottom-right, alternating
 * upward and downward, skipping the timing column at index 6 and every
 * function module. Within each column, the right module comes first.
 *
 * Returns unmasked bits, since the caller always wants them that way and
 * doing it here keeps the traversal and the mask in one place — they have to
 * agree about coordinates, and separating them invites them to drift.
 */
export const readDataBits = (
  matrix: BitMatrix,
  version: number,
  mask: number
): Uint8Array => {
  const size = matrix.width;
  const functionMap = functionModuleMap(size, version);
  const bits: number[] = [];

  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern. It is skipped entirely, and
    // every column to its left shifts by one.
    const columnRight = right <= 6 ? right - 1 : right;

    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;

      for (const x of [columnRight, columnRight - 1]) {
        if (functionMap[y * size + x] === 1) continue;

        const bit = matrix.bits[y * size + x];
        bits.push(shouldFlip(mask, x, y) ? bit ^ 1 : bit);
      }
    }
    upward = !upward;
  }

  return Uint8Array.from(bits);
};
