import { encodeQR } from "etiket/qr";
import { describe, expect, it } from "vitest";
import { blockStructure, totalCodewords } from "../scan/qr/blocks.js";
import { decodeMatrix } from "../scan/qr/decode-matrix.js";
import type { ErrorCorrectionLevel } from "../scan/qr/format.js";
import type { BitMatrix } from "../scan/types.js";

/**
 * Stage 1 is verified by round trip against etiket.
 *
 * etiket encodes the matrices this decodes, so the two are inverses and every
 * version, error-correction level, mask, and segment mode can be proven with
 * no image files and no camera. That is the whole reason this half was built
 * first: it is provable, and the half that needs photographs can then start
 * from a decoder already known to be correct.
 *
 * etiket is a devDependency here, not a runtime one — it is the test oracle.
 */

const LEVELS: readonly ErrorCorrectionLevel[] = [`L`, `M`, `Q`, `H`];

/** etiket returns `boolean[][]`; the decoder wants a flat bit array. */
const toBitMatrix = (matrix: readonly (readonly boolean[])[]): BitMatrix => {
  const size = matrix.length;
  const bits = new Uint8Array(size * size);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) bits[y * size + x] = matrix[y][x] ? 1 : 0;
  }
  return { bits, width: size, height: size };
};

const roundTrip = (
  text: string,
  ecLevel: ErrorCorrectionLevel
): string | null =>
  decodeMatrix(toBitMatrix(encodeQR(text, { ecLevel })))?.value ?? null;

describe(`decodeMatrix`, () => {
  it(`round-trips the URL shape this library actually encodes`, () => {
    // WHY: the case that matters most. A device-flow QR is a URL with a code
    // in the query, and it must decode at every EC level a host might choose.
    const url = `https://example.ngrok-free.app/link?user_code=TFKS`;

    for (const level of LEVELS) expect(roundTrip(url, level)).toBe(url);
  });

  it(`round-trips across versions 1 through 33`, () => {
    // WHY: sweeping payload length walks the symbol up through every version,
    // which is what exercises the character-count width changing at versions
    // 10 and 27. A decoder using one width everywhere passes small QRs and
    // silently misreads every large one — this is the test that catches it.
    const versions = new Set<number>();
    const masks = new Set<number>();

    for (let length = 1; length <= 900; length += 37) {
      const text = `A1b`.repeat(Math.ceil(length / 3)).slice(0, length);

      for (const level of LEVELS) {
        const decoded = decodeMatrix(
          toBitMatrix(encodeQR(text, { ecLevel: level }))
        );

        expect(decoded?.value).toBe(text);
        if (decoded !== null) {
          versions.add(decoded.version);
          masks.add(decoded.mask);
        }
      }
    }

    // Spanning both count-width boundaries is the point of the sweep, so the
    // coverage itself is asserted rather than assumed.
    expect(Math.min(...versions)).toBe(1);
    expect(Math.max(...versions)).toBeGreaterThan(27);
    expect(masks.size).toBeGreaterThan(1);
  });

  it(`reads all three supported segment modes`, () => {
    // WHY: numeric packs 3 digits per 10 bits, alphanumeric 2 chars per 11,
    // and each has a ragged tail for the final 1 or 2 characters. Those tails
    // are separate code paths and are where off-by-one errors live, so the
    // lengths here deliberately hit every remainder.
    for (const length of [1, 2, 3, 4, 5, 17, 100]) {
      const numeric = `7`.repeat(length);
      expect(roundTrip(numeric, `M`)).toBe(numeric);

      const alnum = `ABC123 $%*+-./:`.repeat(length).slice(0, length);
      expect(roundTrip(alnum, `M`)).toBe(alnum);
    }

    const bytes = `lower case forces byte mode`;
    expect(roundTrip(bytes, `M`)).toBe(bytes);
  });

  it(`decodes UTF-8 payloads`, () => {
    // WHY: the spec's default byte encoding is ISO-8859-1, but virtually
    // everything encodes UTF-8 without declaring it. Latin-1 maps every byte
    // to some character, so trying it first would silently produce mojibake
    // rather than an error — UTF-8 has to be attempted first.
    for (const text of [`café`, `emoji 🍺 beer`, `Ünïcödé`]) {
      expect(roundTrip(text, `M`)).toBe(text);
    }
  });

  it(`reports the format it read`, () => {
    // WHY: the EC level and mask come from the format field, and reading them
    // wrong changes how every module is interpreted. Checking them against
    // what the encoder was asked for proves the field was read correctly and
    // not merely that the payload survived.
    for (const level of LEVELS) {
      const decoded = decodeMatrix(
        toBitMatrix(encodeQR(`FORMAT CHECK`, { ecLevel: level }))
      );

      expect(decoded?.errorCorrectionLevel).toBe(level);
      expect(decoded?.mask).toBeGreaterThanOrEqual(0);
      expect(decoded?.mask).toBeLessThan(8);
    }
  });

  it(`returns null for Kanji mode rather than guessing`, () => {
    // WHY: Kanji is deliberately out of scope — it is a large share of what
    // makes general-purpose decoders big, and nothing encoding a sign-in URL
    // uses it. etiket picks Kanji mode for Japanese text (7 kanji fit in a
    // version 1 symbol where 21 ASCII bytes need version 2), so this asserts
    // the exclusion is honest: an unreadable symbol reports nothing rather
    // than returning a partial or corrupted string.
    expect(roundTrip(`日本語テキスト`, `M`)).toBeNull();
  });

  it(`returns null for a matrix that is not a QR`, () => {
    // WHY: a camera sees far more non-symbols than symbols. Every one of them
    // must be a quiet non-event, never an exception in the caller's hot loop.
    const blank: BitMatrix = {
      bits: new Uint8Array(21 * 21),
      width: 21,
      height: 21
    };
    expect(decodeMatrix(blank)).toBeNull();

    const wrongSize: BitMatrix = {
      bits: new Uint8Array(20 * 20),
      width: 20,
      height: 20
    };
    expect(decodeMatrix(wrongSize)).toBeNull();
  });

  it(`describes every block layout consistently with symbol capacity`, () => {
    // WHY: the block table is 160 hand-transcribed entries from ISO/IEC 18004
    // Tables 13-22, and there is no formula to derive it. But the codewords a
    // layout describes must sum to exactly the symbol's capacity, which is an
    // independent value — so a transcription error would have to be exactly
    // compensating to survive this.
    const capacity = [
      0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346, 404, 466, 532, 581, 655,
      733, 815, 901, 991, 1085, 1156, 1258, 1364, 1474, 1588, 1706, 1828, 1921,
      2051, 2185, 2323, 2465, 2611, 2761, 2876, 3034, 3196, 3362, 3532, 3706
    ];

    for (let version = 1; version <= 40; version++) {
      for (const level of LEVELS) {
        const structure = blockStructure(version, level);

        expect(structure).not.toBeNull();
        expect(totalCodewords(structure!)).toBe(capacity[version]);
      }
    }
  });
});
