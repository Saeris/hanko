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
Overall **68.8%** unlimited, against jsQR's 24.8%, ZXing's published 31.87%,
ZBar's 38.95% and BoofCV's own 60.69% on the same images.

| condition                                | rate      | what is known                    |
| ---------------------------------------- | --------- | -------------------------------- |
| Multiple codes per frame (`lots`)        | 100.0%    |                                  |
| Hard shadows (`shadows`)                 | 89.5%     | local binarization               |
| Rotated (`rotations`)                    | 88.6%     |                                  |
| Small in a large frame (`close`)         | 85.7%     | multi-scale retry, both ways     |
| Ordinary photographs (`nominal`)         | 84.0%     | 250-image category, the largest  |
| Even lighting (`brightness`)             | 78.6%     |                                  |
| Motion blur (`blurred`)                  | 73.6%     | blur retry                       |
| Screens and monitors (`monitor`)         | 72.0%     | low-pass retry defeats moire     |
| Non-compliant symbols                    | 71.6%     |                                  |
| Curved surfaces (`curved`)               | 68.7%     | piecewise sampling               |
| Specular highlights (`bright_spots`)     | 63.6%     |                                  |
| Glare                                    | 62.5%     |                                  |
| Pathological / adversarial               | 57.7%     |                                  |
| Perspective / oblique angles             | 48.8%     | finder DETECTION, not fitting    |
| Physically damaged                       | 39.6%     |                                  |
| **Very large symbols (`high_version`)**  | **14.7%** | see below                        |

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
     gives a flat, bad profile: `image001` reads 67% _on_ an anchor and 63%
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

   ### Why it fails: an error budget, not a broken stage

   The literature first ruled out the obvious remaining suspects. The Nyquist
   study (Sensors 22(19):7230) puts the practical floor at **3-3.5 pixels per
   module**; these images measure **6.4-10.7**, so they are not
   resolution-limited. BoofCV's `QrCodeBinaryGridReader` reads the _greyscale_
   image with a 5-point majority vote per module and a threshold bilinearly
   interpolated between four values measured at the symbol's own corners —
   implemented and tested here, it moved timing accuracy by +/-2 points and
   decoded nothing, so thresholding is not the fault either.

   What the sampled grid actually needed was a uniform sub-module **phase**
   shift. Scanning scale and phase independently finds the optimum at scale
   exactly **1.000** on both axes — no pitch error — with a shift of about
   (+0.2, -0.2) modules bringing finders to 96-98% _and_ timing to 76-83%
   together, the first self-consistent state reached. It still does not
   decode.

   Because the bitstream layer is not the problem either: fed perfect
   matrices, `decodeMatrix` round-trips **every version through 38**,
   including the v26 and v32 sizes that fail as photographs.

   The measurement that explains the category is the error budget. Injecting
   random module errors into a perfect symbol:

   | module error | v26 (121x121) | v38 (169x169) |
   | ------------ | ------------- | ------------- |
   | 0.5%         | 5/5           | 5/5           |
   | 1.0%         | 5/5           | 5/5           |
   | 2.0%         | **0/5**       | **0/5**       |

   A large symbol tolerates **1% module error and fails at 2%**. The cliff is
   that sharp because Reed-Solomon works on codewords: at 1% most 8-module
   codewords are clean, and at 2% nearly every one carries a bad bit, so 49
   blocks exhaust their correction capacity simultaneously.

   The best grids measured here read timing at 83-96%, i.e. **4-17% module
   error — between 4x and 17x over budget**. That is not a near miss that
   better geometry closes.

   ### Who actually uses these

   Worth knowing before spending more on the category. Industry guidance is
   consistent: _"most QR codes you encounter in the wild use versions between
   **1 and 10**"_, and the named uses for large versions are vCards, Wi-Fi
   credentials and bulk product data — static, controlled-print, close-scan
   situations that happen to supply the <=1% module accuracy the error budget
   demands. High-volume logistics does **not** use them: USPS, UPS and FedEx
   sort with their own proprietary linear symbologies, and a QR on a shipping
   label is a supplementary consumer-facing layer, not the sorting code.

   The corpus agrees. Of 450 symbols hanko reads, **82% carry 60 characters or
   fewer** (370 of 450) and only 19 exceed ~180. Hanko's own payloads — a
   device-authorization URL with a user code — encode to **version 3-7**, even
   for a long tenant hostname with an issuer parameter.

   So `high_version` is 33 images of a 718-image corpus, in a regime that
   needs 4-17x better sampling than anything measured here, for a use case the
   library will never generate and most adopters will never scan. It also explains why five separate sources of
   correct information each changed nothing: every one removes _some_ error,
   but the requirement is <=1%, and a version 40 symbol allows at most 313 of
   its 31,329 modules to be wrong. A version 1 symbol allows ~4 of 441, which
   is why small symbols are forgiving and these are not.
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

