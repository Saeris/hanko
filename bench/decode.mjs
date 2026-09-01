/**
 * Decoder hotspot benchmark, for profiling under deoptkit.
 *
 * Runs the BUILT output rather than source, because that is what consumers
 * execute and what V8 will actually optimise. Deliberately weighted towards
 * the expensive path — frames holding a symbol that cannot be read — since
 * that is where the decoder spends its time and where the retry ladder is
 * fully exercised.
 */
// oxlint-disable no-await-in-loop -- loading fixtures sequentially is
// deliberate: parallel reads would contend for disk and skew the warm-up.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { createQrDecoder, toGray } from "../dist/scan/index.mjs";

const ROOT = "C:/GitHub/@saeris/hanko/.corpus/qrcodes/detection";
const decoder = createQrDecoder({ timeBudgetMs: 0 });

// Load a fixed set once; decoding the same frames repeatedly is what warms
// V8 enough for it to optimise, which is the point of profiling at all.
const frames = [];
for (const cat of ["perspective", "nominal", "curved", "damaged"]) {
  const files = (await readdir(join(ROOT, cat)))
    .filter((f) => /\.(jpg|png)$/i.test(f))
    .slice(0, 3);
  for (const f of files) {
    const { data, info } = await sharp(join(ROOT, cat, f))
      .resize(1024, null, { withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    frames.push(toGray(new Uint8ClampedArray(data), info.width, info.height));
  }
}

const rounds = Number(process.argv[2] ?? 3);
let decoded = 0;
const started = Date.now();
for (let round = 0; round < rounds; round++) {
  for (const frame of frames) {
    if (decoder.decode(frame) !== null) decoded++;
  }
}
const elapsed = Date.now() - started;
console.log(
  `${frames.length} frames x ${rounds} rounds: ${decoded} decoded in ${elapsed}ms (${Math.round(elapsed / (frames.length * rounds))}ms/frame)`
);
