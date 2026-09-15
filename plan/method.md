# How the coverage work was actually done

The QR decoder went from 62.1% to 74.4% on the BoofCV corpus, and the linear
decoder from 48.6% to 59.1% on ArTe-Lab, over a long series of small changes.
The process that produced those numbers is worth recording, because the
numbers are not reproducible without it and the next person to pick this up
will otherwise rediscover it slowly.

## The loop

1. **Form a hypothesis** about what is failing, from the corpus, not intuition.
2. **Research it before writing code** — at least three sources, ideally one
   that disagrees with the hypothesis. How ZXing, ZBar, BoofCV and jsQR handle
   the same case is public, and reading them first repeatedly turned a guessed
   fix into a known one.
3. **Implement the smallest version** that tests the idea.
4. **Measure against the whole corpus**, not the image that prompted it.
5. **Keep it only if the number moves.** Several correct, well-researched
   changes measured as worthless and were reverted.

Step 2 is the one that is tempting to skip and the one that paid. Step 5 is
the one that hurts.

## The lesson that recurred most

**A fix aimed at a non-binding constraint measures as worthless even when it
is correct.**

Sizing a symbol from its timing pattern was implemented, measured at zero
improvement, and nearly reverted. It was worth 8 images — but only after
registration was fixed separately, because until then the symbol was located
too poorly for its size to matter. Two correct changes, each worth nothing
alone.

The practical consequence: when a well-researched change measures flat, the
question is not only "is it wrong" but "is something upstream masking it".

## Benchmarks measure what they contain

Three separate cases of this, all worth remembering:

- The ArTe-Lab corpus is entirely EAN-13, so it scores 100% on a decoder that
  supports no small-format symbology at all. Field use found that gap
  immediately. **A corpus cannot report a format it does not contain.**
- Transposing for sideways symbols measured at 2 points on the focused half
  and nothing on the blurry one, which _understates_ it: those photographs
  were taken to be a barcode dataset, so they are almost all upright. A phone
  in a shop is not so tidy.
- A grain test once asserted 6500ms inside Vitest's default 5000ms timeout, so
  it could only ever fail.

## Profiling

Hot spots were workload-dependent, and profiling a single synthetic input
would have optimised the wrong function. `bench/noise.mjs`, `bench/video.mjs`
and `bench/barcodes.mjs` exist because they have **three different hot
spots**; deoptkit was run against each rather than against one representative
case.

The largest single win was rewriting `blur` with running sums (57ms to
19.9ms) — an algorithmic change found by profiling, not a micro-optimisation.

## What "done" means here

Zero misreads is the standard for the linear decoder, and it is a stricter
standard than recognition rate. A missed barcode is a retry; a wrong barcode
is a caller looking up a product that does not exist. Where the two trade
against each other, correctness wins — which is why UPC-E is opt-in and why
the one remaining misread is documented in `linear-coverage.md` rather than
tuned away against its single corpus image.
