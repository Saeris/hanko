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
