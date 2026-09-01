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

/**
 * Whether five consecutive runs match the finder ratio.
 *
 * `mergedOuter` relaxes the one assumption that a missing quiet zone breaks.
 * The outer dark runs are the only ones that can join content outside the
 * finder, and a symbol printed hard against a dark element does exactly that:
 * `runs[0]` or `runs[4]` becomes arbitrarily long. Deriving the module size
 * from the total then inflates it and every comparison fails, including those
 * on the undamaged interior — so under this flag the module size comes from
 * the middle three runs, which the finder's own light rings bound, and the
 * outer runs need only be present.
 *
 * Off by default, and deliberately so: it roughly triples the candidate rows,
 * which is noise everywhere the quiet zone is intact. Measured as the only
 * rule, it took `pathological` from 57.7% to 65.4% and the corpus from 70.2%
 * to 64.5% — `high_version` to zero — while making the benchmark five times
 * slower. It is worth having as a retry and not as a replacement.
 */
const matchesFinderRatio = (
  runs: readonly number[],
  mergedOuter = false
): boolean => {
  let total = 0;
  for (const run of runs) {
    // A zero-length run means the sequence was broken, not a valid pattern.
    if (run === 0) return false;
    total += run;
  }
  // Seven modules across: 1 + 1 + 3 + 1 + 1.
  if (total < 7) return false;

  if (mergedOuter) {
    const inner = runs[1] + runs[2] + runs[3];
    if (inner < 5) return false;

    const innerModule = inner / 5;
    const innerTolerance = innerModule * RATIO_TOLERANCE;

    if (Math.abs(innerModule - runs[1]) >= innerTolerance) return false;
    if (Math.abs(innerModule * 3 - runs[2]) >= innerTolerance * 3) return false;
    if (Math.abs(innerModule - runs[3]) >= innerTolerance) return false;

    return runs[0] >= innerModule * 0.5 && runs[4] >= innerModule * 0.5;
  }

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
  maxCount: number,
  mergedOuter = false
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

  if (!matchesFinderRatio(runs, mergedOuter)) return null;

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
export const findFinderPatterns = (
  matrix: BitMatrix,
  /**
   * Tolerate an outer dark run merged with adjacent content.
   *
   * For symbols printed without their quiet zone. Roughly triples the
   * candidate rows, so it is a retry rather than a default — see
   * {@link matchesFinderRatio}.
   */
  mergedOuter = false
): FinderPattern[] => {
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
      if (!matchesFinderRatio(runs, mergedOuter)) return;

      const centerX = centerFromRuns(runs, end);
      const total = runs.reduce((sum, run) => sum + run, 0);
      const moduleSize = total / 7;

      const centerY = checkAxis(
        matrix,
        Math.round(centerX),
        y,
        0,
        1,
        total,
        mergedOuter
      );
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
        total * 2,
        mergedOuter
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
 * Find finder patterns as nested SHAPES rather than as run-length ratios.
 *
 * The 1:1:3:1:1 scan needs several clean pixels per band. In a 12-megapixel
 * photograph where the symbol occupies a small part of the frame, a module is
 * two or three pixels wide and JPEG artefacts destroy the ratio — measured on
 * the corpus, the `close` category is exactly this case, and the run-length
 * scan finds three patterns in only half of them.
 *
 * A finder is also a shape: a dark square ring, a light ring inside it, and a
 * dark core. That structure survives at scales where the ratio does not,
 * because it depends on connectivity rather than on measuring band widths.
 * BoofCV takes this approach — it detects the pattern the way AR-marker
 * trackers do rather than the way the QR specification describes — and scores
 * 100% on this corpus category where run-length scanning manages 28.6%.
 *
 * Complementary rather than better: on `perspective` images this finds three
 * patterns in one image of eight where the run-length scan finds all eight,
 * because a foreshortened finder stops being square. Both are run, and their
 * candidates pooled.
 */
export const findFinderBlobs = (matrix: BitMatrix): FinderPattern[] => {
  const { width, height, bits } = matrix;
  const seen = new Uint8Array(width * height);
  const found: FinderPattern[] = [];

  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= width || y >= height ? 0 : bits[y * width + x];

  // A blob larger than this is not a finder pattern but a dark region of the
  // scene, and flooding it wastes the whole budget.
  const maxArea = Math.max(4096, Math.floor((width * height) / 16));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const start = y * width + x;
      if (seen[start] === 1 || bits[start] !== 1) continue;

      let area = 0;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      const stack = [start];
      seen[start] = 1;

      while (stack.length > 0) {
        const index = stack.pop()!;
        const cy = Math.floor(index / width);
        const cx = index % width;
        area++;

        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;
        if (area > maxArea) break;

        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1]
        ] as const) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

          const next = ny * width + nx;
          if (seen[next] === 0 && bits[next] === 1) {
            seen[next] = 1;
            stack.push(next);
          }
        }
      }

      const blobWidth = maxX - minX + 1;
      const blobHeight = maxY - minY + 1;
      if (area < 20 || blobWidth < 7 || blobHeight < 7 || area > maxArea) {
        continue;
      }

      // Roughly square. Loose, because perspective makes a real finder
      // rectangular — but not so loose that any dark streak qualifies.
      if (
        Math.max(blobWidth, blobHeight) / Math.min(blobWidth, blobHeight) >
        1.5
      ) {
        continue;
      }

      // The outer ring is a RING: its blob should not fill its bounding box,
      // because the light separator breaks it away from the core.
      if (area / (blobWidth * blobHeight) > 0.75) continue;

      const centerX = Math.round(minX + blobWidth / 2);
      const centerY = Math.round(minY + blobHeight / 2);
      const moduleSize = blobWidth / 7;

      // The nesting itself: dark core, light at 1.5 modules out in every
      // direction. This is what separates a finder from any other square.
      if (at(centerX, centerY) !== 1) continue;
      const gap = Math.round(moduleSize * 1.5);
      if (
        at(centerX + gap, centerY) !== 0 ||
        at(centerX - gap, centerY) !== 0 ||
        at(centerX, centerY + gap) !== 0 ||
        at(centerX, centerY - gap) !== 0
      ) {
        continue;
      }

      found.push({ center: { x: centerX, y: centerY }, moduleSize });
    }
  }

  return found;
};

