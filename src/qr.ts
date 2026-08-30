/**
 * QR rendering for the device screen.
 *
 * A thin, opinionated wrapper over `etiket` — the defaults here exist because
 * this QR is scanned off a TV from across a room, which is a harsher case than
 * the usual on-screen QR.
 */

import { qrcode } from "etiket";

export interface DeviceQrOptions {
  /** Rendered edge length in px. Large by default: TVs are viewed from far away. */
  size?: number;
  /**
   * Error-correction level. Defaults to `M`.
   *
   * NOT `H`, despite the instinct to max it out. Higher correction adds modules
   * to encode the same URL, so at a fixed pixel size each module gets smaller —
   * on a 1080p panel viewed from 3m, denser modules hurt scan rate more than
   * damage-tolerance helps. A TV screen is clean and unscuffed; `M` is the
   * right trade. Raise it only if you overlay a logo.
   */
  ecLevel?: `L` | `M` | `Q` | `H`;
  /** Foreground. Must stay dark-on-light for reliable scanning. */
  color?: string;
  /**
   * Background. Keep it opaque and light.
   *
   * Do not make this transparent to sit the QR on a dark or photographic
   * backdrop — scanners need the quiet zone to contrast with the modules.
   *
   * Inverting (light modules on a dark ground, as Plex does) is a constraint
   * on READERS, and is not a contrast question — an inverted symbol can sit
   * at 10:1 and still be unreadable. Many decoders binarize assuming dark
   * modules on a light ground and never try the opposite: jsQR, the engine
   * behind qr-scanner, defaults its live camera path to `dontInvert`, so an
   * inverted symbol decodes as nothing at all while the camera looks
   * perfectly healthy. Apple's detector tries both, so the iOS camera reads
   * what your own scanner cannot — which makes this look like a broken
   * scanner rather than a polarity mismatch.
   *
   * So invert deliberately, not by accident: it is fine when you control the
   * readers and have configured them for it (see `setInversionMode`), and a
   * silent failure when you have not.
   */
  background?: string;
  /** Quiet-zone width in modules. The spec minimum is 4; do not go below it. */
  margin?: number;
}

/**
 * Render `verification_uri_complete` as an SVG string.
 *
 * SVG rather than PNG so it scales to any panel without resampling, and so it
 * can be inlined into the page with no extra request — which matters on a Fire
 * TV / Pi-class device where every fetch is expensive.
 */
export const renderDeviceQr = (
  verificationUriComplete: string,
  {
    size = 512,
    ecLevel = `M`,
    color = `#000000`,
    background = `#ffffff`,
    margin = 4
  }: DeviceQrOptions = {}
): string =>
  qrcode(verificationUriComplete, {
    size,
    ecLevel,
    color,
    background,
    margin
  });
