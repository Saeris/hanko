/**
 * The vocabulary every symbology decoder shares.
 *
 * Kept separate from any one decoder so that adding DataMatrix or Aztec later
 * means writing a `SymbolDecoder`, not restructuring the session around it.
 */

/**
 * A greyscale image.
 *
 * Greyscale rather than RGBA because every stage after acquisition works on
 * luminance: binarization, finder detection, and sampling all discard colour
 * immediately. Converting once at the boundary means the pipeline never
 * carries three redundant channels through its hot loops.
 */
export interface GrayImage {
  /** One byte per pixel, row-major, `width * height` long. */
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/**
 * A bit matrix — the output of binarization and the input to every decoder.
 *
 * `true` is a *set* module, which by QR convention means DARK. Polarity is
 * resolved during binarization, not here, so a decoder never has to ask which
 * way round its input is. That question is exactly what broke the approval
 * screen against an inverted symbol.
 */
export interface BitMatrix {
  /** Row-major bits, `width * height` long. */
  readonly bits: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** A point in image space. Sub-pixel, because finder centres rarely land on one. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** What a successful decode yields. */
export interface DecodedSymbol {
  /** The decoded payload. */
  readonly value: string;
  /**
   * The symbology that produced it, as a BarcodeDetector-compatible name.
   *
   * Shaped to match that API without depending on it: if it ever ships, a
   * compatibility layer is a rename, not a redesign.
   */
  readonly format: `qr_code`;
  /** Corners in image space, clockwise from top-left. */
  readonly cornerPoints: readonly Point[];
}

/**
 * What the session needs from a decoder.
 *
 * One method, deliberately. A decoder that also owned frame acquisition or
 * camera lifecycle could not be tested without a browser — and the whole point
 * of this seam is that everything below it is pure.
 *
 * Returns `null` rather than throwing when no symbol is present: a camera
 * pointed at a room sees frames without codes constantly, and that is a
 * non-event, not an error. Throwing is reserved for a genuine fault.
 */
export interface SymbolDecoder {
  decode(image: GrayImage): DecodedSymbol | null;
}
