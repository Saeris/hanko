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

import type { BitMatrix, GrayImage, Point } from "../types.js";
import {
  cornersAlongAxes,
  finderOutline,
  type FinderTriple
} from "./locate.js";

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
/**
 * Where the sensor stops recording and starts clipping.
 *
 * Not 255 and 0 exactly: JPEG compression and the greyscale conversion move
 * clipped pixels by a few counts either way, so a strict test would miss most
 * of a blown-out region. 250 and 5 catch the shoulder without reaching into
 * ordinary highlights and shadows, which routinely sit in the 230s.
 */
const SATURATED_HIGH = 250;
const SATURATED_LOW = 5;

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
 * Fit a transform to more correspondences than it strictly needs.
 *
 * {@link transformForSymbol} solves exactly: four source points, four
 * destination points, one answer. That is fine when all four are measured,
 * and this symbol only ever has three — the fourth corner has no finder and
 * is estimated, so a guess is baked into every sample the grid takes.
 *
 * Measuring each finder's outer square instead gives four points per finder
 * and twelve in total, which over-determines an eight-parameter homography.
 * Least squares then averages the noise across all twelve rather than
 * propagating one bad estimate through everything, and no corner has to be
 * invented.
 *
 * Solved by the Direct Linear Transform: each correspondence contributes two
 * rows, and the resulting system is reduced through its normal equations.
 * Eight unknowns makes that an 8x8 solve, which is small enough that the
 * numerical cost of normal equations does not matter and their simplicity
 * does.
 *
 * Returns `null` when the system is singular — collinear points, or a
 * degenerate outline.
 */
export const fitTransform = (
  correspondences: ReadonlyArray<{
    /** Position in the unit square that spans finder centres. */
    readonly source: Point;
    /** Where that lands in the image. */
    readonly target: Point;
  }>
): Transform | null => {
  if (correspondences.length < 4) return null;

  // Normal equations: an 8x8 system with a right-hand column.
  const normal = Array.from({ length: 8 }, () => new Float64Array(9));

  const accumulate = (row: readonly number[]): void => {
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) normal[i][j] += row[i] * row[j];
      normal[i][8] += row[i] * row[8];
    }
  };

  for (const { source, target } of correspondences) {
    accumulate([
      source.x,
      source.y,
      1,
      0,
      0,
      0,
      -source.x * target.x,
      -source.y * target.x,
      target.x
    ]);
    accumulate([
      0,
      0,
      0,
      source.x,
      source.y,
      1,
      -source.x * target.y,
      -source.y * target.y,
      target.y
    ]);
  }

  // Gauss-Jordan with partial pivoting.
  for (let column = 0; column < 8; column++) {
    let pivot = column;
    for (let row = column + 1; row < 8; row++) {
      if (Math.abs(normal[row][column]) > Math.abs(normal[pivot][column])) {
        pivot = row;
      }
    }
    if (Math.abs(normal[pivot][column]) < 1e-12) return null;

    const swap = normal[column];
    normal[column] = normal[pivot];
    normal[pivot] = swap;

    for (let row = 0; row < 8; row++) {
      if (row === column) continue;
      const factor = normal[row][column] / normal[column][column];
      for (let j = column; j < 9; j++) {
        normal[row][j] -= factor * normal[column][j];
      }
    }
  }

  const h = Array.from({ length: 8 }, (_, i) => normal[i][8] / normal[i][i]);
  if (h.some((value) => !Number.isFinite(value))) return null;

  // Transposed relative to the textbook layout, matching `applyTransform`:
  // x' = (a11*x + a21*y + a31) / (a13*x + a23*y + a33).
  return {
    a11: h[0],
    a21: h[1],
    a31: h[2],
    a12: h[3],
    a22: h[4],
    a32: h[5],
    a13: h[6],
    a23: h[7],
    a33: 1
  };
};

/**
 * Build a transform from the finders' measured outer squares.
 *
 * Each finder's outer ring is 7 modules on a side at a known symbol position,
 * so its four corners are four correspondences. Three finders give twelve,
 * which {@link fitTransform} solves in the least-squares sense — no estimated
 * fourth corner enters the fit at all.
 *
 * Returns `null` if any finder's outline cannot be traced, so the caller can
 * fall back to the three-centre transform.
 */
