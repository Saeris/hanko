import { describe, expect, it } from "vitest";
import { blur } from "../scan/binarize.js";
import { createLinearDecoder } from "../scan/linear/decoder.js";
import {
  G_CODES,
  L_CODES,
  PARITY_PATTERNS,
  R_CODES,
  checkDigit,
  isValid
} from "../scan/linear/patterns.js";
import type { GrayImage } from "../scan/types.js";

/**
 * The EAN/UPC family, which is one symbology wearing four names.
 *
 * Unlike QR there is no error correction here: a misread is indistinguishable
 * from a read, and the check digit is the only thing between a wrong answer
 * and a confident wrong answer. That shapes what is worth testing — the
 * failure that matters is not "did not read", it is "read the wrong thing".
 */
describe(`linear barcodes`, () => {
  /** Render an EAN-13 exactly as the specification describes it. */
  const render = (
    digits: readonly number[],
    { scale = 3, height = 60, quiet = 9, ink = 0 } = {}
  ): GrayImage => {
    const modules: number[] = [];
    const push = (pattern: readonly number[]): void => {
      for (const bit of pattern) modules.push(bit);
    };

    push([1, 0, 1]);
    const parity = PARITY_PATTERNS[digits[0]];
    for (let i = 0; i < 6; i++) {
      push(parity[i] === 1 ? G_CODES[digits[i + 1]] : L_CODES[digits[i + 1]]);
    }
    push([0, 1, 0, 1, 0]);
    for (let i = 0; i < 6; i++) push(R_CODES[digits[i + 7]]);
    push([1, 0, 1]);

    const width = (modules.length + quiet * 2) * scale;
    const data = new Uint8ClampedArray(width * height).fill(255 - ink);

    for (let y = 0; y < height; y++) {
      for (const [index, module] of modules.entries()) {
        if (module === 0) continue;
        for (let s = 0; s < scale; s++) {
          data[y * width + (quiet + index) * scale + s] = ink;
        }
      }
    }

    return { data, width, height };
  };

  const withCheck = (first: readonly number[]): number[] => [
    ...first,
    checkDigit(first)
  ];

  const ean13 = withCheck([5, 9, 0, 1, 2, 3, 4, 1, 2, 3, 4, 5]);
  const upcA = withCheck([0, 3, 6, 0, 0, 0, 2, 9, 1, 4, 5, 2]);

  it(`reads an EAN-13`, () => {
    // WHY: the baseline. Also pins that the thirteenth digit comes back — it is
    // never drawn, only implied by which parity pattern the left half uses, so
    // a decoder that ignored parity would return twelve plausible digits.
    const decoder = createLinearDecoder({ timeBudgetMs: 0 });
    const symbol = decoder.decode(render(ean13));

    expect(symbol?.format).toBe(`ean_13`);
    expect(symbol?.value).toBe(ean13.join(``));
  });

  it(`reports a UPC-A as twelve digits, not thirteen`, () => {
    // WHY: a UPC-A *is* an EAN-13 whose first digit is zero, so the decoder
    // sees thirteen digits either way. What is printed on the package — and
    // what a product database is keyed by — is the twelve. Returning the
    // leading zero would make every lookup miss, and miss quietly.
    const decoder = createLinearDecoder({ timeBudgetMs: 0 });
    const symbol = decoder.decode(render(upcA));

    expect(symbol?.format).toBe(`upc_a`);
    expect(symbol?.value).toBe(upcA.slice(1).join(``));
    expect(symbol?.value).toHaveLength(12);
  });

  it(`reads a symbol photographed upside down`, () => {
    // WHY: R-codes are the bitwise complement of L, and G is R reversed, so a
    // barcode scanned right-to-left produces a run sequence that still looks
    // valid. Decoding both directions is what makes a label readable whichever
    // way up someone holds the bottle — and getting it wrong yields a
    // plausible wrong number rather than a failure.
    const upright = render(ean13);
    const flipped: GrayImage = {
      width: upright.width,
      height: upright.height,
      data: new Uint8ClampedArray(upright.data.length)
    };

    for (let y = 0; y < upright.height; y++) {
      for (let x = 0; x < upright.width; x++) {
        flipped.data[y * upright.width + x] =
          upright.data[y * upright.width + (upright.width - 1 - x)];
      }
    }

    expect(
      createLinearDecoder({ timeBudgetMs: 0 }).decode(flipped)?.value
    ).toBe(ean13.join(``));
  });

  it(`reads through blur and low contrast`, () => {
    // WHY: a phone photographing a curved can delivers both. The run widths
    // survive blurring because binarization restores the edges; what does not
    // survive is a decoder that measured absolute widths rather than ratios.
    const decoder = createLinearDecoder({ timeBudgetMs: 0 });

    expect(decoder.decode(blur(render(ean13), 2))?.value).toBe(ean13.join(``));
    // Dark at 90, light at 165 — a washed-out print, still bimodal.
    expect(decoder.decode(render(ean13, { ink: 90 }))?.value).toBe(
      ean13.join(``)
    );
  });

  it(`requires more than one row to agree`, () => {
    // WHY: this is the guard that matters. With no error correction, one digit
    // in ten passes the check by chance — and measured against the QR corpus,
    // which contains no linear barcodes at all, single-row acceptance produced
    // a confident EAN-8 on 3 of 51 photographs. Dense QR modules are
    // alternating runs, and occasionally eight of them satisfy everything.
    //
    // A real barcode reads identically on every row through it; a coincidence
    // does not survive being asked twice.
    //
    // Pinned by asking for an impossible amount of agreement rather than by
    // shrinking the image: a one-pixel-tall symbol tests the binarizer's block
    // size instead, since a local threshold needs neighbours to average.
    const image = render(ean13);

    expect(
      createLinearDecoder({ timeBudgetMs: 0, agreement: 1 }).decode(image)
        ?.value
    ).toBe(ean13.join(``));
    expect(
      createLinearDecoder({ timeBudgetMs: 0, agreement: 999 }).decode(image)
    ).toBeNull();
  });

  it(`rejects a code whose check digit does not hold`, () => {
    // WHY: the check digit is the entire verification. A decoder that returned
    // a reading anyway would be worse than one that read nothing, because the
    // caller has no way to tell the difference.
    const corrupted = [...ean13];
    corrupted[12] = (corrupted[12] + 1) % 10;

    expect(isValid(corrupted)).toBe(false);
    expect(
      createLinearDecoder({ timeBudgetMs: 0 }).decode(render(corrupted))
    ).toBeNull();
  });

  it(`computes check digits the GS1 way`, () => {
    // WHY: one algorithm covers GTIN-8, -12 and -13, weighted from the RIGHT.
    // Weighting from the left works for one length and silently breaks the
    // others, which is the kind of bug that only shows on EAN-8.
    expect(checkDigit([5, 9, 0, 1, 2, 3, 4, 1, 2, 3, 4, 5])).toBe(7);
    expect(checkDigit([4, 0, 0, 6, 3, 8, 1, 3, 3, 3, 9, 3])).toBe(1);
  });
});
