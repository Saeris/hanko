/**
 * Turning a greyscale photograph into black-and-white modules.
 *
 * This is the first stage of decoding a real image and the one that decides
 * how many photographs are readable at all. Everything downstream — finding
 * the symbol, sampling its grid, correcting errors — operates on the output of
 * this step, so a module lost here is lost permanently.
 *
 * It is deliberately NOT a single global threshold. Measured across the BoofCV
 * benchmark corpus, local brightness varies by 119-223 levels out of 255
 * within a single photograph: a page lit from one side, a screen with a
 * reflection, a code half in shadow. One threshold cannot separate dark from
 * light modules across that spread — it either loses the shadowed half of the
 * symbol or floods the lit half. On that corpus jsQR, which thresholds
 * globally, reads 0% of the `brightness` and `monitor` categories.
 *
 * The approach here is the local-average method from ZXing's hybrid binarizer:
 * divide the image into blocks, threshold each against its own neighbourhood,
 * and smooth across block boundaries. It costs one extra pass over the image
 * and is what makes unevenly-lit photographs readable.
 */

import type { BitMatrix, GrayImage } from "./types.js";

/**
 * Block size for local thresholding, in pixels.
 *
 * Eight is small enough to track a shadow edge and large enough that a block
 * usually spans several modules — which matters, because the threshold is
 * meaningless if a block can fall entirely inside one module. At typical
 * scanning distances a module is 3-10 pixels.
 */
const BLOCK_SIZE = 8;

/**
 * Minimum spread within a block before its own average is trusted.
 *
 * A block whose pixels are all nearly the same value contains no edge — it is
 * entirely inside a light region or entirely inside a dark one. Thresholding
 * it against its own mean would split noise down the middle and produce a
 * checkerboard of phantom modules, so such blocks inherit from their
 * neighbours instead.
 */
const MIN_DYNAMIC_RANGE = 24;

/** Convert RGBA pixels to greyscale using perceptual luminance weights. */
export const toGray = (
  rgba: Uint8ClampedArray,
  width: number,
  height: number
): GrayImage => {
  const data = new Uint8ClampedArray(width * height);

  for (let i = 0; i < width * height; i++) {
    const offset = i * 4;
    // Rec. 601 luma. Green dominates because the eye is most sensitive to it,
    // and because QR printing contrast is usually strongest there.
    data[i] =
      (rgba[offset] * 77 + rgba[offset + 1] * 150 + rgba[offset + 2] * 29) >> 8;
  }

  return { data, width, height };
};

/**
 * Enlarge by an integer factor, replicating pixels.
 *
 * The mirror of {@link downscale}, and it exists for the same reason in
 * reverse. Local binarization thresholds over a fixed 8px block, so what
 * matters is not the module size in pixels but its RATIO to that block. A
 * symbol far from the camera can land at two or three pixels per module, at
 * which point one block spans several modules and averages them into a single
 * verdict — the data is destroyed before geometry ever runs.
 *
 * Enlarging the frame changes that ratio without inventing detail. Measured on
 * the benchmark corpus, a 2x pass takes `nominal` from 99 of 125 to 106 and
 * `rotations` from 36 of 44 to 37.
 *
 * Nearest-neighbour rather than interpolation, deliberately. Smooth
 * interpolation manufactures intermediate greys along every module edge, which
 * is exactly the ambiguity the threshold then has to resolve; replication
 * leaves each measured value untouched and changes only the block-to-module
 * ratio, which is the whole point.
 */
/**
 * Cut a rectangular region out of a frame.
 *
 * For stages whose cost scales with pixel count but whose subject occupies a
 * small part of the frame. Measured across the corpus, a symbol's finder
 * bounding box covers a median **13%** of the image it sits in — so a stage
 * that must enlarge in order to work can enlarge that instead of everything.
 *
 * The region is clamped rather than validated, so a caller may pad generously
 * past an edge without checking.
 */
