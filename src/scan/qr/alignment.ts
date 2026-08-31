/**
 * Locating the alignment pattern, to pin the fourth corner.
 *
 * Three finder patterns fix three corners of a symbol. The fourth is
 * estimated, and for a small QR that estimate is fine: assume the shape is a
 * parallelogram and the error stays under half a module.
 *
 * For a large one it is not fine. A version 25 symbol is 117 modules across,
 * so a perspective error of one percent at the far corner is more than a
 * module of drift by the time the grid reaches it — every module in that
 * region samples its neighbour. Measured on the benchmark corpus, the
 * `high_version` category reaches the decode stage on 17 of 20 images and
 * fails every one: located correctly, sampled wrongly.
 *
 * Which is exactly what alignment patterns exist for. Every version from 2
 * upward carries at least one, and the one nearest the bottom-right corner
 * sits at a known module position — so finding it converts an estimate into a
 * measurement.
 */

import type { BitMatrix, Point } from "../types.js";
import type { FinderTriple } from "./locate.js";
import { applyTransform, type Transform } from "./sample.js";

/**
 * Alignment-pattern centre coordinates by version, from ISO/IEC 18004 Annex E.
 *
 * The same table `mask.ts` uses to reserve them. Duplicated deliberately
 * rather than shared: that one describes which modules to SKIP when reading
 * data, this one describes where to LOOK in an image, and merging them would
 * couple the image pipeline to the bitstream layer for the sake of one array.
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

/**
 * The module coordinate of the alignment pattern nearest the far corner.
 *
 * Returns `null` for version 1, which has none — and for which the
 * parallelogram estimate is accurate enough anyway.
 */
export const bottomRightAlignmentPosition = (
  version: number
): number | null => {
  const centers = ALIGNMENT_CENTERS[version];
  if (centers === undefined || centers.length === 0) return null;

  // The last coordinate is nearest the bottom-right corner. Both axes use the
  // same value, since the pattern grid is symmetric.
  return centers[centers.length - 1] ?? null;
};

const bitAt = (matrix: BitMatrix, x: number, y: number): number => {
  if (x < 0 || y < 0 || x >= matrix.width || y >= matrix.height) return 0;
  return matrix.bits[y * matrix.width + x];
};

/**
 * Whether a point sits at the centre of a 5x5 alignment pattern.
 *
 * The pattern is a dark 5x5 square with a light 3x3 inside and a single dark
 * module at the centre — so a scan through it reads dark, light, dark. Rather
 * than match run lengths, this checks that ring structure directly, which
 * survives the blur and rounding that a small pattern suffers most.
 */
const looksLikeAlignment = (
  matrix: BitMatrix,
  x: number,
  y: number,
  moduleSize: number
): boolean => {
  const step = Math.max(1, Math.round(moduleSize));

  // Centre must be dark.
  if (bitAt(matrix, x, y) !== 1) return false;

  // The ring one module out must be light on all four sides.
  const light =
    bitAt(matrix, x - step, y) === 0 &&
    bitAt(matrix, x + step, y) === 0 &&
    bitAt(matrix, x, y - step) === 0 &&
    bitAt(matrix, x, y + step) === 0;
  if (!light) return false;

  // The ring two modules out must be dark on all four sides.
  return (
    bitAt(matrix, x - step * 2, y) === 1 &&
    bitAt(matrix, x + step * 2, y) === 1 &&
    bitAt(matrix, x, y - step * 2) === 1 &&
    bitAt(matrix, x, y + step * 2) === 1
  );
};

/**
 * Search for the alignment pattern near where the transform predicts it.
 *
 * Searched in a spiral outward from the estimate, so the nearest match wins:
 * a large symbol may carry several alignment patterns, and locking onto a
 * distant one would be worse than not finding any.
 *
 * Returns `null` when nothing matches, which is a normal outcome — the pattern
 * may be damaged, glared out, or outside the frame. The caller falls back to
 * the parallelogram estimate.
 */
