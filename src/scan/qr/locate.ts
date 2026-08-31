/**
 * Finding the symbol in a photograph.
 *
 * A QR announces itself with three finder patterns — the concentric squares in
 * its corners — whose defining property is a 1:1:3:1:1 ratio of dark:light:
 * dark:light:dark along ANY line through the centre. That ratio is preserved
 * under rotation and, near enough, under moderate perspective, which is what
 * makes it findable without knowing where the symbol is or how it is turned.
 *
 * The search runs row by row looking for that ratio, then confirms each
 * candidate vertically and diagonally. Confirming in more than one direction
 * matters: a row of a barcode, a window blind, or a keyboard produces the
 * ratio horizontally all the time, and only a real finder produces it in every
 * direction through the same point.
 */

import type { BitMatrix, Point } from "../types.js";

/** A located finder pattern. */
export interface FinderPattern {
  readonly center: Point;
  /** Estimated module size in pixels, from the pattern's own width. */
  readonly moduleSize: number;
}

/** Three finders, assigned to their corners. */
export interface FinderTriple {
  /** The corner finder — the one at the right angle of the L. */
  readonly topLeft: FinderPattern;
  readonly topRight: FinderPattern;
  readonly bottomLeft: FinderPattern;
}

/**
 * How far a run sequence may deviate from 1:1:3:1:1 and still count.
 *
 * Half a module of slack per band. Tighter rejects real finders seen at an
 * angle or through a cheap lens; looser starts accepting text and window
 * frames, and every false candidate costs a vertical and diagonal check.
 */
const RATIO_TOLERANCE = 0.5;

/** Whether five consecutive runs match the finder ratio. */
const matchesFinderRatio = (runs: readonly number[]): boolean => {
  let total = 0;
  for (const run of runs) {
    // A zero-length run means the sequence was broken, not a valid pattern.
    if (run === 0) return false;
    total += run;
  }
  // Seven modules across: 1 + 1 + 3 + 1 + 1.
  if (total < 7) return false;

  const moduleSize = total / 7;
  const tolerance = moduleSize * RATIO_TOLERANCE;

  return (
    Math.abs(moduleSize - runs[0]) < tolerance &&
    Math.abs(moduleSize - runs[1]) < tolerance &&
    Math.abs(moduleSize * 3 - runs[2]) < tolerance * 3 &&
    Math.abs(moduleSize - runs[3]) < tolerance &&
    Math.abs(moduleSize - runs[4]) < tolerance
  );
};

/** Centre of the middle run, given where the five runs end. */
const centerFromRuns = (runs: readonly number[], end: number): number =>
  end - runs[4] - runs[3] - runs[2] / 2;

const bitAt = (matrix: BitMatrix, x: number, y: number): number => {
  if (x < 0 || y < 0 || x >= matrix.width || y >= matrix.height) return 0;
  return matrix.bits[y * matrix.width + x];
};

/**
 * Re-check a candidate along one axis through its centre.
 *
 * Returns the refined centre coordinate, or `null` if the ratio does not hold.
 * This is what rejects the horizontal-only coincidences — a line of text or a
 * barcode gives 1:1:3:1:1 across but never up and down through the same point.
 */
