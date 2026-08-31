/**
 * The QR decoder — pixels in, text out.
 *
 * Assembles the stages: binarize, locate the finders, orient them, estimate
 * the size, correct perspective, sample the grid, then hand the matrix to the
 * pure decoder that stage 1 proved correct.
 *
 * Both polarities are tried by default. That is not defensive coding: a symbol
 * rendered light-on-dark is invisible to a decoder that assumes the opposite,
 * and it fails as silence rather than as an error — camera running, frames
 * arriving, nothing ever decoding. Trying both costs one extra pass and
 * removes an entire class of unexplainable failure.
 */

import { binarize } from "../binarize.js";
import type { DecodedSymbol, GrayImage, SymbolDecoder } from "../types.js";
import { refineBottomRight } from "./alignment.js";
import { decodeMatrix } from "./decode-matrix.js";
import {
  findFinderPatterns,
  orientFinders,
  selectBestTriple
} from "./locate.js";
import {
  applyTransform,
  estimateBottomRight,
  estimateSize,
  sampleGrid,
  transformForSymbol
} from "./sample.js";

/** Options for {@link createQrDecoder}. */
export interface QrDecoderOptions {
  /**
   * Which polarities to attempt.
   *
   * `both` by default. `dark-on-light` is the conventional rendering and is
   * marginally faster; choose it only when you control every symbol the
   * scanner will ever see.
   */
  polarity?: `both` | `dark-on-light` | `light-on-dark`;
}

/** Try to decode one binarized image. */
const decodeBinarized = (
  image: GrayImage,
  invert: boolean
): DecodedSymbol | null => {
  const matrix = binarize(image, { invert });

  const patterns = findFinderPatterns(matrix);
  if (patterns.length < 3) return null;

  // Scored rather than taking the first three. Across the benchmark corpus
  // the rotations, high_version and brightness categories return MORE than
  // three candidates on nearly every image, so an arbitrary three discards
  // the right answer and loses a symbol that was successfully found.
  const triple = selectBestTriple(patterns);
  if (triple === null) return null;

  const finders = orientFinders(triple);
  if (finders === null) return null;

  const size = estimateSize(finders);
  if (size === null) return null;

  // First pass: assume the symbol is a parallelogram. Good enough to predict
  // roughly where the alignment pattern should be.
  const estimated = estimateBottomRight(finders);
  const rough = transformForSymbol(finders, size, estimated);

  // Second pass: pin the fourth corner with the alignment pattern, when one
  // is findable. Three finders fix three corners; the fourth is the one the
  // perspective error accumulates towards, and on a 117-module symbol a one
  // percent error there is more than a module of drift — every module in that
  // region samples its neighbour. It is why `high_version` images locate
  // perfectly and decode not at all.
  const version = (size - 17) / 4;
  const bottomRight = refineBottomRight(
    matrix,
    rough,
    finders,
    size,
    version,
    estimated
  );

  const transform =
    bottomRight === estimated
      ? rough
      : transformForSymbol(finders, size, bottomRight);

  const sampled = sampleGrid(matrix, transform, size);
  if (sampled === null) return null;

  const decoded = decodeMatrix(sampled);
  if (decoded === null) return null;

  // Corners in image space, for callers that draw an overlay.
  const corners = [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 }
  ].map((corner) => applyTransform(transform, corner.x, corner.y));

  return {
    value: decoded.value,
    format: `qr_code`,
    cornerPoints: corners
  };
};

/**
 * Create a QR decoder.
 *
 * The returned decoder is pure and synchronous: it holds no camera, no canvas,
 * and no DOM reference, which is what lets the same instance run on a worker,
 * a server, or in a test with no browser at all.
 */
export const createQrDecoder = ({
  polarity = `both`
}: QrDecoderOptions = {}): SymbolDecoder => ({
  decode: (image: GrayImage): DecodedSymbol | null => {
    if (polarity !== `light-on-dark`) {
      const normal = decodeBinarized(image, false);
      if (normal !== null) return normal;
    }

    if (polarity !== `dark-on-light`) {
      const inverted = decodeBinarized(image, true);
      if (inverted !== null) return inverted;
    }

    return null;
  }
});
