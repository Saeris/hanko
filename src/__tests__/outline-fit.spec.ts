import { encodeQR } from "etiket/qr";
import { describe, expect, it } from "vitest";
import { binarize } from "../scan/binarize.js";
import {
  findFinderPatterns,
  finderOutline,
  orientFinders,
  selectBestTriple
} from "../scan/qr/locate.js";
import {
  fitTransform,
  sizeFromTimingPattern,
  transformFromOutlines
} from "../scan/qr/sample.js";
import type { GrayImage } from "../scan/types.js";

/**
 * A finder pattern carries more information than its centre.
 *
 * Its outer ring is a square of known size — 7 modules on a side, at a known
 * position in the symbol — so locating its corners yields four measured
 * correspondences rather than one. Three finders give twelve, which
 * over-determines an eight-parameter homography and removes the estimated
 * fourth corner from the fit entirely.
 *
 * That is worth 62.7% to 68.8% on the benchmark corpus, and 40.3% to 52.5%
 * at the 120ms budget a viewfinder runs.
 */
describe(`fitting the grid to measured outlines`, () => {
  const render = (text: string, scale = 6): GrayImage => {
    const matrix = encodeQR(text, { ecLevel: `M` });
    const size = matrix.length;
    const quiet = 4;
    const width = (size + quiet * 2) * scale;
    const data = new Uint8ClampedArray(width * width).fill(255);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!matrix[y][x]) continue;
        for (let py = 0; py < scale; py++) {
          for (let px = 0; px < scale; px++) {
            data[
              ((y + quiet) * scale + py) * width + (x + quiet) * scale + px
            ] = 0;
          }
        }
      }
    }

    return { data, width, height: width };
  };

  it(`traces the finder's outer square, not its core`, () => {
    // WHY: this is the bug that made the whole approach look worthless. A
    // flood fill seeded at the finder's CENTRE fills the 3x3 dark core and
    // stops at the white separator, describing a square 2 modules across
    // while claiming it is 7. Every correspondence is then wrong by the same
    // factor, the fit is garbage, and nothing decodes — silently, because a
    // square is still found. Pin the size so the seed cannot regress.
    const image = render(`https://example.com/link?user_code=TFKS`, 6);
    const matrix = binarize(image, { invert: false });
    const finders = orientFinders(
      selectBestTriple(findFinderPatterns(matrix)) ?? []
    );
    expect(finders).not.toBeNull();

    const outline = finderOutline(matrix, finders!.topLeft);
    expect(outline).not.toBeNull();

    const xs = outline!.map((point) => point.x);
    const width = Math.max(...xs) - Math.min(...xs);

    // The outer square is 7 modules wide; the core alone would be 3.
    expect(width).toBeGreaterThan(finders!.topLeft.moduleSize * 5);
  });

  it(`recovers a transform exactly from its own output`, () => {
    // WHY: the solver is the part that cannot be checked by eye, and a
    // transposed or mis-indexed homography still produces plausible-looking
    // numbers. Round-tripping points through a known transform and refitting
    // them is the check that catches that.
    const known = {
      a11: 2.5,
      a21: 0.3,
      a31: 17,
      a12: -0.4,
      a22: 2.1,
      a32: 23,
      a13: 0.0004,
      a23: 0.0002,
      a33: 1
    };

    const project = (x: number, y: number): { x: number; y: number } => {
      const w = known.a13 * x + known.a23 * y + known.a33;
      return {
        x: (known.a11 * x + known.a21 * y + known.a31) / w,
        y: (known.a12 * x + known.a22 * y + known.a32) / w
      };
    };

    const samples = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0.3, 0.7],
      [0.8, 0.2]
    ] as const;

    const fitted = fitTransform(
      samples.map(([x, y]) => ({
        source: { x, y },
        target: project(x, y)
      }))
    );
    expect(fitted).not.toBeNull();

    for (const [x, y] of [
      [0.15, 0.85],
      [0.5, 0.5],
      [0.95, 0.05]
    ] as const) {
      const expected = project(x, y);
      const w = fitted!.a13 * x + fitted!.a23 * y + fitted!.a33;
      expect((fitted!.a11 * x + fitted!.a21 * y + fitted!.a31) / w).toBeCloseTo(
        expected.x,
        4
      );
      expect((fitted!.a12 * x + fitted!.a22 * y + fitted!.a32) / w).toBeCloseTo(
        expected.y,
        4
      );
    }
  });

  it(`places the symbol's corners where the finders actually are`, () => {
    // WHY: the correspondences are ordered by the SYMBOL's axes, not the
    // image's. On a rotated symbol the top-left corner is not the point
    // nearest the image origin, and pairing by image axes fits a transform to
    // mismatched points — which decodes nothing while looking correct. This
    // asserts the fitted transform actually lands on the measured finders.
    const image = render(`https://example.com/link?user_code=TFKS`, 6);
    const matrix = binarize(image, { invert: false });
    const finders = orientFinders(
      selectBestTriple(findFinderPatterns(matrix)) ?? []
    );
    expect(finders).not.toBeNull();

    const size = encodeQR(`https://example.com/link?user_code=TFKS`, {
      ecLevel: `M`
    }).length;

    const fitted = transformFromOutlines(matrix, finders!, size);
    expect(fitted).not.toBeNull();

    // The unit square's origin is the top-left finder's centre.
    const w = fitted!.a33;
    expect(fitted!.a31 / w).toBeCloseTo(finders!.topLeft.center.x, 0);
    expect(fitted!.a32 / w).toBeCloseTo(finders!.topLeft.center.y, 0);
  });

  it(`measures size by counting timing transitions`, () => {
    // WHY: the span estimate divides by module size, so its error is
    // multiplied by the module count — under foreshortening it lands on the
    // wrong multiple of four or outside the legal range entirely, which used
    // to abort the decode. Counting transitions divides by nothing: a
    // compressed timing pattern still alternates exactly as many times. This
    // pins that the count is exact on a symbol whose size is known.
    const text = `https://example.com/link?user_code=TFKS`;
    const expected = encodeQR(text, { ecLevel: `M` }).length;

    const matrix = binarize(render(text, 6), { invert: false });
    const finders = orientFinders(
      selectBestTriple(findFinderPatterns(matrix)) ?? []
    );
    expect(finders).not.toBeNull();

    expect(sizeFromTimingPattern(matrix, finders!)).toBe(expected);
  });
});
