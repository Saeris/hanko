/**
 * Reading the decoded bitstream back into text.
 *
 * By this point the codewords have been de-interleaved and repaired, so what
 * remains is a plain bit sequence in the format ISO/IEC 18004 §7.4 describes:
 * a mode indicator, a character count whose WIDTH depends on both the mode and
 * the symbol version, then the payload, repeating until a terminator or the
 * bits run out.
 *
 * Scope note: numeric, alphanumeric, and byte modes are supported. Kanji and
 * ECI are not, and that is deliberate — they are a large share of what makes
 * general-purpose decoders big, and nothing that encodes a URL for a sign-in
 * screen uses them. An unsupported mode returns `null` rather than throwing,
 * because a camera pointed at the world sees all sorts of symbols and an
 * unreadable one is a non-event.
 */

/** Mode indicators, from ISO/IEC 18004 Table 2. */
const MODE = {
  terminator: 0x0,
  numeric: 0x1,
  alphanumeric: 0x2,
  byte: 0x4,
  kanji: 0x8,
  eci: 0x7,
  structuredAppend: 0x3,
  fnc1First: 0x5,
  fnc1Second: 0x9
} as const;

/**
 * The alphanumeric character set, in code order.
 *
 * Note it is uppercase-only and includes nine punctuation characters — a
 * deliberately small set, which is why alphanumeric mode packs two characters
 * into 11 bits.
 */
const ALPHANUMERIC = `0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:`;

/**
 * Character-count field widths, by mode and version range.
 *
 * The width changes at versions 10 and 27 because larger symbols can hold more
 * characters than a short field could express. Using one width everywhere is a
 * classic decoder bug: it works perfectly for small QRs and silently
 * misreads every large one, because the count is read with the wrong number of
 * bits and everything after it shifts.
 */
const countBits = (mode: number, version: number): number => {
  const tier = version <= 9 ? 0 : version <= 26 ? 1 : 2;

  switch (mode) {
    case MODE.numeric:
      return [10, 12, 14][tier];
    case MODE.alphanumeric:
      return [9, 11, 13][tier];
    case MODE.byte:
      return [8, 16, 16][tier];
    case MODE.kanji:
      return [8, 10, 12][tier];
    default:
      return 0;
  }
};

/** A cursor over a bit array that knows when it has run out. */
class BitReader {
  #bits: Uint8Array;
  #position = 0;

  constructor(bits: Uint8Array) {
    this.#bits = bits;
  }

  get remaining(): number {
    return this.#bits.length - this.#position;
  }

  /**
   * Read `count` bits as an unsigned integer, most significant first.
   *
   * Returns `null` rather than a short read when the stream runs out. A
   * truncated field silently treated as a small number is how a corrupted
   * symbol turns into confident garbage instead of a clean failure.
   */
  read(count: number): number | null {
    if (count > this.remaining) return null;

    let value = 0;
    for (let i = 0; i < count; i++) {
      value = (value << 1) | this.#bits[this.#position + i];
    }
    this.#position += count;
    return value;
  }
}

/** Read `count` digits packed three-to-ten-bits. */
const readNumeric = (reader: BitReader, count: number): string | null => {
  let out = ``;
  let left = count;

  while (left >= 3) {
    const triple = reader.read(10);
    // 10 bits can express up to 1023, but only 000-999 are legal. A larger
    // value means the stream is not what it claims to be.
    if (triple === null || triple > 999) return null;
    out += String(triple).padStart(3, `0`);
    left -= 3;
  }

  if (left === 2) {
    const pair = reader.read(7);
    if (pair === null || pair > 99) return null;
    out += String(pair).padStart(2, `0`);
  } else if (left === 1) {
    const single = reader.read(4);
    if (single === null || single > 9) return null;
    out += String(single);
  }

  return out;
};

/** Read `count` characters packed two-to-eleven-bits. */
const readAlphanumeric = (reader: BitReader, count: number): string | null => {
  let out = ``;
  let left = count;

  while (left >= 2) {
    const pair = reader.read(11);
    // 45 * 45 - 1 is the largest legal pair; beyond that the stream is wrong.
    if (pair === null || pair > 44 * 45 + 44) return null;
    out += ALPHANUMERIC[Math.floor(pair / 45)] + ALPHANUMERIC[pair % 45];
    left -= 2;
  }

  if (left === 1) {
    const single = reader.read(6);
    if (single === null || single > 44) return null;
    out += ALPHANUMERIC[single];
  }

  return out;
};

/**
 * Read `count` bytes and decode them as text.
 *
 * The spec's default is ISO-8859-1, but in practice almost everything encodes
 * UTF-8 without declaring it, so UTF-8 is tried first and Latin-1 is the
 * fallback. Doing it the other way round would mis-decode most real-world QRs
 * containing non-ASCII text — silently, into mojibake rather than an error.
 */
const readBytes = (reader: BitReader, count: number): string | null => {
  const bytes = new Uint8Array(count);

  for (let i = 0; i < count; i++) {
    const byte = reader.read(8);
    if (byte === null) return null;
    bytes[i] = byte;
  }

  try {
    return new TextDecoder(`utf-8`, { fatal: true }).decode(bytes);
  } catch {
    // Not valid UTF-8. Latin-1 maps every byte to a character, so it always
    // succeeds — which is exactly why it cannot be tried first.
    return new TextDecoder(`iso-8859-1`).decode(bytes);
  }
};

/**
 * Decode a bitstream into text.
 *
 * Returns `null` for anything it cannot read — a truncated stream, an
 * unsupported mode, or a segment whose values are out of range. Callers treat
 * that as "this frame had no readable code", which is the honest reading: a
 * partial decode is not a partial success.
 */
export const readBitstream = (
  bits: Uint8Array,
  version: number
): string | null => {
  const reader = new BitReader(bits);
  let out = ``;

  for (;;) {
    // Fewer than 4 bits left cannot hold a mode indicator. That is the normal
    // way a stream ends when the terminator was omitted, which is legal.
    if (reader.remaining < 4) break;

    const mode = reader.read(4);
    if (mode === null || mode === MODE.terminator) break;

    if (
      mode === MODE.kanji ||
      mode === MODE.eci ||
      mode === MODE.structuredAppend ||
      mode === MODE.fnc1First ||
      mode === MODE.fnc1Second
    ) {
      // Out of scope by design. Returning null rather than throwing keeps an
      // unreadable symbol a non-event for a camera pointed at the world.
      return null;
    }

    const count = reader.read(countBits(mode, version));
    if (count === null) return null;

    const segment =
      mode === MODE.numeric
        ? readNumeric(reader, count)
        : mode === MODE.alphanumeric
          ? readAlphanumeric(reader, count)
          : mode === MODE.byte
            ? readBytes(reader, count)
            : null;

    if (segment === null) return null;
    out += segment;
  }

  // An empty result means the stream held no segments at all. That is a
  // failed decode, not an empty string — a QR always encodes something.
  return out.length > 0 ? out : null;
};
