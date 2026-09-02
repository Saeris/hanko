import { describe, expect, it } from "vitest";
import { blur } from "../scan/binarize.js";
import { createLinearDecoder } from "../scan/linear/decoder.js";
import { describeGtin } from "../scan/linear/gtin.js";
import {
  G_CODES,
  UPC_E_PARITY,
  expandUpcE,
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

  describe(`prefixes`, () => {
    it(`names the blocks that mean something structurally different`, () => {
      // WHY: a book, a magazine and a shop's own weighed-produce label are all
      // EAN-13s and all look alike as digits. The in-store one is the case
      // that matters most — it will never match a product database, and
      // without the prefix a caller has no way to know that rather than
      // assuming the lookup failed.
      expect(describeGtin(`9784873115658`)?.label).toBe(`Book (ISBN)`);
      expect(describeGtin(`9771234567003`)?.label).toBe(`Periodical (ISSN)`);
      expect(describeGtin(`2001234567893`)?.label).toBe(`In-store`);
      expect(describeGtin(`4901234567894`)?.label).toBe(`GS1 Japan`);
    });

    it(`pads a UPC-A before matching`, () => {
      // WHY: prefixes are allocated in the thirteen-digit space, but a UPC-A
      // is reported as the twelve printed on the package. Matching the printed
      // form would read `03` as the block, putting every US product in the
      // wrong one — or in France's, which starts at 30.
      expect(describeGtin(`036000291452`)?.label).toBe(`GS1 US / Canada`);
    });

    it(`says nothing about an EAN-8`, () => {
      // WHY: eight digits are a compressed allocation, not a prefix followed
      // by a company code, so reading the leading digits as a block would
      // invent an answer. Better to say nothing than to say something wrong.
      expect(describeGtin(`12345670`)).toBeNull();
    });
  });

  describe(`uPC-E`, () => {
    /** Render a UPC-E: start guard, six digits, six-module end guard. */
    const renderUpcE = (
      digits: readonly number[],
      check: number,
      scale = 3
    ): GrayImage => {
      const modules: number[] = [];
      const push = (pattern: readonly number[]): void => {
        for (const bit of pattern) modules.push(bit);
      };

      push([1, 0, 1]);
      const parity = UPC_E_PARITY[check];
      for (const [index, digit] of digits.entries()) {
        push(parity[index] === 1 ? G_CODES[digit] : L_CODES[digit]);
      }
      push([0, 1, 0, 1, 0, 1]);

      const quiet = 9;
      const width = (modules.length + quiet * 2) * scale;
      const height = 60;
      const data = new Uint8ClampedArray(width * height).fill(255);

      for (let y = 0; y < height; y++) {
        for (const [index, module] of modules.entries()) {
          if (module === 0) continue;
          for (let s = 0; s < scale; s++) {
            data[y * width + (quiet + index) * scale + s] = 0;
          }
        }
      }

      return { data, width, height };
    };

    it(`expands the six digits into the twelve they stand for`, () => {
      // WHY: a UPC-E is not a short barcode, it is a full GTIN-12 with its
      // zeros squeezed out, and the LAST digit says where they were. Reporting
      // the six printed digits would miss every product database lookup.
      expect(expandUpcE([1, 2, 3, 4, 5, 6], 0)?.join(``)).toBe(`012345000065`);
    });

    it(`reads one, and reports the expanded number`, () => {
      // WHY: end to end. The parity of the six digits encodes the CHECK digit
      // here — the inverse of EAN-13, where it encodes the first — so a
      // decoder that reused the EAN path would produce a plausible wrong
      // number rather than failing.
      const expanded = expandUpcE([1, 2, 3, 4, 5, 6], 0)!;
      const image = renderUpcE([1, 2, 3, 4, 5, 6], expanded[11]);

      const symbol = createLinearDecoder({
        timeBudgetMs: 0,
        formats: [`upc_e`]
      }).decode(image);

      expect(symbol?.format).toBe(`upc_e`);
      expect(symbol?.value).toBe(`012345000065`);
    });

    it(`is off by default`, () => {
      // WHY: this is a measurement, not a preference. A UPC-E is six digits
      // plus a parity pattern and its 35 runs fit inside a full EAN-13's 59,
      // so enabled by default it produced 14 false positives on a corpus
      // containing no UPC-E at all — every misread in that run. It has to be
      // asked for, and a caller that changes this should know why.
      const expanded = expandUpcE([1, 2, 3, 4, 5, 6], 0)!;
      const image = renderUpcE([1, 2, 3, 4, 5, 6], expanded[11]);

      expect(createLinearDecoder({ timeBudgetMs: 0 }).decode(image)).toBeNull();
    });
  });
});
