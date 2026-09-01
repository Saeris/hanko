/**
 * Reed-Solomon error correction.
 *
 * This is what makes a QR readable when part of it is scratched, glared out,
 * or covered by a logo. The encoder appends check codewords chosen so that the
 * whole block, read as a polynomial, evaluates to zero at a known set of
 * points. If any evaluation comes back non-zero, something changed in transit.
 *
 * The decode runs in four steps, each answering one question:
 *
 * 1. **Syndromes** — did anything change? (evaluate at the known points)
 * 2. **Euclidean algorithm** — where and by how much, jointly? (solve for the
 *    error locator and evaluator)
 * 3. **Chien search** — which positions? (find the locator roots)
 * 4. **Forney** — what were those codewords originally? (magnitudes)
 *
 * A block with `n` check codewords corrects `n / 2` errors. Past that the
 * algebra still produces an answer — the wrong one — so a successful return
 * means "repaired if repairable", and the layers above verify their own
 * results independently rather than trusting this one.
 */

import { add, exp, inverse, multiply } from "./galois.js";
import { Polynomial } from "./polynomial.js";

/** Raised when a block is damaged beyond what its check codewords can repair. */
export class ReedSolomonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = `ReedSolomonError`;
  }
}

/**
 * Evaluate the received block at each of the `errorCodewordCount` points.
 *
 * All zero means the block is intact. Anything else encodes where the damage
 * is, in a form the Euclidean step can solve.
 */
const syndromes = (
  received: Polynomial,
  errorCodewordCount: number
): { values: number[]; hasError: boolean } => {
  const values: number[] = [];
  let hasError = false;

  for (let i = 0; i < errorCodewordCount; i++) {
    const value = received.evaluateAt(exp(i));
    values.push(value);
    if (value !== 0) hasError = true;
  }

  // Collected lowest-power first but consumed as polynomial coefficients,
  // which this codebase stores highest-degree first.
  values.reverse();
  return { values, hasError };
};

/**
 * Run the extended Euclidean algorithm until the remainder is short enough.
 *
 * Solves for the error locator (sigma) and evaluator (omega) together.
 * Stopping early — once the remainder degree falls below half the check
 * codeword count — is what separates this from an ordinary GCD: that point is
 * exactly where the pair describes the errors.
 */
const euclidean = (
  a: Polynomial,
  b: Polynomial,
  limit: number,
  /**
   * Degree at which to stop, when erasures raise it above the usual half.
   *
   * With `e` erasures the algorithm may run until the remainder degree falls
   * below `(limit + e) / 2` rather than `limit / 2` — and that extra room is
   * precisely where the additional correction capacity comes from.
   */
  stopDegree = Math.floor(limit / 2)
): { locator: Polynomial; evaluator: Polynomial } => {
  let rLast = a;
  let r = b;
  let tLast = Polynomial.zero();
  let t = new Polynomial([1]);

  while (r.degree >= stopDegree) {
    const rLastLast = rLast;
    const tLastLast = tLast;
    rLast = r;
    tLast = t;

    if (rLast.isZero) {
      throw new ReedSolomonError(
        `Remainder vanished before the locator was solved`
      );
    }

    // One division, both outputs: the quotient drives the locator recurrence
    // and the remainder drives the evaluator. Calling divide twice would
    // double the cost of the hot loop for nothing.
    const { quotient, remainder } = rLastLast.divide(rLast);
    r = remainder;
    t = quotient.multiply(tLast).add(tLastLast);

    if (r.degree >= rLast.degree) {
      throw new ReedSolomonError(`Euclidean algorithm failed to converge`);
    }
  }

  const constantTerm = t.coefficientAt(0);
  if (constantTerm === 0) {
    throw new ReedSolomonError(`Error locator has no constant term`);
  }

  // Both scaled so the locator constant term is 1, which is what the Forney
  // step below assumes.
  const scale = inverse(constantTerm);
  return {
    locator: t.multiplyScalar(scale),
    evaluator: r.multiplyScalar(scale)
  };
};

/**
 * Find error positions by testing every field element — the Chien search.
 *
 * Exhaustive on purpose: the field has 255 non-zero elements, so this is
 * cheaper than anything clever, and closed forms exist only for degree 1 and 2.
 */
const errorPositions = (locator: Polynomial): number[] => {
  const count = locator.degree;
  if (count === 1) return [locator.coefficientAt(1)];

  const positions: number[] = [];
  for (let i = 1; i < 256 && positions.length < count; i++) {
    if (locator.evaluateAt(i) === 0) positions.push(inverse(i));
  }

  if (positions.length !== count) {
    throw new ReedSolomonError(
      `Locator degree ${count} but found ${positions.length} roots`
    );
  }
  return positions;
};

/**
 * Compute how much each damaged codeword changed — the Forney algorithm.
 *
 * The denominator is the formal derivative of the locator evaluated at the
 * position. Computing it as a product over the *other* roots avoids
 * differentiating explicitly, and sidesteps the trap that in GF(2^k) every
 * even-power term differentiates away, because its coefficient is added to
 * itself.
 */
const errorMagnitudes = (
  evaluator: Polynomial,
  positions: readonly number[]
): number[] =>
  positions.map((position, i) => {
    const positionInverse = inverse(position);

    let denominator = 1;
    for (let j = 0; j < positions.length; j++) {
      if (i === j) continue;
      // `add` is XOR: the field has characteristic 2, so this is the ordinary
      // (1 - x) of the Forney formulation.
      denominator = multiply(
        denominator,
        add(1, multiply(positions[j], positionInverse))
      );
    }

    if (denominator === 0) {
      throw new ReedSolomonError(`Forney denominator vanished`);
    }

    return multiply(
      evaluator.evaluateAt(positionInverse),
      inverse(denominator)
    );
  });