/**
 * Score how much clear space surrounds a candidate.
 *
 * A real finder sits at a CORNER of the symbol, so two of its four outward
 * directions lead into the quiet zone — four modules of light the standard
 * requires — while the other two lead into data. A false positive thrown up
 * by the data region has data on all four sides.
 *
 * This matters most exactly where it is hardest to do without: a version 40
 * symbol carries 3706 codewords of dense pattern, which produce the
 * 1:1:3:1:1 signature by chance 7 to 13 times per image. Measured against
 * known-correct finder positions, every real finder scores 1.00 while false
 * positives score 0.50 to 0.80.
 *
 * The idea is from the QR detection patent literature, which notes that the
 * mandatory four-module quiet zone "can be exploited to enlarge potential 3/3
 * code regions for internal false-positive check purposes".
 */
const clearanceScore = (
  matrix: BitMatrix,
  center: Point,
  moduleSize: number
): number => {
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= matrix.width || y >= matrix.height
      ? 0
      : matrix.bits[y * matrix.width + x];

  const directions = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
  ] as const;

  const lightness: number[] = [];
  for (const [dx, dy] of directions) {
    let light = 0;
    let total = 0;
    // Sampled from 5 to 9 modules out: past the finder's own 7-module width,
    // into either the quiet zone or the first data modules.
    for (let distance = 5; distance <= 9; distance++) {
      const x = Math.round(center.x + dx * moduleSize * distance);
      const y = Math.round(center.y + dy * moduleSize * distance);
      if (at(x, y) === 0) light++;
      total++;
    }
    lightness.push(total === 0 ? 0 : light / total);
  }

  // The two clearest directions. A corner finder has two facing outward, so
  // requiring all four would reject every real finder.
  lightness.sort((a, b) => b - a);
  return ((lightness[0] ?? 0) + (lightness[1] ?? 0)) / 2;
};

/**
 * Drop candidates that have no clear space around them.
 *
 * Returns the original list when filtering would leave fewer than three, so a
 * symbol photographed without its full quiet zone — against a dark table
 * edge, say — is never made undecodable by this check.
 */
