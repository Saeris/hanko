/**
 * Reading one horizontal line of a linear barcode.
 *
 * A 1D symbol is a run-length sequence, so this is the whole decode: walk a
 * row, measure how long each dark and light run is, and match those widths
 * against the encoding tables. There is no geometry to solve — no finders, no
 * perspective, no sampling grid — which is why this file is a fraction of the
 * size of the QR pipeline.
 *
 * The difficulty is elsewhere. A row through a barcode is one sample of a
 * noisy signal, and which row you pick decides whether it decodes at all, so
 * the caller sweeps rows and this stays cheap enough to run on many of them.
 */

import type { BitMatrix } from "../types.js";
import {
  G_CODES,
  L_CODES,
  PARITY_PATTERNS,
  R_CODES,
  isValid
} from "./patterns.js";

/** A run of one colour, in pixels. */
interface Run {
  readonly dark: boolean;
  readonly length: number;
  /** Where the run starts, so a match can be located in the image. */
  readonly start: number;
}

/**
 * Split a row into runs of constant colour.
 *
 * The leading and trailing runs are dropped: they are the quiet zone and the
 * rest of the scene, and their length says nothing about the symbol.
 */
export const runsInRow = (matrix: BitMatrix, y: number): Run[] => {
  const { width, bits } = matrix;
  const row = y * width;
  const runs: Run[] = [];

  let start = 0;
  let current = bits[row];

  for (let x = 1; x <= width; x++) {
    const value = x < width ? bits[row + x] : -1;
    if (value === current) continue;

    runs.push({ dark: current === 1, length: x - start, start });
    start = x;
    current = value;
  }

  return runs;
};

/**
 * How badly a run of widths matches a pattern of module counts.
 *
 * Scale-invariant: the widths are normalised by their own total before
 * comparison, so a barcode occupying 80 pixels and the same barcode occupying
 * 800 score identically. That is what lets one threshold work at any distance.
 *
 * Returns `Infinity` for a mismatch rather than a boolean, so a caller can
 * choose the best of several candidates instead of the first acceptable one.
 */
const patternError = (
  widths: readonly number[],
  pattern: readonly number[],
  tolerance: number
): number => {
  let total = 0;
  let modules = 0;
  for (const width of widths) total += width;
  for (const count of pattern) modules += count;
  if (total === 0 || modules === 0) return Infinity;

  const unit = total / modules;
  // A symbol thinner than a pixel per module cannot be read, and the widths
  // would be noise rather than measurement.
  if (unit < 0.9) return Infinity;

  let error = 0;
  for (const [index, width] of widths.entries()) {
    const expected = pattern[index] * unit;
    const difference = Math.abs(width - expected);
    if (difference > unit * tolerance) return Infinity;
    error += difference;
  }

  return error / total;
};

/** Widths of the module runs within one encoded digit. */
const DIGIT_PATTERNS = [L_CODES, G_CODES, R_CODES].map((table) =>
  table.map((code) => {
    // Each code is 7 modules as alternating runs; the tables store modules, so
    // collapse them into run lengths, which is what a scanline measures.
    const widths: number[] = [];
    let run = 1;
    for (let i = 1; i < code.length; i++) {
      if (code[i] === code[i - 1]) {
        run++;
      } else {
        widths.push(run);
        run = 1;
      }
    }
    widths.push(run);
    return widths;
  })
);

/** Which alphabet a digit was read in, which is how parity is recovered. */
type Alphabet = 0 | 1 | 2;

interface DigitMatch {
  readonly digit: number;
  readonly alphabet: Alphabet;
  readonly error: number;
}

/**
 * Identify one digit from four consecutive runs.
 *
 * Every EAN digit is four runs — two dark, two light — totalling seven
 * modules, whichever alphabet it is in. Which alphabet matched is returned
 * alongside, because for EAN-13 that is the only place the first digit exists.
 */
const readDigit = (
  runs: readonly Run[],
  at: number,
  alphabets: readonly Alphabet[],
  tolerance: number
): DigitMatch | null => {
  if (at + 4 > runs.length) return null;

  const widths = [
    runs[at].length,
    runs[at + 1].length,
    runs[at + 2].length,
    runs[at + 3].length
  ];

  let best: DigitMatch | null = null;

  for (const alphabet of alphabets) {
    for (const [digit, pattern] of DIGIT_PATTERNS[alphabet].entries()) {
      const error = patternError(widths, pattern, tolerance);
      if (error === Infinity) continue;
      if (best === null || error < best.error) {
        best = { digit, alphabet, error };
      }
    }
  }

  return best;
};

/** A decoded linear symbol, before it is named. */
export interface LinearMatch {
  /** Every digit, check digit included. */
  readonly digits: readonly number[];
  /** Pixel bounds of the symbol along the row. */
  readonly start: number;
  readonly end: number;
  /** How well the runs matched, for choosing between rows. */
  readonly error: number;
}