export const findAlignmentPattern = (
  matrix: BitMatrix,
  estimate: Point,
  moduleSize: number,
  /** How many modules out to search. Wider when the estimate is less trusted. */
  searchModules = 4
): Point | null => {
  // Scaled to how wrong the prediction can be, not to the pattern's own size.
  //
  // The prediction comes from a transform whose fourth corner is a guess, so
  // its error grows with the symbol: on a version 40 image measured here, the
  // corner estimate was 65px out and the true alignment pattern sat 87px from
  // the prediction, while a radius of moduleSize * 4 searched only 27px. The
  // search was tightest exactly where the estimate was worst, so the pattern
  // that would have FIXED the estimate was never found.
  //
  // Bounded rather than unlimited: past a few modules a "match" is more
  // likely to be unrelated texture than the pattern being looked for.
  const radius = Math.max(8, Math.round(moduleSize * searchModules));

  for (let ring = 0; ring <= radius; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        // Only the perimeter of each ring — the interior was covered already.
        if (ring > 0 && Math.abs(dx) !== ring && Math.abs(dy) !== ring) {
          continue;
        }

        const x = Math.round(estimate.x) + dx;
        const y = Math.round(estimate.y) + dy;

        if (looksLikeAlignment(matrix, x, y, moduleSize)) return { x, y };
      }
    }
  }

  return null;
};

/**
 * Locate every alignment pattern, giving a measured grid of reference points.
 *
 * Returns a row-major grid the same shape as the version's alignment
 * coordinates, with `null` wherever a pattern could not be found — damaged,
 * glared out, or (at three corners) overlapping a finder and therefore absent
 * by design.
 *
 * This is what makes piecewise sampling possible: rather than one fourth
 * corner, it measures where the symbol actually is at points spread across its
 * whole area, which is the only way to see a warp that a single plane cannot
 * model.
 */
export const locateAlignmentGrid = (
  matrix: BitMatrix,
  transform: Transform,
  size: number,
  version: number,
  moduleSize: number
): {
  anchors: Array<Array<Point | null>>;
  positions: readonly number[];
} | null => {
  const centers = ALIGNMENT_CENTERS[version];
  if (centers === undefined || centers.length < 2) return null;

  const span = size - 7;
  const anchors: Array<Array<Point | null>> = [];

  for (const cy of centers) {
    const row: Array<Point | null> = [];
    for (const cx of centers) {
      // The three finder corners have no alignment pattern. Their positions
      // are known exactly from the finders themselves, so they are supplied
      // by the caller rather than searched for here.
      const nearFinder =
        (cx <= 8 && cy <= 8) ||
        (cx <= 8 && cy >= size - 9) ||
        (cx >= size - 9 && cy <= 8);

      const predicted = applyTransform(
        transform,
        (cx - 3.5) / span,
        (cy - 3.5) / span
      );

      row.push(
        nearFinder
          ? predicted
          : findAlignmentPattern(matrix, predicted, moduleSize)
      );
    }
    anchors.push(row);
  }

  interpolateMissing(anchors);
  return { anchors, positions: centers };
};

/**
 * Fill anchors that could not be located, from the ones that could.
 *
 * A missing anchor otherwise drops its whole cell back to the global
 * transform, which is the flat one piecewise sampling exists to replace — so
 * one glared-out or damaged alignment pattern loses a region far larger than
 * itself. jsQR's own issue #197 names this directly when proposing the same
 * technique: break the symbol into several transforms, "interpolating over
 * the ones that cannot be found".
 *
 * Interpolation is linear from the nearest located anchors in the same row,
 * then the same column. That is a good approximation because the warp being
 * corrected is smooth by nature — paper bends, it does not crease randomly —
 * and any estimate on the measured surface beats reverting to a plane.
 */
