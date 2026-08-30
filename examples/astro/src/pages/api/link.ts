import type { APIRoute } from "astro";
import { createApprovalHandler } from "@saeris/hanko/handlers";
import { authenticate, hanko } from "../../lib/hanko.js";

// No rate limiter here because a demo has no shared store to hold counters —
// but RFC 8628 §5.1 REQUIRES one in production. The seam is `rateLimit`; see
// the README. Leaving it out is a demo shortcut, not a pattern to copy.
const handler = createApprovalHandler({ server: hanko, authenticate });

export const GET: APIRoute = async ({ request }) => handler(request);
export const POST: APIRoute = async ({ request }) => handler(request);
