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
import { MemoryDeviceGrantStore } from "@saeris/hanko/stores/memory";

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

/**
 * Stand-in for the host app's session.
 *
 * In a real app this reads YOUR session cookie and returns a user id or DID.
 * Whatever it returns becomes the identity the TV is signed in as, so it is
 * the trust boundary of the entire flow — never read it from the request body,
 * which the client controls.
 *
 * The demo fakes it with a cookie set by the sign-in page, which is enough to
 * exercise the 401 path honestly.
 */
export const authenticate = (request: Request): string | null => {
  const cookie = request.headers.get(`cookie`) ?? ``;
  const match = /demo_session=([^;]+)/u.exec(cookie);
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
};

/**
 * Stand-in for minting a credential.
 *
 * hanko carries the subject and stops; issuing the session is the host app's
 * job. A real implementation would return a JWT, set a cookie, or hand back
 * whatever Better-Auth or Supabase issues.
 */
export const createSession = (subject: string): object => ({
  access_token: `demo-token-for-${subject}`,
  token_type: `Bearer`,
  subject
});

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
