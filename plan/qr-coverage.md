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
Overall **74.4%** unlimited, against jsQR's 24.8%, ZXing's published 31.87%,
ZBar's 38.95% and BoofCV's own 60.69% on the same images.

| condition                               | rate      | what is known                   |
| --------------------------------------- | --------- | ------------------------------- |
| Multiple codes per frame (`lots`)       | 100.0%    |                                 |
| Hard shadows (`shadows`)                | 89.5%     | local binarization              |
| Rotated (`rotations`)                   | 88.6%     |                                 |
| Small in a large frame (`close`)        | 92.9%     | multi-scale retry, both ways    |
| Ordinary photographs (`nominal`)        | 85.6%     | 250-image category, the largest |
| Even lighting (`brightness`)            | 82.1%     |                                 |
| Non-compliant symbols                   | 77.6%     |                                 |
| Motion blur (`blurred`)                 | 75.5%     | blur retry                      |
| Screens and monitors (`monitor`)        | 80.0%     | low-pass retry defeats moire    |
| Pathological / adversarial              | 69.2%     | missing quiet zone              |
| Curved surfaces (`curved`)              | 68.7%     | piecewise sampling              |
| Perspective / oblique angles            | 67.4%     | timing-pattern sizing           |
| Specular highlights (`bright_spots`)    | 72.7%     |                                 |
| Glare                                   | 64.3%     |                                 |
| Physically damaged                      | 58.3%     |                                 |
| **Very large symbols (`high_version`)** | **14.7%** | see below                       |

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

## What limits `damaged`, `glare` and `bright_spots`

Four hypotheses tested after the outline fit landed, none of which converted
images. Recorded because each looked well-founded and the measurements say
something specific about where these categories actually sit.

Failures break down by the stage that stops them:

| category       | failures | no version | format unreadable | format OK, still fails |
| -------------- | -------- | ---------- | ----------------- | ---------------------- |
| `damaged`      | 29       | 10         | 5                 | 14                     |
| `glare`        | 21       | 7          | 3                 | 11                     |
| `bright_spots` | 12       | 6          | 0                 | 6                      |

- **Alignment patterns as extra correspondences.** quirc anchors its fourth
  corner on a measured alignment pattern rather than an estimate, so adding
  every located alignment centre to the twelve finder-corner correspondences
  should tighten the fit further. It converts nothing: on the images that
  reach the refit, the outline fit alone already decodes them.
- **Erasures from saturation, and from ambiguity.** The decoder gained
  erasure support two rounds ago and it is still not the binding constraint.
  Saturation marks a median 2-21% of modules depending on category and gains
  0; ranking modules by distance from the local black/white midpoint and
  erasing the least confident 5-20% gains 1. Three detectors tried across two
  rounds, including an oracle blob, all confirm the same thing: the damage on
  these images is not a localised region over an otherwise-good grid.
- **Brute-forcing the format.** Format info is 15 bits with 32 legal values,
  so trying all of them is cheap and self-validating. It converts nothing,
  because both format copies failing is a _symptom_ of heavy damage rather
  than an independent gate — 30 BCH-protected bits in two well-separated
  corners do not both fail unless the damage is extensive.

The measurement that explains the residue is timing accuracy on grids that do
read a format: **`glare` 92%, `damaged` 65%, `bright_spots` 54%**. So
`damaged` and `bright_spots` are still registration failures wearing a damage
label, while `glare`'s best images are genuinely well-registered — four of
them sample the timing pattern at **98-100%** and still fail Reed-Solomon on
their single data block.

Those four are mostly **ecL**, the weakest error-correction level, which
tolerates about 7% of codewords. A perfect grid over a symbol whose encoder
chose minimum redundancy is simply past what the symbol can survive. Like
`high_version`, that is an error budget rather than a fixable stage.

### The best grid reachable, per failure

Sweeping every binarization, both finder detectors, both transforms and every
candidate size, and keeping the highest timing accuracy any of them produces:

| category       | failures | best grid >=90% | >=75% | median |
| -------------- | -------- | --------------- | ----- | ------ |
| `damaged`      | 29       | 10              | 13    | 70%    |
| `glare`        | 21       | 8               | 9     | 70%    |
| `bright_spots` | 12       | 3               | 3     | 57%    |
| `pathological` | 11       | 0               | 0     | **0%** |

Two distinct populations, and they need opposite things:

- **21 images already reach a >=90% grid** and still fail. The geometry is
  right; the modules are genuinely damaged past their error-correction
  budget. Four erasure detectors have now been tried on these across three
  rounds — saturation, ambiguity ranking, an oracle blob, and disagreement
  between independent binarizations — converting 0, 1, 0 and 1 image
  respectively. Erasures were the right theory for a failure mode this corpus
  does not contain in quantity: marking positions cannot help when the damage
  exceeds capacity however it is labelled.
