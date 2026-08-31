/**
 * Arithmetic over GF(256), the field QR error correction is defined in.
 *
 * Every byte of a QR's error correction is a field element, and Reed-Solomon
 * decoding is polynomial algebra over that field. Doing it with ordinary
 * integer maths does not work: the field's rules are different, and the whole
 * error-correcting property depends on them.
 *
 * Two rules are worth internalising before reading anything below:
 *
 * - **Addition is XOR.** There is no carry, so addition and subtraction are
 *   the same operation, and `a + a === 0` for every `a`.
 * - **Multiplication is addition of logarithms**, in a field where the
 *   logarithms happen to be exponents of a generator element.
 *
 * The tables are built once at module load rather than written out as
 * literals: 512 entries of magic numbers cannot be reviewed, but eight lines
 * that generate them can.
 */

/**
 * The field's defining polynomial, x^8 + x^4 + x^3 + x^2 + 1.
 *
 * Fixed by ISO/IEC 18004 §7.5.2 — not a tunable. A different primitive
 * polynomial gives a different (valid, but incompatible) field, and every
 * codeword would decode to noise.
 */
const PRIMITIVE = 0x11d;

/** `EXP[i]` is the generator raised to `i`. Doubled so callers can skip a modulo. */
const EXP = new Uint8Array(512);
/** `LOG[v]` is the exponent that produces `v`. `LOG[0]` is undefined and unused. */
const LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    // Multiply by the generator (2), reducing modulo the field polynomial
    // whenever the result would exceed one byte.
    x <<= 1;
    if (x & 0x100) x ^= PRIMITIVE;
  }
  // The second half repeats the first, so `EXP[a + b]` is valid for any two
  // logarithms without wrapping the index by hand.
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

/**
 * Add two field elements.
 *
 * XOR. Named rather than inlined because `a ^ b` at a call site reads as bit
 * twiddling, while `add(a, b)` says which algebra is in play.
 */
export const add = (a: number, b: number): number => a ^ b;

/** Multiply two field elements. */
export const multiply = (a: number, b: number): number =>
  // Zero has no logarithm, so it is handled before the table lookup rather
  // than producing a wrong answer from `LOG[0]`.
  a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];

/** Divide two field elements. `b` must be non-zero. */
export const divide = (a: number, b: number): number => {
  if (b === 0) throw new Error(`Division by zero in GF(256)`);
  if (a === 0) return 0;
  // +255 keeps the index non-negative when LOG[a] < LOG[b]; the doubled table
  // makes that safe without a modulo.
  return EXP[LOG[a] + 255 - LOG[b]];
};

/** Raise the field's generator to a power. */
export const exp = (power: number): number => EXP[power % 255];

/** The multiplicative inverse of `a`. */
export const inverse = (a: number): number => {
  if (a === 0) throw new Error(`Zero has no inverse in GF(256)`);
  return EXP[255 - LOG[a]];
};