export const transformFromOutlines = (
  matrix: BitMatrix,
  finders: FinderTriple,
  size: number
): Transform | null => {
  const span = size - 7;

  // Symbol axes, for ordering each outline's corners. Image axes would pair
  // corners with the wrong module coordinates on a rotated symbol.
  const across = {
    x: finders.topRight.center.x - finders.topLeft.center.x,
    y: finders.topRight.center.y - finders.topLeft.center.y
  };
  const down = {
    x: finders.bottomLeft.center.x - finders.topLeft.center.x,
    y: finders.bottomLeft.center.y - finders.topLeft.center.y
  };

  const acrossLength = Math.hypot(across.x, across.y);
  const downLength = Math.hypot(down.x, down.y);
  if (acrossLength === 0 || downLength === 0) return null;

  const u = { x: across.x / acrossLength, y: across.y / acrossLength };
  const v = { x: down.x / downLength, y: down.y / downLength };

  const correspondences: Array<{ source: Point; target: Point }> = [];

  // Module coordinate of each finder's top-left corner.
  const placements = [
    { finder: finders.topLeft, x: 0, y: 0 },
    { finder: finders.topRight, x: size - 7, y: 0 },
    { finder: finders.bottomLeft, x: 0, y: size - 7 }
  ];

  for (const { finder, x, y } of placements) {
    const outline = finderOutline(matrix, finder);
    if (outline === null) return null;

    const corners = cornersAlongAxes(outline, u, v);
    const modules = [
      { x, y },
      { x: x + 7, y },
      { x: x + 7, y: y + 7 },
      { x, y: y + 7 }
    ];

    for (const [index, module] of modules.entries()) {
      correspondences.push({
        // Rebased onto the same unit square `sampleGrid` samples in, whose
        // corners are module (3.5, 3.5) and (size - 3.5, size - 3.5).
        source: {
          x: (module.x - 3.5) / span,
          y: (module.y - 3.5) / span
        },
        target: corners[index]
      });
    }
  }

  return fitTransform(correspondences);
};

/**
 * Measure the symbol's size by counting timing-pattern transitions.
 *
 * {@link estimateSize} divides the finder span by the module size, which
 * multiplies any error in the module size by the module count. Under strong
 * foreshortening the finder's own run lengths are inflated — the near arm
 * measures wider than the far one — so the quotient lands on the wrong
 * multiple of four, or outside the legal range entirely. Measured on the
 * corpus, `estimateSize` returns null on 7 of the 22 remaining `perspective`
 * failures.
 *
 * The timing pattern answers the question directly. It alternates once per
 * module across the whole symbol, so COUNTING its transitions gives the module
 * count with no division and no dependence on any measured width — a
 * compressed timing pattern still alternates exactly as many times.
 *
 * The scan line has to be found rather than assumed: its offset from the
 * finder centres is itself measured in module widths, which is the quantity in
 * doubt. So several offsets are swept and the one whose runs are most uniform
 * wins — the timing pattern is the one line in a symbol whose runs are all a
 * single module long, which no row of data matches.
 *
 * Worth noting for anyone re-deriving this: measured BEFORE the twelve-point
 * outline fit existed, this technique converted nothing, because every image
 * it fixed then failed later anyway. It is worth 8 images now. A fix aimed at
 * a constraint that is not yet binding measures as worthless even when it is
 * correct.
 */
export const sizeFromTimingPattern = (
  matrix: BitMatrix,
  finders: FinderTriple
): number | null => {
  const { topLeft, topRight, bottomLeft } = finders;

  const down = {
    x: bottomLeft.center.x - topLeft.center.x,
    y: bottomLeft.center.y - topLeft.center.y
  };
  const downLength = Math.hypot(down.x, down.y);
  if (downLength === 0) return null;

  const unitX = down.x / downLength;
  const unitY = down.y / downLength;
  const module = (topLeft.moduleSize + topRight.moduleSize) / 2;
  if (module <= 0) return null;

  let best: { runs: number; deviation: number } | null = null;

  // The timing row sits 2.5 modules below the finder centres in principle.
  // Swept rather than assumed, because that offset is measured in the very
  // module width this function exists to avoid trusting.
  for (let offset = 1.2; offset <= 4; offset += 0.15) {
    const shiftX = unitX * module * offset;
    const shiftY = unitY * module * offset;

    const runs = runLengthsAlong(
      matrix,
      topLeft.center.x + shiftX,
      topLeft.center.y + shiftY,
      topRight.center.x + shiftX,
      topRight.center.y + shiftY
    );
    if (runs === null || runs.length < 12) continue;

    // Ignore the ends, which straddle the finders rather than the timing row.
    const interior = runs.slice(2, -2);
    if (interior.length < 8) continue;

    const mean =
      interior.reduce((total, run) => total + run, 0) / interior.length;
    if (mean <= 0) continue;

    const variance =
      interior.reduce((total, run) => total + (run - mean) ** 2, 0) /
      interior.length;
    const deviation = Math.sqrt(variance) / mean;

    if (best === null || deviation < best.deviation) {
      best = { runs: runs.length, deviation };
    }
  }

  if (best === null) return null;

  // The scan spans finder centre to finder centre: the run count covers the
  // modules between them, and the finders themselves add the rest.
  const estimate = best.runs + 11;
  const snapped = Math.round((estimate - 17) / 4) * 4 + 17;
  return snapped >= 21 && snapped <= 177 ? snapped : null;
};

