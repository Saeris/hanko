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

   Geometry is now ruled out from four independent directions, none of which
   moved the number:

   - **Correct size.** `estimateSize` is badly wrong here — 109 where the
     truth is 117, `null` on 6 of 33 — because `distance / moduleSize`
     multiplies any error in `moduleSize` by ~170 at version 40. Counting
     transitions along the timing pattern instead is immune to that and
     recovers the true size (177 on six images, an exact 117 on another).
     Supplying it decodes **1 of 33**, the one image that already read.
   - **Alignment patterns.** With the correct size, `locateAlignmentGrid`
     finds **25 of 25** anchors on `image001` and 39-42 of 49 on the version
     40 images. Piecewise sampling across all of them still decodes none.
   - **Sub-pixel anchor refinement.** Centroiding the anchors rather than
     taking the first matching pixel made timing accuracy _worse_ on three of
     four images tested.
   - **Global registration search.** Sweeping the fourth corner over a
     +/-6px grid peaks at 54-62% timing accuracy, always at the edge of the
     range, never near the ~95% a correct grid shows.

   The sampled matrix on `image001` tells the story: finders read 92/100/73%,
   but the timing pattern reads **56.4%** and the dark module — which the spec
   fixes at 1 — reads 0. Corners pinned, interior sliding. The bits being fed
   to Reed-Solomon are not the symbol's bits across most of its area, which is
   consistent with the earlier finding that a grid with 100% timing accuracy
   still repairs 0 of 49 blocks.

   Two further probes, both aimed at the sampling stage rather than the
   corners, and both negative:

   - **Accuracy does not decay with distance from an anchor.** Bucketing
     timing-module accuracy by distance to the nearest alignment coordinate
     gives a flat, bad profile: `image001` reads 67% *on* an anchor and 63%
     eight modules away, and `image009` reads **0% directly on one**. So
     interpolation between anchors is not the fault — modules sitting on top
     of a located alignment pattern read no better than distant ones. The
     anchors are regularly spaced (median neighbour-spacing ratio 1.00-1.01,
     so they are genuine patterns rather than false positives) yet sit a
     median 1.3-1.7 modules from where the transform predicts. Reassigning
     every anchor one column over improves all three images identically —
     56->69%, 67->71%, 42->54% — which says the registration is systematically
     off, but nowhere near enough to decode.
   - **The version block measures the size correctly, and it does not help.**
     Versions 7+ carry 18 BCH-protected bits stating the version outright,
     beside the finders where sampling is most accurate. Swept across
     candidate sizes it votes decisively and correctly: v25 on the
     117-module symbol, v40 on the version 40s, scattered singletons
     dissenting. Wired into the decoder's size candidates it converts
     **zero** images and costs 0.2 points budgeted, so it was reverted.

   Five independent sources of correct information — size from timing, size
   from the version block, located alignment anchors, sub-pixel refinement,
   and a global registration sweep — each supply the truth and none decodes an
   additional image. The sampled matrix says why: finders read 92-100% while
   the timing pattern reads 56% and the interior worse. The corners are
   readable and the middle is not, which is precisely why every
   corner-derived correction fails and why the version block reads perfectly
   while the payload does not.

   Timing-derived sizing was likewise measured as a general fallback and
   deliberately NOT added: `estimateSize` returns null on only 29 of 557
   images corpus-wide (5.2%), concentrated in exactly the categories that fail
   downstream anyway.
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
