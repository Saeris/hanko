# QR decoder — a companion to etiket

## Why

Every option we can build on is frozen, and BarcodeDetector is not coming
soon enough to matter.

| Library                           | Last **code** commit | Open issues | Weekly downloads |
| --------------------------------- | -------------------- | ----------- | ---------------- |
| `jsQR` (engine inside qr-scanner) | Aug 2021             | 97          | 2.44M            |
| `qr-scanner`                      | Nov 2022             | 119         | 0.27M            |
| `html5-qrcode`                    | Jul 2023             | 444         | 1.49M            |
| `zxing-wasm`                      | active               | 7           | 1.88M            |

Two facts drive the decision:

1. **The frozen path is the only path on iOS.** WebKit's `support` position
   (Apr 2024) was applied by no-objection — "we forgot to close off the
   position" — on a draft. Its implementation landed behind a flag in May 2023
   and is _still_ off by default. The iOS bug (281848) is 21 months old,
   `NEW`, and `webkit-unassigned`. Firefox's bug is **7 years** old and
   assigned to nobody, with Mozilla at `defer` plus an unanswered
   fingerprinting objection (`getSupportedFormats()` leaks a device
   signature). Baseline needs three engines; two are not trying.

2. **This is abandonment under load, not disinterest.** Web QR scanning draws
   ~7.7M downloads/week against ~2.8M for the native options — `jsQR` alone
   outdraws `expo-camera`. The libraries are unmaintained _despite_ heavy use.

`zxing-wasm` is maintained but is 1.04 MiB reader-only and, being WASM,
structurally un-shakeable.

**The risk we inherit:** a QR decoder feels _finished_ once it decodes, which
is precisely why these projects stall. The differentiator cannot be "modern
patterns" — jsQR's 2021 code still decodes fine. It has to be _maintained and
correct on iOS_. That is a commitment, not an architecture.

## Shape

Companion to `etiket`, matching its conventions exactly:

- Zero dependencies, ESM only, `type: module`, `sideEffects: false`
- Per-symbology subpath exports (`/qr`), so QR decoding pulls in nothing else
- Browser baseline **January 2026** — every API below is available except
  `MediaStreamTrackProcessor` (Chromium-only), so the camera path stays
  canvas-based

Lives in this repo under `src/scan/` for now, exported as
`@saeris/hanko/scan`. Split into its own package when a second consumer
exists — not before, or we maintain a release surface for a hypothesis.

### API

Shaped as we want it, NOT contorted to match `BarcodeDetector` — that spec is
5+ years out on the evidence above, and carries an unresolved privacy
objection. But `detect()` stays roughly its shape so a compatibility layer is
a day's work if it ever ships.

The one API flaw that actually bit us gets fixed: **inversion is a
constructor option, not a post-construction method**. qr-scanner buries it in
`setInversionMode`, and its camera path defaults to `dontInvert` while
`scanImage` defaults to `both` — which is why an inverted QR decoded as
nothing for many turns while every diagnostic read healthy.

## Build order

Deliberately inverted from instinct: the _provable_ half first, so the risky
half starts on a known-good foundation.

### Stage 1 — matrix to bytes (pure logic) — **DONE**

Verified by round trip against etiket: 516 payloads across versions 1-33, all
eight masks, all four EC levels, all three supported segment modes, and UTF-8.
Kanji correctly returns `null` rather than guessing.

Modules: `galois.ts`, `polynomial.ts`, `reed-solomon.ts`, `format.ts`,
`mask.ts`, `blocks.ts`, `bitstream.ts`, `decode-matrix.ts`.

Format/version decode, unmasking, de-interleaving, Reed-Solomon over GF(256),
mode parsing (numeric, alphanumeric, byte; **not** Kanji/ECI — out of scope).

`etiket` gives us a **round-trip oracle** for free:

```
encodeQR(text, { ecLevel }) -> boolean[][] -> decodeMatrix(matrix) -> text
```

Every version (1-40), every EC level, every mask, arbitrary payloads —
exhaustively verifiable with no image files at all. Confirmed working:
`encodeQR` returns a clean `boolean[][]`.

This stage is fully testable in Vitest, which matters because CLAUDE.md
forbids react-native imports in files Vitest runs.

### Stage 2 — pixels to matrix (the hard part)

Binarize, locate finder patterns, correct perspective, sample the grid.

This is where jsQR's 97 open issues live, and it cannot be proven by
round-trip. It needs a corpus of **real photographs**: angled, blurry, glare,
low light, damaged, and inverted — inverted is not optional, since our own
`/tv` screen renders light-on-dark by design.

Gate: measure jsQR against the same corpus as the baseline. Shipping
something that decodes _fewer_ real photos than the library it replaces would
be a straight downgrade, however clean the source.

### Stage 3 — camera adapter

Frame acquisition, worker offload, the lifecycle `link.astro` needs. Only
after stages 1 and 2 hold.

## Scope

**In:** QR only. Versions 1-40. Numeric, alphanumeric, and byte modes.
Both polarities, by default.

**Out:** Kanji and ECI modes, Micro QR, rMQR, and every 1D symbology. These
are what make the incumbents large and un-shakeable.

