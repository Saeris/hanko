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

import {
  binarize,
  binarizeGlobal,
  blur,
  close,
  downscale,
  upscale,
  binarizeAt,
  crop,
  invertMatrix
} from "../binarize.js";
import type {
  BitMatrix,
  DecodedSymbol,
  GrayImage,
  SymbolDecoder
} from "../types.js";
import {
  alignmentCentersFor,
  estimateCornerFromEdges,
  locateAlignmentGrid,
  refineBottomRight
} from "./alignment.js";
import { decodeMatrix } from "./decode-matrix.js";
import {
  findFinderBlobs,
  findFinderPatterns,
  orientFinders,
  selectBestTriple,
  type FinderTriple
} from "./locate.js";
import {
  applyTransform,
  estimateBottomRight,
  estimateSize,
  rectifySymbol,
  unreadableModules,
  refineTransform,
  samplePiecewise,
  searchCorner,
  sampleGrid,
  transformForSymbol,
  transformFromOutlines,
  sizeFromTimingPattern
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
   * Milliseconds to spend before giving up, or `0` for no limit.
   *
   * The retry ladder is what reads difficult images, and it is priced for a
   * still photograph rather than a viewfinder. Measured on 1024x768 frames, a
   * symbol that decodes costs 12 to 32ms while one that cannot be read at all
   * costs 570 to 700 — roughly 25 times more, and the early exit cannot help
   * because a finder pattern genuinely is present.
   *
   * That asymmetry is backwards for a camera: the expensive case happens
   * exactly when someone is holding the phone at a bad angle and moving it, so
   * a scanner that reads 43% of stills would stutter at under two frames a
   * second precisely when the user is trying to line up a shot. The next frame
   * is nearly free and probably better, so spending 700ms on this one is a bad
   * trade in a live loop and a good one for a single still.
   *
   * Defaults to 120ms, which fits comfortably inside a frame at 5 scans per
   * second. Set `0` when decoding a still image, where the whole ladder is
   * worth running.
   */
  timeBudgetMs?: number;

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
/**
 * Largest frame worth enlarging, in pixels.
 *
 * Enlarging costs four times the pixel count, and every stage after it pays
 * that. Two megapixels is the point past which a symbol is very unlikely to be
 * small enough in frame to need it while the pass still costs the most.
 */
const UPSCALE_LIMIT = 2_000_000;

/**
 * Candidate count past which a frame is treated as grain for the deep search.
 *
 * Sixty: no corpus image below that count needs the deep search to decode,
 * and every image above it that decodes does so on a cheaper rung. See the
 * gate in `decodeBinarized`.
 */
const NOISE_CANDIDATES = 60;

/**
 * Binarization passes, cheapest-per-recovery first.
 *
 * `[denoise, global]`. See the loop in `attempt` for the measurements behind
 * the order.
 */
const PASSES: ReadonlyArray<readonly [boolean, boolean]> = [
  [false, false],
  [false, true],
  [true, false],
  [true, true]
];

/**
 * Fixed thresholds to try when every adaptive choice has failed.
 *
 * Spread across the range rather than concentrated, because the thresholds
 * that rescue an image are themselves spread across it — see
 * {@link binarizeAt}. Twenty apart: closer measured no better, and each step
 * costs a full pass.
 */
const THRESHOLD_SWEEP = [60, 80, 100, 120, 140, 160, 180, 200] as const;

/**
 * Candidate symbol regions in a frame, largest-looking first.
 *
 * One region per finder triple, not one box around every candidate. A frame
 * may hold several codes, and boxing their finders together produces a region
 * belonging to no symbol — measured on the `lots` category, that box spans a
 * median 62% of the frame where a single symbol's spans effectively none.
 *
 * Falls back to the whole frame when no triple can be assembled, so a caller
 * always has something to work on.
 */
const symbolRegions = (
  image: GrayImage,
  finders: FinderTriple | null
): GrayImage[] => {
  if (finders === null) return [image];

  const corners = [finders.topLeft, finders.topRight, finders.bottomLeft];
  const xs = corners.map((pattern) => pattern.center.x);
  const ys = corners.map((pattern) => pattern.center.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const width = Math.max(...xs) - left;
  const height = Math.max(...ys) - top;

  // The triple spans finder CENTRES, so the symbol extends about 3.5 modules
  // past them on every side; padding by a third of the span covers that with
  // room for the quiet zone.
  const padX = Math.max(8, width / 3);
  const padY = Math.max(8, height / 3);

  const region = crop(
    image,
    left - padX,
    top - padY,
    width + padX * 2,
    height + padY * 2
  );

  // Only worth it if the crop is actually smaller; a symbol filling the frame
  // gains nothing and a degenerate triple could produce something larger.
  return region.width * region.height < image.width * image.height * 0.9
    ? [region, image]
    : [image];
};

const decodeBinarized = (
  image: GrayImage,
  invert: boolean,
  global = false,
  denoise = false,
  deepSearch = false,
  /** A prepared matrix, when the caller already has one for this pass. */
  prepared?: BitMatrix,
  /** Abandon expensive stages when this returns true. */
  exhausted?: () => boolean
): DecodedSymbol | null => {
  const binarized =
    prepared ??
    (global ? binarizeGlobal(image, { invert }) : binarize(image, { invert }));
  const matrix = denoise ? close(binarized) : binarized;

  // Two detectors, pooled. Run-length scanning reads the 1:1:3:1:1 signature
  // and handles perspective well; blob detection reads the finder as a nested
  // shape and handles small modules well, where band widths of two or three
  // pixels destroy the ratio. Neither dominates, and candidates that are not
  // finders are rejected by scoring further down.
  const patterns = findFinderPatterns(matrix);

  // Scored rather than taking the first three. Across the benchmark corpus
  // the rotations, high_version and brightness categories return MORE than
  // three candidates on nearly every image, so an arbitrary three discards
  // the right answer and loses a symbol that was successfully found.
  // Scored rather than taking the first three. Across the benchmark corpus
  // the rotations, high_version and brightness categories return MORE than
  // three candidates on nearly every image, so an arbitrary three discards
  // the right answer and loses a symbol that was successfully found.
  //
  // Clearance filtering — dropping candidates with no quiet zone around them
  // — is deliberately NOT applied here. It works exactly as designed on large
  // symbols, cutting 13 candidates to 3 and choosing all three real finders,
  // but measured 51.5% to 51.3% because a symbol shot against a dark edge has
  // a poor clearance score legitimately. `withClearance` remains exported for
  // callers who know their symbols have clean quiet zones.
  let triple = patterns.length >= 3 ? selectBestTriple(patterns) : null;

  // Fall back to shape-based detection, POOLED with whatever the scan found.
  //
  // Scoring the two detectors separately was tried on the theory that their
  // module-size estimates are incommensurable — one derived from run lengths,
  // one from a bounding box — and measured slightly worse (39.3% against
  // 39.4%). Pooling lets a triple mix a confidently-scanned finder with a
  // blob-detected one, which is often exactly the right answer.
  //
  // Only attempted when the scan is short of a full triple but found at least
  // one candidate: that means a symbol is probably present and being read
  // badly, rather than absent. Flooding every dark region costs 372ms on a
  // 12-megapixel frame, so it must not run speculatively.
  if (triple === null && patterns.length > 0 && patterns.length < 3) {
    const blobs = findFinderBlobs(matrix);
    if (blobs.length > 0) triple = selectBestTriple([...patterns, ...blobs]);
  }

  // Last resort: re-scan tolerating an outer run merged with adjacent content.
  //
  // A symbol printed without its quiet zone puts a dark element against the
  // finder's outer ring, so the leading or trailing dark run grows without
  // bound and the 1:1:3:1:1 test fails on runs that are otherwise perfect.
  // Measuring the module from the interior instead recovers those.
  //
  // Guarded the same way as the blob fallback, and for a stronger reason: as
  // the only rule it roughly triples the candidate rows, which took the corpus
  // from 70.2% to 64.5% — `high_version` to zero — and made the benchmark five
  // times slower. Behind a "found something, but not three" guard it costs
  // nothing on symbols whose quiet zone is intact.
  if (triple === null && patterns.length > 0) {
    const merged = findFinderPatterns(matrix, true);
    if (merged.length >= 3) triple = selectBestTriple(merged);
  }

  if (triple === null) return null;

  const finders = orientFinders(triple);
  if (finders === null) return null;

  // Size from the finder spans, and the timing pattern as a second opinion.
  //
  // `estimateSize` divides the finder span by the module size, so an error in
  // the module size is multiplied by the module count. Under foreshortening
  // the near arm measures wider than the far one and the quotient lands on the
  // wrong multiple of four — or outside the legal range, which used to abort
  // the decode outright on 7 of the remaining `perspective` failures.
  const measured = sizeFromTimingPattern(matrix, finders);
  let size = estimateSize(finders) ?? measured;
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

  // Before searching for a corner, try measuring one instead.
  //
  // The transform above is fitted to three finder CENTRES plus an estimated
  // fourth corner, so a guess is present in every sample it takes. Each
  // finder's outer square is 7 modules on a side at a known position, so
  // tracing its outline gives four measured points per finder and twelve in
  // total — an over-determined fit with no estimate in it.
  //
  // Measured on the corpus with flat sampling alone, twelve points read
  // `perspective` 18 of 26 against four points' 4, `nominal` 60 of 109
  // against 38, and `glare` 9 of 31 against 3.
  if (decoded === null) {
    const candidates = [size, size - 4, size + 4];
    // Counting timing transitions does not divide by anything, so it survives
    // the foreshortening that defeats the span estimate. Tried after it rather
    // than instead of it: the span estimate is right far more often, and
    // sweeping scan lines to find the timing row is not free.
    if (measured !== null && !candidates.includes(measured)) {
      candidates.push(measured);
    }

    for (const candidateSize of candidates) {
      if (candidateSize < 21 || candidateSize > 177) continue;

      const fitted = transformFromOutlines(matrix, finders, candidateSize);
      if (fitted === null) break;

      const fittedGrid = sampleGrid(matrix, fitted, candidateSize);
      if (fittedGrid === null) continue;

      const fittedDecode = decodeMatrix(fittedGrid);
      if (fittedDecode !== null) {
        transform = fitted;
        sampled = fittedGrid;
        decoded = fittedDecode;
        size = candidateSize;
        break;
      }
    }
  }

  // Each corner is tried at the estimated size and its neighbours. Size comes
  // from finder spacing divided by module size, so an error in either lands
  // on the wrong multiple of four — and rotation is the clearest case:
  // between 43 and 47 degrees the module-size correction overshoots and the
  // estimate reads 33 where the truth is 29, while 29 decodes perfectly at
  // every one of those angles. Only the estimate was ever wrong.
  //
  // Nested rather than run as a separate pass because the two errors
  // interact: correcting the size while holding a wrong corner still does not
  // decode, so they have to vary together.
  const sizes = [size, size - 4, size + 4].filter(
    (candidate) => candidate >= 21 && candidate <= 177
  );

  for (const corner of candidates) {
    if (decoded !== null) break;

    for (const candidateSize of sizes) {
      const candidateTransform = transformForSymbol(
        finders,
        candidateSize,
        corner
      );
      const candidateGrid = sampleGrid(
        matrix,
        candidateTransform,
        candidateSize
      );
      if (candidateGrid === null) continue;

      const candidateDecode = decodeMatrix(candidateGrid);
      if (candidateDecode !== null) {
        transform = candidateTransform;
        sampled = candidateGrid;
        decoded = candidateDecode;
        size = candidateSize;
        break;
      }
    }
  }

  if (sampled === null) return null;

  // Still nothing. Search for a better transform rather than computing one.
  //
  // Repeatedly across this corpus, symbols located correctly to within a
  // module still failed to decode, and no single corner estimate fixed them —
  // a brute-force corner search recovered only 4 of 15 perspective images.
  // The missing piece was never a better formula but a way to tell "better"
  // from "worse" without knowing the answer, which `scoreTransform` supplies:
  // a QR's finders, timing lines and alignment patterns sit at positions the
  // standard fixes, so a transform can be graded by whether sampling those
  // positions finds them.
  if (decoded === null) {
    const refined = refineTransform(
      matrix,
      transform,
      size,
      alignmentCentersFor(version)
    );
    const refinedGrid = sampleGrid(matrix, refined, size);
    if (refinedGrid !== null) {
      const refinedDecode = decodeMatrix(refinedGrid);
      if (refinedDecode !== null) {
        transform = refined;
        sampled = refinedGrid;
        decoded = refinedDecode;
      }
    }
  }

  // Still nothing. Search the fourth corner by fitness rather than deriving
  // it. Every geometric derivation has fallen short here, while supplying a
  // known-good corner takes `perspective` from 2 of 23 images to 7 — so the
  // information is recoverable but not computable, which makes it a search.
  //
  // Gated on `deepSearch`, because it is by far the most expensive stage in
  // the decoder: 625 candidate transforms scored against refinement's 80. Run
  // unconditionally it starves the cheaper retry rungs above it of their time
  // budget, which measured as `close` collapsing from 9 of 14 to 0 — the
  // search itself is valuable, but not at the price of everything after it.
  // Skipped when the frame produced implausibly many candidates.
  //
  // Sensor grain generates spurious 1:1:3:1:1 runs everywhere: a noisy
  // 1280x720 frame yields 181-193 finder candidates against 0-5 for an
  // ordinary photograph, and the ladder then grades transforms against noise
  // that can never decode — `scoreTransform` alone takes 40% of CPU on such a
  // frame, and the frame costs seconds.
  //
  // Rejecting the frame outright is not safe: 10 real corpus images exceed 100
  // candidates, `monitor/image003` reaches 333, and the whole `lots` category
  // (several codes in one frame, read 100%) sits at 182-188 by design. But
  // every one of those decodes on the cheap path — 7 of 7 in `lots`, 4 of 4 in
  // `monitor` — because they hold real symbols. Only the expensive search is
  // wasted on grain, so only the expensive search is skipped.
  if (decoded === null && deepSearch && patterns.length <= NOISE_CANDIDATES) {
    // Searched at each plausible size, not just the estimated one. Measured
    // on the `perspective` category, supplying a known-good corner takes it
    // from 4 of 23 images to 8, and a corner WITH a size sweep to 10 — so the
    // two errors interact here exactly as they do under rotation, and
    // correcting either alone leaves images on the table.
    for (const candidateSize of sizes) {
      if (decoded !== null) break;

      if (exhausted?.() === true) break;

      for (const candidate of searchCorner(
        matrix,
        finders,
        candidateSize,
        moduleSize,
        alignmentCentersFor((candidateSize - 17) / 4),
        estimated,
        exhausted
      )) {
        const candidateGrid = sampleGrid(matrix, candidate, candidateSize);
        if (candidateGrid === null) continue;

        const candidateDecode = decodeMatrix(candidateGrid);
        if (candidateDecode !== null) {
          transform = candidate;
          sampled = candidateGrid;
          decoded = candidateDecode;
          size = candidateSize;
          break;
        }
      }
    }
  }

  // Retry telling Reed-Solomon where the damage is.
  //
  // Placed as a retry rather than folded into the sampling above, because
  // building the mask costs a pass over every module and the overwhelming
  // majority of frames decode without it — this way a healthy symbol pays
  // nothing and only a damaged one pays at all.
  //
  // The capacity is real: `2 * errors + erasures <= check codewords`, so a
  // codeword the decoder is TOLD about costs one check symbol instead of two.
  // Measured against a synthetic blob on a version 3 symbol at ecM, 15% of the
  // area decodes 0% of the time as errors and 100% as erasures.
  if (decoded === null && sampled !== null) {
    const unreliable = unreadableModules(image, transform, size);
    // Only worth a second decode when something actually looks unreadable.
    if (unreliable.some((flag) => flag === 1)) {
      decoded = decodeMatrix(sampled, unreliable);
    }
  }

  // Flat sampling failed. On a large symbol that usually means the surface is
  // not flat: a page bows, and one homography models a plane. Measured on a
  // version 40 symbol with verifiably exact corners, interior alignment
  // patterns sat up to 1.09 modules from where the plane predicted — past
  // half a module, every sample lands on the wrong module.
  //
  // Alignment patterns are a grid of known points across the whole symbol, so
  // locating them measures the warp directly and each cell gets a transform
  // fitted to its own corners.
  // Version 2 and up, not 7 and up. The warp this corrects is a property of
  // the SURFACE, not of the symbol: measured on the `curved` category,
  // alignment patterns sit a median of 0.70 modules off the plane — past the
  // half-module threshold where sampling reads the wrong module — regardless
  // of version. Gating at 7 came from first diagnosing this on a version 40
  // symbol and assuming it was a large-symbol phenomenon.
  //
  // Every version from 2 carries at least one alignment pattern, which is
  // the minimum this needs.
  if (decoded === null && version >= 2) {
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
  retryBlurred = true,
  timeBudgetMs = 120
}: QrDecoderOptions = {}): SymbolDecoder => {
  const attempt = (
    image: GrayImage,
    deepSearch = false,
    exhausted?: () => boolean
  ): DecodedSymbol | null => {
    // Local binarization first, then global. Neither dominates: local follows
    // a shadow across a page and is what makes unevenly-lit photographs
    // readable at all, while global is more faithful on a clean image because
    // local thresholding invents structure in flat regions. zxing-cpp reached
    // the same conclusion — its issue #809 is an image its local binarizer
    // cannot read and its global one can.
    // Local then global binarization; each pass optionally denoised. Denoising
    // is a morphological closing that fills light speckle inside dark regions
    // — zxing-cpp #951 diagnoses an undetected symbol as exactly that, "white
    // pixels inside the black square that disrupt their detection", since one
    // stray pixel splits a finder's dark run in two and breaks the 1:1:3:1:1
    // signature a human still sees perfectly well.
    //
    // Last in the ladder because it is the most destructive: closing erases
    // real detail as readily as noise, so it must only run once everything
    // gentler has failed.
    // Ordered by cost per ATTEMPT, which is not cost per recovery.
    //
    // Instrumented across a quarter of the corpus, the four combinations
    // recover 107 / 13 / 3 / 2 images at 646 / 4949 / 7729 / 15124 ms per
    // recovery — so plain/local is four fifths of every success at an eighth
    // the cost of the next best, and it must come first.
    //
    // But reordering the other three by that same measure — putting
    // denoise/local ahead of plain/global, which recovers four times as
    // cheaply per hit — cost the 120ms budgeted rate two images. Under a
    // budget what matters is what each attempt COSTS, not what it eventually
    // yields: a global binarization is 14ms against denoising's 35ms, so it
    // deserves the earlier slot even though it wins less often. Ranking by
    // yield spends the budget before the cheap pass gets its turn.
    for (const [denoise, global] of PASSES) {
      // The corner search runs only on the plainest binarization, not on
      // every combination. It costs about 48ms per candidate size and three
      // sizes are tried, so allowing it inside all four denoise/global
      // combinations across both polarities multiplied it eightfold — over
      // a second per preprocessing pass, and the ladder has several.
      //
      // A symbol that needs denoising AND a corner search was not going to
      // decode anyway: the search corrects geometry, and denoising is for
      // images whose modules are damaged, which is a different fault.
      const deep = deepSearch && !denoise && !global;

      // Binarized once per pass, then flipped for the second polarity.
      // Binarization is dominated by computing the adaptive threshold
      // surface, and inversion only changes the comparison against it, so
      // running it twice discards half that work on every rung.
      const upright = global ? binarizeGlobal(image) : binarize(image);

      if (polarity !== `light-on-dark`) {
        const normal = decodeBinarized(
          image,
          false,
          global,
          denoise,
          deep,
          upright,
          exhausted
        );
        if (normal !== null) return normal;
      }

      if (polarity !== `dark-on-light`) {
        const inverted = decodeBinarized(
          image,
          true,
          global,
          denoise,
          deep,
          invertMatrix(upright),
          exhausted
        );
        if (inverted !== null) return inverted;
      }
    }

    return null;
  };

  /**
   * Re-run with the binarizer's block grid shifted half a block.
   *
   * Local binarization divides the image into a fixed grid anchored at the
   * origin, so a symbol's position RELATIVE TO THAT GRID changes how it
   * binarizes — two photographs of the same code, differing only in framing,
   * can produce different modules. zxing-cpp hit this exactly: its issue #966
   * reports a symbol detected at one position and not another, and the
   * maintainer traced it to "some arbitrary 8x8 grid related to the inner
   * workings of the binarization algorithm... just one pixel difference after
   * binarization".
   *
   * Measured here, one in nine decodable images is sensitive to a few pixels
   * of translation. Offsetting the image by half a block moves every block
   * boundary onto different pixels, so a symbol that straddled one badly no
   * longer does.
   */
  /**
   * Locate the symbol and resample it square, or `null` if it cannot be found.
   *
   * The automatic form of Lightroom's Guided Upright: that tool needs a person
   * to draw guides because nothing in a photograph says what was straight,
   * while a QR tells us — its three finder centres sit at module coordinates
   * the specification fixes.
   */
  /**
   * Locate one symbol cheaply, for the stages that need to know where it is.
   *
   * Both the rectify rung and the crop before upscaling want the same thing —
   * a plausible triple — and each was binarizing and scanning independently.
   * This is the cheap "is there a code, and roughly where" pass those stages
   * share: one binarization and one finder scan, whose result then narrows
   * everything after it.
   *
   * Cached for the frame, since the rungs that use it run on the same image.
   */
  const locateOnce = (image: GrayImage): FinderTriple | null => {
    const cached = located.get(image);
    if (cached !== undefined) return cached;

    const patterns = findFinderPatterns(binarize(image));
    const triple = patterns.length >= 3 ? selectBestTriple(patterns) : null;
    const finders = triple === null ? null : orientFinders(triple);

    located.set(image, finders);
    return finders;
  };

  const located = new Map<GrayImage, FinderTriple | null>();

  const rectifyUpright = (image: GrayImage): GrayImage | null => {
    const finders = locateOnce(image);
    if (finders === null) return null;

    const size = estimateSize(finders);
    if (size === null) return null;

    return rectifySymbol(image, finders, size, 8);
  };

  const shifted = (image: GrayImage): GrayImage => {
    const offset = 4;
    const width = image.width - offset;
    const height = image.height - offset;
    if (width < 21 || height < 21) return image;

    const data = new Uint8ClampedArray(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        data[y * width + x] =
          image.data[(y + offset) * image.width + x + offset]!;
      }
    }
    return { data, width, height };
  };

  return {
    decode: (image: GrayImage): DecodedSymbol | null => {
      // Measured from the first pass rather than before it, so a budget can
      // never prevent the cheapest attempt from running at all.
      const started = performance.now();
      const spent = (): boolean =>
        timeBudgetMs > 0 && performance.now() - started > timeBudgetMs;

      const sharp = attempt(image);
      if (sharp !== null) return sharp;

      // Bail before the expensive retries when the frame plainly holds no
      // symbol. A camera loop sees far more empty frames than codes, and the
      // full ladder costs about half a second on a 720p frame — enough to cap
      // a scanner at two frames a second scanning nothing at all.
      //
      // The test is deliberately weak: a single finder candidate anywhere, in
      // either polarity, is enough to justify the retries. Retrying exists
      // precisely to rescue symbols the first pass reads badly, so this must
      // only reject frames where there is nothing to rescue.
      //
      // Checked on the BLURRED image as well as the sharp one. Gating on the
      // sharp pass alone rejected 24 of 718 corpus images outright, two of
      // which a later pass decoded — concentrated in `damaged` and
      // `perspective`, exactly the categories where the first binarization
      // finds nothing and a retry rescues it. Blur is one cheap pass against
      // the whole ladder, so this keeps nearly all of the saving.
      const radius = Math.max(
        2,
        Math.round(Math.min(image.width, image.height) / 500)
      );

      // Only the run-length scan, deliberately. Blob detection floods every
      // dark region and costs 372ms on a 12-megapixel frame; running it here
      // would spend that on frames containing nothing, which is the case this
      // exit exists to make cheap. A symbol that only the blob detector can
      // see is lost — an acceptable trade, since the run-length scan finds
      // SOMETHING in all but 24 of the 718 corpus images, and this gate needs
      // only one candidate anywhere to let the full ladder proceed.
      const hasCandidate = (candidate: GrayImage): boolean =>
        findFinderPatterns(binarize(candidate)).length > 0 ||
        findFinderPatterns(binarize(candidate, { invert: true })).length > 0;

      // Run on a downscaled copy when the frame is large enough to spare it.
      //
      // The gate exists to make an empty frame cheap, and on a 2.4MP frame it
      // had become more expensive than the rungs it protects: `hasCandidate`
      // does two binarizations and two finder scans, it is called twice, and
      // the blurred call pays 77ms for the blur alone — 64% of the 120ms
      // budget a viewfinder runs at, before a single retry.
      //
      // Halving each dimension quarters every one of those costs. A finder
      // large enough for the ladder to recover survives it: the gate only
      // needs to know whether ANY candidate exists anywhere, not to locate it
      // precisely.
      // A mip chain, built lazily and shared.
      //
      // The ladder asks for the same reductions more than once — the gate and
      // the downscale rung both want half size, and the blurred gate and the
      // blur rung both want the same radius at full size. Each was recomputed,
      // and on a 2.4MP frame a blur is 77ms and a halving 6ms.
      //
      // Levels are cached rather than precomputed because most frames never
      // reach the rungs that need them: an empty frame should pay for one
      // reduction, not a whole pyramid.
      const levels = new Map<number, GrayImage>([[1, image]]);
      const level = (factor: number): GrayImage => {
        const cached = levels.get(factor);
        if (cached !== undefined) return cached;
        const built = downscale(image, factor);
        levels.set(factor, built);
        return built;
      };

      const blurred = new Map<GrayImage, GrayImage>();
      const blurOf = (source: GrayImage, r: number): GrayImage => {
        const cached = blurred.get(source);
        if (cached !== undefined) return cached;
        const built = blur(source, r);
        blurred.set(source, built);
        return built;
      };

      const gateImage =
        Math.min(image.width, image.height) >= 600 ? level(2) : image;
      const gateRadius = Math.max(
        2,
        Math.round(Math.min(gateImage.width, gateImage.height) / 500)
      );

      // The cheap check first, and full resolution only to overturn a
      // rejection. An empty frame — the common case, and the one this exists
      // for — pays only the quarter-size pass; a frame the small pass doubts
      // costs one more scan rather than losing a symbol, which downscaling
      // alone measured at one image.
      if (
        !hasCandidate(gateImage) &&
        !hasCandidate(blurOf(gateImage, gateRadius)) &&
        (gateImage === image ||
          (!hasCandidate(image) && !hasCandidate(blurOf(image, radius))))
      ) {
        return null;
      }

      // Rungs run cheapest first, so a time budget buys as many attempts as
      // it can before running out. Measured on a 1024x768 frame: downscale
      // 6ms, local binarize 16ms, global binarize 24ms, blur 28ms, denoise
      // 31ms. This was previously ordered by when each rung was written,
      // which put downscaling — the cheapest, and the one that took `close`
      // from 28.6% to 31.0% and `damaged` from 22.9% to 27.1% — last.
      //
      // Downscaling only helps an image large enough to spare the resolution.
      // The guard wraps the LOOP rather than returning, because every rung
      // after it is unrelated to image size; guarding with a return silently
      // skipped the deep search on small frames and cost `nominal` 10 of 14
      // images down to 4.
      if (Math.min(image.width, image.height) >= 600) {
        for (const factor of [2, 3]) {
          if (spent()) return null;
          const smaller = attempt(level(factor));
          if (smaller !== null) return smaller;
        }
      }

      // Rectify and re-read. A projective transform already corrects
      // perspective during sampling, so this is not about geometry — it is
      // about what the BINARIZER sees. In an oblique photograph a module at
      // the far edge is a fraction of the size it is near the camera, and one
      // block size cannot suit both: measured on `perspective`, images that
      // fail have a mean leg ratio of 1.58 and modules down to 2.4 pixels,
      // against 1.14 and 7.5 pixels for those that decode.
      //
      // Rectifying makes every module the same size, so binarization and
      // detection run on uniform data. Worth one image each on `perspective`,
      // `glare` and `damaged`.
      if (spent()) return null;
      const upright = rectifyUpright(image);
      if (upright !== null) {
        const rectified = attempt(upright);
        if (rectified !== null) return rectified;
      }

      // Ordered by MEASURED cost per image recovered, not by when each rung
      // was written or by the cost of its preprocessing step alone.
      //
      // Instrumenting every rung across a third of the corpus gives, in
      // milliseconds spent per image it alone recovered: sharp 364, downscale
      // x3 634, downscale x2 833, rectify 1534, shifted 4359, deep 6525,
      // sweep 6049, blur 12549, upscale 61205. The ladder had been ordered by
      // the cost of the transform each rung applies, which is a different
      // quantity — enlarging is one cheap pass, but every stage after it then
      // works on four times the pixels.
      //
      // Under a time budget the order IS a coverage decision: a rung that runs
      // early spends budget the rungs behind it would have converted at a
      // better rate.
      if (spent()) return null;
      const offset = attempt(shifted(image));
      if (offset !== null) return offset;

      if (spent()) return null;
      const deep = attempt(image, true, spent);
      if (deep !== null) return deep;

      if (spent()) return null;
      const softened = attempt(blurOf(image, radius));
      if (softened === null && !retryBlurred) return null;
      if (softened !== null) return softened;

      // The mirror of downscaling: a symbol small in frame. Local
      // binarization thresholds over a fixed 8px block, so a symbol at two or
      // three pixels per module has one block spanning several of them —
      // averaged into a single verdict before geometry ever runs. Enlarging
      // restores the ratio, taking `nominal` from 99 of 125 to 101 and the
      // corpus from 62.1% to 62.7%.
      //
      // Placed LAST despite being a binarization fix rather than a geometric
      // one, because it is the most expensive rung on the ladder: enlarging
      // 2x quadruples the pixel count and every stage after it pays that.
      // Measured mid-ladder it cost the 120ms budgeted rate 1.8 points — the
      // rung itself gains, but it spends budget that cheaper rungs behind it
      // would have converted at a better rate. Capped by area for the same
      // reason.
      if (image.width * image.height <= UPSCALE_LIMIT) {
        if (spent()) return null;

        // Enlarge the SYMBOL, not the frame.
        //
        // The rung fixes a block-to-module ratio, which is a property of the
        // symbol; enlarging everything around it buys nothing and costs
        // everything, since every later stage then works on four times the
        // pixels. Measured, the transform itself is 18ms of a 245ms rung — the
        // other 227ms is the pipeline running at quadruple size.
        //
        // Cropped per TRIPLE rather than around all candidates. A frame
        // holding several codes — the `lots` category, read 100% — has
        // candidates spread across it, and their combined box spans a median
        // 62% of the frame while any single symbol's spans effectively none.
        // Boxing them together would both defeat the saving and merge distinct
        // symbols into one region belonging to neither.
        for (const region of symbolRegions(image, locateOnce(image))) {
          if (spent()) return null;
          const larger = attempt(upscale(region, 2));
          if (larger !== null) return larger;
        }
      }

      // Last: sweep a plain threshold across its range.
      //
      // Both binarizers answer "what is the right threshold?" — one per image,
      // one per block. On a damaged or unevenly lit symbol there often is not
      // one: measured across the corpus, the thresholds that recover an
      // otherwise-unreadable image spread over 40-190 with no clustering, and
      // the image's own mean does not predict them. Eleven distinct values
      // recover seventeen images between them, so no smaller set would do.
      //
      // Sauvola was measured here first, since the document-binarization
      // literature prefers it for degraded images and an IEEE study validates
      // it for QR under uneven illumination. Nine tuned variants recovered 3
      // images against this sweep's 11, and none the sweep missed — its
      // threshold collapses exactly where local contrast is low, which is what
      // damage and glare produce. See `binarizeAt`.
      //
      // Last on the ladder because it is the most expensive rung: a whole pass
      // per threshold. Everything above it is cheaper per image recovered, and
      // the time budget stops this before it runs on a live frame.
      for (const threshold of THRESHOLD_SWEEP) {
        if (spent()) return null;

        const swept = decodeBinarized(
          image,
          false,
          false,
          false,
          false,
          binarizeAt(image, threshold)
        );
        if (swept !== null) return swept;
      }

      return null;
    }
  };
};
