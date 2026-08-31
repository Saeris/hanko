/**
 * Turning a located symbol into a clean module grid.
 *
 * A QR photographed off a table or a screen is never a square: it is a
 * quadrilateral, because the camera was not perpendicular to it. Sampling that
 * on a regular grid reads the wrong module wherever the distortion accumulates
 * — and it accumulates most at the far corner, which is where the data is
 * densest.
 *
 * So the four corners are mapped to a unit square with a projective transform,
 * and the grid is sampled through it. That is the difference between reading a
 * code held at a comfortable angle and only reading codes held flat.
 */

import type { BitMatrix, Point } from "../types.js";
import type { FinderTriple } from "./locate.js";

/**
 * A projective (homography) transform between two quadrilaterals.
 *
 * Affine is not enough. An affine transform preserves parallel lines, and
 * perspective does not — the far edge of a tilted square is genuinely shorter
 * than the near one. Only a projective transform models that, which is why
 * this carries the two extra terms an affine matrix lacks.
 */
export interface Transform {
  readonly a11: number;
  readonly a12: number;
  readonly a13: number;
  readonly a21: number;
  readonly a22: number;
  readonly a23: number;
  readonly a31: number;
  readonly a32: number;
  readonly a33: number;
}

/** Map a point through a transform, dividing out the homogeneous coordinate. */
export const applyTransform = (
  transform: Transform,
  x: number,
  y: number
): Point => {
  const denominator = transform.a13 * x + transform.a23 * y + transform.a33;

  // A zero denominator means the point maps to infinity — a degenerate
  // transform, which happens when the four source points are collinear.
  if (denominator === 0) return { x: 0, y: 0 };

  return {
    x: (transform.a11 * x + transform.a21 * y + transform.a31) / denominator,
    y: (transform.a12 * x + transform.a22 * y + transform.a32) / denominator
  };
};

/**
 * Build the transform taking the unit square to an arbitrary quadrilateral.
 *
 * The standard construction: solve for how much the quadrilateral deviates
 * from a parallelogram, which is exactly what the two projective terms encode.
 */
const squareToQuadrilateral = (
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point
): Transform => {
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy3 = p0.y - p1.y + p2.y - p3.y;

  // No deviation means the shape is a parallelogram, so the transform is
  // affine and the projective terms vanish.
  if (dx3 === 0 && dy3 === 0) {
    return {
      a11: p1.x - p0.x,
      a12: p1.y - p0.y,
      a13: 0,
      a21: p2.x - p1.x,
      a22: p2.y - p1.y,
      a23: 0,
      a31: p0.x,
      a32: p0.y,
      a33: 1
    };
  }

  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const denominator = dx1 * dy2 - dx2 * dy1;

  if (denominator === 0) {
    // Degenerate quadrilateral — the points are collinear. Identity keeps the
    // caller from producing NaNs; the sample will simply fail to decode.
    return {
      a11: 1,
      a12: 0,
      a13: 0,
      a21: 0,
      a22: 1,
      a23: 0,
      a31: 0,
      a32: 0,
      a33: 1
    };
  }

  const a13 = (dx3 * dy2 - dx2 * dy3) / denominator;
  const a23 = (dx1 * dy3 - dx3 * dy1) / denominator;

  return {
    a11: p1.x - p0.x + a13 * p1.x,
    a12: p1.y - p0.y + a13 * p1.y,
    a13,
    a21: p3.x - p0.x + a23 * p3.x,
    a22: p3.y - p0.y + a23 * p3.y,
    a23,
    a31: p0.x,
    a32: p0.y,
    a33: 1
  };
};

/**
 * The transform from module coordinates to image coordinates.
 *
 * Built from three finder centres plus an estimated fourth corner. The three
 * finders are at fixed module positions in every QR — (3.5, 3.5), (size-3.5,
 * 3.5) and (3.5, size-3.5) — so they pin three corners exactly.
 */
export const transformForSymbol = (
  finders: FinderTriple,
  size: number,
  bottomRight: Point
): Transform => {
  const offset = 3.5;
  const far = size - 3.5;

  // The unit square here spans FINDER CENTRES, not the symbol's outer edge:
  // its corners are module coordinates (3.5, 3.5) to (size - 3.5, size - 3.5).
  // `sampleGrid` has to map module indices into that range rather than
  // treating (0, 0) as the corner of the symbol — getting this wrong offsets
  // every sample by 3.5 modules and reads a plausible grid of nonsense.
  void offset;
  void far;

  return squareToQuadrilateral(
    finders.topLeft.center,
    finders.topRight.center,
    bottomRight,
    finders.bottomLeft.center
  );
};

/**
 * Estimate the fourth corner, which has no finder pattern.
 *
 * Larger symbols carry an alignment pattern near it, and using that is more
 * accurate. Without one, the corner is where the two arms of the L would meet
 * if the symbol were a parallelogram — good enough for small symbols, where
 * accumulated perspective error stays under half a module.
 */
export const estimateBottomRight = (finders: FinderTriple): Point => ({
  x:
    finders.topRight.center.x +
    finders.bottomLeft.center.x -
    finders.topLeft.center.x,
  y:
    finders.topRight.center.y +
    finders.bottomLeft.center.y -
    finders.topLeft.center.y
});

/**
 * Estimate the symbol's size in modules.
 *
 * Derived from the distance between finder centres divided by the module size,
 * then snapped to the nearest legal dimension. Snapping is essential: sizes
 * are always 4n+17, and an off-by-one estimate misaligns every sampled module.
 */
export const estimateSize = (finders: FinderTriple): number | null => {
  const distance = Math.hypot(
    finders.topRight.center.x - finders.topLeft.center.x,
    finders.topRight.center.y - finders.topLeft.center.y
  );
  const moduleSize =
    (finders.topLeft.moduleSize + finders.topRight.moduleSize) / 2;
  if (moduleSize <= 0) return null;

  // The finder centres are 7 modules apart from the symbol edges, so the
  // distance between them spans (size - 7) modules.
  const estimate = distance / moduleSize + 7;
  const snapped = Math.round((estimate - 17) / 4) * 4 + 17;

  return snapped >= 21 && snapped <= 177 ? snapped : null;
};

/**
 * Sample the symbol into a clean module grid.
 *
 * Each module is read at its centre, mapped through the transform. Reading
 * centres rather than averaging whole cells is deliberate: at the distances a
 * phone actually scans from, a module is a handful of pixels, and averaging
 * pulls in its neighbours' ink.
 */
export const sampleGrid = (
  image: BitMatrix,
  transform: Transform,
  size: number
): BitMatrix | null => {
  const bits = new Uint8Array(size * size);

  // The transform's unit square spans finder CENTRES — module (3.5, 3.5) to
  // (size - 3.5, size - 3.5) — so a module index has to be mapped into that
  // range. Dividing by `size` instead treats the unit square as the symbol's
  // outer edge, which shifts every sample by 3.5 modules: the finders still
  // land, the grid still fills, and the result decodes to nothing.
  const span = size - 7;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // +0.5 samples the module's centre; -3.5 rebases onto the finder centre.
      const source = applyTransform(
        transform,
        (x + 0.5 - 3.5) / span,
        (y + 0.5 - 3.5) / span
      );

      const sx = Math.round(source.x);
      const sy = Math.round(source.y);

      // A symbol partly outside the frame cannot be decoded, and sampling
      // clamped edge pixels would produce a plausible-looking matrix of
      // nonsense rather than an honest failure.
      if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) {
        return null;
      }

      bits[y * size + x] = image.bits[sy * image.width + sx]!;
    }
  }

  return { bits, width: size, height: size };
};
