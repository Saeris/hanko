/**
 * App-opening for scanned QR codes.
 *
 * The goal: one QR payload that opens a native app when it is installed, and a
 * web page when it is not — without the device ever showing an error.
 *
 * That rules out custom schemes as the primary target. A `myapp://` QR read by
 * the OS camera on a phone without the app fails silently and
 * unrecoverably — the user sees "cannot open" and has nowhere to go. Universal
 * Links (iOS) and App Links (Android) solve this by making the payload an
 * ordinary `https://` URL that the OS *routes* to the app when the domain and
 * app are associated, and to the browser when they are not.
 *
 * So the QR keeps encoding `verification_uri_complete` exactly as before. The
 * routing lives in association files served from the same origin, not in a
 * different payload. What this module provides is the association files, the
 * URL parsing on the receiving end, and a custom-scheme fallback for the cases
 * that genuinely need one.
 */

/** Where an inbound approval link came from. */
export type LinkSource =
  /** A Universal Link / App Link that opened the native app. */
  | `app-link`
  /** A custom scheme (`myapp://`). Only reached when explicitly used. */
  | `custom-scheme`
  /** An ordinary web navigation — the app was not installed, or this is a PWA. */
  | `web`;

export interface ParsedApprovalLink {
  userCode: string;
  source: LinkSource;
  /** The full URL, for logging or to hand to a router. */
  href: string;
}

export interface LinkConfig {
  /**
   * Origin serving the approval page, e.g. `https://example.com`.
   * Must be HTTPS: both Apple and Google refuse to associate a plain-HTTP domain.
   */
  origin: string;
  /** Path of the approval page. Also the path the association files claim. */
  path?: string;
  /** Query parameter carrying the code. */
  codeParam?: string;
  /**
   * Custom scheme, e.g. `beerjournal`. Optional and NOT the primary path.
   *
   * Worth registering anyway: it is the only way to reach the app from
   * contexts that refuse to follow universal links — some in-app browsers, and
   * a few QR readers that strip them.
   */
  scheme?: string;
}

/**
 * Build the URL a QR should encode.
 *
 * Deliberately an `https://` URL rather than a scheme: this is the same string
 * `verification_uri_complete` already carries, which is what lets one QR serve
 * a phone with the app, a phone without it, and a laptop.
 */
export const buildApprovalUrl = (
  userCode: string,
  { origin, path = `/link`, codeParam = `user_code` }: LinkConfig
): string => {
  const url = new URL(path, origin);
  url.searchParams.set(codeParam, userCode);
  return url.toString();
};

/**
 * Build the custom-scheme equivalent.
 *
 * For a "Open in app" button on the web fallback page — a deliberate tap, where
 * a failure is recoverable because the user is already looking at a working web
 * page. Never for the QR itself.
 */
export const buildAppSchemeUrl = (
  userCode: string,
  { scheme, path = `/link`, codeParam = `user_code` }: LinkConfig
): string => {
  if (scheme === undefined) throw new Error(`no custom scheme configured`);
  const url = new URL(`${scheme}://${path.replace(/^\//u, ``)}`);
  url.searchParams.set(codeParam, userCode);
  return url.toString();
};

/**
 * Parse an inbound link, however it arrived.
 *
 * One entry point for every route into the approval screen: an Expo
 * `Linking.getInitialURL()`, a PWA `launchQueue` target, or `location.href`.
 * Returning the `source` lets a host tell "the OS routed this to us" from "the
 * user is on the web page", which changes what the UI should offer.
 */
export const parseApprovalLink = (
  href: string,
  { codeParam = `user_code`, scheme }: Partial<LinkConfig> = {}
): ParsedApprovalLink | null => {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  const isCustomScheme = scheme !== undefined && url.protocol === `${scheme}:`;
  if (
    !isCustomScheme &&
    url.protocol !== `https:` &&
    url.protocol !== `http:`
  ) {
    return null;
  }

  const userCode =
    url.searchParams.get(codeParam) ??
    // Path-style links (`/link/WDJB-MJHT`) are a common route design, and a
    // custom-scheme URL often has the code as its only path segment.
    url.pathname.split(`/`).filter(Boolean).pop();

  if (userCode === undefined || userCode.length === 0) return null;

  return {
    userCode,
    href,
    source: isCustomScheme ? `custom-scheme` : `web`
  };
};

/**
 * Apple App Site Association, for `/.well-known/apple-app-site-association`.
 *
 * Serve as `application/json` over HTTPS with **no redirects** — Apple fetches
 * it directly and a redirect makes the association fail silently, which is the
 * single most common reason universal links "just don't work".
 *
 * @param appIds `<TEAM_ID>.<BUNDLE_ID>`, e.g. `QQ57RJ5UTD.gg.saeris.beerjournal`
 */