## Corpus results

Measured on the 718-image BoofCV benchmark (`yarn corpus`).

|                                   | rate      |
| --------------------------------- | --------- |
| jsQR (the incumbent, same images) | 24.8%     |
| ZXing (published)                 | 31.87%    |
| ZBar (published)                  | 38.95%    |
| **this decoder**                  | **51.5%** |
| BoofCV (published)                | 60.69%    |

| category     | rate  |
| ------------ | ----- |
| brightness   | 89.3% |
| lots         | 87.5% |
| shadows      | 73.7% |
| bright_spots | 66.7% |
| noncompliant | 65.7% |
| nominal      | 65.6% |
| blurred      | 64.2% |
| curved       | 61.2% |
| monitor      | 48.0% |
| rotations    | 47.7% |
| pathological | 42.3% |
| close        | 38.1% |
| glare        | 35.7% |
| damaged      | 27.1% |
| perspective  | 16.3% |
| high_version | 2.9%  |

### Cost, and why a single frame is the wrong unit

Recognition and latency are in direct tension here, and measuring the
trade-off changed the architecture rather than tuning a constant.

Per-rung cost on a 1024x768 frame: downscale 6ms, local binarize 16ms, global
binarize 24ms, blur 28ms, denoise 31ms, corner search ~250ms. Rungs run
cheapest first so a budget buys as many attempts as possible.

But sweeping the budget over 72 sampled images shows recognition still
climbing well past what any single frame can afford:

| budget    | decoded |
| --------- | ------- |
| 120ms     | 21/72   |
| 250ms     | 24/72   |
| 400ms     | 31/72   |
| 700ms     | 41/72   |
| unlimited | 44/72   |

So `timeBudgetMs` is a blunt instrument: the default 120ms costs roughly half
the achievable rate. The right shape is PROGRESSIVE — cheap rungs on every
frame, expensive ones spread across successive frames. A camera supplies 30
frames a second, so ten frames at 120ms is 1.2s of total work without ever
stalling the preview, which is more than the 700ms that reaches 41 of 72.
Not yet built; `timeBudgetMs: 0` is correct for stills today.

### What is known about the remaining failures

**`high_version` (2.9%)** — the category is not what its name suggests, and
that misled every attempt to fix it for several rounds.

These are **not difficult images**. They are versions 25 and 40 — the largest
QRs that exist — photographed nearly flat-on at a comfortable 8 to 14 pixels
per module. `zxing-wasm` reads 12 of 12. There is no distortion, no damage, no
lighting problem. What makes them hard is CAPACITY: 177x177 modules, 864
characters, 3706 codewords in 49 Reed-Solomon blocks.

That reframes it as a scale-dependent problem rather than a geometric one,
which is why rounds of work on corners, warp and piecewise sampling changed
nothing.

What is now known, measured against `zxing-wasm` corner positions:

- **The true finder patterns ARE detected**, all three, within 1 to 4 pixels
  on every image checked. Detection is not the problem.
- **Module size is consistently over-estimated** — 8.4 against a true 6.3 on
  one image — which makes `estimateSize` under-report: 145, 161, even 53
  where the truth is 177. Nine of twelve sizes are wrong.
- **Forcing the true size still decodes 0 of 12**, so size is a symptom
  rather than the cause.
- **A version 40 symbol produces 7 to 13 finder candidates**, most of them
  false positives from inside the data region: 3706 codewords of dense
  pattern throw up the 1:1:3:1:1 signature by chance many times. On one image
  the search picked three interior blobs 431px apart and concluded 51 modules
  while the real finders sat at the corners.
- **Scoring every candidate triple with `scoreTransform` still decodes 0 of
  12**, even though the correct triple is present among the candidates.

What a module-by-module investigation established:

- **Finder patterns sample at 100%** — 147 of 147 modules correct across all
  three finders on two images, 145 of 147 on the third.
- **Timing and alignment patterns sample at ~50%** — a coin flip. 203 of 322
  timing modules, 615 of 1150 alignment modules.
- **The error is not drift.** Timing accuracy by column on one image runs
  100%, 70%, 50%, 70%, 55%, 80%, 100%, 100% — worst in the MIDDLE and perfect
  at both ends. Another reaches **0%** at columns 68-88 before recovering to
  100% by column 148. Zero percent is anti-correlation: the grid samples
  exactly out of phase and reads every module as its neighbour. Drift would
  degrade monotonically; this bows and returns, which is a non-linear
  deviation a homography cannot express.
- **Piecewise sampling helps and is not enough.** It takes one image's timing
  from 78% to 98%, and it still does not decode.
- **A grid with 100% timing still does not decode**, and trying all 32
  mask/EC combinations on it repairs zero of 49 Reed-Solomon blocks. That
  eliminates mask selection and EC level as causes.

So the surface genuinely sags between the finders, and correcting the module
grid is necessary but demonstrably not sufficient — something downstream
fails even when the grid is verifiably right. Six hypotheses have now been
tested and disproved on this category (wrong size, misplaced corner,
cumulative drift, sampling jitter, finder-candidate pollution, mask/EC
selection), which is worth stating plainly: the geometric search space is
exhausted, and the remaining fault is not geometric.

