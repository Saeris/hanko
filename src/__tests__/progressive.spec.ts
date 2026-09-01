import { encodeQR } from "etiket/qr";
import { describe, expect, it } from "vitest";
import { createProgressiveScanner } from "../scan/qr/progressive.js";
import type { GrayImage } from "../scan/types.js";

/**
 * The progressive scanner exists because the retry ladder costs more than one
 * frame can afford: measured on the benchmark corpus, the decoder reads 61.6%
 * unlimited and 41.9% at the 120ms a viewfinder needs. A camera is not a
 * still image, so effort can be spread across frames instead of crammed into
 * one.
 */
describe(`progressive scanner`, () => {
  /** Render a symbol to a greyscale image, as a camera frame would arrive. */
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

  const blank = (width: number): GrayImage => ({
    data: new Uint8ClampedArray(width * width).fill(200),
    width,
    height: width
  });

  it(`reads a clear symbol on the first frame`, () => {
    // WHY: the ramp must not delay the easy case. Most scans are of a code
    // held reasonably still in decent light, and making those wait several
    // frames to save effort on hard ones would be a bad trade.
    const scanner = createProgressiveScanner();
    const url = `https://example.com/link?user_code=TFKS`;

    expect(scanner.scan(render(url))?.value).toBe(url);
  });

  it(`raises its budget when a frame does not decode`, () => {
    // WHY: this is the mechanism. A frame that fails should buy the next one
    // more time, so a symbol needing more of the ladder than one frame can
    // afford still gets there within a second at 30fps.
    const scanner = createProgressiveScanner({ initialBudgetMs: 10 });
    const initial = scanner.budgetMs;

    scanner.scan(blank(200));
    expect(scanner.budgetMs).toBeGreaterThan(initial);
  });

  it(`stops raising the budget at its ceiling`, () => {
    // WHY: unbounded growth would eventually stall the preview for seconds on
    // a camera pointed at nothing. The ceiling is what keeps the worst case
    // bounded no matter how long a scan runs.
    const scanner = createProgressiveScanner({
      initialBudgetMs: 10,
      maxBudgetMs: 50
    });

    for (let frame = 0; frame < 20; frame++) scanner.scan(blank(200));
    expect(scanner.budgetMs).toBeLessThanOrEqual(50);
  });

  it(`returns to the cheap budget after a successful read`, () => {
    // WHY: effort is earned by a symbol that is present and hard to read.
    // Once it IS read, the next frames are a different scan — usually of
    // nothing, while the user lowers the phone — and should be cheap again.
    const scanner = createProgressiveScanner({ initialBudgetMs: 10 });
    const url = `https://example.com/link?user_code=TFKS`;

    scanner.scan(blank(200));
    scanner.scan(blank(200));
    expect(scanner.budgetMs).toBeGreaterThan(10);

    expect(scanner.scan(render(url))?.value).toBe(url);
    expect(scanner.budgetMs).toBe(10);
  });

  it(`resets on request`, () => {
    // WHY: the caller knows things the scanner cannot — that the user moved
    // to a different code, or reopened the scanner. Without this, effort
    // earned by one symbol would carry over to an unrelated scene.
    const scanner = createProgressiveScanner({ initialBudgetMs: 10 });

    scanner.scan(blank(200));
    scanner.scan(blank(200));
    expect(scanner.budgetMs).toBeGreaterThan(10);

    scanner.reset();
    expect(scanner.budgetMs).toBe(10);
  });
});
