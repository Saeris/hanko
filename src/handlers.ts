/**
 * Request → Response glue for the three endpoints the flow needs.
 *
 * Built on the WinterTC `Request`/`Response` pair, so the same handlers run on
 * Cloudflare Workers, Vercel Functions, Deno Deploy, Bun, and Node 18+ without
 * a framework adapter. This is the layer hanko ships so a host app writes
 * routing, not protocol.
 *
 * Stateless by construction: nothing is held between invocations. Every
 * request loads its grant from the store, applies one transition, and writes
 * it back — which is what makes this safe on an edge runtime where the next
 * request may land on a different instance, or on an instance that was frozen
 * mid-flow.
 */

import { appleAppSiteAssociation, digitalAssetLinks } from "./linking.js";
import type { HankoServer } from "./server.js";

/** JSON with a status. Kept local so nothing imports a framework helper. */
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": `application/json`,
      // These are one-shot auth responses. A cached `authorization_pending`
      // served to a later poll would stall the device until expiry.
      "cache-control": `no-store`
    }
  });

/**
 * Read parameters from a form body or JSON.
 *
 * RFC 8628 specifies form encoding, but hosts routinely post JSON from their
 * own front end, and rejecting that would be pedantry rather than security.
 */
const readParams = async (
  request: Request
): Promise<Partial<Record<string, string>>> => {
  const contentType = request.headers.get(`content-type`) ?? ``;

  if (contentType.includes(`application/json`)) {
    const body: unknown = await request.json();
    if (typeof body !== `object` || body === null) return {};
    return Object.fromEntries(
      Object.entries(body).map(([key, value]) => [key, String(value)])
    );
  }

  // `URLSearchParams` over `request.formData()`: the spec sends
  // `application/x-www-form-urlencoded`, which this parses exactly, while
  // `formData()` drags in multipart handling that is both deprecated on the
  // server and useless here — no field in this protocol is a file.
  const params: Partial<Record<string, string>> = {};
  for (const [key, value] of new URLSearchParams(await request.text())) {
    params[key] = value;
  }
  return params;
};

/**
 * Hook for the rate limiting RFC 8628 §5.1 requires.
 *
 * hanko deliberately does not implement it: an effective limiter needs the IP,
 * which lives in a platform-specific header (`CF-Connecting-IP`,
 * `x-forwarded-for`), and needs storage this library should not assume. What
 * it can do is make the seam explicit so the requirement is not silently
 * skipped.
 *
 * Return `false` to reject with 429.
 */
export type RateLimiter = (
  request: Request,
  userCode: string
) => Promise<boolean> | boolean;

export interface HandlerOptions {
  server: HankoServer;
  /**
   * Identify the approving user from their session.
   *
   * The trust boundary of the whole flow: whatever this returns becomes the
   * `subject` the device is signed in as. Read it from YOUR session — never
   * from the request body, which the client controls.
   *
   * Return `null` when unauthenticated, and the approval endpoint answers 401.
   */
  authenticate: (request: Request) => Promise<string | null> | string | null;
  /**
   * Guard the approval endpoint. Strongly recommended — see {@link RateLimiter}.
   */
  rateLimit?: RateLimiter;
}

/**
 * Public origin this request actually arrived on.
 *
 * `request.url` is unreliable behind a proxy: it carries the internal host the
 * proxy forwarded to, not the one the client typed. `x-forwarded-host` and
 * `x-forwarded-proto` carry the real ones, and every common proxy sets them —
 * ngrok, Cloudflare, Vercel, nginx.
 *
 * Returns `null` when nothing usable is present, so the caller falls back to
 * its configured value rather than guessing.
 *
 * These headers are CLIENT-CONTROLLABLE when no proxy strips them, so this is
 * only safe for building a URL the same client will visit. Never use it for an
 * authorization decision.
 */
const forwardedOrigin = (request: Request): string | null => {
  const host = request.headers.get(`x-forwarded-host`);
  if (host === null || host.length === 0) return null;

  // A comma-separated list when several proxies chained; the first is the
  // original client-facing host. Each hop appends, so taking the last would
  // give the innermost proxy — the one host guaranteed to be private.
  const [first] = host.split(`,`);
  const cleaned = first.trim();
  if (cleaned.length === 0) return null;

  const proto = request.headers.get(`x-forwarded-proto`)?.split(`,`)[0]?.trim();
  return `${proto === undefined || proto.length === 0 ? `https` : proto}://${cleaned}`;
};

