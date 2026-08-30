/**
 * QR reading for the approving device.
 *
 * Generation is dependency-free; decoding cannot be. hanko defines the
 * {@link QrScanner} interface — two methods — and lets the host bring a
 * decoder rather than picking one for everybody.
 *
 * That indirection is not ceremony. `BarcodeDetector` looks like the obvious
 * answer and is NOT a web standard: it is a WICG incubation that MDN flags as
 * outside Baseline, Safari has never shipped it, and no vendor has committed
 * to it. Building against it directly means the scanner silently does nothing
 * on an iPhone — the device most people approve from.
 *
 * What works today, in rough order of preference:
 *
 * - **`qr-scanner`** — ~6 kB gzipped, self-contained, uses a native
 *   `BarcodeDetector` where one exists and its own worker otherwise. It owns
 *   the camera too, which is most of the work. See the Astro example.
 * - **`barcode-detector`** — a ponyfill over ZXing-C++/WASM. More formats and
 *   actively maintained, but it fetches its WASM from a CDN at runtime, which
 *   is a poor default on an authentication screen.
 * - **`expo-camera`** on React Native, where no web API exists at all.
 *
 * {@link createBarcodeDetectorScanner} remains for the native path and for
 * ponyfills mirroring that API.
 */

/** Minimal shape of a detected barcode. Mirrors the Barcode Detection API. */
/**
 * A camera frame, as an opaque handle.
 *
 * The DOM's `ImageBitmapSource` in a browser — a `<video>`, `ImageBitmap`,
 * `Blob`, or canvas — but declared locally rather than pulled from `lib.dom`.
 * This package compiles without the DOM lib on purpose, so server code cannot
 * reach a browser-only global by accident, and so the same types work for a
 * React Native frame that is not an `ImageBitmapSource` at all.
 *
 * hanko never inspects the frame; it passes it straight to the detector.
 */
export type CameraFrame = unknown;

/** Minimal shape of a detected barcode. Mirrors the Barcode Detection API. */
export interface DetectedBarcode {
  rawValue: string;
}

/**
 * What hanko needs from a scanner: turn a frame into strings.
 *
 * Deliberately narrower than `BarcodeDetector` — no bounding boxes, no
 * formats — so an `expo-camera` or jsQR adapter is trivial to write.
 */
export interface QrScanner {
  detect(source: CameraFrame): Promise<DetectedBarcode[]>;
}

/** The subset of the global `BarcodeDetector` this module uses. */
interface BarcodeDetectorLike {
  detect(source: CameraFrame): Promise<DetectedBarcode[]>;
}

interface BarcodeDetectorConstructor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;
}

/** Whether this runtime has a native `BarcodeDetector`. */
export const hasNativeBarcodeDetector = (): boolean =>
  typeof globalThis === `object` && `BarcodeDetector` in globalThis;

/**
 * Scanner backed by the platform's `BarcodeDetector`.
 *
 * Pass the ponyfill's constructor where the native one is missing:
 *
 * ```ts
 * import { BarcodeDetector } from "barcode-detector/ponyfill";
 * const scanner = createBarcodeDetectorScanner({ detector: BarcodeDetector });
 * ```
 *
 * Restricted to `qr_code`: a taplist beer can carries an EAN-13 barcode, and a
 * scanner that reported it here would send a product code to the approval
 * endpoint as though it were a user code.
 */
export const createBarcodeDetectorScanner = ({
  detector
}: {
  /** Constructor to use. Defaults to the global when present. */
  detector?: BarcodeDetectorConstructor;
} = {}): QrScanner => {
  // Read through a narrowing check rather than a cast: `BarcodeDetector` is
  // absent on every server runtime, so its presence has to be tested rather
  // than assumed.
  const global: Record<string, unknown> = globalThis;
  const fromGlobal = global.BarcodeDetector;
  const Ctor =
    detector ??
    (typeof fromGlobal === `function`
      ? // Unavoidable: the platform global is untyped here (no DOM lib), and
        // `typeof === "function"` is as far as a runtime check can narrow a
        // constructor. A wrong global would fail at `new`, not silently.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        (fromGlobal as unknown as BarcodeDetectorConstructor)
      : undefined);

  if (!Ctor) {
    throw new Error(
      `No BarcodeDetector available. Install "barcode-detector" and pass its ponyfill constructor.`
    );
  }

  const instance = new Ctor({ formats: [`qr_code`] });
  return { detect: async (source) => instance.detect(source) };
};

/** Everything hanko can pull out of a scanned payload. */
export interface ScannedPayload {
  /** The code to send to the approval endpoint. */
  userCode: string;
  /** The URL the QR encoded, when it was a URL. */
  verificationUri?: string;
}

/**
 * Read a `user_code` out of a scanned string.
 *
 * QRs in this flow carry `verification_uri_complete` — a URL with the code in
 * it — but a scanner may also see a bare code from a hand-typed fallback, so
 * both are accepted.
 *
 * Returns `null` rather than throwing: a camera pointed at the world sees
 * unrelated codes constantly, and each one is a normal non-event, not an
 * error.
 */
export const parseScannedCode = (
  raw: string,
  { param = `user_code` }: { param?: string } = {}
): ScannedPayload | null => {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  try {
    const url = new URL(trimmed);
    // http/https only. `new URL` accepts ANY scheme, so a café's WiFi QR
    // (`WIFI:S:cafe;T:WPA;...`) parses cleanly and its payload would sail
    // through the path fallback below as though it were a user code.
    if (url.protocol !== `http:` && url.protocol !== `https:`) return null;

    const fromQuery = url.searchParams.get(param);
    if (fromQuery !== null && fromQuery.length > 0) {
      return { userCode: fromQuery, verificationUri: url.toString() };
    }
    // Some hosts put the code in the path (`/link/WDJB-MJHT`) rather than the
    // query, so fall back to the last non-empty segment.
    const segment = url.pathname.split(`/`).filter(Boolean).pop();
    return segment === undefined
      ? null
      : { userCode: segment, verificationUri: url.toString() };
  } catch {
    // Not a URL. Treat it as a bare code, but only if it could plausibly be
    // one — otherwise every QR in the room becomes a candidate code.
    return /^[A-Za-z0-9][A-Za-z0-9\s._-]{2,63}$/u.test(trimmed)
      ? { userCode: trimmed }
      : null;
  }
};