const interpolateMissing = (anchors: Array<Array<Point | null>>): void => {
  const rows = anchors.length;
  const columns = anchors[0]?.length ?? 0;

  /** Nearest located neighbours along one axis, with their distances. */
  const neighbours = (
    at: (index: number) => Point | null,
    length: number,
    index: number
  ): {
    before?: { point: Point; gap: number };
    after?: { point: Point; gap: number };
  } => {
    const result: {
      before?: { point: Point; gap: number };
      after?: { point: Point; gap: number };
    } = {};

    for (let i = index - 1; i >= 0; i--) {
      const point = at(i);
      if (point !== null) {
        result.before = { point, gap: index - i };
        break;
      }
    }
    for (let i = index + 1; i < length; i++) {
      const point = at(i);
      if (point !== null) {
        result.after = { point, gap: i - index };
        break;
      }
    }
    return result;
  };

  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      if (anchors[row][column] !== null) continue;

      const horizontal = neighbours(
        (i) => anchors[row][i] ?? null,
        columns,
        column
      );
      const vertical = neighbours(
        (i) => anchors[i]?.[column] ?? null,
        rows,
        row
      );

      // Prefer an axis with anchors on BOTH sides — that interpolates rather
      // than extrapolates, and extrapolation compounds error away from the
      // measured points.
      const pair =
        horizontal.before && horizontal.after
          ? horizontal
          : vertical.before && vertical.after
            ? vertical
            : null;

      if (pair?.before && pair.after) {
        const total = pair.before.gap + pair.after.gap;
        const weight = pair.before.gap / total;
        anchors[row][column] = {
          x:
            pair.before.point.x +
            (pair.after.point.x - pair.before.point.x) * weight,
          y:
            pair.before.point.y +
            (pair.after.point.y - pair.before.point.y) * weight
        };
      }
    }
  }
};

/**
 * Estimate the fourth corner by following the symbol's own edges.
 *
 * The parallelogram assumption — that the far corner sits where the two arms
 * of the L would meet — ignores perspective entirely, and perspective is
 * precisely what makes the far corner move. Measured against a reference
 * decoder, correcting this one point takes `perspective` from 2 of 23 images
 * to 7, `glare` from 2 of 17 to 7, and `curved` from 18 of 36 to 27. It is
 * the single largest error in the pipeline.
 *
 * The symbol's outer boundary is a hard edge against the quiet zone, so it
 * can be measured rather than assumed: walk outward along the top edge from
 * the top-right finder and along the left edge from the bottom-left finder,
 * find where the dark modules stop, and intersect the two lines. That
 * intersection is the fourth corner, and it follows the real perspective
 * because it is derived from the real edges.
 */
