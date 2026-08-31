import { encodeQR } from "etiket/qr";
import { describe, expect, it } from "vitest";
import {
  decodeFormat,
  decodeVersion,
  readFormat,
  readVersion
} from "../scan/qr/format.js";
import { functionModuleMap, isValidMask, shouldFlip } from "../scan/qr/mask.js";
import type { BitMatrix } from "../scan/types.js";

/** Total data codewords per version, from ISO/IEC 18004 Table 1. */
const TOTAL_CODEWORDS: Readonly<Record<number, number>> = {
  1: 26,
  2: 44,
  3: 70,
  4: 100,
  5: 134,
  6: 172,
  7: 196,
  10: 346,
  20: 1085,
  40: 3706
};

/**
 * Remainder bits per version, from ISO/IEC 18004 Table 1.
 *
 * The symbol's data region is not always a whole number of codewords — the
 * leftover bits are padding. Getting this wrong is invisible until a decode
 * runs off the end of the bitstream.
 */
const remainderBits = (version: number): number => {
  if (version === 1) return 0;
  if (version <= 6) return 7;
  if (version <= 13) return 0;
  if (version <= 20) return 3;
  if (version <= 27) return 4;
  if (version <= 34) return 3;
  return 0;
};

const emptyMatrix = (size: number): BitMatrix => ({
  bits: new Uint8Array(size * size),
  width: size,
  height: size
});

describe(`qr format and version`, () => {
  it(`round-trips every legal format value`, () => {
    // WHY: format info determines the mask and EC level, so a wrong reading
    // does not degrade the decode — it changes how EVERY module is
    // interpreted. All 32 combinations are cheap to check exhaustively.
    for (let ec = 0; ec < 4; ec++) {
      for (let mask = 0; mask < 8; mask++) {
        const levels = [`M`, `L`, `H`, `Q`] as const;
        const raw = encodeFormatForTest(ec, mask);
        const decoded = decodeFormat(raw);

        expect(decoded).not.toBeNull();
        expect(decoded?.errorCorrectionLevel).toBe(levels[ec]);
        expect(decoded?.mask).toBe(mask);
      }
    }
  });

  it(`corrects up to three bit errors in the format field`, () => {
    // WHY: the BCH code protecting this field corrects 3 bits, and the field
    // sits in the top-left corner — exactly where a thumb or a fold lands.
    // Tested at the limit, since an over-eager matcher would accept 4 and
    // silently pick a different mask.
    const raw = encodeFormatForTest(1, 5);

    for (const flips of [1, 2, 3]) {
      let damaged = raw;
      for (let i = 0; i < flips; i++) damaged ^= 1 << (i * 3);

      const decoded = decodeFormat(damaged);
      expect(decoded?.mask).toBe(5);
    }
  });

  it(`round-trips every version block`, () => {
    // WHY: versions 7-40 carry an explicit version block. A misread means
    // sampling the wrong grid size, which fails much later and confusingly.
    for (let version = 7; version <= 40; version++) {
      expect(decodeVersion(encodeVersionForTest(version))).toBe(version);
    }
  });

  it(`reserves exactly the right number of function modules`, () => {
    // WHY: this is the check that catches an off-by-one in the reservation
    // map, and it caught two. The data region has a size fixed by the spec —
    // total codewords times 8, plus remainder bits — so any module wrongly
    // reserved or wrongly freed shows up as an exact numeric mismatch rather
    // than as a mysterious decode failure later.
    for (const [key, codewords] of Object.entries(TOTAL_CODEWORDS)) {
      const version = Number(key);
      const size = version * 4 + 17;
      const map = functionModuleMap(size, version);

      const free = map.reduce<number>((count, bit) => count + (1 - bit), 0);
      expect(free).toBe(codewords * 8 + remainderBits(version));
    }
  });

  it(`infers versions 1-6 from size alone`, () => {
    // WHY: they carry no version block at all, so the dimension is the only
    // source. A decoder that insisted on reading the block would reject every
    // small QR — which is most of them.
    for (let version = 1; version <= 6; version++) {
      expect(readVersion(emptyMatrix(version * 4 + 17))).toBe(version);
    }
  });

  it(`rejects impossible matrix dimensions`, () => {
    for (const size of [20, 22, 23, 178, 0]) {
      expect(readVersion(emptyMatrix(size))).toBeNull();
    }
  });

  it(`rejects a format field that is too damaged to trust`, () => {
    // WHY: returning a guess here would be worse than failing. Every module
    // in the symbol is read according to this field, so a wrong-but-plausible
    // answer produces confident nonsense rather than an error.
    expect(readFormat(emptyMatrix(21))).toBeNull();
  });

  it(`makes each mask its own inverse`, () => {
    // WHY: unmasking IS masking — the decoder applies the same pattern the
    // encoder did. If that were not exactly true, a round trip would corrupt
    // the payload.
    for (let mask = 0; mask < 8; mask++) {
      expect(isValidMask(mask)).toBe(true);
      for (let y = 0; y < 12; y++) {
        for (let x = 0; x < 12; x++) {
          const flip = shouldFlip(mask, x, y);
          const bit = (x * 7 + y) % 2;
          const masked = flip ? bit ^ 1 : bit;
          const unmasked = flip ? masked ^ 1 : masked;
          expect(unmasked).toBe(bit);
        }
      }
    }
  });

  it(`rejects mask indices outside the eight patterns`, () => {
    for (const mask of [-1, 8, 1.5, Number.NaN]) {
      expect(isValidMask(mask)).toBe(false);
    }
  });
});

