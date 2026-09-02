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

import {
  averageColumns,
  binarize,
  binarizeAt,
  binarizeGlobal
} from "../binarize.js";
import type {
  BarcodeFormat,
  BitMatrix,
  DecodedSymbol,
  GrayImage
} from "../types.js";
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
   * almost the same signal. Rows are spread evenly rather than clustered,
   * since a label can sit anywhere in frame.
   *
   * Two hundred and fifty-six, which is where the curve flattens. Measured on
   * the ArTe-Lab corpus's no-autofocus half — blurry hand-held photographs,
   * the hard case — recognition runs 18% at 24 rows, 26% at 64, 35% at 256
   * and 36% at 512, so the last doubling buys a point for half again the time.
   * Blurring, downscaling and enlarging each moved it by nothing.
   *
   * A blurry barcode has only a handful of rows where the runs resolve
   * cleanly, so the answer is to look at more of them rather than to process
   * any one of them harder. ZXing reaches the same conclusion from the other
   * direction: its `tryHarder` mode drops the row step from height/32 to
   * height/256.
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
   * Four by default, which is a deliberate trade of recognition for silence
   * about what it is unsure of.
   *
   * Measured across the whole ArTe-Lab corpus, at 256 rows:
   *
   * | rows agreeing | correct (AF) | wrong | correct (no AF) | wrong |
   * | ------------- | ------------ | ----- | --------------- | ----- |
   * | 2             | 91.6%        | 2     | 28.8%           | 5     |
   * | 3             | 91.2%        | 0     | 27.9%           | 2     |
   * | 4             | 90.7%        | 0     | 26.0%           | 0     |
   *
   * So going from two to four costs about a point on focused images and three
   * on blurry ones, and removes all seven misreads. That is the right way
   * round for anything that looks a code up: a wrong GTIN sends someone to the
   * wrong product with no sign anything went awry, while a scan that returns
   * nothing just means pointing the camera again.
   *
   * Lower it only where a wrong answer is cheap.
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
 * Turn columns into rows.
 *
 * The scan only walks horizontally, so a barcode printed down the frame is
 * invisible to it. Rotating the bits a quarter turn is cheaper than teaching
 * the sweep to walk in two directions, and keeps the scanline code to the one
 * case it is good at.
 */
const transpose = (matrix: BitMatrix): BitMatrix => {
  const { width, height, bits } = matrix;
  const out = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      out[x * height + (height - 1 - y)] = bits[row + x];
    }
  }

  return { bits: out, width: height, height: width };
};

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
  rows = 256,
  formats = ALL_FORMATS,
  agreement = 4
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

        // EAN-8 is held to a higher bar than the thirteen-digit forms.
        //
        // Eight digits is a much weaker claim: fewer runs to match and the
        // same one-in-ten check digit, so ordinary dense artwork satisfies it
        // far more often. Every false positive measured against the QR corpus
        // — which contains no linear barcodes at all — has been an EAN-8, both
        // before the agreement guard existed and again when transposing gave
        // the sweep a second set of runs to find coincidences in.
        const needed = match.digits.length === 8 ? agreement * 2 : agreement;
        if (entry.count >= needed) return entry.match;
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
        () => binarizeAt(image, 180),
        // Sideways, last. Someone photographing a bottle holds it whichever
        // way is comfortable, and a barcode running down the frame has no
        // horizontal row crossing all of it — transposing turns its columns
        // into rows and the existing sweep does the rest.
        //
        // Worth 2 points on the corpus's focused half and nothing on the
        // blurry one, which understates it: these are photographs taken to
        // BE a barcode dataset, so they are almost all upright. A phone in a
        // shop is not so tidy.
        () => transpose(binarize(image)),
        // Averaged down its columns, which is the one filter that helps a
        // defocused barcode. See `averageColumns`: a barcode is constant
        // vertically, so this averages repeated measurements of the same bar
        // rather than smearing neighbouring ones together. Worth 3 points on
        // the corpus's blurry half; last because it is a full extra pass.
        () => binarize(averageColumns(image))
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
