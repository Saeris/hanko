/**
 * Recognition-rate benchmark for the EAN/UPC decoder.
 *
 * The same shape as `corpus.mjs` — sharded across workers, one decoder each,
 * no shared state — over the ArTe-Lab Medium 1D corpus: 345 photographs of
 * EAN-13 barcodes taken with camera phones, split by whether the camera had
 * autofocus.
 *
 * What it measures differs from the QR benchmark in one important way. A QR
 * symbol either reconstructs or it does not, so "read" and "read correctly"
 * are the same number. This family has no error correction and a check digit
 * that one reading in ten passes by chance, so those are two different numbers
 * and both are reported. A **wrong** reading is far worse than none: it sends a
 * caller to look up a product that is not there.
 *
 * Usage:
 *   node bench/barcodes.mjs                 both subsets
 *   node bench/barcodes.mjs Dataset1        autofocus only
 *   node bench/barcodes.mjs --budget 120    with a time budget
 */

// oxlint-disable no-await-in-loop -- directory listing and decoding are
// sequential on purpose: parallelism here is across WORKERS, and doing more at
// once inside one worker would just contend for the same core.
import { readFile, readdir } from "node:fs/promises";
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
import { toGray } from "../dist/scan/index.mjs";
import { createLinearDecoder } from "../dist/scan/linear/index.mjs";

const ROOT = fileURLToPath(
  new URL("../.corpus/BarcodeDatasets", import.meta.url)
);

/** Decode one file, and say whether it matched what the corpus expects. */
const decodeFile = async (decoder, path, maxWidth) => {
  let expected;
  try {
    expected = (await readFile(`${path}.txt`, `utf8`)).trim();
  } catch {
    // No ground truth: the image cannot be scored either way.
    return null;
  }

  try {
    const { data, info } = await sharp(path)
      // Capped by default: these are full-resolution phone photographs, which
      // no camera pipeline would hand a decoder unscaled.
      .resize(maxWidth, null, { withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const symbol = decoder.decode(
      toGray(new Uint8ClampedArray(data), info.width, info.height)
    );

    if (symbol === null) return { read: false, correct: false };

    // A UPC-A is reported as twelve digits and the corpus records thirteen, so
    // compare in the thirteen-digit space rather than counting a correct
    // reading as wrong over a leading zero.
    const value =
      symbol.value.length === 12 ? `0${symbol.value}` : symbol.value;

    return { read: true, correct: value === expected };
  } catch {
    return { read: false, correct: false };
  }
};

if (isMainThread) {
  const args = process.argv.slice(2);
  const budgetIndex = args.indexOf(`--budget`);
  const budget = budgetIndex === -1 ? 0 : Number(args[budgetIndex + 1]);
  const widthIndex = args.indexOf(`--width`);
  const maxWidth = widthIndex === -1 ? 1600 : Number(args[widthIndex + 1]);
  const only = args.filter((arg, index) => {
    if (arg.startsWith(`--`)) return false;
    return args[index - 1] !== `--budget` && args[index - 1] !== `--width`;
  });

  let sets;
  try {
    sets = (await readdir(ROOT)).filter(
      (name) =>
        name.startsWith(`Dataset`) && (only.length === 0 || only.includes(name))
    );
  } catch {
    console.error(
      `No corpus at .corpus/BarcodeDatasets — run \`yarn corpus:barcodes\` first.`
    );
    process.exit(1);
  }

  const entries = [];
  for (const set of sets) {
    const files = (await readdir(join(ROOT, set))).filter((f) =>
      /\.(jpg|png)$/i.test(f)
    );
    for (const file of files) {
      entries.push({ set, path: join(ROOT, set, file) });
    }
  }

  const workerCount = Math.min(availableParallelism(), 16, entries.length);
  const shards = Array.from({ length: workerCount }, () => []);
  // Interleaved rather than contiguous, so no worker gets a slice made
  // entirely of one subset — the no-autofocus images cost more.
  for (const [index, entry] of entries.entries()) {
    shards[index % workerCount].push(entry);
  }

  const started = Date.now();
  const results = await Promise.all(
    shards.map(
      (files) =>
        new Promise((resolve, reject) => {
          const worker = new Worker(fileURLToPath(import.meta.url), {
            workerData: { files, budget, maxWidth }
          });
          worker.on(`message`, resolve);
          worker.on(`error`, reject);
        })
    )
  );

  const tallies = new Map();
  for (const set of sets) {
    tallies.set(set, { total: 0, read: 0, correct: 0 });
  }

  for (const shard of results) {
    // Images with no ground truth are dropped rather than skipped inside the
    // loop: they cannot be scored either way, so they do not belong in a rate.
    for (const [set, outcome] of shard.filter(
      ([, result]) => result !== null
    )) {
      const tally = tallies.get(set);
      tally.total++;
      if (outcome.read) tally.read++;
      if (outcome.correct) tally.correct++;
    }
  }

  const LABELS = {
    Dataset1: `autofocus`,
    Dataset2: `no autofocus`
  };

  console.log(`subset                images  correct  misread   rate`);

  let total = 0;
  let correct = 0;
  let read = 0;

  for (const [set, tally] of tallies) {
    total += tally.total;
    correct += tally.correct;
    read += tally.read;

    const rate = ((tally.correct / tally.total) * 100).toFixed(1);
    const wrong = tally.read - tally.correct;
    const label = `${set} (${LABELS[set] ?? `?`})`;
    console.log(
      `${label.padEnd(21)} ${String(tally.total).padStart(5)} ${String(
        tally.correct
      ).padStart(8)} ${String(wrong).padStart(8)} ${rate.padStart(6)}%`
    );
  }

  const rate = ((correct / total) * 100).toFixed(1);
  console.log(
    `${`TOTAL`.padEnd(21)} ${String(total).padStart(5)} ${String(
      correct
    ).padStart(8)} ${String(read - correct).padStart(8)} ${rate.padStart(6)}%`
  );
  console.log(
    `\n${workerCount} workers, budget ${budget || `none`}ms, capped at ${maxWidth}px — ${(
      (Date.now() - started) /
      1000
    ).toFixed(1)}s`
  );

  // A misread is the failure that matters: it is indistinguishable from a
  // reading to the caller, so it is called out rather than folded into a rate.
  if (read - correct > 0) {
    console.log(
      `\n${read - correct} MISREAD — decoded confidently, wrong digits.`
    );
  }
} else {
  const { files, budget, maxWidth } = workerData;
  const decoder = createLinearDecoder({ timeBudgetMs: budget });

  const results = [];
  for (const entry of files) {
    results.push([entry.set, await decodeFile(decoder, entry.path, maxWidth)]);
  }

  parentPort.postMessage(results);
}
