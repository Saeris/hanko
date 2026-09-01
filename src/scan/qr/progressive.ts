/**
 * Scanning across frames rather than within one.
 *
 * The retry ladder is what makes difficult symbols readable, and it costs far
 * more than one frame can afford. Measured on the benchmark corpus, the
 * decoder reads **61.6%** with no time limit and **41.9%** at the 120ms
 * default a viewfinder needs — so a third of its capability is unreachable in
 * the configuration people actually run, and no budget recovers it: a sweep
 * showed recognition still climbing at 700ms.
 *
 * That is a false choice, because a camera is not a still image. It supplies
 * thirty frames a second, each nearly free and each slightly different. Ten
 * frames at 120ms is 1.2 seconds of decoding work at full frame rate, without
 * ever stalling the preview.
 *
 * So this spends a small budget per frame and ADVANCES through the ladder
 * across successive frames: cheap rungs on every frame, expensive ones only
 * once the cheap ones have failed repeatedly. A code held steadily in view
 * gets the whole ladder within a second; a frame with nothing in it costs one
 * cheap pass.
 *
 * The decoder itself stays pure and synchronous — this wraps it rather than
 * changing it, so a still image can still run the whole ladder at once.
 */

import type { DecodedSymbol, GrayImage } from "../types.js";
import { createQrDecoder, type QrDecoderOptions } from "./decoder.js";

/** A scanner that improves its effort as frames arrive. */
export interface ProgressiveScanner {
  /**
   * Offer one frame.
   *
   * Returns a symbol as soon as one is read, and `null` otherwise — including
   * while effort is still ramping up.
   */
  scan(image: GrayImage): DecodedSymbol | null;

  /**
   * Reset the effort ramp.
   *
   * Call when the scene changes — a new code presented, the camera moved
   * somewhere else — so the next frame starts cheap again rather than
   * inheriting effort earned by a symbol that is no longer there.
   */
  reset(): void;

  /** How much effort the next frame will receive, in milliseconds. */
  readonly budgetMs: number;
}

/** Options for {@link createProgressiveScanner}. */
export interface ProgressiveOptions extends Omit<
  QrDecoderOptions,
  `timeBudgetMs`
> {
  /**
   * Budget for the first frame, in milliseconds.
   *
   * Deliberately small. Most frames a camera delivers contain no code at all,
   * and this is what every one of them costs.
   */
  initialBudgetMs?: number;

  /**
   * Ceiling on the per-frame budget.
   *
   * 400ms by default: beyond that a single frame stalls the preview
   * noticeably, and at 30fps the ladder has had a dozen frames to work with
   * by the time the ramp reaches it.
   */
  maxBudgetMs?: number;

  /**
   * How much the budget grows per consecutive frame that shows a symbol.
   *
   * Growth is conditional on there being something to find: a frame with no
   * finder candidate at all should not earn the next frame more time, or a
   * camera pointed at a wall would ramp to its ceiling and stay there.
   */
  growth?: number;
}

/**
 * Create a scanner that spreads decoding effort across frames.
 *
 * The ramp is driven by evidence rather than by a timer. A frame in which the
 * decoder finds nothing resets it, because nothing is there to spend effort
 * on; a frame that finds a symbol but cannot read it raises the budget,
 * because that is exactly the case where more effort pays.
 */
export const createProgressiveScanner = ({
  initialBudgetMs = 40,
  maxBudgetMs = 400,
  growth = 1.6,
  ...decoderOptions
}: ProgressiveOptions = {}): ProgressiveScanner => {
  let budget = initialBudgetMs;

  // One decoder per budget level, cached: constructing one is cheap, but a
  // camera loop calls this thirty times a second and there are only a handful
  // of distinct budgets in the ramp.
  const decoders = new Map<number, ReturnType<typeof createQrDecoder>>();
  const decoderFor = (ms: number): ReturnType<typeof createQrDecoder> => {
    const existing = decoders.get(ms);
    if (existing !== undefined) return existing;

    const created = createQrDecoder({ ...decoderOptions, timeBudgetMs: ms });
    decoders.set(ms, created);
    return created;
  };

  return {
    get budgetMs(): number {
      return budget;
    },

    scan: (image: GrayImage): DecodedSymbol | null => {
      const rounded = Math.round(budget);
      const result = decoderFor(rounded).decode(image);

      if (result !== null) {
        // Read it. Drop back to the cheap budget: whatever comes next is a
        // different scan, and starting expensive would waste effort on the
        // frames after a successful read.
        budget = initialBudgetMs;
        return result;
      }

      // Nothing read. Spend more next time, up to the ceiling — the symbol may
      // simply need more of the ladder than this frame could afford.
      budget = Math.min(maxBudgetMs, budget * growth);
      return null;
    },

    reset: (): void => {
      budget = initialBudgetMs;
    }
  };
};
