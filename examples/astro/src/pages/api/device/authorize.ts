import type { APIRoute } from "astro";
import { createAuthorizationHandler } from "@saeris/hanko/handlers";
import { hanko } from "../../../lib/hanko.js";

// hanko ships the protocol; Astro supplies the route. The handler takes a
// `Request` and returns a `Response`, which is exactly Astro's endpoint
// signature — no adapter needed.
const handler = createAuthorizationHandler({ server: hanko });

export const POST: APIRoute = async ({ request }) => handler(request);
