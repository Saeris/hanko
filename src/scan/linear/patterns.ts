/**
 * The EAN/UPC encoding tables.
 *
 * One symbology wearing four names. UPC-A is an EAN-13 whose first digit is
 * zero, UPC-E is a compressed EAN-13, and EAN-8 is the same encoding at a
 * shorter length — so there is one set of tables here, not four.
 *
 * Every digit is 7 modules wide in one of three alphabets. R is the bitwise
 * complement of L, and G is R reversed, which is the property that makes a
 * symbol readable in either direction: scanned backwards, an R-coded digit
 * reads as an L-coded one.
 */

/** `1` is a dark module, matching `BitMatrix`. */
const bits = (pattern: string): readonly number[] =>
  pattern.split(``).map((character) => (character === `1` ? 1 : 0));

/** Odd parity, left half. */
export const L_CODES: ReadonlyArray<readonly number[]> = [
  `0001101`,
  `0011001`,
  `0010011`,
  `0111101`,
  `0100011`,
  `0110001`,
  `0101111`,
  `0111011`,
  `0110111`,
  `0001011`
].map(bits);

/** Even parity, left half. The R codes in reverse bit order. */
export const G_CODES: ReadonlyArray<readonly number[]> = [
  `0100111`,
  `0110011`,
  `0011011`,
  `0100001`,
  `0011101`,
  `0111001`,
  `0000101`,
  `0010001`,
  `0001001`,
  `0010111`
].map(bits);

/** Right half. The bitwise complement of L. */
export const R_CODES: ReadonlyArray<readonly number[]> = L_CODES.map((code) =>
  code.map((bit) => (bit === 1 ? 0 : 1))
);

/**
 * Which L/G pattern the left half uses, indexed by the first digit.
 *
 * EAN-13 carries thirteen digits in twelve digit-widths: the first is never
 * drawn, but is recovered from *how* the other six on the left are encoded.
 * `1` here means G, `0` means L.
 *
 * UPC-A is the `0` row — all L — which is exactly why a UPC-A symbol is an
 * EAN-13 beginning with zero rather than a different thing.
 */
export const PARITY_PATTERNS: ReadonlyArray<readonly number[]> = [
  [0, 0, 0, 0, 0, 0],
  [0, 0, 1, 0, 1, 1],
  [0, 0, 1, 1, 0, 1],
  [0, 0, 1, 1, 1, 0],
  [0, 1, 0, 0, 1, 1],
  [0, 1, 1, 0, 0, 1],
  [0, 1, 1, 1, 0, 0],
  [0, 1, 0, 1, 0, 1],
  [0, 1, 0, 1, 1, 0],
  [0, 1, 1, 0, 1, 0]
];

/**
 * The check digit: weights of 3 and 1 alternating from the right, and whatever
 * makes the total a multiple of ten.
 *
 * Shared by every length in the family — GTIN-8, -12 and -13 all use it — so a
 * caller validating a scanned code does not need to know which it has.
 */
export const checkDigit = (digits: readonly number[]): number => {
  let sum = 0;
  // Weighted from the RIGHT, so the alternation does not shift with length.
  for (const [index, digit] of [...digits].reverse().entries()) {
    sum += digit * (index % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
};

/** Whether a full code, check digit included, is self-consistent. */
export const isValid = (digits: readonly number[]): boolean =>
  digits.length > 1 &&
  checkDigit(digits.slice(0, -1)) === digits[digits.length - 1];