/** Lengths of the constant-colour runs along a line, or null if it leaves the image. */
const runLengthsAlong = (
  matrix: BitMatrix,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number
): number[] | null => {
  const steps = Math.round(Math.hypot(toX - fromX, toY - fromY));
  if (steps < 10) return null;

  const runs: number[] = [];
  let previous: number | null = null;
  let length = 0;

  for (let i = 0; i <= steps; i++) {
    const x = Math.round(fromX + ((toX - fromX) * i) / steps);
    const y = Math.round(fromY + ((toY - fromY) * i) / steps);
    if (x < 0 || y < 0 || x >= matrix.width || y >= matrix.height) return null;

    const value = matrix.bits[y * matrix.width + x];
    if (previous === null) {
      previous = value;
      length = 1;
      continue;
    }

    if (value === previous) {
      length++;
    } else {
      runs.push(length);
      previous = value;
      length = 1;
    }
  }

  runs.push(length);
  return runs;
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
  // Derived from each arm of the finder triangle separately, then the smaller
  // estimate taken.
  //
  // A QR is square, so both arms span the same number of modules — but under
  // perspective they do not span the same number of PIXELS, and the finders on
  // the far arm are foreshortened, which shrinks their measured module size.
  // Since size is distance divided by module size, that inflates the estimate,
  // and only ever upward.
  //
  // Measured on a corpus sequence shot at progressively steeper angles, the
  // averaged estimate climbed 25, 29, 33, 37, 41, 45, 49 against a true 25,
  // while the less-foreshortened arm read 25 throughout. Taking the minimum is
  // right nine times in twelve where averaging was right four.
  const alongTop = Math.hypot(
    finders.topRight.center.x - finders.topLeft.center.x,
    finders.topRight.center.y - finders.topLeft.center.y
  );
  const alongLeft = Math.hypot(
    finders.bottomLeft.center.x - finders.topLeft.center.x,
    finders.bottomLeft.center.y - finders.topLeft.center.y
  );

  // Rotation widens run-length measurements: a horizontal scan crosses a
  // rotated finder diagonally, so its runs read 1/cos(angle) too long — 1.41x
  // at 45 degrees. The finders supply the angle, since the top arm's tilt off
  // axis IS the rotation the scan suffered.
  const angle = Math.atan2(
    finders.topRight.center.y - finders.topLeft.center.y,
    finders.topRight.center.x - finders.topLeft.center.x
  );
  const folded = Math.abs(
    ((angle % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2)
  );
  const widening =
    1 / Math.max(Math.cos(folded), Math.cos(Math.PI / 2 - folded));

  const moduleAlongTop =
    (finders.topLeft.moduleSize + finders.topRight.moduleSize) / 2 / widening;
  const moduleAlongLeft =
    (finders.topLeft.moduleSize + finders.bottomLeft.moduleSize) / 2 / widening;
  if (moduleAlongTop <= 0 || moduleAlongLeft <= 0) return null;

  // The finder centres sit 3.5 modules inside each edge, so an arm spans
  // (size - 7) modules.
  const estimate = Math.min(
    alongTop / moduleAlongTop + 7,
    alongLeft / moduleAlongLeft + 7
  );
  const snapped = Math.round((estimate - 17) / 4) * 4 + 17;

  return snapped >= 21 && snapped <= 177 ? snapped : null;
};

/**
 * Resample the image so the symbol is square and its modules uniform.
 *
 * A projective transform already corrects perspective during sampling, so
 * this is not about geometry — it is about what the BINARIZER sees. In an
 * oblique photograph a module at the far edge is a fraction of the size it is
 * near the camera, and one block size cannot suit both. Measured on the
 * `perspective` category, images that fail have a mean leg ratio of 1.58 and
 * modules down to 2.4 pixels at the far edge, against 1.14 and 7.5 for those
 * that decode.
 *
 * Rectifying first makes every module the same size, so binarization,
 * finder detection and everything downstream run on an image whose scale is
 * uniform. This is the automatic form of Lightroom's Guided Upright: that
 * tool needs a person to draw the guides because nothing in a photograph
 * says what was straight, while a QR tells us — its three finder centres sit
 * at module coordinates the specification fixes.
 *
 * Sampled bilinearly rather than nearest-neighbour, because the point is to
 * recover the far edge: replicating nearest pixels would upsample without
 * adding anything.
 */
export const rectifySymbol = (
  image: GrayImage,
  finders: FinderTriple,
  size: number,
  pixelsPerModule = 8
): GrayImage => {
  const topLeft = finders.topLeft.center;
  const topRight = finders.topRight.center;
  const bottomLeft = finders.bottomLeft.center;

  // The fourth corner only frames the output here; any error in it is
  // corrected by re-detecting on the rectified image.
  const bottomRight = {
    x: topRight.x + bottomLeft.x - topLeft.x,
    y: topRight.y + bottomLeft.y - topLeft.y
  };

  const span = size - 7;
  // Half a finder plus a four-module quiet zone, so the output contains the
  // whole symbol with the margin detection expects.
  const padding = 7.5;
  const width = Math.round((span + padding * 2) * pixelsPerModule);
  const data = new Uint8ClampedArray(width * width).fill(255);

  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const u = (x / pixelsPerModule - padding) / span;
      const v = (y / pixelsPerModule - padding) / span;

      const sx =
        (1 - u) * (1 - v) * topLeft.x +
        u * (1 - v) * topRight.x +
        u * v * bottomRight.x +
        (1 - u) * v * bottomLeft.x;
      const sy =
        (1 - u) * (1 - v) * topLeft.y +
        u * (1 - v) * topRight.y +
        u * v * bottomRight.y +
        (1 - u) * v * bottomLeft.y;

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= image.width || y0 + 1 >= image.height) {
        continue;
      }

      const fx = sx - x0;
      const fy = sy - y0;
      const at = (px: number, py: number): number =>
        image.data[py * image.width + px];

      data[y * width + x] =
        (1 - fx) * (1 - fy) * at(x0, y0) +
        fx * (1 - fy) * at(x0 + 1, y0) +
        (1 - fx) * fy * at(x0, y0 + 1) +
        fx * fy * at(x0 + 1, y0 + 1);
    }
  }

  return { data, width, height: width };
};

