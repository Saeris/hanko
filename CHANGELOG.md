# Changelog

## 0.2.0
<sub>2026-09-02</sub>

- Add a zero-dependency QR decoder, and scan with it.
  The library previously delegated scanning to a third-party dependency. It now
  ships its own decoder: pixels in, string out, no camera and no DOM, so the same
  code runs in a browser, on a worker, on a server, or in a test.
  Recognition is measured against the 718-image BoofCV benchmark, where it reads
  **74.4%**. Published results on the same corpus are BoofCV 60.69%, ZBar 38.95%,
  ZXing 31.87% and jsQR 24.8%.
  - `@saeris/hanko/scan` — `createQrDecoder` for a synchronous decode, and
    `createProgressiveScanner` for a camera, which spreads the retry ladder
    across frames rather than cramming it into one.
  - `@saeris/hanko/scan/worker` — `serveDecoder`, to run a decode off the main
    thread. A viewfinder needs this: the ladder deliberately outruns its own time
    budget, so a synchronous decode stalls the preview on exactly the frames
    someone is lining up.
  Reed-Solomon correction also accepts erasures — damage whose position is known
  but whose value is not — which is worth double the capacity when the imaging
  layer can say where the damage is.
