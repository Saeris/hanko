import type { APIRoute } from "astro";
import { createApprovalHandler } from "@saeris/hanko/handlers";
import { authenticate, hanko } from "../../lib/hanko.js";
import { createRateLimiter } from "../../lib/rate-limit.js";

// Not optional here. The demo uses a 4-character code (~17 bits, like Plex),
// which is only safe because guessing is capped — RFC 8628 §5.1 moves the
// entropy budget from the code to this limiter when the code is short.
//
// In-memory, so it is per-instance. Use a shared store on any real deployment,
// or an attacker simply spreads attempts across instances.
const rateLimit = createRateLimiter({ max: 5, windowMs: 60_000 });

const handler = createApprovalHandler({
  server: hanko,
  authenticate,
  rateLimit
});

export const GET: APIRoute = async ({ request }) => handler(request);
export const POST: APIRoute = async ({ request }) => handler(request);
