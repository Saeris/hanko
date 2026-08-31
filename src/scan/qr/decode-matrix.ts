/**
 * Matrix to text — the whole of stage 1, assembled.
 *
 * Everything above this point is pure: given a bit matrix, this produces the
 * string that was encoded, with no pixels, cameras, or DOM involved. That is
 * what makes it exhaustively testable against etiket, which encodes the same
 * matrices this reads.
 */

import type { BitMatrix } from "../types.js";
import { bitsToCodewords, blockStructure, deinterleave } from "./blocks.js";
import { readBitstream } from "./bitstream.js";
import {
  readFormat,
  readVersion,
  type ErrorCorrectionLevel
} from "./format.js";
import { readDataBits } from "./mask.js";
import { decode as correctBlock, ReedSolomonError } from "./reed-solomon.js";

/** What a successful matrix decode yields. */
export interface MatrixDecodeResult {
  readonly value: string;
  readonly version: number;
  readonly errorCorrectionLevel: ErrorCorrectionLevel;
  readonly mask: number;
}

/**
 * Decode a bit matrix into the text it encodes.
 *
 * Returns `null` for anything unreadable. Every failure here is a normal
 * outcome rather than an exception: a camera sees far more non-symbols than
 * symbols, and a decoder that threw on each one would make its callers write
 * try/catch around their hot loop.
 */
export const decodeMatrix = (matrix: BitMatrix): MatrixDecodeResult | null => {
  const version = readVersion(matrix);
  if (version === null) return null;

  const format = readFormat(matrix);
  if (format === null) return null;

  const structure = blockStructure(version, format.errorCorrectionLevel);
  if (structure === null) return null;

  // Unmasked as it is read, since the traversal and the mask have to agree
  // about coordinates.
  const bits = readDataBits(matrix, version, format.mask);
  const codewords = bitsToCodewords(bits);

  const blocks = deinterleave(codewords, structure);

  // Each block is repaired independently — that is the entire point of the
  // interleaving this just undid.
  const repaired: number[] = [];
  for (const block of blocks) {
    try {
      repaired.push(
        ...correctBlock(
          [...block.data, ...block.error],
          structure.errorCodewordsPerBlock
        )
      );
    } catch (error) {
      // One block beyond repair loses the symbol. Reported as an unreadable
      // frame rather than an exception, for the reason above.
      if (error instanceof ReedSolomonError) return null;
      throw error;
    }
  }

  // Back to a bit array for the segment reader. The codewords are bytes, so
  // this is a plain unpack.
  const dataBits = new Uint8Array(repaired.length * 8);
  for (const [index, codeword] of repaired.entries()) {
    for (let bit = 0; bit < 8; bit++) {
      dataBits[index * 8 + bit] = (codeword >> (7 - bit)) & 1;
    }
  }

  const value = readBitstream(dataBits, version);
  if (value === null) return null;

  return {
    value,
    version,
    errorCorrectionLevel: format.errorCorrectionLevel,
    mask: format.mask
  };
};
