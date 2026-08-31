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
  const { width, height } = matrix;
  const dilated = new Uint8Array(width * height);
  const output = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let any = 0;
      for (let dy = -1; dy <= 1 && any === 0; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const px = x + dx;
          const py = y + dy;
          if (px < 0 || py < 0 || px >= width || py >= height) continue;
          if (matrix.bits[py * width + px] === 1) {
            any = 1;
            break;
          }
        }
      }
      dilated[y * width + x] = any;
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let all = 1;
      for (let dy = -1; dy <= 1 && all === 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const px = x + dx;
          const py = y + dy;
          // Outside the image counts as set, so erosion does not eat the
          // border and shrink a symbol that runs to the frame edge.
          if (px < 0 || py < 0 || px >= width || py >= height) continue;
          if (dilated[py * width + px] === 0) {
            all = 0;
            break;
          }
        }
      }
      output[y * width + x] = all;
    }
  }

  return { bits: output, width, height };
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
  const window = radius * 2 + 1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let offset = -radius; offset <= radius; offset++) {
        const sx = x + offset;
        if (sx < 0 || sx >= width) continue;
        sum += image.data[y * width + sx];
        count++;
      }
      horizontal[y * width + x] = sum / (count === 0 ? 1 : count);
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let offset = -radius; offset <= radius; offset++) {
        const sy = y + offset;
        if (sy < 0 || sy >= height) continue;
        sum += horizontal[sy * width + x];
        count++;
      }
      output[y * width + x] = sum / (count === 0 ? 1 : count);
    }
  }

  void window;
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