export const appleAppSiteAssociation = (
  appIds: string[],
  { paths = [`/link`, `/link/*`] }: { paths?: string[] } = {}
): object => ({
  applinks: {
    // Required by the schema and must stay empty — Apple deprecated its use.
    apps: [],
    details: appIds.map((appID) => ({ appID, paths }))
  }
});

/**
 * Digital Asset Links, for `/.well-known/assetlinks.json`.
 *
 * @param fingerprints SHA-256 of the app's SIGNING certificate. Note that Play
 *   App Signing re-signs the upload, so the fingerprint that works in
 *   production is the one from the Play Console — not your local keystore. A
 *   local-only fingerprint is why app links commonly work in debug and break
 *   after release.
 */
export const digitalAssetLinks = (
  packageName: string,
  fingerprints: string[]
): object[] => [
  {
    relation: [`delegate_permission/common.handle_all_urls`],
    target: {
      namespace: `android_app`,
      package_name: packageName,
      sha256_cert_fingerprints: fingerprints
    }
  }
];

/**
 * Expo app config fragment for universal/app links.
 *
 * Merge into `app.json`. Requires a development or production build — the
 * entitlement is registered at build time, so **universal links do not work in
 * Expo Go**, and a project pinned to Expo Go must use the web fallback until it
 * moves to dev builds.
 */
export const expoLinkingConfig = ({
  origin,
  path = `/link`,
  scheme
}: LinkConfig): object => {
  const { host } = new URL(origin);
  return {
    // Custom scheme, for the deliberate "open in app" tap.
    ...(scheme === undefined ? {} : { scheme }),
    ios: {
      // No protocol, per Apple's format — including `https://` here is a
      // silent misconfiguration.
      associatedDomains: [`applinks:${host}`]
    },
    android: {
      intentFilters: [
        {
          action: `VIEW`,
          // `autoVerify` is what makes Android check assetlinks.json and open
          // the app WITHOUT a chooser dialog. Without it the user gets a
          // "open with" prompt every time, which reads as broken.
          autoVerify: true,
          data: [{ scheme: `https`, host, pathPrefix: path }],
          category: [`BROWSABLE`, `DEFAULT`]
        }
      ]
    }
  };
};

/**
 * `launch_handler` fragment for a PWA manifest.
 *
 * `navigate-existing` so a scanned link reuses the already-open window rather
 * than stacking a second one. An approval screen that opened behind the window
 * the user was already looking at would appear not to have worked at all.
 *
 * Pair with `window.launchQueue.setConsumer()` to read the target URL — see
 * {@link consumeLaunchTarget}.
 */
export const pwaLaunchHandler = (): object => ({
  launch_handler: { client_mode: `navigate-existing` }
});

/**
 * Read the URL an installed PWA was launched with.
 *
 * With `navigate-existing`, the window is reused and `location.href` may
 * already be correct — but when the app was cold-started or the consumer runs
 * before navigation settles, `launchQueue` is the only reliable source.
 *
 * Falls back to the current location where `launchQueue` is unsupported
 * (Safari and Firefox, as of 2026), so callers need no branching.
 */
export const consumeLaunchTarget = (
  onTarget: (href: string) => void,
  { currentHref }: { currentHref?: string } = {}
): void => {
  // Narrowed by runtime checks rather than a cast: neither `launchQueue` nor
  // `location` exists on a server runtime, and `launchQueue` is absent in
  // Safari and Firefox even in a browser.
  const scope: Record<string, unknown> = globalThis;

  const location = scope.location;
  const currentLocationHref =
    typeof location === `object` &&
    location !== null &&
    `href` in location &&
    typeof location.href === `string`
      ? location.href
      : undefined;
  const fallback = currentHref ?? currentLocationHref;

  const queue = scope.launchQueue;
  if (!isLaunchQueue(queue)) {
    if (fallback !== undefined) onTarget(fallback);
    return;
  }

  queue.setConsumer(({ targetURL }) => {
    const href = targetURL ?? fallback;
    if (href !== undefined) onTarget(href);
  });
};

/** The subset of `LaunchQueue` this module uses. */
interface LaunchQueueLike {
  setConsumer: (fn: (params: { targetURL?: string }) => void) => void;
}

/**
 * Structural check for the Launch Handler API.
 *
 * A predicate rather than a cast: the API is absent on every server runtime and
 * in Safari and Firefox, so its presence is a runtime fact to test.
 */
const isLaunchQueue = (value: unknown): value is LaunchQueueLike =>
  typeof value === `object` &&
  value !== null &&
  `setConsumer` in value &&
  typeof value.setConsumer === `function`;
