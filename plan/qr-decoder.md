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
| **this decoder**                  | **27.9%** |
| ZXing (published)                 | 31.87%    |
| ZBar (published)                  | 38.95%    |
| BoofCV (published)                | 60.69%    |

Per category, and what each number is telling us:

| category     | rate  | note                             |
| ------------ | ----- | -------------------------------- |
| lots         | 87.5% |                                  |
| shadows      | 63.2% | local binarization               |
| brightness   | 50.0% | was 0% before local binarization |
| pathological | 42.3% |                                  |
| rotations    | 36.4% | was 2.3% before triple scoring   |
| bright_spots | 36.4% |                                  |
| nominal      | 34.4% |                                  |
| noncompliant | 32.8% |                                  |
| close        | 28.6% | was 4.8% before the blur retry   |
| curved       | 28.4% |                                  |
| blurred      | 26.4% |                                  |
| monitor      | 20.0% | was 0% before the blur retry     |
| damaged      | 14.6% |                                  |
| perspective  | 9.3%  |                                  |
| glare        | 3.6%  |                                  |
| high_version | 0.0%  | see below                        |

### What is known about the remaining failures

**`high_version` (0%)** — extensively diagnosed, still unsolved. Four
hypotheses have been tested and disproved, which is worth recording in full
because each looked obviously correct beforehand.

What is definitely RIGHT on `image003` (a version 40, 177-module symbol):
the sampled grid reproduces the top-left finder **49/49 modules**, format and
version read cleanly (v40, ecLevel M, mask 3), the data region yields exactly
3706 codewords in exactly 49 blocks — every structural number the spec
predicts. What is wrong: **all 49 blocks are beyond Reed-Solomon repair.**

Disproved:

1. *Wrong grid size.* Every neighbouring size (±12 modules) was tried; none
   decode.
2. *Fourth corner misplaced.* A 7x7 search over corner positions, scored by
   how well the sampled timing pattern alternates, recovered nothing.
3. *Cumulative perspective drift.* Measuring predicted against actual module
   boundaries along the timing row shows drift that OSCILLATES (-0.59, +0.44,
   -0.31, +0.52, +0.34, +0.02 modules) rather than accumulating. Perspective
   error would grow smoothly in one direction.
4. *Sub-pixel sampling jitter.* Majority-vote sampling at radius 0, 1 and 2
   makes no difference at all — 0/12 in every case.

Structure perfect, content noise, error distributed across every block rather
than concentrated.

### What comparing against a working decoder established

`zxing-wasm` decodes `image003` and reports its corner positions, which makes
it a ground-truth oracle for every geometric stage. Diffing against it:

- **Our finder location is correct.** Finder-centre distance 1140px against
  ZXing's implied 1140px; module size 6.72 against 6.71; size 176.6 -> 177,
  version 40. Every one of those matches.
- **Our fourth-corner estimate is badly wrong**: ours (1312, 1458) against
  ZXing's (1377, 1456) — about 13 modules out. The parallelogram assumption
  fails hard on this symbol, and the earlier +/-3-module corner search was
  simply too small a window to find it. Hypothesis 2 above was under-tested
  rather than disproved.
- **Fixing the corner is still not sufficient.** Sampling with ZXing's corner
  gives a provably correct grid — all three finders 49/49 modules, horizontal
  timing 1.00, vertical timing 0.98, alignment pattern 22/25, format and
  version reading cleanly — and decoding STILL fails, with every block
  reporting a Reed-Solomon locator at its maximum degree of 14. The modules
  are saturated with errors even though the grid is right.
- **`decodeMatrix` itself is not the problem.** Pure matrix round trips
  against etiket succeed at every version up to 38 with no imaging involved.

So there are two independent faults, and only the first is understood. The
second shows up only on photographed large symbols: geometry verifiably
correct, module values substantially wrong. The next thing to try is dumping
our sampled matrix beside one reconstructed from ZXing's own decode and
diffing module by module, which would say WHERE the wrong modules are rather
than how many.

**`glare` (3.6%)** and **`perspective` (9.3%)** are untouched so far.

### Negative results, recorded so they are not re-attempted

- **Majority-vote sampling** over each module's central region (the
  robust-geometric-transform idea from the barcode literature) made things
  **worse**: 22.8% down to 21.7%. At this corpus's module sizes, a
  neighbourhood wide enough to outvote sub-pixel drift is also wide enough to
  reach the adjacent module.
- **Blur as a default preprocessing pass** is a trade, not a win: it takes
  `blurred` from 5/14 to 1/14 and `nominal` from 3/14 to 0/14. It is correct
  only as a retry after a sharp pass fails.

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