/**
 * The device-authorization endpoint. `POST /device/authorize`.
 *
 * Unauthenticated: the whole point is that the device has no credentials yet.
 */
export const createAuthorizationHandler =
  ({
    server,
    verificationPath = `/link`,
    trustForwardedHost = true
  }: Pick<HandlerOptions, `server`> & {
    /** Path of the approval page, appended to the detected origin. */
    verificationPath?: string;
    /**
     * Derive the verification URI from the request's forwarded headers.
     *
     * On by default because it is what makes one deployment work across a
     * preview URL, a custom domain, and a tunnel without a redeploy. Set false
     * to always use the configured `verificationUri` — worth doing if your
     * platform does not strip client-sent `x-forwarded-*` headers and you would
     * rather pin the origin than trust them.
     */
    trustForwardedHost?: boolean;
  }) =>
  async (request: Request): Promise<Response> => {
    if (request.method !== `POST`) {
      return json({ error: `method_not_allowed` }, 405);
    }

    const origin = trustForwardedHost ? forwardedOrigin(request) : null;
    const params = await readParams(request);
    const grant = await server.requestAuthorization({
      clientId: params.client_id,
      scope: params.scope,
      // Undefined falls through to the server's configured value.
      verificationUri:
        origin === null ? undefined : `${origin}${verificationPath}`
    });
    return json(grant);
  };

/**
 * The token endpoint. `POST /device/token`.
 *
 * Maps poll results onto the status codes RFC 8628 §3.5 specifies: pending and
 * slow_down are 400s carrying an error code, not 200s, because a compliant
 * client distinguishes them by body rather than status.
 */
export const createTokenHandler =
  ({
    server,
    createSession
  }: Pick<HandlerOptions, `server`> & {
    /**
     * Mint whatever credential the device should receive.
     *
     * hanko carries the `subject` and stops there — issuing sessions is your
     * auth system's job, and duplicating it would make this library compete
     * with Better-Auth instead of composing with it.
     */
    createSession: (subject: string) => unknown;
  }) =>
  async (request: Request): Promise<Response> => {
    if (request.method !== `POST`) {
      return json({ error: `method_not_allowed` }, 405);
    }

    const params = await readParams(request);
    const deviceCode = params.device_code;
    if (deviceCode === undefined) {
      return json({ error: `invalid_request` }, 400);
    }

    const result = await server.poll(deviceCode);

    switch (result.status) {
      case `approved`:
        return json(await createSession(result.subject));
      case `slow_down`:
        return json({ error: result.error, interval: result.interval }, 400);
      case `pending`:
      case `denied`:
      case `expired`:
        return json({ error: result.error }, 400);
    }
  };

/**
 * The approval endpoint. `GET` to resolve a code, `POST` to decide.
 *
 * Both require an authenticated user: this runs on the phone that is already
 * signed in, and the identity it resolves is what the device inherits.
 */
export const createApprovalHandler =
  ({ server, authenticate, rateLimit }: HandlerOptions) =>
  async (request: Request): Promise<Response> => {
    const subject = await authenticate(request);
    if (subject === null) return json({ error: `unauthorized` }, 401);

    if (request.method === `GET`) {
      const userCode = new URL(request.url).searchParams.get(`user_code`);
      if (userCode === null) return json({ error: `invalid_request` }, 400);

      if (rateLimit && !(await rateLimit(request, userCode))) {
        return json({ error: `slow_down` }, 429);
      }

      const grant = await server.lookupByUserCode(userCode);
      // Unknown and expired collapse to one answer: distinguishing them would
      // let an attacker probe which codes are live.
      if (!grant || grant.status !== `pending`) {
        return json({ error: `invalid_code` }, 404);
      }

      // Returns the code, because RFC 8628 §3.3.1 asks for exactly that:
      //
      //   "The server SHOULD display the user_code to the user and ask them to
      //    verify that it matches the user_code being displayed on the device
      //    to confirm they are authorizing the correct device."
      //
      // The mitigation is a VISUAL comparison against a physically separate
      // screen, not a memory test. Withholding it would leave the user
      // approving an unlabelled request, which is strictly worse: they would
      // have nothing to compare at all.
      //
      // `device_code` is never returned. That one IS a bearer credential —
      // echoing it would let anyone who can resolve a user code redeem the
      // grant themselves.
      return json({
        user_code: grant.user_code,
        client_id: grant.clientId,
        scope: grant.scope
      });
    }

    if (request.method === `POST`) {
      const params = await readParams(request);
      const userCode = params.user_code;
      if (userCode === undefined)
        return json({ error: `invalid_request` }, 400);

      if (rateLimit && !(await rateLimit(request, userCode))) {
        return json({ error: `slow_down` }, 429);
      }

      // Explicit opt-in to approval. A missing field denies rather than
      // approves: a malformed request must never grant access.
      const approved = params.approved === `true`;
      const result = approved
        ? await server.approve(userCode, subject)
        : await server.deny(userCode);

      return result.ok
        ? json({ ok: true, approved })
        : json({ error: result.reason ?? `invalid_code` }, 400);
    }

    return json({ error: `method_not_allowed` }, 405);
  };