- **`pathological` produces no grid at all** — median 0% means no
  combination of detector, binarization, transform and size lands on the
  symbol. Its failures are detection, not registration or correction, and it
  is the one category where a different _locator_ rather than a better fit is
  the honest next step.

Also checked and worth not re-deriving: pairing the centre-based transform
with the timing-derived size — the one combination the ladder never tries,
since timing sizing is only attempted with the outline fit — converts
**zero** images across every category.

## Soft-decision decoding, measured and rejected

The 87 failures that reach a >=90% grid look like the classic soft-decision
case: geometry solved, a handful of modules misread. The literature's answer
is **Chase decoding** — flip the least-reliable positions combinatorially and
re-run the ordinary decoder — and it is a genuinely different mechanism from
the erasures already tried. Erasures declare a position unknown and spend one
check symbol on it, so they are capacity-bound; Chase spends no capacity at
all and instead makes 2^eta attempts. US 9729171 describes exactly this for
barcodes: flip the low-confidence bits, decode again.

Implemented against the grey distance from the local threshold as the
reliability measure, it gains **3 images at eta = 10** (1024 test patterns per
grid) and **2 at eta = 6**. Sixteen times the work for one more image.

That is the diminishing return the complexity literature predicts —
"exponential in eta ... in practice relatively small values are used, and as a
result performance degrades" — and the structural reason is visible in the
numbers here: >=90% timing accuracy on a version 3 symbol still permits dozens
of wrong data modules, so no ten-bit flip pattern reaches a valid codeword.
Chase assumes a handful of errors; these images have many.

Rejected on cost: 3 images at 1024 decodes each, against the threshold
sweep's 12 at 8 passes each. The technique is correct and the measurement is
the argument against it, not the technique.

## Performance envelope

| case                       | cost                                              |
| -------------------------- | ------------------------------------------------- |
| Frame with no symbol       | 233ms at 720p — early exit skips the retry ladder |
| Symbol that decodes        | 11-32ms at 1024x768                               |
| Symbol that cannot be read | 193-224ms, bounded by `timeBudgetMs`              |

A frame of sensor grain is the worst case and was the worst defect: ~190
spurious finder candidates against 0-5 for an ordinary photograph, which cost
**3.8 seconds** unlimited. Three fixes took it to **2.6s** without changing
coverage — bounding the candidate dedup scan, which was accidentally quadratic
in candidate count; moving the refine coefficients off dictionary-mode
property access into a typed array; and skipping the deep search when the
candidate count is implausible. A camera in low light produces this frame, so
it is guarded by a test.

### Pipeline order

Rungs accumulated one at a time, each justified on its own, so the sequence was
measured as a whole. Instrumented across a third of the corpus, milliseconds
spent per image a rung alone recovered:

| rung         | ms/hit |     | rung        | ms/hit     |
| ------------ | ------ | --- | ----------- | ---------- |
| first pass   | 364    |     | shifted     | 4,359      |
| downscale x3 | 634    |     | sweep       | 6,049      |
| downscale x2 | 833    |     | deep search | 6,525      |
| rectify      | 1,534  |     | blur        | 12,549     |
|              |        |     | upscale     | **61,205** |

Two things came out of it, one of them negative.

**Reordering the rungs by that measure changed nothing** — 73.0% and 54.3%
before and after. At 120ms the budget is spent before the ladder reaches
anything past the first few rungs, so their order cannot matter; unlimited runs
all of them regardless. The ordering that affects coverage is at the FRONT.

**The early-exit gate was the real cost.** It ran two binarizations and two
finder scans on the full frame, twice — once sharp, once blurred — and a blur
on a 2.4MP frame is **77ms**, 64% of the whole budget, before a single retry.
The recorded figure justifying that placement was 28ms, measured on a 1024x768
frame; cost scales with pixels and the corpus runs at 1600px.

Running the gate on a half-size copy quarters all of it. That alone lost one
image, so the full-resolution check is kept as a fallback that only runs to
overturn a rejection: an empty frame — the case the gate exists for — pays only
the cheap pass. Corpus 73.0% -> 73.1%, budgeted 54.3% -> 54.5%, unlimited
runtime 111s -> 102s.

Reductions and blurs are now memoised across the ladder, since the gate and the
downscale rung both want half size and the blurred gate and the blur rung both
want the same radius. Built lazily, because most frames never reach the rungs
that need them.

### Ordering from first principles

