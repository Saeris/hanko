/**
 * Recognition-rate benchmark over the whole corpus.
 *
 * Sharded across worker threads. Decoding 718 photographs serially took ten
 * to twenty minutes and eventually stopped completing at all, which made the
 * measurement useless for iterating — the whole point of having a corpus is
 * being able to check a change against it.
 *
 * Each worker owns its own decoder and a slice of the files. There is no
 * shared state to synchronise: decoding is pure, so this parallelises without
 * coordination.
 *
 * Usage:
 *   node bench/corpus.mjs                  whole corpus
 *   node bench/corpus.mjs perspective      one category
 *   node bench/corpus.mjs --budget 120     with a time budget
 */

// oxlint-disable no-await-in-loop -- directory listing and decoding are
// sequential on purpose: parallelism here is across WORKERS, and doing more
// at once inside one worker would just contend for the same core.
import { readdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData
} from "node:worker_threads";
import sharp from "sharp";
import { createQrDecoder, toGray } from "../dist/scan/index.mjs";

const ROOT = fileURLToPath(
  new URL("../.corpus/qrcodes/detection", import.meta.url)
);

/** Decode one file, returning whether it read. */
const decodeFile = async (decoder, path, maxWidth) => {
  try {
    const { data, info } = await sharp(path)
      // Capped by default: several corpus images are 12 megapixels, which no
      // camera pipeline would hand a decoder, and they dominate runtime.
      .resize(maxWidth, null, { withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    return (
      decoder.decode(
        toGray(new Uint8ClampedArray(data), info.width, info.height)
      ) !== null
    );
  } catch {
    return false;
  }
};

if (isMainThread) {
  const args = process.argv.slice(2);
  const budgetIndex = args.indexOf("--budget");
  const budget = budgetIndex === -1 ? 0 : Number(args[budgetIndex + 1]);
  const widthIndex = args.indexOf("--width");
  const maxWidth = widthIndex === -1 ? 1600 : Number(args[widthIndex + 1]);
  const only = args.filter((arg, index) => {
    if (arg.startsWith("--")) return false;
    return args[index - 1] !== "--budget" && args[index - 1] !== "--width";
  });

  const categories = (await readdir(ROOT)).filter(
    (category) => only.length === 0 || only.includes(category)
  );

  const entries = [];
  for (const category of categories) {
    const files = (await readdir(join(ROOT, category))).filter((f) =>
      /\.(jpg|png)$/i.test(f)
    );
    for (const file of files) {
      entries.push({ category, path: join(ROOT, category, file) });
    }
  }

  // Interleaved rather than contiguous, so no worker gets a slice made
  // entirely of the expensive categories — `damaged` costs 15x what
  // `pathological` does, and a contiguous split would leave one worker
  // running long after the rest finished.
  const workerCount = Math.min(availableParallelism(), 16, entries.length);
  const shards = Array.from({ length: workerCount }, () => []);
  for (const [index, entry] of entries.entries()) {
    shards[index % workerCount].push(entry);
  }

  const started = Date.now();
  const tallies = new Map();
  for (const category of categories) {
    tallies.set(category, { total: 0, read: 0 });
  }

  const results = await Promise.all(
    shards.map(
      (files) =>
        new Promise((resolve, reject) => {
          const worker = new Worker(fileURLToPath(import.meta.url), {
            workerData: { files, budget, maxWidth }
          });
          worker.on("message", resolve);
          worker.on("error", reject);
        })
    )
  );

  for (const shard of results) {
    for (const [category, ok] of shard) {
      const tally = tallies.get(category);
      tally.total++;
      if (ok) tally.read++;
    }
  }

  const rows = [...tallies.entries()].sort((a, b) => b[1].total - a[1].total);
  let total = 0;
  let read = 0;

  console.log("category        images  read    rate");
  for (const [category, tally] of rows) {
    total += tally.total;
    read += tally.read;
    const rate = ((tally.read / tally.total) * 100).toFixed(1);
    console.log(
      `${category.padEnd(15)} ${String(tally.total).padStart(5)} ${String(tally.read).padStart(5)}  ${rate.padStart(5)}%`
    );
  }

  const rate = ((read / total) * 100).toFixed(1);
  console.log(
    `${"TOTAL".padEnd(15)} ${String(total).padStart(5)} ${String(read).padStart(5)}  ${rate.padStart(5)}%`
  );
  console.log(
    `\n${workerCount} workers, budget ${budget || "none"}ms, capped at ${maxWidth}px — ${((Date.now() - started) / 1000).toFixed(1)}s`
  );
} else {
  const { files, budget, maxWidth } = workerData;
  const decoder = createQrDecoder({ timeBudgetMs: budget });

  const results = [];
  for (const entry of files) {
    results.push([
      entry.category,
      await decodeFile(decoder, entry.path, maxWidth)
    ]);
  }

  parentPort.postMessage(results);
}
