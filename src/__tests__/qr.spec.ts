import { describe, expect, it } from "vitest";
import { renderDeviceQr } from "../qr.js";

describe(`renderDeviceQr`, () => {
  const url = `https://example.com/link?user_code=WDJB`;

  it(`renders dark modules on a light ground by default`, () => {
    // WHY: polarity is a hard constraint on readers, not a contrast
    // preference. jsQR — the engine behind qr-scanner — binarizes assuming
    // dark-on-light and, on its live camera path, does not try the opposite
    // unless told to. A default that shipped inverted would decode as nothing
    // at all on any reader using that default, while looking perfectly
    // healthy: camera running, frames arriving, no result ever.
    //
    // Inverting is still supported and is a legitimate choice — but it has to
    // be asked for, so that whoever asks also configures their scanner.
    const svg = renderDeviceQr(url);

    expect(svg).toContain(`fill="#ffffff"`);
    expect(svg).toContain(`#000000`);
  });

  it(`keeps the quiet zone at the spec minimum`, () => {
    // WHY: the quiet zone is part of the symbol, not padding around it. A QR
    // read off a TV across a room loses scan rate fast without it, and the
    // failure looks like "the camera is bad" rather than "the margin is thin".
    const svg = renderDeviceQr(url, { size: 330 });

    // Derived from the path itself rather than assuming a symbol version:
    // the first module's x is the inset, and `h<n>` is one module's width, so
    // their ratio is the quiet zone in modules regardless of how much data
    // the URL encodes.
    const firstX = /d="M([\d.]+),/u.exec(svg)?.[1];
    const pitch = /h([\d.]+)v/u.exec(svg)?.[1];
    expect(firstX).toBeDefined();
    expect(pitch).toBeDefined();

    expect(Number(firstX) / Number(pitch)).toBeCloseTo(4, 2);
  });

  it(`honours an explicit inversion`, () => {
    // WHY: the device screen renders Plex-style light-on-dark deliberately,
    // paired with `setInversionMode('both')` on the approving page. The two
    // are load-bearing together — this pins the rendering half so a change
    // here cannot silently break a scanner configured for it.
    const svg = renderDeviceQr(url, {
      color: `#f0b429`,
      background: `#160c1e`
    });

    expect(svg).toContain(`fill="#160c1e"`);
    expect(svg).toContain(`#f0b429`);
  });
});