/**
 * Morphological closing on the greyscale image, before any threshold.
 *
 * {@link close} does the same job on a binarized matrix, and by then the
 * information it needs is gone: a 1-bit speckle can only be flipped to its
 * neighbours' bit, where a grey speckle is filled with their actual
 * intensities. Thresholding is the most destructive step in the pipeline —
 * eight bits to one — so an operation that benefits from intensity has to run
 * before it, not after.
 *
 * That ordering is worth real coverage. Measured across the categories where
 * speckle and highlights dominate, running the closing on grey rather than
 * bits recovers images that the binary form cannot: `glare` +5, with
 * `damaged`, `monitor` and `bright_spots` each gaining as well. A specular
 * highlight is exactly the case — its edges are graded in the grey image and
 * hard-clipped after thresholding.
 *
 * Dark-on-light convention: dilation of the dark foreground is a local
 * minimum, erosion a local maximum. Separable, like its binary counterpart.
 */
export const closeGray = (image: GrayImage, radius = 1): GrayImage => {
  const { width, height, data } = image;
  const pass = new Uint8ClampedArray(width * height);
  const output = new Uint8ClampedArray(width * height);

  const sweep = (
    source: Uint8ClampedArray,
    target: Uint8ClampedArray,
    vertical: boolean,
    pick: (best: number, value: number) => number,
    seed: number
  ): void => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let best = seed;
        for (let offset = -radius; offset <= radius; offset++) {
          const sx = vertical ? x : x + offset;
          const sy = vertical ? y + offset : y;
          if (sx < 0 || sy < 0 || sx >= width || sy >= height) continue;
          best = pick(best, source[sy * width + sx]);
        }
        target[y * width + x] = best;
      }
    }
  };

  const min = (best: number, value: number): number =>
    value < best ? value : best;
  const max = (best: number, value: number): number =>
    value > best ? value : best;

  // Dilate the dark, then erode it back: speckle inside a dark region is
  // swallowed, while the region's own extent is preserved.
  sweep(data, pass, false, min, 255);
  sweep(pass, output, true, min, 255);
  sweep(output, pass, false, max, 0);
  sweep(pass, output, true, max, 0);

  return { data: output, width, height };
};

export const crop = (
  image: GrayImage,
  left: number,
  top: number,
  width: number,
  height: number
): GrayImage => {
  const x0 = Math.max(0, Math.min(image.width - 1, Math.round(left)));
  const y0 = Math.max(0, Math.min(image.height - 1, Math.round(top)));
  const x1 = Math.max(x0 + 1, Math.min(image.width, Math.round(left + width)));
  const y1 = Math.max(y0 + 1, Math.min(image.height, Math.round(top + height)));

  const outWidth = x1 - x0;
  const outHeight = y1 - y0;
  const data = new Uint8ClampedArray(outWidth * outHeight);

  for (let y = 0; y < outHeight; y++) {
    const source = (y0 + y) * image.width + x0;
    data.set(image.data.subarray(source, source + outWidth), y * outWidth);
  }

  return { data, width: outWidth, height: outHeight };
};

export const upscale = (image: GrayImage, factor: number): GrayImage => {
  if (factor <= 1) return image;

  const width = image.width * factor;
  const height = image.height * factor;
  const data = new Uint8ClampedArray(width * height);

  for (let y = 0; y < height; y++) {
    const sourceRow = Math.floor(y / factor) * image.width;
    const targetRow = y * width;
    for (let x = 0; x < width; x++) {
      data[targetRow + x] = image.data[sourceRow + Math.floor(x / factor)];
    }
  }

  return { data, width, height };
};

/**
 * Binarize against a threshold the caller chooses.
 *
 * {@link binarizeGlobal} computes one "correct" threshold from the histogram
 * and {@link binarize} computes one per block. Both answer the question
 * "what is the right threshold?", and on a damaged or unevenly lit symbol
 * there often is not one — measured across the corpus, the thresholds that
 * recover an otherwise-unreadable image are spread over the whole range
 * 40-190 with no clustering, and the image's own mean does not predict them
 * (one is read at 120 with a mean of 195).
 *
 * So this exists to be swept. Eleven distinct thresholds recover seventeen
 * images between them; no small set captures most of the gain, which is why
 * the caller supplies the value rather than this guessing better.
 *
 * The obvious alternative was measured and lost. Sauvola thresholding — the
 * method the document-binarization literature favours for degraded images,
 * and which an IEEE study validates specifically for QR under uneven
 * illumination — recovers 3 images across nine tuned variants (windows 15/31/
 * 63, k 0.2/0.34/0.5, via integral images) against this sweep's 11, and adds
 * nothing the sweep does not already find. The reason is in that literature
 * too: Sauvola's threshold collapses where local contrast is low, which is
 * exactly the condition a damaged or glared symbol presents. Its wins are on
 * scanned documents with uneven illumination, a different degradation.
 */
