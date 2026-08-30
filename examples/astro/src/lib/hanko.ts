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
 * Origin the QR points at.
 *
 * It has to be an absolute URL a DIFFERENT device can resolve. A QR encoding
 * `localhost` is useless to the phone scanning it, which is the single easiest
 * way to make this demo look broken — so the value is chosen in order of how
 * likely it is to be reachable:
 *
 * 1. `HANKO_ORIGIN` — set this for a tunnel, where only you know the URL.
 * 2. `PORTLESS_URL` — injected by `portless run`, correct without configuring
 *    anything.
 * 3. `localhost` — right for a single-machine run, and honest about being
 *    useless to a second device. Deliberately NOT a plausible-looking LAN
 *    hostname: a default that points somewhere unreachable fails silently,
 *    which is worse than one that is obviously local.
 */
export const ORIGIN =
  process.env.HANKO_ORIGIN ??
  process.env.PORTLESS_URL ??
  `http://localhost:4321`;

// Said once at boot rather than left to be discovered by a phone that scans a
// QR and lands nowhere. A camera also refuses to open on a non-HTTPS origin, so
// a localhost run cannot do the scan path at all.
if (/localhost|127\.0\.0\.1/u.test(ORIGIN)) {
  console.warn(
    `[hanko] Origin is ${ORIGIN} — reachable only from this machine.\n` +
      `        The QR will not work from a phone, and the camera needs HTTPS.\n` +
      `        Run \`yarn demo:share\` and set HANKO_ORIGIN to the printed URL.`
  );
}

export const hanko = new HankoServer({
  store: new MemoryDeviceGrantStore(),
  verificationUri: `${ORIGIN}/link`,
  // Short for a demo, so expiry is observable without waiting a quarter hour.
  // The RFC's own guidance is a window long enough to fetch a second device
  // and short enough to limit a phished code's value; 15 minutes is the
  // library default.
  expiresInSeconds: 300,
  intervalSeconds: 2,
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