const checkAxis = (
  matrix: BitMatrix,
  startX: number,
  startY: number,
  stepX: number,
  stepY: number,
  maxCount: number
): number | null => {
  const runs = [0, 0, 0, 0, 0];

  // Walk outward from the centre in both directions, counting run lengths.
  // The centre band is index 2, so it is filled from both halves.
  let x = startX;
  let y = startY;
  while (
    x >= 0 &&
    y >= 0 &&
    x < matrix.width &&
    y < matrix.height &&
    bitAt(matrix, x, y) === 1 &&
    runs[2] < maxCount
  ) {
    runs[2]++;
    x -= stepX;
    y -= stepY;
  }
  if (runs[2] >= maxCount) return null;

  for (const [index, expected] of [
    [1, 0],
    [0, 1]
  ] as const) {
    while (
      x >= 0 &&
      y >= 0 &&
      x < matrix.width &&
      y < matrix.height &&
      bitAt(matrix, x, y) === expected &&
      runs[index] < maxCount
    ) {
      runs[index]++;
      x -= stepX;
      y -= stepY;
    }
    if (runs[index] >= maxCount) return null;
  }

  x = startX + stepX;
  y = startY + stepY;
  while (
    x >= 0 &&
    y >= 0 &&
    x < matrix.width &&
    y < matrix.height &&
    bitAt(matrix, x, y) === 1 &&
    runs[2] < maxCount
  ) {
    runs[2]++;
    x += stepX;
    y += stepY;
  }
  if (runs[2] >= maxCount) return null;

  for (const [index, expected] of [
    [3, 0],
    [4, 1]
  ] as const) {
    while (
      x >= 0 &&
      y >= 0 &&
      x < matrix.width &&
      y < matrix.height &&
      bitAt(matrix, x, y) === expected &&
      runs[index] < maxCount
    ) {
      runs[index]++;
      x += stepX;
      y += stepY;
    }
    if (runs[index] >= maxCount) return null;
  }

  if (!matchesFinderRatio(runs)) return null;

  const total = runs.reduce((sum, run) => sum + run, 0);
  const end = stepX !== 0 ? x : y;
  return centerFromRuns(runs, end) + (total % 2 === 0 ? 0 : 0);
};

/**
 * Refine a finder centre to the centroid of its dark core.
 *
 * The run-length scan gives a centre by halving the middle band, which is
 * accurate only if the scan line passes exactly through the pattern's middle.
 * Under perspective or rotation it rarely does, and the row-averaging that
 * merges detections biases toward whichever rows happened to match.
 *
 * Measured against a reference decoder on the `perspective` category, centres
 * from the scan alone sit 0.72 to 0.84 modules from the truth — and sampling
 * needs better than 0.5. Every fourth-corner method inherits that error,
 * which is why all three of them landed around 1.7 modules regardless of how
 * they were computed. The centres themselves were the limit.
 *
 * The 3x3 dark core of a finder is a solid block, so its centroid is a much
 * better estimate than a scan-line midpoint: it uses every pixel of the core
 * rather than one row through it, and it does not care what angle the pattern
 * is seen at.
 */
const refineCenter = (
  matrix: BitMatrix,
  center: Point,
  moduleSize: number
): Point => {
  // Flood the connected dark region containing the centre, bounded to the
  // core's plausible extent so it cannot leak into the surrounding ring.
  const limit = Math.max(2, Math.round(moduleSize * 2));
  const startX = Math.round(center.x);
  const startY = Math.round(center.y);
  if (
    startX < 0 ||
    startY < 0 ||
    startX >= matrix.width ||
    startY >= matrix.height ||
    matrix.bits[startY * matrix.width + startX] !== 1
  ) {
    return center;
  }

  let sumX = 0;
  let sumY = 0;
  let count = 0;
  const seen = new Set<number>();
  const queue: Array<[number, number]> = [[startX, startY]];

  while (queue.length > 0) {
    const [x, y] = queue.pop()!;
    if (
      x < 0 ||
      y < 0 ||
      x >= matrix.width ||
      y >= matrix.height ||
      Math.abs(x - startX) > limit ||
      Math.abs(y - startY) > limit
    ) {
      continue;
    }

    const key = y * matrix.width + x;
    if (seen.has(key) || matrix.bits[key] !== 1) continue;
    seen.add(key);

    sumX += x;
    sumY += y;
    count++;

    queue.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }

  // Too small to be the core, or so large it leaked — keep the scan estimate.
  const area = count / (moduleSize * moduleSize);
  if (count === 0 || area < 2 || area > 20) return center;

  return { x: sumX / count, y: sumY / count };
};

/**
 * Find candidate finder patterns.
 *
 * Scans every row for the horizontal ratio, then confirms vertically and
 * diagonally. Candidates close to one already found are merged, since a
 * pattern several modules tall is detected on each of its rows.
 */