/**
 * Decode an EAN-13, UPC-A or EAN-8 starting at a given run.
 *
 * Both lengths are attempted from the same position because they are
 * distinguished by what decodes, not by anything visible up front: an EAN-8 is
 * not a truncated EAN-13, it is a shorter symbol with its own centre guard
 * position. Trying both costs one pass and removes a guess.
 */
const decodeFrom = (
  runs: readonly Run[],
  at: number,
  tolerance: number
): LinearMatch | null => {
  // The start guard is three runs — dark, light, dark — of one module each.
  const guardError = patternError(
    [runs[at].length, runs[at + 1].length, runs[at + 2].length],
    [1, 1, 1],
    tolerance
  );
  if (guardError === Infinity || !runs[at].dark) return null;

  for (const perSide of [6, 4] as const) {
    const digits: number[] = [];
    const parities: number[] = [];
    let error = guardError;
    let cursor = at + 3;
    let failed = false;

    // Left half: L or G on a 13, L only on an 8.
    const leftAlphabets: Alphabet[] = perSide === 6 ? [0, 1] : [0];
    for (let i = 0; i < perSide; i++) {
      const match = readDigit(runs, cursor, leftAlphabets, tolerance);
      if (match === null) {
        failed = true;
        break;
      }
      digits.push(match.digit);
      parities.push(match.alphabet === 1 ? 1 : 0);
      error += match.error;
      cursor += 4;
    }
    if (failed) continue;

    // Centre guard: five runs of one module, light-dark-light-dark-light.
    if (cursor + 5 > runs.length) continue;
    const centreError = patternError(
      [
        runs[cursor].length,
        runs[cursor + 1].length,
        runs[cursor + 2].length,
        runs[cursor + 3].length,
        runs[cursor + 4].length
      ],
      [1, 1, 1, 1, 1],
      tolerance
    );
    if (centreError === Infinity) continue;
    error += centreError;
    cursor += 5;

    // Right half is always R.
    for (let i = 0; i < perSide; i++) {
      const match = readDigit(runs, cursor, [2], tolerance);
      if (match === null) {
        failed = true;
        break;
      }
      digits.push(match.digit);
      error += match.error;
      cursor += 4;
    }
    if (failed) continue;

    // End guard, which also proves the symbol ended where it should rather
    // than the scan having drifted into neighbouring artwork.
    if (cursor + 3 > runs.length) continue;
    if (
      patternError(
        [runs[cursor].length, runs[cursor + 1].length, runs[cursor + 2].length],
        [1, 1, 1],
        tolerance
      ) === Infinity
    ) {
      continue;
    }

    const full =
      perSide === 6
        ? // The thirteenth digit is not drawn: it is which parity pattern the
          // left half used. A pattern that matches none is not an EAN-13.
          (() => {
            const first = PARITY_PATTERNS.findIndex((pattern) =>
              pattern.every((bit, index) => bit === parities[index])
            );
            return first === -1 ? null : [first, ...digits];
          })()
        : digits;

    if (full === null) continue;

    // The check digit is the whole verification. There is no error correction
    // in this family, so a symbol either reads consistently or is discarded —
    // returning a plausible-looking wrong number would be far worse than
    // returning nothing.
    if (!isValid(full)) continue;

    return {
      digits: full,
      start: runs[at].start,
      end: runs[cursor + 2].start + runs[cursor + 2].length,
      error: error / full.length
    };
  }

  return null;
};

/**
 * Find a linear symbol anywhere along one row.
 *
 * Every dark run is tried as a possible start guard. That sounds expensive and
 * is not: a mismatch is rejected within a few runs, and a row through ordinary
 * packaging has only tens of runs in it.
 *
 * Both directions are attempted. The R alphabet is the complement of L and G
 * is R reversed, so a barcode scanned right-to-left produces a valid-looking
 * run sequence — reversing the runs and decoding again is how an upside-down
 * label reads without the caller rotating the image.
 */
export const decodeRow = (
  matrix: BitMatrix,
  y: number,
  tolerance = 0.7
): LinearMatch | null => {
  const runs = runsInRow(matrix, y);
  // 3 + 24 + 5 + 24 + 3 for an EAN-8, the shortest thing worth trying.
  if (runs.length < 59) return null;

  let best: LinearMatch | null = null;

  for (const forward of [true, false]) {
    const ordered = forward
      ? runs
      : // Reversed, with positions rewritten so a match still reports where it
        // sits in the image rather than where it sat in the reversed array.
        [...runs].reverse().map((run) => ({
          ...run,
          start: matrix.width - run.start - run.length
        }));

    for (let at = 0; at + 59 <= ordered.length; at++) {
      if (!ordered[at].dark) continue;

      const match = decodeFrom(ordered, at, tolerance);
      if (match === null) continue;
      if (best === null || match.error < best.error) best = match;
    }
  }

  return best;
};
