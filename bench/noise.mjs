/**
 * Noisy-frame benchmark, for profiling under deoptkit.
 *
 * A camera in low light delivers frames that are mostly sensor grain, and
 * grain is the worst possible input for a finder scan: it produces spurious
 * 1:1:3:1:1 runs everywhere, so every candidate-scoring stage runs at its
 * worst case on data holding no symbol at all. Measured before this bench
 * existed, one such frame cost 3.8 seconds with no time budget.
 */
// oxlint-disable no-bitwise -- a linear congruential generator IS bitwise
// arithmetic; the mask and shift are the algorithm, not a micro-optimisation.
import { createQrDecoder } from "../dist/scan/index.mjs";

const decoder = createQrDecoder({ timeBudgetMs: 0 });

const noise = (width, height, seed) => {
  const data = new Uint8ClampedArray(width * height);
  // Deterministic, so profiles are comparable between runs.
  let state = seed;
  for (let i = 0; i < data.length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    data[i] = (state >> 16) & 0xff;
  }
  return { data, width, height };
};

const frames = [noise(1280, 720, 1), noise(1280, 720, 7), noise(960, 540, 13)];

const rounds = Number(process.argv[2] ?? 2);
const started = Date.now();
for (let round = 0; round < rounds; round++) {
  for (const frame of frames) decoder.decode(frame);
}
console.log(
  `${frames.length} noisy frames x ${rounds} rounds in ${Date.now() - started}ms`
);