## The next lever: erasure decoding

Where the 268 remaining failures actually sit, by count:

| category       | missing | read |
| -------------- | ------- | ---- |
| `high_version` | 33      | 3%   |
| `damaged`      | 31      | 35%  |
| `glare`        | 28      | 50%  |
| `nominal`      | 24      | 81%  |
| `noncompliant` | 24      | 64%  |
| `curved`       | 23      | 66%  |
| `perspective`  | 22      | 49%  |

Excluding `high_version`, the corpus reads **65.6%**. The four buckets after
it total 107 images — more than three times the v40 opportunity — and they sit
in the version range that both the industry and this corpus say is where real
scanning happens.

`glare` and `damaged` share a mechanism worth pursuing. Reed-Solomon corrects
`2t` **erasures** (failures at known positions) against only `t` **errors**
(unknown positions) — literally double the capacity, for no improvement in
sampling. Confirmed against this implementation: with 10 EC codewords it
corrects exactly 5 errors and fails at 6, where erasures would reach 10.

The decoder is currently errors-only, and throws the position information away
by thresholding every pixel into a confident 0 or 1. Glare hands that
information over for free: measured across the corpus, `glare` and
`bright_spots` average **1.1-1.2% of pixels at or above 250**, while `nominal`
and `damaged` measure **0.00%** — so saturation cleanly identifies the glare
categories and would essentially never fire on ordinary images, making it safe
for the 82% that already work. (`damaged` shows no saturation at all and would
need a different signal, most likely absence of local contrast.)

Measured tolerance for localised blob damage today, which is the shape glare
actually takes:

| EC level | survives | fails at |
| -------- | -------- | -------- |
| L        | 5%       | 10%      |
| M        | 10%      | 15%      |
| Q        | 10%      | 15%      |
| H        | 15%      | 20%      |

Doubling the correctable count should move the ecM threshold from ~10% toward
~20% of the symbol.

### Built, verified, and not yet the binding constraint

Erasure decoding is implemented and correct. It satisfies the theoretical
bound at every boundary — 10 check codewords repair 5 errors and fail at 6,
repair 10 erasures and fail at 11, repair 2 errors plus 6 erasures but not 2
plus 7 — and end-to-end through the imaging path a synthetic blob shows
exactly the predicted gain:

| EC level | blob area | errors-only | with erasures |
| -------- | --------- | ----------- | ------------- |
| M        | 15%       | 0%          | **100%**      |
| Q        | 20%       | 0%          | **100%**      |
| H        | 25%       | 0%          | **100%**      |

It converts **zero** corpus images, and the reason is worth recording.

The headroom looked real: 45 of 56 `glare` images reach a finder triple under
some binarization while only 28 decode, and the same gap holds for
`bright_spots` (28 vs 21) and `damaged` (31 vs 17) — 38 images across three
categories that locate a symbol and then lose it. The saturation detector
fires on them, marking a median 5.4% of modules on `glare` and **21.6%** on
`bright_spots`, well past the 15% where synthetic blobs flip from 0% to 100%.

But sweeping every ladder binarization and size, with erasures offered at each,
recovers none of them. The measurement that explains it: on failing images that
produce a grid at all, **median timing accuracy is 50-58%** — chance. Localized
damage leaves the timing pattern near 95% intact and destroys one region;
these grids are wrong _everywhere_.

So the failures in `glare`, `bright_spots` and `damaged` are not blobs of
destroyed modules over an otherwise-good grid. They are the same
grid-registration failure that limits `perspective` and `high_version`, and
erasures cannot help: there is no clean region left to preserve, and marking
most of a symbol as erased spends the capacity it was meant to save.

The capability stays because it is correct, tested, costs nothing when no mask
is supplied, and is exactly what these categories will need **once** the grid
lands — but detection and registration, not correction capacity, are what
gate them today.

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