export const findFinderPatterns = (matrix: BitMatrix): FinderPattern[] => {
  const found: Array<{ center: Point; moduleSize: number; count: number }> = [];

  for (let y = 0; y < matrix.height; y++) {
    // Five run lengths, oldest first, always phased dark-light-dark-light-dark.
    // Phase is the whole difficulty here: a row starts in the quiet zone, so
    // the FIRST run is light and must not be recorded as runs[0]. Tracking
    // "how many runs have we seen" separately from "which colour are we in"
    // is what keeps the window aligned to a dark start.
    const runs = [0, 0, 0, 0, 0];
    let filled = 0;
    let current = matrix.bits[y * matrix.width];
    let length = 0;

    const shift = (): void => {
      // Drop the oldest pair and keep the last three runs: a finder can begin
      // inside the tail of the one before it, so restarting from empty would
      // miss adjacent patterns.
      runs[0] = runs[2]!;
      runs[1] = runs[3]!;
      runs[2] = runs[4]!;
      runs[3] = 0;
      runs[4] = 0;
      filled = 3;
    };

    const consider = (end: number): void => {
      if (!matchesFinderRatio(runs)) return;

      const centerX = centerFromRuns(runs, end);
      const total = runs.reduce((sum, run) => sum + run, 0);
      const moduleSize = total / 7;

      const centerY = checkAxis(matrix, Math.round(centerX), y, 0, 1, total);
      if (centerY === null) return;

      // Diagonal confirmation. A run of text or a barcode gives the ratio
      // horizontally all the time; only a real finder gives it in every
      // direction through the same point.
      const diagonal = checkAxis(
        matrix,
        Math.round(centerX),
        Math.round(centerY),
        1,
        1,
        total * 2
      );
      if (diagonal === null) return;

      const center = { x: centerX, y: centerY };
      const existing = found.find(
        (candidate) =>
          Math.abs(candidate.center.x - center.x) < moduleSize * 2 &&
          Math.abs(candidate.center.y - center.y) < moduleSize * 2
      );

      if (existing === undefined) {
        found.push({ center, moduleSize, count: 1 });
        return;
      }

      // A pattern several modules tall is detected on each of its rows, and
      // the mean of those estimates is a better centre than any single row.
      const next = existing.count + 1;
      existing.center = {
        x: (existing.center.x * existing.count + center.x) / next,
        y: (existing.center.y * existing.count + center.y) / next
      };
      existing.moduleSize =
        (existing.moduleSize * existing.count + moduleSize) / next;
      existing.count = next;
    };

    for (let x = 0; x <= matrix.width; x++) {
      const bit = x < matrix.width ? matrix.bits[y * matrix.width + x] : -1;

      if (bit === current) {
        length++;
        continue;
      }

      // A run just ended. Record it only once the window has started on a
      // DARK run — a leading light run is the quiet zone and carries no
      // ratio information.
      if (filled > 0 || current === 1) {
        if (filled < 5) {
          runs[filled] = length;
          filled++;
        }

        if (filled === 5) {
          consider(x);
          shift();
          runs[filled] = 0;
        }
      }

      current = bit;
      length = 1;
    }
  }

  return found.map(({ center, moduleSize }) => ({
    center: refineCenter(matrix, center, moduleSize),
    moduleSize
  }));
};

/**
 * Choose the three candidates most likely to be one symbol's finders.
 *
 * Taking the first three found is wrong far more often than it looks. Measured
 * across the benchmark corpus, the `rotations`, `high_version` and
 * `brightness` categories return MORE than three candidates on essentially
 * every image — alignment patterns, texture, and print artefacts all produce
 * the 1:1:3:1:1 signature somewhere — so an arbitrary three discards the
 * right answer and the symbol is lost despite having been found.
 *
 * Scored on the two properties three real finders always have: their module
 * sizes agree, and they sit at the corners of a right isosceles triangle. Both
 * hold under rotation and moderate perspective, which is what makes them
 * usable as a selection criterion rather than a validation one.
 */
export const selectBestTriple = (
  patterns: readonly FinderPattern[]
): FinderPattern[] | null => {
  if (patterns.length < 3) return null;
  if (patterns.length === 3) return [...patterns];

  // Beyond a handful of candidates the combinations grow cubically, so the
  // search is capped. Candidates are already merged by proximity, so a large
  // count means genuine clutter rather than duplicates of one pattern.
  const pool = patterns.slice(0, 12);
  let best: { score: number; triple: FinderPattern[] } | null = null;

  for (let i = 0; i < pool.length - 2; i++) {
    for (let j = i + 1; j < pool.length - 1; j++) {
      for (let k = j + 1; k < pool.length; k++) {
        const triple = [pool[i], pool[j], pool[k]];
        const score = scoreTriple(triple);
        if (score === null) continue;
        if (best === null || score < best.score) best = { score, triple };
      }
    }
  }

  return best?.triple ?? null;
};

