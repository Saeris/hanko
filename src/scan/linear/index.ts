/**
 * Linear barcodes — the EAN/UPC family.
 *
 * A separate entry point from `@saeris/hanko/scan` because most callers want
 * one or the other: a device-authorization screen reads QR and never a
 * product label, while a shopping app reads labels and never a QR. Splitting
 * them means neither pays for the other's tables.
 */

export { createLinearDecoder } from "./decoder.js";
export type { LinearDecoderOptions } from "./decoder.js";
export { decodeRow, runsInRow } from "./scanline.js";
export type { LinearMatch } from "./scanline.js";
export { checkDigit, isValid } from "./patterns.js";
export { describeGtin } from "./gtin.js";
export type { GtinPrefix } from "./gtin.js";