export const binarizeAt = (
  image: GrayImage,
  threshold: number,
  { invert = false }: { invert?: boolean } = {}
): BitMatrix => {
  const bits = new Uint8Array(image.width * image.height);

  for (let i = 0; i < bits.length; i++) {
    const dark = image.data[i] < threshold;
    bits[i] = (invert ? !dark : dark) ? 1 : 0;
  }

  return { bits, width: image.width, height: image.height };
};

/**
 * Binarize against one threshold chosen from the whole image's histogram.
 *
 * The opposite trade to {@link binarize}. A single threshold cannot follow a
 * shadow across a page — which is why local thresholding exists and why it
 * takes the `brightness` and `monitor` categories from nothing to something.
 * But local thresholding invents structure in flat regions, and on a clean,
 * evenly-lit image a global threshold is both more faithful and less prone to
 * that.
 *
 * Neither dominates, so this is a retry rather than a replacement. zxing-cpp
 * reached the same conclusion from the other direction: its issue #809 is an
 * image its local binarizer cannot read and its global one can, and its
 * issue #500 is a prototype for supporting several binarizers for exactly
 * this reason.
 *
 * The threshold is the midpoint between the two dominant peaks of the
 * histogram rather than the mean. A QR is mostly two tones, so the histogram
 * is bimodal, and the mean of a symbol with more light area than dark sits
 * inside the light peak and thresholds half the modules away.
 */
export const binarizeGlobal = (
  image: GrayImage,
  { invert = false }: { invert?: boolean } = {}
): BitMatrix => {
  const histogram = new Uint32Array(32);
  for (const value of image.data) histogram[value >> 3]++;

  // Tallest bucket, then the bucket furthest from it weighted by its own
  // height — the standard two-peak search, which avoids picking the tall
  // peak's immediate neighbour as the second "peak".
  let first = 0;
  for (let i = 1; i < 32; i++) {
    if (histogram[i] > histogram[first]) first = i;
  }

  let second = first;
  let bestScore = 0;
  for (let i = 0; i < 32; i++) {
    const distance = i - first;
    const score = histogram[i] * distance * distance;
    if (score > bestScore) {
      bestScore = score;
      second = i;
    }
  }

  const [low, high] = first < second ? [first, second] : [second, first];

  // Valley between the peaks: the bucket where the fewest pixels sit, scaled
  // by how far it is from the peaks so a flat run does not drag it to an end.
  let valley = low;
  let bestValley = -1;
  for (let i = low + 1; i < high; i++) {
    const fromLow = i - low;
    const fromHigh = high - i;
    const score = fromLow * fromHigh * (high - low) - histogram[i] * 4;
    if (score > bestValley) {
      bestValley = score;
      valley = i;
    }
  }

  const threshold = (valley << 3) + 4;
  const bits = new Uint8Array(image.width * image.height);

  for (let i = 0; i < bits.length; i++) {
    const dark = image.data[i] < threshold;
    bits[i] = (invert ? !dark : dark) ? 1 : 0;
  }

  return { bits, width: image.width, height: image.height };
};

/**
 * Morphological closing on a bit matrix — dilate, then erode.
 *
 * Fills small light specks inside dark regions while leaving real structure
 * intact, because dilation closes a gap smaller than the kernel and the
 * following erosion restores every boundary the dilation moved.
 *
 * The failure this targets is specific: zxing-cpp issue #951 diagnoses an
 * undetected symbol as "white pixels inside the black square that disrupt
 * their detection" of the finder patterns, and its remedy is exactly this
 * operation. Speckle inside a finder breaks the run-length signature — a
 * single light pixel splits one dark run into two — so the pattern stops
 * matching 1:1:3:1:1 even though a human sees it perfectly well.
 *
 * A 3x3 kernel: large enough for sensor speckle and dust, small enough that
 * it cannot close a real one-module gap at any usable resolution.
 */