**`glare` (3.6%)** and **`perspective` (9.3%)** are untouched so far.

### What limits `perspective` (9.3%)

Established by brute force rather than inference, using decode success as the
only ground truth:

- **The fourth corner is not the limit.** Searching it over a +/-8 module grid
  recovers 4 of 15 images; the other 11 decode at NO corner position. Whatever
  is wrong is upstream of the corner.
- **Size estimation is not the limit.** With a known-good corner, 16 of 23
  images fail at every legal size from 21 to 177.
- **Finder-centre precision is part of it.** Nudging the three centres by up
  to one module in half-module steps recovers 2 of 8 failing images — real,
  but not the whole story.

So roughly a quarter of the remaining failures are sub-module geometry and
the rest are something else not yet identified.

### Ideas evaluated, with what the measurements said

**WebGPU acceleration — worth doing.** Profiling a 1024x768 frame: one
`scoreTransform` costs 0.29ms, and the corner search makes 625 of them for
~179ms, which is 78% of that stage and the single largest cost in the
decoder. Those 625 calls are independent scorings of the same image, which is
the shape GPU compute is for.

The rest is not. Binarization, blur and downscale cost 6-31ms each, and the
literature is explicit that WebGPU loses at that scale because buffer upload,
dispatch and readback exceed the work. So this is one targeted kernel, not a
rewrite.

Availability is unusually good: WebGPU shipped enabled-by-default in iOS 26,
macOS Tahoe 26 and iPadOS 26, which removed the last major holdout. MDN still
says "not Baseline" because that needs sustained multi-engine support, but
every target platform has it today. Note the contrast with BarcodeDetector —
that is five years out and would REPLACE this decoder; this is available now
and merely accelerates it.

**Dewarping — already implemented, in the form that suits QR.** The
single-image document-flattening literature works by exploiting known regular
structure in the content: "parallelism and equal line spacing" of printed
text. A QR has stronger structure than that — timing patterns are a known
alternating sequence and alignment patterns sit at coordinates the spec
fixes — and `samplePiecewise` already uses exactly that to fit local
transforms per region. It is the QR-specific case of the same idea.

Shape-from-shading specifically is a poor fit: it assumes Lambertian
reflection and near-uniform albedo, and a QR's albedo varies violently by
design, since the modules ARE the albedo variation.

Measuring the warp did find a real bug, though: piecewise sampling was gated
on `version >= 7`, from having first diagnosed the problem on a version 40
symbol and assuming it scaled with symbol size. On the `curved` category
alignment patterns sit a median of 0.70 modules off the plane — past the
half-module threshold — regardless of version. Now gated at version 2, which
is the first version carrying an alignment pattern at all.

**LiDAR — not available to us.** Depth data is not exposed to the web
platform: `getUserMedia` returns colour frames, and there is no depth track.
It would require a native app, which is the opposite of this library's
purpose.

### Negative results, recorded so they are not re-attempted

- **Majority-vote sampling** over each module's central region (the
  robust-geometric-transform idea from the barcode literature) made things
  **worse**: 22.8% down to 21.7%. At this corpus's module sizes, a
  neighbourhood wide enough to outvote sub-pixel drift is also wide enough to
  reach the adjacent module.
- **Blur as a default preprocessing pass** is a trade, not a win: it takes
  `blurred` from 5/14 to 1/14 and `nominal` from 3/14 to 0/14. It is correct
  only as a retry after a sharp pass fails.
- **Fitting lines to the far edges** to locate the fourth corner — probing
  perpendicular to each edge at several points, fitting by principal
  direction, and intersecting — measured slightly WORSE (32.2% -> 31.9%) and
  decoded exactly the same images as the parallelogram it replaced on
  `perspective`, `curved` and `glare`. More principled, no better, so
  reverted. The corner simply is not what limits those categories.
- **A fixed wide alignment search radius** (16 modules) measured worse than
  scaling it to the symbol: false matches on small symbols cost more than the
  large-symbol recoveries gained.

## Open questions

1. ~~Where does the photo corpus come from?~~ **Resolved.** The BoofCV QR
   benchmark (`qrcodes_v4.zip`, assembled by Peter Abeles) — 718 photographs
   across the same 16 categories the published comparisons use, with
   hand-selected corner coordinates as ground truth, plus 54 decoding cases.

   Fetched on demand by `yarn corpus` into a gitignored `.corpus/`, never
   vendored. The archive is published as "freely available" with no stated
   licence: `BoofCV-Data` is CC BY 4.0, but that is a different repository
   covering 2011-2015 material, and this archive's own readme points at a
   third-party site for some images. Fetching redistributes nothing and keeps
   the published package free of third-party images — and 251 MB has no place
   in a package arguing for a small footprint. Tests skip when it is absent.

2. Does stage 1 alone justify shipping, paired with jsQR's locator, as a way
   to de-risk before stage 2 lands?
3. Worker or no worker? etiket has no worker; a decoder on the main thread is
   simpler and may be fast enough at 5-10 scans/sec.
