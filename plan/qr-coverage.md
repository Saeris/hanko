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
| Module size           | 2px and up                                     | 1px/module fails                                  |
| Quiet zone            | 0 modules and up                               | no minimum needed — better than the spec requires |
| Polarity              | both                                           | dark-on-light and light-on-dark                   |
| Rotation              | 0-35 deg, 60-90 deg, and every 90 deg multiple | **45 deg still fails**                            |
| Blur                  | up to sigma 4                                  | sigma 8 fails                                     |
| Version at 4px/module | 10 through 40                                  |                                                   |

## Real-photograph coverage

The 718-image BoofCV benchmark, which is photographs rather than renders.
Overall **51.5%**, against jsQR's 24.8% and ZXing's published 31.87% on the
same images.

| condition                               | rate     | what is known                   |
| --------------------------------------- | -------- | ------------------------------- |
| Even lighting (`brightness`)            | 89.3%    |                                 |
| Multiple codes per frame (`lots`)       | 87.5%    |                                 |
| Hard shadows (`shadows`)                | 73.7%    | local binarization              |
| Specular highlights (`bright_spots`)    | 66.7%    |                                 |
| Non-compliant symbols                   | 65.7%    |                                 |
| Ordinary photographs (`nominal`)        | 65.6%    |                                 |
| Motion blur (`blurred`)                 | 64.2%    | blur retry                      |
| Curved surfaces (`curved`)              | 61.2%    | piecewise sampling              |
| Rotated (`rotations`)                   | 50.0%    |                                 |
| Screens and monitors (`monitor`)        | 48.0%    | low-pass retry defeats moire    |
| Pathological / adversarial              | 42.3%    |                                 |
| Small in a large frame (`close`)        | 38.1%    | multi-scale retry               |
| Glare                                   | 35.7%    |                                 |
| Perspective / oblique angles            | 16.3%    | corner search helps, not solved |
| Physically damaged                      | 27.1%    |                                 |
| **Very large symbols (`high_version`)** | **2.9%** | see below                       |

## Known gaps, in order of what is worth fixing

1. **`high_version` (2.9%)** — versions 25 and 40 photographed flat-on and
   well-lit. Not a difficulty category: the images are easy, the symbols are
   enormous (177x177 modules, 3706 codewords, 49 error-correction blocks).
   The surface sags non-linearly between the finders — timing accuracy runs
   100% at both ends and 0% in the middle — but correcting that is
   demonstrably not sufficient: a grid with 100% timing accuracy still
   repairs zero of 49 blocks under all 32 mask/EC combinations. Six
   hypotheses tested and disproved. The geometric search space is exhausted.

2. **`perspective` (16.3%)** — oblique angles. Supplying a known-good fourth
   corner takes it from 2 of 23 images to 7, so the information is
   recoverable; the corner search reaches some of that and not all.

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

`timeBudgetMs` defaults to 120ms. It is a blunt instrument: recognition on a
sampled set runs 21 of 72 at 120ms against 44 of 72 unlimited, and the curve
is still climbing at 700ms. Set `0` for stills. The right shape for a live
camera is progressive — cheap rungs every frame, expensive ones spread across
successive frames — which is not yet built.
