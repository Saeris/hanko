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
  moduleSize: number
): Point | null => {
  // Half the pattern-to-corner distance is the most the estimate should ever
  // be wrong by; beyond that a "match" is more likely to be unrelated texture.
  const radius = Math.max(4, Math.round(moduleSize * 4));

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

  const found = findAlignmentPattern(matrix, predicted, moduleSize);
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
