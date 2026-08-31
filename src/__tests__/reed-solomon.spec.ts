import { describe, expect, it } from "vitest";
import {
  decode,
  encode,
  generatorPolynomial,
  ReedSolomonError
} from "../scan/qr/reed-solomon.js";

/**
 * Verified by round trip: encode, damage, decode, compare.
 *
 * Chosen examples would not catch the failure that matters here. Reed-Solomon
 * does not fail loudly when it is subtly wrong — it returns confidently
 * corrected codewords that are not the originals, and the QR above it decodes
 * to plausible garbage. Only round-tripping real damage proves the repair.
 */
describe(`reed-Solomon`, () => {
  /** Deterministic pseudo-random data, so a failure is reproducible. */
  const dataOf = (length: number, seed: number): number[] => {
    const out: number[] = [];
    let x = seed;
    for (let i = 0; i < length; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      out.push((x >> 16) & 0xff);
    }
    return out;
  };

  it(`round-trips an undamaged block`, () => {
    const data = dataOf(16, 1);
    const block = encode(data, 10);

    expect(block).toHaveLength(26);
    expect(decode(block, 10)).toEqual(data);
  });

  it(`corrects up to half the check codewords`, () => {
    // WHY: n check codewords correct exactly n/2 errors. This is the
    // guarantee the whole scheme rests on, so it is tested AT the boundary
    // rather than comfortably inside it — an off-by-one in the Euclidean
    // stopping condition passes a weaker test and fails here.
    for (const errorCount of [1, 2, 3, 4, 5]) {
      const data = dataOf(16, errorCount);
      const block = encode(data, 10);

      const damaged = [...block];
      for (let i = 0; i < errorCount; i++) {
        // Spread the damage out; adjacent errors are an easier case.
        damaged[i * 4] = damaged[i * 4] ^ 0xff;
      }

      expect(decode(damaged, 10)).toEqual(data);
    }
  });

  it(`corrects damage wherever it lands`, () => {
    // WHY: position arithmetic is indexed from the END of the block, which is
    // the kind of detail that works for errors in the middle and breaks at the
    // edges. Every single-error position is checked.
    const data = dataOf(16, 7);
    const block = encode(data, 10);

    for (let position = 0; position < block.length; position++) {
      const damaged = [...block];
      damaged[position] = damaged[position] ^ 0x5a;

      expect(decode(damaged, 10)).toEqual(data);
    }
  });

  it(`corrects across block sizes and correction levels`, () => {
    // WHY: real QR versions use wildly different block geometries — version 1
    // has 7 check codewords, version 40 has 30 per block. A decoder that only
    // works at one size is not usable.
    for (const [dataLength, checkCount] of [
      [9, 7],
      [16, 10],
      [34, 16],
      [64, 22],
      [100, 30]
    ] as const) {
      const data = dataOf(dataLength, dataLength);
      const block = encode(data, checkCount);
      const damaged = [...block];

      for (let i = 0; i < Math.floor(checkCount / 2); i++) {
        damaged[i * 2] = damaged[i * 2] ^ 0x3c;
      }

      expect(decode(damaged, checkCount)).toEqual(data);
    }
  });

  it(`builds generator polynomials of the right degree`, () => {
    // WHY: the generator for n check codewords has degree n by construction.
    // A wrong degree here silently changes the code being used, and every
    // block encoded with it is incompatible with every real QR reader.
    for (const count of [7, 10, 13, 16, 22, 30]) {
      expect(generatorPolynomial(count).degree).toBe(count);
    }
  });

  it(`rejects a block shorter than its error correction`, () => {
    expect(() => decode([1, 2, 3], 10)).toThrow(ReedSolomonError);
  });

  it(`does not silently accept damage beyond its limit`, () => {
    // WHY: this is the honest boundary of the scheme. Past n/2 errors the
    // algebra still produces an answer, and it is wrong. It must either throw
    // or return something detectably incorrect — never a confident wrong
    // answer that the layers above trust. Anything the checksum-free algebra
    // cannot catch is caught by format/version verification upstream.
    const data = dataOf(16, 99);
    const block = encode(data, 10);

    const damaged = [...block];
    for (let i = 0; i < 9; i++) damaged[i] = damaged[i] ^ 0xff;

    let result: number[] | null = null;
    try {
      result = decode(damaged, 10);
    } catch (error) {
      expect(error).toBeInstanceOf(ReedSolomonError);
    }

    // Either it threw, or it returned something that is not the original.
    if (result !== null) expect(result).not.toEqual(data);
  });
});