/**
 * Keep only the lowest `count` degrees of a polynomial.
 *
 * Coefficients are stored highest-degree first, so the low-order terms are the
 * TAIL of the array. Both the Forney syndrome and the errata evaluator are
 * defined modulo `x^count`, and taking the wrong end here yields a polynomial
 * that is the right length and entirely wrong.
 */
const truncate = (poly: Polynomial, count: number): Polynomial => {
  const { coefficients } = poly;
  if (coefficients.length <= count) return poly;
  return new Polynomial(coefficients.slice(coefficients.length - count));
};

/** Discrete logarithm by search. Only reached on the error path. */
const logOf = (value: number): number => {
  for (let i = 0; i < 255; i++) if (exp(i) === value) return i;
  throw new ReedSolomonError(`Value ${value} is not a field element`);
};

/**
 * Repair a block, returning the corrected data codewords.
 *
 * `received` is data codewords followed by error-correction codewords; the
 * return is the data portion alone, since the check codewords have done their
 * job by this point.
 */
export const decode = (
  received: readonly number[],
  errorCodewordCount: number,
  /**
   * Indices of codewords already known to be unreadable.
   *
   * An **erasure** — damage whose position is known but whose value is not.
   * The distinction is worth real capacity: the bound is
   * `2 * errors + erasures <= errorCodewordCount`, so a codeword costs two
   * check symbols when the decoder has to find it and only one when it is
   * told where to look. With 10 check codewords that is 5 unknown errors
   * against 10 known erasures.
   *
   * The imaging layer can often tell: a region blown out by glare or crushed
   * to black by shadow is visibly untrustworthy, and thresholding it into a
   * confident bit throws that knowledge away. Indices are into `received`.
   */
  erasures: readonly number[] = []
): number[] => {
  const dataLength = received.length - errorCodewordCount;
  if (dataLength <= 0) {
    throw new ReedSolomonError(`Block is shorter than its error correction`);
  }

  const poly = new Polynomial([...received]);
  const { values, hasError } = syndromes(poly, errorCodewordCount);

  // Intact block — overwhelmingly the common case, and worth not paying for.
  // Erasures do not change this: if every syndrome is zero the block is
  // already correct, whatever the imaging layer suspected.
  if (!hasError) return received.slice(0, dataLength);

  // Erasure positions as field elements. A codeword's index is counted from
  // the END of the block, matching the correction step below.
  const erasureRoots = [
    ...new Set(erasures.filter((i) => i >= 0 && i < received.length))
  ].map((index) => exp(received.length - 1 - index));

  if (erasureRoots.length > errorCodewordCount) {
    throw new ReedSolomonError(
      `${erasureRoots.length} erasures exceed ${errorCodewordCount} check codewords`
    );
  }

  // The erasure locator, whose roots are the known positions:
  // Lambda(x) = product of (1 - root * x).
  let erasureLocator = new Polynomial([1]);
  for (const root of erasureRoots) {
    erasureLocator = erasureLocator.multiply(new Polynomial([root, 1]));
  }

  // The Forney syndrome: the syndrome polynomial with the known erasures
  // folded in, truncated back to the check-codeword count. Feeding this to
  // the Euclidean algorithm in place of the raw syndrome is what lets one
  // pass solve for erasures and errors together.
  const syndromePoly = new Polynomial(values);
  const forney =
    erasureRoots.length === 0
      ? syndromePoly
      : truncate(syndromePoly.multiply(erasureLocator), errorCodewordCount);

  const { locator, evaluator } = euclidean(
    Polynomial.monomial(errorCodewordCount, 1),
    forney,
    errorCodewordCount,
    // Erasures buy exactly this: each one raises the degree the remainder may
    // stop at, and so the number of unknown errors solvable alongside them.
    Math.floor((errorCodewordCount + erasureRoots.length) / 2)
  );

  // The errata locator covers both kinds of damage at once.
  const errata =
    erasureRoots.length === 0 ? locator : locator.multiply(erasureLocator);

  const positions = errorPositions(errata);
  const magnitudes = errorMagnitudes(
    erasureRoots.length === 0
      ? evaluator
      : truncate(new Polynomial(values).multiply(errata), errorCodewordCount),
    positions
  );

  const corrected = [...received];
  for (const [i, position] of positions.entries()) {
    // Positions are field elements; the codeword index is their logarithm,
    // counted from the end of the block.
    const index = corrected.length - 1 - logOf(position);
    if (index < 0 || index >= corrected.length) {
      throw new ReedSolomonError(`Corrected position ${index} is out of range`);
    }
    corrected[index] = add(corrected[index], magnitudes[i]);
  }

  return corrected.slice(0, dataLength);
};

/**
 * The generator polynomial for `count` error-correction codewords.
 *
 * Exported because the tests need it: proving the decoder repairs damage means
 * being able to produce correctly-encoded blocks to damage.
 */
export const generatorPolynomial = (count: number): Polynomial => {
  let generator = new Polynomial([1]);
  for (let i = 0; i < count; i++) {
    generator = generator.multiply(new Polynomial([1, exp(i)]));
  }
  return generator;
};

/** Encode data codewords, appending `count` check codewords. */
export const encode = (data: readonly number[], count: number): number[] => {
  const generator = generatorPolynomial(count);
  const info = new Polynomial([...data]).multiplyMonomial(count, 1);
  const { remainder } = info.divide(generator);

  // The remainder can be shorter than `count` when its leading coefficients
  // are zero. Those zeroes are significant here and have to be restored.
  const check = remainder.coefficients;
  const padding = Math.max(0, count - check.length);
  return [
    ...data,
    ...Array.from<number>({ length: padding }).fill(0),
    ...check
  ];
};
