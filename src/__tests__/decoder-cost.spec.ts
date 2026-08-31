import { describe, expect, it } from "vitest";
import { createQrDecoder } from "../scan/qr/decoder.js";
import type { GrayImage } from "../scan/types.js";

/**
 * The retry ladder is what makes this decoder read difficult images, and it
 * is also what could make it useless in a camera loop.
 *
 * Eight passes over a frame is affordable when one of them succeeds. It is
 * not affordable on a frame containing no code at all — and that is the
 * common case, since a camera sees far more empty frames than symbols. An
 * unguarded ladder measured 495ms on a blank 720p frame, which caps a scanner
 * at two frames a second while finding nothing.
 */
describe(`decoder cost`, () => {
  const flat = (width: number, height: number): GrayImage => ({
    data: new Uint8ClampedArray(width * height).fill(200),
    width,
    height
  });

  it(`abandons a frame with no finder candidates quickly`, () => {
    // WHY: guards the early exit. Without it every empty frame pays for the
    // whole ladder — two binarizers, both polarities, a blur, a shifted copy
    // and a denoise — to discover what the first pass already knew: there is
    // no finder pattern anywhere, so there is nothing for a retry to rescue.
    //
    // The threshold is deliberately loose. This asserts an order of
    // magnitude, not a number, because it runs on whatever hardware CI has.
    const decoder = createQrDecoder();

    const start = performance.now();
    const result = decoder.decode(flat(1280, 720));
    const elapsed = performance.now() - start;

    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(400);
  });

  it(`scales with pixel count rather than exploding`, () => {
    // WHY: a quadratic blow-up would pass the test above at 720p and still
    // be unusable at 1080p. Four times the pixels should cost roughly four
    // times as much, not sixteen.
    const decoder = createQrDecoder();

    const time = (image: GrayImage): number => {
      const start = performance.now();
      decoder.decode(image);
      return performance.now() - start;
    };

    // Warm up, so the first measurement does not carry JIT compilation.
    time(flat(320, 240));

    const small = time(flat(320, 240));
    const large = time(flat(640, 480));

    // Four times the pixels, allowed up to eight times the cost — loose
    // enough for timer noise on a small image, tight enough to catch a
    // quadratic.
    expect(large).toBeLessThan(Math.max(50, small * 8));
  });
});