/**
 * Score how well a transform explains the symbol it claims to describe.
 *
 * A QR contains structures whose positions are fixed by the standard: three
 * finder patterns, two timing lines, and a grid of alignment patterns. If a
 * transform is right, sampling those positions finds those structures. If it
 * is slightly wrong, they blur or vanish — and the score falls off smoothly,
 * which is what makes it usable as a search signal rather than a pass/fail
 * check.
 *
 * Crucially this needs NO ground truth. It asks only whether the symbol is
 * self-consistent under the proposed geometry, so it can drive a search on a
 * live camera frame.
 *
 * Adapted from quirc's `fitness_all`, which is the same idea implemented in
 * about 2700 lines of C for embedded use.
 */
export const scoreTransform = (
  image: BitMatrix,
  transform: Transform,
  size: number,
  alignmentCenters: readonly number[]
): number => {
  const span = size - 7;

  /**
   * Sample one module at nine points across its interior.
   *
   * A single centre sample is a coin flip when the transform is half a module
   * out. Nine samples at 0.3/0.5/0.7 of the module's width turn that into a
   * gradient: a slightly-wrong transform scores lower rather than randomly,
   * and that gradient is what a search can follow.
   */
  // Hoisted out of the loop: these are read nine times per call and this
  // function is the hottest in the decoder — 46% of all CPU time, measured
  // with deoptkit.
  const { bits, width, height } = image;
  const { a11, a12, a13, a21, a22, a23, a31, a32, a33 } = transform;

  /**
   * One sample at a fractional module offset, inlined.
   *
   * Takes normalised coordinates rather than module ones, so the caller can
   * hoist the `(m - 3.5) / span` conversion: `cell` samples three distinct x
   * offsets against three y offsets, so computing them per sample does nine
   * divisions where six suffice.
   */
  const sampleAt = (u: number, v: number): number => {
    const w = a13 * u + a23 * v + a33;
    if (w === 0) return 0;

    // `| 0` after adding 0.5 rather than Math.round: rounding was one of two
    // eager deopts here ("minus zero"), and the coordinates are always
    // positive inside the guard below.
    const px = ((a11 * u + a21 * v + a31) / w + 0.5) | 0;
    const py = ((a12 * u + a22 * v + a32) / w + 0.5) | 0;

    if (px < 0 || py < 0 || px >= width || py >= height) return 0;
    return bits[py * width + px] === 1 ? 1 : -1;
  };

  const cell = (x: number, y: number): number => {
    // Unrolled, with the coordinate conversion hoisted. The array-literal
    // form allocated two arrays and ran two iterator protocols per call —
    // `Symbol.iterator`, `next`, `done`, `value` — and this runs hundreds of
    // times per scored transform, with 1875 transforms scored per image.
    //
    // Nine samples rather than five: five measured identical accuracy on the
    // corpus for 8% less time, which is not worth deviating from the sampling
    // quirc proved. The 8% is itself informative — cutting the sampler's work
    // by 44% barely moved total time, so the constraint is how many attempts
    // the ladder makes, not what each sample costs.
    const x3 = (x + 0.3 - 3.5) / span;
    const x5 = (x + 0.5 - 3.5) / span;
    const x7 = (x + 0.7 - 3.5) / span;
    const y3 = (y + 0.3 - 3.5) / span;
    const y5 = (y + 0.5 - 3.5) / span;
    const y7 = (y + 0.7 - 3.5) / span;

    return (
      sampleAt(x3, y3) +
      sampleAt(x5, y3) +
      sampleAt(x7, y3) +
      sampleAt(x3, y5) +
      sampleAt(x5, y5) +
      sampleAt(x7, y5) +
      sampleAt(x3, y7) +
      sampleAt(x5, y7) +
      sampleAt(x7, y7)
    );
  };

  /** The square ring `radius` modules out from a centre. */
  const ring = (cx: number, cy: number, radius: number): number => {
    let score = 0;
    for (let i = 0; i < radius * 2; i++) {
      score += cell(cx - radius + i, cy - radius);
      score += cell(cx - radius, cy + radius - i);
      score += cell(cx + radius, cy - radius + i);
      score += cell(cx + radius - i, cy + radius);
    }
    return score;
  };

  // A finder is dark centre, dark ring, LIGHT ring, dark ring — so the middle
  // ring is subtracted. Signs encode the structure being looked for.
  const finder = (x: number, y: number): number =>
    cell(x + 3, y + 3) +
    ring(x + 3, y + 3, 1) -
    ring(x + 3, y + 3, 2) +
    ring(x + 3, y + 3, 3);

  // An alignment pattern is dark centre, light ring, dark ring.
  const alignment = (cx: number, cy: number): number =>
    cell(cx, cy) - ring(cx, cy, 1) + ring(cx, cy, 2);

  let score = 0;

  // Timing patterns alternate, so the expected value flips each module.
  for (let i = 0; i < size - 14; i++) {
    const expected = (i & 1) === 1 ? 1 : -1;
    score += cell(i + 7, 6) * expected;
    score += cell(6, i + 7) * expected;
  }

  score += finder(0, 0);
  score += finder(size - 7, 0);
  score += finder(0, size - 7);

  // Alignment patterns, skipping the row and column that overlap finders.
  for (let i = 1; i + 1 < alignmentCenters.length; i++) {
    score += alignment(6, alignmentCenters[i]);
    score += alignment(alignmentCenters[i], 6);
  }
  for (let i = 1; i < alignmentCenters.length; i++) {
    for (let j = 1; j < alignmentCenters.length; j++) {
      score += alignment(alignmentCenters[i], alignmentCenters[j]);
    }
  }

  return score;
};