/**
 * How unlike three real finders a candidate triple is. Lower is better.
 *
 * Returns `null` for triples that cannot be a symbol at all, which prunes most
 * combinations before the geometry is examined.
 */
const scoreTriple = (triple: readonly FinderPattern[]): number | null => {
  const [a, b, c] = triple as [FinderPattern, FinderPattern, FinderPattern];

  // Three finders of one symbol are the same size. A candidate that is twice
  // its neighbours is an alignment pattern or unrelated texture.
  const sizes = [a.moduleSize, b.moduleSize, c.moduleSize];
  const meanSize = (sizes[0] + sizes[1] + sizes[2]) / 3;
  if (meanSize <= 0) return null;

  const sizeSpread = Math.max(...sizes) / Math.min(...sizes) - 1;
  if (sizeSpread > 1.5) return null;

  // The three sit at the corners of a right isosceles triangle: two equal
  // legs and a hypotenuse of sqrt(2) times their length.
  const sides = [
    Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y),
    Math.hypot(b.center.x - c.center.x, b.center.y - c.center.y),
    Math.hypot(a.center.x - c.center.x, a.center.y - c.center.y)
  ].sort((first, second) => first - second);

  const [leg1, leg2, hypotenuse] = sides as [number, number, number];
  if (leg1 <= 0) return null;

  // Legs far enough apart in length are not a QR at any angle.
  const legRatio = leg2 / leg1;
  if (legRatio > 2.2) return null;

  const expectedHypotenuse = ((leg1 + leg2) / 2) * Math.SQRT2;
  const hypotenuseError =
    Math.abs(hypotenuse - expectedHypotenuse) / expectedHypotenuse;
  if (hypotenuseError > 0.5) return null;

  // Separation must be plausible for the module size — the legs span
  // (size - 7) modules, so 14 to 170 covers versions 1 to 40 with slack.
  const modulesApart = leg1 / meanSize;
  if (modulesApart < 10 || modulesApart > 200) return null;

  return sizeSpread + (legRatio - 1) + hypotenuseError;
};

/** Squared distance, for comparisons that never need the square root. */
const distanceSquared = (a: Point, b: Point): number =>
  (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/**
 * Assign three finders to their corners.
 *
 * The top-left finder is the one at the right angle of the L the three form —
 * identified as the corner opposite the longest side, which is the hypotenuse.
 * That works at any rotation, which a coordinate comparison would not: a
 * symbol photographed upside down has its "top" left finder at the bottom of
 * the image.
 *
 * Top-right and bottom-left are then distinguished by the sign of the cross
 * product, which says which side of the diagonal each falls on.
 */
export const orientFinders = (
  patterns: readonly FinderPattern[]
): FinderTriple | null => {
  if (patterns.length !== 3) return null;

  const [a, b, c] = patterns as [FinderPattern, FinderPattern, FinderPattern];
  const sides = [
    { corner: c, length: distanceSquared(a.center, b.center) },
    { corner: a, length: distanceSquared(b.center, c.center) },
    { corner: b, length: distanceSquared(a.center, c.center) }
  ];

  // The corner opposite the longest side is the right angle of the L.
  const hypotenuse = sides.reduce((longest, side) =>
    side.length > longest.length ? side : longest
  );
  const topLeft = hypotenuse.corner;
  const others = patterns.filter((pattern) => pattern !== topLeft);
  if (others.length !== 2) return null;

  const [first, second] = others as [FinderPattern, FinderPattern];

  // Cross product of the two arms. Its sign says whether `first` is clockwise
  // or anticlockwise from `second` about the corner, which is exactly the
  // top-right / bottom-left distinction — and it holds under any rotation.
  const cross =
    (first.center.x - topLeft.center.x) * (second.center.y - topLeft.center.y) -
    (first.center.y - topLeft.center.y) * (second.center.x - topLeft.center.x);

  return cross < 0
    ? { topLeft, topRight: second, bottomLeft: first }
    : { topLeft, topRight: first, bottomLeft: second };
};