Cost scheduling is only one of the properties that constrain order. Two others
turned out to be worth coverage, and neither is about speed at all.

**A lossy step should run as late as possible.** Thresholding is the most
destructive operation in the pipeline — eight bits to one — and morphological
closing was running _after_ it. On a binarized matrix a speckle can only take
its neighbours' bit; on the greyscale image it is filled with their
intensities. Moving the operation to the other side of the threshold recovers
`glare` +5 with `damaged`, `monitor` and `bright_spots` each gaining. A
specular highlight is the clearest case: its edges are graded in grey and
hard-clipped after thresholding.

**Order determines which states are reachable, not just how fast they arrive.**
Every rung applied exactly one transform to the original image, so a frame with
two independent faults — small in frame AND moire — had no rung addressing
both. Composing pairs recovers images no single transform does, and the order
_within_ a pair is not arbitrary: downscale-then-blur recovers 5 where
blur-then-downscale recovers 3, because a box-average reduction already
smooths and blurring first over-softens what the reduction would have handled.

Together: **73.3% -> 74.4%**, with `monitor` 72.0% -> 80.0%, `bright_spots`
66.7% -> 72.7%, `damaged` 54.2% -> 58.3% and `glare` 62.5% -> 64.3%. Unlimited
runtime rises 105s -> 156s; the 120ms budgeted rate is unchanged at 54.6%,
because the budget clips every one of these rungs on a live frame. Only a
still pays for them.

### Three workloads, three different hot spots

