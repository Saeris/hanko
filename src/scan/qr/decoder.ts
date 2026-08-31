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
import { decodeMatrix } from "./decode-matrix.js";
import { findFinderPatterns, orientFinders } from "./locate.js";
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
  // Fewer than three means no symbol was found. More means either several
  // symbols or false positives; the first three are tried rather than giving
  // up, since a real symbol among clutter is a common case.
  if (patterns.length < 3) return null;

  const finders = orientFinders(patterns.slice(0, 3));
  if (finders === null) return null;

  const size = estimateSize(finders);
  if (size === null) return null;

  const bottomRight = estimateBottomRight(finders);
  const transform = transformForSymbol(finders, size, bottomRight);

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
