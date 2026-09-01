/**
 * QR scanning — pixels to text, with no dependencies.
 *
 * A companion to `etiket`, which encodes the symbols this reads. The two are
 * inverses, which is what let the whole matrix layer be proven by round trip
 * before a single pixel was involved.
 *
 * Scope is deliberately narrow: QR only, versions 1-40, numeric, alphanumeric
 * and byte modes. No Kanji, no ECI, no Micro QR, no 1D symbologies — those are
 * what make general-purpose decoders large and un-shakeable.
 */

export { createQrDecoder } from "./qr/decoder.js";
export { withClearance } from "./qr/locate.js";
export type { QrDecoderOptions } from "./qr/decoder.js";

export {
  binarize,
  binarizeGlobal,
  blur,
  close,
  downscale,
  toGray
} from "./binarize.js";

export { decodeMatrix } from "./qr/decode-matrix.js";
export type { MatrixDecodeResult } from "./qr/decode-matrix.js";

export { createGpuScorer, hasWebGpu } from "./gpu.js";
export type { GpuScorer } from "./gpu.js";

export { canTransitionScan, isScanSettled, scanTransition } from "./machine.js";
export type { ScanEvent, ScanFailure, ScanState } from "./machine.js";

export type {
  BitMatrix,
  DecodedSymbol,
  GrayImage,
  Point,
  SymbolDecoder
} from "./types.js";
