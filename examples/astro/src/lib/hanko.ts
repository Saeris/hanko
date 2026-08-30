/**
 * One hanko server, shared by every endpoint.
 *
 * A module-level singleton is correct for a demo on a single Node process and
 * WRONG for the edge deployment this library targets: `MemoryDeviceGrantStore`
 * dies with the process and is not shared between instances. Swap in
 * `KvDeviceGrantStore` for anything real — that is the whole point of the store
 * interface, and it is a two-line change (see the README's Edge runtimes
 * section).
 */

import { HankoServer } from "@saeris/hanko";
import type { DeviceAuthorizationResponse } from "@saeris/hanko";
import type { AstroCookies } from "astro";
import { MemoryDeviceGrantStore } from "@saeris/hanko/stores/memory";
import { touchSession } from "./sessions.js";

/** Cookie holding this browser's in-flight grant. */
const GRANT_COOKIE = `hanko_demo_grant`;

/**
 * Fallback origin, used only when a request carries no forwarded headers.
 *
 * The real origin is derived PER REQUEST from `x-forwarded-host` — see
 * `createAuthorizationHandler`. That is what lets the same running server serve
 * a correct QR on localhost, through a tunnel, and behind a LAN hostname
 * without a restart or an environment variable.
 */
export const FALLBACK_ORIGIN =
  process.env.HANKO_ORIGIN ?? `http://localhost:4321`;

export const hanko = new HankoServer({
  store: new MemoryDeviceGrantStore(),
  verificationUri: `${FALLBACK_ORIGIN}/link`,
  // Short for a demo, so expiry is observable without waiting a quarter hour.
  // The RFC's own guidance is a window long enough to fetch a second device
  // and short enough to limit a phished code's value; 15 minutes is the
  // library default.
  expiresInSeconds: 300,
  intervalSeconds: 2,
  // Four characters, no separator — the Plex shape. Eight is the library
  // default and what RFC 8628 works through, but its own §5.1 analysis is
  // "short code plus rate limiting", not "long code alone": at ~17 bits this
  // is safe because `/api/link` caps attempts, and unsafe without that.
  //
  // Four also fits on one line of a TV at any size, and is short enough that
  // re-typing it to confirm is not a chore — which keeps the §5.4 check
  // something people actually do rather than click past.
  userCode: { length: 4, separator: `` },
  hooks: {
    // Visible in the terminal running `astro dev`, so the flow can be followed
    // across three devices without a debugger attached to any of them.
    onTransition: (from, to, grant): void => {
      console.log(`[hanko] ${grant.user_code}: ${from} → ${to}`);
    }
  }
});

/** Cookie holding this browser's session token. */
export const SESSION_COOKIE = `hanko_demo_session`;

/**
 * Who is making this request.
 *
 * Whatever this returns becomes the identity a device is signed in as, so it
 * is the trust boundary of the entire flow — never read it from the request
 * body, which the client controls.
 *
 * Resolved through the session STORE rather than trusting the cookie's
 * contents. That is what makes revocation real: sign a browser out from the
 * device list and its very next request stops resolving, because the token it
 * presents is no longer there.
 */
export const authenticate = (request: Request): string | null => {
  const cookie = request.headers.get(`cookie`) ?? ``;
  const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`, `u`).exec(cookie);
  const token = match?.[1];
  if (token === undefined) return null;

  const session = touchSession(decodeURIComponent(token));
  return session?.subject ?? null;
};

/** This request's session token, for marking which row is "this device". */
export const sessionToken = (request: Request): string | undefined => {
  const cookie = request.headers.get(`cookie`) ?? ``;
  const match = new RegExp(`${SESSION_COOKIE}=([^;]+)`, `u`).exec(cookie);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
};

/**
 * Public origin a request actually arrived on.
 *
 * Mirrors what `createAuthorizationHandler` does internally, for the pages that
 * create grants directly rather than through the endpoint. `x-forwarded-host`
 * first, because behind a proxy `Astro.url` carries the internal host the proxy
 * forwarded to, not the one the phone will visit.
 */
export const originOf = (request: Request, url: URL): string => {
  const host = request.headers.get(`x-forwarded-host`)?.split(`,`)[0]?.trim();
  if (host === undefined || host.length === 0) return url.origin;

  const proto = request.headers.get(`x-forwarded-proto`)?.split(`,`)[0]?.trim();
  return `${proto === undefined || proto.length === 0 ? `https` : proto}://${host}`;
};

/**
 * Reuse this browser's grant across reloads, or create one.
 *
 * A page render must not be a side effect. Minting a grant per request means a
 * refresh — or a second tab, or a phone opening the same screen — silently
 * replaces the code someone is halfway through typing, while the old grant
 * stays live. Two valid codes then disagree about which is "the" code, and the
 * phone reports the one on the TV as invalid.
 *
 * Keyed by a cookie because that is what identifies a BROWSER, which is what a
 * TV screen is. Falls through to a new grant once the old one is spent or
 * expired, so a completed sign-in does not pin a dead code forever.
 */