/**
 * Nudge a transform toward a better fit, keeping only improvements.
 *
 * Coordinate descent over the transform's eight free parameters, halving the
 * step each pass. Cheap, derivative-free, and it cannot make things worse
 * because a step is reverted unless it scores higher.
 *
 * This is what closes the loop that measurement kept pointing at: on the
 * corpus, symbols repeatedly located correctly to within a module still
 * failed to decode, and no single corner estimate fixed them. Rather than
 * compute a better corner, this searches for one — the score says which
 * direction is better without knowing the answer.
 *
 * From quirc's `jiggle_perspective`.
 */
export const refineTransform = (
  image: BitMatrix,
  transform: Transform,
  size: number,
  alignmentCenters: readonly number[]
): Transform => {
  const keys = [
    `a11`,
    `a12`,
    `a13`,
    `a21`,
    `a22`,
    `a23`,
    `a31`,
    `a32`
  ] as const;

  // Coefficients in a typed array rather than an object mutated by string
  // key. The object form made every read and write a dictionary-mode named
  // access on the decoder's hottest path — `scoreTransform` accounts for 40%
  // of CPU on a noisy frame — and V8 reported "insufficient type feedback for
  // generic named access" against it. Indexed access on a Float64Array is
  // monomorphic and allocates nothing.
  const values = new Float64Array(8);
  for (let i = 0; i < 8; i++) values[i] = transform[keys[i]];

  const asTransform = (): Transform => ({
    a11: values[0],
    a12: values[1],
    a13: values[2],
    a21: values[3],
    a22: values[4],
    a23: values[5],
    a31: values[6],
    a32: values[7],
    a33: transform.a33
  });

  let best = scoreTransform(image, transform, size, alignmentCenters);

  // Two percent of each parameter's own magnitude, so the step suits both the
  // large translation terms and the small projective ones.
  const steps = new Float64Array(8);
  for (let i = 0; i < 8; i++) steps[i] = Math.abs(values[i]) * 0.02;

  for (let pass = 0; pass < 5; pass++) {
    for (let index = 0; index < 8; index++) {
      for (const direction of [1, -1]) {
        const previous = values[index];
        values[index] = previous + steps[index] * direction;

        const score = scoreTransform(
          image,
          asTransform(),
          size,
          alignmentCenters
        );

        if (score > best) {
          best = score;
        } else {
          values[index] = previous;
        }
      }
    }

    for (let i = 0; i < 8; i++) steps[i] *= 0.5;
  }

  return asTransform();
};