export const close = (matrix: BitMatrix): BitMatrix => {
  const { width, height, bits } = matrix;

  // Separable. A 3x3 square structuring element factors into a horizontal
  // pass and a vertical one, because a 3x3 neighbourhood is the union of
  // three 1x3 neighbourhoods. That turns nine reads per pixel into six, and
  // removes the inner bounds checks and early-exit branches entirely.
  //
  // Worth doing: measured with deoptkit, this function was 54 of 327 JS ticks
  // — 17% of the decoder's CPU — as the LAST rung in the retry ladder.
  // Two buffers, not four. The four sweeps read one and write the other in
  // turn, so they can ping-pong: on a 1280x720 frame the old form allocated
  // 3.7MB per call, and this runs on half of every ladder rung's passes.
  // Profiled under viewfinder load it was 14% of JS time with the garbage
  // collector visible behind it.
  const scratch = new Uint8Array(width * height);
  const output = new Uint8Array(width * height);
  const horizontal = scratch;
  const dilated = output;
  const vertical = scratch;

  // Dilate: a pixel is set if any of its three horizontal neighbours is.
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const left = x > 0 ? bits[row + x - 1] : 0;
      const right = x + 1 < width ? bits[row + x + 1] : 0;
      horizontal[row + x] = bits[row + x] | left | right;
    }
  }
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const above = y > 0 ? row - width : row;
    const below = y + 1 < height ? row + width : row;
    for (let x = 0; x < width; x++) {
      dilated[row + x] =
        horizontal[row + x] | horizontal[above + x] | horizontal[below + x];
    }
  }

  // Erode: a pixel survives only if all three neighbours are set. Outside the
  // image counts as set, so erosion does not eat the border and shrink a
  // symbol that runs to the frame edge.
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const left = x > 0 ? dilated[row + x - 1] : 1;
      const right = x + 1 < width ? dilated[row + x + 1] : 1;
      vertical[row + x] = dilated[row + x] & left & right;
    }
  }
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const above = y > 0 ? row - width : row;
    const below = y + 1 < height ? row + width : row;
    for (let x = 0; x < width; x++) {
      output[row + x] =
        vertical[row + x] & vertical[above + x] & vertical[below + x];
    }
  }

  return { bits: output, width, height };
};

/**
 * Downscale by box-averaging whole blocks of pixels.
 *
 * Not for speed — for signal. A symbol photographed from a distance on a
 * 12-megapixel sensor has modules two or three pixels wide, and at that scale
 * neither run-length scanning nor shape detection produces reliable
 * structure: measured on the corpus, both detectors return module-size
 * estimates spanning 1.1 to 137.9 pixels within a single image, which is
 * noise rather than measurement.
 *
 * Averaging blocks of pixels down trades resolution the symbol does not have
 * for a cleaner signal it does. BoofCV builds an image pyramid for the same
 * reason and scores 100% on that corpus category.
 *
 * Box averaging rather than nearest-neighbour sampling, because dropping
 * pixels aliases a module grid badly — the very structure being looked for
 * beats against the sampling lattice.
 */
export const downscale = (image: GrayImage, factor: number): GrayImage => {
  if (factor <= 1) return image;

  const width = Math.max(1, Math.floor(image.width / factor));
  const height = Math.max(1, Math.floor(image.height / factor));
  const data = new Uint8ClampedArray(width * height);

  for (let y = 0; y < height; y++) {
    const startY = Math.floor(y * factor);
    const endY = Math.min(image.height, Math.floor((y + 1) * factor));

    for (let x = 0; x < width; x++) {
      const startX = Math.floor(x * factor);
      const endX = Math.min(image.width, Math.floor((x + 1) * factor));

      let sum = 0;
      let count = 0;
      for (let sy = startY; sy < endY; sy++) {
        for (let sx = startX; sx < endX; sx++) {
          sum += image.data[sy * image.width + sx];
          count++;
        }
      }
      data[y * width + x] = count === 0 ? 0 : sum / count;
    }
  }

  return { data, width, height };
};

