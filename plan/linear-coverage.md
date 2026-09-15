# What the linear decoder supports

The same split as `qr-coverage.md`, for the same reason. **Symbology
coverage** is which barcode families the decoder can represent at all.
**Imaging coverage** is the conditions under which a photograph of one
actually decodes. A gap in the first is a missing feature; a gap in the
second is a robustness problem, and they are fixed by different work.

One difference from QR matters more than any other here, and most of the
design follows from it: **a linear barcode has no error correction.** A QR
symbol carries Reed-Solomon, so it either reconstructs or it does not, and a
wrong read is essentially impossible. These have a single check digit, which
one wrong reading in ten passes by chance. The failure this decoder is built
to avoid is therefore not "no result" — it is a confident wrong number, which
sends a caller to look up a product that does not exist.

## Symbology coverage

| family      | status            | notes                                        |
| ----------- | ----------------- | -------------------------------------------- |
| EAN-13      | full              | includes JAN, ISBN (978/979), ISSN (977)     |
| UPC-A       | full              | reported as 12 digits, padded to 13 to match |
| EAN-8       | full              | double agreement required                    |
| UPC-E       | full              | **opt in**; expanded to the GTIN-12 it means |
| Code 128    | **not supported** | see "The gap field testing found"            |
| ITF-14      | **not supported** | see below                                    |
| GS1 DataBar | **not supported** | see below                                    |
| Code 39     | **not supported** | see below                                    |

### Why UPC-E is off by default

A measurement, not a preference. Six digits plus a parity pattern is thin
evidence, and a UPC-E's 35 runs fit **inside** a full EAN-13's 59 — so it can
match a fragment of a longer symbol. Enabled by default it produced 14 false
positives on a corpus containing no UPC-E at all, which was every misread in
that run. Tried last and given double agreement it produced one. Asked for
explicitly, none of them are anyone's surprise.

The parity of its six digits encodes the **check** digit, the inverse of
EAN-13 where it encodes the first. Reusing the EAN path would not have
failed — it would have produced a plausible wrong number.

## Imaging coverage

Measured against the ArTe-Lab Medium 1D corpus (430 images, CC BY 3.0), split
by whether the camera had autofocus. `yarn corpus:barcodes` fetches it;
`node bench/barcodes.mjs` scores it.

| subset            | images | correct   | misread |
| ----------------- | ------ | --------- | ------- |
| With autofocus    | 215    | **91.6%** | 0       |
| Without autofocus | 215    | **26.5%** | 0       |
| Total             | 430    | **59.1%** | 1       |

The no-autofocus half is the honest number for a phone in a shop, and it is
the half worth working on. The gap between 91.6% and 26.5% is almost entirely
defocus blur.

### The one misread

`Dataset1/PICT00daw23.JPG` reads `3434730701253` against an expected
`3434730707835`. The first eight digits match, so the left half read
correctly and the right half did not — and the wrong result still passed its
check digit, which is precisely the one-in-ten case. Pre-existing, not from
the UPC-E work. Recorded rather than tuned away, because tuning against a
single corpus image is how a decoder gets fitted to its benchmark.

## The gap field testing found

Field use surfaced what a corpus could not: **retail packaging often cannot
fit an EAN-13**, and reaches for a smaller symbology. This is the single
largest remaining coverage gap, and the corpus above cannot see it — the
ArTe-Lab images are all EAN-13, so the benchmark scores 100% on a decoder
that handles none of these.

In rough order of value for a product-identification path:

- **GS1 DataBar** (Omnidirectional, Stacked, Expanded). Designed for exactly
  this constraint — small consumer items — and mandatory on US coupons. The
  highest-value addition.
- **Code 128** / **GS1-128**. Variable length, very common on cartons and
  shipping labels, and carries application identifiers rather than a bare
  GTIN.
- **ITF-14** for shipping cases; simple to add once run extraction is shared.
- **Code 39**, older and lower density, still found on library and asset tags.

**The expensive parts are already built and are format-agnostic.** The
binarizer ladder, row sweeping, transposition for sideways symbols, column
averaging for defocus, and agreement voting all live in
`src/scan/linear/decoder.ts` and know nothing about EAN. A new symbology is a
pattern table plus a decode function in the shape of `decodeRow`, reusing
every rung.

Two cautions carry over. Variable-length formats like Code 128 have **no
fixed run count** to sanity-check against, so the guard that keeps UPC-E
honest does not exist for them — expect to lean harder on agreement. And
every format added widens the surface for a fragment of one symbology to
match inside another, which is the mechanism behind every misread this
decoder has ever produced.

## Known defect: the time budget is not enforced mid-pass

`timeBudgetMs` is checked **between** rungs of the ladder, not inside one, so
a 120ms budget yields roughly a 190ms median and a 1526ms worst case. It
bounds how many passes are attempted, not how long one takes.

Enforcing it properly cost 6 points of recognition, so it is documented
rather than fixed. A caller that needs a hard bound should run the decoder in
a worker, where the deadline can be enforced by not waiting for it — which is
what `examples/astro` does, and why it passes `timeBudgetMs: 0`.