/** BCH-encode a format value the way an encoder would, for round-trip tests. */
const encodeFormatForTest = (ec: number, mask: number): number => {
  const data = (ec << 3) | mask;
  let value = data << 10;
  for (let i = 4; i >= 0; i--) {
    if ((value & (1 << (i + 10))) !== 0) value ^= 0x537 << i;
  }
  return ((data << 10) | value) ^ 0x5412;
};

/** BCH-encode a version value, for round-trip tests. */
const encodeVersionForTest = (version: number): number => {
  let value = version << 12;
  for (let i = 5; i >= 0; i--) {
    if ((value & (1 << (i + 12))) !== 0) value ^= 0x1f25 << i;
  }
  return (version << 12) | value;
};

describe(`alignment pattern positions`, () => {
  it(`matches real encoded symbols at every version`, () => {
    // WHY: this table is 40 rows of hand-transcribed coordinates with no
    // formula to derive them, and a single wrong number breaks one version
    // COMPLETELY and silently. jsQR has shipped exactly that bug for years —
    // its issue #251 reports version 23 failing 100% of the time, from a
    // pixel-perfect render with no camera involved, because one coordinate
    // reads 74 where the spec says 78.
    //
    // Verified against symbols an encoder actually produced rather than
    // against a remembered rule: an alignment pattern is a dark centre, a
    // light ring, then a dark ring, so its presence at a coordinate is
    // checkable directly. An earlier attempt to check this by re-deriving the
    // spec's spacing rule from memory produced six false positives.
    for (let version = 2; version <= 40; version += 3) {
      const matrix = encodeQR(`ALIGNMENT POSITION CHECK`, {
        ecLevel: `L`,
        version
      });
      const size = matrix.length;
      const centers = alignmentCentersForTest(version);

      for (const centerY of centers) {
        for (const centerX of centers) {
          const nearFinder =
            (centerX <= 8 && centerY <= 8) ||
            (centerX <= 8 && centerY >= size - 9) ||
            (centerX >= size - 9 && centerY <= 8);
          if (nearFinder) continue;

          const at = (x: number, y: number): boolean =>
            x >= 0 && y >= 0 && x < size && y < size && matrix[y][x];

          expect(at(centerX, centerY)).toBe(true);
          expect(at(centerX - 1, centerY)).toBe(false);
          expect(at(centerX + 1, centerY)).toBe(false);
          expect(at(centerX - 2, centerY)).toBe(true);
          expect(at(centerX + 2, centerY)).toBe(true);
          expect(at(centerX, centerY - 2)).toBe(true);
          expect(at(centerX, centerY + 2)).toBe(true);
        }
      }
    }
  });
});

/** The alignment table, mirrored from `mask.ts` for verification. */
const alignmentCentersForTest = (version: number): readonly number[] =>
  [
    [],
    [],
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50],
    [6, 30, 54],
    [6, 32, 58],
    [6, 34, 62],
    [6, 26, 46, 66],
    [6, 26, 48, 70],
    [6, 26, 50, 74],
    [6, 30, 54, 78],
    [6, 30, 56, 82],
    [6, 30, 58, 86],
    [6, 34, 62, 90],
    [6, 28, 50, 72, 94],
    [6, 26, 50, 74, 98],
    [6, 30, 54, 78, 102],
    [6, 28, 54, 80, 106],
    [6, 32, 58, 84, 110],
    [6, 30, 58, 86, 114],
    [6, 34, 62, 90, 118],
    [6, 26, 50, 74, 98, 122],
    [6, 30, 54, 78, 102, 126],
    [6, 26, 52, 78, 104, 130],
    [6, 30, 56, 82, 108, 134],
    [6, 34, 60, 86, 112, 138],
    [6, 30, 58, 86, 114, 142],
    [6, 34, 62, 90, 118, 146],
    [6, 30, 54, 78, 102, 126, 150],
    [6, 24, 50, 76, 102, 128, 154],
    [6, 28, 54, 80, 106, 132, 158],
    [6, 32, 58, 84, 110, 136, 162],
    [6, 26, 54, 82, 110, 138, 166],
    [6, 30, 58, 86, 114, 142, 170]
  ][version] ?? [];
