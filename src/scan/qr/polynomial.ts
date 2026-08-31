/**
 * Polynomials over GF(256).
 *
 * Reed-Solomon treats a block of codewords as the coefficients of a
 * polynomial, so decoding is polynomial algebra: evaluate it at known points
 * to find syndromes, solve for an error locator, then evaluate again to find
 * the magnitudes. Everything here exists to serve that.
 *
 * Coefficients are stored **highest degree first**, matching how the QR spec
 * writes generator polynomials. The alternative reads more naturally in code
 * (`coefficients[i]` being the x^i term) but forces a mental reversal every
 * time this is checked against ISO/IEC 18004, which is where the errors come
 * from.
 *
 * Leading zeroes are always stripped, so `degree` is meaningful and two
 * equal polynomials have one representation.
 */

import { add, divide, multiply } from "./galois.js";

/** Drop leading zero coefficients so `degree` means what it says. */
const normalize = (coefficients: readonly number[]): readonly number[] => {
  let first = 0;
  while (first < coefficients.length - 1 && coefficients[first] === 0) first++;
  return coefficients.slice(first);
};

/** A polynomial over GF(256), highest degree first. */
export class Polynomial {
  readonly coefficients: readonly number[];

  constructor(coefficients: readonly number[]) {
    if (coefficients.length === 0) {
      throw new Error(`A polynomial needs at least one coefficient`);
    }
    this.coefficients = normalize(coefficients);
  }

  /** The zero polynomial — the additive identity. */
  static zero(): Polynomial {
    return new Polynomial([0]);
  }

  /** `coefficient * x^degree`, the building block for constructing others. */
  static monomial(degree: number, coefficient: number): Polynomial {
    if (degree < 0) throw new Error(`Monomial degree must not be negative`);
    if (coefficient === 0) return Polynomial.zero();

    const coefficients = Array.from<number>({ length: degree + 1 }).fill(0);
    coefficients[0] = coefficient;
    return new Polynomial(coefficients);
  }

  get degree(): number {
    return this.coefficients.length - 1;
  }

  get isZero(): boolean {
    return this.coefficients[0] === 0;
  }

  /** The coefficient of `x^degree`. */
  coefficientAt(degree: number): number {
    return this.coefficients[this.coefficients.length - 1 - degree] ?? 0;
  }

  /**
   * Evaluate at `x`, by Horner's method.
   *
   * Horner rather than summing `c * x^i` term by term: it needs one multiply
   * and one add per coefficient instead of a running power, and this is the
   * innermost loop of syndrome calculation.
   */
  evaluateAt(x: number): number {
    if (x === 0) return this.coefficientAt(0);

    let result = this.coefficients[0];
    for (let i = 1; i < this.coefficients.length; i++) {
      result = add(multiply(result, x), this.coefficients[i]);
    }
    return result;
  }

  /**
   * Add another polynomial.
   *
   * Also subtraction: the field has characteristic 2, so `a + b` and `a - b`
   * are the same operation.
   */
  add(other: Polynomial): Polynomial {
    if (this.isZero) return other;
    if (other.isZero) return this;

    const [shorter, longer] =
      this.coefficients.length > other.coefficients.length
        ? [other.coefficients, this.coefficients]
        : [this.coefficients, other.coefficients];

    const difference = longer.length - shorter.length;
    const sum = longer.slice(0, difference);
    for (let i = difference; i < longer.length; i++) {
      sum.push(add(shorter[i - difference], longer[i]));
    }
    return new Polynomial(sum);
  }

  /** Multiply by another polynomial. */
  multiply(other: Polynomial): Polynomial {
    if (this.isZero || other.isZero) return Polynomial.zero();

    const a = this.coefficients;
    const b = other.coefficients;
    const product = Array.from<number>({
      length: a.length + b.length - 1
    }).fill(0);

    for (let i = 0; i < a.length; i++) {
      for (let j = 0; j < b.length; j++) {
        product[i + j] = add(product[i + j], multiply(a[i], b[j]));
      }
    }
    return new Polynomial(product);
  }

  /** Multiply every coefficient by a scalar. */
  multiplyScalar(scalar: number): Polynomial {
    if (scalar === 0) return Polynomial.zero();
    if (scalar === 1) return this;

    return new Polynomial(this.coefficients.map((c) => multiply(c, scalar)));
  }

  /** Multiply by `coefficient * x^degree`. */
  multiplyMonomial(degree: number, coefficient: number): Polynomial {
    if (degree < 0) throw new Error(`Monomial degree must not be negative`);
    if (coefficient === 0) return Polynomial.zero();

    return new Polynomial([
      ...this.coefficients.map((c) => multiply(c, coefficient)),
      ...Array.from<number>({ length: degree }).fill(0)
    ]);
  }

  /**
   * Divide by `other`, returning quotient and remainder.
   *
   * Long division, one term at a time. Needed by the Euclidean algorithm that
   * solves for the error locator polynomial.
   */
  divide(other: Polynomial): { quotient: Polynomial; remainder: Polynomial } {
    if (other.isZero) throw new Error(`Polynomial division by zero`);

    let quotient = Polynomial.zero();
    // Seeded from a copy rather than `this` so the loop reassigns a plain
    // local: the accumulator is what changes each round, not the receiver.
    let remainder = new Polynomial(this.coefficients);

    const denominatorLeading = other.coefficientAt(other.degree);
    const inverseLeading = divide(1, denominatorLeading);

    while (remainder.degree >= other.degree && !remainder.isZero) {
      const degreeDifference = remainder.degree - other.degree;
      const scale = multiply(
        remainder.coefficientAt(remainder.degree),
        inverseLeading
      );

      quotient = quotient.add(Polynomial.monomial(degreeDifference, scale));
      remainder = remainder.add(
        other.multiplyMonomial(degreeDifference, scale)
      );
    }

    return { quotient, remainder };
  }
}
