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

import { binarize, binarizeGlobal, blur } from "../binarize.js";
import type { DecodedSymbol, GrayImage, SymbolDecoder } from "../types.js";
import {
  estimateCornerFromEdges,
  locateAlignmentGrid,
  refineBottomRight
} from "./alignment.js";
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
  samplePiecewise,
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

  /**
   * Retry with a low-pass filter when the sharp pass finds nothing.
   *
   * On by default, and it is what makes a code on a SCREEN readable: moire
   * banding is frequency aliasing between the camera sensor and the display's
   * sub-pixel grid, so it sits at a higher spatial frequency than the modules
   * and blurs away while they survive. Measured on the benchmark corpus this
   * takes the `monitor` category from 0 of 25 to 10 of 25 — and since this
   * library's own device screen is scanned off a TV, that is not a niche case.
   *
   * A retry rather than a default pass, because the same filter destroys
   * already-blurry photographs: `blurred` drops from 5 of 14 to 1, `nominal`
   * from 3 to 0. Costs nothing on images that decode sharp.
   */
  retryBlurred?: boolean;
}

/** Try to decode one binarized image. */
const decodeBinarized = (
  image: GrayImage,
  invert: boolean,
  global = false
): DecodedSymbol | null => {
  const matrix = global
    ? binarizeGlobal(image, { invert })
    : binarize(image, { invert });

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

  const version = (size - 17) / 4;

  // Second pass: pin the fourth corner with the alignment pattern, when one
  // is findable. Three finders fix three corners; the fourth is the one the
  // perspective error accumulates towards, and on a 117-module symbol a one
  // percent error there is more than a module of drift — every module in that
  // region samples its neighbour. It is why `high_version` images locate
  // perfectly and decode not at all.
  const moduleSize =
    (finders.topLeft.moduleSize +
      finders.topRight.moduleSize +
      finders.bottomLeft.moduleSize) /
    3;

  // Three candidates for the fourth corner, tried in order of how much they
  // are trusted. Measured against a reference decoder, this one point is the
  // largest error in the pipeline: supplying a correct corner takes
  // `perspective` from 2 of 23 images to 7, `glare` from 2 of 17 to 7, and
  // `curved` from 18 of 36 to 27.
  //
  // Trying several rather than picking one is cheap — each attempt is a
  // sample and a decode, and a wrong grid fails fast at the format check —
  // and no single method wins everywhere: the alignment pattern is exact when
  // present and absent on small or damaged symbols, edge-following handles
  // perspective but needs a clean quiet zone, and the parallelogram is a poor
  // estimate that never fails outright.
  const candidates = [
    refineBottomRight(matrix, rough, finders, size, version, estimated),
    estimateCornerFromEdges(matrix, finders, moduleSize, estimated),
    estimated
  ];

  let transform = rough;
  let sampled = sampleGrid(matrix, rough, size);
  let decoded = sampled === null ? null : decodeMatrix(sampled);

  for (const corner of candidates) {
    if (decoded !== null) break;
    const candidateTransform = transformForSymbol(finders, size, corner);
    const candidateGrid = sampleGrid(matrix, candidateTransform, size);
    if (candidateGrid === null) continue;

    const candidateDecode = decodeMatrix(candidateGrid);
    if (candidateDecode !== null) {
      transform = candidateTransform;
      sampled = candidateGrid;
      decoded = candidateDecode;
    }
  }

  if (sampled === null) return null;

  // Flat sampling failed. On a large symbol that usually means the surface is
  // not flat: a page bows, and one homography models a plane. Measured on a
  // version 40 symbol with verifiably exact corners, interior alignment
  // patterns sat up to 1.09 modules from where the plane predicted — past
  // half a module, every sample lands on the wrong module.
  //
  // Alignment patterns are a grid of known points across the whole symbol, so
  // locating them measures the warp directly and each cell gets a transform
  // fitted to its own corners.
  if (decoded === null && version >= 7) {
    const grid = locateAlignmentGrid(
      matrix,
      transform,
      size,
      version,
      moduleSize
    );

    if (grid !== null) {
      const warped = samplePiecewise(
        matrix,
        size,
        grid.anchors,
        grid.positions,
        transform
      );
      if (warped !== null) decoded = decodeMatrix(warped);
    }
  }

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
  polarity = `both`,
  retryBlurred = true
}: QrDecoderOptions = {}): SymbolDecoder => {
  const attempt = (image: GrayImage): DecodedSymbol | null => {
    // Local binarization first, then global. Neither dominates: local follows
    // a shadow across a page and is what makes unevenly-lit photographs
    // readable at all, while global is more faithful on a clean image because
    // local thresholding invents structure in flat regions. zxing-cpp reached
    // the same conclusion — its issue #809 is an image its local binarizer
    // cannot read and its global one can.
    for (const global of [false, true]) {
      if (polarity !== `light-on-dark`) {
        const normal = decodeBinarized(image, false, global);
        if (normal !== null) return normal;
      }

      if (polarity !== `dark-on-light`) {
        const inverted = decodeBinarized(image, true, global);
        if (inverted !== null) return inverted;
      }
    }

    return null;
  };

  return {
    decode: (image: GrayImage): DecodedSymbol | null => {
      const sharp = attempt(image);
      if (sharp !== null || !retryBlurred) return sharp;

      // Radius scaled to the image rather than fixed: the aliasing frequency
      // depends on how many sensor pixels cover one screen pixel, which
      // depends on capture resolution.
      const radius = Math.max(
        2,
        Math.round(Math.min(image.width, image.height) / 500)
      );
      return attempt(blur(image, radius));
    }
  };
};
