# What this decoder supports

Two different questions, kept separate because they have different answers.

**Symbology coverage** is what the decoder can represent at all, and is
verified exhaustively against `etiket`-encoded matrices with no imaging
involved. **Imaging coverage** is the conditions under which a photograph of
such a symbol actually decodes, and is measured against synthetic renders at
known parameters plus the 718-image BoofCV benchmark.

A gap in the first is a missing feature. A gap in the second is a robustness
problem, and they are fixed by completely different work.

## Symbology coverage

Verified by round trip: encode with `etiket`, decode, compare. No pixels.

| feature              | support                                    | notes                                           |
| -------------------- | ------------------------------------------ | ----------------------------------------------- |
| Versions 1-40        | **all 160** version x EC combinations pass |                                                 |
| EC levels L, M, Q, H | full                                       |                                                 |
| Mask patterns 0-7    | full                                       |                                                 |
| Numeric mode         | full                                       |                                                 |
| Alphanumeric mode    | full                                       |                                                 |
| Byte mode (ASCII)    | full                                       |                                                 |
| Byte mode (UTF-8)    | full                                       | including emoji; UTF-8 tried before Latin-1     |
| Byte mode (Latin-1)  | full                                       | fallback when UTF-8 is invalid                  |
| Kanji mode           | **not supported**                          | deliberate; returns `null` rather than guessing |
| ECI                  | **not supported**                          | deliberate                                      |
| Structured Append    | **not supported**                          | deliberate                                      |
| Micro QR / rMQR      | **not supported**                          | out of scope                                    |
| 1D symbologies       | **not supported**                          | out of scope                                    |

The unsupported modes are what make general-purpose decoders large and
un-shakeable. Nothing encoding a URL for a sign-in screen uses them.

## Imaging coverage

Measured on synthetic renders where each condition is varied alone, so a
limit is attributable. "Works" means a version 3 URL decoded end to end.

| condition             | works                                          | limit                                             |
| --------------------- | ---------------------------------------------- | ------------------------------------------------- |
| Module size           | 2px and up                                     | below ~4px relies on the upscale rung; 1px fails  |
| Quiet zone            | 0 modules and up                               | no minimum needed — better than the spec requires |
| Polarity              | both                                           | dark-on-light and light-on-dark                   |
| Rotation              | 0-35 deg, 60-90 deg, and every 90 deg multiple | **45 deg still fails**                            |
| Blur                  | up to sigma 4                                  | sigma 8 fails                                     |
| Version at 4px/module | 10 through 40                                  |                                                   |

## Real-photograph coverage

The 718-image BoofCV benchmark, which is photographs rather than renders.
Overall **62.7%** unlimited, against jsQR's 24.8%, ZXing's published 31.87%,
ZBar's 38.95% and BoofCV's own 60.69% on the same images.

| condition                               | rate     | what is known                   |
| --------------------------------------- | -------- | ------------------------------- |
| Multiple codes per frame (`lots`)       | 100.0%   |                                 |
| Hard shadows (`shadows`)                | 84.2%    | local binarization              |
| Rotated (`rotations`)                   | 81.8%    |                                 |
| Ordinary photographs (`nominal`)        | 80.8%    | 250-image category, the largest |
| Even lighting (`brightness`)            | 75.0%    |                                 |
| Motion blur (`blurred`)                 | 73.6%    | blur retry                      |
| Curved surfaces (`curved`)              | 65.7%    | piecewise sampling              |
| Non-compliant symbols                   | 64.2%    |                                 |
| Specular highlights (`bright_spots`)    | 63.6%    |                                 |
| Small in a large frame (`close`)        | 59.5%    | multi-scale retry, both ways    |
| Pathological / adversarial              | 57.7%    |                                 |
| Screens and monitors (`monitor`)        | 56.0%    | low-pass retry defeats moire    |
| Glare                                   | 50.0%    |                                 |
| Perspective / oblique angles            | 48.8%    | believed near its ceiling       |
| Physically damaged                      | 35.4%    |                                 |
| **Very large symbols (`high_version`)** | **2.9%** | see below                       |

Re-measure rather than cite: every figure here is a snapshot of a ladder that
changes often.

## Known gaps, in order of what is worth fixing

1. **`high_version` (2.9%)** — versions 25 and 40 photographed flat-on and
   well-lit. Not a difficulty category: the images are easy, the symbols are
   enormous (177x177 modules, 3706 codewords, 49 error-correction blocks).
   The surface sags non-linearly between the finders — timing accuracy runs
   100% at both ends and 0% in the middle — but correcting that is
   demonstrably not sufficient: a grid with 100% timing accuracy still
   repairs zero of 49 blocks under all 32 mask/EC combinations. Six
   hypotheses tested and disproved. The geometric search space is exhausted.

2. **`perspective` (48.8%)** — oblique angles, and now believed to be at or
   near its classical ceiling. Two independent oracles were supplied and each
   added **zero** images:

   - **Ground-truth corners.** Feeding ZXing's own corner positions for all
     22 remaining failures, and sweeping every legal size from 21 to 97,
     recovers none of them. An earlier note here recorded a 2-of-23 to 7 gain
     from a supplied corner; that measurement was taken under the default
     120ms budget, and it does not survive re-measurement at `timeBudgetMs: 0`.
   - **Exhaustive triple search.** Trying every scoring finder triple rather
     than only `selectBestTriple`'s pick adds nothing on `perspective`,
     `rotations`, or `nominal`. The selection is not discarding a readable
     symbol.

   When two oracles at different stages both move the number by nothing, the
   fault is downstream of both. Four of the failures (`image010`-`012`,
   `image026`) sample the timing pattern at **0%** — not 50%, which would be
   noise — with correct-polarity finders and the true corner, which is only
   possible if binarization has already destroyed the modules. Those symbols
   are ~130px across at roughly 2.7px per module, in natively 1024x768 frames
   where no more resolution exists to recover. Neither higher resolution
   (capping at 2400px or not at all) nor polarity inversion changes any of it.

   Several of the remaining failures have no ZXing ground truth at all, which
   is itself evidence about where the ceiling sits.

3. **45-degree rotation** — the only angle that still fails on synthetic
   renders. The module-size correction over-shoots there, giving size 33
   where the truth is 29.

4. **`damaged` (27.1%) and `glare` (35.7%)** — no single cause identified.
   Notably OpenCV's WeChat detector leads both categories using a CNN, which
   is not replicable in a zero-dependency library, so these may have a
   classical ceiling.

## Performance envelope

| case                       | cost                                              |
| -------------------------- | ------------------------------------------------- |
| Frame with no symbol       | 233ms at 720p — early exit skips the retry ladder |
| Symbol that decodes        | 11-32ms at 1024x768                               |
| Symbol that cannot be read | 193-224ms, bounded by `timeBudgetMs`              |

`timeBudgetMs` defaults to 120ms. It is a blunt instrument: the full corpus
reads **62.7% unlimited against 40.3% at 120ms**, and the curve is still
climbing at 700ms. Set `0` for stills. For a live camera the answer is
`createProgressiveScanner`, which spends a small budget per frame and advances
through the ladder across successive frames.

Both figures are worth re-measuring rather than quoting: the ladder changes
often, and comparing a fresh number against a stale one in this document has
twice manufactured a regression that did not exist.
