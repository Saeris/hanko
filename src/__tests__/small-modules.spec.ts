import { encodeQR } from "etiket/qr";
import { describe, expect, it } from "vitest";
import { upscale } from "../scan/binarize.js";
import { createQrDecoder } from "../scan/qr/decoder.js";
import type { GrayImage } from "../scan/types.js";

/**
 * A symbol can be too small in frame to survive binarization, independently of
 * being in focus, well lit, or squarely presented.
 *
 * Local binarization thresholds over a fixed-size block. What decides whether
 * a module survives is therefore not its size in pixels but its size RELATIVE
 * to that block: once one block spans several modules, it averages them into a
 * single verdict and the data is gone before any geometry runs.
 *
 * That makes small-in-frame a distinct failure mode from blur or low contrast,
 * and one the ladder has to answer separately.
 */
describe(`symbols smaller than the binarizer's block`, () => {
  /** Render a symbol at a chosen module size, with a quiet zone. */
  const render = (text: string, scale: number): GrayImage => {
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

  it(`reads a symbol whose modules are smaller than the threshold block`, () => {
    // WHY: this is the whole reason the upscale rung exists. At two pixels per
    // module the 8px block spans four modules at once, so thresholding averages
    // them away. If someone removes the rung — or raises BLOCK_SIZE without
    // accounting for it — this is the case that silently stops working, and it
    // is a common one: it is simply a code held a little too far from the
    // camera.
    const url = `https://example.com/link?user_code=TFKS`;

    expect(
      createQrDecoder({ timeBudgetMs: 0 }).decode(render(url, 2))?.value
    ).toBe(url);
  });

  it(`preserves every measured value when enlarging`, () => {
    // WHY: the rung must not invent detail. Interpolation would manufacture
    // intermediate greys along module edges — exactly the ambiguity the
    // threshold then has to resolve — so enlargement replicates instead. A
    // change to smooth scaling would still "work" on easy images while
    // undermining the hard ones this rung was added for, so pin the property
    // rather than the implementation.
    const source: GrayImage = {
      data: new Uint8ClampedArray([0, 255, 128, 32]),
      width: 2,
      height: 2
    };

    const enlarged = upscale(source, 2);
    expect(enlarged.width).toBe(4);
    expect(enlarged.height).toBe(4);
    expect([...new Set(enlarged.data)].sort((a, b) => a - b)).toEqual([
      0, 32, 128, 255
    ]);
  });
});