export const resumeOrCreateGrant = async ({
  cookies,
  clientId,
  verificationUri,
  buildQrTarget
}: {
  cookies: AstroCookies;
  clientId: string;
  verificationUri: string;
  /**
   * What the QR encodes, if not the spec's default.
   *
   * RFC 8628 defines `verification_uri_complete` as carrying the user code, so
   * the library emits that. This app overrides it to carry a device identifier
   * instead — see the call site for why — which is a host policy choice rather
   * than a protocol one.
   */
  buildQrTarget?: (deviceCode: string) => Promise<string>;
}): Promise<DeviceAuthorizationResponse> => {
  // Validated rather than asserted: a cookie is client-controlled, and a
  // half-shaped value here would fail deep inside the render instead of at the
  // boundary. Nothing security-sensitive rests on it — the store is still the
  // authority on whether the grant is live — but a crash is a worse outcome
  // than minting a fresh code.
  const existing = readGrantCookie(cookies.get(GRANT_COOKIE)?.value);

  if (existing !== undefined) {
    // Trust the store, not the cookie: the grant may have been approved,
    // denied, or aged out since this browser last loaded the page.
    const live = await hanko.lookupByUserCode(existing.user_code);
    if (live?.status === `pending`) return existing;
  }

  const issued = await hanko.requestAuthorization({
    clientId,
    verificationUri
  });
  let grant = issued;

  if (buildQrTarget !== undefined) {
    grant = {
      ...issued,
      verification_uri_complete: await buildQrTarget(issued.device_code)
    };
    // Remembered so a scan of that QR can be resolved back to this grant.
    indexDevice(
      await publicDeviceId(issued.device_code),
      issued.user_code,
      Date.now() + issued.expires_in * 1000
    );
  }

  cookies.set(GRANT_COOKIE, JSON.stringify(grant), {
    path: `/`,
    httpOnly: true,
    sameSite: `lax`,
    // Matches the grant's own lifetime. A cookie outliving its grant would
    // just mean one wasted lookup, but expiring first would mint a duplicate.
    maxAge: grant.expires_in
  });
  return grant;
};

const isGrant = (value: unknown): value is DeviceAuthorizationResponse =>
  typeof value === `object` &&
  value !== null &&
  `device_code` in value &&
  typeof value.device_code === `string` &&
  `user_code` in value &&
  typeof value.user_code === `string`;

/** Parse the grant cookie, tolerating anything that is not a grant. */
const readGrantCookie = (
  raw: string | undefined
): DeviceAuthorizationResponse | undefined => {
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isGrant(parsed) ? parsed : undefined;
  } catch {
    // Not JSON at all. Treated the same as absent.
    return undefined;
  }
};

/**
 * Display name for a subject.
 *
 * The approving page stores the handle in its session cookie, so what reaches
 * `createSession` is already human-readable. Kept as a seam because a real app
 * carries the DID as its subject and resolves the handle for display —
 * handles change, DIDs do not.
 */
export const subjectHandle = (subject: string): string => subject;

/**
 * Reject a state-changing request that did not come from our own page.
 *
 * This is what actually protects approval, and it is what the httpOnly cookie
 * cannot do alone: a cookie proves the request came from your browser, not
 * that it came from your page. `SameSite=Lax` blocks the classic cross-site
 * form POST, and this closes the rest.
 *
 * Astro's built-in `checkOrigin` is off for this app, because the RFC 8628
 * device endpoints are machine-to-machine and legitimately send no Origin at
 * all. Turning it off globally to accommodate them removed the protection from
 * the endpoints that DO need it, so it is reapplied here, per route.
 */
export const sameOrigin = (request: Request): boolean => {
  const origin = request.headers.get(`origin`);
  // No Origin header at all: not a browser-initiated cross-site request. Every
  // modern browser sends it on POST, so this is a non-browser client.
  if (origin === null) return true;

  const expected = originOf(request, new URL(request.url));
  return origin === expected;
};

/**
 * Public handle for a grant, safe to put in a QR.
 *
 * The `device_code` is the bearer credential — 256 bits, known only to the
 * server and the device that requested it. Anyone who reads it can redeem the
 * grant, so it must never appear in something a stranger can photograph.
 *
 * This is a SHA-256 of it, truncated. Same identity, none of the authority:
 * it says which pending sign-in a scan refers to, and cannot be used to
 * complete one. Truncation is fine because the value only has to be unique
 * among the handful of grants live at once, and it is not a secret.
 */
export const publicDeviceId = async (deviceCode: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    `SHA-256`,
    new TextEncoder().encode(deviceCode)
  );
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, `0`))
    .join(``);
};

/**
 * Public device id → user code, for scanned QRs.
 *
 * Kept HERE rather than in the library on purpose: enumerating pending grants
 * is precisely what `DeviceGrantStore` withholds — every lookup takes a code
 * the caller must already hold. Mapping a scan back to a grant is a host
 * concern, so the index lives with the host.
 *
 * Entries are dropped when the grant settles or ages out, so this cannot grow
 * unbounded.
 */
const deviceIndex = new Map<string, { userCode: string; expiresAt: number }>();

export const indexDevice = (
  deviceId: string,
  userCode: string,
  expiresAt: number
): void => {
  const now = Date.now();
  for (const [id, entry] of deviceIndex) {
    if (entry.expiresAt <= now) deviceIndex.delete(id);
  }
  deviceIndex.set(deviceId, { userCode, expiresAt });
};

/** Resolve a scanned device id, or undefined if it is unknown or stale. */
export const userCodeForDevice = (deviceId: string): string | undefined => {
  const entry = deviceIndex.get(deviceId);
  if (entry === undefined) return undefined;
  if (entry.expiresAt <= Date.now()) {
    deviceIndex.delete(deviceId);
    return undefined;
  }
  return entry.userCode;
};
