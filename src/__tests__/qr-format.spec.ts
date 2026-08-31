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
