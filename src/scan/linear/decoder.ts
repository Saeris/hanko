/**
 * Reading UPC and EAN barcodes from a photograph.
 *
 * The same shape as the QR decoder — pixels in, symbol out, no camera and no
 * DOM — and built on the same binarization, so a caller that already scans QR
 * pays nothing new to also scan packaging.
 *
 * What differs is where the difficulty lives. A QR symbol carries its own
 * geometry and its own error correction, so the work is finding it. A linear
 * barcode has neither: one row either decodes or does not, there is no
 * correction to recover a misread, and the check digit is the only thing
 * standing between a wrong answer and a confident wrong answer. So this sweeps
 * many rows and trusts the check digit rather than trying to read one row well.
 */

import { binarize, binarizeAt, binarizeGlobal } from "../binarize.js";
import type { BarcodeFormat, DecodedSymbol, GrayImage } from "../types.js";
import { decodeRow, type LinearMatch } from "./scanline.js";

/** Options for {@link createLinearDecoder}. */
export interface LinearDecoderOptions {
  /**
   * Milliseconds to spend before giving up, or `0` for no limit.
   *
   * Checked between row sweeps rather than inside one, so a budget bounds the
   * work started rather than the time taken — the same caveat the QR decoder
   * carries, and for the same reason.
   */
  timeBudgetMs?: number;

  /**
   * How many rows to sample across the image.
   *
   * Not every row: a barcode is many pixels tall, so neighbouring rows carry
   * almost the same signal, and sampling a fraction of them finds the same
   * symbols for a fraction of the work. Rows are spread evenly rather than
   * clustered, since a label can sit anywhere in frame.
   */
  rows?: number;

  /**
   * Which lengths to accept.
   *
   * `ean_8` is a genuine source of false positives: eight digits is a short
   * enough sequence that ordinary artwork occasionally satisfies both the
   * pattern match and the check digit. A caller scanning bottles — which carry
   * UPC-A or EAN-13 — can exclude it and remove that failure mode outright.
   */
  formats?: readonly BarcodeFormat[];

  /**
   * How many rows must agree before a reading is returned.
   *
   * Two by default. One is measurably unsafe — see the sweep below — and more
   * than two costs recognition on a barcode photographed small or at an angle,
   * where only a couple of rows cross it cleanly.
   */
  agreement?: number;
}

/** The default set: everything this decoder can produce. */
const ALL_FORMATS: readonly BarcodeFormat[] = [
  `ean_13`,
  `ean_8`,
  `upc_a`,
  `upc_e`
];

/**
 * Name the symbology from what was decoded.
 *
 * The distinction is in the digits, not the bars — a UPC-A *is* an EAN-13
 * whose first digit is zero — so this is a matter of reporting the shape the
 * caller will match on rather than of recognising anything further.
 */
const formatOf = (digits: readonly number[]): BarcodeFormat =>
  digits.length === 8 ? `ean_8` : digits[0] === 0 ? `upc_a` : `ean_13`;

/**
 * The payload, as the digits a caller would look up.
 *
 * UPC-A is reported as twelve digits rather than thirteen with a leading zero,
 * because that is what is printed on the package and what a product database
 * is keyed by. The information is identical; the spelling is not, and a lookup
 * that misses because of a leading zero is a bad way to discover the
 * difference.
 */
const valueOf = (digits: readonly number[], format: BarcodeFormat): string => {
  const text = digits.join(``);
  return format === `upc_a` ? text.slice(1) : text;
};

/**
 * Create a decoder for the EAN/UPC family.
 *
 * Stateless and reusable: one instance can decode any number of frames, and
 * holding onto it lets V8 keep the hot paths optimised across them.
 */
export const createLinearDecoder = ({
  timeBudgetMs = 120,
  rows = 24,
  formats = ALL_FORMATS,
  agreement = 2
}: LinearDecoderOptions = {}): {
  decode(image: GrayImage): DecodedSymbol | null;
} => {
  const wanted = new Set(formats);

  const sweep = (
    matrix: { bits: Uint8Array; width: number; height: number },
    spent: () => boolean
  ): LinearMatch | null => {
    const { height } = matrix;
    const step = Math.max(1, Math.floor(height / rows));

    // The same reading has to appear on more than one row.
    //
    // This family carries no error correction, so a misread is indistinguishable
    // from a read — the check digit is the only guard, and one digit in ten
    // passes it by chance. Measured against the QR corpus, which contains no
    // linear barcodes at all, single-row acceptance produced a confident EAN-8
    // on 3 of 51 photographs: dense QR modules are alternating runs, and
    // occasionally eight of them satisfy both the pattern match and the check.
    //
    // A real barcode is many pixels tall and reads identically on every row
    // through it. A coincidence does not survive being asked twice, so
    // agreement across rows costs one more row of work and removes the failure
    // mode rather than reducing it.
    const seen = new Map<string, { match: LinearMatch; count: number }>();

    const middle = Math.floor(height / 2);
    // From the middle outwards: a label photographed deliberately sits near the
    // centre of frame, so the rows most likely to decode are tried first.
    for (let offset = 0; offset < height; offset += step) {
      if (spent()) return null;

      // At offset 0 both expressions are the middle row. Visiting it twice
      // would let a row corroborate ITSELF, which is exactly the agreement the
      // guard below is supposed to require from a second row.
      const candidates =
        offset === 0 ? [middle] : [middle + offset, middle - offset];

      for (const y of candidates) {
        if (y < 0 || y >= height) continue;

        const match = decodeRow(matrix, y);
        if (match === null) continue;

        const key = match.digits.join(``);
        const entry = seen.get(key);

        if (entry === undefined) {
          seen.set(key, { match, count: 1 });
          continue;
        }

        entry.count++;
        // Keep whichever row matched its patterns most cleanly, so the reported
        // bounds come from the best evidence rather than the first sighting.
        if (match.error < entry.match.error) entry.match = match;
        if (entry.count >= agreement) return entry.match;
      }
    }

    return null;
  };

  return {
    decode: (image: GrayImage): DecodedSymbol | null => {
      const started = performance.now();
      const spent = (): boolean =>
        timeBudgetMs > 0 && performance.now() - started > timeBudgetMs;

      // The same ladder the QR decoder uses, for the same reasons: local
      // thresholding follows uneven lighting across a curved can, global is
      // more faithful on a flat printed label, and a swept threshold covers
      // the images where neither is right. Ordered cheapest first.
      const passes = [
        () => binarize(image),
        () => binarizeGlobal(image),
        () => binarizeAt(image, 100),
        () => binarizeAt(image, 140),
        () => binarizeAt(image, 180)
      ];

      for (const prepare of passes) {
        if (spent()) return null;

        const match = sweep(prepare(), spent);
        if (match === null) continue;

        const format = formatOf(match.digits);
        if (!wanted.has(format)) continue;

        return {
          value: valueOf(match.digits, format),
          format,
          // A linear symbol has no corners in the QR sense — it is a band, not
          // a quadrilateral — so these bound the run that decoded. Enough to
          // draw an overlay, which is what a caller wants them for.
          cornerPoints: [
            { x: match.start, y: 0 },
            { x: match.end, y: 0 },
            { x: match.end, y: image.height },
            { x: match.start, y: image.height }
          ]
        };
      }

      return null;
    }
  };
};
