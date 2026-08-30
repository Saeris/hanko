import type { APIRoute } from "astro";
import { createApprovalHandler } from "@saeris/hanko/handlers";
import { authenticate, hanko, sameOrigin } from "../../lib/hanko.js";
import { createRateLimiter } from "../../lib/rate-limit.js";

// Not optional here. The demo uses a 4-character code (~17 bits, like Plex),
// which is only safe because guessing is capped — RFC 8628 §5.1 moves the
// entropy budget from the code to this limiter when the code is short.
const rateLimit = createRateLimiter({ max: 5, windowMs: 60_000 });

const handler = createApprovalHandler({
  server: hanko,
  authenticate,
  rateLimit
});

export const GET: APIRoute = async ({ request }) => handler(request);

/**
 * Approving is the state-changing half, so it gets the CSRF check.
 *
 * The session cookie proves the request came from your BROWSER; the Origin
 * proves it came from your PAGE. Both matter: without this, any site could
 * POST an approval and your cookie would ride along.
 */
export const POST: APIRoute = async ({ request }) =>
  sameOrigin(request)
    ? handler(request)
    : Response.json({ error: `invalid_origin` }, { status: 403 });