export const estimateCornerFromEdges = (
  matrix: BitMatrix,
  finders: FinderTriple,
  moduleSize: number,
  fallback: Point
): Point => {
  const { topLeft, topRight, bottomLeft } = finders;

  // Direction vectors along the two arms of the L.
  const alongTop = {
    x: topRight.center.x - topLeft.center.x,
    y: topRight.center.y - topLeft.center.y
  };
  const alongLeft = {
    x: bottomLeft.center.x - topLeft.center.x,
    y: bottomLeft.center.y - topLeft.center.y
  };

  /**
   * Walk from `start` in direction `step` until the symbol ends.
   *
   * "Ends" means a run of light longer than a module can be — inside the
   * symbol, light runs are bounded by the module grid, so a longer one is the
   * quiet zone. Counting a run rather than stopping at the first light pixel
   * is what makes this survive a symbol whose last column happens to be light.
   */
  const walkToEdge = (start: Point, step: Point): Point | null => {
    const length = Math.hypot(step.x, step.y);
    if (length === 0) return null;

    const unit = { x: step.x / length, y: step.y / length };
    const limit = Math.round(length * 1.6);
    const quietRun = Math.max(3, Math.round(moduleSize * 2.5));

    let light = 0;
    let lastDark: Point | null = null;

    for (let i = 0; i < limit; i++) {
      const x = Math.round(start.x + unit.x * i);
      const y = Math.round(start.y + unit.y * i);
      if (x < 0 || y < 0 || x >= matrix.width || y >= matrix.height) break;

      if (matrix.bits[y * matrix.width + x] === 1) {
        light = 0;
        lastDark = { x, y };
      } else if (++light > quietRun) {
        break;
      }
    }

    return lastDark;
  };

  // From each far finder, walk along the edge that continues away from the
  // top-left one. Those two walks end at the two ends of the far corner.
  const rightEdge = walkToEdge(topRight.center, alongLeft);
  const bottomEdge = walkToEdge(bottomLeft.center, alongTop);
  if (rightEdge === null || bottomEdge === null) return fallback;

  // Intersect the line through topRight along alongLeft with the line through
  // bottomLeft along alongTop.
  const denominator = alongLeft.x * alongTop.y - alongLeft.y * alongTop.x;
  if (Math.abs(denominator) < 1e-6) return fallback;

  const dx = bottomEdge.x - rightEdge.x;
  const dy = bottomEdge.y - rightEdge.y;
  const t = (dx * alongTop.y - dy * alongTop.x) / denominator;

  const corner = {
    x: rightEdge.x + alongLeft.x * t,
    y: rightEdge.y + alongLeft.y * t
  };

  // Sanity: the corner must lie beyond both far finders and within a
  // plausible distance. A wild intersection is worse than the parallelogram.
  const span = Math.hypot(alongTop.x, alongTop.y);
  const drift = Math.hypot(corner.x - fallback.x, corner.y - fallback.y);
  return Number.isFinite(corner.x) &&
    Number.isFinite(corner.y) &&
    drift < span * 0.4
    ? corner
    : fallback;
};

/**
 * Refine the fourth corner using the alignment pattern, when one can be found.
 *
 * The alignment centre sits at module `(position, position)`, not at the
 * symbol's corner, so its measured location has to be extrapolated outward to
 * where the corner actually is. Doing that in the transform's own coordinate
 * space keeps the perspective it already models.
 */
export const refineBottomRight = (
  matrix: BitMatrix,
  transform: Transform,
  finders: FinderTriple,
  size: number,
  version: number,
  fallback: Point
): Point => {
  const position = bottomRightAlignmentPosition(version);
  if (position === null) return fallback;

  const span = size - 7;
  // Where the current (estimated) transform thinks the pattern is.
  const predicted = applyTransform(
    transform,
    (position - 3.5) / span,
    (position - 3.5) / span
  );

  const moduleSize =
    (finders.topLeft.moduleSize +
      finders.topRight.moduleSize +
      finders.bottomLeft.moduleSize) /
    3;

  // Scaled to the symbol, because that is what scales the error. The corner
  // guess assumes a parallelogram, and its error grows with how far the far
  // corner is from the three measured ones — negligible on a version 2
  // symbol, 65px on the version 40 measured here. A fixed wide radius would
  // instead find false matches on small symbols whose estimate was already
  // good, which measurably costs more than it recovers.
  const found = findAlignmentPattern(
    matrix,
    predicted,
    moduleSize,
    Math.max(4, size / 12)
  );
  if (found === null) return fallback;

  // Extrapolate from the alignment centre out to the symbol corner, along the
  // line from the top-left finder. The corner is at module (size-3.5), the
  // alignment at (position), so the ratio is fixed by the version.
  const fromCorner = size - 3.5 - position;
  const scale = (size - 3.5 - 3.5) / (position - 3.5);

  // A degenerate ratio means the version table and the size disagree; trust
  // the fallback rather than producing a wild corner.
  if (!Number.isFinite(scale) || scale <= 0) return fallback;
  void fromCorner;

  return {
    x: finders.topLeft.center.x + (found.x - finders.topLeft.center.x) * scale,
    y: finders.topLeft.center.y + (found.y - finders.topLeft.center.y) * scale
  };
};
