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
    // magnitude, not a number, because it runs on whatever hardware CI has —
    // a shared runner measured 423ms against an earlier 400ms bound, which
    // says nothing about the guard and everything about the machine. What
    // must not happen is the unguarded half-second-plus this exists to
    // prevent.
    const decoder = createQrDecoder();

    const start = performance.now();
    const result = decoder.decode(flat(1280, 720));
    const elapsed = performance.now() - start;

    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(1000);
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

  // The assertion is a wall-clock bound above Vitest's default timeout, so
  // the test needs its own or it fails as a timeout rather than reporting
  // the number it measured.
  it(
    `does not collapse on a frame of sensor grain`,
    { timeout: 20_000 },
    () => {
      // WHY: grain is the worst input a finder scan can get. Random pixels
      // produce spurious 1:1:3:1:1 runs everywhere — measured, ~190 candidates
      // on a 1280x720 frame against 0-5 for an ordinary photograph — and every
      // per-candidate stage then runs at its worst case on a frame holding no
      // symbol. A camera in low light delivers exactly this, so it is a real
      // operating condition rather than a synthetic one.
      //
      // This frame cost 3.8 seconds before the dedup scan was bounded, the
      // refine coefficients moved off dictionary-mode property access, and the
      // deep search learned to skip implausible candidate counts, which took it
      // to 2.5s. Composing transform pairs — worth 1.1 points of coverage — put
      // it back to 4.9s, because grain is precisely the case with no early exit
      // and composition multiplies the rungs that run on it.
      //
      // Gating those rungs on candidate count was measured and rejected: it
      // recovered about a third of the time and cost a corpus image. The cost is
      // accepted rather than hidden, and it is a STILL-image cost — the same
      // frame under the 120ms budget a viewfinder runs at takes 175ms.
      //
      // The budget is generous against the ~4.9s measured, because CI machines
      // vary — it guards the collapse, not the constant.
      const width = 1280;
      const height = 720;
      const data = new Uint8ClampedArray(width * height);
      let state = 1;
      for (let i = 0; i < data.length; i++) {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        data[i] = (state >> 16) & 0xff;
      }

      const started = Date.now();
      createQrDecoder({ timeBudgetMs: 0 }).decode({ data, width, height });

      expect(Date.now() - started).toBeLessThan(12_000);
    }
  );
});
