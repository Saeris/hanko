/**
 * Running the decoder off the main thread.
 *
 * Decoding is synchronous and cannot be made otherwise without rewriting
 * every stage as a coroutine, so a budget bounds how much work is STARTED,
 * not how long the thread is held. Measured on a hard frame, a 40ms budget
 * produced a 208ms block and a 400ms budget a 481ms one — because the first
 * attempt runs before any deadline check, and one expensive stage overruns
 * freely once entered.
 *
 * At 60fps a frame is 16.7ms, so those are 12 and 28 dropped frames: a
 * visible freeze of the preview, on the very frames where the user is trying
 * to line up a shot. No budget setting fixes that, because the problem is
 * occupancy rather than duration.
 *
 * A worker fixes it completely. The decoder is pure — pixels in, string out,
 * no shared state — which is exactly what transfers cleanly across a thread
 * boundary. The buffer is transferred rather than copied, so the cost is a
 * pointer hand-off rather than a megabyte memcpy.
 *
 * This module is the worker side. It is deliberately tiny and has no imports
 * beyond the decoder, so it can be bundled as a worker entry by any tool.
 */

import { createQrDecoder, type QrDecoderOptions } from "./qr/decoder.js";
import type { DecodedSymbol } from "./types.js";

/** A frame handed to the worker. */
export interface DecodeRequest {
  /** Correlates the reply, since frames may be in flight concurrently. */
  readonly id: number;
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** The worker's reply. */
export interface DecodeResponse {
  readonly id: number;
  readonly result: DecodedSymbol | null;
  /** Wall-clock time the decode took, for callers pacing their own requests. */
  readonly elapsedMs: number;
}

/**
 * Wire a worker scope to a decoder.
 *
 * Call from a worker entry module:
 *
 * ```ts
 * import { serveDecoder } from "@saeris/hanko/scan/worker";
 * serveDecoder(self);
 * ```
 *
 * The scope is passed in rather than reached for, so this stays testable
 * without a worker and works under any host that provides the same two
 * methods — a DOM `Worker`, a Node `parentPort`, or a stub.
 */
export const serveDecoder = (
  scope: {
    addEventListener?: (
      type: string,
      listener: (event: unknown) => void
    ) => void;
    on?: (type: string, listener: (message: unknown) => void) => void;
    postMessage: (message: unknown) => void;
  },
  options: QrDecoderOptions = {}
): void => {
  // One decoder for the worker's lifetime. Constructing one is cheap, but
  // reusing it lets V8 keep the hot paths optimised across frames rather than
  // rediscovering them each time.
  const decoder = createQrDecoder(options);

  const handle = (payload: unknown): void => {
    const request = payload as DecodeRequest | { data?: DecodeRequest };
    // A DOM MessageEvent carries the payload on `.data`; a Node message is
    // the payload itself.
    const frame =
      `data` in request && typeof request.data === `object`
        ? (request.data as DecodeRequest)
        : (request as DecodeRequest);

    if (frame === null || typeof frame !== `object` || !(`id` in frame)) return;

    const started = Date.now();
    const result = decoder.decode({
      data: frame.data,
      width: frame.width,
      height: frame.height
    });

    scope.postMessage({
      id: frame.id,
      result,
      elapsedMs: Date.now() - started
    } satisfies DecodeResponse);
  };

  if (typeof scope.addEventListener === `function`) {
    scope.addEventListener(`message`, handle);
  } else if (typeof scope.on === `function`) {
    scope.on(`message`, handle);
  }
};