/**
 * Flip a bit matrix's polarity.
 *
 * Binarization spends nearly all its time computing an adaptive threshold
 * surface; inverting only changes the final comparison against it. Since the
 * decoder tries both polarities on every rung of its retry ladder, computing
 * the surface twice wastes half of that work — measured at 31 of 279 ticks,
 * 11% of the decoder's CPU. Flipping the bits costs one pass over the array.
 */
export const invertMatrix = (matrix: BitMatrix): BitMatrix => {
  const bits = new Uint8Array(matrix.bits.length);
  for (let i = 0; i < bits.length; i++) bits[i] = matrix.bits[i] === 1 ? 0 : 1;
  return { bits, width: matrix.width, height: matrix.height };
};

/**
 * Blur an image with a separable box filter, approximating a Gaussian.
 *
 * Two passes of a box filter — one horizontal, one vertical — is a standard
 * cheap stand-in for a true Gaussian, and it is separable, so cost is linear
 * in radius rather than quadratic.
 *
 * This exists for one specific failure: photographing a screen. Moire banding
 * is frequency ALIASING between the camera sensor grid and the display's
 * sub-pixel grid, so the interference sits at a much higher spatial frequency
 * than the modules do. Low-pass filtering suppresses the banding and leaves
 * the modules — measured on the benchmark corpus, it takes the `monitor`
 * category from 0 of 25 to 10 of 25.
 *
 * It is NOT a free win and must not be applied by default: the same filter
 * takes `blurred` from 5 of 14 down to 1, and `nominal` from 3 to 0. A blurred
 * photograph blurred again is unreadable. Use it as a retry after a sharp
 * pass fails.
 */
export const blur = (image: GrayImage, radius: number): GrayImage => {
  if (radius < 1) return image;

  const { width, height } = image;
  const horizontal = new Uint8ClampedArray(width * height);
  const output = new Uint8ClampedArray(width * height);

  // Running sums rather than a fresh window per pixel.
  //
  // Summing the whole window at every pixel is O(radius) per pixel per axis;
  // adding the entering sample and subtracting the leaving one is O(1),
  // whatever the radius. On a 2.4MP frame at radius 3 that is 7 adds per pixel
  // per axis against 2 — and this is the single most expensive image operation
  // in the decoder, 57ms of a 75ms pipeline, so it is where the arithmetic
  // actually shows.
  //
  // Edges are handled by counting only the samples that exist rather than
  // clamping or wrapping, which keeps the result identical to the previous
  // window-per-pixel form.
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    let count = 0;

    // Prime the window for x = 0: samples 0 .. radius.
    for (let x = 0; x <= radius && x < width; x++) {
      sum += image.data[row + x];
      count++;
    }

    for (let x = 0; x < width; x++) {
      horizontal[row + x] = sum / count;

      // Slide: drop x - radius, take x + radius + 1.
      const leaving = x - radius;
      if (leaving >= 0) {
        sum -= image.data[row + leaving];
        count--;
      }
      const entering = x + radius + 1;
      if (entering < width) {
        sum += image.data[row + entering];
        count++;
      }
    }
  }

  for (let x = 0; x < width; x++) {
    let sum = 0;
    let count = 0;

    for (let y = 0; y <= radius && y < height; y++) {
      sum += horizontal[y * width + x];
      count++;
    }

    for (let y = 0; y < height; y++) {
      output[y * width + x] = sum / count;

      const leaving = y - radius;
      if (leaving >= 0) {
        sum -= horizontal[leaving * width + x];
        count--;
      }
      const entering = y + radius + 1;
      if (entering < height) {
        sum += horizontal[entering * width + x];
        count++;
      }
    }
  }

  return { data: output, width, height };
};

