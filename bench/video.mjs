/**
 * Viewfinder benchmark, for profiling under deoptkit.
 *
 * A camera scanning a code does not decode a still: it delivers a stream of
 * frames under a time budget, most of which fail, until one succeeds. The
 * decode benchmark measures the still case and the noise benchmark the empty
 * one; this measures the case a scanner is actually in most of the time —
 * a symbol present, budget enforced, frame after frame.
 *
 * Frames are perturbed rather than repeated, because a real scene shifts
 * slightly between frames and decoding one identical image N times exercises
 * only one path through the ladder.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { createQrDecoder, toGray } from "../dist/scan/index.mjs";

const ROOT = "C:/GitHub/@saeris/hanko/.corpus/qrcodes/detection";
const decoder = createQrDecoder({ timeBudgetMs: 120 });

const frames = [];
for (const cat of ["monitor", "damaged", "close", "nominal"]) {
  const files = (await readdir(join(ROOT, cat)))
    .filter((f) => /\.(jpg|png)$/i.test(f))
    .slice(0, 3);
  for (const f of files) {
    const { data, info } = await sharp(join(ROOT, cat, f))
      .resize(1280, null, { withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    frames.push(toGray(new Uint8ClampedArray(data), info.width, info.height));
  }
}

/** Shift a frame by a pixel, as a hand holding a phone would. */
const jitter = (frame, n) => {
  const { width, height, data } = frame;
  const out = new Uint8ClampedArray(width * height);
  const dx = (n % 3) - 1;
  for (let y = 0; y < height; y++) {
    const from = y * width;
    for (let x = 0; x < width; x++) {
      const sx = Math.min(width - 1, Math.max(0, x + dx));
      out[from + x] = data[from + sx];
    }
  }
  return { data: out, width, height };
};

const rounds = Number(process.argv[2] ?? 3);
const started = Date.now();
let decoded = 0;
for (let round = 0; round < rounds; round++) {
  for (const [index, frame] of frames.entries()) {
    if (decoder.decode(jitter(frame, round + index)) !== null) decoded++;
  }
}
const elapsed = Date.now() - started;
const count = frames.length * rounds;
console.log(
  `${count} frames at a 120ms budget: ${decoded} read in ${elapsed}ms (${(elapsed / count).toFixed(0)}ms/frame)`
);