/**
 * All three handlers, plus a router for hosts that prefer one entry point.
 *
 * The router is a convenience — a Workers `fetch` can delegate to it wholesale
 * — but the individual handlers exist so file-based routing (Astro, Next,
 * SvelteKit) can mount each at its own path.
 */
export const createHandlers = (
  options: HandlerOptions & {
    createSession: (subject: string) => unknown;
  }
): {
  authorize: (request: Request) => Promise<Response>;
  token: (request: Request) => Promise<Response>;
  approval: (request: Request) => Promise<Response>;
  fetch: (request: Request) => Promise<Response>;
} => {
  const authorize = createAuthorizationHandler(options);
  const token = createTokenHandler(options);
  const approval = createApprovalHandler(options);

  return {
    authorize,
    token,
    approval,
    fetch: async (request) => {
      const { pathname } = new URL(request.url);
      if (pathname.endsWith(`/device/authorize`)) return authorize(request);
      if (pathname.endsWith(`/device/token`)) return token(request);
      if (pathname.endsWith(`/link`)) return approval(request);
      return json({ error: `not_found` }, 404);
    }
  };
};

/**
 * Serve the association files that make universal/app links work.
 *
 * Both must be served from the SAME origin as the approval page, over HTTPS,
 * with no redirects. Apple and Google fetch them directly; a redirect or a
 * wrong content-type makes the association fail silently, which is the usual
 * reason "universal links don't work" with nothing in any log to explain it.
 *
 * Mount at `/.well-known/*`. Cached rather than `no-store` — unlike the auth
 * endpoints these are static, and the platforms re-fetch them on their own
 * schedule anyway.
 */
export const createWellKnownHandler = ({
  appleAppIds = [],
  androidPackageName,
  androidFingerprints = [],
  paths
}: {
  /** `<TEAM_ID>.<BUNDLE_ID>` for each iOS app that may open these links. */
  appleAppIds?: string[];
  androidPackageName?: string;
  /** SHA-256 of the PLAY-signed certificate, not the local keystore. */
  androidFingerprints?: string[];
  /** Paths the apps claim. Defaults to the approval route. */
  paths?: string[];
}) => {
  const aasa = JSON.stringify(appleAppSiteAssociation(appleAppIds, { paths }));
  const assetlinks =
    androidPackageName === undefined
      ? `[]`
      : JSON.stringify(
          digitalAssetLinks(androidPackageName, androidFingerprints)
        );

  return (request: Request): Response | null => {
    const { pathname } = new URL(request.url);

    // `application/json` with no extension — Apple rejects other content types,
    // and the file deliberately has no `.json` suffix.
    if (pathname.endsWith(`/.well-known/apple-app-site-association`)) {
      return new Response(aasa, {
        headers: {
          "content-type": `application/json`,
          "cache-control": `public, max-age=3600`
        }
      });
    }

    if (pathname.endsWith(`/.well-known/assetlinks.json`)) {
      return new Response(assetlinks, {
        headers: {
          "content-type": `application/json`,
          "cache-control": `public, max-age=3600`
        }
      });
    }

    // Null rather than 404, so a host can fall through to its own routes.
    return null;
  };
};
