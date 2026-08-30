/**
 * Code generation.
 *
 * Two codes with opposite constraints:
 *
 * - `user_code` is read off a TV across a room and typed on a phone, so it must
 *   be SHORT. That caps its entropy, which is why RFC 8628 §5.1 requires the
 *   server to rate-limit attempts — the code alone is not brute-force safe.
 * - `device_code` is never displayed, so it has no usability ceiling. The spec
 *   says "a very high entropy code SHOULD be used".
 *
 * @see https://datatracker.ietf.org/doc/html/rfc8628#section-5.1
 */

/**
 * RFC 8628 §6.1's recommended base-20 alphabet: consonants only.
 *
 * No vowels, so generated codes cannot accidentally spell words. No digits, so
 * there is no 0/O or 1/l/I confusion. 20^8 ≈ 34.5 bits at 8 characters, which
 * the spec pairs with a 5-attempt rate limit.
 */
export const BASE20_ALPHABET = `BCDFGHJKLMNPQRSTVWXZ`;

/**
 * Digits only — better for non-Latin locales and numeric TV remotes, which is
 * why Plex-style flows often use them. Lower entropy per character than base-20
 * (10 vs 20), so prefer a longer code when using this.
 */
export const NUMERIC_ALPHABET = `0123456789`;

/** Bytes of entropy for `device_code`. 32 bytes = 256 bits. */
const DEVICE_CODE_BYTES = 32;

/**
 * Rejection-sampled index into `alphabet`.
 *
 * A naive `byte % alphabet.length` is biased whenever 256 is not a multiple of
 * the alphabet size (it is not, for 20): low indices would come up more often.
 * We discard bytes above the largest clean multiple instead. This matters — a
 * skewed distribution shrinks the effective keyspace an attacker must search.
 */
const unbiasedIndex = (alphabet: string): number => {
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  const buf = new Uint8Array(1);
  let byte: number;
  do {
    crypto.getRandomValues(buf);
    byte = buf[0]!;
  } while (byte >= limit);
  return byte % alphabet.length;
};

export interface UserCodeOptions {
  /** Significant characters, excluding any separator. Spec example uses 8. */
  length?: number;
  /** Character set to draw from. Defaults to {@link BASE20_ALPHABET}. */
  alphabet?: string;
  /**
   * Inserted every `groupSize` characters purely for legibility.
   * The stored/compared form never contains it — see {@link normalizeUserCode}.
   */
  separator?: string;
  /** Characters per visual group. Ignored when `separator` is empty. */
  groupSize?: number;
}

/**
 * Generate a user-facing code, formatted for display.
 *
 * Defaults follow the spec's worked example: 8 base-20 characters shown as
 * `WDJB-MJHT`.
 */
export const generateUserCode = ({
  length = 8,
  alphabet = BASE20_ALPHABET,
  separator = `-`,
  groupSize = 4
}: UserCodeOptions = {}): string => {
  if (length < 1) throw new RangeError(`user code length must be >= 1`);
  if (alphabet.length < 2)
    throw new RangeError(`alphabet needs >= 2 characters`);

  let code = ``;
  for (let i = 0; i < length; i++) code += alphabet[unbiasedIndex(alphabet)];

  if (!separator || groupSize < 1) return code;

  const groups: string[] = [];
  for (let i = 0; i < code.length; i += groupSize) {
    groups.push(code.slice(i, i + groupSize));
  }
  return groups.join(separator);
};

/**
 * Canonicalize user input before comparison.
 *
 * RFC 8628 §6.1: the server strips punctuation it added for readability, and
 * uppercases A-Z codes. Without this, a user typing `wdjb mjht` — which is what
 * a phone keyboard will autocorrect toward — fails against `WDJB-MJHT` for no
 * reason the user can see.
 *
 * Strips ALL non-alphanumerics, so it is agnostic to whichever separator the
 * display format used.
 */
export const normalizeUserCode = (input: string): string =>
  input.replace(/[^a-zA-Z0-9]/gu, ``).toUpperCase();

/**
 * Generate a `device_code`: 256 bits, base64url, no padding.
 *
 * base64url (not base64) because this value travels in URLs and form bodies,
 * where `+` and `/` would need escaping.
 */
export const generateDeviceCode = (): string => {
  const bytes = new Uint8Array(DEVICE_CODE_BYTES);
  crypto.getRandomValues(bytes);
  let binary = ``;
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, `-`)
    .replace(/\//gu, `_`)
    .replace(/=+$/u, ``);
};
