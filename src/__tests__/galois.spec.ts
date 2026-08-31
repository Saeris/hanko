import { describe, expect, it } from "vitest";
import { add, divide, exp, inverse, multiply } from "../scan/qr/galois.js";

/**
 * These verify FIELD AXIOMS, not chosen examples.
 *
 * A wrong table here does not crash — it silently corrects errors into the
 * wrong bytes, and a QR decodes to plausible garbage. Exhaustive checks over
 * all 256 elements are cheap and are the only way to be sure the generated
 * tables are the field ISO/IEC 18004 specifies.
 */
describe(`gF(256)`, () => {
  it(`makes addition its own inverse`, () => {
    // WHY: the field has characteristic 2, so `a + a === 0` for every element.
    // Any table where this fails is not GF(256), and Reed-Solomon's error
    // locator maths silently stops working.
    for (let a = 0; a < 256; a++) expect(add(a, a)).toBe(0);
  });

  it(`treats 1 as the multiplicative identity`, () => {
    for (let a = 0; a < 256; a++) expect(multiply(a, 1)).toBe(a);
  });

  it(`annihilates with zero`, () => {
    // WHY: zero has no logarithm. A table lookup that forgot this would read
    // LOG[0] and return a plausible non-zero product.
    for (let a = 0; a < 256; a++) expect(multiply(a, 0)).toBe(0);
  });

  it(`makes division undo multiplication`, () => {
    // WHY: exhaustive over every non-zero pair — 65k cases, and the property
    // that Reed-Solomon's syndrome evaluation depends on most directly.
    for (let a = 1; a < 256; a++) {
      for (let b = 1; b < 256; b++) {
        expect(divide(multiply(a, b), b)).toBe(a);
      }
    }
  });

  it(`gives every non-zero element an inverse`, () => {
    for (let a = 1; a < 256; a++) expect(multiply(a, inverse(a))).toBe(1);
  });

  it(`is commutative and associative under multiplication`, () => {
    for (let a = 0; a < 256; a += 7) {
      for (let b = 0; b < 256; b += 11) {
        expect(multiply(a, b)).toBe(multiply(b, a));
        for (let c = 0; c < 256; c += 13) {
          expect(multiply(multiply(a, b), c)).toBe(multiply(a, multiply(b, c)));
        }
      }
    }
  });

  it(`distributes multiplication over addition`, () => {
    // WHY: distributivity is what lets polynomial arithmetic work at all. It
    // is also the axiom most likely to survive a wrong PRIMITIVE constant,
    // so it is checked against the others rather than alone.
    for (let a = 0; a < 256; a += 5) {
      for (let b = 0; b < 256; b += 9) {
        for (let c = 0; c < 256; c += 17) {
          expect(multiply(a, add(b, c))).toBe(
            add(multiply(a, b), multiply(a, c))
          );
        }
      }
    }
  });

  it(`cycles the generator with period 255`, () => {
    // WHY: the generator must be primitive — it has to visit all 255 non-zero
    // elements before repeating. A non-primitive polynomial produces a shorter
    // cycle, which collapses the field and breaks error correction in ways
    // that only show up on specific data.
    const seen = new Set<number>();
    for (let i = 0; i < 255; i++) seen.add(exp(i));

    expect(seen.size).toBe(255);
    expect(seen.has(0)).toBe(false);
    expect(exp(0)).toBe(1);
    expect(exp(255)).toBe(1);
  });

  it(`refuses division and inversion by zero`, () => {
    // WHY: loudly, rather than returning 0 and corrupting a codeword. A silent
    // wrong answer here is indistinguishable from data that failed to correct.
    expect(() => divide(1, 0)).toThrow(/zero/iu);
    expect(() => inverse(0)).toThrow(/zero/iu);
  });
});
