import { encodeQR } from "etiket/qr";
import { describe, expect, it } from "vitest";
import { binarize, binarizeAt } from "../scan/binarize.js";
import {
  findFinderPatterns,
  finderOutline,
  orientFinders,
  selectBestTriple
} from "../scan/qr/locate.js";
import { createQrDecoder } from "../scan/qr/decoder.js";
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

/**
 * A symbol printed without its quiet zone puts foreign content directly
 * against the finder's outer ring.
 *
 * The spec requires four modules of light margin, and the whole run-length
 * search depends on it: the 1:1:3:1:1 test derives the module size from the
 * sum of five runs, so a dark element merged with the outer run inflates that
 * sum and every comparison fails — including the ones on the undamaged
 * interior. Measuring from the middle three runs instead, which the finder's
 * own light rings bound, recovers those symbols.
 */
describe(`finders without a quiet zone`, () => {
  /** Render a symbol flush against a dark bar, with no quiet zone. */
  const flush = (text: string, scale = 6): GrayImage => {
    const matrix = encodeQR(text, { ecLevel: `M` });
    const size = matrix.length;
    const bar = scale * 3;
    const width = size * scale + bar;
    const data = new Uint8ClampedArray(width * width).fill(255);

    // The symbol occupies the bottom-right, touching a dark bar on two sides.
    for (let y = 0; y < bar; y++) {
      for (let x = 0; x < width; x++) data[y * width + x] = 0;
    }
    for (let y = 0; y < width; y++) {
      for (let x = 0; x < bar; x++) data[y * width + x] = 0;
    }

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!matrix[y][x]) continue;
        for (let py = 0; py < scale; py++) {
          for (let px = 0; px < scale; px++) {
            data[(bar + y * scale + py) * width + bar + x * scale + px] = 0;
          }
        }
      }
    }

    return { data, width, height: width };
  };

  it(`finds finders whose outer run merges with adjacent content`, () => {
    // WHY: the strict ratio derives the module size from all five runs, so a
    // dark neighbour touching the ring makes runs[0] unbounded and rejects a
    // finder whose interior is perfect. This is the `pathological` category's
    // whole difficulty — 57.7% to 69.2% — and a regression would be silent,
    // since the strict rule still finds SOME finders on these images, just
    // never three.
    const image = flush(`https://example.com/link?user_code=TFKS`, 6);
    const matrix = binarize(image, { invert: false });

    const strict = findFinderPatterns(matrix);
    const merged = findFinderPatterns(matrix, true);

    expect(merged.length).toBeGreaterThanOrEqual(strict.length);
    expect(selectBestTriple(merged)).not.toBeNull();
  });

  it(`still rejects runs whose interior is not a finder`, () => {
    // WHY: the relaxation must only forgive the OUTER runs. If it also loosened
    // the interior it would match ordinary dark-light-dark texture, and
    // measured as the only rule it already costs the corpus 70.2% to 64.5% —
    // a version that also accepted bad interiors would be far worse.
    const image: GrayImage = {
      data: new Uint8ClampedArray(40 * 40).fill(255),
      width: 40,
      height: 40
    };
    // A plain dark bar: no 1:3:1 interior anywhere.
    for (let y = 10; y < 30; y++) {
      for (let x = 5; x < 35; x++) image.data[y * 40 + x] = 0;
    }

    expect(
      findFinderPatterns(binarize(image, { invert: false }), true)
    ).toHaveLength(0);
  });
});

/**
 * Sometimes there is no single right threshold.
 *
 * Both binarizers answer "what is the correct threshold?" — one per image from
 * the histogram, one per block from the neighbourhood. On a damaged or
 * unevenly lit symbol that question can have no good answer, and the value
 * that recovers the symbol is not the one either method computes.
 */
describe(`threshold sweeping`, () => {
  it(`reads a symbol whose correct threshold is far from its histogram`, () => {
    // WHY: this is the case the sweep exists for. A symbol rendered in two
    // close greys has a histogram whose peaks are adjacent, so the two-peak
    // midpoint lands between them and both tones threshold the same way. A
    // swept threshold separates them. Measured on the corpus this rung takes
    // `damaged` from 41.7% to 54.2% and `close` from 88.1% to 92.9%.
    const text = `https://example.com/link?user_code=TFKS`;
    const matrix = encodeQR(text, { ecLevel: `M` });
    const size = matrix.length;
    const scale = 6;
    const quiet = 4;
    const width = (size + quiet * 2) * scale;

    // Dark modules at 150, light at 200 — a low-contrast pair sitting well
    // above any midpoint a bimodal search would pick from the quiet zone.
    const data = new Uint8ClampedArray(width * width).fill(200);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!matrix[y][x]) continue;
        for (let py = 0; py < scale; py++) {
          for (let px = 0; px < scale; px++) {
            data[
              ((y + quiet) * scale + py) * width + (x + quiet) * scale + px
            ] = 150;
          }
        }
      }
    }

    const image: GrayImage = { data, width, height: width };
    expect(createQrDecoder({ timeBudgetMs: 0 }).decode(image)?.value).toBe(
      text
    );
  });

  it(`thresholds exactly where told`, () => {
    // WHY: the sweep's whole value is that the CALLER picks the value, so a
    // binarizer that adjusted the threshold it was given would silently
    // collapse the sweep back to one choice.
    const image: GrayImage = {
      data: new Uint8ClampedArray([10, 100, 140, 250]),
      width: 2,
      height: 2
    };

    expect([...binarizeAt(image, 120).bits]).toEqual([1, 1, 0, 0]);
    expect([...binarizeAt(image, 50).bits]).toEqual([1, 0, 0, 0]);
  });
});

/**
 * A frame may hold more than one code.
 *
 * Stages that narrow the work to "where the symbol is" have to narrow to ONE
 * symbol. Boxing every finder candidate together produces a region belonging
 * to no code at all — measured on the `lots` category, that box spans a median
 * 62% of the frame where a single symbol's spans effectively none.
 */
describe(`narrowing to a symbol`, () => {
  const render = (text: string, scale: number): Uint8ClampedArray[] => {
    const matrix = encodeQR(text, { ecLevel: `M` });
    const size = matrix.length;
    const rows: Uint8ClampedArray[] = [];
    for (let y = 0; y < size * scale; y++) {
      const row = new Uint8ClampedArray(size * scale).fill(255);
      for (let x = 0; x < size * scale; x++) {
        if (matrix[Math.floor(y / scale)][Math.floor(x / scale)]) row[x] = 0;
      }
      rows.push(row);
    }
    return rows;
  };

  it(`reads one code with another in the frame`, () => {
    // WHY: cropping and rectifying both fit to a single symbol's finders. If
    // either applied its result to the whole frame, the second code would be
    // distorted or excluded — and the `lots` category, which reads 100%, is
    // exactly this case.
    const first = `https://example.com/link?user_code=TFKS`;
    const scale = 5;
    const tile = render(first, scale);
    const side = tile.length;
    const quiet = 6 * scale;
    const width = side * 2 + quiet * 3;
    const height = side + quiet * 2;
    const data = new Uint8ClampedArray(width * height).fill(255);

    for (const left of [quiet, quiet * 2 + side]) {
      for (let y = 0; y < side; y++) {
        data.set(tile[y], (quiet + y) * width + left);
      }
    }

    expect(
      createQrDecoder({ timeBudgetMs: 0 }).decode({ data, width, height })
        ?.value
    ).toBe(first);
  });
});
