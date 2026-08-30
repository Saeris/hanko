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
  verificationUri
}: {
  cookies: AstroCookies;
  clientId: string;
  verificationUri: string;
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

  const grant = await hanko.requestAuthorization({ clientId, verificationUri });
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