/**
 * Search for the fourth corner by fitness rather than computing it.
 *
 * Every attempt to derive this corner from geometry has fallen short: the
 * parallelogram assumption ignores perspective, edge-following measured no
 * better, and the alignment pattern is often missing on the symbols that need
 * it most. Meanwhile supplying a known-good corner takes the `perspective`
 * category from 2 of 23 images to 7, so the information IS recoverable — it
 * just is not derivable.
 *
 * So it is searched for. {@link scoreTransform} can rank a candidate without
 * knowing the answer, which turns this into an optimisation rather than a
 * derivation.
 *
 * The step size matters more than the range. The corner error has a median of
 * 1.6 modules on that category, so a coarse grid straddles the answer and
 * never lands on it: a two-module step recovered nothing, and a half-module
 * step recovered all five. That is why this searches finely over a modest
 * range rather than coarsely over a wide one.
 */
export const searchCorner = (
  image: BitMatrix,
  finders: FinderTriple,
  size: number,
  moduleSize: number,
  alignmentCenters: readonly number[],
  estimate: Point,
  /**
   * Abandon the search when this returns true.
   *
   * Scoring 625 transforms is the single longest uninterrupted stretch in the
   * decoder, and a budget checked only BETWEEN stages cannot bound it —
   * measured, a 40ms budget produced a 209ms block and a 400ms budget a 603ms
   * one. A budget that does not bound latency is not a budget.
   */
  exhausted?: () => boolean
): Transform[] => {
  const scored: Array<{ score: number; transform: Transform }> = [];

  for (let dy = -6; dy <= 6; dy += 0.5) {
    // Checked per row rather than per candidate: 25 checks instead of 625,
    // bounding the overrun to one row's work — under a millisecond.
    if (exhausted?.() === true) break;

    for (let dx = -6; dx <= 6; dx += 0.5) {
      const corner = {
        x: estimate.x + dx * moduleSize,
        y: estimate.y + dy * moduleSize
      };
      const transform = transformForSymbol(finders, size, corner);
      scored.push({
        score: scoreTransform(image, transform, size, alignmentCenters),
        transform
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  // The best few, not the single best. The score is a good ranking and not a
  // perfect one — it prefers the corner that decodes on six images in eight,
  // which is worth several decode attempts but not blind trust.
  return scored.slice(0, 8).map((entry) => entry.transform);
};

/**
 * Sample using local transforms fitted per region — piecewise sampling.
 *
 * A single homography models a FLAT quadrilateral. A photographed QR is
 * usually on paper, and paper is never flat: it bows, curls, or lies over
 * something. Measured on a version 40 symbol whose four corners were verified
 * exact, the interior alignment patterns sit up to **1.09 modules** away from
 * where the homography predicts them, growing toward the middle and
 * vanishing at the edges. Anything past half a module samples the wrong
 * module, which is why such a symbol can have three perfect finder patterns,
 * a timing pattern scoring 1.00, and still decode to nothing.
 *
 * Alignment patterns are the fix, and not merely as a fourth corner: they are
 * a grid of known reference points spread across the whole symbol. Locating
 * them measures the warp directly, and each cell of that grid gets its own
 * transform fitted to its own four corners — so the model is piecewise
 * planar rather than globally planar, which a bowed page actually is.
 */
export const samplePiecewise = (
  image: BitMatrix,
  size: number,
  /** Measured image positions of alignment centres, indexed [row][column]. */
  anchors: ReadonlyArray<ReadonlyArray<Point | null>>,
  /** Module coordinates those anchors correspond to. */
  positions: readonly number[],
  fallback: Transform
): BitMatrix | null => {
  const bits = new Uint8Array(size * size);

  /**
   * Which anchor cell governs a module coordinate.
   *
   * Coordinates outside the anchor span — the border strip before the first
   * alignment pattern and after the last — are CLAMPED to the nearest cell
   * rather than dropped to the global transform. On a version 40 symbol that
   * strip is 13% of all modules, and handing that many to the warped global
   * transform is more error than Reed-Solomon can absorb even when every
   * interior module is right. A bow is locally smooth, so extending the
   * neighbouring cell outward approximates it far better than a plane fitted
   * across the whole symbol.
   */
  const cellFor = (m: number): number => {
    for (let i = 0; i < positions.length - 1; i++) {
      if (m >= positions[i] && m <= positions[i + 1]) return i;
    }
    return m < positions[0] ? 0 : positions.length - 2;
  };

  /** The transform governing the cell containing this module coordinate. */
  const localTransform = (mx: number, my: number): Transform => {
    const col = cellFor(mx);
    const row = cellFor(my);

    const topLeft = anchors[row]?.[col];
    const topRight = anchors[row]?.[col + 1];
    const bottomLeft = anchors[row + 1]?.[col];
    const bottomRight = anchors[row + 1]?.[col + 1];

    // A cell with a missing corner — damaged or glared-out alignment pattern
    // — falls back to the global transform rather than guessing.
    if (!topLeft || !topRight || !bottomLeft || !bottomRight) return fallback;

    return squareToQuadrilateral(topLeft, topRight, bottomRight, bottomLeft);
  };

  /**
   * The four measured corners of the cell containing a module, if all exist.
   *
   * Used for bilinear interpolation, which is the correct primitive for a
   * NON-PLANAR quadrilateral. A homography maps a square to a planar quad —
   * and the whole reason for sampling piecewise is that the surface is
   * curved, so each cell is slightly non-planar by construction. Texture
   * mapping draws exactly this distinction: bilinear patches handle
   * non-planar quads, perspective mapping handles planar ones.
   */
  const cellCorners = (
    mx: number,
    my: number
  ): { p0: Point; p1: Point; p2: Point; p3: Point } | null => {
    const col = cellFor(mx);
    const row = cellFor(my);

    const p0 = anchors[row]?.[col];
    const p1 = anchors[row]?.[col + 1];
    const p2 = anchors[row + 1]?.[col + 1];
    const p3 = anchors[row + 1]?.[col];
    if (!p0 || !p1 || !p2 || !p3) return null;

    return { p0, p1, p2, p3 };
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const transform = localTransform(x, y);
      let source: Point;

      if (transform === fallback) {
        const span = size - 7;
        source = applyTransform(
          transform,
          (x + 0.5 - 3.5) / span,
          (y + 0.5 - 3.5) / span
        );
      } else {
        // Within a cell, coordinates are relative to that cell's own corners.
        // Outside the anchor span the ratio falls below 0 or above 1, which
        // extrapolates the nearest cell's transform rather than clamping the
        // sample — exactly what the border strip needs.
        const col = cellFor(x);
        const row = cellFor(y);
        const x0 = positions[col];
        const x1 = positions[col + 1];
        const y0 = positions[row];
        const y1 = positions[row + 1];

        const u = (x + 0.5 - x0) / (x1 - x0);
        const v = (y + 0.5 - y0) / (y1 - y0);
        const corners = cellCorners(x, y);

        // Bilinear where all four corners were measured, homography
        // otherwise. Inside the cell the two differ by up to 0.39 modules at
        // the warps measured here — under the half-module threshold on its
        // own, but the errors compound with everything else.
        source =
          corners === null
            ? applyTransform(transform, u, v)
            : {
                x:
                  (1 - u) * (1 - v) * corners.p0.x +
                  u * (1 - v) * corners.p1.x +
                  u * v * corners.p2.x +
                  (1 - u) * v * corners.p3.x,
                y:
                  (1 - u) * (1 - v) * corners.p0.y +
                  u * (1 - v) * corners.p1.y +
                  u * v * corners.p2.y +
                  (1 - u) * v * corners.p3.y
              };
      }

      const sx = Math.round(source.x);
      const sy = Math.round(source.y);
      if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) {
        return null;
      }

      bits[y * size + x] = image.bits[sy * image.width + sx]!;
    }
  }

  return { bits, width: size, height: size };
};

/**
 * Sample the symbol into a clean module grid.
 *
 * Each module is read at its centre, mapped through the transform. Reading
 * centres rather than averaging whole cells is deliberate: at the distances a
 * phone actually scans from, a module is a handful of pixels, and averaging
 * pulls in its neighbours' ink.
 */
/**
 * Which modules the image cannot answer for.
 *
 * Returns a mask the same shape as the sampled grid, where 1 marks a module
 * whose value was guessed rather than read. Reed-Solomon corrects twice as
 * many codewords when it is told where the damage is, so this is worth real
 * capacity — measured on a version 3 symbol at ecM, a blob covering 15% of the
 * area decodes 0% of the time as errors and 100% as erasures.
 *
 * Two things make a module unanswerable, and they are different failures:
 *
 * - **Saturation.** A pixel at the top or bottom of the range has been
 *   clipped by the sensor, so its true value is not merely uncertain but
 *   absent. Measured across the benchmark corpus, `glare` and `bright_spots`
 *   average 1.1-1.2% of pixels at or above 250 while `nominal` and `damaged`
 *   average 0.00% — so this fires on the categories it is meant for and
 *   essentially never on ordinary photographs, which is what makes it safe to
 *   run always.
 * - **Falling outside the frame.** `sampleGrid` reads these as light, because
 *   a symbol's surroundings are its quiet zone. That is the right guess, but
 *   it is still a guess, and saying so costs nothing.
 *
 * Deliberately NOT flagged: low local contrast. It is the obvious third
 * signal and it is not measured here, because a module in a large flat region
 * of a correctly-read symbol also has no local contrast — the check would fire
 * on healthy images, and erasures spent on undamaged modules are capacity
 * taken away from the damage that matters.
 */
export const unreadableModules = (
  image: GrayImage,
  transform: Transform,
  size: number
): Uint8Array => {
  const span = size - 7;
  const mask = new Uint8Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const source = applyTransform(
        transform,
        (x + 0.5 - 3.5) / span,
        (y + 0.5 - 3.5) / span
      );

      const sx = Math.round(source.x);
      const sy = Math.round(source.y);

      if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) {
        mask[y * size + x] = 1;
        continue;
      }

      const value = image.data[sy * image.width + sx];
      if (value >= SATURATED_HIGH || value <= SATURATED_LOW) {
        mask[y * size + x] = 1;
      }
    }
  }

  return mask;
};

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

      // Out of frame reads as LIGHT rather than abandoning the grid.
      //
      // Rejecting the whole symbol on one stray sample is too blunt: under
      // perspective the corner estimate is imprecise, so a grid that is 95%
      // correct gets discarded because a quiet-zone module maps a pixel or
      // two past the edge. Reed-Solomon exists to absorb a handful of wrong
      // modules, and pre-empting it throws away symbols it would have
      // recovered. The perspective literature makes the same point from the
      // other direction, padding detected corners "to account for minor
      // inaccuracies in corner detection".
      //
      // Light is the right default because everything outside a symbol is its
      // quiet zone, which the standard requires to be light.
      const outside =
        sx < 0 || sy < 0 || sx >= image.width || sy >= image.height;
      if (outside) {
        bits[y * size + x] = 0;
        continue;
      }

      bits[y * size + x] = image.bits[sy * image.width + sx]!;
    }
  }

  return { bits, width: size, height: size };
};
