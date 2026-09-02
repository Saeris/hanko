/**
 * Fetch the ArTe-Lab Medium 1D barcode corpus.
 *
 * 345 photographs of EAN-13 barcodes taken with camera phones, each with its
 * digits in a sibling `.txt`. Split by whether the camera had autofocus, which
 * is the useful axis: the no-AF half is exactly the blurry hand-held case a
 * scanner meets in a shop.
 *
 * Downloaded rather than vendored, like the QR corpus and for the second of
 * the same two reasons — 226 MB has no place in a package whose whole argument
 * is a small footprint. Licensing is not a concern here: unlike the BoofCV
 * archive this is explicitly **CC BY 3.0**, so the requirement is attribution,
 * which the citation below satisfies.
 *
 * Attribution, as the dataset asks:
 *
 *   Neural Image Restoration For Decoding 1-D Barcodes Using Common Camera
 *   Phones. Alessandro Zamberletti, Ignazio Gallo, Moreno Carullo and
 *   Elisabetta Binaghi. Computer Vision, Imaging and Computer Graphics —
 *   Theory and Applications, Springer Berlin Heidelberg, 2011.
 *
 * http://artelab.dista.uninsubria.it/downloads/datasets/barcode/medium_barcode_1d/medium_barcode_1d.html
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, `..`);
const CORPUS_DIR = join(ROOT, `.corpus`);
const ARCHIVE = join(CORPUS_DIR, `medium_barcode_1d.zip`);
const URL = `http://artelab.dista.uninsubria.it/downloads/datasets/barcode/medium_barcode_1d/medium_barcode_1d.zip`;

const exists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/** Unzip with the platform's own tool, so this needs no dependency. */
const extract = (archive, into) =>
  new Promise((resolve, reject) => {
    const [command, args] =
      process.platform === `win32`
        ? [
            `powershell`,
            [
              `-NoProfile`,
              `-Command`,
              `Expand-Archive -Path "${archive}" -DestinationPath "${into}" -Force`
            ]
          ]
        : [`unzip`, [`-oq`, archive, `-d`, into]];

    const child = spawn(command, args, { stdio: `inherit` });
    child.on(`exit`, (code) =>
      code === 0 ? resolve() : reject(new Error(`Extract failed (${code})`))
    );
    child.on(`error`, reject);
  });

if (await exists(join(CORPUS_DIR, `BarcodeDatasets`))) {
  console.log(`Corpus already present at .corpus/BarcodeDatasets`);
  process.exit(0);
}

await mkdir(CORPUS_DIR, { recursive: true });

console.log(`Fetching the ArTe-Lab Medium 1D corpus (~226 MB)...`);
console.log(`  ${URL}\n`);

const response = await fetch(URL);
if (!response.ok || response.body === null) {
  console.error(`Download failed: ${response.status} ${response.statusText}`);
  process.exit(1);
}

await pipeline(response.body, createWriteStream(ARCHIVE));
console.log(`Extracting...`);
await extract(ARCHIVE, CORPUS_DIR);
// The archive is only a delivery mechanism; keeping it doubles the footprint.
await rm(ARCHIVE, { force: true });

console.log(`\nCorpus ready at .corpus/BarcodeDatasets`);
console.log(
  `Zamberletti, Gallo, Carullo & Binaghi (2011), CC BY 3.0 — University of Insubria`
);