/** Per-block average brightness, and the global average as a fallback. */
const blockAverages = (
  image: GrayImage,
  blocksWide: number,
  blocksHigh: number
): { averages: Int32Array; global: number } => {
  const averages = new Int32Array(blocksWide * blocksHigh);
  let total = 0;

  for (let blockY = 0; blockY < blocksHigh; blockY++) {
    for (let blockX = 0; blockX < blocksWide; blockX++) {
      const startX = blockX * BLOCK_SIZE;
      const startY = blockY * BLOCK_SIZE;
      const endX = Math.min(startX + BLOCK_SIZE, image.width);
      const endY = Math.min(startY + BLOCK_SIZE, image.height);

      let sum = 0;
      let min = 255;
      let max = 0;
      let count = 0;

      for (let y = startY; y < endY; y++) {
        for (let x = startX; x < endX; x++) {
          const value = image.data[y * image.width + x];
          sum += value;
          if (value < min) min = value;
          if (value > max) max = value;
          count++;
        }
      }

      const average = count === 0 ? 128 : sum / count;

      // A flat block has no edge in it. Rather than threshold noise, mark it
      // so the smoothing pass below can take a neighbour's value — the block
      // is inside a solid region, and its neighbours know which one.
      averages[blockY * blocksWide + blockX] =
        max - min >= MIN_DYNAMIC_RANGE ? Math.round(average) : -1;

      total += average;
    }
  }

  return {
    averages,
    global: Math.round(total / Math.max(1, blocksWide * blocksHigh))
  };
};

/**
 * Resolve flat blocks and smooth the threshold surface.
 *
 * Averaging each block against its 5x5 neighbourhood stops a hard threshold
 * step at every block boundary, which would otherwise appear as a grid of
 * false edges — and false edges look exactly like module boundaries to the
 * stage that runs next.
 */
const smoothThresholds = (
  averages: Int32Array,
  blocksWide: number,
  blocksHigh: number,
  globalAverage: number
): Int32Array => {
  const smoothed = new Int32Array(blocksWide * blocksHigh);

  for (let blockY = 0; blockY < blocksHigh; blockY++) {
    for (let blockX = 0; blockX < blocksWide; blockX++) {
      let sum = 0;
      let count = 0;

      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const y = blockY + dy;
          const x = blockX + dx;
          if (y < 0 || x < 0 || y >= blocksHigh || x >= blocksWide) continue;

          const value = averages[y * blocksWide + x];
          // Flat blocks contribute nothing — they have no opinion to average.
          if (value < 0) continue;
          sum += value;
          count++;
        }
      }

      smoothed[blockY * blocksWide + blockX] =
        count === 0 ? globalAverage : Math.round(sum / count);
    }
  }

  return smoothed;
};

/**
 * Binarize a greyscale image into a bit matrix.
 *
 * `true` (1) means DARK, matching the QR convention where a set module is a
 * dark one. Fixing polarity here — at the single boundary where pixels become
 * bits — is deliberate: every stage above this one can then assume one
 * orientation, and none of them has to ask which way round the image was.
 *
 * @param invert Treat light modules as set. Needed for symbols rendered
 *   light-on-dark, which decoders that assume dark-on-light read as nothing at
 *   all. Callers that do not know should try both.
 */
export const binarize = (
  image: GrayImage,
  { invert = false }: { invert?: boolean } = {}
): BitMatrix => {
  const blocksWide = Math.ceil(image.width / BLOCK_SIZE);
  const blocksHigh = Math.ceil(image.height / BLOCK_SIZE);

  const { averages, global } = blockAverages(image, blocksWide, blocksHigh);
  const thresholds = smoothThresholds(averages, blocksWide, blocksHigh, global);

  const bits = new Uint8Array(image.width * image.height);

  for (let y = 0; y < image.height; y++) {
    const blockY = Math.min(blocksHigh - 1, Math.floor(y / BLOCK_SIZE));

    for (let x = 0; x < image.width; x++) {
      const blockX = Math.min(blocksWide - 1, Math.floor(x / BLOCK_SIZE));
      const threshold = thresholds[blockY * blocksWide + blockX];
      const dark = image.data[y * image.width + x] < threshold;

      bits[y * image.width + x] = (invert ? !dark : dark) ? 1 : 0;
    }
  }

  return { bits, width: image.width, height: image.height };
};