export const withClearance = (
  matrix: BitMatrix,
  patterns: readonly FinderPattern[]
): FinderPattern[] => {
  const clear = patterns.filter(
    (pattern) =>
      clearanceScore(matrix, pattern.center, pattern.moduleSize) >= 0.95
  );
  return clear.length >= 3 ? clear : [...patterns];
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

/**
 * The four corners of a finder pattern's outer square.
 *
 * A finder gives more than a centre. Its outer ring is a square of known size
 * — 7 modules on a side — so locating its corners yields four measured
 * correspondences instead of one, and three finders yield twelve. That is
 * what turns fitting the sampling grid from an exactly-determined problem
 * with a guessed fourth corner into an overdetermined one where least squares
 * can average out the noise in any single measurement.
 *
 * The gain is large. Measured on the benchmark corpus with a single flat
 * sampling pass and no retry ladder, a twelve-point fit reads `perspective`
 * 18 of 26 against four points' 4, `nominal` 60 of 109 against 38, and
 * `glare` 9 of 31 against 3.
 *
 * The seed matters and is easy to get wrong: flooding from the finder's
 * CENTRE fills only its 3x3 dark core, which stops at the white separator
 * ring and describes a square 2 modules across rather than 7. The outer ring
 * is a separate dark region, so this seeds on the ring itself.
 */
export const finderOutline = (
  matrix: BitMatrix,
  finder: FinderPattern
): Point[] | null => {
  const { width, height } = matrix;
  const cx = Math.round(finder.center.x);
  const cy = Math.round(finder.center.y);
  const module = finder.moduleSize;

  // Three modules out lands on the outer ring in every direction; the first
  // dark hit is the ring, whichever way the symbol is rotated.
  let seed: readonly [number, number] | null = null;
  for (const [dx, dy] of [
    [3, 0],
    [-3, 0],
    [0, 3],
    [0, -3],
    [3, 3],
    [-3, -3],
    [3, -3],
    [-3, 3]
  ] as const) {
    const x = Math.round(cx + dx * module);
    const y = Math.round(cy + dy * module);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    if (matrix.bits[y * width + x] === 1) {
      seed = [x, y];
      break;
    }
  }
  if (seed === null) return null;

  // Bounded flood fill. The bound keeps a finder that touches surrounding
  // dark content from swallowing the whole image.
  const limit = Math.ceil(module * 8);
  const seen = new Uint8Array(width * height);
  const stack: Array<readonly [number, number]> = [seed];
  seen[seed[1] * width + seed[0]] = 1;

  const points: Array<readonly [number, number]> = [];
  let visited = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    const [x, y] = current;

    points.push(current);
    visited++;
    if (visited > limit * limit * 6) break;
    if (Math.abs(x - cx) > limit || Math.abs(y - cy) > limit) continue;

    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1]
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (seen[ny * width + nx] === 1) continue;
      if (matrix.bits[ny * width + nx] !== 1) continue;
      seen[ny * width + nx] = 1;
      stack.push([nx, ny]);
    }
  }

  if (points.length < 12) return null;
  return points.map(([x, y]) => ({ x, y }));
};

/**
 * Pick the four extreme points of an outline along a pair of axes.
 *
 * Ordered by the SYMBOL's axes rather than the image's, because a rotated
 * symbol's top-left corner is not the point nearest the image origin — using
 * image axes silently pairs each corner with the wrong module coordinate and
 * fits a transform to nonsense.
 *
 * Returns them in symbol order: origin, along-u, diagonal, along-v.
 */
export const cornersAlongAxes = (
  outline: readonly Point[],
  u: Point,
  v: Point
): [Point, Point, Point, Point] => {
  const extreme = (score: (point: Point) => number): Point => {
    let best = outline[0];
    let bestScore = -Infinity;
    for (const point of outline) {
      const value = score(point);
      if (value > bestScore) {
        bestScore = value;
        best = point;
      }
    }
    return best;
  };

  const alongU = (p: Point): number => p.x * u.x + p.y * u.y;
  const alongV = (p: Point): number => p.x * v.x + p.y * v.y;

  return [
    extreme((p) => -alongU(p) - alongV(p)),
    extreme((p) => alongU(p) - alongV(p)),
    extreme((p) => alongU(p) + alongV(p)),
    extreme((p) => -alongU(p) + alongV(p))
  ];
};