No public QR _video_ corpus exists — the available datasets are all still
images (Roboflow's 1,547, a merged 8,748-image set), and the video research is
deblurring work with no barcode content. So the workloads are synthesised, and
which one is used decides what the profiler shows:

| workload             | hottest function     | share of JS |
| -------------------- | -------------------- | ----------- |
| still (`decode`)     | `scoreTransform`     | 27%         |
| empty (`noise`)      | candidate dedup scan | quadratic   |
| viewfinder (`video`) | `findFinderBlobs`    | 22%         |

None of the three appears near the top for the others. `findFinderBlobs` in
particular rarely fires on a still or an empty frame, so two of the three
benchmarks hid it completely.

Fixes measured from the viewfinder profile, none of which changed coverage:

- **The blob flood's inner loop.** A division and a modulo per popped pixel to
  recover coordinates from an index, plus a four-element array of pairs
  allocated to iterate the neighbours. On a blob of tens of thousands of
  pixels that is the whole cost — worst pass **75ms -> 22ms**.
- **The denoise closing's allocation.** Four full-size buffers per call, 3.7MB
  on a 1280x720 frame, on half of every rung's passes. The four sweeps
  ping-pong, so two suffice.

Unlimited corpus runtime **176s -> 136s** across the two.

### The time budget does not bound the time

`timeBudgetMs` is checked between ladder rungs, so it bounds how much work is
STARTED and not how long a decode runs. Measured on 1280x720 frames at a 120ms
budget:

|     | median | p90   | max    | over budget |
| --- | ------ | ----- | ------ | ----------- |
|     | 190ms  | 562ms | 1526ms | 40 of 71    |

One `attempt` is four binarization passes across two polarities, each a full
binarize, scan and sample, and the ladder calls `attempt` a dozen times. None
of that is interruptible.

**Enforcing it properly was measured and rejected.** Checking the deadline
inside the pass loop halves the p90 (562ms -> 256ms) and cuts the median by
30%, but costs **6 points** of budgeted coverage — 54.3% to 48.3% — because it
aborts work mid-flight that would have succeeded slightly late. More budget
does not buy it back: enforced at 250ms it reaches 51.3%, still below the
unenforced 120ms figure. The max also stays at 1237ms, so the worst case is
not actually bounded by it.

So the overshoot stands as a known defect rather than a fixed one, and the
budgeted rates in this document are what a decoder achieves while overrunning
its budget by about 58% at the median. A caller who needs a hard bound should
run the decoder in a worker, where `createWorkerScanner` already keeps the
main thread free regardless of how long a frame takes.

This also corrects an earlier conclusion here. Reordering rungs and runtime
planning were both explained as "the budget is spent in the first few rungs,
so later rungs never run". That was wrong: the budget is not spent, it is
exceeded, and the later rungs do run. Both remain no-ops, but not for the
reason given.

### Profiling under viewfinder load

`bench/video.mjs` profiles the case a scanner is actually in — a symbol
present, a budget enforced, frame after frame with a pixel of jitter between
them — as distinct from the still (`bench/decode.mjs`) and empty
(`bench/noise.mjs`) cases.

It surfaces a hot spot the others hide. `findFinderBlobs` is the **single
hottest function at 22% of JS time** under this load, where it does not reach
the top three for either of the others. It is worth 2 corpus images and 12% of
frame time. Gating it on the deadline was tried and collapsed the budgeted
rate to 48.3%, for the same reason as above: by the time the check runs, the
budget is usually already exceeded.

### Runtime planning, measured and rejected

The ladder is a fixed sequence run blindly, and several rungs answer conditions
that are cheap to measure. The finder scan already reports a module size per
candidate, and that one number separates the categories whose fix is scaling
from those whose is not — median pixels per module: `monitor` 1.7, `close` 3.3,
`nominal` 6.5, `high_version` 8.5, `blurred` 9.5, `damaged` 18.7. `monitor`
sits below the 3-3.5 the sampling literature gives as the practical floor,
which is exactly why enlarging rescues it.

So a plan was built: measure once, skip the scaling rungs the measurement rules
out, cache it across frames in the progressive scanner since a scene does not
change between them, and invalidate on `reset()`.

It buys **nothing**. On stills it is 3% _slower_, because skipping a rung saves
only that rung while the measurement is paid on every frame. Under video-shaped
load — 116 scenes, 15 frames each, 120ms budget, measurement amortised — it
reads the same 55 scenes in the same time to within 0%.

The reason is the same one that made reordering the rungs a no-op: at 120ms the
budget is spent in the first few rungs, so ruling out rungs 6 through 10 saves
time that was never going to be spent. A plan can only pay where the ladder
runs deep, and the ladder only runs deep when there is no budget to save.

Reverted. Recorded because the heuristic is sound and the measurement is the
argument against it, not the idea.

### Narrow before you enlarge

The upscale rung measured 61,205ms per image recovered, which looked like a
case for GPU offload. Splitting the number apart says otherwise: the enlarging
itself is **18ms** and the other **227ms** is the rest of the pipeline running
at quadruple pixel count. Accelerating the transform would address 7% of the
cost.

What the rung actually needs is the SYMBOL enlarged, not the frame. A symbol's
finder bounding box covers a median **13%** of the image it sits in, so
cropping first cuts the pipeline proportionally — and it improves accuracy as
well as speed, because a cropped region binarizes against its own contrast
instead of a threshold surface stretched over irrelevant background. Corpus
73.1% -> 73.3%.

Cropped per **triple**, not around all candidates. A frame holding several
codes has candidates spread across it: measured on `lots`, their combined box
spans a median 62% of the frame while any single symbol's spans effectively
none. Boxing them together would defeat the saving and merge distinct symbols
into a region belonging to neither. `rectifySymbol` was already correct here —
it samples one symbol into its own canvas rather than warping the frame — and
both stages now share one cheap "where is a code" pass instead of binarizing
and scanning independently.

### GPU offload, reconsidered

`gpu.ts` records that binarize, blur and downscale are "far too small to
survive the cost of uploading a buffer, dispatching a shader and reading the
result back", measured at 16/28/6ms on a 1024x768 frame. At the 1600px the
corpus runs, blur was **57ms** — the one image operation whose kernel dominated
its own pipeline, and a genuine candidate.

Rewriting it with running sums took it to **19.9ms** instead. Summing the whole
window at each pixel is O(radius) per pixel per axis; adding the entering
sample and subtracting the leaving one is O(1) at any radius. That is a larger
saving than offloading a 57ms kernel could return once upload and readback are
paid, and it needs no availability check.

The corner search remains the one stage whose shape suits a GPU — 625
independent scorings of the same image — and that is what `gpu.ts` targets.

### Cost per attempt is not cost per recovery

Every attempt runs four binarization combinations. Measured, they recover
107 / 13 / 3 / 2 images at 646 / 4949 / 7729 / 15124 ms per recovery, so
plain/local is four fifths of all successes at an eighth the cost of the next.

Reordering the other three by that same ranking — denoise/local ahead of
plain/global — **cost two images** at 120ms. Under a budget what matters is
what an attempt costs, not what it eventually yields: a global binarization is
14ms against denoising's 35ms, so it earns the earlier slot even though it wins
less often. Ranking by yield spends the budget before the cheap pass gets a
turn.

`timeBudgetMs` defaults to 120ms. It is a blunt instrument: the full corpus
reads **62.7% unlimited against 40.3% at 120ms**, and the curve is still
climbing at 700ms. Set `0` for stills. For a live camera the answer is
`createProgressiveScanner`, which spends a small budget per frame and advances
through the ladder across successive frames.

Both figures are worth re-measuring rather than quoting: the ladder changes
often, and comparing a fresh number against a stale one in this document has
twice manufactured a regression that did not exist.
