/**
 * The decoders, off the main thread.
 *
 * Two symbologies with nothing in common but their input: QR for the device
 * flow, and the EAN/UPC family for product packaging. The library ships each
 * as a plain function — pixels in, symbol out — so combining them is the
 * application's call rather than something it has to be configured into.
 *
 * `serveDecoder` wires a single decoder to a worker scope, which is the common
 * case. This wants both, so it does that wiring by hand — a dozen lines, and
 * it shows what the helper is doing.
 */
import { createQrDecoder } from "@saeris/hanko/scan";
import type { DecodedSymbol, GrayImage } from "@saeris/hanko/scan";
import { createLinearDecoder } from "@saeris/hanko/scan/linear";

// No time budget on either. A worker has no preview to block, so the QR retry
// ladder may run to exhaustion — worth roughly twenty points of recognition
// against the 120ms a synchronous decode has to respect.
const qr = createQrDecoder({ timeBudgetMs: 0 });
// UPC-E is asked for explicitly, because the library does not enable it by
// default — six digits is thin evidence and it costs false positives on a
// corpus that holds none. This is a scanner pointed at real packaging, where
// bottle necks and small cans genuinely carry the compressed form, so the
// trade lands the other way here.
const linear = createLinearDecoder({
  timeBudgetMs: 0,
  formats: [`ean_13`, `ean_8`, `upc_a`, `upc_e`]
});

/**
 * QR first, then linear.
 *
 * Not arbitrary. A QR symbol carries Reed-Solomon correction, so a wrong read
 * is essentially impossible — it either reconstructs or it does not. A linear
 * barcode has only a check digit, one in ten of which passes by chance, so it
 * is the one that can in principle answer confidently and wrongly. Asking the
 * safer decoder first means a frame holding a QR never reaches the riskier one.
 */
const decode = (image: GrayImage): DecodedSymbol | null =>
  qr.decode(image) ?? linear.decode(image);

interface Frame {
  readonly id: number;
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

self.addEventListener(`message`, (event: MessageEvent<Frame>) => {
  const frame = event.data;
  if (frame === null || typeof frame !== `object` || !(`id` in frame)) return;

  const started = Date.now();
  const result = decode({
    data: frame.data,
    width: frame.width,
    height: frame.height
  });

  self.postMessage({ id: frame.id, result, elapsedMs: Date.now() - started });
});
