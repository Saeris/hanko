/**
 * Fetch the BoofCV QR benchmark corpus for stage-2 development.
 *
 * Downloaded on demand rather than vendored, for two reasons.
 *
 * The first is licensing. The archive is published as "freely available" with
 * no stated licence: `BoofCV-Data` is CC BY 4.0, but that is a different
 * repository covering 2011-2015 material, and this archive lives elsewhere
 * with no terms attached. Its own readme points at a third-party site for
 * some images, so parts of it may not be the author's to license onward.
 * Fetching leaves every image where its owner put it and redistributes
 * nothing.
 *
 * The second is size: 251 MB has no place in a package whose entire argument
 * is a small footprint.
 *
 * The corpus is therefore a development tool, not a dependency. Tests that
 * need it skip when it is absent, so a clean checkout still passes.
 *
 * Attribution: assembled by Peter Abeles for the BoofCV project.
 * https://boofcv.org/index.php?title=Performance:QrCode
 */

import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, `..`);
const CORPUS_DIR = join(ROOT, `.corpus`);
const ARCHIVE = join(CORPUS_DIR, `qrcodes_v4.zip`);
const URL = `https://boofcv.org/notwiki/regression/fiducial/qrcodes_v4.zip`;

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

if (await exists(join(CORPUS_DIR, `qrcodes`))) {
  console.log(`Corpus already present at .corpus/qrcodes`);
  process.exit(0);
}

await mkdir(CORPUS_DIR, { recursive: true });

console.log(`Fetching the BoofCV QR benchmark corpus (~251 MB)...`);
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

console.log(`\nCorpus ready at .corpus/qrcodes`);
console.log(`Assembled by Peter Abeles for BoofCV — https://boofcv.org`);
